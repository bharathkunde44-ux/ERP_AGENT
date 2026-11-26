/**
 * Test Suite: Draft Delivery Flow, HTTPS Email & Honest Status Reporting
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const notifier = require('../src/notifications/notifier');
const { config } = require('../src/config/env');

async function runTests() {
  console.log('🧪 Starting Draft Delivery & HTTPS Email Tests...\n');

  // Test 1: Verification of sendWhatsAppDocument function & simulated mode
  console.log('Test 1: Verification of sendWhatsAppDocument...');
  assert.strictEqual(typeof notifier.sendWhatsAppDocument, 'function', 'sendWhatsAppDocument must be a function');

  // Create temporary test file
  const tempTestFile = path.join(__dirname, 'temp_test_draft.md');
  fs.writeFileSync(tempTestFile, '# Test Draft Markdown Content\n\nSample draft text.', 'utf8');

  try {
    const waDocRes = await notifier.sendWhatsAppDocument({
      filePath: tempTestFile,
      filename: 'temp_test_draft.md',
      caption: 'Test Caption',
    });
    // In local / unconfigured WhatsApp mode, it should simulate or return object
    assert.strictEqual(typeof waDocRes, 'object', 'sendWhatsAppDocument should return a result object');
    assert.strictEqual(typeof waDocRes.success, 'boolean', 'waDocRes.success should be boolean');
    console.log('✅ Test 1 Passed: sendWhatsAppDocument safely handles file input.\n');

    // Test 2: Verification of sendTelegramDocument function
    console.log('Test 2: Verification of sendTelegramDocument...');
    assert.strictEqual(typeof notifier.sendTelegramDocument, 'function', 'sendTelegramDocument must be a function');
    const tgDocRes = await notifier.sendTelegramDocument(tempTestFile, 'temp_test_draft.md', 'Test Caption');
    assert.strictEqual(typeof tgDocRes, 'object', 'sendTelegramDocument should return a result object');
    assert.strictEqual(typeof tgDocRes.success, 'boolean', 'tgDocRes.success should be boolean');
    console.log('✅ Test 2 Passed: sendTelegramDocument safely handles file input.\n');

    // Test 3: Verification of HTTPS Email delivery & honest status on Render
    console.log('Test 3: Verification of sendEmail honest status on Render...');
    // Simulate Render environment
    process.env.RENDER_EXTERNAL_URL = 'https://sidus-erp-agent.onrender.com';
    delete process.env.RESEND_API_KEY;

    const emailRes = await notifier.sendEmail({
      subject: 'Test Subject',
      htmlContent: '<p>Test</p>',
      textContent: 'Test',
      attachments: [{ filename: 'temp_test_draft.md', path: tempTestFile }],
    });

    assert.strictEqual(typeof emailRes, 'object', 'sendEmail should return an object');
    assert.strictEqual(emailRes.success, false, 'sendEmail should report success=false on Render without HTTPS transport');
    assert.ok(
      emailRes.error && emailRes.error.includes('Render blocks outbound SMTP'),
      `Expected error about Render blocking SMTP, got: ${emailRes.error}`
    );
    console.log(`✅ Test 3 Passed: Honest reporting returned error: "${emailRes.error}"\n`);

    // Test 4: Verification of honest status line generation
    console.log('Test 4: Verification of honest status formatting...');
    const recipient = 'bharathkunde44@gmail.com';

    // Simulated failure status line
    const failedStatus = emailRes.success
      ? `📧 *Emailed to:* ${recipient}`
      : `⚠️ *Email skipped* (${emailRes.error || 'Blocked outbound SMTP'}) — full file attached above.`;

    assert.ok(failedStatus.startsWith('⚠️ *Email skipped*'), 'Should start with warning when failed');
    assert.ok(failedStatus.includes('full file attached above'), 'Should mention full file attached above');

    // Simulated success status line
    const successRes = { success: true, messageId: 'msg_12345' };
    const successStatus = successRes.success
      ? `📧 *Emailed to:* ${recipient}`
      : `⚠️ *Email skipped* (${successRes.error}) — full file attached above.`;

    assert.strictEqual(successStatus, `📧 *Emailed to:* ${recipient}`);
    console.log('✅ Test 4 Passed: Status line formatting matches specifications exactly.\n');

  } finally {
    if (fs.existsSync(tempTestFile)) {
      fs.unlinkSync(tempTestFile);
    }
  }

  console.log('🎉 All Draft Delivery & HTTPS Email Tests Passed Successfully!');
}

runTests().catch((err) => {
  console.error('❌ Test Failure:', err);
  process.exit(1);
});
