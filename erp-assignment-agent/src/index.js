#!/usr/bin/env node

/**
 * Autonomous College ERP Assignment Agent
 * Main Entry Point and CLI Controller
 * 
 * Flags:
 *   --login     Launch interactive browser window for manual login / CAPTCHA session saving
 *   --run-once  Execute one autonomous check cycle immediately and exit
 *   --mock      Start and target local Mock ERP portal (http://localhost:3000)
 *   --dry-run   Simulate matching and submission (no actual portal form submission, proof screenshots captured)
 *   --daemon    Run continuously on a cron schedule with 24/7 WhatsApp Webhook & Folder Watcher (default)
 */

const cron = require('node-cron');
const path = require('path');
const { config, validateConfig } = require('./config/env');
const db = require('./db/database');
const erp = require('./browser/erpAutomation');
const orchestrator = require('./agent/orchestrator');
const { startWhatsAppWebhookServer, stopWhatsAppWebhookServer } = require('./webhook/whatsappServer');
const { startFolderWatcher, stopFolderWatcher } = require('./scanner/folderWatcher');
const { startMockServer, stopMockServer } = require('../mock_erp/mockServer');

const args = process.argv.slice(2);
const isLoginMode = args.includes('--login');
const isRunOnce = args.includes('--run-once');
const isMock = args.includes('--mock');
const isDryRun = args.includes('--dry-run');

function printBanner() {
  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║                AUTONOMOUS COLLEGE ERP ASSIGNMENT AGENT               ║
║              24/7 Bidirectional AI Assistant & Monitor               ║
╚══════════════════════════════════════════════════════════════════════╝
  Local Time:     ${new Date().toLocaleString()}
  ERP Portal:     ${isMock ? 'http://localhost:3000 (MOCK)' : config.erp.portalUrl}
  Groq Model:     ${config.groq.model}
  Assignments:    ${config.paths.collegeAssignments}
  Drafts Dir:     ${config.paths.drafts}
  Database:       ${config.paths.database}
  Webhook Port:   ${config.webhook.port}
  Mode:           ${isDryRun ? 'DRY-RUN (SIMULATION)' : 'LIVE EXECUTION'}
────────────────────────────────────────────────────────────────────────
`);
}

async function main() {
  printBanner();

  // Validate configuration warnings
  const validation = validateConfig({ isMock, isDryRun, isLoginMode });
  if (validation.warnings.length > 0) {
    validation.warnings.forEach((w) => console.log(w));
    console.log('────────────────────────────────────────────────────────────────────────\n');
  }

  // If mock mode is requested, start the local mock ERP server
  let mockServerInstance = null;
  if (isMock) {
    console.log('[System] Launching local Mock ERP Portal on port 3000...');
    config.erp.portalUrl = `http://localhost:${config.mockServer.port}`;
    mockServerInstance = await startMockServer(config.mockServer.port);
  }

  // Initialize SQLite database
  await db.initDb();

  // 1. Interactive Login Mode
  if (isLoginMode) {
    console.log('[Mode: Login] Starting interactive session manager...');
    try {
      await erp.loginInteractive({
        portalUrl: config.erp.portalUrl,
        username: config.erp.username,
        password: config.erp.password,
      });
      console.log('\n[System] Interactive login completed. Browser cookies and session saved to:');
      console.log(`         ${config.paths.browserSession}`);
    } catch (err) {
      console.error('[System] Error during interactive login:', err.message);
    } finally {
      if (mockServerInstance) await stopMockServer();
      await db.closeDb();
      process.exit(0);
    }
    return;
  }

  // 2. Run-Once Mode
  if (isRunOnce) {
    console.log('[Mode: Run-Once] Executing single autonomous agent cycle...');
    try {
      await orchestrator.runAgentCycle({ dryRun: isDryRun });
      console.log('\n[System] Single autonomous cycle finished successfully.');
    } catch (err) {
      console.error('[System] Cycle encountered an error:', err.message);
    } finally {
      if (mockServerInstance) await stopMockServer();
      await db.closeDb();
      process.exit(0);
    }
    return;
  }

  // 3. 24/7 Bidirectional Assistant Daemon Mode
  console.log(`[Mode: 24/7 Daemon] Starting background services...`);

  // Start Two-Way WhatsApp Command Webhook Server
  await startWhatsAppWebhookServer();

  // Start Real-Time Assignments Folder Watcher (5s debounce)
  startFolderWatcher();

  console.log(`[Mode: 24/7 Daemon] Scheduling background monitor with cron: "${config.agent.cronSchedule}"`);
  console.log('[System] Press Ctrl+C at any time to gracefully stop the agent.\n');

  // Run initial cycle immediately
  try {
    await orchestrator.runAgentCycle({ dryRun: isDryRun });
  } catch (err) {
    console.error('[System] Initial cycle error:', err.message);
  }

  // Schedule recurring runs
  const scheduledTask = cron.schedule(config.agent.cronSchedule, async () => {
    console.log(`\n[Cron Trigger] Scheduled check fired at ${new Date().toLocaleTimeString()}...`);
    try {
      await orchestrator.runAgentCycle({ dryRun: isDryRun });
    } catch (err) {
      console.error('[System] Scheduled cycle error:', err.message);
    }
  });

  // Graceful shutdown handling
  const shutdown = async () => {
    console.log('\n[System] Graceful shutdown requested...');
    scheduledTask.stop();
    stopFolderWatcher();
    await stopWhatsAppWebhookServer();
    if (mockServerInstance) {
      await stopMockServer();
    }
    await db.closeDb();
    console.log('[System] Agent shut down cleanly. Goodbye!');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(async (error) => {
  console.error('[Fatal Error]:', error);
  await db.closeDb();
  process.exit(1);
});
