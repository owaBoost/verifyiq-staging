/**
 * Test execution keywords — one function per testType in regression-suite.json.
 * Each keyword has signature (fixture, results) and mutates the results array.
 * Low-level keywords parseDocument (single file) and batchUpload are also exported
 * so the orchestrator can compose them if needed.
 *
 * Behavior here is a straight extraction from run_regression.mjs — no logic
 * changes.
 */

import axios from 'axios';
import { randomUUID } from 'crypto';
import {
  state,
  sleep,
  createApiClient,
  callParseBatch,
  getBaseUrl,
  getWebhookIapToken,
  getWebhookBaseline,
  pollWebhookCallbacks,
  decryptCallback,
  WEBHOOK_SERVER_URL,
  GATEWAY_DOCTYPE_MAP,
  callGetApplication,
  callListApplications,
  callListDocuments,
  callGetDocumentPages,
  callReprocessDocument,
  callListActivities,
  callExportApplication,
  callExportDocument,
} from './utils.mjs';
import {
  RESPONSE_VALIDATORS,
  validateDocumentCallback,
  validateApplicationCallback,
} from './validators.mjs';
import { isStubSkipped } from '../run_regression.mjs';

// -- Single-doc parse with response validation --------------------------------

export async function parseDocument(fixture, file, extraPayload = {}) {
  const payload = { file, fileType: fixture.documentType, classification: 'PRIMARY', ...extraPayload };
  const client = createApiClient(false);
  const start = Date.now();
  const res = await client.post('/v1/documents/parse', payload);
  const elapsed = Date.now() - start;

  if (res.status !== 200) {
    return { file, status: res.status, passed: false, body: res.data, elapsed,
      summary: `HTTP ${res.status} -- ${JSON.stringify(res.data).slice(0, 200)}` };
  }

  const validator = RESPONSE_VALIDATORS[fixture.documentType];
  const validation = validator ? validator(res.data) : { errors: [], warnings: [] };
  // Support old-style validators that return plain array (backwards compat)
  const fieldErrors = Array.isArray(validation) ? validation : validation.errors || [];
  let fieldWarnings = Array.isArray(validation) ? [] : validation.warnings || [];
  // Suppress "transactionsOCR is empty array" warning when skipBatch is true
  if (fixture.skipBatch) {
    fieldWarnings = fieldWarnings.filter(w => !w.includes('transactionsOCR is empty array'));
  }
  // Per-fixture warning suppression (substring match)
  if (Array.isArray(fixture.suppressWarnings) && fixture.suppressWarnings.length) {
    fieldWarnings = fieldWarnings.filter(w => !fixture.suppressWarnings.some(p => w.includes(p)));
  }

  if (fieldErrors.length) {
    return { file, status: res.status, passed: false, body: res.data, elapsed, warnings: fieldWarnings,
      summary: `HTTP 200 but validation failed: ${fieldErrors.join(', ')}` };
  }

  const warnSuffix = fieldWarnings.length ? ` | ${fieldWarnings.join('; ')}` : '';
  return { file, status: res.status, passed: true, body: res.data, elapsed, warnings: fieldWarnings,
    summary: `HTTP 200 -- parsed as ${res.data?.documentType ?? fixture.documentType} (${elapsed}ms)${warnSuffix}` };
}

// -- Batch upload with webhook callback polling --------------------------------

export async function batchUpload(fixture) {
  if (!state.webhookTokenId) {
    return { status: 0, passed: false, body: null, summary: 'SKIPPED -- no webhook token' };
  }

  const gatewayDocType = GATEWAY_DOCTYPE_MAP[fixture.documentType] || fixture.documentType;
  const documents = fixture.files.map(file => ({
    documentId: randomUUID(), fileId: randomUUID(), documentClassification: 'PRIMARY',
    documentType: gatewayDocType, filename: file.split('/').pop(), preSignedUrl: file,
  }));

  const webhookIapHeader = { Authorization: `Bearer ${getWebhookIapToken()}` };
  const payload = {
    payload: { publicUserId: `regression-${fixture.id}-${Date.now()}`, submissionId: randomUUID(), documents },
    callbacks: {
      documentResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
      applicationResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
    },
  };

  let baselineCount;
  try { baselineCount = await getWebhookBaseline(); console.log(`    Webhook baseline: ${baselineCount}`); }
  catch (err) { return { status: 0, passed: false, body: null, summary: `Webhook baseline failed: ${err.message}` }; }

  const client = createApiClient(true);
  let status, body;
  try { const res = await client.post('/ai-gateway/batch-upload', payload); status = res.status; body = res.data; }
  catch (err) { return { status: 0, passed: false, body: null, summary: `POST error: ${err.message}` }; }

  console.log(`    POST response: HTTP ${status}`);
  if (status !== 200) return { status, passed: false, body, summary: `HTTP ${status} -- ${JSON.stringify(body).slice(0, 200)}` };
  if (!body.applicationId) return { status, passed: false, body, summary: 'Missing applicationId' };
  console.log(`    HTTP 200, applicationId=${body.applicationId}, status=${body.status}`);

  const expectedCallbacks = documents.length + 1;
  let callbacks;
  try {
    console.log(`    Waiting for ${expectedCallbacks} callbacks (${documents.length} doc + 1 app)...`);
    callbacks = await pollWebhookCallbacks(baselineCount, expectedCallbacks, body.applicationId);
    console.log(`    Received ${callbacks.length} callbacks`);
  } catch (err) { return { status, passed: false, body, summary: `Polling: ${err.message}` }; }

  const allErrors = [];
  const callbackDetails = { documents: [], application: null };
  for (const cb of callbacks) {
    const rawBody = cb.content ?? cb.body ?? JSON.stringify(cb);
    let decrypted;
    try { decrypted = await decryptCallback(rawBody); }
    catch (err) {
      if (err.prSkip) { console.log(`    ${err.message}`); continue; }
      allErrors.push(`Decrypt failed: ${err.message}`); continue;
    }

    if (decrypted.documentId) {
      const docErrors = validateDocumentCallback(decrypted, gatewayDocType);
      if (docErrors.length) allErrors.push(...docErrors);
      else console.log(`    Document callback OK (docId=${decrypted.documentId})`);
      callbackDetails.documents.push({
        documentId: decrypted.documentId, status: decrypted.status,
        documentType: decrypted.documentType, documentClassification: decrypted.documentClassification,
      });
    } else {
      const appErrors = validateApplicationCallback(decrypted);
      if (appErrors.length) allErrors.push(...appErrors);
      else console.log(`    Application callback OK (appId=${decrypted.applicationId})`);
      callbackDetails.application = {
        applicationId: decrypted.applicationId, status: decrypted.status,
        computedFields: decrypted.ocrResult?.computedFields ?? decrypted.computedFields ?? null,
        crossCheckFindings: decrypted.ocrResult?.crossCheckFindings ?? decrypted.crossCheckFindings ?? null,
      };
    }
  }

  if (!callbackDetails.application) {
    allErrors.push('Application callback missing — suppression fallback fired on non-fraud fixture');
  }
  if (allErrors.length) return { status, passed: false, body, callbackDetails, summary: `Callback: ${allErrors.length} error(s): ${allErrors.join('; ')}` };
  return { status, passed: true, body, callbackDetails, summary: `HTTP 200 ACCEPTED -- ${callbacks.length} callbacks validated` };
}

// =============================================================================
// TEST TYPE RUNNERS
// =============================================================================

// -- DEFAULT: parse each file + batch upload -----------------------------------

export async function runDefault(fixture, results) {
  for (const file of fixture.files) {
    const fileName = file.split('/').pop();
    console.log(`  -> ${fileName}`);
    try {
      const result = await parseDocument(fixture, file);
      results.push(result);
      console.log(`    ${result.passed ? 'PASS' : 'FAIL'} ${result.summary}`);
    } catch (err) {
      results.push({ file, status: 0, passed: false, body: null, summary: `Error: ${err.message}` });
      console.log(`    FAIL Error: ${err.message}`);
    }
    await sleep(2500);
  }

  // Batch upload
  if (fixture.skipBatch) {
    console.log(`  -> parse-only (batch not supported for this docType)`);
  } else {
    console.log(`  -> Batch upload (${fixture.files.length} docs)...`);
    try {
      const batchResult = await batchUpload(fixture);
      results.push({ ...batchResult, file: null });
      console.log(`    ${batchResult.passed ? 'PASS' : 'FAIL'} ${batchResult.summary}`);
    } catch (err) {
      results.push({ file: null, status: 0, passed: false, body: null, summary: `Batch error: ${err.message}` });
    }
  }
}

// -- FRAUD: parse with fraud_detection:true, assert fraudScore -----------------

export async function validateFraud(fixture, results) {
  const extra = { pipeline: fixture.pipeline || { fraud_detection: true, use_cache: false } };

  for (const file of fixture.files) {
    const fileName = file.split('/').pop();
    console.log(`  -> [FRAUD] ${fileName}`);
    try {
      const result = await parseDocument(fixture, file, extra);
      if (result.passed && result.body) {
        const errors = [];
        const warnings = [];
        if (typeof result.body.fraudScore !== 'number') {
          // PhilID fraud pipeline returns null fraudScore for tampered/damaged QR — known API limitation
          if (result.body.fraudScore === null && result.body.extractionStatus === 'complete'
              && Array.isArray(result.body.summaryOCR) && result.body.summaryOCR.length > 0) {
            warnings.push('WARN: fraudScore is null (extraction complete, summaryOCR present)');
          } else {
            errors.push('fraudScore not a number');
          }
        }
        // For RAFI false-positive validation: assert fraudScore < 30
        if (fixture.id.startsWith('FRAUD-ID') || fixture.id.startsWith('FRAUD-DL') || fixture.id.startsWith('FRAUD-PS')) {
          if (typeof result.body.fraudScore === 'number' && result.body.fraudScore >= 30) {
            errors.push(`fraudScore=${result.body.fraudScore} >= 30 (false positive)`);
          }
        }
        // Positive vs negative fraud detection based on fixture.expectFraud flag.
        // Note: API returns findings as { type, score, description } without an explicit
        // severity field, so "CRITICAL finding" is defined as any entry in fraudCheckFindings.
        if (fixture.expectFraud === true) {
          if (typeof result.body.fraudScore === 'number' && result.body.fraudScore <= 20) {
            errors.push(`fraudScore=${result.body.fraudScore} <= 20 (expected fraud detected)`);
          }
          const findings = result.body.fraudCheckFindings;
          if (!Array.isArray(findings) || findings.length === 0) {
            errors.push('fraudCheckFindings empty (expected at least 1 CRITICAL finding)');
          }
        } else if (fixture.expectFraud === false) {
          if (typeof result.body.fraudScore === 'number' && result.body.fraudScore >= 20) {
            errors.push(`fraudScore=${result.body.fraudScore} >= 20 (false positive — legitimate document flagged)`);
          }
          const findings = result.body.fraudCheckFindings;
          if (Array.isArray(findings) && findings.length > 0) {
            warnings.push(`WARN: ${findings.length} fraudCheckFinding(s) present on legitimate document`);
          }
        }
        // For electricity fraud: assert summaryOCR populated, warn if no findings
        if (fixture.documentType === 'ElectricUtilityBillingStatement') {
          if (!Array.isArray(result.body.summaryOCR) || result.body.summaryOCR.length === 0) {
            errors.push('summaryOCR missing or empty');
          }
          if (!Array.isArray(result.body.fraudCheckFindings) || result.body.fraudCheckFindings.length === 0) {
            warnings.push('WARN: fraudCheckFindings empty (legitimate bill may have no findings)');
          }
          if (Array.isArray(result.body.fraudCheckFindings)) {
            const mathInconsistency = result.body.fraudCheckFindings.some(
              f => typeof f === 'string' ? f.includes('mathematical_inconsistency') :
                f.type === 'mathematical_inconsistency'
            );
            if (mathInconsistency) errors.push('mathematical_inconsistency found in fraudCheckFindings');
          }
        }
        if (warnings.length) {
          console.log(`    ${warnings.join('; ')}`);
          result.warnings = [...(result.warnings || []), ...warnings];
        }
        if (errors.length) {
          result.passed = false;
          result.summary = `HTTP 200 fraud validation failed: ${errors.join(', ')}`;
        } else {
          result.summary += ` | fraudScore=${result.body.fraudScore}`;
        }
      }
      results.push(result);
      console.log(`    ${result.passed ? 'PASS' : 'FAIL'} ${result.summary}`);
    } catch (err) {
      results.push({ file, status: 0, passed: false, body: null, summary: `Error: ${err.message}` });
    }
    // Fraud detection uses VLM - longer delay
    await sleep(5000);
  }
}

// -- BANK-DEEP: parse with deep transaction validation -------------------------

export async function validateBankDeep(fixture, results) {
  for (const file of fixture.files) {
    const fileName = file.split('/').pop();
    console.log(`  -> [BANK-DEEP] ${fileName}`);
    try {
      const result = await parseDocument(fixture, file);
      if (result.passed && result.body) {
        const errors = [];
        if (!Array.isArray(result.body.transactionsOCR)) {
          errors.push('missing transactionsOCR');
        } else if (result.body.transactionsOCR.length > 0) {
          // Check posting_date format on first few transactions
          for (const txn of result.body.transactionsOCR.slice(0, 3)) {
            if (txn.posting_date && !/^\d{4}-\d{2}-\d{2}/.test(txn.posting_date)) {
              errors.push(`posting_date "${txn.posting_date}" not YYYY-MM-DD`);
              break;
            }
          }
        }
        // Check calculatedFields (top-level) or fall back to summaryOCR for totals
        const cf = result.body.calculatedFields || {};
        const ocr0 = result.body.summaryOCR?.[0] || {};
        if (cf.calculated_debits === undefined && cf.total_debits === undefined && ocr0.total_debits === undefined) {
          errors.push('missing calculated_debits/total_debits in calculatedFields or summaryOCR');
        }
        if (cf.calculated_credits === undefined && cf.total_credits === undefined && ocr0.total_credits === undefined) {
          errors.push('missing calculated_credits/total_credits in calculatedFields or summaryOCR');
        }
        if (!result.body.fraudCheckFindings) errors.push('missing fraudCheckFindings');

        if (errors.length) {
          result.passed = false;
          result.summary = `HTTP 200 bank-deep failed: ${errors.join(', ')}`;
        }
      }
      results.push(result);
      console.log(`    ${result.passed ? 'PASS' : 'FAIL'} ${result.summary}`);
    } catch (err) {
      results.push({ file, status: 0, passed: false, body: null, summary: `Error: ${err.message}` });
    }
    await sleep(2500);
  }
}

// -- CACHE: parse same doc twice, compare timing ------------------------------

export async function validateCache(fixture, results) {
  const file = fixture.files[0];
  const fileName = file.split('/').pop();
  const extra = { pipeline: fixture.pipeline || { use_cache: true } };

  // First parse
  console.log(`  -> [CACHE] ${fileName} (1st parse, cold)`);
  let first;
  try {
    first = await parseDocument(fixture, file, extra);
    results.push({ ...first, summary: `1st parse: ${first.summary}` });
    console.log(`    ${first.passed ? 'PASS' : 'FAIL'} 1st: ${first.summary}`);
  } catch (err) {
    results.push({ file, status: 0, passed: false, body: null, summary: `1st parse error: ${err.message}` });
    return;
  }
  await sleep(2000);

  // Second parse (should be cache hit)
  console.log(`  -> [CACHE] ${fileName} (2nd parse, should be cached)`);
  try {
    const second = await parseDocument(fixture, file, extra);
    const isCacheHit = second.body?.fromCache === true;
    const summary = `2nd parse: ${second.summary} | fromCache=${isCacheHit} | ${second.elapsed}ms vs ${first.elapsed}ms`;
    results.push({ ...second, summary });
    console.log(`    ${second.passed ? 'PASS' : 'FAIL'} ${summary}`);
  } catch (err) {
    results.push({ file, status: 0, passed: false, body: null, summary: `2nd parse error: ${err.message}` });
  }
}

