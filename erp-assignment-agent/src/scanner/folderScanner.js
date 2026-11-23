/**
 * Folder Scanner & Document Parser
 * Recursively scans the assignments directory for .pdf and .docx files,
 * extracts text content quietly, computes file hashes, and indexes them in SQLite.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { config } = require('../config/env');
const db = require('../db/database');

/**
 * Calculates SHA-256 hash of a file for integrity and change tracking
 */
function calculateFileHash(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

/**
 * Extracts plain text from a PDF file using pdf-parse while silencing noisy font warnings
 */
async function extractTextFromPdf(filePath) {
  const origWarn = console.warn;
  const origLog = console.log;
  try {
    // Silence pdf.js "Warning: TT: undefined function" spam during parsing
    console.warn = (...args) => {
      if (typeof args[0] === 'string' && args[0].includes('TT: undefined function')) return;
      origWarn.apply(console, args);
    };
    console.log = (...args) => {
      if (typeof args[0] === 'string' && args[0].includes('TT: undefined function')) return;
      origLog.apply(console, args);
    };

    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    return (data.text || '').trim();
  } catch (error) {
    origWarn(`[Scanner Error] Failed to parse PDF at ${filePath}:`, error.message);
    return '';
  } finally {
    console.warn = origWarn;
    console.log = origLog;
  }
}

/**
 * Extracts plain text from a DOCX file using mammoth
 */
async function extractTextFromDocx(filePath) {
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    return (result.value || '').trim();
  } catch (error) {
    console.error(`[Scanner Error] Failed to parse DOCX at ${filePath}:`, error.message);
    return '';
  }
}

/**
 * Basic heuristic extractor to identify possible subject and title from header lines
 */
function extractBasicMetadata(text, filename) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 12);

  let detectedSubject = '';
  let detectedTitle = '';

  for (const line of lines) {
    if (/(subject|course|module|dept|class)\s*[:\-]/i.test(line)) {
      detectedSubject = line.replace(/(subject|course|module|dept|class)\s*[:\-]/i, '').trim();
      break;
    }
  }

  for (const line of lines) {
    if (/(assignment|homework|lab\s*report|lab|project|term paper|midterm)\s*[:\-0-9]/i.test(line)) {
      detectedTitle = line;
      break;
    }
  }

  if (!detectedTitle) {
    detectedTitle = path.basename(filename, path.extname(filename)).replace(/[_-]/g, ' ');
  }

  return { detectedSubject, detectedTitle };
}

/**
 * Scans a folder recursively for assignment files (.pdf, .docx)
 * @param {string} targetDir - Directory to scan (defaults to config.paths.collegeAssignments)
 * @returns {Promise<Array<Object>>} List of indexed local files with text and metadata
 */
async function scanAssignmentsFolder(targetDir = null) {
  const folder = targetDir || config.paths.collegeAssignments;

  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
  }

  const entries = fs.readdirSync(folder, { withFileTypes: true });
  const scannedFiles = [];

  for (const entry of entries) {
    const fullPath = path.join(folder, entry.name);

    if (entry.isDirectory()) {
      // Ignore drafts subfolder and hidden directories
      if (entry.name.toLowerCase() === 'drafts' || entry.name.startsWith('.')) {
        continue;
      }
      const subFiles = await scanAssignmentsFolder(fullPath);
      scannedFiles.push(...subFiles);
      continue;
    }

    // Ignore temporary Office lock files (starts with ~$) and hidden files
    if (entry.name.startsWith('~$') || entry.name.startsWith('.')) {
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (ext !== '.pdf' && ext !== '.docx') {
      continue;
    }

    const stats = fs.statSync(fullPath);
    const fileHash = calculateFileHash(fullPath);

    let extractedText = '';
    if (ext === '.pdf') {
      extractedText = await extractTextFromPdf(fullPath);
    } else if (ext === '.docx') {
      extractedText = await extractTextFromDocx(fullPath);
    }

    const { detectedSubject, detectedTitle } = extractBasicMetadata(extractedText, entry.name);

    // Compact single-line snippet (max 200 chars) to keep LLM token usage low
    const cleanSnippet = extractedText.replace(/\s+/g, ' ').trim().slice(0, 200);

    const fileRecord = {
      filepath: fullPath,
      filename: entry.name,
      fileType: ext.replace('.', ''),
      fileSize: stats.size,
      fileHash,
      extractedText,
      textSnippet: cleanSnippet,
      detectedSubject,
      detectedTitle,
    };

    await db.upsertLocalFile(fileRecord);
    scannedFiles.push(fileRecord);
  }

  return scannedFiles;
}

module.exports = {
  scanAssignmentsFolder,
  extractTextFromPdf,
  extractTextFromDocx,
  calculateFileHash,
};