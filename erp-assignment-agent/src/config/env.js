/**
 * Environment & Configuration Manager
 * Handles loading, validation, and safe defaults for the ERP Assignment Agent.
 */

const path = require('path');
const dotenv = require('dotenv');

// Locate root directory and load .env
const projectRoot = path.resolve(__dirname, '../../');
const envPath = path.join(projectRoot, '.env');

dotenv.config({ path: envPath });

const assignmentsDir = process.env.ASSIGNMENTS_DIR
  ? path.resolve(process.env.ASSIGNMENTS_DIR)
  : path.resolve(projectRoot, 'college_assignments');

const config = {
  // Project Paths
  paths: {
    root: projectRoot,
    collegeAssignments: assignmentsDir,
    drafts: path.join(assignmentsDir, 'drafts'),
    browserSession: path.resolve(projectRoot, process.env.SESSION_DIR || 'browser_session'),
    screenshots: path.resolve(projectRoot, process.env.SCREENSHOTS_DIR || 'screenshots'),
    database: path.resolve(projectRoot, process.env.DB_PATH || 'agent_data.db'),
  },

  // Groq LLM Brain Configuration
  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  },

  // ERP Portal Configuration
  erp: {
    portalUrl: (process.env.ERP_PORTAL_URL || 'https://www.sidus.net/modules/assessments/assessments').replace(/\/+$/, ''),
    username: process.env.SIDUS_EMAIL || process.env.ERP_USERNAME || '',
    password: process.env.SIDUS_PASSWORD || process.env.ERP_PASSWORD || '',
    authB64: process.env.SIDUS_AUTH_B64 || '',
  },

  // Email Notification Configuration (Nodemailer / SMTP)
  email: {
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT, 10) || 587,
    secure: process.env.EMAIL_SECURE === 'true',
    user: process.env.EMAIL_USER || '',
    pass: process.env.EMAIL_PASS || '',
    recipient: process.env.ALERT_RECIPIENT_EMAIL || '',
  },

  // WhatsApp Notification Configuration (Meta WhatsApp Cloud API)
  whatsapp: {
    apiToken: process.env.WHATSAPP_API_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    recipientPhone: process.env.WHATSAPP_RECIPIENT_PHONE || '',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
  },

  // Telegram Bot Configuration (@bharath_sidus_bot)
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: (process.env.TELEGRAM_CHAT_ID || '').trim(),
    renderUrl: (process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),
  },

  // Two-Way WhatsApp Webhook Configuration
  webhook: {
    port: parseInt((process.env.PORT || process.env.WEBHOOK_PORT), 10) || 3005,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'sidus_erp_verify_2026',
  },

  // Google Drive Shared Folder Sync Configuration
  googleDrive: {
    apiKey: process.env.GOOGLE_DRIVE_API_KEY || '',
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
  },

  // Agent Autonomous Decisions & Thresholds
  agent: {
    // Minimum matching confidence percentage (0-100) needed to trigger auto-submit
    confidenceThreshold: parseInt(process.env.AUTO_SUBMIT_CONFIDENCE_THRESHOLD, 10) || 85,
    // Buffer window: only auto-submit if due within this many hours (default 48h)
    hoursBeforeDeadlineToSubmit: parseInt(process.env.HOURS_BEFORE_DEADLINE_TO_SUBMIT, 10) || 48,
    // Default cron schedule: every 30 minutes
    cronSchedule: process.env.CRON_SCHEDULE || '*/30 * * * *',
    // Browser visibility
    headless: process.env.HEADLESS_BROWSER === 'true' || process.env.AGENT_HEADLESS === 'true',
  },

  // Mock Server Port
  mockServer: {
    port: parseInt(process.env.MOCK_SERVER_PORT, 10) || 3000,
  },
};

/**
 * Validates configuration and logs non-blocking warnings or throws errors if critical
 * @param {Object} options - Execution context flags (isMock, isDryRun, isLoginOnly)
 */
function validateConfig(options = {}) {
  const warnings = [];

  // Check Groq API Key
  if (!config.groq.apiKey || config.groq.apiKey === 'gsk_your_groq_api_key_here') {
    warnings.push(
      '[Config Warning] GROQ_API_KEY is not configured in .env. The agent will fall back to heuristic intelligent matching.'
    );
  }

  // Check Notifications
  if (!config.email.user || !config.email.pass || !config.email.recipient) {
    warnings.push(
      '[Config Warning] Email credentials (EMAIL_USER, EMAIL_PASS, ALERT_RECIPIENT_EMAIL) are incomplete. Email notifications will be simulated in console.'
    );
  }

  if (!config.whatsapp.apiToken || !config.whatsapp.phoneNumberId || !config.whatsapp.recipientPhone) {
    warnings.push(
      '[Config Warning] WhatsApp Cloud API credentials are incomplete. WhatsApp notifications will be simulated in console.'
    );
  }

  if (!config.telegram.botToken || !config.telegram.chatId) {
    warnings.push(
      '[Config Warning] Telegram credentials (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) are not configured. Telegram bot will be skipped.'
    );
  }

  return {
    isValid: true,
    warnings,
  };
}

module.exports = {
  config,
  validateConfig,
};
