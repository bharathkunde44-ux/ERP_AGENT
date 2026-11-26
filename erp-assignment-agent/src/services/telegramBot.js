/**
 * Telegram Bot Integration Service (@bharath_sidus_bot)
 * Autonomous bidirectional communication channel for Sidus ERP Assignment Agent.
 *
 * Features:
 * - Single-user owner security lock matching process.env.TELEGRAM_CHAT_ID
 * - Interactive Inline Keyboard buttons (Approve / Cancel)
 * - Direct PDF/DOCX assignment file uploads via chat
 * - Zero-Conflict Render mode: Webhooks on Render, Polling locally
 * - Proactive deadline reminders, auto-submission confirmations & Drive sync notifications
 */

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { config } = require('../config/env');
const db = require('../db/database');
const scanner = require('../scanner/folderScanner');
const { matchAssignmentForFile } = require('../agent/assignmentMatcher');

let botInstance = null;
let isInitialized = false;

/**
 * Checks whether an incoming message or callback query originates from the authorized owner
 */
function isAuthorizedUser(msgOrQuery) {
  const allowedId = String(process.env.TELEGRAM_CHAT_ID || config.telegram?.chatId || '').trim();
  if (!allowedId) return false;

  const senderId = String(msgOrQuery?.from?.id || msgOrQuery?.chat?.id || '').trim();
  return senderId === allowedId;
}

/**
 * Safely sends a text message to the owner's Telegram chat.
 * Falls back to plain text if Markdown parsing fails.
 */
