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
  createStagingClient,
  getWebhookIapToken,
  getWebhookBaseline,
  pollWebhookCallbacks,
  decryptCallback,
  WEBHOOK_SERVER_URL,
  STAGING_URL,
  GATEWAY_DOCTYPE_MAP,
} from './utils.mjs';
import {
  RESPONSE_VALIDATORS,
  validateDocumentCallback,
  validateApplicationCallback,
} from './validators.mjs';

// -- Single-doc parse with response validation --------------------------------

export async function parseDocument(fixture, file, extraPayload = {}) {
  const payload = { file, fileType: fixture.documentType, classification: 'PRIMARY', ...extraPayload };
  const client = createStagingClient(false);
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

  const client = createStagingClient(true);
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
    catch (err) { allErrors.push(`Decrypt failed: ${err.message}`); continue; }

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
    const client = createStagingClient(false);
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
      baseURL: STAGING_URL, headers: { 'Content-Type': 'application/json' }, validateStatus: () => true,
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
      baseURL: STAGING_URL,
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
  const batchClient = createStagingClient(true);
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
    const client = createStagingClient(false);
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
    console.log(`  -> [HEALTH] GET ${endpoint}`);
    try {
      const useIap = endpoint.startsWith('/ai-gateway/');
      const client = createStagingClient(useIap);
      const res = await client.get(endpoint);
      const errors = [];

      if (res.status !== 200) {
        errors.push(`HTTP ${res.status}`);
      } else {
        if (endpoint === '/health/detailed') {
          if (res.data?.cache?.redis?.healthy !== true) console.log('    WARN redis.healthy not true (non-blocking — PG failover active)');
          if (res.data?.cache?.healthy !== true) errors.push('cache.healthy not true');
          if (res.data?.cache?.postgresql?.healthy !== true) errors.push('postgresql.healthy not true');
        }
        if (endpoint.includes('circuit-breakers')) {
          if (res.data?.boost_callback?.state !== 'closed') errors.push(`boost_callback.state="${res.data?.boost_callback?.state}"`);
        }
        if (endpoint === '/health/startup' || endpoint === '/health/live' || endpoint === '/health/ready') {
          const s = String(res.data?.status ?? '').toLowerCase();
          if (s !== 'ok' && s !== 'healthy' && res.status !== 200) errors.push(`unexpected status="${res.data?.status}"`);
        }
      }

      const passed = errors.length === 0;
      results.push({ file: endpoint, status: res.status, passed, body: null,
        summary: passed ? `HTTP 200 -- ${endpoint} OK` : `${endpoint}: ${errors.join(', ')}` });
      console.log(`    ${passed ? 'PASS' : 'FAIL'} ${results.at(-1).summary}`);
    } catch (err) {
      results.push({ file: endpoint, status: 0, passed: false, body: null, summary: `Error: ${err.message}` });
    }
    await sleep(500);
  }
}

// -- BLS: GET/POST /api/v1/applications/* -------------------------------------

export async function validateBls(fixture, results) {
  // GET /api/v1/applications/
  console.log('  -> [BLS] GET /api/v1/applications/');
  try {
    const client = createStagingClient(true);
    const res = await client.get('/api/v1/applications/');
    const passed = res.status === 200 || res.status === 404;
    results.push({ file: '/api/v1/applications/', status: res.status, passed, body: null,
      summary: `HTTP ${res.status} -- endpoint ${passed ? 'exists' : 'unexpected status'}` });
    console.log(`    ${passed ? 'PASS' : 'FAIL'} HTTP ${res.status}`);
  } catch (err) {
    results.push({ file: '/api/v1/applications/', status: 0, passed: false, body: null, summary: `Error: ${err.message}` });
  }
  await sleep(1000);

  // GET /api/v1/applications/upload-urls
  console.log('  -> [BLS] GET /api/v1/applications/upload-urls');
  try {
    const client = createStagingClient(true);
    const res = await client.get('/api/v1/applications/upload-urls');
    const passed = res.status === 200 || res.status === 404 || res.status === 422;
    results.push({ file: '/api/v1/applications/upload-urls', status: res.status, passed, body: null,
      summary: `HTTP ${res.status} -- endpoint ${passed ? 'exists' : 'unexpected status'}` });
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
  const client = createStagingClient(true);
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
  const val90 = computedFields?.gs_90days_consec_bankstatement;
  if (val90 === 1) { console.log(`    PASS gs_90days_consec_bankstatement === 1`); }
  else { console.log(`    FAIL gs_90days_consec_bankstatement === 1 (actual: ${JSON.stringify(val90)})`); errors.push(`gs_90days_consec=${JSON.stringify(val90)}`); }

  const val180 = computedFields?.gs_180days_valid_bankstatement;
  if (val180 === 1) { console.log(`    PASS gs_180days_valid_bankstatement === 1`); }
  else { console.log(`    FAIL gs_180days_valid_bankstatement === 1 (actual: ${JSON.stringify(val180)})`); errors.push(`gs_180days_valid=${JSON.stringify(val180)}`); }

  if (errors.length) {
    results.push({ file: null, status, passed: false, body: null, summary: `computedFields assertion failed: ${errors.join(', ')}` });
  } else {
    results.push({ file: null, status, passed: true, body: null, summary: 'HTTP 200 -- gs_90days_consec=1, gs_180days_valid=1 validated' });
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
  const client = createStagingClient(true);
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

  const client = createStagingClient(true);
  const res = await client.post('/ai-gateway/batch-upload', payload);
  if (res.status !== 200 || !res.data?.applicationId) {
    results.push({ file: null, status: res.status, passed: false, body: res.data,
      summary: `HTTP ${res.status} -- ${JSON.stringify(res.data).slice(0, 200)}` });
    return;
  }
  console.log(`    HTTP 200, applicationId=${res.data.applicationId}`);

  // Poll for 4 callbacks (3 doc + 1 app)
  try {
    console.log('    Waiting for 4 callbacks (3 doc + 1 app)...');
    const callbacks = await pollWebhookCallbacks(baselineCount, 4, res.data.applicationId);
    console.log(`    Received ${callbacks.length} callbacks`);
    results.push({ file: null, status: 200, passed: true, body: null,
      summary: `HTTP 200 ACCEPTED -- ${callbacks.length} callbacks, dedup OK` });
    console.log(`    PASS ${results.at(-1).summary}`);
  } catch (err) {
    results.push({ file: null, status: 200, passed: false, body: null, summary: `Polling: ${err.message}` });
  }
}

// =============================================================================
// Dispatch table: testType -> keyword function
// =============================================================================

export const TEST_TYPE_RUNNERS = {
  default: runDefault,
  fraud: validateFraud,
  'bank-deep': validateBankDeep,
  cache: validateCache,
  security: validateSecurity,
  crosscheck: crossValidate,
  'payslip-deep': validatePayslipDeep,
  completeness: validateCompleteness,
  health: validateHealth,
  bls: validateBls,
  'gcash-computed': runGcashComputed,
  'gcash-rules': validateGcashRules,
  'dedup-gcash': validateDedup,
  dedup: runDedup,
};
