#!/usr/bin/env node
/**
 * test-90-180-validation.mjs
 * Submits a 91-day GCash bank statement via batch-upload, waits for callbacks,
 * decrypts and asserts gs_90days_consec_bankstatement === 1 and
 * gs_180days_valid_bankstatement === 1 from computedFields.
 */

import 'dotenv/config';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';

// -- Config -------------------------------------------------------------------

const STAGING_URL = (process.env.STAGING_URL || 'https://ai-boostform-api-1019050071398.us-central1.run.app').replace(/\/$/, '');
const VERIFYIQ_KEY = process.env.VERIFYIQ_API_KEY;
const GOOGLE_SA_KEY_FILE = process.env.GOOGLE_SA_KEY_FILE;
const WEBHOOK_SERVER_URL = (process.env.WEBHOOK_SERVER_URL || '').trim().replace(/\/$/, '');
const DECRYPT_URL = process.env.DECRYPT_URL || 'https://us-central1-boost-capital-staging.cloudfunctions.net/verifyiq-gateway/utils/decrypt';

const FILE = 'gs://verifyiq-internal-testing/QA/Gcash/HP-BS-01_GCash_QA_91days.pdf';

// -- IAP tokens ---------------------------------------------------------------

function makeIapToken(audience) {
  const sa = JSON.parse(readFileSync(GOOGLE_SA_KEY_FILE, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: sa.client_email, sub: sa.client_email, aud: audience, iat: now, exp: now + 3600, target_audience: audience },
    sa.private_key, { algorithm: 'RS256', keyid: sa.private_key_id },
  );
}

// -- Helpers ------------------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function decryptCallback(rawBody) {
  const res = await axios.post(DECRYPT_URL, rawBody, {
    headers: { Authorization: `Bearer ${makeIapToken(STAGING_URL)}`, 'Content-Type': 'text/plain' },
    validateStatus: () => true,
  });
  if (res.status !== 200) throw new Error(`Decrypt HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
  return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
}

// -- Main ---------------------------------------------------------------------

async function main() {
  console.log('=== 90/180-day computedFields validation ===\n');
  console.log(`File: ${FILE}`);

  // 1. Create webhook token
  const webhookIap = makeIapToken(WEBHOOK_SERVER_URL);
  console.log('\n-> Creating webhook token...');
  const tokenRes = await axios.post(`${WEBHOOK_SERVER_URL}/token`, null, {
    headers: { Authorization: `Bearer ${webhookIap}` }, validateStatus: () => true,
  });
  const webhookTokenId = tokenRes.data?.uuid;
  if (!webhookTokenId) { console.error('Fatal: no webhook token uuid'); process.exit(1); }
  console.log(`  Token: ${webhookTokenId}`);

  try {
    // 2. Get baseline
    const baseRes = await axios.get(
      `${WEBHOOK_SERVER_URL}/token/${webhookTokenId}/requests?per_page=200`,
      { headers: { Authorization: `Bearer ${webhookIap}` }, validateStatus: () => true },
    );
    const baselineCount = baseRes.data?.data?.length ?? 0;

    // 3. Submit batch upload
    console.log('\n-> Submitting batch upload...');
    const webhookIapHeader = { Authorization: `Bearer ${webhookIap}` };
    const payload = {
      payload: {
        publicUserId: `test-90-180-${Date.now()}`,
        submissionId: randomUUID(),
        documents: [{
          documentId: randomUUID(),
          fileId: randomUUID(),
          documentClassification: 'PRIMARY',
          documentType: 'BANK_STATEMENT',
          filename: FILE.split('/').pop(),
          preSignedUrl: FILE,
        }],
      },
      callbacks: {
        documentResult: { url: `${WEBHOOK_SERVER_URL}/${webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
        applicationResult: { url: `${WEBHOOK_SERVER_URL}/${webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
      },
    };

    const client = axios.create({
      baseURL: STAGING_URL,
      headers: { Authorization: `Bearer ${makeIapToken(STAGING_URL)}`, 'X-Tenant-Token': VERIFYIQ_KEY, 'Content-Type': 'application/json' },
      validateStatus: () => true,
    });

    const res = await client.post('/ai-gateway/batch-upload', payload);
    if (res.status !== 200) { console.error(`Fatal: HTTP ${res.status}`, res.data); process.exit(1); }
    console.log(`  HTTP 200, applicationId=${res.data.applicationId}`);

    // 4. Poll for callbacks (1 doc + 1 app = 2)
    console.log('\n-> Waiting for 2 callbacks (1 doc + 1 app)...');
    const expectedCallbacks = 2;
    const start = Date.now();
    let callbacks;
    while (Date.now() - start < 120_000) {
      await sleep(3_000);
      const pollRes = await axios.get(
        `${WEBHOOK_SERVER_URL}/token/${webhookTokenId}/requests?per_page=200`,
        { headers: { Authorization: `Bearer ${webhookIap}` }, validateStatus: () => true },
      );
      const all = pollRes.data?.data ?? [];
      const newReqs = all.slice(0, all.length - baselineCount);
      if (newReqs.length >= expectedCallbacks) { callbacks = newReqs; break; }
      console.log(`  Polling... ${newReqs.length}/${expectedCallbacks}`);
    }
    if (!callbacks) { console.error('Fatal: timed out waiting for callbacks'); process.exit(1); }
    console.log(`  Received ${callbacks.length} callbacks`);

    // 5. Decrypt and inspect
    let computedFields = null;

    for (const cb of callbacks) {
      const rawBody = cb.content ?? cb.body ?? JSON.stringify(cb);
      const decrypted = await decryptCallback(rawBody);

      if (decrypted.documentId) {
        console.log(`\n  Document callback (docId=${decrypted.documentId}, status=${decrypted.status})`);
      } else {
        console.log(`\n  Application callback (appId=${decrypted.applicationId}, status=${decrypted.status})`);
        // computedFields lives at ocrResult.computedFields.BANK_STATEMENT.data
        const cf = decrypted.ocrResult?.computedFields?.BANK_STATEMENT?.data;
        if (cf) computedFields = cf;
      }
    }

    // 6. Log full computedFields
    console.log('\n=== FULL computedFields ===');
    console.log(JSON.stringify(computedFields, null, 2));

    // 7. Assert
    console.log('\n=== ASSERTIONS ===');
    let allPassed = true;

    const val90 = computedFields?.gs_90days_consec_bankstatement;
    if (val90 === 1) {
      console.log(`  PASS  gs_90days_consec_bankstatement === 1  (actual: ${val90})`);
    } else {
      console.log(`  FAIL  gs_90days_consec_bankstatement === 1  (actual: ${JSON.stringify(val90)})`);
      allPassed = false;
    }

    const val180 = computedFields?.gs_180days_valid_bankstatement;
    if (val180 === 1) {
      console.log(`  PASS  gs_180days_valid_bankstatement === 1  (actual: ${val180})`);
    } else {
      console.log(`  FAIL  gs_180days_valid_bankstatement === 1  (actual: ${JSON.stringify(val180)})`);
      allPassed = false;
    }

    console.log(`\n${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);
    process.exit(allPassed ? 0 : 1);

  } finally {
    // Cleanup webhook token
    console.log(`\n-> Deleting webhook token ${webhookTokenId}...`);
    await axios.delete(`${WEBHOOK_SERVER_URL}/token/${webhookTokenId}`, {
      headers: { Authorization: `Bearer ${webhookIap}` }, validateStatus: () => true,
    }).catch(() => {});
    console.log('  Deleted');
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
