/**
 * Test Suite: Telegram Bot Service & Webhook Integration
 */

const assert = require('assert');
const http = require('http');
const telegramBot = require('../src/services/telegramBot');
const { createWebhookApp } = require('../src/webhook/whatsappServer');
const notifier = require('../src/notifications/notifier');

function makeRequest({ port, path, method = 'GET', body = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const reqHeaders = { ...headers };
    if (data) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(data);
    }

    const req = http.request(
      {
        host: 'localhost',
        port,
        path,
        method,
        headers: reqHeaders,
      },
      (res) => {
        let resBody = '';
        res.on('data', (chunk) => (resBody += chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode, body: resBody });
        });
      }
    );

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function runTests() {
  console.log('🧪 Starting Telegram Integration Tests...\n');

  // Test 1: Graceful Skip when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set
  console.log('Test 1: Verification of missing credentials graceful skip...');
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  const result = await telegramBot.initTelegramBot();
  assert.strictEqual(result, null, 'initTelegramBot should return null when env vars are missing');
  console.log('✅ Test 1 Passed: Safely skipped initialization without errors.\n');

  // Test 2: Owner Security Lock Verification
  console.log('Test 2: Verification of single-user owner security lock...');
  process.env.TELEGRAM_CHAT_ID = '789123456';

  const validOwnerMsg = { chat: { id: 789123456 }, from: { id: 789123456 }, text: '/status' };
  const validOwnerStringMsg = { chat: { id: '789123456' }, from: { id: '789123456' }, text: 'status' };
  const unauthorizedMsg = { chat: { id: 999999999 }, from: { id: 999999999 }, text: '/status' };
  const validQuery = { from: { id: 789123456 }, data: 'approve_submission' };
  const unauthorizedQuery = { from: { id: 111111111 }, data: 'approve_submission' };

  assert.strictEqual(telegramBot.isAuthorizedUser(validOwnerMsg), true, 'Owner should be authorized');
  assert.strictEqual(telegramBot.isAuthorizedUser(validOwnerStringMsg), true, 'Owner string ID should be authorized');
  assert.strictEqual(telegramBot.isAuthorizedUser(unauthorizedMsg), false, 'Stranger should NOT be authorized');
  assert.strictEqual(telegramBot.isAuthorizedUser(validQuery), true, 'Owner callback query should be authorized');
  assert.strictEqual(telegramBot.isAuthorizedUser(unauthorizedQuery), false, 'Stranger callback query should NOT be authorized');
  console.log('✅ Test 2 Passed: Owner lock strictly allows owner and blocks all unauthorized users.\n');

  // Test 3: Express Webhook Endpoint for Render Zero-Conflict Mode
  console.log('Test 3: Verification of Express /telegram-webhook endpoint...');
  const app = createWebhookApp();
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(3099, resolve));

  try {
    const healthRes = await makeRequest({ port: 3099, path: '/health' });
    assert.strictEqual(healthRes.status, 200, 'GET /health should return 200');

    const rootRes = await makeRequest({ port: 3099, path: '/' });
    assert.strictEqual(rootRes.status, 200, 'GET / should return 200');

    const webhookRes = await makeRequest({
      port: 3099,
      path: '/telegram-webhook',
      method: 'POST',
      body: {
        update_id: 12345,
        message: {
          message_id: 1,
          chat: { id: 789123456 },
          text: '/help',
        },
      },
    });
    assert.strictEqual(webhookRes.status, 200, 'POST /telegram-webhook should return 200 OK');
    console.log('✅ Test 3 Passed: /telegram-webhook accepts updates and responds 200 OK immediately.\n');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // Test 4: sendTelegramMessage safe fallback when unconfigured
  console.log('Test 4: Verification of sendTelegramMessage safe execution...');
  delete process.env.TELEGRAM_BOT_TOKEN;
  const sendRes = await telegramBot.sendTelegramMessage('Test alert message');
  assert.strictEqual(sendRes.skipped, true, 'sendTelegramMessage should gracefully report skipped');

  assert.strictEqual(
    typeof notifier.sendTelegramMessage,
    'function',
    'notifier should export sendTelegramMessage'
  );
  console.log('✅ Test 4 Passed: sendTelegramMessage is safely callable and mirrored in notifier.\n');

  console.log('🎉 All Telegram Integration Tests Passed Successfully!');
}

runTests().catch((err) => {
  console.error('❌ Test Failure:', err);
  process.exit(1);
});