async function sendTelegramMessage(text, options = {}) {
  const token = (process.env.TELEGRAM_BOT_TOKEN || config.telegram?.botToken || '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || config.telegram?.chatId || '').trim();

  if (!botInstance || !token || !chatId) {
    return { success: false, skipped: true };
  }

  try {
    const msg = await botInstance.sendMessage(chatId, text, { parse_mode: 'Markdown', ...options });
    return { success: true, messageId: msg.message_id };
  } catch (err) {
    // If Markdown parsing fails due to unescaped special characters, fall back to plain text
    try {
      const fallbackOptions = { ...options };
      delete fallbackOptions.parse_mode;
      const msg = await botInstance.sendMessage(chatId, text, fallbackOptions);
      return { success: true, messageId: msg.message_id };
    } catch (fallbackErr) {
      console.error(`[Telegram Error] Failed to send message: ${fallbackErr.message}`);
      return { success: false, error: fallbackErr.message };
    }
  }
}

/**
 * Safely sends a document attachment to the owner's Telegram chat.
 * Falls back to sending without parse_mode if Markdown parsing in caption fails.
 */
async function sendTelegramDocument(filePath, filename, caption = '', options = {}) {
  const token = (process.env.TELEGRAM_BOT_TOKEN || config.telegram?.botToken || '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || config.telegram?.chatId || '').trim();

  if (!botInstance || !token || !chatId) {
    return { success: false, skipped: true };
  }

  if (!fs.existsSync(filePath)) {
    return { success: false, error: `File not found on disk: ${filePath}` };
  }

  const baseFilename = filename || path.basename(filePath);
  const trimmedCaption = caption ? caption.slice(0, 1024) : '';

  try {
    const fileStream = fs.createReadStream(filePath);
    const msg = await botInstance.sendDocument(
      chatId,
      fileStream,
      {
        caption: trimmedCaption,
        parse_mode: 'Markdown',
        ...options,
      },
      {
        filename: baseFilename,
        contentType: 'text/markdown',
      }
    );
    console.log(`[Telegram Document Sent] Message ID: ${msg.message_id}`);
    return { success: true, messageId: msg.message_id };
  } catch (err) {
    try {
      const fileStream = fs.createReadStream(filePath);
      const fallbackOptions = { ...options };
      delete fallbackOptions.parse_mode;
      const msg = await botInstance.sendDocument(
        chatId,
        fileStream,
        {
          caption: trimmedCaption,
          ...fallbackOptions,
        },
        {
          filename: baseFilename,
          contentType: 'text/markdown',
        }
      );
      console.log(`[Telegram Document Sent (Fallback)] Message ID: ${msg.message_id}`);
      return { success: true, messageId: msg.message_id };
    } catch (fallbackErr) {
      console.error(`[Telegram Error] Failed to send document: ${fallbackErr.message}`);
      return { success: false, error: fallbackErr.message };
    }
  }
}

/**
 * Executes assignment submission approval
 */
async function executeApproval(sourceLabel = 'command') {
  const pending = await db.getLatestPendingApproval();
  if (!pending) {
    await sendTelegramMessage(
      'ℹ️ *No pending assignment approvals found.*\nSend a PDF/DOCX document here or drop a file into Google Drive to start.'
    );
    return;
  }

  if (!fs.existsSync(pending.file_path)) {
    await sendTelegramMessage(
      `⚠️ *File not found:* \`${pending.file_name}\` is no longer on disk. Please resend the document.`
    );
    await db.resolvePendingApproval(pending.id, 'EXPIRED');
    return;
  }

  await sendTelegramMessage(
    `⏳ *Approving submission...*\nUploading \`${pending.file_name}\` for *${pending.title}* to Sidus portal. This takes ~30 seconds.`
  );

  try {
    const erp = require('../browser/erpAutomation');
    const subResult = await erp.submitAssignment({
      portalUrl: config.erp.portalUrl,
      assignmentId: pending.assignment_id,
      filePath: pending.file_path,
      dryRun: false,
      confidenceScore: 100,
      reasoning: `Approved by student via Telegram (${sourceLabel}, ${pending.source} upload).`,
    });

    if (subResult && subResult.success) {
      await db.resolvePendingApproval(pending.id, 'APPROVED');
      const successMsg = `🎉 *Submission Successful!*\n\n• *Subject:* ${pending.subject}\n• *Assignment:* ${pending.title}\n• *File:* \`${pending.file_name}\`\n• *Source:* ${pending.source}\n• *Time:* ${new Date().toLocaleString()}\n\nProof screenshot recorded. Great job!`;
      await sendTelegramMessage(successMsg);
    } else {
      await sendTelegramMessage(
        `❌ *Submission Failed:* ${subResult ? subResult.message : 'Upload failed on portal.'}\n\nYou can click *Approve* to retry, or *Cancel* to skip.`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Retry Approve', callback_data: 'approve_submission' },
                { text: '❌ Cancel', callback_data: 'cancel_submission' },
              ],
            ],
          },
        }
      );
    }
  } catch (subErr) {
    console.error('[Telegram Approval Error]:', subErr.message);
    await sendTelegramMessage(
      `❌ *Submission Error:* ${subErr.message}\n\nYou can reply *approve* to retry, or *cancel* to skip.`
    );
  }
}

/**
 * Executes assignment submission cancellation
 */
async function executeCancellation(sourceLabel = 'command') {
  const pending = await db.getLatestPendingApproval();
  if (!pending) {
    await sendTelegramMessage('ℹ️ *No pending approvals to cancel.*');
    return;
  }

  await db.resolvePendingApproval(pending.id, 'CANCELLED');
  await sendTelegramMessage(
    `🚫 *Submission Cancelled.*\nSkipped submitting \`${pending.file_name}\` for *${pending.title}* (${sourceLabel}).`
  );
}

/**
 * Handles incoming document messages (PDF/DOCX) from Telegram
 */
