#!/usr/bin/env node
/**
 * One-shot probe: submit clean Blade Asia / Maria Garcia payslip batch through
 * the AI gateway, capture all 7 callbacks (6 doc + 1 app), dump their shape.
 *
 * Purpose: confirm app-level callback field shape for PS-FRAUD-CLEAN-001 spec.
 *
 * Suppression-fallback bypass: applicationId is NOT passed to
 * pollWebhookCallbacks — the hybrid fallback check (`&& applicationId`) is
 * falsy, so a missing app callback cannot be silently accepted as suppression.
 * If only 6 callbacks arrive within the 300s window this script exits non-zero.
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import {
  state,
  createApiClient,
  getWebhookIapToken,
  getWebhookBaseline,
  pollWebhookCallbacks,
  decryptCallback,
  WEBHOOK_SERVER_URL,
  GATEWAY_DOCTYPE_MAP,
  createWebhookToken,
  deleteWebhookToken,
} from './src/utils.mjs';

// ---------------------------------------------------------------------------

const FILES = [
  'gs://verifyiq-internal-testing/QA/Gcash/Payslip/Blade Asia_Maria Garcia Payslip_2026-01-15.pdf',
  'gs://verifyiq-internal-testing/QA/Gcash/Payslip/Blade Asia_Maria Garcia Payslip_2026-01-31.pdf',
  'gs://verifyiq-internal-testing/QA/Gcash/Payslip/Blade Asia_Maria Garcia Payslip_2026-02-15.pdf',
  'gs://verifyiq-internal-testing/QA/Gcash/Payslip/Blade Asia_Maria Garcia Payslip_2026-02-28.pdf',
  'gs://verifyiq-internal-testing/QA/Gcash/Payslip/Blade Asia_Maria Garcia Payslip_2026-03-15.pdf',
  'gs://verifyiq-internal-testing/QA/Gcash/Payslip/Blade Asia_Maria Garcia Payslip_2026-03-31.pdf',
];

const FIXTURE_ID     = 'PS-FRAUD-CLEAN-001';
const PREFIX         = 'payslip';
const EXPECTED_DOCS  = FILES.length;        // 6
const EXPECTED_TOTAL = FILES.length + 1;    // 7 (6 doc + 1 app)
const OUT_PATH       = 'probe-results/2026-05-24_PS-FRAUD-CLEAN-001.json';

// Fields the spec already knows about — anything beyond these gets flagged.
const KNOWN_APP_FIELDS = new Set(['applicationId', 'submissionId', 'publicUserId', 'status']);

// ---------------------------------------------------------------------------

function sep(label = '') {
  const line = '='.repeat(72);
  if (label) {
    console.log(`\n${line}`);
    console.log(`  ${label}`);
    console.log(line);
  } else {
    console.log(`\n${line}`);
  }
}

// ---------------------------------------------------------------------------

async function main() {
  sep('PROBE: PS-FRAUD-CLEAN-001');
  console.log(`  fixture:  ${FIXTURE_ID}`);
  console.log(`  files:    ${FILES.length}`);
  console.log(`  expected: ${EXPECTED_DOCS} doc + 1 app = ${EXPECTED_TOTAL} total`);
  console.log(`  output:   ${OUT_PATH}`);
  console.log(`  note:     applicationId OMITTED from pollWebhookCallbacks`);
  console.log(`            → hybrid suppression fallback disabled for this probe`);

  if (!WEBHOOK_SERVER_URL) {
    console.error('\nFATAL: WEBHOOK_SERVER_URL not set in .env');
    process.exit(1);
  }

  // -- Webhook token setup ----------------------------------------------------
  sep('Step 1 — Webhook setup');
  state.webhookTokenId = await createWebhookToken();

  let baselineCount;
  try {
    baselineCount = await getWebhookBaseline();
    console.log(`  Baseline callback count: ${baselineCount}`);
  } catch (err) {
    console.error(`  FATAL: baseline failed: ${err.message}`);
    await deleteWebhookToken(state.webhookTokenId);
    process.exit(1);
  }

  // -- Payload construction (mirrors validateFraudAiGenerated exactly) --------
  sep('Step 2 — Batch upload');
  const gatewayDocType = GATEWAY_DOCTYPE_MAP['Payslip'] || 'Payslip';
  const submissionId  = randomUUID();
  const publicUserId  = `probe-${FIXTURE_ID}-${Date.now()}`;

  const documents = FILES.map(file => ({
    documentId: randomUUID(),
    fileId: randomUUID(),
    documentClassification: 'PRIMARY',
    documentType: gatewayDocType,
    filename: file.split('/').pop(),
    preSignedUrl: file,
  }));

  const webhookIapHeader = { Authorization: `Bearer ${getWebhookIapToken()}` };
  const payload = {
    payload: { publicUserId, submissionId, documents },
    callbacks: {
      documentResult:   { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
      applicationResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
    },
  };

  console.log(`  publicUserId:  ${publicUserId}`);
  console.log(`  submissionId:  ${submissionId}`);
  console.log(`  documentType:  ${gatewayDocType}`);
  console.log(`  Posting to:    /ai-gateway/batch-upload`);

  const client = createApiClient(true);
  let batchStatus, batchBody;
  try {
    const res = await client.post('/ai-gateway/batch-upload', payload);
    batchStatus = res.status;
    batchBody   = res.data;
  } catch (err) {
    console.error(`  FATAL: POST error: ${err.message}`);
    await deleteWebhookToken(state.webhookTokenId);
    process.exit(1);
  }

  console.log(`  HTTP ${batchStatus}`);
  if (batchStatus !== 200 || !batchBody?.applicationId) {
    console.error(`  FATAL: unexpected response — ${JSON.stringify(batchBody).slice(0, 300)}`);
    await deleteWebhookToken(state.webhookTokenId);
    process.exit(1);
  }
  const applicationId = batchBody.applicationId;
  console.log(`  applicationId: ${applicationId}`);

  // -- Poll for callbacks — applicationId intentionally omitted ---------------
  sep('Step 3 — Polling (suppression fallback DISABLED)');
  console.log(`  Waiting for ${EXPECTED_TOTAL} callbacks (no suppression fallback)...`);
  console.log(`  Timeout: 300s`);

  let rawCallbacks;
  let timedOut = false;
  try {
    // applicationId param omitted → undefined → hybrid fallback check is falsy
    rawCallbacks = await pollWebhookCallbacks(baselineCount, EXPECTED_TOTAL, undefined);
    console.log(`  Received ${rawCallbacks.length} callbacks`);
  } catch (err) {
    // pollWebhookCallbacks throws on timeout
    timedOut = true;
    console.error(`\n!!! TIMEOUT: ${err.message}`);
    console.error('!!! App callback did not arrive within the poll window.');
    console.error('!!! This is a finding: PR #6 may be suppressing clean docs,');
    console.error('!!! or the app callback is delayed beyond 300s.');
    // Attempt a partial result dump before exiting
    rawCallbacks = [];
  }

  // -- Decrypt and classify ---------------------------------------------------
  sep('Step 4 — Callback classification');
  const docCallbacks = [];
  const appCallbacks = [];
  const decryptErrors = [];

  for (let i = 0; i < rawCallbacks.length; i++) {
    const cb = rawCallbacks[i];
    const rawBody = cb.content ?? cb.body ?? JSON.stringify(cb);
    let decrypted;
    try {
      decrypted = await decryptCallback(rawBody);
    } catch (err) {
      decryptErrors.push({ index: i, error: err.message });
      console.log(`  [${i}] DECRYPT FAILED: ${err.message}`);
      continue;
    }

    if (decrypted.documentId) {
      docCallbacks.push(decrypted);
      const fname = documents.find(d => d.documentId === decrypted.documentId)?.filename ?? decrypted.documentId;
      console.log(`  [${i}] DOC  — ${fname}`);
    } else {
      appCallbacks.push(decrypted);
      console.log(`  [${i}] APP  — appId=${decrypted.applicationId}, status=${decrypted.status}`);
    }
  }

  console.log(`\n  doc callbacks received:  ${docCallbacks.length} / ${EXPECTED_DOCS}`);
  console.log(`  app callbacks received:  ${appCallbacks.length} / 1`);
  if (decryptErrors.length) console.log(`  decrypt errors:          ${decryptErrors.length}`);

  // -- App callback dump ------------------------------------------------------
  sep('Step 5 — App callback shape (full)');
  if (appCallbacks.length === 0) {
    console.log('  *** NO APP CALLBACK RECEIVED ***');
    console.log('  Cannot dump shape — see timeout/missing finding above.');
  } else {
    const app = appCallbacks[0];
    console.log('\n  Full decrypted app callback:');
    console.log(JSON.stringify(app, null, 2));

    // Unknown keys
    const unknownKeys = Object.keys(app).filter(k => !KNOWN_APP_FIELDS.has(k));
    if (unknownKeys.length === 0) {
      console.log('\n  Unknown keys beyond spec (applicationId, submissionId, publicUserId, status): NONE');
    } else {
      console.log(`\n  *** UNKNOWN KEYS (not in spec): ${unknownKeys.join(', ')} ***`);
      for (const k of unknownKeys) {
        const val = app[k];
        const preview = typeof val === 'object' && val !== null
          ? JSON.stringify(val).slice(0, 200)
          : JSON.stringify(val);
        console.log(`    ${k}: ${preview}`);
      }
    }

    // submissionId / publicUserId echo check
    console.log('\n  Echo verification:');
    console.log(`    publicUserId sent: ${publicUserId}`);
    console.log(`    publicUserId got:  ${app.publicUserId}  ${app.publicUserId === publicUserId ? '✓' : '✗ MISMATCH'}`);
    console.log(`    submissionId sent: ${submissionId}`);
    console.log(`    submissionId got:  ${app.submissionId}  ${app.submissionId === submissionId ? '✓' : '✗ MISMATCH'}`);
  }

  // -- Doc callback fraud fields (representative: first doc) ------------------
  sep('Step 6 — Doc callback fraud fields (first doc)');
  if (docCallbacks.length === 0) {
    console.log('  *** NO DOC CALLBACKS RECEIVED ***');
  } else {
    const doc = docCallbacks[0];
    const fname = documents.find(d => d.documentId === doc.documentId)?.filename ?? doc.documentId;
    const ocrResult   = doc.ocrResult ?? {};
    const fraudChecks = ocrResult.fraudChecks ?? {};

    console.log(`  Representative doc: ${fname}`);
    console.log(`\n  ocrResult.fraudChecks:`);
    console.log(JSON.stringify(fraudChecks, null, 2));

    // Specific field checks against spec predictions
    const isFraud  = fraudChecks[`gs_isFraudulent_${PREFIX}`];
    const score    = fraudChecks[`gs_overallFraudScore_${PREFIX}`];
    const status   = fraudChecks[`gs_fraudCheckStatus_${PREFIX}`];
    const findings = Array.isArray(fraudChecks.fraudCheckFindings) ? fraudChecks.fraudCheckFindings : null;

    console.log('\n  Spec predictions vs actual:');
    console.log(`    gs_isFraudulent_${PREFIX}:      expected=0        actual=${JSON.stringify(isFraud)}     ${isFraud === 0 ? 'MATCH' : '*** MISMATCH ***'}`);
    console.log(`    gs_overallFraudScore_${PREFIX}: expected=100      actual=${JSON.stringify(score)}     ${score === 100 ? 'MATCH' : '*** MISMATCH — check scale ***'}`);
    console.log(`    gs_fraudCheckStatus_${PREFIX}:  expected="complete" actual=${JSON.stringify(status)}     ${status === 'complete' ? 'MATCH' : '*** MISMATCH ***'}`);
    console.log(`    fraudCheckFindings:          expected=[]       actual=${JSON.stringify(findings)}     ${Array.isArray(findings) && findings.length === 0 ? 'MATCH' : '*** MISMATCH ***'}`);

    // All doc callbacks: quick fraud field scan
    sep('Step 6b — All doc callbacks fraud field scan');
    for (const d of docCallbacks) {
      const fn  = documents.find(x => x.documentId === d.documentId)?.filename ?? d.documentId.slice(0, 8);
      const fc  = d.ocrResult?.fraudChecks ?? {};
      const isF = fc[`gs_isFraudulent_${PREFIX}`];
      const sc  = fc[`gs_overallFraudScore_${PREFIX}`];
      const st  = fc[`gs_fraudCheckStatus_${PREFIX}`];
      const ff  = Array.isArray(fc.fraudCheckFindings) ? fc.fraudCheckFindings.length : '?';
      const ok  = isF === 0 && sc === 100 && st === 'complete' && ff === 0;
      console.log(`  ${ok ? 'PASS' : 'FAIL'} ${fn}`);
      console.log(`       isFraudulent=${isF}  score=${sc}  status=${st}  findings=${ff}`);
    }
  }

  // -- Save full probe result -------------------------------------------------
  sep('Step 7 — Saving probe results');
  const probeResult = {
    probe:      FIXTURE_ID,
    timestamp:  new Date().toISOString(),
    applicationId,
    publicUserId,
    submissionId,
    timedOut,
    counts: {
      expected_doc: EXPECTED_DOCS,
      expected_app: 1,
      received_doc: docCallbacks.length,
      received_app: appCallbacks.length,
      decrypt_errors: decryptErrors.length,
    },
    appCallback:  appCallbacks[0] ?? null,
    docCallbacks: docCallbacks.map(d => ({
      documentId: d.documentId,
      filename: documents.find(x => x.documentId === d.documentId)?.filename ?? null,
      status: d.status,
      fraudChecks: d.ocrResult?.fraudChecks ?? null,
    })),
    decryptErrors,
  };

  try {
    mkdirSync('probe-results', { recursive: true });
    writeFileSync(OUT_PATH, JSON.stringify(probeResult, null, 2), 'utf8');
    console.log(`  Written: ${OUT_PATH}`);
  } catch (err) {
    console.error(`  WARNING: Could not write output file: ${err.message}`);
  }

  // -- Cleanup ----------------------------------------------------------------
  await deleteWebhookToken(state.webhookTokenId);

  // -- Final verdict ----------------------------------------------------------
  sep('VERDICT');
  const allDocsPassed = docCallbacks.length === EXPECTED_DOCS;
  const appArrived    = appCallbacks.length === 1;
  const overall       = !timedOut && allDocsPassed && appArrived;

  console.log(`  Doc callbacks:  ${docCallbacks.length}/${EXPECTED_DOCS}  ${allDocsPassed ? 'OK' : '*** MISSING ***'}`);
  console.log(`  App callback:   ${appCallbacks.length}/1              ${appArrived ? 'ARRIVED' : '*** MISSING — suppression triggered or delayed ***'}`);
  console.log(`  Timed out:      ${timedOut}`);
  console.log(`\n  ${overall ? 'PROBE PASS — all 7 callbacks received, ready to write fixture' : 'PROBE FAIL — see findings above before writing fixture'}`);

  if (!overall) process.exit(1);
}

main().catch(err => {
  console.error(`\nUnhandled error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
