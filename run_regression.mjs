#!/usr/bin/env node
/**
 * Staging Regression Runner -- loops through permanent fixtures in regression-suite.json
 * and sends each to the VerifyIQ staging API.
 *
 * Single-doc fixtures -> POST /v1/documents/parse (with response field validation)
 * Batch fixtures      -> POST /ai-gateway/batch-upload (with webhook callback polling)
 *
 * Results are posted to ClickUp (updates existing tasks, creates new ones if needed).
 */

import 'dotenv/config';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';

// -- PascalCase -> SCREAMING_SNAKE_CASE mapping for /ai-gateway/batch-upload --

const GATEWAY_DOCTYPE_MAP = {
  BankStatement: 'BANK_STATEMENT',
  Payslip: 'PAYSLIP',
  ElectricUtilityBillingStatement: 'ELECTRICITY_BILL',
  PLDTTelcoBill: 'TelcoBill',
  WaterUtilityBillingStatement: 'WaterBill',
  PhilippineNationalID: 'PHILIPPINE_NATIONAL_ID',
  DriversLicense: 'DRIVERS_LICENSE',
  Passport: 'PASSPORT',
  UMID: 'UMID',
  SSSID: 'SSS_ID',
  TINID: 'TIN_ID',
  PhilHealthID: 'PHILHEALTH_ID',
  HDMFID: 'HDMF_ID',
  PostalID: 'POSTAL_ID',
  PRCID: 'PRC_ID',
  VotersID: 'VOTERS_ID',
  NBIClearance: 'NBI_CLEARANCE',
  ACRICard: 'ACRI_CARD',
  BIRForm2303: 'BIRForm2303',
  DTIRegistrationCertificate: 'DTIRegistrationCertificate',
  CertificateOfEmployment: 'COE',
};

// -- Per-doctype response field validation ------------------------------------

const RESPONSE_VALIDATORS = {
  BIRForm2303: (body) => {
    const errors = [];
    if (!body.summaryOCR) errors.push('missing summaryOCR');
    if (!body.documentData) errors.push('missing documentData');
    return errors;
  },
  ElectricUtilityBillingStatement: (body) => {
    const errors = [];
    if (!body.summaryOCR) errors.push('missing summaryOCR');
    if (!body.documentData) errors.push('missing documentData');
    const dd = body.documentData || {};
    if (!dd.bill_period_start && !dd.billing_period) errors.push('missing bill_period_start or billing_period');
    if (!dd.gs_amountdue_elecbill) errors.push('missing gs_amountdue_elecbill');
    return errors;
  },
  PhilippineNationalID: (body) => {
    const errors = [];
    if (!body.summaryOCR) errors.push('missing summaryOCR');
    if (!body.documentData) errors.push('missing documentData');
    return errors;
  },
  DriversLicense: (body) => {
    const errors = [];
    if (!body.summaryOCR) errors.push('missing summaryOCR');
    if (!body.documentData) errors.push('missing documentData');
    return errors;
  },
  WaterUtilityBillingStatement: (body) => {
    const errors = [];
    if (!body.summaryOCR) errors.push('missing summaryOCR');
    if (!body.documentData) errors.push('missing documentData');
    return errors;
  },
  BankStatement: (body) => {
    const errors = [];
    if (!body.summaryOCR) errors.push('missing summaryOCR');
    if (!body.transactionsOCR || !Array.isArray(body.transactionsOCR) || body.transactionsOCR.length === 0) {
      errors.push('missing or empty transactionsOCR');
    }
    if (!body.fraudChecks) errors.push('missing fraudChecks');
    return errors;
  },
  Payslip: (body) => {
    const errors = [];
    if (!body.summaryOCR) errors.push('missing summaryOCR');
    if (!body.documentData) errors.push('missing documentData');
    const dd = body.documentData || {};
    if (!dd.gross_pay && !dd.net_pay) errors.push('missing both gross_pay and net_pay');
    return errors;
  },
  NBIClearance: (body) => {
    const errors = [];
    if (!body.summaryOCR) errors.push('missing summaryOCR');
    if (!body.documentData) errors.push('missing documentData');
    return errors;
  },
  Passport: (body) => {
    const errors = [];
    if (!body.summaryOCR) errors.push('missing summaryOCR');
    if (!body.documentData) errors.push('missing documentData');
    return errors;
  },
  DTIRegistrationCertificate: (body) => {
    const errors = [];
    if (!body.summaryOCR) errors.push('missing summaryOCR');
    if (!body.documentData) errors.push('missing documentData');
    return errors;
  },
};

