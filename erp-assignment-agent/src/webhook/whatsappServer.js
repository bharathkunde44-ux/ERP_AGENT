/**
 * Two-Way WhatsApp Command Webhook Server
 * Express webhook server listening for Meta WhatsApp Cloud API webhooks.
 * Validates Meta verification challenges, enforces single-user phone authentication,
 * and executes bidirectional commands (status, draft, scan, files, help).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { config } = require('../config/env');
const db = require('../db/database');
const notifier = require('../notifications/notifier');
const drafter = require('../agent/drafter');
const orchestrator = require('../agent/orchestrator');
const erp = require('../browser/erpAutomation');
const scanner = require('../scanner/folderScanner');
const { matchAssignmentForFile } = require('../agent/assignmentMatcher');
const driveSync = require('../services/driveSync');
const telegramBot = require('../services/telegramBot');

let serverInstance = null;

function createWebhookApp() {
  const app = express();
  app.use(express.json());

  // Health check endpoints
  app.get('/', (req, res) => {
    res.status(200).send('OK');
  });

  app.get('/health', (req, res) => {
    res.status(200).send('OK');
  });

  // Telegram Webhook Endpoint (Zero-Conflict Render Mode)
  app.post('/telegram-webhook', (req, res) => {
    res.sendStatus(200);
    try {
      const bot = telegramBot.getTelegramBot();
      if (bot && req.body) {
        bot.processUpdate(req.body);
      }
    } catch (err) {
      console.error('[Telegram Webhook Error]:', err.message);
    }
  });

  // 1. Meta Webhook Verification Handshake
  app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const expectedToken = config.webhook.verifyToken || process.env.WHATSAPP_VERIFY_TOKEN || 'sidus_erp_verify_2026';

    if (mode === 'subscribe' && token === expectedToken) {
      console.log(`[WhatsApp Webhook] Meta challenge verification successful. Responding with challenge token.`);
      return res.status(200).send(challenge);
    }

    console.warn(`[WhatsApp Webhook] Verification failed. Received token: "${token}", Expected: "${expectedToken}"`);
    return res.sendStatus(403);
  });

  // 2. Meta Incoming Message Event Webhook
  app.post('/webhook', (req, res) => {
    // Immediately return 200 OK to satisfy Meta webhook retry SLA
    res.sendStatus(200);

    try {
      const entry = req.body?.entry?.[0];
      const change = entry?.changes?.[0]?.value;
      const message = change?.messages?.[0];

      // If event is not an incoming user message, ignore
      if (!message) return;

      // Security Guard: Verify sender phone against config.whatsapp.recipientPhone
      const senderDigits = (message.from || '').replace(/\D/g, '');
      const allowedDigits = (config.whatsapp.recipientPhone || '').replace(/\D/g, '');

      if (!allowedDigits || senderDigits !== allowedDigits) {
        console.warn(
          `[WhatsApp Webhook Security] Blocked unauthorized message from ${message.from} (Expected: ${config.whatsapp.recipientPhone})`
        );
        return;
      }

      // Channel A: Handle Document Uploads (PDF/DOCX)
      if (message.type === 'document') {
        const docName = message.document?.filename || 'document';
        console.log(`[WhatsApp Webhook] Incoming document from student (${message.from}): "${docName}"`);
        handleIncomingDocument(message).catch((err) => {
          console.error(`[WhatsApp Document Error]: ${err.message}`);
          notifier.sendWhatsAppMessage({
            textMessage: `⚠️ *Document Upload Error:* ${err.message}`,
          });
        });
        return;
      }

      // Only text messages trigger commands beyond this point
      if (message.type !== 'text') {
        console.log(`[WhatsApp Webhook] Received unsupported message type (${message.type}). Ignoring.`);
        return;
      }

      const rawCommand = (message.text?.body || '').trim();
      console.log(`[WhatsApp Webhook] Command received from student (${message.from}): "${rawCommand}"`);

      // Execute command asynchronously
      handleWhatsAppCommand(rawCommand).catch((err) => {
        console.error(`[WhatsApp Webhook Command Error]: ${err.message}`);
        notifier.sendWhatsAppMessage({
          textMessage: `⚠️ *Command Error:* ${err.message}`,
        });
      });
    } catch (err) {
      console.error('[WhatsApp Webhook Error]:', err.message);
    }
  });

  return app;
}

/**
 * Handles incoming document messages (PDF/DOCX) from Meta WhatsApp Cloud API
 */