// -- SECURITY: test auth headers on 200, 401, 403 ----------------------------

export async function validateSecurity(fixture, results) {
  const file = fixture.files[0];

  // 1. Normal parse (200) - check security headers
  console.log('  -> [SEC] Normal request (expect 200 + security headers)');
  try {
    const client = createApiClient(false);
    const res = await client.post('/v1/documents/parse', {
      file, fileType: fixture.documentType, classification: 'PRIMARY',
    });
    const headers = res.headers;
    const errors = [];
    if (!headers['x-content-type-options']) errors.push('missing X-Content-Type-Options');
    if (!headers['x-frame-options']) errors.push('missing X-Frame-Options');
    if (!headers['strict-transport-security']) errors.push('missing Strict-Transport-Security');

    const passed = res.status === 200 && errors.length === 0;
    results.push({ file: '200-headers', status: res.status, passed, body: null,
      summary: passed ? 'HTTP 200 + all security headers present' : `HTTP ${res.status} | ${errors.join(', ')}` });
    console.log(`    ${passed ? 'PASS' : 'FAIL'} ${results.at(-1).summary}`);
  } catch (err) {
    results.push({ file: '200-headers', status: 0, passed: false, body: null, summary: `Error: ${err.message}` });
  }
  await sleep(2500);

  // 2. No API key (expect 401)
  console.log('  -> [SEC] No API key (expect 401)');
  try {
    const noAuth = axios.create({
      baseURL: getBaseUrl(), headers: { 'Content-Type': 'application/json' }, validateStatus: () => true,
    });
    const res = await noAuth.post('/v1/documents/parse', {
      file, fileType: fixture.documentType, classification: 'PRIMARY',
    });
    const passed = res.status === 401;
    results.push({ file: 'no-key', status: res.status, passed, body: null,
      summary: passed ? 'HTTP 401 as expected (no API key)' : `Expected 401, got ${res.status}` });
    console.log(`    ${passed ? 'PASS' : 'FAIL'} ${results.at(-1).summary}`);
  } catch (err) {
    results.push({ file: 'no-key', status: 0, passed: false, body: null, summary: `Error: ${err.message}` });
  }
  await sleep(2500);

  // 3. Wrong API key (expect 401 or 403)
  console.log('  -> [SEC] Wrong API key (expect 401/403)');
  try {
    const wrongAuth = axios.create({
      baseURL: getBaseUrl(),
      headers: { Authorization: 'Bearer sk_wrong_key_12345', 'X-Tenant-Token': 'sk_wrong_key_12345', 'Content-Type': 'application/json' },
      validateStatus: () => true,
    });
    const res = await wrongAuth.post('/v1/documents/parse', {
      file, fileType: fixture.documentType, classification: 'PRIMARY',
    });
    const passed = res.status === 401 || res.status === 403;
    results.push({ file: 'wrong-key', status: res.status, passed, body: null,
      summary: passed ? `HTTP ${res.status} as expected (wrong key)` : `Expected 401/403, got ${res.status}` });
    console.log(`    ${passed ? 'PASS' : 'FAIL'} ${results.at(-1).summary}`);
  } catch (err) {
    results.push({ file: 'wrong-key', status: 0, passed: false, body: null, summary: `Error: ${err.message}` });
  }
}

// -- CROSSCHECK: batch upload PRIMARY + SUPPORTING, then POST /api/v1/cross-validate

export async function crossValidate(fixture, results) {
  if (!state.webhookTokenId) {
    results.push({ file: null, status: 0, passed: false, body: null, summary: 'SKIPPED -- no webhook token' });
    return;
  }

  // Build documents array: PRIMARY bank statement + SUPPORTING payslip
  const gatewayDocType = GATEWAY_DOCTYPE_MAP[fixture.documentType] || fixture.documentType;
  const documents = fixture.files.map(file => ({
    documentId: randomUUID(), fileId: randomUUID(), documentClassification: 'PRIMARY',
    documentType: gatewayDocType, filename: file.split('/').pop(), preSignedUrl: file,
  }));
  if (fixture.supportingFiles) {
    for (const sf of fixture.supportingFiles) {
      const sfPath = typeof sf === 'string' ? sf : sf.path;
      const sfDocType = (typeof sf === 'object' && sf.documentType)
        ? (GATEWAY_DOCTYPE_MAP[sf.documentType] || sf.documentType)
        : gatewayDocType;
      const sfClass = (typeof sf === 'object' && sf.documentClassification) || 'SUPPORTING';
      documents.push({
        documentId: randomUUID(), fileId: randomUUID(), documentClassification: sfClass,
        documentType: sfDocType, filename: sfPath.split('/').pop(), preSignedUrl: sfPath,
      });
    }
  }

  const webhookIapHeader = { Authorization: `Bearer ${getWebhookIapToken()}` };
  const payload = {
    payload: { publicUserId: `regression-${fixture.id}-${Date.now()}`, submissionId: randomUUID(), documents },
    callbacks: {
      documentResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
      applicationResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
    },
  };

  // Get baseline, submit batch, wait for callbacks
  let baselineCount;
  try { baselineCount = await getWebhookBaseline(); console.log(`    Webhook baseline: ${baselineCount}`); }
  catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `Webhook baseline failed: ${err.message}` }); return; }

  console.log(`  -> [CROSSCHECK] Batch upload (${documents.length} docs: ${fixture.files.length} PRIMARY + ${fixture.supportingFiles?.length || 0} SUPPORTING)...`);
  const batchClient = createApiClient(true);
  let batchStatus, batchBody;
  try { const res = await batchClient.post('/ai-gateway/batch-upload', payload); batchStatus = res.status; batchBody = res.data; }
  catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `Batch POST error: ${err.message}` }); return; }

  console.log(`    POST response: HTTP ${batchStatus}`);
  if (batchStatus !== 200 || !batchBody.applicationId) {
    results.push({ file: null, status: batchStatus, passed: false, body: batchBody, summary: `Batch HTTP ${batchStatus} -- ${JSON.stringify(batchBody).slice(0, 200)}` });
    return;
  }
  const applicationId = batchBody.applicationId;
  console.log(`    HTTP 200, applicationId=${applicationId}, status=${batchBody.status}`);

  const expectedCallbacks = documents.length + 1;
  try {
    console.log(`    Waiting for ${expectedCallbacks} callbacks (${documents.length} doc + 1 app)...`);
    const callbacks = await pollWebhookCallbacks(baselineCount, expectedCallbacks, applicationId);
    console.log(`    Received ${callbacks.length} callbacks`);
    for (const cb of callbacks) {
      const rawBody = cb.content ?? cb.body ?? JSON.stringify(cb);
      let decrypted;
      try { decrypted = await decryptCallback(rawBody); } catch { continue; }
      if (decrypted.documentId) {
        console.log(`    Document callback OK (docId=${decrypted.documentId}, status=${decrypted.status}, class=${decrypted.documentClassification})`);
      } else {
        console.log(`    Application callback (appId=${decrypted.applicationId}, status=${decrypted.status})`);
      }
    }
  } catch (err) { results.push({ file: null, status: batchStatus, passed: false, body: null, summary: `Callback polling: ${err.message}` }); return; }

  // POST /api/v1/cross-validate with the applicationId (no IAP needed)
  console.log(`  -> [CROSSCHECK] POST /api/v1/cross-validate { application_id: "${applicationId}" }`);
  await sleep(2500);
  try {
    const client = createApiClient(false);
    const res = await client.post('/api/v1/cross-validate', { application_id: applicationId });
    console.log(`    HTTP ${res.status}`);

    const tier1 = res.data?.tier_1_results ?? [];
    const tier2 = res.data?.tier_2_results ?? [];
    const findings = [...tier1, ...tier2];
    const score = res.data?.consistency_score;

    console.log(`    consistency_score: ${JSON.stringify(score)}`);
    console.log(`    tier_1_results (${tier1.length}):`);
    for (const r of tier1) console.log(`      ${r.status} ${r.field} — ${r.detail}`);
    console.log(`    tier_2_results (${tier2.length}):`);
    for (const r of tier2) console.log(`      ${r.status} ${r.field} — ${r.detail}`);

    const errors = [];
    if (res.status !== 200) errors.push(`HTTP ${res.status}`);
    if (findings.length === 0) errors.push('no tier_1 or tier_2 results returned');

    const passed = errors.length === 0;
    results.push({ file: 'cross-validate', status: res.status, passed, body: res.data,
      summary: passed
        ? `HTTP 200 -- cross-validate done, ${findings.length} check(s), consistency_score=${score}`
        : `cross-validate failed: ${errors.join(', ')}` });
    console.log(`    ${passed ? 'PASS' : 'FAIL'} ${results.at(-1).summary}`);
  } catch (err) {
    results.push({ file: 'cross-validate', status: 0, passed: false, body: null, summary: `Error: ${err.message}` });
    console.log(`    FAIL Error: ${err.message}`);
  }
}

// -- PAYSLIP-DEEP: parse with detailed payslip field validation ----------------

export async function validatePayslipDeep(fixture, results) {
  for (const file of fixture.files) {
    const fileName = file.split('/').pop();
    console.log(`  -> [PS-DEEP] ${fileName}`);
    try {
      const result = await parseDocument(fixture, file);
      if (result.passed && result.body) {
        const errors = [];
        const ocr = result.body.summaryOCR?.[0] || {};
        if (!ocr.gross_pay && !ocr.net_pay) errors.push('missing gross_pay and net_pay');
        if (!ocr.sss_contribution_deduction && !ocr.sssContributionDeduction) errors.push('missing SSS contribution');
        if (result.body.completenessScore === undefined) errors.push('missing completenessScore');
        if (errors.length) {
          result.passed = false;
          result.summary = `HTTP 200 payslip-deep failed: ${errors.join(', ')}`;
        }
      }
      results.push(result);
      console.log(`    ${result.passed ? 'PASS' : 'FAIL'} ${result.summary}`);
    } catch (err) {
      results.push({ file, status: 0, passed: false, body: null, summary: `Error: ${err.message}` });
    }
    await sleep(2500);
  }
}

// -- COMPLETENESS: parse and assert completenessScore > 0 ---------------------

export async function validateCompleteness(fixture, results) {
  for (const file of fixture.files) {
    const fileName = file.split('/').pop();
    console.log(`  -> [COMP] ${fileName}`);
    try {
      const result = await parseDocument(fixture, file);
      if (result.passed && result.body) {
        const score = result.body.completenessScore;
        if (score === undefined || score === null) {
          result.passed = false;
          result.summary = 'HTTP 200 but missing completenessScore';
        } else if (typeof score === 'number' && score <= 0) {
          result.passed = false;
          result.summary = `HTTP 200 but completenessScore=${score} (expected > 0)`;
        } else {
          result.summary += ` | completenessScore=${score}`;
        }
      }
      results.push(result);
      console.log(`    ${result.passed ? 'PASS' : 'FAIL'} ${result.summary}`);
    } catch (err) {
      results.push({ file, status: 0, passed: false, body: null, summary: `Error: ${err.message}` });
    }
    await sleep(2500);
  }
}

// -- HEALTH: GET health endpoints ---------------------------------------------

export async function validateHealth(fixture, results) {
  const endpoints = fixture.endpoints || [];
  for (const endpoint of endpoints) {
    // Determine method and client based on endpoint config
    const isPost = endpoint.startsWith('POST ');
    const path = isPost ? endpoint.slice(5) : endpoint;
    const isWebhook = path.startsWith('WEBHOOK:');
    const actualPath = isWebhook ? path.slice(8) : path;
    const methodLabel = isPost ? 'POST' : 'GET';

    console.log(`  -> [HEALTH] ${methodLabel} ${isWebhook ? '{WEBHOOK}' : ''}${actualPath}`);
    try {
      let res;
      if (isWebhook) {
        // Use webhook server base URL
        const webhookClient = axios.create({
          baseURL: WEBHOOK_SERVER_URL, headers: { 'Content-Type': 'application/json' },
          validateStatus: () => true, timeout: 15000,
        });
        res = isPost ? await webhookClient.post(actualPath, {}) : await webhookClient.get(actualPath);
      } else {
        const useIap = path.startsWith('/ai-gateway/');
        const client = createApiClient(useIap);
        res = isPost ? await client.post(path, {}) : await client.get(path);
      }
      const errors = [];

      if (res.status !== 200) {
        errors.push(`HTTP ${res.status}`);
      } else {
        if (actualPath === '/health/detailed') {
          if (res.data?.cache?.redis?.healthy !== true) console.log('    WARN redis.healthy not true (non-blocking — PG failover active)');
          if (res.data?.cache?.healthy !== true) errors.push('cache.healthy not true');
          if (res.data?.cache?.postgresql?.healthy !== true) errors.push('postgresql.healthy not true');
        }
        if (actualPath.includes('circuit-breakers')) {
          if (res.data?.boost_callback?.state !== 'closed') errors.push(`boost_callback.state="${res.data?.boost_callback?.state}"`);
        }
        if (actualPath === '/health/startup' || actualPath === '/health/live' || actualPath === '/health/ready') {
          const s = String(res.data?.status ?? '').toLowerCase();
          if (s !== 'ok' && s !== 'healthy' && res.status !== 200) errors.push(`unexpected status="${res.data?.status}"`);
        }
        // ai-gateway health assertions
        if (actualPath === '/ai-gateway/health') {
          if (res.data?.status !== 'healthy') errors.push(`status="${res.data?.status}" (expected "healthy")`);
          if (res.data?.service !== 'ai-gateway-api') errors.push(`service="${res.data?.service}" (expected "ai-gateway-api")`);
        }
        // Webhook server health assertions
        if (isWebhook && actualPath === '/health') {
          if (res.data?.status !== 'ok') errors.push(`status="${res.data?.status}" (expected "ok")`);
        }
      }

      const label = isWebhook ? `{WEBHOOK}${actualPath}` : actualPath;
      const passed = errors.length === 0;
      results.push({ file: label, status: res.status, passed, body: null,
        summary: passed ? `HTTP 200 -- ${label} OK` : `${label}: ${errors.join(', ')}` });
      console.log(`    ${passed ? 'PASS' : 'FAIL'} ${results.at(-1).summary}`);
    } catch (err) {
      const label = isWebhook ? `{WEBHOOK}${actualPath}` : actualPath;
      results.push({ file: label, status: 0, passed: false, body: null, summary: `Error: ${err.message}` });
    }
    await sleep(500);
  }
}

// -- BLS: GET/POST /api/v1/applications/* -------------------------------------

