/**
 * Assignment Matcher Service
 * Accurately matches uploaded files (from WhatsApp documents, Google Drive, or folder)
 * to active Sidus FILE UPLOAD assignments using normalized subject codes,
 * strict subject conflict guards, and mandatory subject verification.
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
 * Normalizes subject code patterns in text (e.g., "CS_209", "cs 209", "CS-209" -> "CS209")
 * Supports standard course codes: 2 to 4 letters followed by optional space/hyphen/underscore and 3 digits.
 */
function normalizeSubjectCodes(text) {
  if (!text) return '';
  return text.replace(
    /(?:^|([^A-Za-z0-9]))([A-Za-z]{2,4})[\s_-]?(\d{3})(?=$|[^A-Za-z0-9])/gi,
    (m, p0, p1, p2) => (p0 || '') + p1.toUpperCase() + p2
  );
}

/**
 * Extracts all unique uppercase normalized subject codes from a string
 * (e.g., "CS_209_LAB_5.pdf" -> ["CS209"])
 */
function extractSubjectCodes(text) {
  if (!text) return [];
  const regex = /(?:^|[^A-Za-z0-9])([A-Za-z]{2,4})[\s_-]?(\d{3})(?=$|[^A-Za-z0-9])/gi;
  const codes = new Set();
  let match;
  while ((match = regex.exec(text)) !== null) {
    const prefix = match[1].toUpperCase();
    const num = match[2];
    codes.add(`${prefix}${num}`);
  }
  return Array.from(codes);
}

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
 * with strict subject code conflict guards and mandatory subject verification.
 * 
 * @param {Object} params - { fileName, caption, extractedText }
 * @returns {Promise<{ matched: boolean, assignment: Object|null, score: number, reasoning: string, detectedSubjectCode?: string, availableDeadlines: Array }>}
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

  // 1. Normalize subject codes in filename, caption, and extracted text
  const normFileName = normalizeSubjectCodes(fileName);
  const normCaption = normalizeSubjectCodes(caption);
  const normExtractedText = normalizeSubjectCodes(extractedText);

  const fnameLower = normFileName.toLowerCase();
  const captionLower = normCaption.toLowerCase();
  const textLower = normExtractedText.toLowerCase();

  // 2. Extract any explicitly detected subject codes from filename and caption
  const detectedSubjectCodes = Array.from(
    new Set([
      ...extractSubjectCodes(fileName),
      ...extractSubjectCodes(caption),
    ])
  );

  console.log(`[Assignment Matcher] Evaluating "${fileName}" (Normalized: "${normFileName}", Detected Codes: [${detectedSubjectCodes.join(', ')}])`);

  // Rule 2: Strict Subject-Code Conflict Guard
  // If subject codes were detected in the file/caption, verify if any active assignment belongs to that code
  if (detectedSubjectCodes.length > 0) {
    const hasAnyMatchingSubject = fileUploadDeadlines.some((asgt) => {
      const asgtCodes = extractSubjectCodes(`${asgt.subject} ${asgt.assignment_id || asgt.assignmentId}`);
      return asgtCodes.some((code) => detectedSubjectCodes.includes(code));
    });

    if (!hasAnyMatchingSubject) {
      const detectedCodeStr = detectedSubjectCodes.join(', ');
      console.warn(`[Assignment Matcher] Subject code guard: Detected ${detectedCodeStr}, but no active FILE UPLOAD assignment exists on Sidus for ${detectedCodeStr}.`);
      return {
        matched: false,
        assignment: null,
        score: 0,
        reasoning: `Detected subject code ${detectedCodeStr}, but no active FILE UPLOAD assignment exists on Sidus for ${detectedCodeStr}.`,
        detectedSubjectCode: detectedCodeStr,
        availableDeadlines: fileUploadDeadlines,
      };
    }
  }

  const combinedContext = `${captionLower} ${fnameLower}`;
  let bestMatch = null;
  let highestScore = 0;
  let matchReason = '';

  for (const asgt of fileUploadDeadlines) {
    const cleanTitle = asgt.title.replace(/\s*\(.*?\)\s*$/, '').trim();
    const titleLower = cleanTitle.toLowerCase();
    const subjectLower = asgt.subject.toLowerCase();
    const asgtCodes = extractSubjectCodes(`${asgt.subject} ${asgt.assignment_id || asgt.assignmentId}`);

    // Rule 2: Strict Subject-Code Conflict Guard
    // If the file specified a subject code (e.g. CS209), NEVER match an assignment from a different subject code (e.g. CS210)
    if (detectedSubjectCodes.length > 0) {
      const isSameSubjectCode = asgtCodes.some((code) => detectedSubjectCodes.includes(code));
      if (!isSameSubjectCode) {
        // Different subject code: strictly forbid matching
        continue;
      }
    }

    // Safety guard: Reject if number conflict exists (e.g. title has #5, but file has #4)
    if (hasNumberConflict(asgt.title, combinedContext)) {
      continue;
    }

    let score = 0;
    const reasons = [];
    let hasSubjectMatch = false;

    // Find subject aliases matching this assignment
    let subjectTokens = [];
    for (const [subjCode, aliases] of Object.entries(SUBJECT_ALIASES)) {
      if (
        subjectLower.includes(subjCode) ||
        asgtCodes.includes(subjCode.toUpperCase()) ||
        aliases.some((a) => subjectLower.includes(a))
      ) {
        subjectTokens = aliases;
        break;
      }
    }
    if (subjectTokens.length === 0) {
      subjectTokens = asgt.subject.split(/[\s-]+/).map((s) => s.toLowerCase()).filter((s) => s.length > 2);
    }

    // A. Check for Subject Match in Caption (Highest priority)
    for (const token of subjectTokens) {
      if (captionLower.includes(token)) {
        score += 60;
        hasSubjectMatch = true;
        reasons.push(`WhatsApp caption matches subject '${token}'`);
        break;
      }
    }

    // B. Check for Subject Match in Filename
    for (const token of subjectTokens) {
      if (fnameLower.includes(token)) {
        score += 50;
        hasSubjectMatch = true;
        reasons.push(`filename matches subject '${token}'`);
        break;
      }
    }

    // C. Check for Subject Match in Document Text
    for (const token of subjectTokens) {
      if (textLower.includes(token)) {
        score += 25;
        hasSubjectMatch = true;
        reasons.push(`document text mentions '${token}'`);
        break;
      }
    }

    // Rule 3: Require Subject Match!
    // Never match an assignment on lab number alone unless either the subject code
    // OR a strong subject name keyword also matches!
    if (!hasSubjectMatch) {
      continue;
    }

    // D. Exact Assignment Number Match
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

    // E. Title Keyword Match (e.g. 'lab', 'report', 'assignment')
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

  // Minimum threshold of 50 points (with verified subject match) to consider it confident
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
  normalizeSubjectCodes,
  extractSubjectCodes,
  hasNumberConflict,
  getPendingFileUploadDeadlines,
  matchAssignmentForFile,
};
