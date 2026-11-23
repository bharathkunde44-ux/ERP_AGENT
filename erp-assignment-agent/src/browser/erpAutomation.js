/**
 * Playwright Browser Automation for Aurora University ERP (sidus.net)
 * Handles persistent browser session storage, automatic interactive login fallback,
 * multi-tab table scraping (Theory / Lab / Project), stale-deadline cleanup,
 * number-mismatch safety guard, and filechooser upload automation.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { config } = require('../config/env');
const db = require('../db/database');

/**
 * Returns the exact configured portal URL without altering subdomain cookies
 */
function getPortalUrl(rawUrl) {
  return (rawUrl || config.erp.portalUrl || 'https://www.sidus.net/modules/assessments/assessments').trim();
}

/**
 * Creates or reuses a persistent Playwright browser context
 */
async function launchBrowser(customHeadless = null) {
  const sessionDir = config.paths.browserSession;
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const isHeadless = customHeadless !== null ? customHeadless : config.agent.headless;

  const context = await chromium.launchPersistentContext(sessionDir, {
    headless: isHeadless,
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    args: ['--disable-blink-features=AutomationControlled'],
  });

  return context;
}

/**
 * Helper: Strictly waits until Sidus renders "View assessments" or assessment table rows.
 */
async function ensureSidusLoadedAndAuthenticated(page, targetUrl) {
  const hasAssessmentsRendered = async () => {
    const viewCount = await page.getByText(/View assessments/i).count().catch(() => 0);
    const rowCount = await page.locator('table tbody tr').count().catch(() => 0);
    return viewCount > 0 || rowCount > 0;
  };

  for (let i = 0; i < 6; i++) {
    if (await hasAssessmentsRendered()) {
      await page.waitForTimeout(1000);
      return;
    }
    await page.waitForTimeout(1000);
  }

  console.log(`\n[Browser Scraper] Current Page URL: ${page.url()}`);
  console.log('='.repeat(68));
  console.log('[Browser] WAITING FOR SIDUS ASSESSMENTS CARDS TO APPEAR...');
  console.log(' -> If the Chrome window shows a Login screen, please sign in now.');
  console.log(' -> Once "View assessments" cards appear, scraping will start!');
  console.log('='.repeat(68) + '\n');

  try {
    const userField = page
      .locator('input[type="email"], input[type="text"], input[name*="user"], input[name*="email"]')
      .first();
    const passField = page.locator('input[type="password"]').first();
    if ((await userField.count()) > 0 && config.erp.username && config.erp.username !== 'student_2026') {
      await userField.fill(config.erp.username);
    }
    if ((await passField.count()) > 0 && config.erp.password && config.erp.password !== 'student_pass_secure') {
      await passField.fill(config.erp.password);
    }
  } catch (_) { }

  const maxWaitLoops = 90;
  for (let loop = 0; loop < maxWaitLoops; loop++) {
    if (await hasAssessmentsRendered()) {
      console.log('[Browser] Assessments cards detected on page!');
      await page.waitForTimeout(1500);
      return;
    }

    const curUrl = page.url().toLowerCase();
    if (
      curUrl.includes('sidus.net') &&
      !curUrl.includes('login') &&
      !curUrl.includes('auth') &&
      !curUrl.includes('/assessments')
    ) {
      console.log('[Browser] Logged in! Redirecting to Assessments module...');
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
    }

    await page.waitForTimeout(2000);
  }
}

/**
 * Helper: Walks up the DOM from a "View assessments" element to find its full Subject Card text
 */
async function getSubjectCardText(buttonLocator) {
  return await buttonLocator
    .evaluate((el) => {
      let curr = el;
      for (let depth = 0; depth < 8; depth++) {
        if (!curr.parentElement) break;
        curr = curr.parentElement;
        const txt = (curr.innerText || '').trim();
        if (txt.includes('Ongoing') && (txt.includes('Total') || txt.includes('Published'))) {
          return txt;
        }
      }
      return (curr.innerText || '').trim();
    })
    .catch(() => '');
}