async function handleIncomingDocument(message) {
  const mediaId = message.document?.id;
  const originalName = message.document?.filename || 'document.pdf';
  const caption = (message.document?.caption || '').trim();

  const ext = path.extname(originalName).toLowerCase();
  if (ext !== '.pdf' && ext !== '.docx') {
    await notifier.sendWhatsAppMessage({
      textMessage: `⚠️ *Unsupported file format:* "${originalName}". Only *.pdf* and *.docx* files can be submitted to Sidus ERP.`,
    });
    return;
  }

  // Immediate acknowledgement
  await notifier.sendWhatsAppMessage({
    textMessage: `📥 *Document Received:* \`${originalName}\`${caption ? `\n_Caption:_ "${caption}"` : ''}\nDownloading and matching against active Sidus deadlines...`,
  });

  const downloadDir = config.paths.collegeAssignments;
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }

  const sanitizedName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const targetPath = path.join(downloadDir, sanitizedName);

  // 1. Fetch Media URL from Meta Cloud API
  const metaUrl = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${mediaId}`;
  const metaRes = await axios.get(metaUrl, {
    headers: { Authorization: `Bearer ${config.whatsapp.apiToken}` },
    timeout: 20000,
  });

  const downloadUrl = metaRes.data?.url;
  if (!downloadUrl) {
    throw new Error('Meta did not return a valid download URL for the document.');
  }

  // 2. Download binary file buffer using Bearer token
  const fileRes = await axios.get(downloadUrl, {
    headers: { Authorization: `Bearer ${config.whatsapp.apiToken}` },
    responseType: 'arraybuffer',
    timeout: 30000,
  });

  fs.writeFileSync(targetPath, Buffer.from(fileRes.data));
  console.log(`[WhatsApp Webhook] Downloaded document to: ${targetPath}`);

  // 3. Extract text content quietly
  let extractedText = '';
  try {
    if (ext === '.pdf') {
      extractedText = await scanner.extractTextFromPdf(targetPath);
    } else if (ext === '.docx') {
      extractedText = await scanner.extractTextFromDocx(targetPath);
    }
  } catch (_) {}

  // 4. Match file to active Sidus FILE UPLOAD assignments
  const matchResult = await matchAssignmentForFile({
    fileName: sanitizedName,
    caption,
    extractedText,
  });

  if (matchResult.matched && matchResult.assignment) {
    const asgt = matchResult.assignment;
    console.log(`[WhatsApp Webhook] Matched "${sanitizedName}" to [${asgt.subject}] ${asgt.title} (Score: ${matchResult.score}%)`);

    // Save pending approval in SQLite
    await db.savePendingApproval({
      filePath: targetPath,
      fileName: sanitizedName,
      assignmentId: asgt.assignment_id || asgt.assignmentId,
      subject: asgt.subject,
      title: asgt.title,
      source: 'WhatsApp',
    });

    const promptMsg = `📄 *File ready (WhatsApp):* \`${sanitizedName}\`\n🎯 *Matched to:* *${asgt.subject}* - *${asgt.title}*\n\nReply *approve* to submit to Sidus, or *cancel* to skip.`;
    await notifier.sendWhatsAppMessage({ textMessage: promptMsg });
  } else {
    console.log(`[WhatsApp Webhook] Could not match "${sanitizedName}" to an active assignment.`);
    const pendingList = matchResult.availableDeadlines || [];
    const asgtList = pendingList.map((d) => `• *[${d.subject}]* ${d.title}`).join('\n') || '(No active FILE UPLOAD assignments)';

    let reasonNote = '';
    if (matchResult.detectedSubjectCode) {
      reasonNote = `\n⚠️ *Detected subject:* \`${matchResult.detectedSubjectCode}\`, but no active FILE UPLOAD assignment was found for this subject on Sidus.`;
    }

    const unassignedMsg = `📄 *Document Received:* \`${sanitizedName}\`\n❓ *Could not confidently match to an active assignment.*${caption ? `\n_Caption received:_ "${caption}"` : ''}${reasonNote}\n\n*Active FILE UPLOAD Assignments:*\n${asgtList}\n\nPlease resend the document with a caption matching your subject (e.g. *cs210 lab 5*).`;
    await notifier.sendWhatsAppMessage({ textMessage: unassignedMsg });
  }
}

/**
 * Parses and executes incoming user commands, replying via WhatsApp
 */