// -- Config -------------------------------------------------------------------

const STAGING_URL = (process.env.STAGING_URL || 'https://ai-boostform-api-1019050071398.us-central1.run.app').replace(/\/$/, '');
const VERIFYIQ_KEY = process.env.VERIFYIQ_API_KEY;
const GOOGLE_SA_KEY_FILE = process.env.GOOGLE_SA_KEY_FILE;
const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN;
const CLICKUP_FOLDER_ID = process.env.CLICKUP_FOLDER_ID || '90147720582';
const WEBHOOK_SERVER_URL = (process.env.WEBHOOK_SERVER_URL || '').trim().replace(/\/$/, '');
const DECRYPT_URL = process.env.DECRYPT_URL || 'https://us-central1-boost-capital-staging.cloudfunctions.net/verifyiq-gateway/utils/decrypt';
let WEBHOOK_TOKEN_ID = null;

// -- CLI args -----------------------------------------------------------------

const args = process.argv.slice(2);
const fixtureFilter = args.includes('--fixture') ? args[args.indexOf('--fixture') + 1] : null;
const dryRun = args.includes('--dry-run');

// -- Startup validation -------------------------------------------------------

const REQUIRED_VARS = { VERIFYIQ_API_KEY: VERIFYIQ_KEY, GOOGLE_SA_KEY_FILE };
const missing = Object.entries(REQUIRED_VARS).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`Fatal: missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

// -- IAP token generation (for staging API) -----------------------------------

let _iapToken = null;
let _iapTokenExp = 0;

function getIapToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_iapToken && now < _iapTokenExp - 60) return _iapToken;

  const sa = JSON.parse(readFileSync(GOOGLE_SA_KEY_FILE, 'utf8'));
  const exp = now + 3600;
  _iapToken = jwt.sign(
    {
      iss: sa.client_email,
      sub: sa.client_email,
      aud: STAGING_URL,
      iat: now,
      exp,
      target_audience: STAGING_URL,
    },
    sa.private_key,
    { algorithm: 'RS256', keyid: sa.private_key_id },
  );
  _iapTokenExp = exp;
  console.log(`  IAP token generated (aud=${STAGING_URL}, ${_iapToken.length} chars)`);
  return _iapToken;
}

// -- Webhook server IAP auth --------------------------------------------------

let _webhookIapToken = null;

function getWebhookIapToken() {
  if (_webhookIapToken) return _webhookIapToken;
  if (!GOOGLE_SA_KEY_FILE) throw new Error('GOOGLE_SA_KEY_FILE is required for webhook server auth');
  const sa = JSON.parse(readFileSync(GOOGLE_SA_KEY_FILE, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  _webhookIapToken = jwt.sign(
    {
      iss: sa.client_email,
      sub: sa.client_email,
      aud: WEBHOOK_SERVER_URL,
      iat: now,
      exp: now + 3600,
    },
    sa.private_key,
    { algorithm: 'RS256', keyid: sa.private_key_id },
  );
  console.log(`  Webhook IAP token generated (${_webhookIapToken.length} chars)`);
  return _webhookIapToken;
}

// -- Webhook token lifecycle --------------------------------------------------

async function createWebhookToken() {
  console.log('-> Creating fresh webhook token...');
  const res = await axios.post(`${WEBHOOK_SERVER_URL}/token`, null, {
    headers: { Authorization: `Bearer ${getWebhookIapToken()}` },
    validateStatus: () => true,
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`Webhook token creation failed: HTTP ${res.status} -- ${JSON.stringify(res.data).slice(0, 300)}`);
  }
  const uuid = res.data?.uuid;
  if (!uuid) throw new Error('Webhook server returned no uuid');
  console.log(`  Webhook token created: ${uuid}`);
  return uuid;
}

async function deleteWebhookToken(uuid) {
  if (!uuid) return;
  console.log(`-> Deleting webhook token ${uuid}...`);
  try {
    await axios.delete(`${WEBHOOK_SERVER_URL}/token/${uuid}`, {
      headers: { Authorization: `Bearer ${getWebhookIapToken()}` },
      validateStatus: () => true,
    });
    console.log('  Webhook token deleted');
  } catch (err) {
    console.warn(`  Could not delete webhook token: ${err.message}`);
  }
}

// -- Webhook polling & decryption ---------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getWebhookBaseline() {
  const res = await axios.get(
    `${WEBHOOK_SERVER_URL}/token/${WEBHOOK_TOKEN_ID}/requests?per_page=200`,
    { headers: { Authorization: `Bearer ${getWebhookIapToken()}` }, validateStatus: () => true }
  );
  return res.data?.data?.length ?? 0;
}

async function pollWebhookCallbacks(baselineCount, expectedCount, applicationId, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(3_000);
    const res = await axios.get(
      `${WEBHOOK_SERVER_URL}/token/${WEBHOOK_TOKEN_ID}/requests?per_page=200`,
      { headers: { Authorization: `Bearer ${getWebhookIapToken()}` }, validateStatus: () => true }
    );
    const all = res.data?.data ?? [];
    const newRequests = all.slice(0, all.length - baselineCount);
    if (newRequests.length >= expectedCount) return newRequests;
    console.log(`    Polling... ${newRequests.length}/${expectedCount} callbacks received`);
  }
  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${expectedCount} callbacks`);
}

