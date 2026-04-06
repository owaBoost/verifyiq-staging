#!/usr/bin/env node
/**
 * Staging Regression Runner -- loops through permanent fixtures in regression-suite.json
 * and sends each to the VerifyIQ staging API.
 *
 * Single-doc fixtures -> POST /v1/documents/parse
 * Batch fixtures      -> POST /ai-gateway/batch-upload
 *
 * Results are posted to ClickUp.
 */

import 'dotenv/config';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';

// -- Config -------------------------------------------------------------------

const STAGING_URL = (process.env.STAGING_URL || 'https://ai-boostform-api-1019050071398.us-central1.run.app').replace(/\/$/, '');
const VERIFYIQ_KEY = process.env.VERIFYIQ_API_KEY;
const GOOGLE_SA_KEY_FILE = process.env.GOOGLE_SA_KEY_FILE;
const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN;
const CLICKUP_FOLDER_ID = process.env.CLICKUP_FOLDER_ID || '90147709410';

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

// -- IAP token generation -----------------------------------------------------

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

// -- Single-doc parse ---------------------------------------------------------

async function runSingleParse(fixture, file) {
  const payload = {
    file,
    documentType: fixture.documentType,
    classification: 'PRIMARY',
  };

  const client = createStagingClient(false);
  const res = await client.post('/v1/documents/parse', payload);

  return {
    file,
    status: res.status,
    passed: res.status === 200,
    body: res.data,
    summary: res.status === 200
      ? `HTTP 200 -- parsed as ${res.data?.documentType ?? fixture.documentType}`
      : `HTTP ${res.status} -- ${JSON.stringify(res.data).slice(0, 200)}`,
  };
}

// -- Batch upload -------------------------------------------------------------

async function runBatchUpload(fixture) {
  const documents = fixture.files.map(file => ({
    preSignedUrl: file,
    documentType: fixture.documentType,
    classification: 'PRIMARY',
  }));

  const payload = {
    payload: { documents },
  };

  const client = createStagingClient(true);
  const res = await client.post('/ai-gateway/batch-upload', payload);

  return {
    status: res.status,
    passed: res.status === 200 && !!res.data?.applicationId,
    body: res.data,
    summary: res.status === 200
      ? `HTTP 200 -- applicationId=${res.data.applicationId}, status=${res.data.status}`
      : `HTTP ${res.status} -- ${JSON.stringify(res.data).slice(0, 200)}`,
  };
}

// -- ClickUp reporting --------------------------------------------------------

let clickupListId = null;

async function createClickUpList() {
  if (!clickup) {
    console.warn('  CLICKUP_API_TOKEN not set -- ClickUp integration disabled');
    return;
  }

  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const listName = `Staging Regression -- ${timestamp}`;

  try {
    const { data } = await clickup.post(`/folder/${CLICKUP_FOLDER_ID}/list`, {
      name: listName,
    });
    clickupListId = data.id;
    console.log(`  ClickUp list created: ${listName} (${clickupListId})`);
  } catch (err) {
    const errCode = err.response?.data?.ECODE ?? '';
    if (errCode === 'SUBCAT_016') {
      console.log(`  List "${listName}" already exists, looking up...`);
      try {
        const { data: folder } = await clickup.get(`/folder/${CLICKUP_FOLDER_ID}/list`);
        const existing = folder.lists.find(l => l.name === listName);
        if (existing) {
          clickupListId = existing.id;
          console.log(`  Reusing existing ClickUp list (${clickupListId})`);
          return;
        }
      } catch (e) {
        console.warn(`  Lookup failed: ${e.message}`);
      }
    }
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

  try {
    const { data } = await clickup.post(`/list/${clickupListId}/task`, {
      name: `${icon} ${fixture.id} -- ${fixture.documentType} (${passedCount}/${totalCount})`,
      description: [
        `**Fixture:** ${fixture.id}`,
        `**Document Type:** ${fixture.documentType}`,
        `**Bucket:** ${fixture.bucket}`,
        `**Results:**`,
        '',
        ...lines,
      ].join('\n'),
      tags: ['regression', fixture.documentType],
      status,
    });
    console.log(`  ClickUp: ${data.url}`);
  } catch (err) {
    console.warn(`  ClickUp task failed for ${fixture.id}: ${err.message}`);
  }
}

// -- Main ---------------------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
  await createClickUpList();

  let totalPassed = 0;
  let totalFailed = 0;

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
      // Small delay between requests to avoid rate limits
      await sleep(500);
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

  console.log(`\n-> Done. ${totalPassed} passed, ${totalFailed} failed out of ${totalPassed + totalFailed} total.`);
  if (totalFailed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
