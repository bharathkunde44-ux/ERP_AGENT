/**
 * Notification Service (Email, WhatsApp Cloud API & Telegram)
 * Handles sending rich HTML emails (via Resend HTTPS, Gmail API HTTPS, or Nodemailer SMTP),
 * WhatsApp text and document alerts via Meta Cloud API, and Telegram messages/documents.
 * Includes alert throttling and duplicate spam prevention.
 */

const nodemailer = require('nodemailer');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const FormData = require('form-data');
const { config } = require('../config/env');
const db = require('../db/database');

/**
 * Creates and configures Nodemailer transporter for SMTP
 */
function createEmailTransporter() {
  if (!config.email.user || !config.email.pass) {
    return null;
  }

  return nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure,
    connectionTimeout: 4000,
    greetingTimeout: 4000,
    socketTimeout: 4000,
    auth: {
      user: config.email.user,
      pass: config.email.pass,
    },
  });
}

/**
 * Sends a rich Email alert via Resend API (HTTPS), Gmail API (HTTPS), or Nodemailer (SMTP)
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string, simulated?: boolean }>}
 */
async function sendEmail({ subject, htmlContent, textContent, attachments = [] }) {
  const recipient = (config.email.recipient || config.email.user || '').trim();
  const resendApiKey = (process.env.RESEND_API_KEY || config.email.resendApiKey || '').trim();
  const googleClientId = (process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || config.email.googleClientId || '').trim();
  const googleClientSecret = (process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || config.email.googleClientSecret || '').trim();
  const googleRefreshToken = (process.env.GMAIL_REFRESH_TOKEN || process.env.GOOGLE_REFRESH_TOKEN || config.email.googleRefreshToken || '').trim();
  const isRender = Boolean(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);

  // 1. Prioritize Resend HTTP API (Port 443 HTTPS - Works reliably on Render Free Tier)
  if (resendApiKey) {
    try {
      const resendFrom = (process.env.RESEND_FROM || config.email.resendFrom || 'College ERP Agent <onboarding@resend.dev>').trim();
      const resendAttachments = attachments
        .filter((att) => att.path && fs.existsSync(att.path))
        .map((att) => ({
          filename: att.filename || path.basename(att.path),
          content: fs.readFileSync(att.path).toString('base64'),
        }));

      const res = await axios.post(
        'https://api.resend.com/emails',
        {
          from: resendFrom,
          to: [recipient || 'delivered@resend.dev'],
          subject,
          html: htmlContent,
          text: textContent,
          attachments: resendAttachments.length > 0 ? resendAttachments : undefined,
        },
        {
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      const msgId = res.data?.id;
      console.log(`[Email Sent via Resend HTTPS] ID: ${msgId}`);
      return { success: true, messageId: msgId, provider: 'resend' };
    } catch (err) {
      const errMsg = err.response?.data?.message || err.response?.data?.error?.message || err.message;
      console.error(`[Email Failed via Resend] Error: ${errMsg}`);
      return { success: false, error: `Resend API: ${errMsg}` };
    }
  }

  // 2. Google OAuth / Gmail API (Port 443 HTTPS)
  if (googleClientId && googleClientSecret && googleRefreshToken) {
    try {
      const { google } = require('googleapis');
      const oauth2Client = new google.auth.OAuth2(googleClientId, googleClientSecret);
      oauth2Client.setCredentials({ refresh_token: googleRefreshToken });
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      const mailComposer = nodemailer.createTransport({ streamTransport: true, buffer: true });
      const mail = await mailComposer.sendMail({
        from: `"College ERP Agent" <${config.email.user || recipient}>`,
        to: recipient,
        subject,
        text: textContent,
        html: htmlContent,
        attachments: attachments.filter((att) => att.path && fs.existsSync(att.path)),
      });

      const rawBase64 = Buffer.from(mail.message)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      const res = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: rawBase64 },
      });

      console.log(`[Email Sent via Gmail API HTTPS] ID: ${res.data?.id}`);
      return { success: true, messageId: res.data?.id, provider: 'gmail_api' };
    } catch (err) {
      console.error(`[Email Failed via Gmail API] Error: ${err.message}`);
      return { success: false, error: `Gmail API: ${err.message}` };
    }
  }

  // 3. Fallback: Nodemailer SMTP
  if (!config.email.user || !config.email.pass || !recipient) {
    console.log('\n[Simulated Email Alert]');
    console.log(`To: ${recipient || '(No recipient configured)'}`);
    console.log(`Subject: ${subject}`);
    console.log(`Content:\n${textContent}\n`);
    return { success: false, error: 'Email credentials not configured', simulated: true };
  }

  // Render Free Tier blocks outbound SMTP ports 25, 465, and 587.
  const transporter = createEmailTransporter();
  const mailOptions = {
    from: `"College ERP Agent" <${config.email.user}>`,
    to: recipient,
    subject,
    text: textContent,
    html: htmlContent,
    attachments: attachments.filter((att) => att.path && fs.existsSync(att.path)),
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[Email Sent via SMTP] Message ID: ${info.messageId}`);
    return { success: true, messageId: info.messageId, provider: 'smtp' };
  } catch (error) {
    let cleanErr = error.message;
    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED' || isRender) {
      cleanErr = 'Render blocks outbound SMTP (ports 465/587). Please set RESEND_API_KEY in Render.';
    }
    console.error(`[Email Failed] Error sending email: ${cleanErr}`);
    return { success: false, error: cleanErr };
  }
}

/**
 * Sends a WhatsApp alert via Meta Cloud API
 */
async function sendWhatsAppMessage({ textMessage }) {
  if (
    !config.whatsapp.apiToken ||
    !config.whatsapp.phoneNumberId ||
    !config.whatsapp.recipientPhone
  ) {
    console.log('\n[Simulated WhatsApp Alert]');
    console.log(`To: ${config.whatsapp.recipientPhone || '(No phone configured)'}`);
    console.log(`Message:\n${textMessage}\n`);
    return { success: true, simulated: true };
  }

  const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`;
  // Clean phone number (strip spaces, dashes, leading '+')
  const cleanPhone = config.whatsapp.recipientPhone.replace(/[^0-9]/g, '');

  try {
    const response = await axios.post(
      url,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanPhone,
        type: 'text',
        text: { preview_url: false, body: textMessage },
      },
      {
        headers: {
          Authorization: `Bearer ${config.whatsapp.apiToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(`[WhatsApp Sent] ID: ${response.data.messages?.[0]?.id || 'OK'}`);
    return { success: true, data: response.data };
  } catch (error) {
    const errMsg = error.response?.data?.error?.message || error.message;
    console.error(`[WhatsApp Failed] Meta API Error: ${errMsg}`);
    return { success: false, error: errMsg };
  }
}

/**
 * Sends a document file via Meta WhatsApp Cloud API
 */
async function sendWhatsAppDocument({ filePath, filename, caption = '' }) {
  if (
    !config.whatsapp.apiToken ||
    !config.whatsapp.phoneNumberId ||
    !config.whatsapp.recipientPhone
  ) {
    console.log('\n[Simulated WhatsApp Document Alert]');
    console.log(`To: ${config.whatsapp.recipientPhone || '(No phone configured)'}`);
    console.log(`File: ${filePath} (${filename || path.basename(filePath)})`);
    console.log(`Caption:\n${caption}\n`);
    return { success: true, simulated: true };
  }

  if (!fs.existsSync(filePath)) {
    console.error(`[WhatsApp Document] File does not exist: ${filePath}`);
    return { success: false, error: 'File not found on disk' };
  }

  const cleanPhone = config.whatsapp.recipientPhone.replace(/[^0-9]/g, '');
  const baseFilename = filename || path.basename(filePath);

  try {
    // 1. Upload media to Meta WhatsApp Cloud API
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', fs.createReadStream(filePath), {
      filename: baseFilename,
      contentType: 'text/plain',
    });
    form.append('type', 'text/plain');

    const uploadUrl = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/media`;
    const uploadRes = await axios.post(uploadUrl, form, {
      headers: {
        Authorization: `Bearer ${config.whatsapp.apiToken}`,
        ...form.getHeaders(),
      },
      timeout: 30000,
    });

    const mediaId = uploadRes.data?.id;
    if (!mediaId) {
      throw new Error('Meta did not return a media ID for the uploaded file');
    }

    // 2. Send document message with media ID
    const msgUrl = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`;
    const msgPayload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'document',
      document: {
        id: mediaId,
        filename: baseFilename,
        caption: caption ? caption.slice(0, 1024) : '',
      },
    };

    const msgRes = await axios.post(msgUrl, msgPayload, {
      headers: {
        Authorization: `Bearer ${config.whatsapp.apiToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });

    console.log(`[WhatsApp Document Sent] Message ID: ${msgRes.data.messages?.[0]?.id || 'OK'}`);
    return { success: true, messageId: msgRes.data.messages?.[0]?.id };
  } catch (error) {
    const errMsg = error.response?.data?.error?.message || error.message;
    console.error(`[WhatsApp Document Failed] Error: ${errMsg}`);
    return { success: false, error: errMsg };
  }
}

/**
 * Generates modern responsive HTML email template
 */
function buildHtmlEmail({ title, badgeText, badgeColor, items, ctaText, ctaUrl, footerNote }) {
  const itemsHtml = items
    .map(
      (item) => `
      <tr>
        <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; color: #555; font-size: 14px; width: 35%;"><strong>${item.label}:</strong></td>
        <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; color: #222; font-size: 14px;">${item.value}</td>
      </tr>
    `
    )
    .join('');

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f7f9fb; margin: 0; padding: 20px; }
          .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 14px rgba(0,0,0,0.06); }
          .header { background: #1a202c; color: #ffffff; padding: 24px; text-align: center; }
          .header h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.5px; }
          .badge { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: bold; text-transform: uppercase; margin-top: 8px; background-color: ${badgeColor}; color: #ffffff; }
          .content { padding: 24px; }
          .info-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
          .cta-btn { display: inline-block; background-color: #3182ce; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600; font-size: 14px; margin-top: 12px; }
          .footer { background: #f8fafc; padding: 16px; text-align: center; font-size: 12px; color: #718096; border-top: 1px solid #e2e8f0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Autonomous ERP Assignment Agent</h1>
            <span class="badge">${badgeText}</span>
          </div>
          <div class="content">
            <h2 style="font-size: 18px; color: #2d3748; margin-top: 0;">${title}</h2>
            <table class="info-table">
              ${itemsHtml}
            </table>
            ${
              ctaUrl
                ? `<div style="text-align: center; margin: 24px 0;"><a href="${ctaUrl}" class="cta-btn" target="_blank">${ctaText || 'Open ERP Portal'}</a></div>`
                : ''
            }
          </div>
          <div class="footer">
            <p>${footerNote || 'Automated audit message from your local Autonomous Assignment Agent.'}</p>
          </div>
        </div>
      </body>
    </html>
  `;
}

/**
 * Sends a Telegram alert via telegramBot service
 */
async function sendTelegramMessage(textMessage, options = {}) {
  const telegramBot = require('../services/telegramBot');
  return telegramBot.sendTelegramMessage(textMessage, options);
}

/**
 * Sends a Telegram document attachment via telegramBot service
 */
async function sendTelegramDocument(filePath, filename, caption = '', options = {}) {
  const telegramBot = require('../services/telegramBot');
  if (typeof telegramBot.sendTelegramDocument === 'function') {
    return telegramBot.sendTelegramDocument(filePath, filename, caption, options);
  }
  return { success: false, skipped: true };
}

/**
 * Sends upcoming deadline alert with matching file details
 */
async function notifyUpcomingDeadline(assignment, matchingFile = null) {
  const alertType = 'UPCOMING_DEADLINE';
  const hoursLeft = Math.max(
    0,
    Math.round((new Date(assignment.due_date).getTime() - Date.now()) / (1000 * 60 * 60))
  );

  // Check cooldown (12 hours) to avoid spamming
  const emailSentRecently = await db.hasAlertBeenSent(
    assignment.assignment_id,
    'EMAIL',
    alertType,
    12
  );
  const waSentRecently = await db.hasAlertBeenSent(
    assignment.assignment_id,
    'WHATSAPP',
    alertType,
    12
  );

  const fileStatus = matchingFile
    ? `Completed file identified (${matchingFile.filename})`
    : 'No matching completed file found yet in college_assignments/';

  const subject = `[ERP Reminder] Upcoming Deadline: ${assignment.subject} - ${assignment.title} (${hoursLeft}h left)`;

  const items = [
    { label: 'Subject', value: assignment.subject },
    { label: 'Assignment', value: assignment.title },
    { label: 'Due Date', value: new Date(assignment.due_date).toLocaleString() },
    { label: 'Time Remaining', value: `${hoursLeft} hours` },
    { label: 'File Status', value: fileStatus },
  ];

  const htmlContent = buildHtmlEmail({
    title: 'Upcoming College Assignment Deadline',
    badgeText: `${hoursLeft} Hours Remaining`,
    badgeColor: hoursLeft <= 24 ? '#e53e3e' : '#dd6b20',
    items,
    ctaText: 'Check ERP Portal',
    ctaUrl: assignment.portal_url || config.erp.portalUrl,
    footerNote: matchingFile
      ? 'Agent will auto-submit this file safely prior to the deadline.'
      : 'Please place your completed assignment PDF/DOCX inside the college_assignments folder.',
  });

  const textContent = `Upcoming Deadline Alert!\n\nSubject: ${assignment.subject}\nAssignment: ${assignment.title}\nDue Date: ${assignment.due_date}\nTime Remaining: ${hoursLeft} hours\nLocal File: ${fileStatus}\nPortal: ${assignment.portal_url || config.erp.portalUrl}`;

  const waMessage = `⏰ *ERP Deadline Alert*\n\n📌 *Subject:* ${assignment.subject}\n📝 *Assignment:* ${assignment.title}\n⏳ *Due in:* ${hoursLeft} hours (${new Date(assignment.due_date).toLocaleTimeString()})\n📁 *Status:* ${fileStatus}\n\n🔗 ${assignment.portal_url || config.erp.portalUrl}`;

  // Send Email if not throttled
  if (!emailSentRecently) {
    const res = await sendEmail({ subject, htmlContent, textContent });
    if (res.success) {
      await db.recordAlert(
        assignment.assignment_id,
        'EMAIL',
        alertType,
        config.email.recipient,
        subject
      );
    }
  }

  // Send WhatsApp if not throttled
  if (!waSentRecently) {
    const res = await sendWhatsAppMessage({ textMessage: waMessage });
    if (res.success) {
      await db.recordAlert(
        assignment.assignment_id,
        'WHATSAPP',
        alertType,
        config.whatsapp.recipientPhone,
        waMessage
      );
    }
  }

  // Send Telegram if not throttled
  const tgSentRecently = await db.hasAlertBeenSent(
    assignment.assignment_id,
    'TELEGRAM',
    alertType,
    12
  );
  if (!tgSentRecently) {
    const res = await sendTelegramMessage(waMessage);
    if (res && res.success) {
      await db.recordAlert(
        assignment.assignment_id,
        'TELEGRAM',
        alertType,
        config.telegram?.chatId || 'TELEGRAM',
        waMessage
      );
    }
  }
}

/**
 * Sends notification confirming that an assignment has been successfully auto-submitted
 */
async function notifyAutoSubmitted(assignment, filePath, screenshotPath, confidenceScore, reasoning) {
  const alertType = 'AUTO_SUBMITTED';
  const filename = path.basename(filePath);

  const subject = `[ERP Success] Auto-Submitted: ${assignment.subject} - ${assignment.title}`;

  const items = [
    { label: 'Subject', value: assignment.subject },
    { label: 'Assignment', value: assignment.title },
    { label: 'Submitted File', value: filename },
    { label: 'AI Match Confidence', value: `${confidenceScore}%` },
    { label: 'Decision Reason', value: reasoning },
    { label: 'Submitted At', value: new Date().toLocaleString() },
  ];

  const attachments = [];
  if (screenshotPath && fs.existsSync(screenshotPath)) {
    attachments.push({
      filename: path.basename(screenshotPath),
      path: screenshotPath,
    });
  }

  const htmlContent = buildHtmlEmail({
    title: 'Assignment Successfully Auto-Submitted!',
    badgeText: 'Auto-Submitted',
    badgeColor: '#38a169',
    items,
    ctaText: 'View Submission on ERP',
    ctaUrl: assignment.portal_url || config.erp.portalUrl,
    footerNote: 'Proof screenshot attached. Verified and submitted by your local AI Agent.',
  });

  const textContent = `Assignment Auto-Submitted!\n\nSubject: ${assignment.subject}\nAssignment: ${assignment.title}\nFile: ${filename}\nConfidence: ${confidenceScore}%\nReasoning: ${reasoning}\nProof: ${screenshotPath || 'Saved in screenshots/'}`;

  const waMessage = `✅ *Assignment Auto-Submitted!*\n\n📌 *Subject:* ${assignment.subject}\n📝 *Assignment:* ${assignment.title}\n📎 *File:* ${filename}\n🎯 *Match Confidence:* ${confidenceScore}%\n💡 *Reasoning:* ${reasoning}\n📸 Proof screenshot saved locally.`;

  // Email
  const emailRes = await sendEmail({ subject, htmlContent, textContent, attachments });
  if (emailRes.success) {
    await db.recordAlert(
      assignment.assignment_id,
      'EMAIL',
      alertType,
      config.email.recipient,
      subject
    );
  }

  // WhatsApp
  const waRes = await sendWhatsAppMessage({ textMessage: waMessage });
  if (waRes.success) {
    await db.recordAlert(
      assignment.assignment_id,
      'WHATSAPP',
      alertType,
      config.whatsapp.recipientPhone,
      waMessage
    );
  }

  // Telegram
  const tgRes = await sendTelegramMessage(waMessage);
  if (tgRes && tgRes.success) {
    await db.recordAlert(
      assignment.assignment_id,
      'TELEGRAM',
      alertType,
      config.telegram?.chatId || 'TELEGRAM',
      waMessage
    );
  }
}

/**
 * Sends urgent warning when a deadline is imminent and no matching file exists
 */
async function notifyMissingFileWarning(assignment) {
  const alertType = 'MISSING_FILE';
  const hoursLeft = Math.max(
    0,
    Math.round((new Date(assignment.due_date).getTime() - Date.now()) / (1000 * 60 * 60))
  );

  const emailSentRecently = await db.hasAlertBeenSent(
    assignment.assignment_id,
    'EMAIL',
    alertType,
    6
  );
  const waSentRecently = await db.hasAlertBeenSent(
    assignment.assignment_id,
    'WHATSAPP',
    alertType,
    6
  );

  const subject = `[URGENT ERP Alert] Missing Completed File: ${assignment.subject} (${hoursLeft}h left)`;

  const items = [
    { label: 'Subject', value: assignment.subject },
    { label: 'Assignment', value: assignment.title },
    { label: 'Due Date', value: new Date(assignment.due_date).toLocaleString() },
    { label: 'Time Remaining', value: `ONLY ${hoursLeft} hours left!` },
    {
      label: 'Warning',
      value: 'No completed document matching this assignment was detected in college_assignments/.',
    },
  ];

  const htmlContent = buildHtmlEmail({
    title: 'Urgent: Missing Assignment File',
    badgeText: 'Action Required',
    badgeColor: '#e53e3e',
    items,
    ctaText: 'Open ERP Portal',
    ctaUrl: assignment.portal_url || config.erp.portalUrl,
    footerNote:
      'Please drop your completed PDF or DOCX file into the college_assignments folder right away.',
  });

  const textContent = `URGENT: Missing Assignment File!\n\nSubject: ${assignment.subject}\nAssignment: ${assignment.title}\nDue: ${assignment.due_date}\nHours Left: ${hoursLeft}\n\nPlease place your completed file into college_assignments/ immediately.`;

  const waMessage = `🚨 *URGENT: Assignment Due Soon!*\n\n📌 *Subject:* ${assignment.subject}\n📝 *Assignment:* ${assignment.title}\n⏳ *Time Left:* ${hoursLeft} hours\n⚠️ *Alert:* No matching file found in college_assignments/.\n\nPlease drop your completed PDF/DOCX file into the folder so the agent can auto-submit.`;

  if (!emailSentRecently) {
    const res = await sendEmail({ subject, htmlContent, textContent });
    if (res.success) {
      await db.recordAlert(
        assignment.assignment_id,
        'EMAIL',
        alertType,
        config.email.recipient,
        subject
      );
    }
  }

  if (!waSentRecently) {
    const res = await sendWhatsAppMessage({ textMessage: waMessage });
    if (res.success) {
      await db.recordAlert(
        assignment.assignment_id,
        'WHATSAPP',
        alertType,
        config.whatsapp.recipientPhone,
        waMessage
      );
    }
  }

  // Send Telegram if not throttled
  const tgSentRecently = await db.hasAlertBeenSent(
    assignment.assignment_id,
    'TELEGRAM',
    alertType,
    6
  );
  if (!tgSentRecently) {
    const res = await sendTelegramMessage(waMessage);
    if (res && res.success) {
      await db.recordAlert(
        assignment.assignment_id,
        'TELEGRAM',
        alertType,
        config.telegram?.chatId || 'TELEGRAM',
        waMessage
      );
    }
  }
}

module.exports = {
  notifyUpcomingDeadline,
  notifyAutoSubmitted,
  notifyMissingFileWarning,
  sendEmail,
  sendWhatsAppMessage,
  sendWhatsAppDocument,
  sendTelegramMessage,
  sendTelegramDocument,
};