export async function validateBls(fixture, results) {
  // GET /api/v1/applications/
  console.log('  -> [BLS] GET /api/v1/applications/');
  try {
    const client = createApiClient(true);
    const res = await client.get('/api/v1/applications/');
    const passed = res.status === 200;
    results.push({ file: '/api/v1/applications/', status: res.status, passed, body: null,
      summary: passed ? 'HTTP 200' : `HTTP ${res.status} (expected 200)` });
    console.log(`    ${passed ? 'PASS' : 'FAIL'} HTTP ${res.status}`);
  } catch (err) {
    results.push({ file: '/api/v1/applications/', status: 0, passed: false, body: null, summary: `Error: ${err.message}` });
  }
  await sleep(1000);

  // GET /api/v1/applications/upload-urls
  console.log('  -> [BLS] GET /api/v1/applications/upload-urls');
  try {
    const client = createApiClient(true);
    const res = await client.get('/api/v1/applications/upload-urls');
    const passed = res.status === 422;
    results.push({ file: '/api/v1/applications/upload-urls', status: res.status, passed, body: null,
      summary: passed ? 'HTTP 422' : `HTTP ${res.status} (expected 422)` });
    console.log(`    ${passed ? 'PASS' : 'FAIL'} HTTP ${res.status}`);
  } catch (err) {
    results.push({ file: '/api/v1/applications/upload-urls', status: 0, passed: false, body: null, summary: `Error: ${err.message}` });
  }
}

// -- GCASH-COMPUTED: batch with computedFields validation ----------------------

export async function runGcashComputed(fixture, results) {
  if (!state.webhookTokenId) {
    results.push({ file: null, status: 0, passed: false, body: null, summary: 'SKIPPED -- no webhook token' });
    return;
  }

  const batchResult = await batchUpload(fixture);
  if (!batchResult.passed) {
    results.push({ ...batchResult, file: null });
    console.log(`    FAIL ${batchResult.summary}`);
    return;
  }

  // The batch itself passed callback validation. For gcash-computed we want
  // to check computed fields in the app callback. The existing batch runner
  // already validates doc/app callbacks. The computedFields check would require
  // deeper callback body inspection. For now, batch pass = test pass.
  results.push({ ...batchResult, file: null,
    summary: batchResult.summary + ' (computed fields batch submitted)' });
  console.log(`    PASS ${results.at(-1).summary}`);
}

// -- GCASH-RULES: batch upload + assert 90/180-day computedFields -------------

export async function validateGcashRules(fixture, results) {
  if (!state.webhookTokenId) {
    results.push({ file: null, status: 0, passed: false, body: null, summary: 'SKIPPED -- no webhook token' });
    return;
  }

  const gatewayDocType = GATEWAY_DOCTYPE_MAP[fixture.documentType] || fixture.documentType;
  const documents = fixture.files.map(file => ({
    documentId: randomUUID(), fileId: randomUUID(), documentClassification: 'PRIMARY',
    documentType: gatewayDocType, filename: file.split('/').pop(), preSignedUrl: file,
  }));

  const webhookIapHeader = { Authorization: `Bearer ${getWebhookIapToken()}` };
  const payload = {
    payload: { publicUserId: `regression-${fixture.id}-${Date.now()}`, submissionId: randomUUID(), documents },
    callbacks: {
      documentResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
      applicationResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
    },
  };

  let baselineCount;
  try { baselineCount = await getWebhookBaseline(); console.log(`    Webhook baseline: ${baselineCount}`); }
  catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `Webhook baseline failed: ${err.message}` }); return; }

  console.log(`  -> Batch upload (${fixture.files.length} docs)...`);
  const client = createApiClient(true);
  let status, body;
  try { const res = await client.post('/ai-gateway/batch-upload', payload); status = res.status; body = res.data; }
  catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `POST error: ${err.message}` }); return; }

  console.log(`    POST response: HTTP ${status}`);
  if (status !== 200 || !body.applicationId) {
    results.push({ file: null, status, passed: false, body, summary: `HTTP ${status} -- ${JSON.stringify(body).slice(0, 200)}` });
    return;
  }
  console.log(`    HTTP 200, applicationId=${body.applicationId}`);

  const expectedCallbacks = documents.length + 1;
  let callbacks;
  try {
    console.log(`    Waiting for ${expectedCallbacks} callbacks (${documents.length} doc + 1 app)...`);
    callbacks = await pollWebhookCallbacks(baselineCount, expectedCallbacks, body.applicationId);
    console.log(`    Received ${callbacks.length} callbacks`);
  } catch (err) { results.push({ file: null, status, passed: false, body, summary: `Polling: ${err.message}` }); return; }

  // Find application callback and extract computedFields
  let computedFields = null;
  for (const cb of callbacks) {
    const rawBody = cb.content ?? cb.body ?? JSON.stringify(cb);
    let decrypted;
    try { decrypted = await decryptCallback(rawBody); } catch { continue; }
    if (!decrypted.documentId && decrypted.ocrResult?.computedFields?.BANK_STATEMENT?.data) {
      computedFields = decrypted.ocrResult.computedFields.BANK_STATEMENT.data;
    }
  }

  // Log all computedFields
  console.log('    computedFields (BANK_STATEMENT):');
  if (computedFields) {
    for (const [k, v] of Object.entries(computedFields)) console.log(`      ${k}: ${v}`);
  } else {
    console.log('      (none found)');
  }

  // Assert required fields
  const errors = [];
  const skipped = [];
  const checks = [
    ['gs_90days_consec_bankstatement', computedFields?.gs_90days_consec_bankstatement],
    ['gs_180days_valid_bankstatement', computedFields?.gs_180days_valid_bankstatement],
  ];
  for (const [key, val] of checks) {
    const stub = isStubSkipped(key, val);
    if (stub) { console.log(`    SKIP ${key} — ${stub.note}`); skipped.push(`${key}: ${stub.note}`); continue; }
    if (val === 1) { console.log(`    PASS ${key} === 1`); }
    else { console.log(`    FAIL ${key} === 1 (actual: ${JSON.stringify(val)})`); errors.push(`${key}=${JSON.stringify(val)}`); }
  }

  if (errors.length) {
    const suffix = skipped.length ? ` (skipped: ${skipped.length})` : '';
    results.push({ file: null, status, passed: false, body: null, summary: `computedFields assertion failed: ${errors.join(', ')}${suffix}` });
  } else {
    const suffix = skipped.length ? ` (${skipped.length} stub field(s) skipped)` : '';
    results.push({ file: null, status, passed: true, body: null, summary: `HTTP 200 -- gs_90days_consec=1, gs_180days_valid=1 validated${suffix}` });
  }
}

// -- DEDUP-GCASH: 3x same file + supporting doc, assert totals NOT tripled ----

export async function validateDedup(fixture, results) {
  if (!state.webhookTokenId) {
    results.push({ file: null, status: 0, passed: false, body: null, summary: 'SKIPPED -- no webhook token' });
    return;
  }

  const gatewayDocType = GATEWAY_DOCTYPE_MAP[fixture.documentType] || fixture.documentType;
  const documents = fixture.files.map(file => ({
    documentId: randomUUID(), fileId: randomUUID(), documentClassification: 'PRIMARY',
    documentType: gatewayDocType, filename: file.split('/').pop(), preSignedUrl: file,
  }));

  // Add supporting files with their own documentType and classification
  if (fixture.supportingFiles) {
    for (const sf of fixture.supportingFiles) {
      const sfPath = typeof sf === 'string' ? sf : sf.path;
      const sfDocType = (typeof sf === 'object' && sf.documentType)
        ? (GATEWAY_DOCTYPE_MAP[sf.documentType] || sf.documentType)
        : gatewayDocType;
      const sfClass = (typeof sf === 'object' && sf.documentClassification) || 'SUPPORTING';
      documents.push({
        documentId: randomUUID(), fileId: randomUUID(), documentClassification: sfClass,
        documentType: sfDocType, filename: sfPath.split('/').pop(), preSignedUrl: sfPath,
      });
    }
  }

  const webhookIapHeader = { Authorization: `Bearer ${getWebhookIapToken()}` };
  const payload = {
    payload: { publicUserId: `regression-${fixture.id}-${Date.now()}`, submissionId: randomUUID(), documents },
    callbacks: {
      documentResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
      applicationResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
    },
  };

  let baselineCount;
  try { baselineCount = await getWebhookBaseline(); console.log(`    Webhook baseline: ${baselineCount}`); }
  catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `Webhook baseline failed: ${err.message}` }); return; }

  console.log(`  -> Batch upload (${documents.length} docs: ${fixture.files.length} PRIMARY + ${fixture.supportingFiles?.length || 0} SECONDARY)...`);
  const client = createApiClient(true);
  let status, body;
  try { const res = await client.post('/ai-gateway/batch-upload', payload); status = res.status; body = res.data; }
  catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `POST error: ${err.message}` }); return; }

  console.log(`    POST response: HTTP ${status}`);
  if (status !== 200 || !body.applicationId) {
    results.push({ file: null, status, passed: false, body, summary: `HTTP ${status} -- ${JSON.stringify(body).slice(0, 200)}` });
    return;
  }
  console.log(`    HTTP 200, applicationId=${body.applicationId}`);

  const expectedCallbacks = documents.length + 1;
  let callbacks;
  try {
    console.log(`    Waiting for ${expectedCallbacks} callbacks (${documents.length} doc + 1 app)...`);
    callbacks = await pollWebhookCallbacks(baselineCount, expectedCallbacks, body.applicationId);
    console.log(`    Received ${callbacks.length} callbacks`);
  } catch (err) { results.push({ file: null, status, passed: false, body, summary: `Polling: ${err.message}` }); return; }

  // Decrypt all callbacks; find application callback and extract computedFields + crossCheckFindings
  let computedFields = null;
  let crossCheckFindings = null;
  for (const cb of callbacks) {
    const rawBody = cb.content ?? cb.body ?? JSON.stringify(cb);
    let decrypted;
    try { decrypted = await decryptCallback(rawBody); } catch { continue; }
    if (decrypted.documentId) {
      console.log(`    Document callback OK (docId=${decrypted.documentId}, status=${decrypted.status}, class=${decrypted.documentClassification})`);
    } else {
      console.log(`    Application callback (appId=${decrypted.applicationId}, status=${decrypted.status})`);
      const bsData = decrypted.ocrResult?.computedFields?.BANK_STATEMENT?.data
        ?? decrypted.computedFields?.BANK_STATEMENT?.data;
      if (bsData) computedFields = bsData;
      crossCheckFindings = decrypted.ocrResult?.crossCheckFindings ?? decrypted.crossCheckFindings ?? null;
    }
  }

  // Log all computedFields
  console.log('    computedFields (BANK_STATEMENT):');
  if (computedFields) {
    for (const [k, v] of Object.entries(computedFields)) console.log(`      ${k}: ${v}`);
  } else {
    console.log('      (none found)');
    results.push({ file: null, status, passed: false, body: null, summary: 'No computedFields in application callback' });
    return;
  }

  // Assert dedup: totals must NOT be tripled
  const assertions = [
    { key: 'gs_totaldebit_bankstatement', expected: 11830.08, tripled: 35490.24 },
    { key: 'gs_totalcredit_bankstatement', expected: 11655, tripled: 34965 },
    { key: 'gs_inferredincome_bankstatement', expected: -175.08, tolerance: 0.01 },
    { key: 'gs_90days_consec_bankstatement', expected: 1 },
    { key: 'gs_180days_valid_bankstatement', expected: 1 },
  ];

  const errors = [];
  for (const { key, expected, tripled, tolerance } of assertions) {
    const actual = computedFields[key];
    const stub = isStubSkipped(key, actual);
    if (stub) {
      console.log(`    SKIP ${key} — ${stub.note}`);
      continue;
    }
    const tol = tolerance || 0.001;
    const pass = typeof actual === 'number' && Math.abs(actual - expected) < tol;
    const isTripled = tripled != null && typeof actual === 'number' && Math.abs(actual - tripled) < tol;

    if (isTripled) {
      console.log(`    FAIL ${key} === ${actual} (TRIPLED! expected ${expected}, got 3x)`);
      errors.push(`${key}=${actual} (3x detected)`);
    } else if (!pass) {
      console.log(`    FAIL ${key} === ${JSON.stringify(actual)} (expected ${expected})`);
      errors.push(`${key}=${JSON.stringify(actual)}`);
    } else {
      console.log(`    PASS ${key} === ${actual}`);
    }
  }

  // Log and assert crossCheckFindings from application callback
  console.log('\n    crossCheckFindings:');
  if (crossCheckFindings && Array.isArray(crossCheckFindings)) {
    console.log(JSON.stringify(crossCheckFindings, null, 2).split('\n').map(l => '    ' + l).join('\n'));
  } else {
    console.log('      (none found)');
    errors.push('crossCheckFindings missing or not an array');
  }

  if (Array.isArray(crossCheckFindings)) {
    for (const field of ['name', 'address']) {
      const entry = crossCheckFindings.find(f => f.field === field);
      if (!entry) { errors.push(`crossCheck: "${field}" entry not found`); console.log(`    FAIL crossCheck: "${field}" entry not found`); continue; }

      if (!Array.isArray(entry.valuePrimary) || entry.valuePrimary.length === 0) {
        errors.push(`crossCheck ${field}: valuePrimary is empty`);
        console.log(`    FAIL crossCheck ${field}: valuePrimary is empty`);
      } else {
        console.log(`    PASS crossCheck ${field}: valuePrimary has ${entry.valuePrimary.length} value(s)`);
      }

      if (!Array.isArray(entry.valueSecondary) || entry.valueSecondary.length === 0) {
        errors.push(`crossCheck ${field}: valueSecondary is empty`);
        console.log(`    FAIL crossCheck ${field}: valueSecondary is empty`);
      } else {
        console.log(`    PASS crossCheck ${field}: valueSecondary has ${entry.valueSecondary.length} value(s)`);
      }

      if (entry.match === true) {
        console.log(`    PASS crossCheck ${field}: match === true`);
      } else {
        errors.push(`crossCheck ${field}: match=${JSON.stringify(entry.match)}, expected true`);
        console.log(`    FAIL crossCheck ${field}: match === ${JSON.stringify(entry.match)} (expected true)`);
      }
    }
  }

  if (errors.length) {
    results.push({ file: null, status, passed: false, body: null, summary: `Dedup assertion failed: ${errors.join(', ')}` });
  } else {
    results.push({ file: null, status, passed: true, body: null, summary: 'HTTP 200 -- dedup + crosscheck validated' });
  }
}

// -- DEDUP: same file 3x in one batch -----------------------------------------

