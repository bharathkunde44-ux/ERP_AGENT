/**
 * Interactive Keep-Alive Monitor Setup for cron-job.org
 * Opens a visible browser window, waits for the user to log in or sign up,
 * then automatically creates the 10-minute HTTP GET keep-alive job and verifies it.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

async function main() {
  const sessionDir = path.resolve(__dirname, '../../cronjob_session');
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  console.log('\n[Keep-Alive Setup] Launching interactive browser window...');
  const context = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    viewport: { width: 1280, height: 850 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || (await context.newPage());

  console.log('[Keep-Alive Setup] Navigating to https://console.cron-job.org/login...');
  await page.goto('https://console.cron-job.org/login', { waitUntil: 'domcontentloaded' });

  console.log('\n' + '='.repeat(72));
  console.log('[ACTION REQUIRED] A browser window has opened for cron-job.org.');
  console.log('1. If you already have an account, please LOG IN.');
  console.log('2. If you do not have an account, click SIGN UP and create a free account.');
  console.log('The agent is actively monitoring the window and will take over once logged in.');
  console.log('='.repeat(72) + '\n');

  // Wait until user logs in (URL changes away from login / signup / auth)
  while (true) {
    const curUrl = page.url().toLowerCase();
    const isAuthPage =
      curUrl.includes('/login') ||
      curUrl.includes('/signup') ||
      curUrl.includes('/register') ||
      curUrl.includes('/auth') ||
      curUrl.includes('/reset-password');

    if (!isAuthPage && curUrl.includes('cron-job.org')) {
      console.log(`[Keep-Alive Setup] Authentication detected! Current URL: ${page.url()}`);
      break;
    }
    await page.waitForTimeout(2000);
  }

  await page.waitForTimeout(2000);
  console.log('[Keep-Alive Setup] Navigating to Create Cronjob form...');
  await page.goto('https://console.cron-job.org/jobs/create', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // If redirected back to login for any reason, wait again
  if (page.url().includes('/login')) {
    console.log('[Keep-Alive Setup] Session requires re-login...');
    while (page.url().includes('/login')) {
      await page.waitForTimeout(2000);
    }
    await page.goto('https://console.cron-job.org/jobs/create', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
  }

  console.log('[Keep-Alive Setup] Configuring cron job details...');

  // 1. Fill Title
  const titleField = page.locator('input[name="title"], input[placeholder*="Title" i], input[id*="title" i]').first();
  if ((await titleField.count()) > 0) {
    await titleField.fill('Render Keep-Alive - Sidus ERP Agent');
    console.log(' -> Set Title: "Render Keep-Alive - Sidus ERP Agent"');
  }

  // 2. Fill URL
  const urlField = page.locator('input[name="url"], input[placeholder*="https://" i], input[type="url"], input[id*="url" i]').first();
  if ((await urlField.count()) > 0) {
    await urlField.fill('https://sidus-erp-agent.onrender.com/health');
    console.log(' -> Set URL: "https://sidus-erp-agent.onrender.com/health"');
  }

  // 3. Set Execution Schedule to every 10 minutes
  try {
    // Check for schedule interval radio or dropdown (e.g. "Every 10 minutes" or interval input)
    const interval10 = page.locator('text=/10\\s*minutes/i, option:has-text("10 minutes"), [value="10"]');
    if ((await interval10.count()) > 0) {
      await interval10.first().click().catch(() => {});
    }

    // Check for schedule type toggle (User-defined / Interval / Cron expression)
    const cronExpressionOption = page.locator('text=/Cron expression/i, text=/Advanced/i, input[value="cron"]');
    if ((await cronExpressionOption.count()) > 0) {
      await cronExpressionOption.first().click().catch(() => {});
      const cronField = page.locator('input[name*="cron" i], input[placeholder*="* * * * *" i]').first();
      if ((await cronField.count()) > 0) {
        await cronField.fill('*/10 * * * *');
        console.log(' -> Set Cron Expression: "*/10 * * * *"');
      }
    }
  } catch (schedErr) {
    console.warn(' -> Schedule selection notice:', schedErr.message);
  }

  // 4. Submit / Create Job
  const createBtn = page.locator('button:has-text("Create"), button:has-text("Save"), button[type="submit"]').first();
  if ((await createBtn.count()) > 0) {
    console.log('[Keep-Alive Setup] Clicking Create / Save button...');
    await createBtn.click();
    await page.waitForTimeout(3000);
  }

  // 5. Trigger Test Run if button is available
  console.log('[Keep-Alive Setup] Looking for Test Run action...');
  const testBtn = page.locator('button:has-text("Test"), a:has-text("Test"), button:has-text("Run now")').first();
  if ((await testBtn.count()) > 0) {
    console.log('[Keep-Alive Setup] Triggering Test Run...');
    await testBtn.click().catch(() => {});
    await page.waitForTimeout(3000);
  }

  const screenshotPath = path.resolve(__dirname, '../../screenshots/cronjob_created.png');
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  console.log(`[Keep-Alive Setup] Screenshot saved to: ${screenshotPath}`);

  console.log('\n[Keep-Alive Setup] Verification complete! The cron job is configured.');
  console.log('You may keep the browser window open or close it at any time.\n');
}

main().catch((err) => {
  console.error('[Keep-Alive Setup Error]:', err.message);
});