/**
 * Interactive login session
 */
async function loginInteractive({ portalUrl = null } = {}) {
  const url = getPortalUrl(portalUrl);

  console.log('\n[Browser] Launching interactive login window...');
  console.log(`[Browser] Session directory: ${config.paths.browserSession}`);
  console.log(`[Browser] Navigating to: ${url}`);

  const context = await launchBrowser(false);
  const page = context.pages()[0] || (await context.newPage());

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await ensureSidusLoadedAndAuthenticated(page, url);

    console.log('[Browser] Interactive session verified and saved successfully!');
    await db.recordAuditLog('INTERACTIVE_LOGIN', { portalUrl: url, status: 'SUCCESS' });
  } finally {
    await context.close();
  }
}

/**
 * Checks if a valid authenticated session exists
 */
async function checkSession({ portalUrl = null } = {}) {
  const url = getPortalUrl(portalUrl);
  const context = await launchBrowser(true);
  const page = context.pages()[0] || (await context.newPage());

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(4000);
    const viewCount = await page.getByText(/View assessments/i).count().catch(() => 0);
    return viewCount > 0;
  } catch (error) {
    return false;
  } finally {
    await context.close();
  }
}

/**
 * Helper: Extracts Ongoing rows from the active Sidus assessment table
 */
async function extractTableRowsOnCurrentTab(page, tabName, url, subjectIdx) {
  const rows = page.locator('table tbody tr');
  const rowCount = await rows.count();
  const extracted = [];
  const origin = new URL(url).origin;

  for (let r = 0; r < rowCount; r++) {
    try {
      const row = rows.nth(r);
      const cells = row.locator('td');
      const cellCount = await cells.count();
      if (cellCount < 6) continue;

      const assessmentCellText = (await cells.nth(0).innerText().catch(() => '')).trim();
      const subjectCellText = (await cells.nth(1).innerText().catch(() => '')).trim();
      const startText = (await cells.nth(2).innerText().catch(() => '')).trim();
      const dueText = (await cells.nth(3).innerText().catch(() => '')).trim();
      const pointsText = (await cells.nth(4).innerText().catch(() => '')).trim();
      const statusText = (await cells.nth(5).innerText().catch(() => '')).trim();

      if (!/Ongoing/i.test(statusText)) {
        continue;
      }

      const assessmentLines = assessmentCellText.split('\n').map((s) => s.trim()).filter(Boolean);
      const title = assessmentLines[0] || 'Untitled Assessment';
      const assessmentType = assessmentLines[1] || 'ASSESSMENT';

      const subjectLines = subjectCellText.split('\n').map((s) => s.trim()).filter(Boolean);
      const subjectName = subjectLines[0] || 'Unknown Subject';
      const subjectCode = subjectLines[1] || '';

      const actionCell = cells.nth(6);
      const linkEl = actionCell.locator('a').first();
      const href = (await linkEl.count()) > 0 ? await linkEl.getAttribute('href') : null;

      let isoDueDate;
      const parsedDue = new Date(`${dueText} 23:59:59`);
      if (!isNaN(parsedDue.getTime())) {
        isoDueDate = parsedDue.toISOString();
      } else {
        isoDueDate = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      }

      const cleanSlug = `${subjectCode}_${tabName}_${title}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '');

      extracted.push({
        assignmentId: cleanSlug,
        subject: subjectCode ? `${subjectCode} - ${subjectName}` : subjectName,
        title: `${title} (${assessmentType})`,
        description: `SubjectIndex: ${subjectIdx} | SubjectName: ${subjectName} | SubjectCode: ${subjectCode} | Tab: ${tabName} | Type: ${assessmentType} | Start: ${startText} | Due: ${dueText} | Max Points: ${pointsText}`,
        dueDate: isoDueDate,
        status: 'PENDING',
        portalUrl: href
          ? `${origin}${href.startsWith('/') ? '' : '/'}${href}`
          : `${url}#subjectIdx=${subjectIdx}&subject=${encodeURIComponent(subjectName)}&tab=${encodeURIComponent(tabName)}&title=${encodeURIComponent(title)}`,
      });
    } catch (err) {
      // Skip malformed row
    }
  }

  return extracted;
}