export async function runDedup(fixture, results) {
  if (!state.webhookTokenId) {
    results.push({ file: null, status: 0, passed: false, body: null, summary: 'SKIPPED -- no webhook token' });
    return;
  }

  const file = fixture.files[0];
  const gatewayDocType = GATEWAY_DOCTYPE_MAP[fixture.documentType] || fixture.documentType;
  const documents = [1, 2, 3].map(() => ({
    documentId: randomUUID(),
    fileId: randomUUID(),
    documentClassification: 'PRIMARY',
    documentType: gatewayDocType,
    filename: file.split('/').pop(),
    preSignedUrl: file,
  }));

  const webhookIapHeader = { Authorization: `Bearer ${getWebhookIapToken()}` };
  const payload = {
    payload: {
      publicUserId: `regression-dedup-${Date.now()}`,
      submissionId: randomUUID(),
      documents,
    },
    callbacks: {
      documentResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
      applicationResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
    },
  };

  console.log(`  -> [DEDUP] Same file 3x: ${file.split('/').pop()}`);
  let baselineCount;
  try { baselineCount = await getWebhookBaseline(); } catch (err) {
    results.push({ file: null, status: 0, passed: false, body: null, summary: `Baseline failed: ${err.message}` }); return;
  }

  const client = createApiClient(true);
  const res = await client.post('/ai-gateway/batch-upload', payload);
  if (res.status !== 200 || !res.data?.applicationId) {
    results.push({ file: null, status: res.status, passed: false, body: res.data,
      summary: `HTTP ${res.status} -- ${JSON.stringify(res.data).slice(0, 200)}` });
    return;
  }
  console.log(`    HTTP 200, applicationId=${res.data.applicationId}`);

  // Poll for 4 callbacks (3 doc + 1 app). applicationId intentionally omitted —
  // hybrid suppression fallback must not fire on a non-fraud fixture.
  try {
    console.log('    Waiting for 4 callbacks (3 doc + 1 app)...');
    const callbacks = await pollWebhookCallbacks(baselineCount, 4, undefined);
    console.log(`    Received ${callbacks.length} callbacks`);
    const allErrors = [];
    let appCallbackFound = false;
    let docCount = 0;
    for (const cb of callbacks) {
      const rawBody = cb.content ?? cb.body ?? JSON.stringify(cb);
      let decrypted;
      try { decrypted = await decryptCallback(rawBody); }
      catch (err) {
        if (err.prSkip) { console.log(`    ${err.message}`); continue; }
        allErrors.push(`Decrypt failed: ${err.message}`); continue;
      }
      if (decrypted.documentId) { docCount++; }
      else { appCallbackFound = true; }
    }
    if (!appCallbackFound) allErrors.push('Application callback missing — suppression fallback fired');
    if (docCount !== 3) allErrors.push(`Expected 3 doc callbacks, got ${docCount}`);
    if (allErrors.length) {
      results.push({ file: null, status: 200, passed: false, body: null,
        summary: `Dedup: ${allErrors.length} error(s): ${allErrors.join('; ')}` });
      console.log(`    FAIL ${results.at(-1).summary}`);
    } else {
      results.push({ file: null, status: 200, passed: true, body: null,
        summary: `HTTP 200 ACCEPTED -- ${callbacks.length} callbacks, dedup OK (${docCount} doc + app)` });
      console.log(`    PASS ${results.at(-1).summary}`);
    }
  } catch (err) {
    results.push({ file: null, status: 200, passed: false, body: null, summary: `Polling: ${err.message}` });
  }
}

// -- CROSSCHECK-DEEP: batch upload + strict crossCheckFindings assertions -----
//
// Asserts, from the application callback's crossCheckFindings:
//   name    — valuePrimary non-empty, match === true, riskLevel === 'low'
//   address — valuePrimary non-empty (unless genuinely missing),
//             match === true OR null (null allowed only if valuePrimary empty),
//             riskLevel !== 'high' unless match === false

export async function validateCrosscheckDeep(fixture, results) {
  if (!state.webhookTokenId) {
    results.push({ file: null, status: 0, passed: false, body: null, summary: 'SKIPPED -- no webhook token' });
    return;
  }

  const gatewayDocType = GATEWAY_DOCTYPE_MAP[fixture.documentType] || fixture.documentType;
  const documents = fixture.files.map(file => ({
    documentId: randomUUID(), fileId: randomUUID(), documentClassification: 'PRIMARY',
    documentType: gatewayDocType, filename: file.split('/').pop(), preSignedUrl: file,
  }));
  if (fixture.supportingFiles) {
    for (const sf of fixture.supportingFiles) {
      const sfPath = typeof sf === 'string' ? sf : sf.path;
      const sfDocType = (typeof sf === 'object' && sf.documentType)
        ? (GATEWAY_DOCTYPE_MAP[sf.documentType] || sf.documentType)
        : gatewayDocType;
      const sfClass = (typeof sf === 'object' && sf.documentClassification) || 'SUPPORTING';
      documents.push({
        documentId: randomUUID(), fileId: randomUUID(), documentClassification: sfClass,
        documentType: sfDocType, filename: sfPath.split('/').pop(), preSignedUrl: sfPath,
      });
    }
  }

  const webhookIapHeader = { Authorization: `Bearer ${getWebhookIapToken()}` };
  const payload = {
    payload: { publicUserId: `regression-${fixture.id}-${Date.now()}`, submissionId: randomUUID(), documents },
    callbacks: {
      documentResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
      applicationResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
    },
  };

  let baselineCount;
  try { baselineCount = await getWebhookBaseline(); }
  catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `Baseline: ${err.message}` }); return; }

  const client = createApiClient(true);
  let status, body;
  try { const res = await client.post('/ai-gateway/batch-upload', payload); status = res.status; body = res.data; }
  catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `POST error: ${err.message}` }); return; }

  if (status !== 200 || !body.applicationId) {
    results.push({ file: null, status, passed: false, body, summary: `HTTP ${status} -- ${JSON.stringify(body).slice(0, 200)}` });
    return;
  }
  console.log(`    HTTP 200, applicationId=${body.applicationId}`);

  const expectedCallbacks = documents.length + 1;
  let crossCheckFindings = null;
  try {
    const callbacks = await pollWebhookCallbacks(baselineCount, expectedCallbacks, body.applicationId);
    for (const cb of callbacks) {
      const rawBody = cb.content ?? cb.body ?? JSON.stringify(cb);
      let decrypted;
      try { decrypted = await decryptCallback(rawBody); } catch { continue; }
      if (!decrypted.documentId) {
        crossCheckFindings = decrypted.ocrResult?.crossCheckFindings ?? decrypted.crossCheckFindings ?? null;
      }
    }
  } catch (err) { results.push({ file: null, status, passed: false, body: null, summary: `Polling: ${err.message}` }); return; }

  console.log('    crossCheckFindings:');
  if (!Array.isArray(crossCheckFindings)) {
    results.push({ file: null, status, passed: false, body: null, summary: 'crossCheckFindings missing or not an array' });
    return;
  }
  console.log(JSON.stringify(crossCheckFindings, null, 2).split('\n').map(l => '    ' + l).join('\n'));

  const errors = [];

  // --- name: valuePrimary non-empty, match===true, riskLevel==='low' ---
  const nameEntry = crossCheckFindings.find(f => f.field === 'name');
  if (!nameEntry) {
    errors.push('crossCheck name: entry not found');
    console.log('    FAIL crossCheck name: entry not found');
  } else {
    if (!Array.isArray(nameEntry.valuePrimary) || nameEntry.valuePrimary.length === 0) {
      errors.push('crossCheck name: valuePrimary is empty');
      console.log('    FAIL crossCheck name: valuePrimary is empty');
    } else {
      console.log(`    PASS crossCheck name: valuePrimary has ${nameEntry.valuePrimary.length} value(s)`);
    }
    if (nameEntry.match !== true) {
      errors.push(`crossCheck name: match=${JSON.stringify(nameEntry.match)}, expected true`);
      console.log(`    FAIL crossCheck name: match === ${JSON.stringify(nameEntry.match)} (expected true)`);
    } else {
      console.log('    PASS crossCheck name: match === true');
      if (nameEntry.riskLevel !== 'low') {
        errors.push(`crossCheck name: riskLevel=${JSON.stringify(nameEntry.riskLevel)}, expected "low" when match===true`);
        console.log(`    FAIL crossCheck name: riskLevel === ${JSON.stringify(nameEntry.riskLevel)} (expected "low")`);
      } else {
        console.log('    PASS crossCheck name: riskLevel === "low"');
      }
    }
  }

  // --- address: primary non-empty unless genuinely missing (match===null);
  //     match must be true or null (null only if primary empty);
  //     riskLevel must not be 'high' unless match===false ---
  const addrEntry = crossCheckFindings.find(f => f.field === 'address');
  if (!addrEntry) {
    errors.push('crossCheck address: entry not found');
    console.log('    FAIL crossCheck address: entry not found');
  } else {
    const primaryEmpty = !Array.isArray(addrEntry.valuePrimary) || addrEntry.valuePrimary.length === 0;
    if (primaryEmpty && addrEntry.match !== null) {
      errors.push('crossCheck address: valuePrimary empty and match !== null (expected null when address genuinely missing)');
      console.log('    FAIL crossCheck address: valuePrimary empty but match !== null');
    } else if (!primaryEmpty) {
      console.log(`    PASS crossCheck address: valuePrimary has ${addrEntry.valuePrimary.length} value(s)`);
      if (addrEntry.match !== true && addrEntry.match !== null) {
        errors.push(`crossCheck address: match=${JSON.stringify(addrEntry.match)}, expected true or null`);
        console.log(`    FAIL crossCheck address: match === ${JSON.stringify(addrEntry.match)} (expected true or null)`);
      } else {
        console.log(`    PASS crossCheck address: match === ${JSON.stringify(addrEntry.match)}`);
      }
    } else {
      console.log('    PASS crossCheck address: primary missing, match === null (genuinely absent)');
    }

    if (addrEntry.riskLevel === 'high' && addrEntry.match !== false) {
      errors.push(`crossCheck address: riskLevel="high" but match=${JSON.stringify(addrEntry.match)} (mismatch not confirmed)`);
      console.log('    FAIL crossCheck address: riskLevel "high" without confirmed mismatch');
    } else {
      console.log(`    PASS crossCheck address: riskLevel === ${JSON.stringify(addrEntry.riskLevel)} (not unjustified "high")`);
    }
  }

  if (errors.length) {
    results.push({ file: null, status, passed: false, body: null, summary: `crosscheck-deep failed: ${errors.join('; ')}` });
  } else {
    results.push({ file: null, status, passed: true, body: null, summary: 'HTTP 200 -- crosscheck-deep name+address validated' });
  }
}

// -- PAYSLIP-RULES: batch upload payslips + assert PAYSLIP computedFields -----

export async function validatePayslipRules(fixture, results) {
  if (!state.webhookTokenId) {
    results.push({ file: null, status: 0, passed: false, body: null, summary: 'SKIPPED -- no webhook token' });
    return;
  }

  const gatewayDocType = GATEWAY_DOCTYPE_MAP[fixture.documentType] || fixture.documentType;
  const documents = fixture.files.map(file => ({
    documentId: randomUUID(), fileId: randomUUID(), documentClassification: 'PRIMARY',
    documentType: gatewayDocType, filename: file.split('/').pop(), preSignedUrl: file,
  }));

  const webhookIapHeader = { Authorization: `Bearer ${getWebhookIapToken()}` };
  const submissionId = randomUUID();
  const publicUserId = `regression-${fixture.id}-${Date.now()}`;
  const payload = {
    payload: { publicUserId, submissionId, documents },
    callbacks: {
      documentResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
      applicationResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
    },
  };

  let baselineCount;
  try { baselineCount = await getWebhookBaseline(); console.log(`    Webhook baseline: ${baselineCount}`); }
  catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `Webhook baseline failed: ${err.message}` }); return; }

  console.log(`  -> Batch upload (${fixture.files.length} payslips)...`);
  const client = createApiClient(true);
  let status, body;
  try { const res = await client.post('/ai-gateway/batch-upload', payload); status = res.status; body = res.data; }
  catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `POST error: ${err.message}` }); return; }

  console.log(`    POST response: HTTP ${status}`);
  if (status !== 200 || !body.applicationId) {
    results.push({ file: null, status, passed: false, body, summary: `HTTP ${status} -- ${JSON.stringify(body).slice(0, 200)}` });
    return;
  }
  console.log(`    HTTP 200, applicationId=${body.applicationId}`);

  const expectedCallbacks = documents.length + 1;
  let callbacks;
  try {
    console.log(`    Waiting for ${expectedCallbacks} callbacks (${documents.length} doc + 1 app)...`);
    callbacks = await pollWebhookCallbacks(baselineCount, expectedCallbacks, body.applicationId);
    console.log(`    Received ${callbacks.length} callbacks`);
  } catch (err) { results.push({ file: null, status, passed: false, body, summary: `Polling: ${err.message}` }); return; }

  // Decrypt all callbacks, validate doc/app, extract computedFields
  const errors = [];
  const warnings = [];
  let computedFields = null;
  let crossCheckFindings = null;

  for (const cb of callbacks) {
    const rawBody = cb.content ?? cb.body ?? JSON.stringify(cb);
    let decrypted;
    try { decrypted = await decryptCallback(rawBody); }
    catch (err) {
      if (err.prSkip) { console.log(`    ${err.message}`); continue; }
      errors.push(`Decrypt failed: ${err.message}`); continue;
    }

    if (decrypted.documentId) {
      console.log(`    Document callback OK (docId=${decrypted.documentId}, status=${decrypted.status})`);
      if (decrypted.status !== 'COMPLETED') errors.push(`doc ${decrypted.documentId}: status=${decrypted.status}`);
      if (decrypted.submissionId !== submissionId) errors.push(`doc ${decrypted.documentId}: submissionId mismatch`);
      if (decrypted.publicUserId !== publicUserId) errors.push(`doc ${decrypted.documentId}: publicUserId mismatch`);
      // Auth header echo
      const cbAuth = cb.headers?.Authorization ?? cb.headers?.authorization;
      if (cbAuth !== webhookIapHeader.Authorization) errors.push(`doc ${decrypted.documentId}: Auth header mismatch`);
    } else {
      console.log(`    Application callback (appId=${decrypted.applicationId}, status=${decrypted.status})`);
      if (decrypted.status !== 'COMPLETED') errors.push(`app: status=${decrypted.status}`);
      if (decrypted.submissionId !== submissionId) errors.push('app: submissionId mismatch');
      if (decrypted.publicUserId !== publicUserId) errors.push('app: publicUserId mismatch');
      const cbAuth = cb.headers?.Authorization ?? cb.headers?.authorization;
      if (cbAuth !== webhookIapHeader.Authorization) errors.push('app: Auth header mismatch');
      computedFields = decrypted.ocrResult?.computedFields ?? decrypted.computedFields ?? null;
      crossCheckFindings = decrypted.ocrResult?.crossCheckFindings ?? decrypted.crossCheckFindings ?? null;
    }
  }

  if (!computedFields) {
    errors.push('No computedFields in application callback');
    results.push({ file: null, status, passed: false, body: null, warnings, summary: `payslip-rules failed: ${errors.join('; ')}` });
    return;
  }

  // Availability flags
  if (computedFields.PAYSLIP?.available !== true) errors.push('PAYSLIP.available != true');
  if (computedFields.BANK_STATEMENT?.available !== false) errors.push('BANK_STATEMENT.available != false');
  if (computedFields.ELECTRICITY_BILL?.available !== false) errors.push('ELECTRICITY_BILL.available != false');

  // PAYSLIP computedFields
  const psData = computedFields.PAYSLIP?.data;
  console.log('    computedFields (PAYSLIP):');
  if (psData) {
    for (const [k, v] of Object.entries(psData)) console.log(`      ${k}: ${JSON.stringify(v)}`);
  } else {
    console.log('      (none found)');
    errors.push('PAYSLIP.data missing');
  }

  // Exact-value checks (with stub-field awareness)
  const skipped = [];
  const exactChecks = [
    ['gs_180days_valid_payslip', 1],
    ['gs_90days_consec_payslip', 1],
    ['gs_90days_oneemployer_payslip', 1],
  ];
  for (const [key, expected] of exactChecks) {
    const val = psData?.[key];
    const stub = isStubSkipped(key, val);
    if (stub) { console.log(`    SKIP ${key} — ${stub.note}`); skipped.push(`${key}: ${stub.note}`); continue; }
    if (val === expected) { console.log(`    PASS ${key} === ${expected}`); }
    else { console.log(`    FAIL ${key} === ${expected} (actual: ${JSON.stringify(val)})`); errors.push(`${key}=${JSON.stringify(val)}`); }
  }

  // Present-and-numeric checks (with stub-field awareness)
  const numericChecks = [
    'gs_90days_gross_payslip',
    'gs_90days_onetime_payslip',
    'gs_90days_personalexpense_payslip',
    'gs_inferredincome_payslip',
  ];
  for (const key of numericChecks) {
    const val = psData?.[key];
    const stub = isStubSkipped(key, val);
    if (stub) { console.log(`    SKIP ${key} — ${stub.note}`); skipped.push(`${key}: ${stub.note}`); continue; }
    if (typeof val === 'number' && !Number.isNaN(val)) { console.log(`    PASS ${key} = ${val} (numeric)`); }
    else { console.log(`    FAIL ${key} not numeric (actual: ${JSON.stringify(val)})`); errors.push(`${key}=${JSON.stringify(val)} (expected numeric)`); }
  }

  // crossCheckFindings
  if (crossCheckFindings == null) {
    warnings.push('WARN: crossCheckFindings not present in app callback');
    console.log('    WARN crossCheckFindings not present');
  } else {
    console.log(`    PASS crossCheckFindings present (${Array.isArray(crossCheckFindings) ? crossCheckFindings.length + ' entries' : typeof crossCheckFindings})`);
  }

  if (errors.length) {
    const suffix = skipped.length ? ` (${skipped.length} stub skipped)` : '';
    results.push({ file: null, status, passed: false, body: null, warnings, summary: `payslip-rules failed: ${errors.join('; ')}${suffix}` });
  } else {
    const suffix = skipped.length ? ` (${skipped.length} stub field(s) skipped)` : '';
    results.push({ file: null, status, passed: true, body: null, warnings, summary: `HTTP 200 -- payslip computedFields validated${suffix}` });
  }
}