async function handleTelegramDocument(msg) {
  const doc = msg.document;
  const originalName = doc?.file_name || 'document.pdf';
  const caption = (msg.caption || '').trim();

  const ext = path.extname(originalName).toLowerCase();
  if (ext !== '.pdf' && ext !== '.docx') {
    await sendTelegramMessage(
      `⚠️ *Unsupported file format:* \`${originalName}\`. Only *.pdf* and *.docx* files can be submitted to Sidus ERP.`
    );
    return;
  }

  // Immediate acknowledgement
  await sendTelegramMessage(
    `📥 *Document Received:* \`${originalName}\`${caption ? `\n_Caption:_ "${caption}"` : ''}\nDownloading and matching against active Sidus deadlines...`
  );

  const downloadDir = config.paths.collegeAssignments;
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }

  const sanitizedName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const targetPath = path.join(downloadDir, sanitizedName);

  try {
    // 1. Fetch file download link from Telegram
    const fileLink = await botInstance.getFileLink(doc.file_id);
    const fileRes = await axios.get(fileLink, {
      responseType: 'arraybuffer',
      timeout: 30000,
    });

    fs.writeFileSync(targetPath, Buffer.from(fileRes.data));
    console.log(`[Telegram Bot] Downloaded document to: ${targetPath}`);

    // 2. Extract text quietly for matcher heuristics
    let extractedText = '';
    try {
      if (ext === '.pdf') {
        extractedText = await scanner.extractTextFromPdf(targetPath);
      } else if (ext === '.docx') {
        extractedText = await scanner.extractTextFromDocx(targetPath);
      }
    } catch (_) {}

    // 3. Match against active Sidus FILE UPLOAD assignments
    const matchResult = await matchAssignmentForFile({
      fileName: sanitizedName,
      caption,
      extractedText,
    });

    if (matchResult.matched && matchResult.assignment) {
      const asgt = matchResult.assignment;
      console.log(`[Telegram Bot] Matched "${sanitizedName}" to [${asgt.subject}] ${asgt.title} (${matchResult.score}%)`);

      // Save pending approval in SQLite
      await db.savePendingApproval({
        filePath: targetPath,
        fileName: sanitizedName,
        assignmentId: asgt.assignment_id || asgt.assignmentId,
        subject: asgt.subject,
        title: asgt.title,
        source: 'Telegram',
      });

      const promptMsg = `📄 *File ready (Telegram):* \`${sanitizedName}\`\n🎯 *Matched to:* *${asgt.subject}* - *${asgt.title}*\n\nClick below to approve submission to Sidus ERP or cancel:`;
      await sendTelegramMessage(promptMsg, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Approve', callback_data: 'approve_submission' },
              { text: '❌ Cancel', callback_data: 'cancel_submission' },
            ],
          ],
        },
      });
    } else {
      console.log(`[Telegram Bot] Could not match "${sanitizedName}" to an active assignment.`);
      const pendingList = matchResult.availableDeadlines || [];
      const asgtList = pendingList.map((d) => `• *[${d.subject}]* ${d.title}`).join('\n') || '(No active FILE UPLOAD assignments)';

      let reasonNote = '';
      if (matchResult.detectedSubjectCode) {
        reasonNote = `\n⚠️ *Detected subject:* \`${matchResult.detectedSubjectCode}\`, but no active FILE UPLOAD assignment was found for this subject on Sidus.`;
      }

      const unassignedMsg = `📄 *Document Received:* \`${sanitizedName}\`\n❓ *Could not confidently match to an active assignment.*${caption ? `\n_Caption received:_ "${caption}"` : ''}${reasonNote}\n\n*Active FILE UPLOAD Assignments:*\n${asgtList}\n\nPlease resend the document with a caption matching your subject (e.g. \`cs210 lab 5\`).`;
      await sendTelegramMessage(unassignedMsg);
    }
  } catch (err) {
    console.error(`[Telegram Document Error]: ${err.message}`);
    await sendTelegramMessage(`⚠️ *Document Processing Error:* ${err.message}`);
  }
}

/**
 * Handles incoming text commands from Telegram
 */
