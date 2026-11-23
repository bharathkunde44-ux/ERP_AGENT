/**
 * Notification Service (Email & WhatsApp Cloud API)
 * Handles sending rich HTML emails via nodemailer and WhatsApp alerts via Meta Cloud API.
 * Includes alert throttling and duplicate spam prevention.
 */

const nodemailer = require('nodemailer');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { config } = require('../config/env');
const db = require('../db/database');

/**
 * Creates and configures Nodemailer transporter
 */
function createEmailTransporter() {
  if (!config.email.user || !config.email.pass) {
    return null;
  }

  return nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure,
    auth: {
      user: config.email.user,
      pass: config.email.pass,
    },
  });
}

/**
 * Sends a rich Email alert
 */
async function sendEmail({ subject, htmlContent, textContent, attachments = [] }) {
  if (!config.email.user || !config.email.pass || !config.email.recipient) {
    console.log('\n[Simulated Email Alert]');
    console.log(`To: ${config.email.recipient || '(No recipient configured)'}`);
    console.log(`Subject: ${subject}`);
    console.log(`Content:\n${textContent}\n`);
    return { success: true, simulated: true };
  }

  const transporter = createEmailTransporter();
  const mailOptions = {
    from: `"College ERP Agent" <${config.email.user}>`,
    to: config.email.recipient,
    subject,
    text: textContent,
    html: htmlContent,
    attachments: attachments.filter((att) => att.path && fs.existsSync(att.path)),
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log(`[Email Sent] Message ID: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`[Email Failed] Error sending email: ${error.message}`);
    return { success: false, error: error.message };
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
}

module.exports = {
  notifyUpcomingDeadline,
  notifyAutoSubmitted,
  notifyMissingFileWarning,
  sendEmail,
  sendWhatsAppMessage,
};

