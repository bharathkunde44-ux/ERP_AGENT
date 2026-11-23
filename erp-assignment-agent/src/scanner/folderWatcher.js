/**
 * Instant Real-Time Folder Watcher
 * Watches the student's assignments folder (C:\personal\2ND_YEAR_TERM_2)
 * for newly saved or modified .pdf and .docx files with a 5-second debounce.
 * Ignores Office lock files (~$*), hidden files, and drafts/.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../config/env');
const notifier = require('../notifications/notifier');
const orchestrator = require('../agent/orchestrator');

let fsWatcherInstance = null;
let debounceTimer = null;
const pendingFiles = new Set();
const DEBOUNCE_DELAY_MS = 5000; // 5-second debounce

/**
 * Handles batch processing of files detected after the debounce delay
 */
async function processDetectedFiles() {
  if (pendingFiles.size === 0) return;

  const fileList = Array.from(pendingFiles);
  pendingFiles.clear();

  console.log(`\n[Folder Watcher] Debounce elapsed. Processing ${fileList.length} new/updated file(s):`);
  fileList.forEach((f) => console.log(`  • ${f}`));

  // Send WhatsApp notification
  try {
    const filenamesStr = fileList.map((f) => `\`${f}\``).join(', ');
    await notifier.sendWhatsAppMessage({
      textMessage: `📂 *New Assignment File Detected!*\n\n${filenamesStr}\n\nTriggering automated Sidus deadline matching & submission check now...`,
    });
  } catch (err) {
    console.error('[Folder Watcher] Failed to send WhatsApp heads-up:', err.message);
  }

  // Trigger autonomous agent cycle
  try {
    console.log('[Folder Watcher] Triggering autonomous agent cycle...');
    await orchestrator.runAgentCycle({ dryRun: false });
  } catch (err) {
    console.error('[Folder Watcher] Error during auto-triggered cycle:', err.message);
  }
}

/**
 * Starts watching the assignments folder
 * @param {string} customDir - Optional folder path (defaults to config.paths.collegeAssignments)
 */
function startFolderWatcher(customDir = null) {
  const watchDir = customDir || config.paths.collegeAssignments;

  if (!fs.existsSync(watchDir)) {
    fs.mkdirSync(watchDir, { recursive: true });
  }

  console.log(`[Folder Watcher] Initializing real-time file watcher on: ${watchDir}`);
  console.log(`[Folder Watcher] Ignoring drafts/, hidden files, and temporary Office lock files (~$*).`);

  try {
    fsWatcherInstance = fs.watch(watchDir, { recursive: true }, (eventType, relativePath) => {
      if (!relativePath) return;

      const normPath = relativePath.replace(/\\/g, '/');
      const baseName = path.basename(normPath);

      // 1. Ignore drafts directory
      if (normPath.toLowerCase().includes('drafts/') || normPath.toLowerCase().startsWith('drafts')) {
        return;
      }

      // 2. Ignore Office lock files (~$*) and hidden files
      if (baseName.startsWith('~$') || baseName.startsWith('.')) {
        return;
      }

      // 3. Only watch .pdf and .docx
      const ext = path.extname(baseName).toLowerCase();
      if (ext !== '.pdf' && ext !== '.docx') {
        return;
      }

      const fullPath = path.join(watchDir, relativePath);

      // Verify file still exists on disk (rules out deletions)
      if (!fs.existsSync(fullPath)) {
        return;
      }

      console.log(`[Folder Watcher] Event (${eventType}): Detected "${baseName}"`);
      pendingFiles.add(baseName);

      // Reset 5-second debounce timer
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        processDetectedFiles().catch((err) => {
          console.error('[Folder Watcher Error]:', err.message);
        });
      }, DEBOUNCE_DELAY_MS);
    });

    console.log('[Folder Watcher] Real-time file watcher active (5-second debounce).');
    return fsWatcherInstance;
  } catch (err) {
    console.error(`[Folder Watcher Error] Failed to start folder watcher on ${watchDir}:`, err.message);
    return null;
  }
}

/**
 * Stops the folder watcher
 */
function stopFolderWatcher() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (fsWatcherInstance) {
    fsWatcherInstance.close();
    fsWatcherInstance = null;
    console.log('[Folder Watcher] Stopped.');
  }
}

module.exports = {
  startFolderWatcher,
  stopFolderWatcher,
  processDetectedFiles,
};
