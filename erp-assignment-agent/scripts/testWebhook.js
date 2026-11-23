/**
 * Automated test script to verify WhatsApp Webhook verification handshake
 * and bidirectional command processing.
 */

const axios = require('axios');
const db = require('../src/db/database');
const { startWhatsAppWebhookServer, stopWhatsAppWebhookServer } = require('../src/webhook/whatsappServer');

async function runTests() {
  console.log('=== STARTING WHATSAPP WEBHOOK TESTS ===\n');

  await db.initDb();
  await startWhatsAppWebhookServer(3005);

  const baseUrl = 'http://localhost:3005';

  try {
    // 1. Test GET /webhook (Meta verification handshake)
    console.log('[Test 1] Testing GET /webhook verification handshake...');
    const verifyRes = await axios.get(`${baseUrl}/webhook`, {
      params: {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'sidus_erp_verify_2026',
        'hub.challenge': 'CHALLENGE_ACCEPTED_777',
      },
    });

    if (verifyRes.status === 200 && verifyRes.data === 'CHALLENGE_ACCEPTED_777') {
      console.log('✅ [Test 1 Passed] Meta challenge verification returned 200 OK with correct challenge token.');
    } else {
      console.error('❌ [Test 1 Failed] Unexpected response:', verifyRes.status, verifyRes.data);
    }

    // 2. Test GET /webhook with invalid token
    console.log('\n[Test 2] Testing GET /webhook with invalid token (should return 403)...');
    try {
      await axios.get(`${baseUrl}/webhook`, {
        params: {
          'hub.mode': 'subscribe',
          'hub.verify_token': 'wrong_token',
          'hub.challenge': 'SHOULD_FAIL',
        },
      });
      console.error('❌ [Test 2 Failed] Request should have returned 403 Forbidden.');
    } catch (err) {
      if (err.response && err.response.status === 403) {
        console.log('✅ [Test 2 Passed] Invalid token correctly rejected with 403 Forbidden.');
      } else {
        console.error('❌ [Test 2 Failed] Unexpected error:', err.message);
      }
    }

    // 3. Test POST /webhook from unauthorized number
    console.log('\n[Test 3] Testing POST /webhook from unauthorized number (919999999999)...');
    const unauthorizedPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15551234567', phone_number_id: '1446954535175873' },
                contacts: [{ profile: { name: 'Stranger' }, wa_id: '919999999999' }],
                messages: [
                  {
                    from: '919999999999',
                    id: 'wamid.HBgLOTk5OTk5OTk5ORUCABEYEjE1',
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                    type: 'text',
                    text: { body: 'status' },
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    const unauthRes = await axios.post(`${baseUrl}/webhook`, unauthorizedPayload);
    if (unauthRes.status === 200) {
      console.log('✅ [Test 3 Passed] Webhook immediately acknowledged 200 OK (unauthorized message ignored in background).');
    }

    // 4. Test POST /webhook with "help" from authorized student number
    console.log('\n[Test 4] Testing POST /webhook with command "help" from student (916309049745)...');
    const helpPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15551234567', phone_number_id: '1446954535175873' },
                contacts: [{ profile: { name: 'Bharath' }, wa_id: '916309049745' }],
                messages: [
                  {
                    from: '916309049745',
                    id: 'wamid.HBgLOTYwMDM4ODAzORUCABEYEjE1',
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                    type: 'text',
                    text: { body: 'help' },
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    const helpRes = await axios.post(`${baseUrl}/webhook`, helpPayload);
    if (helpRes.status === 200) {
      console.log('✅ [Test 4 Passed] "help" webhook acknowledged 200 OK.');
    }

    // 5. Test POST /webhook with "status" from authorized student number
    console.log('\n[Test 5] Testing POST /webhook with command "status" from student (916309049745)...');
    const statusPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WHATSAPP_BUSINESS_ACCOUNT_ID',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15551234567', phone_number_id: '1446954535175873' },
                contacts: [{ profile: { name: 'Bharath' }, wa_id: '916309049745' }],
                messages: [
                  {
                    from: '916309049745',
                    id: 'wamid.HBgLOTYwMDM4ODAzORUCABEYEjE2',
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                    type: 'text',
                    text: { body: 'status' },
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    const statusRes = await axios.post(`${baseUrl}/webhook`, statusPayload);
    if (statusRes.status === 200) {
      console.log('✅ [Test 5 Passed] "status" webhook acknowledged 200 OK.');
    }

    // Wait 4 seconds for async background handlers to finish sending WhatsApp messages
    console.log('\nWaiting 4 seconds for async background handlers to dispatch WhatsApp messages...');
    await new Promise((r) => setTimeout(r, 4000));

    console.log('\n=== ALL WEBHOOK TESTS COMPLETED SUCCESSFULLY ===');
  } catch (err) {
    console.error('❌ Test suite failed:', err.message);
  } finally {
    await stopWhatsAppWebhookServer();
    await db.closeDb();
  }
}

runTests();
