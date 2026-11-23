/**
 * Google Drive Shared Folder Sync Service
 * Periodically polls a publicly shared Google Drive folder (via API key) for new .pdf and .docx files,
 * downloads them into the assignments directory, tracks processed file IDs in SQLite,
 * and triggers WhatsApp permission approval for matching Sidus assignments.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { config } = require('../config/env');
const db = require('../db/database');
const scanner = require('../scanner/folderScanner');
const notifier = require('../notifications/notifier');
const { matchAssignmentForFile } = require('../agent/assignmentMatcher');

let isSyncRunning = false;

/**
 * Sanitizes a filename safely for the local filesystem
 */
function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Syncs new files from the configured Google Drive shared folder
 */
async function syncGoogleDriveFiles() {
  const apiKey = (config.googleDrive?.apiKey || process.env.GOOGLE_DRIVE_API_KEY || '').trim();
  const folderId = (config.googleDrive?.folderId || process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();

  // If not configured, log a single informative line and exit gracefully
  if (!apiKey || !folderId) {
    console.log('[Google Drive Sync] GOOGLE_DRIVE_API_KEY or GOOGLE_DRIVE_FOLDER_ID not set. Skipping Drive sync.');
    return { synced: 0, skipped: true };
  }

  if (isSyncRunning) {
    console.log('[Google Drive Sync] Sync already in progress. Skipping concurrent run.');
    return { synced: 0, skipped: true };
  }

  isSyncRunning = true;
  console.log(`\n[Google Drive Sync] Checking shared folder "${folderId}" for new assignments...`);

  const downloadDir = config.paths.collegeAssignments;
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }

  let downloadedCount = 0;

  try {
    // 1. List files in folder via Google Drive v3 REST API
    const listUrl = 'https://www.googleapis.com/drive/v3/files';
    const query = `'${folderId}' in parents and trashed = false and (mimeType = 'application/pdf' or mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' or name contains '.pdf' or name contains '.docx')`;

    const response = await axios.get(listUrl, {
      params: {
        key: apiKey,
        q: query,
        fields: 'files(id, name, mimeType, size, modifiedTime)',
        pageSize: 50,
      },
      timeout: 20000,
    });

    const files = response.data?.files || [];
    console.log(`[Google Drive Sync] Found ${files.length} document(s) in shared Drive folder.`);

    for (const file of files) {
      const fileId = file.id;
      const fileName = file.name;
      const ext = path.extname(fileName).toLowerCase();

      if (ext !== '.pdf' && ext !== '.docx') {
        continue;
      }

      // Check if file has already been processed in SQLite
      const alreadyProcessed = await db.isDriveFileProcessed(fileId);
      if (alreadyProcessed) {
        continue;
      }

      console.log(`[Google Drive Sync] New file detected: "${fileName}" (ID: ${fileId}). Downloading...`);

      // 2. Download binary media content
      const downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`;
      const fileBufferResponse = await axios.get(downloadUrl, {
        responseType: 'arraybuffer',
        timeout: 30000,
      });

      const sanitizedName = sanitizeFileName(fileName);
      const localFilePath = path.join(downloadDir, sanitizedName);

      fs.writeFileSync(localFilePath, Buffer.from(fileBufferResponse.data));
      console.log(`[Google Drive Sync] Saved to local path: ${localFilePath}`);

      // Mark file ID as processed in SQLite
      await db.markDriveFileProcessed(fileId, fileName);
      downloadedCount++;

      // Index file content quietly
      let extractedText = '';
      try {
        if (ext === '.pdf') {
          extractedText = await scanner.extractTextFromPdf(localFilePath);
        } else if (ext === '.docx') {
          extractedText = await scanner.extractTextFromDocx(localFilePath);
        }
      } catch (_) {}

      // 3. Match against active Sidus FILE UPLOAD assignments
      const matchResult = await matchAssignmentForFile({
        fileName: sanitizedName,
        caption: fileName,
        extractedText,
      });

      if (matchResult.matched && matchResult.assignment) {
        const asgt = matchResult.assignment;
        console.log(`[Google Drive Sync] Matched "${fileName}" to [${asgt.subject}] ${asgt.title} (${matchResult.score}%)`);

        // Save pending approval in SQLite
        await db.savePendingApproval({
          filePath: localFilePath,
          fileName: sanitizedName,
          assignmentId: asgt.assignment_id || asgt.assignmentId,
          subject: asgt.subject,
          title: asgt.title,
          source: 'Google Drive',
        });

        // Prompt student on WhatsApp for approval
        const promptMsg = `📄 *File ready (Google Drive):* \`${sanitizedName}\`\n🎯 *Matched to:* *${asgt.subject}* - *${asgt.title}*\n\nReply *approve* to submit to Sidus, or *cancel* to skip.`;
        await notifier.sendWhatsAppMessage({ textMessage: promptMsg });
      } else {
        console.log(`[Google Drive Sync] Could not match "${fileName}" to an active assignment.`);
        const pendingList = matchResult.availableDeadlines || [];
        const asgtList = pendingList.map((d) => `• *[${d.subject}]* ${d.title}`).join('\n') || '(None active)';

        const unassignedMsg = `📄 *New File Downloaded from Google Drive:* \`${sanitizedName}\`\n\n❓ Could not automatically determine the target Sidus assignment.\n\n*Active FILE UPLOAD Assignments:*\n${asgtList}\n\n_Tip: Rename the file to include the subject code (e.g. cs210_lab5.pdf) or send it via WhatsApp with a caption._`;
        await notifier.sendWhatsAppMessage({ textMessage: unassignedMsg });
      }
    }

    return { synced: downloadedCount, total: files.length, skipped: false };
  } catch (err) {
    console.error(`[Google Drive Sync Error]: ${err.message}`);
    return { synced: 0, error: err.message, skipped: false };
  } finally {
    isSyncRunning = false;
  }
}

module.exports = {
  syncGoogleDriveFiles,
};
