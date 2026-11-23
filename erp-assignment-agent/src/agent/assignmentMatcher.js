/**
 * Assignment Matcher Service
 * Accurately matches uploaded files (from WhatsApp documents or Google Drive sync)
 * to active Sidus FILE UPLOAD assignments using filename, captions, and document text.
 */

const path = require('path');
const db = require('../db/database');

const SUBJECT_ALIASES = {
  cs210: ['cs210', 'backend', 'node', 'express', 'api'],
  ds201: ['ds201', 'fds', 'data science', 'foundations of data science'],
  cs209: ['cs209', 'dsa', 'ads', 'advanced data structures', 'data structures'],
  ma113: ['ma113', 'math', 'linear algebra'],
  re102: ['re102', 'research', 'ethics'],
  ec201: ['ec201', 'english'],
};

/**
 * Checks if candidate text has a conflicting number with the required assignment number
 */
function hasNumberConflict(assignmentTitle, textToSearch) {
  const cleanTitle = assignmentTitle.replace(/\s*\(.*?\)\s*$/, '').trim();
  const titleNums = cleanTitle.match(/\d+/g);
  if (!titleNums || titleNums.length === 0) return false;

  const requiredNum = titleNums[titleNums.length - 1];
  const fileNums = textToSearch.match(/\d+/g);

  // If the file/caption explicitly contains numbers, but does NOT include the required number, it's a conflict
  if (fileNums && fileNums.length > 0 && !fileNums.includes(requiredNum)) {
    return true;
  }
  return false;
}

/**
 * Retrieves all active Sidus deadlines that require FILE UPLOAD
 */
async function getPendingFileUploadDeadlines() {
  const allPending = await db.getPendingDeadlines();
  return (allPending || []).filter(
    (d) => /FILE UPLOAD/i.test(d.title) || /Type:\s*FILE UPLOAD/i.test(d.description || '')
  );
}

/**
 * Matches a file (by filename, caption, and optional extracted text) against active FILE UPLOAD assignments
 * @param {Object} params - { fileName, caption, extractedText }
 * @returns {Promise<{ matched: boolean, assignment: Object|null, score: number, availableDeadlines: Array }>}
 */
async function matchAssignmentForFile({ fileName = '', caption = '', extractedText = '' }) {
  const fileUploadDeadlines = await getPendingFileUploadDeadlines();

  if (fileUploadDeadlines.length === 0) {
    return {
      matched: false,
      assignment: null,
      score: 0,
      reasoning: 'No active FILE UPLOAD assignments found on Sidus ERP.',
      availableDeadlines: [],
    };
  }

  const fnameLower = (fileName || '').toLowerCase();
  const captionLower = (caption || '').toLowerCase();
  const textLower = (extractedText || '').toLowerCase();
  const combinedContext = `${captionLower} ${fnameLower}`;

  let bestMatch = null;
  let highestScore = 0;
  let matchReason = '';

  for (const asgt of fileUploadDeadlines) {
    const cleanTitle = asgt.title.replace(/\s*\(.*?\)\s*$/, '').trim();
    const titleLower = cleanTitle.toLowerCase();
    const subjectLower = asgt.subject.toLowerCase();

    // Safety guard: Reject if number conflict exists
    if (hasNumberConflict(asgt.title, combinedContext)) {
      continue;
    }

    let score = 0;
    const reasons = [];

    // Find subject aliases matching this assignment
    let subjectTokens = [];
    for (const [subjCode, aliases] of Object.entries(SUBJECT_ALIASES)) {
      if (subjectLower.includes(subjCode) || aliases.some((a) => subjectLower.includes(a))) {
        subjectTokens = aliases;
        break;
      }
    }
    if (subjectTokens.length === 0) {
      subjectTokens = asgt.subject.split(/[\s-]+/).map((s) => s.toLowerCase()).filter((s) => s.length > 2);
    }

    // 1. Caption Subject Match (Highest priority)
    for (const token of subjectTokens) {
      if (captionLower.includes(token)) {
        score += 60;
        reasons.push(`WhatsApp caption matches subject '${token}'`);
        break;
      }
    }

    // 2. Filename Subject Match
    for (const token of subjectTokens) {
      if (fnameLower.includes(token)) {
        score += 45;
        reasons.push(`filename matches subject '${token}'`);
        break;
      }
    }

    // 3. Document Text Subject Match
    for (const token of subjectTokens) {
      if (textLower.includes(token)) {
        score += 20;
        reasons.push(`document text mentions '${token}'`);
        break;
      }
    }

    // 4. Exact Assignment Number Match
    const titleNums = cleanTitle.match(/\d+/g);
    if (titleNums && titleNums.length > 0) {
      const requiredNum = titleNums[titleNums.length - 1];
      if (captionLower.includes(requiredNum)) {
        score += 35;
        reasons.push(`caption includes exact assignment #${requiredNum}`);
      } else if (fnameLower.includes(requiredNum)) {
        score += 30;
        reasons.push(`filename includes exact assignment #${requiredNum}`);
      }
    }

    // 5. Title Keyword Match (e.g., 'lab', 'report', 'assignment')
    const titleWords = titleLower.split(/[\s_-]+/).filter((w) => w.length > 2);
    for (const w of titleWords) {
      if (combinedContext.includes(w)) {
        score += 15;
        reasons.push(`matched keyword '${w}'`);
        break;
      }
    }

    const finalScore = Math.min(100, score);
    if (finalScore > highestScore) {
      highestScore = finalScore;
      bestMatch = asgt;
      matchReason = reasons.join('; ');
    }
  }

  // Minimum threshold of 50 points to consider it a confident match
  if (highestScore >= 50 && bestMatch) {
    return {
      matched: true,
      assignment: bestMatch,
      score: highestScore,
      reasoning: matchReason,
      availableDeadlines: fileUploadDeadlines,
    };
  }

  return {
    matched: false,
    assignment: null,
    score: highestScore,
    reasoning: matchReason || 'Could not confidently match to an active FILE UPLOAD assignment.',
    availableDeadlines: fileUploadDeadlines,
  };
}

module.exports = {
  SUBJECT_ALIASES,
  hasNumberConflict,
  getPendingFileUploadDeadlines,
  matchAssignmentForFile,
};