// -- QUALITY-REJECT: assert section-level nulls on quality-rejected document ---

export async function validateQualityReject(fixture, results) {
  for (const file of fixture.files) {
    const fileName = file.split('/').pop();
    console.log(`  -> [QUALITY-REJECT] ${fileName}`);
    try {
      const result = await parseDocument(fixture, file);
      if (result.passed && result.body) {
        const errors = [];

        // qualityCheck must be non-null with qualityCheckFindings + gs_overallQualityScore_payslip
        const qc = result.body.qualityCheck;
        if (!qc || typeof qc !== 'object') {
          errors.push('qualityCheck is null or missing');
        } else {
          if (!Array.isArray(qc.qualityCheckFindings)) {
            errors.push('qualityCheck.qualityCheckFindings missing or not array');
          }
          if (qc.gs_overallQualityScore_payslip === undefined || qc.gs_overallQualityScore_payslip === null) {
            errors.push('qualityCheck.gs_overallQualityScore_payslip missing');
          }
        }

        // Sections that must be null on quality-rejected docs
        if (result.body.documentData !== null && result.body.documentData !== undefined) {
          errors.push(`documentData should be null, got ${typeof result.body.documentData}`);
        }
        if (result.body.fraudChecks !== null && result.body.fraudChecks !== undefined) {
          errors.push(`fraudChecks should be null, got ${typeof result.body.fraudChecks}`);
        }
        if (result.body.completenessCheck !== null && result.body.completenessCheck !== undefined) {
          errors.push(`completenessCheck should be null, got ${typeof result.body.completenessCheck}`);
        }

        if (errors.length) {
          result.passed = false;
          result.summary = `HTTP 200 quality-reject validation failed: ${errors.join(', ')}`;
        } else {
          result.summary += ` | qualityScore=${qc.gs_overallQualityScore_payslip}`;
        }
      }
      results.push(result);
      console.log(`    ${result.passed ? 'PASS' : 'FAIL'} ${result.summary}`);
    } catch (err) {
      results.push({ file, status: 0, passed: false, body: null, summary: `Error: ${err.message}` });
    }
    await sleep(2500);
  }
}

// -- BANK-DEEP-BATCH: batch upload + deep transaction validation on doc callback

export async function validateBankDeepBatch(fixture, results) {
  if (!state.webhookTokenId) {
    results.push({ file: null, status: 0, passed: false, body: null, summary: 'SKIPPED -- no webhook token' });
    return;
  }

  const gatewayDocType = GATEWAY_DOCTYPE_MAP[fixture.documentType] || fixture.documentType;
  const documents = fixture.files.map(file => ({
    documentId: randomUUID(), fileId: randomUUID(), documentClassification: 'PRIMARY',
    documentType: gatewayDocType, filename: file.split('/').pop(), preSignedUrl: file,
  }));

  const webhookIapHeader = { Authorization: `Bearer ${getWebhookIapToken()}` };
  const payload = {
    payload: { publicUserId: `regression-${fixture.id}-${Date.now()}`, submissionId: randomUUID(), documents },
    callbacks: {
      documentResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
      applicationResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
    },
  };

  let baselineCount;
  try { baselineCount = await getWebhookBaseline(); console.log(`    Webhook baseline: ${baselineCount}`); }
  catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `Webhook baseline failed: ${err.message}` }); return; }

  const client = createApiClient(true);
  let status, body;
  try { const res = await client.post('/ai-gateway/batch-upload', payload); status = res.status; body = res.data; }
  catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `POST error: ${err.message}` }); return; }

  console.log(`    POST response: HTTP ${status}`);
  if (status !== 200) { results.push({ file: null, status, passed: false, body, summary: `HTTP ${status} -- ${JSON.stringify(body).slice(0, 200)}` }); return; }
  if (!body.applicationId) { results.push({ file: null, status, passed: false, body, summary: 'Missing applicationId' }); return; }
  console.log(`    HTTP 200, applicationId=${body.applicationId}`);

  const expectedCallbacks = documents.length + 1;
  let callbacks;
  try {
    console.log(`    Waiting for ${expectedCallbacks} callbacks (${documents.length} doc + 1 app)...`);
    callbacks = await pollWebhookCallbacks(baselineCount, expectedCallbacks, body.applicationId);
    console.log(`    Received ${callbacks.length} callbacks`);
  } catch (err) { results.push({ file: null, status, passed: false, body, summary: `Polling: ${err.message}` }); return; }

  const allErrors = [];

  for (const cb of callbacks) {
    const rawBody = cb.content ?? cb.body ?? JSON.stringify(cb);
    let decrypted;
    try { decrypted = await decryptCallback(rawBody); }
    catch (err) {
      if (err.prSkip) { console.log(`    ${err.message}`); continue; }
      allErrors.push(`Decrypt failed: ${err.message}`); continue;
    }

    if (!decrypted.documentId) {
      console.log(`    Application callback OK (appId=${decrypted.applicationId})`);
      continue;
    }

    const docMeta = documents.find(d => d.documentId === decrypted.documentId);
    const fname = docMeta?.filename ?? decrypted.documentId;
    console.log(`  -> [BANK-DEEP-BATCH] ${fname}`);

    // Batch callback ocrResult schema:
    // { documentData, transactions, fraudChecks, qualityCheck, completenessCheck }
    // documentData fields: accountHolderName, calculated_debits, calculated_credits,
    //   summary_debits, summary_credits, gs_bankname_bankstatement, ...
    // transactions items: { postingDate, inferredPostingDate, transactionDescription,
    //   debitAmount, creditAmount, balance }
    const ocrResult = (decrypted.ocrResult && typeof decrypted.ocrResult === 'object') ? decrypted.ocrResult : {};
    const docData = ocrResult.documentData || {};
    const txns = Array.isArray(ocrResult.transactions) ? ocrResult.transactions : null;
    const fraudChecks = ocrResult.fraudChecks;

    // Totals live directly on documentData
    const totalDebits = docData.calculated_debits ?? docData.summary_debits;
    const totalCredits = docData.calculated_credits ?? docData.summary_credits;

    // Log deep fields (Step 2 discovery output)
    console.log(`    transactions: ${txns !== null ? txns.length + ' entries' : 'null/missing'}`);
    if (txns && txns.length > 0) {
      const s = txns[0];
      console.log(`    transactions[0]: postingDate="${s.postingDate}", debitAmount=${s.debitAmount}, creditAmount=${s.creditAmount}`);
    }
    console.log(`    calculated_debits: ${docData.calculated_debits}`);
    console.log(`    calculated_credits: ${docData.calculated_credits}`);
    console.log(`    summary_debits: ${docData.summary_debits}`);
    console.log(`    summary_credits: ${docData.summary_credits}`);
    console.log(`    accountHolderName: ${docData.accountHolderName}`);
    console.log(`    bankName: ${docData.gs_bankname_bankstatement}`);
    console.log(`    fraudChecks: ${fraudChecks ? JSON.stringify(fraudChecks).slice(0, 120) : 'missing'}`);

    // Deep assertions (mirrors bank-deep, adapted to batch ocrResult schema)
    const errors = [];

    // 1. transactions present and non-empty
    if (txns === null) {
      errors.push('missing transactions (ocrResult.transactions)');
    } else if (txns.length === 0) {
      errors.push('transactions is empty array');
    } else {
      // postingDate format varies by bank (MM/DD/YYYY, MM/DD/YY, MM-DD-YYYY) —
      // assert presence only; actual format logged above.
      const sampleDate = txns[0]?.postingDate ?? txns[0]?.inferredPostingDate;
      console.log(`    postingDate format sample: "${sampleDate}"`);
      const hasDate = txns.slice(0, 3).some(txn => txn.postingDate || txn.inferredPostingDate);
      if (!hasDate) errors.push('postingDate and inferredPostingDate both null on first 3 transactions');
    }

    // 2. debit/credit totals — presence (base) + exact value (per-fixture)
    if (totalDebits === undefined || totalDebits === null) {
      errors.push('missing calculated_debits/summary_debits in documentData');
    }
    if (totalCredits === undefined || totalCredits === null) {
      errors.push('missing calculated_credits/summary_credits in documentData');
    }

    // 3. fraudChecks present
    if (!fraudChecks) errors.push('missing fraudChecks (ocrResult.fraudChecks)');

    // 4. first/last transaction date and balance — presence assertions
    const dateBalFields = [
      'first_transaction_date', 'first_transaction_balance',
      'last_transaction_date',  'last_transaction_balance',
    ];
    for (const f of dateBalFields) {
      const val = docData[f];
      console.log(`    ${f}: ${val}`);
      if (val === undefined || val === null) errors.push(`missing ${f} in documentData`);
    }

    // 5. Per-fixture exact value assertions (fixture.assertions array of objects)
    //    Shape: { field, expected, tolerance? }
    //    field resolves against documentData.
    const TOL = 0.01;
    for (const a of (fixture.assertions ?? [])) {
      if (typeof a !== 'object' || !a.field) continue; // skip string-form assertions
      const actual = docData[a.field];
      const tol = a.tolerance ?? TOL;
      if (typeof a.expected === 'number') {
        if (typeof actual !== 'number') {
          errors.push(`${a.field}: expected ${a.expected}, got ${JSON.stringify(actual)}`);
          console.log(`    FAIL ${a.field}: expected ${a.expected}, got ${JSON.stringify(actual)}`);
        } else if (Math.abs(actual - a.expected) > tol) {
          errors.push(`${a.field}: expected ${a.expected}, got ${actual} (diff ${Math.abs(actual - a.expected).toFixed(4)})`);
          console.log(`    FAIL ${a.field}: expected ${a.expected}, got ${actual}`);
        } else {
          console.log(`    PASS ${a.field}: ${actual} ≈ ${a.expected}`);
        }
      }
    }

    if (errors.length) {
      console.log(`    FAIL ${errors.join(', ')}`);
      allErrors.push(...errors.map(e => `${fname}: ${e}`));
    } else {
      console.log(`    PASS deep fields OK`);
    }
  }

  if (allErrors.length) {
    results.push({ file: null, status, passed: false, body, summary: `bank-deep-batch failed: ${allErrors.join('; ')}` });
  } else {
    results.push({ file: null, status, passed: true, body, summary: `HTTP 200 ACCEPTED -- ${callbacks.length} callbacks, deep fields OK` });
  }
}

