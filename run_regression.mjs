#!/usr/bin/env node
/**
 * Staging Regression Runner -- loops through permanent fixtures in regression-suite.json
 * and sends each to the VerifyIQ staging API.
 *
 * Test types:
 *   default      -> POST /v1/documents/parse + POST /ai-gateway/batch-upload
 *   fraud        -> parse with pipeline:{fraud_detection:true, use_cache:false}, assert fraudScore
 *   bank-deep    -> parse with deep transaction/field validation
 *   cache        -> parse same doc twice, assert cache hit
 *   security     -> test auth headers (200, 401, 403 responses)
 *   crosscheck   -> POST /v1/documents/crosscheck
 *   payslip-deep -> parse with gross_pay/net_pay/sss/completenessScore
 *   completeness -> parse and assert completenessScore > 0
 *   health       -> GET health endpoints
 *   bls          -> GET/POST /api/v1/applications/* endpoints
 *   gcash-computed -> batch with computedFields validation
 *   gcash-rules  -> batch with 90/180-day assertion
 *   dedup-gcash  -> dedup + crosscheck validation
 *   dedup        -> same file 3x in one batch, assert no tripling
 *
 * Results are posted to ClickUp (new list per run) and Slack summary.
 */

import { readFileSync } from 'fs';
import {
  state,
  VERIFYIQ_KEY,
  GOOGLE_SA_KEY_FILE,
  WEBHOOK_SERVER_URL,
  createStagingClient,
  createWebhookToken,
  deleteWebhookToken,
} from './src/utils.mjs';
import { TEST_TYPE_RUNNERS } from './src/keywords.mjs';
import {
  createClickUpList,
  loadClickUpTasks,
  postToClickUp,
  postToSlack,
} from './src/reporters.mjs';

// -- CLI args -----------------------------------------------------------------

const args = process.argv.slice(2);
const fixtureFilter = args.includes('--fixture') ? args[args.indexOf('--fixture') + 1] : null;
const sectionFilter = args.includes('--section') ? args[args.indexOf('--section') + 1] : null;
const dryRun = args.includes('--dry-run');

// -- Startup validation -------------------------------------------------------

const REQUIRED_VARS = { VERIFYIQ_API_KEY: VERIFYIQ_KEY, GOOGLE_SA_KEY_FILE };
const missing = Object.entries(REQUIRED_VARS).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`Fatal: missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

// -- Load fixtures ------------------------------------------------------------

function loadFixtures() {
  console.log('-> Loading regression-suite.json...');
  const raw = readFileSync('regression-suite.json', 'utf8');
  const suite = JSON.parse(raw);
  let fixtures = suite.fixtures;

  if (fixtureFilter) {
    fixtures = fixtures.filter(f => f.id === fixtureFilter);
    if (!fixtures.length) { console.error(`Fatal: no fixture with id "${fixtureFilter}"`); process.exit(1); }
  }
  if (sectionFilter) {
    fixtures = fixtures.filter(f => (f.testType || 'default') === sectionFilter);
  }

  console.log(`  ${fixtures.length} fixture(s) loaded`);
  return fixtures;
}

// -- Health check -------------------------------------------------------------

async function runHealthCheck() {
  console.log('-> Running health check...');
  const client = createStagingClient(false);
  const res = await client.get('/health');
  if (res.status !== 200) { console.error(`Fatal: /health returned HTTP ${res.status}`); process.exit(1); }
  const s = String(res.data.status ?? '').toLowerCase();
  if (s !== 'ok' && s !== 'healthy') { console.error(`Fatal: /health status="${res.data.status}"`); process.exit(1); }
  console.log(`  /health -- status=${res.data.status}, revision=${res.data.revision}`);
}

// -- Main orchestrator --------------------------------------------------------

async function main() {
  const startTime = Date.now();
  const fixtures = loadFixtures();

  if (dryRun) {
    console.log('\n-- Dry run -- fixtures that would be tested:\n');
    for (const f of fixtures) {
      const type = f.testType || 'default';
      console.log(`  ${f.id} (${f.documentType}) [${type}] -- ${f.files?.length || 0} file(s), ${f.endpoints?.length || 0} endpoint(s)`);
    }
    return;
  }

  await runHealthCheck();
  await createClickUpList();
  await loadClickUpTasks();

  const batchEnvReady = GOOGLE_SA_KEY_FILE && WEBHOOK_SERVER_URL;
  if (batchEnvReady) {
    state.webhookTokenId = await createWebhookToken();
  } else {
    console.warn('  WEBHOOK_SERVER_URL not set -- batch tests will be skipped');
  }

  let totalPassed = 0;
  let totalFailed = 0;
  const allWarnings = [];
  const fixtureResults = [];

  try {
    for (const fixture of fixtures) {
      const testType = fixture.testType || 'default';
      const fileCount = fixture.files?.length || 0;
      const epCount = fixture.endpoints?.length || 0;
      console.log(`\n-- ${fixture.id} (${fixture.documentType}) [${testType}] -- ${fileCount} file(s), ${epCount} endpoint(s) --`);

      const results = [];
      const runner = TEST_TYPE_RUNNERS[testType];
      if (!runner) {
        console.warn(`  Unknown testType "${testType}" -- skipping`);
        continue;
      }

      await runner(fixture, results);

      const passed = results.filter(r => r.passed).length;
      const failed = results.length - passed;
      totalPassed += passed;
      totalFailed += failed;

      const section = fixture.section || 'Uncategorized';
      for (const r of results) {
        for (const w of (r.warnings || [])) {
          allWarnings.push(`[${section}] ${fixture.id}: ${w.replace(/^WARN:\s*/, '')}`);
        }
      }
      fixtureResults.push({
        id: fixture.id,
        section,
        description: fixture.description || '',
        passed: failed === 0,
        passedCount: passed,
        totalCount: results.length,
        reason: failed > 0 ? results.filter(r => !r.passed).map(r => r.summary).join('; ') : null,
      });

      await postToClickUp(fixture, results);
    }
  } finally {
    await deleteWebhookToken(state.webhookTokenId);
  }

  console.log(`\n-> Done. ${totalPassed} passed, ${totalFailed} failed out of ${totalPassed + totalFailed} total.`);
  await postToSlack(fixtureResults, totalPassed, totalFailed, allWarnings, startTime);
  if (totalFailed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
