/**
 * Two-Way WhatsApp Command Webhook Server
 * Express webhook server listening for Meta WhatsApp Cloud API webhooks.
 * Validates Meta verification challenges, enforces single-user phone authentication,
 * and executes bidirectional commands (status, draft, scan, files, help).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { config } = require('../config/env');
const db = require('../db/database');
const notifier = require('../notifications/notifier');
const drafter = require('../agent/drafter');
const orchestrator = require('../agent/orchestrator');

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

      // Only text messages trigger commands
      if (message.type !== 'text') {
        console.log(`[WhatsApp Webhook] Received non-text message type (${message.type}). Ignoring.`);
        return;
      }

      // Security Guard: Verify sender phone against config.whatsapp.recipientPhone
      const senderDigits = (message.from || '').replace(/\D/g, '');
      const allowedDigits = (config.whatsapp.recipientPhone || '').replace(/\D/g, '');

      if (!allowedDigits || senderDigits !== allowedDigits) {
        console.warn(
          `[WhatsApp Webhook Security] Blocked unauthorized message from ${message.from} (Expected: ${config.whatsapp.recipientPhone})`
        );
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
 * Parses and executes incoming user commands, replying via WhatsApp
 */
async function handleWhatsAppCommand(rawText) {
  const text = (rawText || '').trim();
  const lower = text.toLowerCase();

  // Command: HELP
  if (lower === 'help' || lower === '?') {
    const helpMsg = `🤖 *Autonomous Sidus ERP Assistant*

Here are the commands you can send me:

📋 *status* or *deadlines*
View all active Sidus assignments grouped by deadline urgency.

📝 *draft <subject>*
Generate an AI draft or outline (e.g., *draft ec201*, *draft cs210*, *draft ds201*, *draft cs209*, *draft ma113*).

🔄 *scan* or *run*
Trigger an immediate Sidus portal scrape and local file submission check.

📁 *files*
List all completed PDFs and DOCXs in your assignment folder.

❓ *help*
Display this command menu.

_Send any command anytime right here in this chat!_`;

    await notifier.sendWhatsAppMessage({ textMessage: helpMsg });
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

    await notifier.sendWhatsAppMessage({
      textMessage: result.previewText,
    });
    return;
  }

  // Command: SCAN / RUN
  if (lower === 'scan' || lower === 'run') {
    await notifier.sendWhatsAppMessage({
      textMessage: '🔄 *Starting live Sidus scrape & folder scan...*\nChecking portal deadlines and matching assignments.',
    });

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
