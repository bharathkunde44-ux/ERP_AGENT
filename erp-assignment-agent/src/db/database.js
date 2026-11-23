/**
 * SQLite Database & Audit Log Management
 * Uses sqlite and sqlite3 for storing deadlines, scanned local files, alerts, and submissions.
 */

const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { config } = require('../config/env');

let dbInstance = null;

/**
 * Initializes and opens the SQLite database, ensuring all tables exist
 */
async function initDb(customDbPath = null) {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = customDbPath || config.paths.database;

  dbInstance = await open({
    filename: dbPath,
    driver: sqlite3.Database,
  });

  // Enable WAL mode for better concurrency and integrity
  await dbInstance.exec('PRAGMA journal_mode = WAL;');

  // Table: Deadlines scraped from ERP
  await dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS deadlines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      subject TEXT NOT NULL,
      description TEXT,
      due_date TEXT NOT NULL,
      status TEXT DEFAULT 'PENDING',
      portal_url TEXT,
      last_scraped_at TEXT NOT NULL,
      submitted_at TEXT,
      submission_path TEXT
    );
  `);

  // Table: Scanned local assignment files
  await dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS local_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filepath TEXT UNIQUE NOT NULL,
      filename TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_size INTEGER,
      extracted_text TEXT,
      file_hash TEXT NOT NULL,
      detected_subject TEXT,
      detected_title TEXT,
      last_scanned_at TEXT NOT NULL
    );
  `);

  // Table: Notification alerts sent to prevent duplicate spamming
  await dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS alerts_sent (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      recipient TEXT,
      message TEXT,
      sent_at TEXT NOT NULL
    );
  `);

  // Table: Audit log of submission attempts and proof screenshots
  await dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      screenshot_path TEXT,
      confidence_score REAL,
      reasoning TEXT,
      status TEXT NOT NULL,
      error_message TEXT,
      submitted_at TEXT NOT NULL
    );
  `);

  // Table: System audit log for agent decision tracing
  await dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL
    );
  `);

  return dbInstance;
}

/**
 * Upserts a scraped assignment deadline
 */
async function upsertDeadline(deadline) {
  const db = await initDb();
  const now = new Date().toISOString();

  const query = `
    INSERT INTO deadlines (
      assignment_id, title, subject, description, due_date, status, portal_url, last_scraped_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(assignment_id) DO UPDATE SET
      title = excluded.title,
      subject = excluded.subject,
      description = excluded.description,
      due_date = excluded.due_date,
      portal_url = excluded.portal_url,
      last_scraped_at = excluded.last_scraped_at
    WHERE deadlines.status != 'SUBMITTED';
  `;

  await db.run(query, [
    deadline.assignmentId,
    deadline.title,
    deadline.subject,
    deadline.description || '',
    deadline.dueDate,
    deadline.status || 'PENDING',
    deadline.portalUrl || '',
    now,
  ]);
}

/**
 * Fetches all pending deadlines from database
 */
async function getPendingDeadlines() {
  const db = await initDb();
  return db.all("SELECT * FROM deadlines WHERE status = 'PENDING' ORDER BY due_date ASC");
}

/**
 * Fetches all deadlines
 */
async function getAllDeadlines() {
  const db = await initDb();
  return db.all('SELECT * FROM deadlines ORDER BY due_date ASC');
}

/**
 * Gets a specific deadline by assignment ID
 */
async function getDeadlineById(assignmentId) {
  const db = await initDb();
  return db.get('SELECT * FROM deadlines WHERE assignment_id = ?', [assignmentId]);
}

/**
 * Marks a deadline as submitted in the database
 */
async function markDeadlineSubmitted(assignmentId, filePath, submittedAt = null) {
  const db = await initDb();
  const timestamp = submittedAt || new Date().toISOString();

  await db.run(
    `UPDATE deadlines 
     SET status = 'SUBMITTED', submission_path = ?, submitted_at = ? 
     WHERE assignment_id = ?`,
    [filePath, timestamp, assignmentId]
  );
}

/**
 * Upserts a scanned local assignment file
 */
async function upsertLocalFile(fileData) {
  const db = await initDb();
  const now = new Date().toISOString();

  const query = `
    INSERT INTO local_files (
      filepath, filename, file_type, file_size, extracted_text, file_hash, detected_subject, detected_title, last_scanned_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(filepath) DO UPDATE SET
      filename = excluded.filename,
      file_type = excluded.file_type,
      file_size = excluded.file_size,
      extracted_text = excluded.extracted_text,
      file_hash = excluded.file_hash,
      detected_subject = excluded.detected_subject,
      detected_title = excluded.detected_title,
      last_scanned_at = excluded.last_scanned_at;
  `;

  await db.run(query, [
    fileData.filepath,
    fileData.filename,
    fileData.fileType,
    fileData.fileSize,
    fileData.extractedText,
    fileData.fileHash,
    fileData.detectedSubject || '',
    fileData.detectedTitle || '',
    now,
  ]);
}

/**
 * Fetches all scanned local assignment files
 */
async function getAllLocalFiles() {
  const db = await initDb();
  return db.all('SELECT * FROM local_files ORDER BY last_scanned_at DESC');
}

/**
 * Checks if a specific alert has been sent within a cooldown period (to prevent spam)
 */
async function hasAlertBeenSent(assignmentId, channel, alertType, cooldownHours = 12) {
  const db = await initDb();
  const cooldownTimestamp = new Date(Date.now() - cooldownHours * 60 * 60 * 1000).toISOString();

  const row = await db.get(
    `SELECT id FROM alerts_sent 
     WHERE assignment_id = ? AND channel = ? AND alert_type = ? AND sent_at > ?`,
    [assignmentId, channel, alertType, cooldownTimestamp]
  );

  return Boolean(row);
}

/**
 * Records an alert notification in the audit log
 */
async function recordAlert(assignmentId, channel, alertType, recipient, message) {
  const db = await initDb();
  const now = new Date().toISOString();

  await db.run(
    `INSERT INTO alerts_sent (assignment_id, channel, alert_type, recipient, message, sent_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [assignmentId, channel, alertType, recipient, message, now]
  );
}

/**
 * Records a submission attempt (successful, dry run, or failed)
 */
async function recordSubmission(submission) {
  const db = await initDb();
  const now = new Date().toISOString();

  const result = await db.run(
    `INSERT INTO submissions (
      assignment_id, filename, filepath, screenshot_path, confidence_score, reasoning, status, error_message, submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      submission.assignmentId,
      submission.filename,
      submission.filepath,
      submission.screenshotPath || null,
      submission.confidenceScore || 0,
      submission.reasoning || '',
      submission.status,
      submission.errorMessage || null,
      now,
    ]
  );

  return result.lastID;
}

/**
 * Fetches submission history
 */
async function getSubmissions(limit = 20) {
  const db = await initDb();
  return db.all('SELECT * FROM submissions ORDER BY submitted_at DESC LIMIT ?', [limit]);
}

/**
 * Records an audit log entry for system actions
 */
async function recordAuditLog(action, details = '') {
  const db = await initDb();
  const now = new Date().toISOString();
  const detailsStr = typeof details === 'object' ? JSON.stringify(details) : String(details);

  await db.run('INSERT INTO audit_logs (action, details, created_at) VALUES (?, ?, ?)', [
    action,
    detailsStr,
    now,
  ]);
}

/**
 * Closes the database connection
 */
async function closeDb() {
  if (dbInstance) {
    await dbInstance.close();
    dbInstance = null;
  }
}

module.exports = {
  initDb,
  upsertDeadline,
  getPendingDeadlines,
  getAllDeadlines,
  getDeadlineById,
  markDeadlineSubmitted,
  upsertLocalFile,
  getAllLocalFiles,
  hasAlertBeenSent,
  recordAlert,
  recordSubmission,
  getSubmissions,
  recordAuditLog,
  closeDb,
};

