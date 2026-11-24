/**
 * Autonomous AI Agent Orchestrator & Decision Brain
 * - Evaluates FILE UPLOAD assessments with strict lab/assignment number matching.
 * - Sends Gmail + WhatsApp reminders for urgent online Quizzes & Reflective Journals (<= 24h left).
 * - Uses ultra-compact prompts (~900 tokens) to guarantee zero Groq 413 TPM rate limit errors.
 */

const { Groq } = require('groq-sdk');
const path = require('path');
const { config } = require('../config/env');
const db = require('../db/database');
const scanner = require('../scanner/folderScanner');
const notifier = require('../notifications/notifier');
const erp = require('../browser/erpAutomation');
const {
  SUBJECT_ALIASES,
  normalizeSubjectCodes,
  extractSubjectCodes,
  hasNumberConflict,
} = require('./assignmentMatcher');

/**
 * Helper: Sends Gmail + WhatsApp reminders for urgent browser-only tasks (Quizzes / Reflective Journals due <= 24h)
 */
async function checkAndNotifyUrgentOnlineTasks(deadlines) {
  let sentCount = 0;
  for (const asgt of deadlines) {
    const isFileUpload =
      /FILE UPLOAD/i.test(asgt.title) || /Type:\s*FILE UPLOAD/i.test(asgt.description || '');
    if (isFileUpload) continue;

    const hoursUntilDue = Math.max(
      0,
      (new Date(asgt.due_date).getTime() - Date.now()) / (1000 * 60 * 60)
    );

    if (hoursUntilDue > 0 && hoursUntilDue <= 24) {
      console.log(
        `  [Urgent Online Reminder] [${asgt.subject}] ${asgt.title} due in ${hoursUntilDue.toFixed(1)}h -> Triggering Email & WhatsApp...`
      );
      await notifier.notifyUpcomingDeadline(asgt, {
        filename: 'Online Portal Activity (Complete directly on Sidus)',
      });
      sentCount++;
    }
  }
  return sentCount;
}

/**
 * Tool definitions exposed to the Groq LLM
 */
const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'submit_assignment_file',
      description:
        'Submits a verified local assignment document to the ERP portal (ONLY when subject AND exact assignment number match).',
      parameters: {
        type: 'object',
        properties: {
          assignment_id: {
            type: 'string',
            description: 'The assignment ID from the ERP portal.',
          },
          filepath: {
            type: 'string',
            description: 'Full path to the local completed assignment document.',
          },
          confidence_score: {
            type: 'number',
            description: 'AI confidence score between 0 and 100.',
          },
          reasoning: {
            type: 'string',
            description: 'Short explanation of why the subject and exact assignment number match.',
          },
        },
        required: ['assignment_id', 'filepath', 'confidence_score', 'reasoning'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_student_notification',
      description: 'Sends an alert to the student about an urgent missing file (<48h) or matched upcoming file.',
      parameters: {
        type: 'object',
        properties: {
          assignment_id: {
            type: 'string',
            description: 'The assignment ID from the ERP portal.',
          },
          alert_type: {
            type: 'string',
            enum: ['UPCOMING_DEADLINE', 'MISSING_FILE_WARNING'],
            description: 'Type of alert to send.',
          },
          matching_filename: {
            type: 'string',
            description: 'Name of the matched local file, if one exists.',
          },
          reason: {
            type: 'string',
            description: 'Brief context for the notification.',
          },
        },
        required: ['assignment_id', 'alert_type'],
      },
    },
  },
];

/**
 * Heuristic matching engine (Strictly enforces Lab/Assignment numbers & notifies urgent online tasks)
 */
