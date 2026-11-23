/**
 * AI Drafting Assistant
 * Uses Groq SDK (openai/gpt-oss-120b) to generate high-quality starter drafts
 * or study outlines for pending assignments, saves them to drafts/, and notifies via Email & WhatsApp.
 */

const { Groq } = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const { config } = require('../config/env');
const db = require('../db/database');
const notifier = require('../notifications/notifier');

const SUBJECT_ALIASES = {
  cs210: ['cs210', 'backend', 'node', 'express', 'api'],
  ds201: ['ds201', 'fds', 'data science', 'foundations of data science'],
  cs209: ['cs209', 'dsa', 'ads', 'advanced data structures', 'data structures'],
  ma113: ['ma113', 'math', 'linear algebra'],
  re102: ['re102', 'research', 'ethics'],
  ec201: ['ec201', 'english'],
};

/**
 * Searches pending deadlines matching the given subject code/alias or assignment_id
 */
async function findMatchingDeadline(subjectOrId) {
  const pending = await db.getPendingDeadlines();
  if (!pending || pending.length === 0) return null;

  const rawInput = (subjectOrId || '').trim().toLowerCase();
  const cleanInput = rawInput.replace(/[^a-z0-9]/g, '');

  // 1. Exact assignment_id match
  const exactId = pending.find((d) => d.assignment_id.toLowerCase() === rawInput);
  if (exactId) return exactId;

  // 2. Partial assignment_id match
  const partialId = pending.find((d) =>
    d.assignment_id.toLowerCase().replace(/[^a-z0-9]/g, '').includes(cleanInput)
  );
  if (partialId) return partialId;

  // 3. Subject code or alias match
  let matchedSubjectCode = null;
  for (const [code, aliases] of Object.entries(SUBJECT_ALIASES)) {
    if (code === cleanInput || aliases.some((alias) => rawInput.includes(alias))) {
      matchedSubjectCode = code;
      break;
    }
  }

  // Filter candidates matching subject or title
  let candidates = pending.filter((d) => {
    const sLower = d.subject.toLowerCase();
    const idLower = d.assignment_id.toLowerCase();
    const tLower = d.title.toLowerCase();

    if (matchedSubjectCode && (sLower.includes(matchedSubjectCode) || idLower.includes(matchedSubjectCode))) {
      return true;
    }
    if (sLower.includes(rawInput) || idLower.includes(cleanInput) || tLower.includes(rawInput)) {
      return true;
    }
    const tokens = rawInput.split(/\s+/).filter((t) => t.length > 1);
    if (
      tokens.length > 0 &&
      tokens.every((tok) => tLower.includes(tok) || sLower.includes(tok) || idLower.includes(tok))
    ) {
      return true;
    }
    return false;
  });

  if (candidates.length === 0) return null;

  // If user included specific keywords like 'journal', 'quiz', 'lab', or numbers ('4', '5'), narrow down
  const inputNums = rawInput.match(/\d+/g);
  if (inputNums && inputNums.length > 0) {
    const targetNum = inputNums[inputNums.length - 1];
    const numCandidates = candidates.filter((c) => {
      const titleNums = c.title.match(/\d+/g);
      return titleNums && titleNums.includes(targetNum);
    });
    if (numCandidates.length > 0) {
      candidates = numCandidates;
    }
  }

  if (/journal/i.test(rawInput)) {
    const journalCandidates = candidates.filter((c) => /journal/i.test(c.title));
    if (journalCandidates.length > 0) candidates = journalCandidates;
  } else if (/quiz/i.test(rawInput)) {
    const quizCandidates = candidates.filter((c) => /quiz/i.test(c.title));
    if (quizCandidates.length > 0) candidates = quizCandidates;
  } else if (/lab/i.test(rawInput) || /report/i.test(rawInput)) {
    const labCandidates = candidates.filter((c) => /lab/i.test(c.title) || /FILE UPLOAD/i.test(c.title));
    if (labCandidates.length > 0) candidates = labCandidates;
  }

  // Sort by due date ascending (earliest first)
  candidates.sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
  return candidates[0];
}

/**
 * Generates an assignment starter draft or study outline using Groq LLM
 * @param {string} subjectOrId - e.g. "ec201", "cs210", "ds201", "cs209", "ma113", or an assignment_id
 */