async function handleWhatsAppCommand(rawText) {
  const text = (rawText || '').trim();
  const lower = text.toLowerCase();

  // Command: HELP
  if (lower === 'help' || lower === '?') {
    const helpMsg = `🤖 *Autonomous Sidus ERP Assistant*

Here are the commands you can send me:

📄 *Send PDF/DOCX Document*
Send any finished assignment file directly in this chat with an optional caption (e.g. "cs210 lab 5").

✅ *approve* or *yes*
Confirm and submit the pending assignment to the Sidus portal.

🚫 *cancel* or *no*
Cancel the pending assignment submission.

📋 *status* or *deadlines*
View all active Sidus assignments grouped by deadline urgency.

📝 *draft <subject>*
Generate an AI draft or outline (e.g., *draft ec201*, *draft cs210*, *draft ds201*, *draft cs209*, *draft ma113*).

🔄 *scan* or *run*
Trigger an immediate Sidus portal scrape, Google Drive sync, and file check.

📁 *files*
List all completed PDFs and DOCXs in your assignment folder.

❓ *help*
Display this command menu.

_Send any command or document anytime right here in this chat!_`;

    await notifier.sendWhatsAppMessage({ textMessage: helpMsg });
    return;
  }

  // Command: APPROVE / YES / CONFIRM / SUBMIT
  if (lower === 'approve' || lower === 'yes' || lower === 'confirm' || lower === 'submit') {
    const pending = await db.getLatestPendingApproval();
    if (!pending) {
      await notifier.sendWhatsAppMessage({
        textMessage: 'ℹ️ *No pending assignment approvals found.*\nSend a PDF/DOCX document here or drop a file in Google Drive to start.',
      });
      return;
    }

    if (!fs.existsSync(pending.file_path)) {
      await notifier.sendWhatsAppMessage({
        textMessage: `⚠️ *File not found:* \`${pending.file_name}\` is no longer on disk. Please resend the document.`,
      });
      await db.resolvePendingApproval(pending.id, 'EXPIRED');
      return;
    }

    await notifier.sendWhatsAppMessage({
      textMessage: `⏳ *Approving submission...*\nUploading \`${pending.file_name}\` for *${pending.title}* to Sidus portal. This takes ~30 seconds.`,
    });

    try {
      const subResult = await erp.submitAssignment({
        portalUrl: config.erp.portalUrl,
        assignmentId: pending.assignment_id,
        filePath: pending.file_path,
        dryRun: false,
        confidenceScore: 100,
        reasoning: `Approved by student via WhatsApp command (${pending.source} upload).`,
      });

      if (subResult && subResult.success) {
        await db.resolvePendingApproval(pending.id, 'APPROVED');
        const successMsg = `🎉 *Submission Successful!*\n\n• *Subject:* ${pending.subject}\n• *Assignment:* ${pending.title}\n• *File:* \`${pending.file_name}\`\n• *Source:* ${pending.source}\n• *Time:* ${new Date().toLocaleString()}\n\nProof screenshot recorded. Great job!`;
        await notifier.sendWhatsAppMessage({ textMessage: successMsg });
      } else {
        await notifier.sendWhatsAppMessage({
          textMessage: `❌ *Submission Failed:* ${subResult ? subResult.message : 'Upload failed on portal.'}\n\nYou can reply *approve* to retry, or *cancel* to skip.`,
        });
      }
    } catch (subErr) {
      console.error('[WhatsApp Approval Error]:', subErr.message);
      await notifier.sendWhatsAppMessage({
        textMessage: `❌ *Submission Error:* ${subErr.message}\n\nYou can reply *approve* to retry, or *cancel* to skip.`,
      });
    }
    return;
  }

  // Command: CANCEL / NO / SKIP / ABORT
  if (lower === 'cancel' || lower === 'no' || lower === 'skip' || lower === 'abort') {
    const pending = await db.getLatestPendingApproval();
    if (!pending) {
      await notifier.sendWhatsAppMessage({
        textMessage: 'ℹ️ *No pending approvals to cancel.*',
      });
      return;
    }

    await db.resolvePendingApproval(pending.id, 'CANCELLED');
    await notifier.sendWhatsAppMessage({
      textMessage: `🚫 *Submission Cancelled.*\nSkipped submitting \`${pending.file_name}\` for *${pending.title}*.`,
    });
    return;
  }

  // Command: STATUS / DEADLINES
  if (lower === 'status' || lower === 'deadlines') {
    const pending = await db.getPendingDeadlines();
    if (!pending || pending.length === 0) {
      await notifier.sendWhatsAppMessage({
        textMessage: '🎉 *All Caught Up!* No pending deadlines found on Sidus ERP.',
      });
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

    report += `\n💡 _Tip: Reply "draft <subject>" to generate starter drafts._`;

    await notifier.sendWhatsAppMessage({ textMessage: report });
    return;
  }

  // Command: DRAFT <subject>
  if (lower.startsWith('draft')) {
    const subjectParam = text.replace(/^draft\s*/i, '').trim();
    if (!subjectParam) {
      await notifier.sendWhatsAppMessage({
        textMessage:
          '⚠️ *Please specify a subject:*\nExample: `draft ec201`, `draft cs210`, `draft ds201`, `draft cs209`, `draft ma113`',
      });
      return;
    }

    // Immediate acknowledgement
    await notifier.sendWhatsAppMessage({
      textMessage: `⏳ *Drafting "${subjectParam.toUpperCase()}" with Groq AI (${config.groq.model})...*\nThis takes ~5 seconds.`,
    });

    const result = await drafter.generateAssignmentDraft(subjectParam);

    if (!result.success) {
      await notifier.sendWhatsAppMessage({
        textMessage: `❌ *Drafting Failed:* ${result.message}`,
      });
      return;
    }

    // Only send standalone text preview if document delivery wasn't handled on WhatsApp
    if (!result.deliveredWhatsApp) {
      await notifier.sendWhatsAppMessage({
        textMessage: result.previewText,
      });
    }
    return;
  }

  // Command: SCAN / RUN
  if (lower === 'scan' || lower === 'run') {
    await notifier.sendWhatsAppMessage({
      textMessage: '🔄 *Starting live Sidus scrape & folder scan...*\nChecking portal deadlines, Google Drive shared folder, and local files.',
    });

    // Check Google Drive shared folder for new files
    try {
      await driveSync.syncGoogleDriveFiles();
    } catch (driveErr) {
      console.warn('[WhatsApp Scan] Google Drive sync notice:', driveErr.message);
    }

    const cycleResult = await orchestrator.runAgentCycle({ dryRun: false });

    if (cycleResult.status === 'ALREADY_RUNNING') {
      await notifier.sendWhatsAppMessage({
        textMessage: '⏳ *Notice:* An automated cycle is already in progress. Please wait a moment.',
      });
      return;
    }

    const actionCount = cycleResult.executedActions?.length || 0;
    const summaryMsg = `✅ *Sidus Cycle Complete!*\n\n• Executed Actions: *${actionCount}*\n• Watched Folder: \`${path.basename(config.paths.collegeAssignments)}\`\n• Status: *${cycleResult.status}*`;

    await notifier.sendWhatsAppMessage({ textMessage: summaryMsg });
    return;
  }

  // Command: FILES
  if (lower === 'files' || lower === 'list') {
    const folder = config.paths.collegeAssignments;
    if (!fs.existsSync(folder)) {
      await notifier.sendWhatsAppMessage({
        textMessage: `📁 *Folder Not Found:* \`${folder}\``,
      });
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
      await notifier.sendWhatsAppMessage({
        textMessage: `📁 *No completed .pdf or .docx files found* in \`${path.basename(folder)}\`.`,
      });
      return;
    }

    const fileList = files
      .slice(0, 12)
      .map((f) => `• \`${f.name}\` (${f.sizeKB} KB)`)
      .join('\n');

    const msg = `📁 *Completed Assignment Files (${files.length} Total):*\n\n${fileList}\n\n_Folder: ${folder}_`;
    await notifier.sendWhatsAppMessage({ textMessage: msg });
    return;
  }

  // Fallback for unknown commands
  await notifier.sendWhatsAppMessage({
    textMessage: `❓ *Unrecognized command:* "${text}"\n\nReply with *help* to see the list of supported commands (*status*, *draft <subject>*, *scan*, *files*).`,
  });
}

/**
 * Starts the WhatsApp Webhook server
 */
function startWhatsAppWebhookServer(customPort = null) {
  const port = customPort || config.webhook.port || 3005;
  const app = createWebhookApp();

  return new Promise((resolve) => {
    serverInstance = app.listen(port, () => {
      console.log(`[WhatsApp Webhook] Server listening on http://localhost:${port}`);
      console.log(`[WhatsApp Webhook] Meta Callback URL: http://localhost:${port}/webhook`);
      console.log(`[WhatsApp Webhook] Verify Token: "${config.webhook.verifyToken}"`);
      resolve(serverInstance);
    });
  });
}

/**
 * Gracefully stops the WhatsApp Webhook server
 */
function stopWhatsAppWebhookServer() {
  return new Promise((resolve) => {
    if (serverInstance) {
      serverInstance.close(() => {
        console.log('[WhatsApp Webhook] Server stopped.');
        serverInstance = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

module.exports = {
  createWebhookApp,
  startWhatsAppWebhookServer,
  stopWhatsAppWebhookServer,
  handleWhatsAppCommand,
};