async function runHeuristicDecisionEngine({ deadlines, localFiles, dryRun = false }) {
  console.log('\n[Agent Brain] Running strict number-aware matching engine...');
  const results = [];
  let warningsSentCount = 0;

  for (const asgt of deadlines) {
    const isFileUpload =
      /FILE UPLOAD/i.test(asgt.title) || /Type:\s*FILE UPLOAD/i.test(asgt.description || '');

    const hoursUntilDue = Math.max(
      0,
      (new Date(asgt.due_date).getTime() - Date.now()) / (1000 * 60 * 60)
    );

    if (!isFileUpload) {
      if (hoursUntilDue > 0 && hoursUntilDue <= 24) {
        console.log(
          `  [Urgent Online Activity] [${asgt.subject}] ${asgt.title} (Due in ${hoursUntilDue.toFixed(1)}h) -> Sending reminder!`
        );
        await notifier.notifyUpcomingDeadline(asgt, {
          filename: 'Online Portal Activity (Complete directly on Sidus)',
        });
        results.push({
          assignmentId: asgt.assignment_id,
          action: 'ONLINE_REMINDER_SENT',
          file: null,
          score: 100,
        });
      } else {
        console.log(`  [Skip Online Activity] [${asgt.subject}] ${asgt.title} (Due in ${hoursUntilDue.toFixed(1)}h)`);
      }
      continue;
    }

    console.log(`\n------------------------------------------------------------`);
    console.log(`Evaluating FILE UPLOAD: [${asgt.subject}] ${asgt.title}`);
    console.log(`Due Date: ${new Date(asgt.due_date).toLocaleString()} (${hoursUntilDue.toFixed(1)}h left)`);

    let bestMatch = null;
    let highestScore = 0;
    let matchReason = '';

    const subjectCode = asgt.subject.split(' - ')[0].trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const aliasKeywords = SUBJECT_ALIASES[subjectCode] || [];

    const subjectClean = asgt.subject.toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
    const titleClean = asgt.title.replace(/\s*\(.*?\)\s*$/, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
    const subjectTokens = [...new Set([...subjectClean.split(/\s+/).filter((t) => t.length > 2), ...aliasKeywords])];
    const titleTokens = titleClean.split(/\s+/).filter((t) => t.length > 2);

    const asgtCodes = extractSubjectCodes(`${asgt.subject} ${asgt.assignment_id || asgt.assignmentId}`);

    for (const file of localFiles) {
      const normFileName = normalizeSubjectCodes(file.filename);
      const detectedCodes = extractSubjectCodes(file.filename);

      // Strict Subject-Code Conflict Guard
      if (detectedCodes.length > 0 && !asgtCodes.some((c) => detectedCodes.includes(c))) {
        continue;
      }

      if (hasNumberConflict(asgt.title, normFileName)) {
        continue;
      }

      let score = 0;
      const reasons = [];
      let hasSubjectMatch = false;

      const fnameLower = normFileName.toLowerCase();
      const textLower = normalizeSubjectCodes(file.extractedText || '').toLowerCase();

      for (const token of subjectTokens) {
        if (fnameLower.includes(token)) {
          score += 40;
          hasSubjectMatch = true;
          reasons.push(`filename matches subject '${token}'`);
          break;
        }
      }

      for (const token of subjectTokens) {
        if (textLower.includes(token)) {
          score += 20;
          hasSubjectMatch = true;
          reasons.push(`document text matches subject '${token}'`);
          break;
        }
      }

      // Require Subject Match: Never match on lab number alone
      if (!hasSubjectMatch) {
        continue;
      }

      for (const token of titleTokens) {
        if (fnameLower.includes(token)) {
          score += 20;
          reasons.push(`filename contains '${token}'`);
          break;
        }
      }

      const titleNums = titleClean.match(/\d+/g);
      if (titleNums && fnameLower.includes(titleNums[titleNums.length - 1])) {
        score += 20;
        reasons.push(`exact number match #${titleNums[titleNums.length - 1]}`);
      }

      const finalScore = Math.min(98, score);
      console.log(`  - Valid Candidate: "${file.filename}" -> Score: ${finalScore}%`);

      if (finalScore > highestScore) {
        highestScore = finalScore;
        bestMatch = file;
        matchReason = reasons.join('; ');
      }
    }

    const isConfident = highestScore >= config.agent.confidenceThreshold;
    const isWithinSubmissionWindow = hoursUntilDue <= config.agent.hoursBeforeDeadlineToSubmit;

    if (isConfident && bestMatch) {
      console.log(`  => Confident Match Found: "${bestMatch.filename}" (${highestScore}%)`);
      console.log(`  => Reasoning: ${matchReason}`);

      if (isWithinSubmissionWindow) {
        console.log(`  => ACTION: Triggering Auto-Submission (Due in ${hoursUntilDue.toFixed(1)}h)`);
        const subResult = await erp.submitAssignment({
          portalUrl: config.erp.portalUrl,
          assignmentId: asgt.assignment_id,
          filePath: bestMatch.filepath,
          dryRun,
          confidenceScore: highestScore,
          reasoning: matchReason,
        });

        if (subResult && subResult.success) {
          await notifier.notifyAutoSubmitted(
            asgt,
            bestMatch.filepath,
            subResult.screenshotPath,
            highestScore,
            matchReason
          );

          results.push({
            assignmentId: asgt.assignment_id,
            action: 'AUTO_SUBMIT',
            file: bestMatch.filename,
            score: highestScore,
            dryRun,
          });
        } else {
          console.log(`  => Submission skipped/blocked: ${subResult ? subResult.message : 'Unknown reason'}`);
        }
      } else {
        console.log(`  => ACTION: File ready, waiting for submission window (<= ${config.agent.hoursBeforeDeadlineToSubmit}h).`);
      }
    } else {
      console.log(`  => No matching file with required assignment number in folder.`);
      if (hoursUntilDue <= 48 && warningsSentCount < 3) {
        console.log(`  => ACTION: Urgent FILE UPLOAD due in ${hoursUntilDue.toFixed(1)}h! Sending missing file warning.`);
        await notifier.notifyMissingFileWarning(asgt);
        warningsSentCount++;
      }
      results.push({
        assignmentId: asgt.assignment_id,
        action: 'MISSING_FILE',
        file: null,
        score: highestScore,
      });
    }
  }

  return results;
}

let isCycleRunning = false;

/**
 * Main Autonomous Orchestration Cycle
 */
async function runAgentCycle(options = {}) {
  const { dryRun = false } = options;

  if (isCycleRunning) {
    console.log(
      '\n[Agent Brain] ⚠️ A cycle is already actively running. Skipping concurrent trigger to protect browser session.'
    );
    return { status: 'ALREADY_RUNNING', message: 'A cycle is already in progress.' };
  }

  isCycleRunning = true;

  try {
    console.log('\n' + '='.repeat(60));
    console.log(`AUTONOMOUS AGENT CYCLE STARTED [${new Date().toISOString()}]`);
    console.log(`Mode: ${dryRun ? 'DRY-RUN (SIMULATION)' : 'LIVE EXECUTION'}`);
    console.log('='.repeat(60));

  await db.initDb();
  await db.recordAuditLog('CYCLE_START', { dryRun });

  // 1. Scrape latest deadlines from ERP portal
  try {
    await erp.scrapeDeadlines({ portalUrl: config.erp.portalUrl });
  } catch (err) {
    console.warn(`[Browser Scraper] Note: Scrape step had issue (${err.message}). Continuing with existing DB records.`);
  }

  // 2. Fetch pending deadlines from DB
  const pendingDeadlines = await db.getPendingDeadlines();
  console.log(`[Agent Brain] Found ${pendingDeadlines.length} pending assignment(s) in database.`);

  if (pendingDeadlines.length === 0) {
    console.log('[Agent Brain] No pending assignments requiring action. Cycle finished.');
    await db.recordAuditLog('CYCLE_END', { status: 'NO_PENDING_ASSIGNMENTS' });
    return { status: 'NO_PENDING_ASSIGNMENTS' };
  }

  // 3. Scan local assignments folder
  console.log(`[Agent Brain] Scanning local folder: ${config.paths.collegeAssignments}...`);
  const localFiles = await scanner.scanAssignmentsFolder();
  console.log(`[Agent Brain] Scanned ${localFiles.length} assignment document(s) (.pdf / .docx).`);

  // 4. Filter down to FILE UPLOAD assignments for Groq evaluation
  const fileUploadDeadlines = pendingDeadlines
    .filter((d) => /FILE UPLOAD/i.test(d.title) || /Type:\s*FILE UPLOAD/i.test(d.description || ''))
    .map((d) => ({
      assignment_id: d.assignment_id,
      subject: d.subject,
      title: d.title,
      due_date: d.due_date,
      hours_left: Math.round((new Date(d.due_date).getTime() - Date.now()) / (1000 * 60 * 60)),
    }));

  const compactFiles = localFiles.map((f) => ({
    filename: f.filename,
    filepath: f.filepath,
    snippet: (f.textSnippet || '').slice(0, 80),
  }));

  const hasGroqKey = Boolean(config.groq.apiKey && config.groq.apiKey !== 'gsk_your_groq_api_key_here');

  if (!hasGroqKey) {
    const results = await runHeuristicDecisionEngine({
      deadlines: pendingDeadlines,
      localFiles,
      dryRun,
    });
    return { status: 'COMPLETED', engine: 'HEURISTIC', results };
  }

  // 5. Single-Turn Ultra-Compact Groq Brain
  console.log(`[Agent Brain] Initializing Groq Brain with model: ${config.groq.model}`);
  const groq = new Groq({ apiKey: config.groq.apiKey });

  const compactSystemPrompt = `You are an Autonomous College ERP Agent.
RULES:
1. Match pending 'FILE UPLOAD' assignments to local files.
2. STRICT NUMBER RULE: An assignment with a number (e.g. "Lab Report 4" or "Lab Report 5") MUST ONLY match a file containing that EXACT SAME number ("4" or "5"). NEVER match Lab 1, Lab 2, or Lab 3 files to Lab Report 4 or 5!
3. Subject aliases: CS210 = BACKEND, DS201 = FDS, CS209 = DSA or ADS, MA113 = MATH.
4. If an exact subject + number match has confidence >= ${config.agent.confidenceThreshold}% and hours_left <= ${config.agent.hoursBeforeDeadlineToSubmit}, call 'submit_assignment_file'.
5. For FILE UPLOAD items with NO matching numbered file and hours_left <= 48, call 'send_student_notification' with 'MISSING_FILE_WARNING' (max 3 warnings).`;

  const messages = [
    { role: 'system', content: compactSystemPrompt },
    {
      role: 'user',
      content: `Pending FILE UPLOAD Deadlines:\n${JSON.stringify(fileUploadDeadlines)}\n\nLocal Folder Files:\n${JSON.stringify(compactFiles)}\n\nEvaluate and call necessary tools now.`,
    },
  ];

  const executedActions = [];

  try {
    console.log(`\n[Groq LLM] Evaluating ${fileUploadDeadlines.length} FILE UPLOAD deadlines against ${compactFiles.length} local files...`);
    const response = await groq.chat.completions.create({
      model: config.groq.model,
      messages,
      tools: AGENT_TOOLS,
      tool_choice: 'auto',
      temperature: 0.1,
    });

    const assistantMessage = response.choices[0].message;

    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      for (const toolCall of assistantMessage.tool_calls) {
        const funcName = toolCall.function.name;
        let args = {};
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch (_) { }

        console.log(`[LLM Tool Call] ${funcName}(${JSON.stringify(args)})`);

        if (funcName === 'submit_assignment_file') {
          const asgt = await db.getDeadlineById(args.assignment_id);
          if (!asgt) continue;

          if (hasNumberConflict(asgt.title, path.basename(args.filepath))) {
            console.warn(
              `[Brain Safety Guard] Blocked LLM from matching "${path.basename(args.filepath)}" to "${asgt.title}" (Number mismatch!)`
            );
            continue;
          }

          const subResult = await erp.submitAssignment({
            portalUrl: config.erp.portalUrl,
            assignmentId: args.assignment_id,
            filePath: args.filepath,
            dryRun,
            confidenceScore: args.confidence_score,
            reasoning: args.reasoning,
          });

          if (subResult && subResult.success) {
            await notifier.notifyAutoSubmitted(
              asgt,
              args.filepath,
              subResult.screenshotPath,
              args.confidence_score,
              args.reasoning
            );
            executedActions.push({ action: 'SUBMISSION', assignmentId: args.assignment_id });
          }
        } else if (funcName === 'send_student_notification') {
          const asgt = await db.getDeadlineById(args.assignment_id);
          if (!asgt) continue;

          if (args.alert_type === 'MISSING_FILE_WARNING') {
            await notifier.notifyMissingFileWarning(asgt);
          } else {
            const matchedFile = args.matching_filename ? { filename: args.matching_filename } : null;
            await notifier.notifyUpcomingDeadline(asgt, matchedFile);
          }
          executedActions.push({ action: 'NOTIFICATION', assignmentId: args.assignment_id });
        }
      }
    }

    // Also alert student about urgent online Quizzes / Reflective Journals due within 24 hours
    const onlineAlerts = await checkAndNotifyUrgentOnlineTasks(pendingDeadlines);
    if (onlineAlerts > 0) {
      executedActions.push({ action: 'ONLINE_DEADLINE_ALERTS', count: onlineAlerts });
    }

    if (assistantMessage.content) {
      console.log(`\n[Groq LLM Summary]:\n${assistantMessage.content}`);
    }
  } catch (err) {
    console.error(`[Groq LLM Error] API request failed: ${err.message}`);
    console.log('[Agent Brain] Falling back to strict number-aware heuristic engine...');
    const results = await runHeuristicDecisionEngine({
      deadlines: pendingDeadlines,
      localFiles,
      dryRun,
    });
    return { status: 'COMPLETED_WITH_FALLBACK', results };
  }

  console.log('\n' + '='.repeat(60));
  console.log(`AUTONOMOUS AGENT CYCLE FINISHED`);
  console.log(`Executed Actions: ${executedActions.length}`);
  console.log('='.repeat(60) + '\n');

  await db.recordAuditLog('CYCLE_END', { executedActions });
  return { status: 'COMPLETED', executedActions };
  } finally {
    isCycleRunning = false;
  }
}

module.exports = {
  runAgentCycle,
  runHeuristicDecisionEngine,
};