async function handleTelegramText(rawText) {
  const text = (rawText || '').trim();
  const lower = text.toLowerCase();

  // Command: /START
  if (lower === '/start') {
    const welcomeMsg = `👋 *Hello Bharath! Welcome to @bharath_sidus_bot*

I am your 24/7 Autonomous Sidus ERP Assistant. I track your deadlines, sync your Google Drive folder, and auto-submit assignments with your approval.

*What you can do here:*
• 📄 *Upload Document:* Send any .pdf or .docx file right here (with optional caption like \`cs210 lab 5\`).
• 📋 */status* - Check active Sidus deadlines grouped by urgency.
• 🔄 */scan* - Trigger an immediate portal scrape & Google Drive sync.
• 📁 */files* - List completed files in your assignment folder.
• 📝 */draft <subject>* - Generate an AI draft outline with Groq.
• ✅ */approve* or ❌ */cancel* - Confirm or skip pending submissions.
• ❓ */help* - View available commands.

Interactive buttons will also appear whenever an assignment is ready for submission!`;
    await sendTelegramMessage(welcomeMsg);
    return;
  }

  // Command: HELP
  if (lower === '/help' || lower === 'help' || lower === '?') {
    const helpMsg = `🤖 *Sidus ERP Assistant Commands:*

📄 *Send PDF/DOCX Document*
Send any finished assignment file directly in this chat with an optional caption (e.g. \`cs210 lab 5\`).

✅ */approve* or *approve*
Confirm and submit the pending assignment to the Sidus portal.

🚫 */cancel* or *cancel*
Cancel the pending assignment submission.

📋 */status* or *status*
View all active Sidus assignments grouped by deadline urgency.

📝 */draft <subject>* (e.g., \`/draft cs210\`, \`/draft ec201\`)
Generate an AI draft or outline with Groq.

🔄 */scan* or *scan*
Trigger an immediate Sidus portal scrape, Google Drive sync, and file check.

📁 */files* or *files*
List completed assignment files in your local assignments folder.

❓ */help*
Display this command menu.`;
    await sendTelegramMessage(helpMsg);
    return;
  }

  // Command: APPROVE
  if (lower === '/approve' || lower === 'approve' || lower === 'yes' || lower === 'confirm' || lower === 'submit') {
    await executeApproval('text command');
    return;
  }

  // Command: CANCEL
  if (lower === '/cancel' || lower === 'cancel' || lower === 'no' || lower === 'skip' || lower === 'abort') {
    await executeCancellation('text command');
    return;
  }

  // Command: STATUS
  if (lower === '/status' || lower === 'status' || lower === 'deadlines') {
    const pending = await db.getPendingDeadlines();
    if (!pending || pending.length === 0) {
      await sendTelegramMessage('🎉 *All Caught Up!* No pending deadlines found on Sidus ERP.');
      return;
    }

    const urgent24 = [];
    const soon72 = [];
    const later = [];

    for (const d of pending) {
      const hoursLeft = Math.max(
        0,
        Math.round((new Date(d.due_date).getTime() - Date.now()) / (1000 * 60 * 60))
      );
      const isFileUpload = /FILE UPLOAD/i.test(d.title) || /Type:\s*FILE UPLOAD/i.test(d.description || '');
      const isJournal = /REFLECTIVE JOURNAL/i.test(d.title);
      const isQuiz = /QUIZ/i.test(d.title);

      const typeBadge = isFileUpload ? '📎 FILE UPLOAD' : isJournal ? '📝 JOURNAL' : isQuiz ? '❓ QUIZ' : '📌 TASK';
      const cleanSubject = d.subject.includes('-') ? d.subject.split('-').slice(1).join('-').trim() : d.subject.trim();
      const cleanTitle = d.title.replace(/\s*\(.*?\)\s*$/, '').trim();

      const itemStr = `• *[${cleanSubject}]* ${cleanTitle}\n  _${typeBadge}_ | Due in *${hoursLeft}h* (${new Date(d.due_date).toLocaleDateString()})`;

      if (hoursLeft <= 24) urgent24.push(itemStr);
      else if (hoursLeft <= 72) soon72.push(itemStr);
      else later.push(itemStr);
    }

    let report = `📊 *Sidus ERP Deadlines Status (${pending.length} Active)*\n`;

    if (urgent24.length > 0) {
      report += `\n🚨 *CRITICAL (Due in < 24 Hours):*\n${urgent24.join('\n\n')}\n`;
    }
    if (soon72.length > 0) {
      report += `\n⚠️ *UPCOMING (Due in 1-3 Days):*\n${soon72.join('\n\n')}\n`;
    }
    if (later.length > 0) {
      report += `\n📅 *FUTURE DEADLINES:*\n${later.join('\n\n')}\n`;
    }

    report += `\n💡 _Tip: Send /draft <subject> to generate starter drafts._`;

    await sendTelegramMessage(report);
    return;
  }

  // Command: DRAFT <subject>
  if (lower.startsWith('/draft') || lower.startsWith('draft')) {
    const subjectParam = text.replace(/^\/?draft\s*/i, '').trim();
    if (!subjectParam) {
      await sendTelegramMessage(
        '⚠️ *Please specify a subject:*\nExample: `/draft ec201`, `/draft cs210`, `/draft ds201`, `/draft cs209`, `/draft ma113`'
      );
      return;
    }

    await sendTelegramMessage(
      `⏳ *Drafting "${subjectParam.toUpperCase()}" with Groq AI (${config.groq.model})...*\nThis takes ~5 seconds.`
    );

    const drafter = require('../agent/drafter');
    const result = await drafter.generateAssignmentDraft(subjectParam);

    if (!result.success) {
      await sendTelegramMessage(`❌ *Drafting Failed:* ${result.message}`);
      return;
    }

    if (!result.deliveredTelegram) {
      await sendTelegramMessage(result.previewText);
    }
    return;
  }

  // Command: SCAN / RUN
  if (lower === '/scan' || lower === 'scan' || lower === 'run') {
    await sendTelegramMessage(
      '🔄 *Starting live Sidus scrape & folder scan...*\nChecking portal deadlines, Google Drive shared folder, and local files.'
    );

    try {
      const driveSync = require('./driveSync');
      await driveSync.syncGoogleDriveFiles();
    } catch (driveErr) {
      console.warn('[Telegram Scan] Google Drive sync notice:', driveErr.message);
    }

    const orchestrator = require('../agent/orchestrator');
    const cycleResult = await orchestrator.runAgentCycle({ dryRun: false });

    if (cycleResult.status === 'ALREADY_RUNNING') {
      await sendTelegramMessage('⏳ *Notice:* An automated cycle is already in progress. Please wait a moment.');
      return;
    }

    const actionCount = cycleResult.executedActions?.length || 0;
    const summaryMsg = `✅ *Sidus Cycle Complete!*\n\n• Executed Actions: *${actionCount}*\n• Watched Folder: \`${path.basename(config.paths.collegeAssignments)}\`\n• Status: *${cycleResult.status}*`;

    await sendTelegramMessage(summaryMsg);
    return;
  }

  // Command: FILES / LIST
  if (lower === '/files' || lower === 'files' || lower === 'list') {
    const folder = config.paths.collegeAssignments;
    if (!fs.existsSync(folder)) {
      await sendTelegramMessage(`📁 *Folder Not Found:* \`${folder}\``);
      return;
    }

    const entries = fs.readdirSync(folder, { withFileTypes: true });
    const files = entries
      .filter((e) => {
        if (e.isDirectory()) return false;
        if (e.name.startsWith('~$') || e.name.startsWith('.')) return false;
        const ext = path.extname(e.name).toLowerCase();
        return ext === '.pdf' || ext === '.docx';
      })
      .map((e) => {
        const stats = fs.statSync(path.join(folder, e.name));
        return {
          name: e.name,
          sizeKB: Math.round(stats.size / 1024),
          mtime: stats.mtime,
        };
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) {
      await sendTelegramMessage(`📁 *No completed .pdf or .docx files found* in \`${path.basename(folder)}\`.`);
      return;
    }

    const fileList = files
      .slice(0, 15)
      .map((f) => `• \`${f.name}\` (${f.sizeKB} KB)`)
      .join('\n');

    const msg = `📁 *Completed Assignment Files (${files.length} Total):*\n\n${fileList}\n\n_Folder: ${folder}_`;
    await sendTelegramMessage(msg);
    return;
  }

  // Fallback for unknown messages
  await sendTelegramMessage(
    `❓ *Unrecognized command:* "${text}"\n\nSend */help* to see available commands (*status*, *draft*, *scan*, *files*).`
  );
}

/**
 * Initializes the Telegram Bot service.
 * Supports Zero-Conflict Webhook on Render and Polling locally.
 */
async function initTelegramBot() {
  const token = (process.env.TELEGRAM_BOT_TOKEN || config.telegram?.botToken || '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || config.telegram?.chatId || '').trim();

  if (!token || !chatId) {
    console.log('[Telegram] Skipping initialization: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not configured');
    return null;
  }

  if (isInitialized && botInstance) {
    return botInstance;
  }

  const renderUrl = (process.env.RENDER_EXTERNAL_URL || config.telegram?.renderUrl || '').trim().replace(/\/+$/, '');

  try {
    if (renderUrl) {
      // Zero-Conflict Render Mode: Webhook
      botInstance = new TelegramBot(token, { polling: false });
      const webhookUrl = `${renderUrl}/telegram-webhook`;
      await botInstance.setWebHook(webhookUrl);
      console.log(`[Telegram] Webhook mode activated. Registered at: ${webhookUrl}`);
    } else {
      // Local development: Polling mode
      botInstance = new TelegramBot(token, { polling: false });
      try {
        await botInstance.deleteWebHook();
      } catch (_) {}
      await botInstance.startPolling();
      console.log('[Telegram] Polling mode activated (local development).');
    }

    // Register Document Handler
    botInstance.on('message', async (msg) => {
      if (!isAuthorizedUser(msg)) {
        const sender = msg.from?.id || msg.chat?.id;
        console.warn(`[Telegram Security] Blocked unauthorized message from ID: ${sender}`);
        return;
      }

      if (msg.document) {
        handleTelegramDocument(msg).catch((err) => {
          console.error('[Telegram Document Error]:', err.message);
        });
        return;
      }

      if (msg.text) {
        handleTelegramText(msg.text).catch((err) => {
          console.error('[Telegram Command Error]:', err.message);
        });
      }
    });

    // Register Interactive Button Handler
    botInstance.on('callback_query', async (query) => {
      if (!isAuthorizedUser(query)) {
        console.warn(`[Telegram Security] Blocked unauthorized callback query from ID: ${query.from?.id}`);
        return;
      }

      try {
        await botInstance.answerCallbackQuery(query.id, { text: 'Processing...' });
      } catch (err) {
        console.warn('[Telegram] answerCallbackQuery notice:', err.message);
      }

      const action = query.data;
      if (action === 'approve_submission') {
        executeApproval('inline button').catch((err) => {
          console.error('[Telegram Button Approval Error]:', err.message);
        });
      } else if (action === 'cancel_submission') {
        executeCancellation('inline button').catch((err) => {
          console.error('[Telegram Button Cancel Error]:', err.message);
        });
      }
    });

    isInitialized = true;
    console.log(`[Telegram] Bot (@bharath_sidus_bot) initialized successfully for Chat ID: ${chatId}`);
    return botInstance;
  } catch (err) {
    console.error('[Telegram Init Error]:', err.message);
    return null;
  }
}

/**
 * Gracefully stops the Telegram bot
 */
async function stopTelegramBot() {
  if (botInstance) {
    try {
      if (botInstance.isPolling()) {
        await botInstance.stopPolling();
        console.log('[Telegram] Polling stopped.');
      }
    } catch (err) {
      console.warn('[Telegram] Error stopping bot:', err.message);
    }
  }
}

/**
 * Returns current bot instance
 */
function getTelegramBot() {
  return botInstance;
}

module.exports = {
  initTelegramBot,
  stopTelegramBot,
  sendTelegramMessage,
  sendTelegramDocument,
  getTelegramBot,
  handleTelegramText,
  handleTelegramDocument,
  isAuthorizedUser,
};