async function decryptCallback(rawBody) {
  const res = await axios.post(DECRYPT_URL, rawBody, {
    headers: {
      Authorization: `Bearer ${getIapToken()}`,
      'Content-Type': 'text/plain',
    },
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    throw new Error(`Decrypt returned HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
  }
  return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
}

// -- Callback validation ------------------------------------------------------

function resolvePath(obj, dotPath) {
  const keys = dotPath.split('.');
  let current = obj;
  for (const key of keys) {
    if (current == null) throw new Error(`null at "${key}"`);
    current = Array.isArray(current) ? current[Number(key)] : current[key];
  }
  return current;
}

function assertField(obj, path, label) {
  try {
    const val = resolvePath(obj, path);
    if (val == null) return `${label}: ${path} is null`;
    return null;
  } catch {
    return `${label}: ${path} not found`;
  }
}

function validateDocumentCallback(decrypted) {
  const coreFields = [
    'applicationId', 'submissionId', 'documentId', 'publicUserId',
    'status', 'documentType', 'documentClassification',
  ];
  return coreFields.map(f => assertField(decrypted, f, 'doc-callback')).filter(Boolean);
}

function validateApplicationCallback(decrypted) {
  const topFields = ['applicationId', 'submissionId', 'publicUserId', 'status'];
  return topFields.map(f => assertField(decrypted, f, 'app-callback')).filter(Boolean);
}

// -- Axios clients ------------------------------------------------------------

const clickup = CLICKUP_TOKEN
  ? axios.create({
      baseURL: 'https://api.clickup.com/api/v2',
      headers: { Authorization: CLICKUP_TOKEN },
    })
  : null;

function createStagingClient(useIap) {
  const authHeader = useIap ? `Bearer ${getIapToken()}` : `Bearer ${VERIFYIQ_KEY}`;
  return axios.create({
    baseURL: STAGING_URL,
    headers: {
      Authorization: authHeader,
      'X-Tenant-Token': VERIFYIQ_KEY,
      'Content-Type': 'application/json',
    },
    validateStatus: () => true,
  });
}

// -- Load fixtures ------------------------------------------------------------

function loadFixtures() {
  console.log('-> Loading regression-suite.json...');
  const raw = readFileSync('regression-suite.json', 'utf8');
  const suite = JSON.parse(raw);
  let fixtures = suite.fixtures;

  if (fixtureFilter) {
    fixtures = fixtures.filter(f => f.id === fixtureFilter);
    if (!fixtures.length) {
      console.error(`Fatal: no fixture with id "${fixtureFilter}"`);
      process.exit(1);
    }
  }

  console.log(`  ${fixtures.length} fixture(s) loaded`);
  return fixtures;
}

// -- Health check -------------------------------------------------------------

async function runHealthCheck() {
  console.log('-> Running health check...');
  const client = createStagingClient(false);
  const res = await client.get('/health');
  if (res.status !== 200) {
    console.error(`Fatal: /health returned HTTP ${res.status}`);
    process.exit(1);
  }
  const s = String(res.data.status ?? '').toLowerCase();
  if (s !== 'ok' && s !== 'healthy') {
    console.error(`Fatal: /health status="${res.data.status}", expected "ok" or "healthy"`);
    process.exit(1);
  }
  console.log(`  /health -- status=${res.data.status}, revision=${res.data.revision}`);
}

// -- Single-doc parse with response validation --------------------------------

async function runSingleParse(fixture, file) {
  const payload = {
    file,
    fileType: fixture.documentType,
    classification: 'PRIMARY',
  };

  const client = createStagingClient(false);
  const res = await client.post('/v1/documents/parse', payload);

  if (res.status !== 200) {
    return {
      file,
      status: res.status,
      passed: false,
      body: res.data,
      summary: `HTTP ${res.status} -- ${JSON.stringify(res.data).slice(0, 200)}`,
    };
  }

  // Validate response fields per document type
  const validator = RESPONSE_VALIDATORS[fixture.documentType];
  const fieldErrors = validator ? validator(res.data) : [];

  if (fieldErrors.length) {
    return {
      file,
      status: res.status,
      passed: false,
      body: res.data,
      summary: `HTTP 200 but validation failed: ${fieldErrors.join(', ')}`,
    };
  }

  return {
    file,
    status: res.status,
    passed: true,
    body: res.data,
    summary: `HTTP 200 -- parsed as ${res.data?.documentType ?? fixture.documentType}`,
  };
}

// -- Batch upload with webhook callback polling --------------------------------

async function runBatchUpload(fixture) {
  if (!WEBHOOK_TOKEN_ID) {
    return {
      status: 0,
      passed: false,
      body: null,
      summary: 'SKIPPED -- WEBHOOK_SERVER_URL not set or webhook token unavailable',
    };
  }

  const gatewayDocType = GATEWAY_DOCTYPE_MAP[fixture.documentType] || fixture.documentType;
  const documents = fixture.files.map(file => ({
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
      publicUserId: `regression-${fixture.id}-${Date.now()}`,
      submissionId: randomUUID(),
      documents,
    },
    callbacks: {
      documentResult: {
        url: `${WEBHOOK_SERVER_URL}/${WEBHOOK_TOKEN_ID}`,
        method: 'POST',
        headers: webhookIapHeader,
      },
      applicationResult: {
        url: `${WEBHOOK_SERVER_URL}/${WEBHOOK_TOKEN_ID}`,
        method: 'POST',
        headers: webhookIapHeader,
      },
    },
  };

  // 1. Get baseline webhook count
  let baselineCount;
  try {
    baselineCount = await getWebhookBaseline();
    console.log(`    Webhook baseline: ${baselineCount} existing requests`);
  } catch (err) {
    return { status: 0, passed: false, body: null, summary: `Webhook baseline failed: ${err.message}` };
  }

  // 2. POST to batch-upload
  const client = createStagingClient(true);
  let status, body;
  try {
    const res = await client.post('/ai-gateway/batch-upload', payload);
    status = res.status;
    body = res.data;
  } catch (err) {
    return { status: 0, passed: false, body: null, summary: `POST error: ${err.message}` };
  }

  console.log(`    POST response: HTTP ${status}`);

  if (status !== 200) {
    return {
      status,
      passed: false,
      body,
      summary: `HTTP ${status} -- ${JSON.stringify(body).slice(0, 200)}`,
    };
  }

  if (!body.applicationId) {
    return { status, passed: false, body, summary: 'Missing applicationId in response' };
  }
  console.log(`    HTTP 200, applicationId=${body.applicationId}, status=${body.status}`);

  // 3. Poll for webhook callbacks (N doc callbacks + 1 app callback)
  const docCount = documents.length;
  const expectedCallbacks = docCount + 1;
  let callbacks;
  try {
    console.log(`    Waiting for ${expectedCallbacks} callbacks (${docCount} doc + 1 app)...`);
    callbacks = await pollWebhookCallbacks(baselineCount, expectedCallbacks, body.applicationId);
    console.log(`    Received ${callbacks.length} callbacks`);
  } catch (err) {
    return { status, passed: false, body, summary: `Polling: ${err.message}` };
  }

  // 4. Decrypt and validate each callback
  const allErrors = [];
  for (const cb of callbacks) {
    const rawBody = cb.content ?? cb.body ?? JSON.stringify(cb);
    let decrypted;
    try {
      decrypted = await decryptCallback(rawBody);
    } catch (err) {
      allErrors.push(`Decrypt failed: ${err.message}`);
      continue;
    }

    const isDocLevel = !!decrypted.documentId;
    if (isDocLevel) {
      const docErrors = validateDocumentCallback(decrypted);
      if (docErrors.length) allErrors.push(...docErrors);
      else console.log(`    Document callback OK (docId=${decrypted.documentId})`);
    } else {
      const appErrors = validateApplicationCallback(decrypted);
      if (appErrors.length) allErrors.push(...appErrors);
      else console.log(`    Application callback OK (appId=${decrypted.applicationId})`);
    }
  }

  if (allErrors.length) {
    return {
      status,
      passed: false,
      body,
      summary: `Callback validation: ${allErrors.length} error(s): ${allErrors.join('; ')}`,
    };
  }

  return {
    status,
    passed: true,
    body,
    summary: `HTTP 200 ACCEPTED -- ${callbacks.length} callbacks validated`,
  };
}

// -- ClickUp reporting (update existing tasks, create if not found) ------------

let clickupListId = null;
let existingTasks = {}; // name -> task id

async function createOrReuseClickUpList() {
  if (!clickup) {
    console.warn('  CLICKUP_API_TOKEN not set -- ClickUp integration disabled');
    return;
  }

  const listName = 'Staging Regression';

  // Look for existing list with this name
  try {
    const { data: folder } = await clickup.get(`/folder/${CLICKUP_FOLDER_ID}/list`);
    const existing = folder.lists.find(l => l.name === listName);
    if (existing) {
      clickupListId = existing.id;
      console.log(`  Reusing existing ClickUp list: ${listName} (${clickupListId})`);
      // Load existing tasks for dedup
      try {
        const { data } = await clickup.get(`/list/${clickupListId}/task`);
        for (const task of (data.tasks ?? [])) {
          existingTasks[task.name] = task.id;
        }
        console.log(`  Loaded ${Object.keys(existingTasks).length} existing tasks for dedup`);
      } catch (err) {
        console.warn(`  Could not load existing tasks: ${err.message}`);
      }
      return;
    }
  } catch (err) {
    console.warn(`  Could not list folder: ${err.message}`);
  }

  // Create new list
  try {
    const { data } = await clickup.post(`/folder/${CLICKUP_FOLDER_ID}/list`, {
      name: listName,
    });
    clickupListId = data.id;
    console.log(`  ClickUp list created: ${listName} (${clickupListId})`);
  } catch (err) {
    console.warn(`  Could not create ClickUp list: ${err.message}`);
  }
}

async function postClickUpResult(fixture, results) {
  if (!clickupListId) return;

  const passedCount = results.filter(r => r.passed).length;
  const totalCount = results.length;
  const icon = passedCount === totalCount ? 'PASS' : passedCount > 0 ? 'PARTIAL' : 'FAIL';
  const status = passedCount === totalCount ? 'passed' : 'fail';

  const lines = results.map(r => {
    const rIcon = r.passed ? 'PASS' : 'FAIL';
    const fileName = r.file ? r.file.split('/').pop() : 'batch';
    return `${rIcon} **${fileName}** -- ${r.summary}`;
  });

  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const description = [
    `**Fixture:** ${fixture.id}`,
    `**Document Type:** ${fixture.documentType}`,
    `**Bucket:** ${fixture.bucket}`,
    `**Last Run:** ${timestamp}`,
    `**Results:**`,
    '',
    ...lines,
  ].join('\n');

  // Find existing task by fixture ID prefix in task name
  const taskNamePrefix = `${fixture.id} --`;
  const existingTaskId = Object.entries(existingTasks).find(([name]) => name.startsWith(taskNamePrefix))?.[1];
  const taskName = `${icon} ${fixture.id} -- ${fixture.documentType} (${passedCount}/${totalCount})`;

  try {
    if (existingTaskId) {
      // Update existing task
      await clickup.put(`/task/${existingTaskId}`, {
        name: taskName,
        description,
        status,
      });
      console.log(`  ClickUp updated: ${existingTaskId}`);
      // Post run result as comment
      await clickup.post(`/task/${existingTaskId}/comment`, {
        comment_text: `**${timestamp}** -- ${icon} ${passedCount}/${totalCount}\n\n${lines.join('\n')}`,
        notify_all: false,
      });
    } else {
      // Create new task
      const { data } = await clickup.post(`/list/${clickupListId}/task`, {
        name: taskName,
        description,
        tags: ['regression', fixture.documentType],
        status,
      });
      existingTasks[taskName] = data.id;
      console.log(`  ClickUp created: ${data.url}`);
    }
  } catch (err) {
    console.warn(`  ClickUp task failed for ${fixture.id}: ${err.message}`);
  }
}

// -- Main ---------------------------------------------------------------------

async function main() {
  const fixtures = loadFixtures();

  if (dryRun) {
    console.log('\n-- Dry run -- fixtures that would be tested:\n');
    for (const f of fixtures) {
      console.log(`  ${f.id} (${f.documentType}) -- ${f.files.length} file(s)`);
      for (const file of f.files) console.log(`    ${file}`);
    }
    return;
  }

  await runHealthCheck();
  await createOrReuseClickUpList();

  // Create a fresh webhook token for batch tests
  const batchEnvReady = GOOGLE_SA_KEY_FILE && WEBHOOK_SERVER_URL;
  if (batchEnvReady) {
    WEBHOOK_TOKEN_ID = await createWebhookToken();
  } else {
    console.warn('  WEBHOOK_SERVER_URL not set -- batch callback validation will be skipped');
  }

  let totalPassed = 0;
  let totalFailed = 0;

  try {
    for (const fixture of fixtures) {
      console.log(`\n-- ${fixture.id} (${fixture.documentType}) -- ${fixture.files.length} file(s) --`);

      const results = [];

      // Run each file individually via /v1/documents/parse
      for (const file of fixture.files) {
        const fileName = file.split('/').pop();
        console.log(`  -> ${fileName}`);
        try {
          const result = await runSingleParse(fixture, file);
          results.push(result);
          console.log(`    ${result.passed ? 'PASS' : 'FAIL'} ${result.summary}`);
        } catch (err) {
          results.push({ file, status: 0, passed: false, body: null, summary: `Error: ${err.message}` });
          console.log(`    FAIL Error: ${err.message}`);
        }
        // Delay between requests to stay under 30/min rate limit
        await sleep(2500);
      }

      // Also run as batch via /ai-gateway/batch-upload
      console.log(`  -> Batch upload (${fixture.files.length} docs)...`);
      try {
        const batchResult = await runBatchUpload(fixture);
        results.push({ ...batchResult, file: null });
        console.log(`    ${batchResult.passed ? 'PASS' : 'FAIL'} ${batchResult.summary}`);
      } catch (err) {
        results.push({ file: null, status: 0, passed: false, body: null, summary: `Batch error: ${err.message}` });
        console.log(`    FAIL Batch error: ${err.message}`);
      }

      const passed = results.filter(r => r.passed).length;
      const failed = results.length - passed;
      totalPassed += passed;
      totalFailed += failed;

      await postClickUpResult(fixture, results);
    }
  } finally {
    await deleteWebhookToken(WEBHOOK_TOKEN_ID);
  }

  console.log(`\n-> Done. ${totalPassed} passed, ${totalFailed} failed out of ${totalPassed + totalFailed} total.`);
  if (totalFailed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