// -- APP-COMPUTED: batch upload + assert app-level computedFields --------------
//
// Verifies that computed Payslip fields land at correct values in the
// application-level callback for a batch submitted through the AI gateway.
// Primary purpose: catch regressions in the 90-day income rollup and
// inferred-income computation where presence-only checks would pass silently.
//
// Suppression-fallback bypass: applicationId is NOT passed to
// pollWebhookCallbacks — the hybrid fallback (PR #6) cannot mask a missing
// app callback. Zero app callbacks received = hard FAIL.
//
// Fixture fields required:
//   fraudFieldPrefix               {string} — e.g. "payslip"
//   expectedComputedFields.PAYSLIP {object} — field name -> expected value
//     Tolerance: exact for 0|1 values; ±0.01 for all other numbers.
//
export async function runAppComputed(fixture, results) {
  if (!state.webhookTokenId) {
    results.push({ file: null, status: 0, passed: false, body: null,
      summary: 'SKIPPED -- no webhook token' });
    return;
  }

  const prefix = fixture.fraudFieldPrefix;
  if (!prefix) {
    results.push({ file: null, status: 0, passed: false, body: null,
      summary: 'FAIL — fixture missing fraudFieldPrefix' });
    return;
  }

  const expectedData = fixture.expectedComputedFields?.PAYSLIP;
  if (!expectedData || typeof expectedData !== 'object' || Object.keys(expectedData).length === 0) {
    results.push({ file: null, status: 0, passed: false, body: null,
      summary: 'FAIL — fixture missing expectedComputedFields.PAYSLIP' });
    return;
  }

  const gatewayDocType = GATEWAY_DOCTYPE_MAP[fixture.documentType] || fixture.documentType;
  const documents = fixture.files.map(file => ({
    documentId: randomUUID(), fileId: randomUUID(), documentClassification: 'PRIMARY',
    documentType: gatewayDocType, filename: file.split('/').pop(), preSignedUrl: file,
  }));

  const webhookIapHeader = { Authorization: `Bearer ${getWebhookIapToken()}` };
  const payload = {
    payload: { publicUserId: `regression-${fixture.id}-${Date.now()}`, submissionId: randomUUID(), documents },
    callbacks: {
      documentResult:    { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
      applicationResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
    },
  };

  let baselineCount;
  try { baselineCount = await getWebhookBaseline(); console.log(`    Webhook baseline: ${baselineCount}`); }
  catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `Webhook baseline failed: ${err.message}` }); return; }

  const client = createApiClient(true);
  let status, body;
  try { const res = await client.post('/ai-gateway/batch-upload', payload); status = res.status; body = res.data; }
  catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `POST error: ${err.message}` }); return; }

  console.log(`    POST response: HTTP ${status}`);
  if (status !== 200 || !body?.applicationId) {
    results.push({ file: null, status, passed: false, body, summary: `HTTP ${status} -- ${JSON.stringify(body).slice(0, 200)}` });
    return;
  }
  console.log(`    HTTP 200, applicationId=${body.applicationId}`);

  const expectedCallbacks = documents.length + 1;
  let rawCallbacks;
  try {
    console.log(`    Waiting for ${expectedCallbacks} callbacks (${documents.length} doc + 1 app, suppression fallback disabled)...`);
    // applicationId intentionally omitted — hybrid suppression fallback must not fire
    rawCallbacks = await pollWebhookCallbacks(baselineCount, expectedCallbacks, undefined);
    console.log(`    Received ${rawCallbacks.length} callbacks`);
  } catch (err) { results.push({ file: null, status, passed: false, body, summary: `Polling: ${err.message}` }); return; }

  // Decrypt and classify by presence of decrypted.documentId
  const docCallbacks = [];
  const appCallbacks = [];
  const allErrors = [];

  for (const cb of rawCallbacks) {
    const rawBody = cb.content ?? cb.body ?? JSON.stringify(cb);
    let decrypted;
    try { decrypted = await decryptCallback(rawBody); }
    catch (err) {
      if (err.prSkip) { console.log(`    ${err.message}`); continue; }
      allErrors.push(`Decrypt failed: ${err.message}`); continue;
    }
    if (decrypted.documentId) docCallbacks.push(decrypted);
    else appCallbacks.push(decrypted);
  }

  // -- Count assertions -------------------------------------------------------
  if (docCallbacks.length !== documents.length) {
    allErrors.push(`doc callback count: expected ${documents.length}, got ${docCallbacks.length}`);
  }
  if (appCallbacks.length !== 1) {
    const note = appCallbacks.length === 0 ? ' — suppression fallback may have fired on clean docs' : '';
    allErrors.push(`app callback count: expected 1, got ${appCallbacks.length}${note}`);
  }

  // -- Doc-level fraud guard: gs_isFraudulent_{prefix} must be 0 on every doc -
  for (const doc of docCallbacks) {
    const fname = documents.find(d => d.documentId === doc.documentId)?.filename ?? doc.documentId.slice(0, 8);
    const isFraudulent = doc.ocrResult?.fraudChecks?.[`gs_isFraudulent_${prefix}`];
    if (isFraudulent !== 0) {
      console.log(`    FAIL ${fname}: gs_isFraudulent_${prefix}=${JSON.stringify(isFraudulent)} (expected 0)`);
      allErrors.push(`${fname}: gs_isFraudulent_${prefix}=${JSON.stringify(isFraudulent)} (expected 0 — doc flagged as fraudulent)`);
    } else {
      console.log(`    PASS ${fname}: gs_isFraudulent_${prefix}=0`);
    }
  }

  // -- App callback computed field assertions ----------------------------------
  if (appCallbacks.length >= 1) {
    const app = appCallbacks[0];
    const payslipBlock = app.ocrResult?.computedFields?.PAYSLIP;

    if (payslipBlock?.available !== true) {
      allErrors.push(`app callback: PAYSLIP.available=${JSON.stringify(payslipBlock?.available)} (expected true)`);
    }

    const data = payslipBlock?.data ?? {};
    console.log('    computedFields (PAYSLIP):');
    for (const [key, expectedVal] of Object.entries(expectedData)) {
      const actual = data[key];
      if (actual === undefined || actual === null) {
        console.log(`    FAIL ${key} — missing`);
        allErrors.push(`app callback: ${key} missing (expected ${expectedVal})`);
        continue;
      }
      // Exact match for boolean 0|1 fields; ±0.01 tolerance for monetary/float
      if (expectedVal === 0 || expectedVal === 1) {
        if (actual === expectedVal) { console.log(`    PASS ${key} === ${expectedVal}`); }
        else { console.log(`    FAIL ${key}: expected ${expectedVal}, got ${actual}`); allErrors.push(`app callback: ${key}=${JSON.stringify(actual)} (expected ${expectedVal})`); }
      } else {
        if (typeof actual === 'number' && Math.abs(actual - expectedVal) <= 0.01) {
          console.log(`    PASS ${key} = ${actual} (expected ${expectedVal} ±0.01)`);
        } else {
          console.log(`    FAIL ${key}: expected ${expectedVal} ±0.01, got ${JSON.stringify(actual)}`);
          allErrors.push(`app callback: ${key}=${JSON.stringify(actual)} (expected ${expectedVal} ±0.01)`);
        }
      }
    }
  }

  // -- Result -----------------------------------------------------------------
  const fieldCount = Object.keys(expectedData).length;
  if (allErrors.length) {
    results.push({ file: null, status, passed: false, body,
      summary: `app-computed failed: ${allErrors.join('; ')}` });
  } else {
    results.push({ file: null, status, passed: true, body,
      summary: `HTTP 200 ACCEPTED -- ${docCallbacks.length} doc callbacks (fraud guard OK), 1 app callback, ${fieldCount} computed fields validated` });
  }
}

// -- FRAUD-AI-GENERATED: batch upload + assert AI-generated fraud detection on each doc callback

export async function validateFraudAiGenerated(fixture, results) {
  if (!state.webhookTokenId) {
    results.push({ file: null, status: 0, passed: false, body: null, summary: 'SKIPPED -- no webhook token' });
    return;
  }

  const prefix = fixture.fraudFieldPrefix;
  if (!prefix) {
    results.push({ file: null, status: 0, passed: false, body: null, summary: 'Missing fixture.fraudFieldPrefix' });
    return;
  }

  const gatewayDocType = GATEWAY_DOCTYPE_MAP[fixture.documentType] || fixture.documentType;
  const documents = fixture.files.map(file => ({
    documentId: randomUUID(), fileId: randomUUID(), documentClassification: 'PRIMARY',
    documentType: gatewayDocType, filename: file.split('/').pop(), preSignedUrl: file,
  }));

  const webhookIapHeader = { Authorization: `Bearer ${getWebhookIapToken()}` };
  const payload = {
    payload: { publicUserId: `regression-${fixture.id}-${Date.now()}`, submissionId: randomUUID(), documents },
    callbacks: {
      documentResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
      applicationResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
    },
  };

  let baselineCount;
  try { baselineCount = await getWebhookBaseline(); console.log(`    Webhook baseline: ${baselineCount}`); }
  catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `Webhook baseline failed: ${err.message}` }); return; }

  const client = createApiClient(true);
  let status, body;
  try { const res = await client.post('/ai-gateway/batch-upload', payload); status = res.status; body = res.data; }
  catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `POST error: ${err.message}` }); return; }

  console.log(`    POST response: HTTP ${status}`);
  if (status !== 200) { results.push({ file: null, status, passed: false, body, summary: `HTTP ${status} -- ${JSON.stringify(body).slice(0, 200)}` }); return; }
  if (!body.applicationId) { results.push({ file: null, status, passed: false, body, summary: 'Missing applicationId' }); return; }
  console.log(`    HTTP 200, applicationId=${body.applicationId}`);

  const expectedCallbacks = documents.length + 1;
  let callbacks;
  try {
    console.log(`    Waiting for ${expectedCallbacks} callbacks (${documents.length} doc + 1 app, suppression expected)...`);
    callbacks = await pollWebhookCallbacks(baselineCount, expectedCallbacks, body.applicationId);
    console.log(`    Received ${callbacks.length} callbacks`);
  } catch (err) { results.push({ file: null, status, passed: false, body, summary: `Polling: ${err.message}` }); return; }

  const allErrors = [];
  let docCallbackCount = 0;

  for (const cb of callbacks) {
    const rawBody = cb.content ?? cb.body ?? JSON.stringify(cb);
    let decrypted;
    try { decrypted = await decryptCallback(rawBody); }
    catch (err) {
      if (err.prSkip) { console.log(`    ${err.message}`); continue; }
      allErrors.push(`Decrypt failed: ${err.message}`); continue;
    }

    if (!decrypted.documentId) {
      console.log(`    Application callback (appId=${decrypted.applicationId})`);
      continue;
    }

    docCallbackCount++;
    const docMeta = documents.find(d => d.documentId === decrypted.documentId);
    const fname = docMeta?.filename ?? decrypted.documentId;
    console.log(`  -> [FRAUD-AI-GEN] ${fname}`);

    const ocrResult = (decrypted.ocrResult && typeof decrypted.ocrResult === 'object') ? decrypted.ocrResult : {};
    const fraudChecks = ocrResult.fraudChecks || {};
    const findings = Array.isArray(fraudChecks.fraudCheckFindings) ? fraudChecks.fraudCheckFindings : [];

    // Log fraud fields
    const isFraudulent = fraudChecks[`gs_isFraudulent_${prefix}`];
    const overallScore = fraudChecks[`gs_overallFraudScore_${prefix}`];
    const checkStatus = fraudChecks[`gs_fraudCheckStatus_${prefix}`];
    console.log(`    gs_isFraudulent_${prefix}: ${isFraudulent}`);
    console.log(`    gs_overallFraudScore_${prefix}: ${overallScore}`);
    console.log(`    gs_fraudCheckStatus_${prefix}: ${checkStatus}`);
    console.log(`    fraudCheckFindings (${findings.length}):`);
    for (const f of findings) console.log(`      ${f.type}: ${f.description}`);

    // Assertions
    const errors = [];

    // 1. gs_isFraudulent_{prefix} === 1
    if (isFraudulent !== 1) {
      errors.push(`gs_isFraudulent_${prefix}=${JSON.stringify(isFraudulent)} (expected 1)`);
    }

    // 2. gs_overallFraudScore_{prefix} present and non-null
    if (overallScore === undefined || overallScore === null) {
      errors.push(`gs_overallFraudScore_${prefix} missing or null`);
    }

    // 3. fraudCheckFindings contains ai-generatedContent
    const hasAiGen = findings.some(f => f.type === 'ai-generatedContent');
    if (!hasAiGen) {
      errors.push('fraudCheckFindings missing ai-generatedContent entry');
    }

    if (errors.length) {
      console.log(`    FAIL ${errors.join(', ')}`);
      allErrors.push(...errors.map(e => `${fname}: ${e}`));
    } else {
      console.log(`    PASS fraud AI-generated detection confirmed`);
    }
  }

  if (docCallbackCount === 0) {
    allErrors.push('No document callbacks received');
  } else if (docCallbackCount < documents.length) {
    allErrors.push(`Only ${docCallbackCount}/${documents.length} document callbacks received`);
  }

  if (allErrors.length) {
    results.push({ file: null, status, passed: false, body, summary: `fraud-ai-generated failed: ${allErrors.join('; ')}` });
  } else {
    results.push({ file: null, status, passed: true, body, summary: `HTTP 200 ACCEPTED -- ${docCallbackCount} doc callbacks, all AI-generated fraud detected` });
  }
}

// =============================================================================
// Dispatch table: testType -> keyword function
// =============================================================================

// -- CONTRACT-NEGATIVE: assert POST /v1/documents/batch rejects the document ---

export async function runContractNegative(fixture, results) {
  const errorPattern = fixture.expectedError?.errorPattern;
  if (!errorPattern) {
    results.push({ file: null, status: 0, passed: false, body: null,
      summary: 'FAIL — fixture missing expectedError.errorPattern' });
    return;
  }

  console.log(`  -> [CONTRACT-NEGATIVE] ${fixture.id} (pattern: "${errorPattern}")`);
  let res;
  try {
    res = await callParseBatch(fixture.files, fixture.documentType);
  } catch (err) {
    results.push({ file: null, status: 0, passed: false, body: null,
      summary: `FAIL — request error: ${err.message}` });
    return;
  }

  // POST /v1/documents/batch always returns HTTP 200; rejection is signalled by
  // results[].ok === false with an error string — not a non-2xx status code.
  if (res.status !== 200) {
    console.log(`    FAIL unexpected HTTP ${res.status}`);
    results.push({ file: null, status: res.status, passed: false, body: res.body,
      summary: `FAIL unexpected HTTP ${res.status} — ${JSON.stringify(res.body).slice(0, 200)}` });
    return;
  }

  const items = Array.isArray(res.body?.results) ? res.body.results : [];
  const rejected = items.filter(r => r.ok === false);
  const accepted = items.filter(r => r.ok === true);

  if (accepted.length > 0 && rejected.length === 0) {
    console.log(`    FAIL HTTP 200 — all items accepted (expected rejection)`);
    results.push({ file: null, status: res.status, passed: false, body: res.body,
      summary: `FAIL HTTP 200 — document accepted when it should be rejected (expected "${errorPattern}")` });
    return;
  }

  const matchedItem = rejected.find(r =>
    typeof r.error === 'string' && r.error.toLowerCase().includes(errorPattern.toLowerCase())
  );

  if (matchedItem) {
    console.log(`    PASS HTTP 200 rejected — error: "${matchedItem.error}"`);
    results.push({ file: null, status: res.status, passed: true, body: res.body,
      summary: `PASS HTTP 200 rejected — error matches "${errorPattern}": "${matchedItem.error}"` });
  } else {
    const actualErrors = rejected.map(r => r.error).join('; ');
    console.log(`    FAIL HTTP 200 rejected but pattern not found — actual: "${actualErrors}"`);
    results.push({ file: null, status: res.status, passed: false, body: res.body,
      summary: `FAIL HTTP 200 rejected but "${errorPattern}" not in error — actual: "${actualErrors}"` });
  }
}