async function generateAssignmentDraft(subjectOrId) {
  const asgt = await findMatchingDeadline(subjectOrId);
  if (!asgt) {
    const pending = await db.getPendingDeadlines();
    const availableSubjects = [...new Set(pending.map((d) => d.subject.split('-')[0].trim()))].join(', ');
    return {
      success: false,
      message: `No active deadline found matching "${subjectOrId}". Currently pending subjects: ${availableSubjects || 'None'}`,
    };
  }

  const isReflectiveJournal =
    /REFLECTIVE JOURNAL/i.test(asgt.title) ||
    /reflective journal/i.test(asgt.description || '') ||
    /journal/i.test(asgt.title);

  const isQuiz =
    /QUIZ/i.test(asgt.title) ||
    /quiz/i.test(asgt.description || '');

  console.log(`\n[AI Drafter] Generating draft for: [${asgt.subject}] ${asgt.title}`);
  console.log(`[AI Drafter] Type: ${isReflectiveJournal ? 'REFLECTIVE JOURNAL' : isQuiz ? 'QUIZ STUDY GUIDE' : 'LAB REPORT'}`);

  let prompt = '';
  if (isReflectiveJournal) {
    prompt = `You are a dedicated undergraduate student pursuing a B.Tech in Computer Science and Engineering with specialization in AI & Machine Learning (AIML).
Write an authentic, articulate, first-person reflective journal entry (350–450 words) for:
Course: ${asgt.subject}
Assignment Title: ${asgt.title}
Course Context / Description: ${asgt.description || 'Weekly course reflection and progress review.'}

Guidelines:
- Write in first person ("I explored...", "I implemented...", "I encountered challenges with...").
- Demonstrate genuine technical depth in this subject.
- Adhere strictly to this Markdown layout:

# ${asgt.title} - Reflective Journal
**Course:** ${asgt.subject}
**Program:** B.Tech CSE (AIML)

### Key Concepts Learned
(Discuss the core theoretical concepts and frameworks studied, explaining them clearly.)

### Practical Application / Lab Insights
(Detail how you applied these concepts in lab exercises, coding implementations, or problem-solving.)

### Challenges Faced
(Discuss 1 or 2 specific technical hurdles, errors, or conceptual roadblocks encountered and how you resolved them.)

### Next Steps
(Outline actionable follow-ups, upcoming topics to master, or ways to apply this knowledge in projects.)
`;
  } else if (isQuiz) {
    prompt = `You are an expert university professor and tutor for B.Tech CSE (AIML) students.
Generate a comprehensive, high-yield study sheet and revision cheat-sheet for:
Course: ${asgt.subject}
Assignment / Assessment: ${asgt.title}
Context: ${asgt.description || 'Module revision and quiz preparation.'}

Guidelines:
- Deliver maximum exam-ready value.
- Format with clear Markdown headings:

# ${asgt.title} - High-Yield Study Guide
**Course:** ${asgt.subject}

### Key Concepts & Formula Summary
(Dense, high-value summary of critical concepts, equations, and rules.)

### Core Terminology & Definitions
(Essential terms with precise technical definitions.)

### 10 Practice Quiz Questions with Detailed Solutions
(10 realistic multiple-choice or short-answer questions with thorough explanations for the correct answers.)

### Exam Tips & Common Pitfalls
(Frequent student mistakes and strategies to score 100%.)
`;
  } else {
    // File upload / Lab Report
    prompt = `You are a senior engineering instructor assisting B.Tech CSE (AIML) undergraduates.
Generate a professional, structured starter template and technical guide for:
Course: ${asgt.subject}
Assignment: ${asgt.title}
Description: ${asgt.description || 'Laboratory programming assignment.'}

Guidelines:
- Include full code architectures and implementation details.
- Format strictly as Markdown:

# ${asgt.title} - Laboratory Report
**Course:** ${asgt.subject}
**Program:** B.Tech CSE (AIML)

### Objective & Aim
(Clear statement of what this laboratory exercise accomplishes.)

### Theoretical Background & Prerequisites
(Mathematical/computational theory behind the algorithms or architectures.)

### Algorithm / System Architecture
(Detailed breakdown of classes, data structures, and algorithmic steps.)

### Implementation Code Outline
(Clean, commented starter code or complete reference implementation in Python or JavaScript/C++.)

### Test Cases & Output Verification
(Specific test cases, inputs, and expected outputs demonstrating correctness.)

### Discussion & Viva Questions
(5 common viva/interview questions regarding this experiment with concise answers.)
`;
  }

  // Call Groq LLM
  let draftMarkdown = '';
  try {
    const groq = new Groq({ apiKey: config.groq.apiKey });
    const response = await groq.chat.completions.create({
      model: config.groq.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.6,
      max_tokens: 1800,
    });
    draftMarkdown = response.choices[0]?.message?.content?.trim() || '';
  } catch (err) {
    console.error(`[AI Drafter Error] Groq API call failed: ${err.message}`);
    throw new Error(`Failed to generate draft with Groq: ${err.message}`);
  }

  // Save draft Markdown file
  const draftsDir = config.paths.drafts;
  if (!fs.existsSync(draftsDir)) {
    fs.mkdirSync(draftsDir, { recursive: true });
  }

  // Generate safe filename: e.g., EC201_Reflective_Journal_4_Draft.md
  const cleanSubject = asgt.subject
    .split('-')[0]
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const cleanTitle = asgt.title
    .replace(/\s*\(.*?\)\s*$/, '')
    .trim()
    .replace(/[^a-zA-Z0-9]/g, '_');
  const filename = `${cleanSubject}_${cleanTitle}_Draft.md`;
  const filePath = path.join(draftsDir, filename);

  fs.writeFileSync(filePath, draftMarkdown, 'utf8');
  console.log(`[AI Drafter] Draft saved to: ${filePath}`);

  // Email draft to student
  const emailSubject = `[AI Draft Ready] ${asgt.subject} - ${asgt.title}`;
  const htmlContent = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f7f9fb; padding: 24px; color: #2d3748;">
      <div style="max-width: 680px; margin: 0 auto; background: #ffffff; border-radius: 10px; padding: 30px; box-shadow: 0 4px 12px rgba(0,0,0,0.06);">
        <div style="border-bottom: 2px solid #3182ce; padding-bottom: 16px; margin-bottom: 20px;">
          <h2 style="color: #2b6cb0; margin: 0 0 6px 0;">AI Draft Ready: ${asgt.title}</h2>
          <span style="font-size: 14px; color: #718096;"><strong>Course:</strong> ${asgt.subject} | <strong>Due:</strong> ${new Date(asgt.due_date).toLocaleString()}</span>
        </div>
        <p style="font-size: 14px; line-height: 1.6; color: #4a5568;">Your AI starter draft has been generated using <strong>${config.groq.model}</strong> and saved to your local drafts folder:</p>
        <div style="background: #edf2f7; padding: 12px; border-radius: 6px; font-family: monospace; font-size: 13px; margin: 16px 0; word-break: break-all;">
          ${filePath}
        </div>
        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
        <div style="font-size: 14px; line-height: 1.7; color: #2d3748; white-space: pre-wrap;">${draftMarkdown.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
      </div>
    </div>
  `;

  await notifier.sendEmail({
    subject: emailSubject,
    htmlContent,
    textContent: `AI Starter Draft for ${asgt.title} (${asgt.subject})\n\nSaved locally at: ${filePath}\n\n${draftMarkdown}`,
    attachments: [{ filename, path: filePath }],
  });

  // Build compact WhatsApp preview (< 1,000 characters)
  // Extract first 2 content paragraphs
  const previewBody = draftMarkdown
    .split('\n')
    .filter((line) => line.trim().length > 0 && !line.startsWith('#'))
    .slice(0, 4)
    .join('\n')
    .slice(0, 400);

  const previewText = `📝 *AI Draft Ready!*\n\n📌 *Subject:* ${asgt.subject}\n📋 *Task:* ${asgt.title}\n📁 *Saved to:* drafts/${filename}\n✉️ *Emailed to:* ${config.email.recipient || 'Student Inbox'}\n\n💡 *Preview Excerpt:*\n${previewBody}...\n\n✅ _Full draft saved in drafts/ & delivered to your email._`;

  return {
    success: true,
    assignmentId: asgt.assignment_id,
    title: asgt.title,
    subject: asgt.subject,
    filename,
    filePath,
    previewText,
    draftContent: draftMarkdown,
  };
}

module.exports = {
  generateAssignmentDraft,
  findMatchingDeadline,
  SUBJECT_ALIASES,
};
