/**
 * Reset script to revert agent_data.db and sample assignments to initial test state
 */

const fs = require('fs');
const path = require('path');
const db = require('../src/db/database');

async function resetState() {
  console.log('[Reset] Resetting agent database and testing state...');

  const database = await db.initDb();
  await database.exec(`
    DELETE FROM deadlines;
    DELETE FROM local_files;
    DELETE FROM alerts_sent;
    DELETE FROM submissions;
    DELETE FROM audit_logs;
  `);

  console.log('[Reset] Cleared all database tables (deadlines, local_files, alerts_sent, submissions, audit_logs).');

  // Clean mock uploads if any
  const uploadsDir = path.resolve(__dirname, '../mock_erp/uploads');
  if (fs.existsSync(uploadsDir)) {
    const files = fs.readdirSync(uploadsDir);
    for (const f of files) {
      if (f !== '.gitkeep') {
        fs.unlinkSync(path.join(uploadsDir, f));
      }
    }
  }

  // Clean screenshots if any
  const screenshotsDir = path.resolve(__dirname, '../screenshots');
  if (fs.existsSync(screenshotsDir)) {
    const files = fs.readdirSync(screenshotsDir);
    for (const f of files) {
      if (f !== '.gitkeep') {
        fs.unlinkSync(path.join(screenshotsDir, f));
      }
    }
  }

  await db.closeDb();
  console.log('[Reset] State successfully reset to pristine initial condition.');
}

resetState().catch(console.error);