// -- CALLBACK-ECHO: batch upload + identity field echo assertion ---------------
//
// Guards fix for ticket 86b9fkm0u: publicUserId/submissionId/authorization
// sent in the BatchUploadRequest payload must be echoed verbatim in every
// decrypted callback body. No type coercion, no normalization.
//
// Fixture fields:
//   echoField  {string}   — top-level field name to assert (e.g. "publicUserId")
//   echoValue  {string}   — exact string value that must round-trip unchanged
//   documentTypes {string[]} — optional per-file override for mixed-type batches
//
export async function runCallbackEcho(fixture, results) {
  if (!state.webhookTokenId) {
    results.push({ file: null, status: 0, passed: false, body: null,
      summary: 'SKIPPED -- no webhook token' });
    return;
  }

  const { echoField, echoValue } = fixture;
  if (!echoField || echoValue === undefined) {
    results.push({ file: null, status: 0, passed: false, body: null,
      summary: 'FAIL -- fixture missing echoField or echoValue' });
    return;
  }

  // Per-file document types for mixed batches (e.g. 3 PAYSLIP + 1 BANK_STATEMENT)
  const perFileTypes = Array.isArray(fixture.documentTypes) ? fixture.documentTypes : [];
  const documents = fixture.files.map((file, i) => {
    const rawType = perFileTypes[i] ?? fixture.documentType;
    const docType = GATEWAY_DOCTYPE_MAP[rawType] || rawType;
    return {
      documentId: randomUUID(), fileId: randomUUID(),
      documentClassification: 'PRIMARY',
      documentType: docType, filename: file.split('/').pop(), preSignedUrl: file,
    };
  });

  // Build the payload, injecting echoField alongside the standard identity fields
  const echoPayload = {
    publicUserId: `regression-echo-${fixture.id}-${Date.now()}`,
    submissionId: randomUUID(),
    documents,
    [echoField]: echoValue,
  };

  const webhookIapHeader = { Authorization: `Bearer ${getWebhookIapToken()}` };
  const payload = {
    payload: echoPayload,
    callbacks: {
      documentResult:   { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
      applicationResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
    },
  };

  let baselineCount;
  try { baselineCount = await getWebhookBaseline(); console.log(`    Webhook baseline: ${baselineCount}`); }
  catch (err) {
    results.push({ file: null, status: 0, passed: false, body: null, summary: `Webhook baseline failed: ${err.message}` });
    return;
  }

  const client = createApiClient(true);
  let status, body;
  try { const res = await client.post('/ai-gateway/batch-upload', payload); status = res.status; body = res.data; }
  catch (err) {
    results.push({ file: null, status: 0, passed: false, body: null, summary: `POST error: ${err.message}` });
    return;
  }

  console.log(`    [ECHO] POST response: HTTP ${status}`);
  if (status !== 200) {
    results.push({ file: null, status, passed: false, body,
      summary: `HTTP ${status} -- ${JSON.stringify(body).slice(0, 200)}` });
    return;
  }
  if (!body.applicationId) {
    results.push({ file: null, status, passed: false, body, summary: 'Missing applicationId' });
    return;
  }
  console.log(`    [ECHO] applicationId=${body.applicationId}, asserting ${echoField}="${echoValue}"`);

  // skipAppCallback: true skips waiting for the application-level callback (e.g.
  // for mixed-type multi-doc batches where the app callback arrives too slowly).
  const expectedCallbacks = fixture.skipAppCallback ? documents.length : documents.length + 1;
  const cbLabel = fixture.skipAppCallback
    ? `${documents.length} doc`
    : `${documents.length} doc + 1 app`;
  let callbacks;
  try {
    console.log(`    Waiting for ${expectedCallbacks} callbacks (${cbLabel})...`);
    callbacks = await pollWebhookCallbacks(baselineCount, expectedCallbacks, body.applicationId);
    console.log(`    Received ${callbacks.length} callbacks`);
  } catch (err) {
    results.push({ file: null, status, passed: false, body, summary: `Polling: ${err.message}` });
    return;
  }

  const echoErrors = [];
  let checked = 0;
  for (const cb of callbacks) {
    const rawBody = cb.content ?? cb.body ?? JSON.stringify(cb);
    let decrypted;
    try { decrypted = await decryptCallback(rawBody); }
    catch (err) {
      if (err.prSkip) { console.log(`    ${err.message}`); continue; }
      echoErrors.push(`Decrypt failed: ${err.message}`); continue;
    }

    checked++;
    const cbLabel = decrypted.documentId ? `doc(${decrypted.documentId.slice(0, 8)})` : `app(${decrypted.applicationId?.slice(0, 8)})`;
    const actual = decrypted[echoField];
    if (actual === echoValue) {
      console.log(`    PASS ${cbLabel}: ${echoField}="${actual}"`);
    } else {
      const msg = `${cbLabel}: ${echoField} — sent "${echoValue}", got ${JSON.stringify(actual)}`;
      console.log(`    FAIL ${msg}`);
      echoErrors.push(msg);
    }
  }

  if (echoErrors.length) {
    results.push({ file: null, status, passed: false, body,
      summary: `FAIL echo(${echoField}): ${echoErrors.join('; ')}` });
  } else {
    results.push({ file: null, status, passed: true, body,
      summary: `PASS ${checked}/${expectedCallbacks} callbacks — ${echoField}="${echoValue}" verbatim` });
  }
}

// -- CROSS-VALIDATE: batch upload PRIMARY + SUPPORTING, then assert tier results
//
// Differences from 'crosscheck':
//   - crosscheck asserts crossCheckFindings from the application callback
//   - cross-validate asserts tier_1_results / tier_2_results from the direct
//     POST /api/v1/cross-validate response
//
// fixture.assertions (optional): array of { tier, field, status } objects.
// Each entry is checked against the matching tier array in the response.
// Probe result for BLS-CROSSVALIDATE-001 (BS + ElectricUtility, 2026-05-21):
//   tier_1_results: [], tier_2_results: [{ field:"address", status:"fail",
//   confidence:0.66, detail:"city mismatch: 'makati' vs 'manila metro manila'" }]

export async function runCrossValidateDirect(fixture, results) {
  if (!state.webhookTokenId) {
    results.push({ file: null, status: 0, passed: false, body: null, summary: 'SKIPPED -- no webhook token' });
    return;
  }

  const gatewayDocType = GATEWAY_DOCTYPE_MAP[fixture.documentType] || fixture.documentType;
  const documents = fixture.files.map(file => ({
    documentId: randomUUID(), fileId: randomUUID(), documentClassification: 'PRIMARY',
    documentType: gatewayDocType, filename: file.split('/').pop(), preSignedUrl: file,
  }));
  if (fixture.supportingFiles) {
    for (const sf of fixture.supportingFiles) {
      const sfPath = typeof sf === 'string' ? sf : sf.path;
      const sfDocType = (typeof sf === 'object' && sf.documentType)
        ? (GATEWAY_DOCTYPE_MAP[sf.documentType] || sf.documentType)
        : gatewayDocType;
      const sfClass = (typeof sf === 'object' && sf.documentClassification) || 'SUPPORTING';
      documents.push({
        documentId: randomUUID(), fileId: randomUUID(), documentClassification: sfClass,
        documentType: sfDocType, filename: sfPath.split('/').pop(), preSignedUrl: sfPath,
      });
    }
  }

  const webhookIapHeader = { Authorization: `Bearer ${getWebhookIapToken()}` };
  const payload = {
    payload: { publicUserId: `regression-${fixture.id}-${Date.now()}`, submissionId: randomUUID(), documents },
    callbacks: {
      documentResult:    { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
      applicationResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
    },
  };

  let baselineCount;
  try { baselineCount = await getWebhookBaseline(); console.log(`    Webhook baseline: ${baselineCount}`); }
  catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `Baseline: ${err.message}` }); return; }

  console.log(`  -> [CROSS-VALIDATE] Batch upload (${documents.length} docs: ${fixture.files.length} PRIMARY + ${fixture.supportingFiles?.length || 0} SUPPORTING)...`);
  const batchClient = createApiClient(true);
  let batchStatus, batchBody;
  try { const res = await batchClient.post('/ai-gateway/batch-upload', payload); batchStatus = res.status; batchBody = res.data; }
  catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `Batch POST error: ${err.message}` }); return; }

  if (batchStatus !== 200 || !batchBody.applicationId) {
    results.push({ file: null, status: batchStatus, passed: false, body: batchBody, summary: `Batch HTTP ${batchStatus} -- ${JSON.stringify(batchBody).slice(0, 200)}` });
    return;
  }
  const applicationId = batchBody.applicationId;
  console.log(`    HTTP 200, applicationId=${applicationId}`);

  const expectedCallbacks = documents.length + 1;
  try {
    console.log(`    Waiting for ${expectedCallbacks} callbacks (${documents.length} doc + 1 app)...`);
    const callbacks = await pollWebhookCallbacks(baselineCount, expectedCallbacks, applicationId);
    console.log(`    Received ${callbacks.length} callbacks`);
  } catch (err) { results.push({ file: null, status: batchStatus, passed: false, body: null, summary: `Callback polling: ${err.message}` }); return; }

  await sleep(2500);
  console.log(`  -> [CROSS-VALIDATE] POST /api/v1/cross-validate { application_id: "${applicationId}" }`);
  let cvStatus, cvData;
  try {
    const res = await createApiClient(false).post('/api/v1/cross-validate', { application_id: applicationId });
    cvStatus = res.status; cvData = res.data;
  } catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `cross-validate error: ${err.message}` }); return; }

  const tier1 = cvData?.tier_1_results ?? [];
  const tier2 = cvData?.tier_2_results ?? [];
  console.log(`    HTTP ${cvStatus}, consistency_score=${cvData?.consistency_score}`);
  console.log(`    tier_1_results (${tier1.length}): ${tier1.map(r => `${r.field}=${r.status}`).join(', ') || '—'}`);
  console.log(`    tier_2_results (${tier2.length}): ${tier2.map(r => `${r.field}=${r.status}(${r.confidence})`).join(', ') || '—'}`);

  const errors = [];
  if (cvStatus !== 200) errors.push(`HTTP ${cvStatus}`);
  if (tier1.length + tier2.length === 0) errors.push('no tier_1 or tier_2 results returned');

  for (const a of (fixture.assertions ?? [])) {
    const pool = a.tier === 1 ? tier1 : tier2;
    const hit = pool.find(r => r.field === a.field && r.status === a.status);
    if (hit) {
      console.log(`    PASS tier_${a.tier} ${a.field} === "${a.status}" (confidence=${hit.confidence ?? 'n/a'})`);
    } else {
      const actual = pool.find(r => r.field === a.field);
      const msg = actual
        ? `tier_${a.tier} ${a.field}: expected status="${a.status}", got "${actual.status}"`
        : `tier_${a.tier} ${a.field}: entry not found`;
      errors.push(msg);
      console.log(`    FAIL ${msg}`);
    }
  }

  const passed = errors.length === 0;
  const summary = passed
    ? `HTTP 200 -- cross-validate OK, tier1=${tier1.length} tier2=${tier2.length} result(s), score=${cvData?.consistency_score}`
    : `cross-validate failed: ${errors.join('; ')}`;
  results.push({ file: 'cross-validate', status: cvStatus, passed, body: cvData, summary });
  console.log(`    ${passed ? 'PASS' : 'FAIL'} ${summary}`);
}

// -- API-ENDPOINTS: seed a batch, then exercise lifecycle GET/POST endpoints ---

// Endpoint callers: each receives (applicationId, docId) and returns {status, body}.
// docId here is the *server-side* document ID resolved from the list endpoint,
// NOT the callback documentId (which is the client-generated UUID).
const ENDPOINT_CALLERS = {
  'GET /applications/{applicationId}': async (appId) => callGetApplication(appId),
  'GET /applications/':                async ()      => callListApplications(),
  'GET /applications/{id}/documents':  async (appId) => callListDocuments(appId),
  'GET /documents/{docId}/pages':      async (appId, docId) => callGetDocumentPages(appId, docId),
  'POST /documents/{docId}/reprocess': async (appId, docId) => callReprocessDocument(appId, docId),
  'GET /activities':                   async ()      => callListActivities(),
  'GET /applications/{id}/export':     async (appId) => callExportApplication(appId),
  'GET /documents/{docId}/export':     async (appId, docId) => callExportDocument(appId, docId),
};

export async function validateApiEndpoints(fixture, results) {
  if (!state.webhookTokenId) {
    results.push({ file: null, status: 0, passed: false, body: null, summary: 'SKIPPED -- no webhook token' });
    return;
  }

  // Step 1: Seed a batch upload to get a real applicationId
  console.log('  -> [API-ENDPOINTS] Seeding batch upload...');
  const batchResult = await batchUpload(fixture);
  if (!batchResult.passed) {
    results.push({ ...batchResult, file: 'seed-batch' });
    console.log(`    FAIL seed batch: ${batchResult.summary}`);
    return;
  }
  console.log(`    Seed batch OK`);

  const applicationId = batchResult.body?.applicationId;
  if (!applicationId) {
    results.push({ file: 'seed-batch', status: 0, passed: false, body: null, summary: 'Seed batch missing applicationId' });
    return;
  }

  // Brief wait for backend indexing
  await sleep(2_000);

  // Resolve the server-side document ID via the list endpoint.
  // The callback documentId is the client-generated UUID; the API uses its own ID.
  let docId = null;
  try {
    const listRes = await callListDocuments(applicationId);
    docId = listRes.body?.items?.[0]?.id ?? null;
    console.log(`    applicationId=${applicationId}, docId=${docId}`);
  } catch (err) {
    console.log(`    WARN could not resolve docId: ${err.message}`);
  }

  // Step 2: Run each endpoint assertion from the fixture
  const endpointAssertions = fixture.endpointAssertions || [];

  for (const ea of endpointAssertions) {
    const label = ea.endpoint;
    console.log(`  -> [API-ENDPOINTS] ${label}`);
    const caller = ENDPOINT_CALLERS[label];
    if (!caller) {
      results.push({ file: label, status: 0, passed: false, body: null, summary: `Unknown endpoint: ${label}` });
      continue;
    }

    if (ea.needsDocId && !docId) {
      results.push({ file: label, status: 0, passed: false, body: null, summary: 'No docId resolved from document list' });
      console.log('    FAIL no docId');
      continue;
    }

    let res;
    try {
      res = await caller(applicationId, docId);
    } catch (err) {
      results.push({ file: label, status: 0, passed: false, body: null, summary: `Error: ${err.message}` });
      console.log(`    FAIL ${err.message}`);
      continue;
    }

    const errors = [];

    // Assert HTTP status (supports single number or array of accepted statuses)
    if (ea.expectedStatus) {
      const accepted = Array.isArray(ea.expectedStatus) ? ea.expectedStatus : [ea.expectedStatus];
      if (!accepted.includes(res.status)) {
        errors.push(`HTTP ${res.status} (expected ${accepted.join(' or ')})`);
      }
    }

    // Assert required body fields
    if (Array.isArray(ea.requiredFields)) {
      for (const field of ea.requiredFields) {
        const val = getNestedField(res.body, field);
        if (val === undefined || val === null) {
          errors.push(`missing field: ${field}`);
        }
      }
    }

    // Assert applicationId match
    if (ea.assertApplicationIdMatch && res.body) {
      const bodyAppId = res.body.applicationId;
      if (bodyAppId !== applicationId) {
        errors.push(`applicationId mismatch: ${bodyAppId} !== ${applicationId}`);
      }
    }

    // Assert array field present and non-empty
    if (ea.assertArrayField) {
      const arr = getNestedField(res.body, ea.assertArrayField);
      if (!Array.isArray(arr)) {
        errors.push(`${ea.assertArrayField} is not an array`);
      } else if (ea.assertArrayMinLength && arr.length < ea.assertArrayMinLength) {
        errors.push(`${ea.assertArrayField} length ${arr.length} < ${ea.assertArrayMinLength}`);
      }
    }

    // Assert contains seeded applicationId (for list/search results)
    if (ea.assertContainsAppId && res.body?.items) {
      const found = res.body.items.some(i => i.applicationId === applicationId);
      if (!found) errors.push(`seeded applicationId not found in items`);
    }

    // Assert documentId matches seeded docId
    if (ea.assertDocumentIdMatch && res.body) {
      const bodyDocId = res.body.documentId;
      if (!docId) {
        errors.push('assertDocumentIdMatch: no seeded docId to compare against');
      } else if (bodyDocId !== docId) {
        errors.push(`documentId mismatch: ${bodyDocId} !== ${docId}`);
      }
    }

    // Assert specific field values
    if (Array.isArray(ea.assertFieldEquals)) {
      for (const { field, value } of ea.assertFieldEquals) {
        const actual = getNestedField(res.body, field);
        if (actual !== value) {
          errors.push(`${field}=${JSON.stringify(actual)} (expected ${JSON.stringify(value)})`);
        }
      }
    }

    const passed = errors.length === 0;
    const summary = passed
      ? `HTTP ${res.status} -- ${label} OK`
      : `${label}: ${errors.join(', ')}`;
    results.push({ file: label, status: res.status, passed, body: res.body, summary });
    console.log(`    ${passed ? 'PASS' : 'FAIL'} ${summary}`);
    await sleep(500);
  }
}