/**
 * Scrapes all Ongoing deadlines across all subjects and tabs (Theory, Lab, Project) on sidus.net
 * Also marks stale DB deadlines that are no longer Ongoing on the portal as CLOSED_ON_PORTAL.
 */
async function scrapeAssignments(customPageOrOptions = null, customUrl = null) {
  let page = null;
  let context = null;

  if (customPageOrOptions && typeof customPageOrOptions.goto === 'function') {
    page = customPageOrOptions;
  } else {
    if (customPageOrOptions && typeof customPageOrOptions === 'object' && !customUrl) {
      customUrl = customPageOrOptions.portalUrl || customPageOrOptions.url;
    }
    context = await launchBrowser(config.agent.headless);
    page = context.pages()[0] || (await context.newPage());
  }

  const url = getPortalUrl(customUrl);
  const scrapedDeadlines = [];

  try {
    console.log(`[Browser Scraper] Navigating to ERP portal at ${url}...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    console.log('[Browser Scraper] Waiting for Sidus subject cards to load...');
    await ensureSidusLoadedAndAuthenticated(page, url);

    const screenshotsDir = config.paths.screenshots;
    if (!fs.existsSync(screenshotsDir)) {
      fs.mkdirSync(screenshotsDir, { recursive: true });
    }
    await page.screenshot({ path: path.join(screenshotsDir, 'debug_scrape.png'), fullPage: true });

    const backBtn = page.locator('button:has(svg.lucide-chevron-left)').first();
    if ((await page.locator('table tbody tr').count()) > 0 && (await backBtn.count()) > 0) {
      await backBtn.click().catch(() => { });
      await page.waitForTimeout(1500);
    }

    const viewButtons = page.getByText(/View assessments/i);
    const totalSubjects = await viewButtons.count();
    console.log(`[Browser Scraper] Found ${totalSubjects} subject card(s) on Sidus.`);

    for (let i = 0; i < totalSubjects; i++) {
      try {
        const currentViewButtons = page.getByText(/View assessments/i);
        if (i >= (await currentViewButtons.count())) break;

        const buttonEl = currentViewButtons.nth(i);
        const cardText = await getSubjectCardText(buttonEl);
        const cardLines = cardText.split('\n').map((s) => s.trim()).filter(Boolean);
        const subjectHeader = cardLines[0] && !/View assessments/i.test(cardLines[0]) ? cardLines[0] : `Subject_${i + 1}`;

        const ongoingIdx = cardLines.findIndex((l) => /^Ongoing$/i.test(l));
        const ongoingCount = ongoingIdx > 0 ? parseInt(cardLines[ongoingIdx - 1], 10) : 1;

        if (ongoingCount === 0) {
          console.log(`[Browser Scraper] Skipping ${subjectHeader} (0 Ongoing assessments).`);
          continue;
        }

        console.log(`[Browser Scraper] Inspecting ${subjectHeader} (${ongoingCount} Ongoing)...`);
        await buttonEl.click();

        await page.waitForSelector('table tbody tr', { timeout: 10000 }).catch(() => { });
        await page.waitForTimeout(1000);

        const tabNames = ['Theory', 'Lab', 'Project'];
        for (const tabName of tabNames) {
          const tabButton = page
            .locator('button, div[role="tab"]')
            .filter({ hasText: new RegExp(`^${tabName}`, 'i') })
            .first();

          if ((await tabButton.count()) > 0) {
            const tabText = (await tabButton.innerText().catch(() => '')).trim();
            if (new RegExp(`^${tabName}\\s*\\n?\\s*0$`, 'i').test(tabText)) {
              continue;
            }
            await tabButton.click().catch(() => { });
            await page.waitForTimeout(800);
          }

          const items = await extractTableRowsOnCurrentTab(page, tabName, url, i);
          for (const item of items) {
            await db.upsertDeadline(item);
            if (!scrapedDeadlines.some((d) => d.assignmentId === item.assignmentId)) {
              scrapedDeadlines.push(item);
              console.log(`   -> Found Ongoing: [${item.subject}] ${item.title} (Due: ${item.dueDate.split('T')[0]})`);
            }
          }
        }

        const innerBackBtn = page.locator('button:has(svg.lucide-chevron-left)').first();
        if ((await innerBackBtn.count()) > 0) {
          await innerBackBtn.click();
        } else {
          await page.goto(url, { waitUntil: 'domcontentloaded' });
        }
        await page.waitForTimeout(1500);
      } catch (subErr) {
        console.warn(`[Browser Scraper] Warning on subject #${i + 1}:`, subErr.message);
        await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => { });
        await page.waitForTimeout(1500);
      }
    }

    // Reconcile stale PENDING records that were already submitted/closed on Sidus
    if (totalSubjects > 0) {
      const activeIds = new Set(scrapedDeadlines.map((d) => d.assignmentId));
      const existingPending = await db.getPendingDeadlines();
      for (const oldRecord of existingPending) {
        const oldId = oldRecord.assignment_id || oldRecord.assignmentId;
        if (oldId && !activeIds.has(oldId)) {
          await db.markDeadlineSubmitted(oldId, 'CLOSED_OR_SUBMITTED_ON_PORTAL');
          console.log(`[Browser Scraper] Synced status: "${oldRecord.title}" is no longer Ongoing on Sidus (marked closed).`);
        }
      }
    }

    console.log(`[Browser Scraper] Successfully scraped ${scrapedDeadlines.length} Ongoing assignment(s) from portal.`);
    await db.recordAuditLog('SCRAPE_DEADLINES', { count: scrapedDeadlines.length });
    return scrapedDeadlines;
  } catch (error) {
    console.error(`[Browser Scraper] Failed to scrape deadlines:`, error.message);
    throw error;
  } finally {
    if (context) {
      await context.close();
    }
  }
}