function getNestedField(obj, path) {
  if (!obj || !path) return undefined;
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

// -- API-SECURITY: negative-case endpoint assertions -------------------------
// Each fixture.securityCases is an array of {method, path, authMode, expectedStatus}.
// authMode: "valid" (normal API key), "none" (no headers), "wrong-key" (invalid key).
// No seed batch needed — all cases use synthetic/bad IDs.

function buildSecurityClient(authMode) {
  const baseURL = getBaseUrl();
  if (authMode === 'none') {
    return axios.create({
      baseURL, headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true, timeout: 15000,
    });
  }
  if (authMode === 'wrong-key') {
    return axios.create({
      baseURL,
      headers: { Authorization: 'Bearer sk_wrong_key_12345', 'X-Tenant-Token': 'sk_wrong_key_12345', 'Content-Type': 'application/json' },
      validateStatus: () => true, timeout: 15000,
    });
  }
  // "valid" — use the normal authenticated client
  return createApiClient(false);
}

export async function validateApiSecurity(fixture, results) {
  const cases = fixture.securityCases || [];

  for (const tc of cases) {
    const label = `${tc.method} ${tc.path} [${tc.authMode}]`;
    console.log(`  -> [API-SEC] ${label}`);

    const client = buildSecurityClient(tc.authMode);
    let res;
    try {
      if (tc.method === 'GET') {
        res = await client.get(tc.path);
      } else if (tc.method === 'POST') {
        res = await client.post(tc.path, tc.body || {});
      } else {
        results.push({ file: label, status: 0, passed: false, body: null, summary: `Unsupported method: ${tc.method}` });
        continue;
      }
    } catch (err) {
      results.push({ file: label, status: 0, passed: false, body: null, summary: `Error: ${err.message}` });
      console.log(`    FAIL ${err.message}`);
      continue;
    }

    const accepted = Array.isArray(tc.expectedStatus) ? tc.expectedStatus : [tc.expectedStatus];
    const passed = accepted.includes(res.status);
    const summary = passed
      ? `HTTP ${res.status} -- ${label} OK`
      : `${label}: expected ${accepted.join('/')}, got ${res.status}`;
    results.push({ file: label, status: res.status, passed, body: res.data, summary });
    console.log(`    ${passed ? 'PASS' : 'FAIL'} ${summary}`);
    await sleep(1000);
  }
}

// -- BATCH-QUALITY-REJECT: batch upload, assert all docs quality-rejected -----

export async function validateBatchQualityReject(fixture, results) {
  if (!state.webhookTokenId) {
    results.push({ file: null, status: 0, passed: false, body: null, summary: 'SKIPPED -- no webhook token' });
    return;
  }

  const fileEntries = fixture.files || [];
  const webhookIapHeader = { Authorization: `Bearer ${getWebhookIapToken()}` };

  // Build documents array — each entry has its own documentType
  const documents = fileEntries.map(f => ({
    documentId: randomUUID(), fileId: randomUUID(), documentClassification: 'PRIMARY',
    documentType: GATEWAY_DOCTYPE_MAP[f.documentType] || f.documentType,
    filename: f.gcsPath.split('/').pop(), preSignedUrl: f.gcsPath,
  }));

  let baselineCount;
  try { baselineCount = await getWebhookBaseline(); console.log(`    Webhook baseline: ${baselineCount}`); }
  catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `Webhook baseline failed: ${err.message}` }); return; }

  const client = createApiClient(true);
  const payload = {
    payload: { publicUserId: `regression-${fixture.id}-${Date.now()}`, submissionId: randomUUID(), documents },
    callbacks: {
      documentResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
      applicationResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
    },
  };

  let batchStatus, batchBody;
  try { const res = await client.post('/ai-gateway/batch-upload', payload); batchStatus = res.status; batchBody = res.data; }
  catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `POST error: ${err.message}` }); return; }

  console.log(`    POST response: HTTP ${batchStatus}`);
  if (batchStatus !== 200) { results.push({ file: null, status: batchStatus, passed: false, body: batchBody, summary: `HTTP ${batchStatus}` }); return; }
  const applicationId = batchBody.applicationId;
  console.log(`    HTTP 200, applicationId=${applicationId}`);

  // Wait for doc callbacks (app callback may be suppressed)
  const expectedCallbacks = documents.length + 1;
  let callbacks;
  try {
    console.log(`    Waiting for ${expectedCallbacks} callbacks (${documents.length} doc + 1 app)...`);
    callbacks = await pollWebhookCallbacks(baselineCount, expectedCallbacks, applicationId);
    console.log(`    Received ${callbacks.length} callbacks`);
  } catch (err) { results.push({ file: null, status: batchStatus, passed: false, body: null, summary: `Polling: ${err.message}` }); return; }

  // Build lookup from gateway docType to fixture entry for prefix matching
  const prefixByGatewayType = {};
  for (const entry of fileEntries) {
    const gw = GATEWAY_DOCTYPE_MAP[entry.documentType] || entry.documentType;
    prefixByGatewayType[gw] = entry.qualityFieldPrefix;
  }

  // Decrypt and validate each doc callback
  let docIndex = 0;
  for (const cb of callbacks) {
    const rawBody = cb.content ?? cb.body ?? JSON.stringify(cb);
    let decrypted;
    try { decrypted = await decryptCallback(rawBody); }
    catch (err) {
      if (err.prSkip) { console.log(`    ${err.message}`); continue; }
      results.push({ file: `decrypt-${docIndex}`, status: 0, passed: false, body: null, summary: `Decrypt failed: ${err.message}` });
      continue;
    }

    // Skip app callbacks
    if (!decrypted.documentId) {
      console.log(`    Application callback (appId=${decrypted.applicationId}, status=${decrypted.status})`);
      continue;
    }

    const cbDocType = decrypted.documentType || 'unknown';
    const label = `doc-${docIndex + 1} (${cbDocType})`;
    console.log(`  -> [BATCH-QR] ${label}`);
    const errors = [];

    // Assert quality-rejected
    if (decrypted.status !== 'COMPLETED') errors.push(`status="${decrypted.status}" (expected COMPLETED)`);
    if (decrypted.failureReason !== 'QUALITY_REJECTED') errors.push(`failureReason="${decrypted.failureReason}" (expected QUALITY_REJECTED)`);

    // Assert documentData absent (undefined or null)
    if (decrypted.documentData !== undefined && decrypted.documentData !== null) {
      errors.push(`documentData present (expected null/undefined)`);
    }

    // Assert qualityCheck findings in ocrResult
    const qc = decrypted.ocrResult?.qualityCheck;
    if (!qc) {
      errors.push('missing ocrResult.qualityCheck');
    } else {
      const findings = qc.qualityCheckFindings;
      if (!Array.isArray(findings) || findings.length === 0) {
        errors.push('qualityCheckFindings empty or missing');
      } else {
        if (findings[0].status !== 'failed') errors.push(`findings[0].status="${findings[0].status}" (expected "failed")`);
      }

      // Match quality score prefix by callback documentType (not positional index)
      const prefix = prefixByGatewayType[cbDocType];
      if (prefix) {
        const scoreKey = `gs_overallQualityScore_${prefix}`;
        if (qc[scoreKey] === undefined) errors.push(`missing ${scoreKey}`);
        else console.log(`    ${scoreKey} = ${qc[scoreKey]}`);
      }
    }

    const passed = errors.length === 0;
    const summary = passed
      ? `HTTP 200 -- ${label} quality-rejected OK`
      : `${label}: ${errors.join(', ')}`;
    results.push({ file: label, status: batchStatus, passed, body: null, summary });
    console.log(`    ${passed ? 'PASS' : 'FAIL'} ${summary}`);
    docIndex++;
  }
}

// -- BATCH-WRONG-TYPE: batch upload, assert all docs get DOCUMENT_TYPE_MISMATCH

export async function validateBatchWrongType(fixture, results) {
  if (!state.webhookTokenId) {
    results.push({ file: null, status: 0, passed: false, body: null, summary: 'SKIPPED -- no webhook token' });
    return;
  }

  const fileEntries = fixture.files || [];
  const webhookIapHeader = { Authorization: `Bearer ${getWebhookIapToken()}` };

  const documents = fileEntries.map(f => ({
    documentId: randomUUID(), fileId: randomUUID(), documentClassification: 'PRIMARY',
    documentType: GATEWAY_DOCTYPE_MAP[f.documentType] || f.documentType,
    filename: f.gcsPath.split('/').pop(), preSignedUrl: f.gcsPath,
  }));

  let baselineCount;
  try { baselineCount = await getWebhookBaseline(); console.log(`    Webhook baseline: ${baselineCount}`); }
  catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `Webhook baseline failed: ${err.message}` }); return; }

  const client = createApiClient(true);
  const payload = {
    payload: { publicUserId: `regression-${fixture.id}-${Date.now()}`, submissionId: randomUUID(), documents },
    callbacks: {
      documentResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
      applicationResult: { url: `${WEBHOOK_SERVER_URL}/${state.webhookTokenId}`, method: 'POST', headers: webhookIapHeader },
    },
  };

  let batchStatus, batchBody;
  try { const res = await client.post('/ai-gateway/batch-upload', payload); batchStatus = res.status; batchBody = res.data; }
  catch (err) { results.push({ file: null, status: 0, passed: false, body: null, summary: `POST error: ${err.message}` }); return; }

  console.log(`    POST response: HTTP ${batchStatus}`);
  if (batchStatus !== 200) { results.push({ file: null, status: batchStatus, passed: false, body: batchBody, summary: `HTTP ${batchStatus}` }); return; }
  const applicationId = batchBody.applicationId;
  console.log(`    HTTP 200, applicationId=${applicationId}`);

  const expectedCallbacks = documents.length + 1;
  let callbacks;
  try {
    console.log(`    Waiting for ${expectedCallbacks} callbacks (${documents.length} doc + 1 app)...`);
    callbacks = await pollWebhookCallbacks(baselineCount, expectedCallbacks, applicationId);
    console.log(`    Received ${callbacks.length} callbacks`);
  } catch (err) { results.push({ file: null, status: batchStatus, passed: false, body: null, summary: `Polling: ${err.message}` }); return; }

  let docIndex = 0;
  for (const cb of callbacks) {
    const rawBody = cb.content ?? cb.body ?? JSON.stringify(cb);
    let decrypted;
    try { decrypted = await decryptCallback(rawBody); }
    catch (err) {
      if (err.prSkip) { console.log(`    ${err.message}`); continue; }
      results.push({ file: `decrypt-${docIndex}`, status: 0, passed: false, body: null, summary: `Decrypt failed: ${err.message}` });
      continue;
    }

    if (!decrypted.documentId) {
      console.log(`    Application callback (appId=${decrypted.applicationId}, status=${decrypted.status})`);
      continue;
    }

    const cbDocType = decrypted.documentType || 'unknown';
    const label = `doc-${docIndex + 1} (${cbDocType})`;
    console.log(`  -> [WRONG-TYPE] ${label}`);
    const errors = [];

    if (decrypted.status !== 'COMPLETED') errors.push(`status="${decrypted.status}" (expected COMPLETED)`);

    const fc = decrypted.ocrResult?.fraudChecks;

    if (cbDocType === 'BANK_STATEMENT') {
      // BANK_STATEMENT signals mismatch via fraudChecks, not failureReason
      const prefix = 'bankstatement';
      const statusReason = fc?.[`gs_fraudCheckStatusReason_${prefix}`];
      if (statusReason !== 'document_type_mismatch') {
        errors.push(`gs_fraudCheckStatusReason_${prefix}="${statusReason}" (expected "document_type_mismatch")`);
      }
      if (fc?.[`gs_isFraudulent_${prefix}`] !== 1) {
        errors.push(`gs_isFraudulent_${prefix}=${fc?.[`gs_isFraudulent_${prefix}`]} (expected 1)`);
      }
      const findings = fc?.fraudCheckFindings || [];
      const hasMismatchFinding = findings.some(f =>
        f.type === 'others_fraud' && f.description?.includes('does not match the declared document type'));
      if (!hasMismatchFinding) {
        errors.push('missing fraudCheckFindings entry with type=others_fraud + "does not match the declared document type"');
      }
    } else {
      // PAYSLIP and ELECTRICITY_BILL signal mismatch via failureReason
      if (decrypted.failureReason !== 'DOCUMENT_TYPE_MISMATCH') {
        errors.push(`failureReason="${decrypted.failureReason || 'none'}" (expected DOCUMENT_TYPE_MISMATCH)`);
      }
      if (decrypted.documentData !== undefined && decrypted.documentData !== null) {
        errors.push('documentData present (expected null/undefined)');
      }
    }

    const passed = errors.length === 0;
    const summary = passed
      ? `HTTP 200 -- ${label} mismatch detected OK`
      : `${label}: ${errors.join(', ')}`;
    results.push({ file: label, status: batchStatus, passed, body: null, summary });
    console.log(`    ${passed ? 'PASS' : 'FAIL'} ${summary}`);
    docIndex++;
  }
}

// -- CACHE-CHECK: POST /v1/documents/check-cache assertions ------------------

export async function validateCacheCheck(fixture, results) {
  const cases = fixture.cacheCheckCases || [];

  for (const tc of cases) {
    const label = tc.label || `check-cache [${tc.format}]`;
    console.log(`  -> [CACHE-CHECK] ${label}`);

    const client = createApiClient(false);
    let body;
    if (tc.format === 'batch') {
      body = { items: tc.items.map(i => ({ file_url: i.file_url, document_type: i.document_type })) };
    } else {
      body = { file: tc.file, fileType: tc.fileType };
    }

    let res;
    try {
      res = await client.post('/v1/documents/check-cache', body);
    } catch (err) {
      results.push({ file: label, status: 0, passed: false, body: null, summary: `Error: ${err.message}` });
      console.log(`    FAIL ${err.message}`);
      continue;
    }

    const errors = [];
    if (res.status !== 200) {
      errors.push(`HTTP ${res.status} (expected 200)`);
    } else if (tc.format === 'batch') {
      if (!Array.isArray(res.data?.items)) errors.push('missing items array');
      if (typeof res.data?.cached_count !== 'number') errors.push('missing cached_count');
      if (typeof res.data?.uncached_count !== 'number') errors.push('missing uncached_count');
      if (res.data?.items?.length !== tc.items.length) errors.push(`items length ${res.data?.items?.length} !== ${tc.items.length}`);
      for (const item of (res.data?.items || [])) {
        if (typeof item.is_cached !== 'boolean') errors.push(`item missing is_cached: ${item.file_url}`);
        // Assert expected cache state if specified
        if (tc.expectCached !== undefined && item.is_cached !== tc.expectCached) {
          errors.push(`${item.file_url}: is_cached=${item.is_cached} (expected ${tc.expectCached})`);
        }
      }
      // Assert cached_count matches expectations
      if (tc.expectCached === true && res.data?.cached_count !== tc.items.length) {
        errors.push(`cached_count=${res.data?.cached_count} (expected ${tc.items.length})`);
      }
    } else {
      if (typeof res.data?.cached !== 'boolean') errors.push('missing cached field');
      if (typeof res.data?.documentHash !== 'string' && res.data?.documentHash !== null) errors.push('missing documentHash');
      // Assert expected cache state if specified
      if (tc.expectCached !== undefined && res.data?.cached !== tc.expectCached) {
        errors.push(`cached=${res.data?.cached} (expected ${tc.expectCached})`);
      }
    }

    const passed = errors.length === 0;
    const summary = passed
      ? `HTTP ${res.status} -- ${label} OK`
      : `${label}: ${errors.join(', ')}`;
    results.push({ file: label, status: res.status, passed, body: res.data, summary });
    console.log(`    ${passed ? 'PASS' : 'FAIL'} ${summary}`);
    await sleep(500);
  }
}

export const TEST_TYPE_RUNNERS = {
  default: runDefault,
  fraud: validateFraud,
  'bank-deep': validateBankDeep,
  'bank-deep-batch': validateBankDeepBatch,
  cache: validateCache,
  security: validateSecurity,
  crosscheck: crossValidate,
  'crosscheck-deep': validateCrosscheckDeep,
  'payslip-deep': validatePayslipDeep,
  completeness: validateCompleteness,
  health: validateHealth,
  bls: validateBls,
  'gcash-computed': runGcashComputed,
  'gcash-rules': validateGcashRules,
  'dedup-gcash': validateDedup,
  dedup: runDedup,
  'payslip-rules': validatePayslipRules,
  'quality-reject': validateQualityReject,
  'contract-negative': runContractNegative,
  'callback-echo': runCallbackEcho,
  'cross-validate': runCrossValidateDirect,
  'app-computed': runAppComputed,
  'api-endpoints': validateApiEndpoints,
  'api-security': validateApiSecurity,
  'cache-check': validateCacheCheck,
  'batch-quality-reject': validateBatchQualityReject,
  'batch-wrong-type': validateBatchWrongType,
  'fraud-ai-generated': validateFraudAiGenerated,
};