/**
 * Automates file submission for a Sidus FILE UPLOAD assessment with proof screenshot
 */
async function submitAssignment({
  portalUrl = null,
  assignmentId,
  filePath,
  dryRun = false,
  confidenceScore = 100,
  reasoning = '',
}) {
  const baseUrl = getPortalUrl(portalUrl);
  const filename = path.basename(filePath);

  console.log(`\n[Browser Uploader] Preparing to submit "${filename}" for ${assignmentId}`);
  console.log(`[Browser Uploader] Mode: ${dryRun ? 'DRY-RUN (SIMULATION)' : 'LIVE SUBMISSION'}`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Submission file not found at path: ${filePath}`);
  }

  const pendingList = await db.getPendingDeadlines();
  const targetRecord = pendingList.find(
    (a) => (a.assignment_id || a.assignmentId) === assignmentId
  );

  const cleanTitle = targetRecord
    ? targetRecord.title.replace(/\s*\(.*?\)\s*$/, '').trim()
    : assignmentId.replace(/^[a-z0-9]+_(theory|lab|project)_/i, '').replace(/_/g, ' ');

  if (targetRecord && !/FILE UPLOAD/i.test(targetRecord.title) && !/FILE UPLOAD/i.test(targetRecord.description || '')) {
    console.warn(
      `[Browser Uploader] Blocked upload: "${targetRecord.title}" is an online portal activity, not a FILE UPLOAD.`
    );
    return {
      success: false,
      skipped: true,
      message: `Skipped: ${targetRecord.title} is not a file upload assessment.`,
    };
  }

  const titleNumbers = cleanTitle.match(/\d+/g);
  const fileNumbers = filename.replace(/\.[^/.]+$/, '').match(/\d+/g);
  if (titleNumbers && titleNumbers.length > 0) {
    const requiredNum = titleNumbers[titleNumbers.length - 1];
    if (!fileNumbers || !fileNumbers.includes(requiredNum)) {
      console.warn(
        `[Browser Uploader] SAFETY BLOCK: "${cleanTitle}" requires #${requiredNum}, but matched file is "${filename}". Refusing to upload wrong lab/assignment number!`
      );
      return {
        success: false,
        skipped: true,
        message: `Blocked mismatched number: ${cleanTitle} requires #${requiredNum}, file is ${filename}.`,
      };
    }
  }

  const screenshotsDir = config.paths.screenshots;
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  const context = await launchBrowser();
  const page = context.pages()[0] || (await context.newPage());

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await ensureSidusLoadedAndAuthenticated(page, baseUrl);

    let subjectName = '';
    if (targetRecord && targetRecord.subject) {
      const parts = targetRecord.subject.split(' - ');
      subjectName = (parts.length > 1 ? parts.slice(1).join(' - ') : parts[0]).trim();
    }

    const idxMatch =
      targetRecord && targetRecord.description
        ? targetRecord.description.match(/SubjectIndex:\s*(\d+)/i)
        : null;
    const savedSubjectIdx = idxMatch ? parseInt(idxMatch[1], 10) : null;

    console.log(`[Browser Uploader] Target Subject Card: "${subjectName}" | Target Row: "${cleanTitle}"`);

    let clickedSubject = false;
    const viewButtons = page.getByText(/View assessments/i);
    const totalCards = await viewButtons.count();

    for (let i = 0; i < totalCards; i++) {
      const btn = viewButtons.nth(i);
      const fullCardText = await getSubjectCardText(btn);
      if (subjectName && fullCardText.toLowerCase().includes(subjectName.toLowerCase())) {
        console.log(`[Browser Uploader] Matched subject card #${i + 1} ("${subjectName}")`);
        await btn.click();
        clickedSubject = true;
        break;
      }
    }

    if (!clickedSubject && savedSubjectIdx !== null && savedSubjectIdx < totalCards) {
      console.log(`[Browser Uploader] Clicking subject card by index #${savedSubjectIdx + 1}...`);
      await viewButtons.nth(savedSubjectIdx).click();
      clickedSubject = true;
    }

    if (!clickedSubject) {
      throw new Error(`Could not find subject card for "${subjectName}" on Sidus assessments page.`);
    }

    await page.waitForSelector('table tbody tr', { timeout: 10000 }).catch(() => { });
    await page.waitForTimeout(1000);

    const tabToClick =
      targetRecord && targetRecord.description && targetRecord.description.includes('Tab: Lab')
        ? 'Lab'
        : targetRecord && targetRecord.description && targetRecord.description.includes('Tab: Project')
          ? 'Project'
          : /_lab_/i.test(assignmentId)
            ? 'Lab'
            : /_project_/i.test(assignmentId)
              ? 'Project'
              : 'Theory';

    const tabBtn = page
      .locator('button, div[role="tab"]')
      .filter({ hasText: new RegExp(`^${tabToClick}`, 'i') })
      .first();

    if ((await tabBtn.count()) > 0) {
      console.log(`[Browser Uploader] Switching to "${tabToClick}" tab...`);
      await tabBtn.click();
      await page.waitForTimeout(1200);
    }

    const targetRow = page
      .locator('table tbody tr')
      .filter({ hasText: new RegExp(cleanTitle, 'i') })
      .first();

    if ((await targetRow.count()) === 0) {
      throw new Error(`Could not locate assessment row for "${cleanTitle}" inside ${subjectName} (${tabToClick} tab).`);
    }

    // Verify row is still Ongoing (not already Submitted/Closed)
    const rowStatus = (await targetRow.locator('td').nth(5).innerText().catch(() => '')).trim();
    if (rowStatus && !/Ongoing/i.test(rowStatus)) {
      console.log(`[Browser Uploader] Row "${cleanTitle}" status is "${rowStatus}" (already submitted/closed). Marking complete in DB.`);
      await db.markDeadlineSubmitted(assignmentId, filePath);
      return {
        success: false,
        skipped: true,
        message: `Assessment "${cleanTitle}" is already ${rowStatus} on Sidus.`,
      };
    }

    await targetRow.scrollIntoViewIfNeeded();
    const timestamp = Date.now();

    if (dryRun) {
      await targetRow.evaluate((el) => {
        el.style.outline = '4px solid #10b981';
        el.style.backgroundColor = '#ecfdf5';
      });
      await page.waitForTimeout(500);

      const screenshotPath = path.join(screenshotsDir, `dryrun_${assignmentId}_${timestamp}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      await db.recordSubmission({
        assignmentId,
        filename,
        filepath: filePath,
        screenshotPath,
        confidenceScore,
        reasoning: `[DRY-RUN] Verified row target for ${cleanTitle} with local file ${filename}. ${reasoning}`,
        status: 'DRY_RUN',
      });

      console.log(`[Browser Uploader] Dry-run completed! Highlighted proof screenshot saved to: ${screenshotPath}`);
      return {
        success: true,
        dryRun: true,
        screenshotPath,
        message: 'Dry-run submission verified target row on Sidus without uploading file.',
      };
    }

    // Handle direct <input type="file"> or native filechooser button
    const hiddenFileInput = targetRow.locator('input[type="file"]').first();
    if ((await hiddenFileInput.count()) > 0) {
      await hiddenFileInput.setInputFiles(filePath);
    } else {
      const actionBtn = targetRow.locator('td').nth(6).locator('button, a, [role="button"]').first();
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 10000 }),
        actionBtn.click(),
      ]);
      await fileChooser.setFiles(filePath);
    }

    console.log(`[Browser Uploader] Attached file: ${filePath}`);
    await page.waitForTimeout(2500);

    const confirmBtn = page
      .locator('button:has-text("Submit"), button:has-text("Upload"), button:has-text("Confirm")')
      .first();
    if ((await confirmBtn.count()) > 0 && (await confirmBtn.isVisible())) {
      await confirmBtn.click();
      await page.waitForTimeout(2500);
    }

    const screenshotPath = path.join(screenshotsDir, `submission_${assignmentId}_${timestamp}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    await db.markDeadlineSubmitted(assignmentId, filePath);
    await db.recordSubmission({
      assignmentId,
      filename,
      filepath: filePath,
      screenshotPath,
      confidenceScore,
      reasoning,
      status: 'SUCCESS',
    });

    console.log(`[Browser Uploader] Live submission completed! Proof screenshot: ${screenshotPath}`);
    return {
      success: true,
      dryRun: false,
      screenshotPath,
      message: 'Assignment submitted successfully to Sidus portal.',
    };
  } catch (error) {
    const errorScreenshotPath = path.join(screenshotsDir, `failed_${assignmentId}_${Date.now()}.png`);
    try {
      await page.screenshot({ path: errorScreenshotPath, fullPage: true });
    } catch (_) { }

    await db.recordSubmission({
      assignmentId,
      filename,
      filepath: filePath,
      screenshotPath: errorScreenshotPath,
      confidenceScore,
      reasoning,
      status: 'FAILED',
      errorMessage: error.message,
    });

    console.error(`[Browser Uploader] Submission failed:`, error.message);
    throw error;
  } finally {
    await context.close();
  }
}

module.exports = {
  loginInteractive,
  checkSession,
  scrapeAssignments,
  scrapeDeadlines: scrapeAssignments,
  submitAssignment,
};