#!/usr/bin/env node
/**
 * Regression Runner -- loops through permanent fixtures in regression-suite.json
 * and sends each to the VerifyIQ API (staging or dev).
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
  DEV_VERIFYIQ_KEY,
  GOOGLE_SA_KEY_FILE,
  WEBHOOK_SERVER_URL,
  PR_URL_TEMPLATE,
  PR_AUTH_MODE,
  createApiClient,
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

// -- Known stub fields --------------------------------------------------------
// Backend has not yet implemented these computed fields. When validation
// encounters one that returns 0 or null, treat it as SKIPPED rather than FAIL
// so ClickUp results don't surface false negatives.

export const KNOWN_STUB_FIELDS = [
  'gs_90days_consec_payslip',
  'gs_180days_valid_payslip',
  'gs_90days_gross_payslip',
  'gs_90days_onetime_payslip',
  'gs_90days_personalexpense_payslip',
  'gs_inferredincome_payslip',
];

export function isStubSkipped(fieldName, value) {
  if (!KNOWN_STUB_FIELDS.includes(fieldName)) return null;
  if (value === 0 || value == null) {
    return { skipped: true, note: 'stub field — not yet implemented' };
  }
  return null;
}

// -- CLI args -----------------------------------------------------------------

const args = process.argv.slice(2);
const fixtureFilter = args.includes('--fixture') ? args[args.indexOf('--fixture') + 1] : null;
const sectionFilter = args.includes('--section') ? args[args.indexOf('--section') + 1] : null;
const dryRun        = args.includes('--dry-run');
const smokeOnly     = args.includes('--smoke');

const baseUrlFlagIdx = args.indexOf('--base-url');
const prFlagIdx      = args.indexOf('--pr');
const explicitBaseUrl = baseUrlFlagIdx !== -1 ? args[baseUrlFlagIdx + 1] : null;
const prFlagNumber    = prFlagIdx !== -1 ? args[prFlagIdx + 1] : null;

// Resolve target environment: --env flag > TARGET_ENV env var > 'staging'
const envFlagIdx = args.indexOf('--env');
const resolvedEnv = (() => {
  const raw = envFlagIdx !== -1 ? args[envFlagIdx + 1] : (process.env.TARGET_ENV || 'staging');
  if (raw !== 'staging' && raw !== 'dev' && raw !== 'pr') {
    console.error(`Fatal: --env must be "staging", "dev", or "pr", got "${raw}"`);
    process.exit(1);
  }
  return raw;
})();

// Resolve PR base URL when --env pr
let resolvedPrNumber = null;
if (resolvedEnv === 'pr') {
  let prBaseUrl = null;
  if (explicitBaseUrl) {
    // --base-url wins over --pr for the URL, but --pr still sets the PR number
    prBaseUrl = explicitBaseUrl.replace(/\/$/, '');
    resolvedPrNumber = prFlagNumber;
  } else if (prFlagNumber) {
    if (!PR_URL_TEMPLATE) {
      console.error('Fatal: --pr requires PR_URL_TEMPLATE to be set in .env');
      process.exit(1);
    }
    prBaseUrl = PR_URL_TEMPLATE.replace('{n}', prFlagNumber).replace(/\/$/, '');
    resolvedPrNumber = prFlagNumber;
  } else {
    console.error('Fatal: --env pr requires --base-url <url> or --pr <number>');
    process.exit(1);
  }
  state.prBaseUrl = prBaseUrl;
  state.prNumber  = resolvedPrNumber;
}

// Write resolved env into shared state so all modules read it at call time.
state.env = resolvedEnv;

// -- Startup validation -------------------------------------------------------
// Skipped in dry-run (no API calls are made).

if (!dryRun) {
  const required = {};
  if (resolvedEnv === 'dev') {
    required.DEV_VERIFYIQ_API_KEY = DEV_VERIFYIQ_KEY;
    required.GOOGLE_SA_KEY_FILE   = GOOGLE_SA_KEY_FILE;
  } else if (resolvedEnv === 'pr') {
    required.VERIFYIQ_API_KEY = VERIFYIQ_KEY;
    // GOOGLE_SA_KEY_FILE only needed when PR Cloud Run requires invoker auth.
    if (PR_AUTH_MODE === 'id-token') required.GOOGLE_SA_KEY_FILE = GOOGLE_SA_KEY_FILE;
  } else {
    // staging
    required.VERIFYIQ_API_KEY   = VERIFYIQ_KEY;
    required.GOOGLE_SA_KEY_FILE = GOOGLE_SA_KEY_FILE;
  }
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`Fatal: missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// -- Load fixtures ------------------------------------------------------------

function loadFixtures() {
  console.log('-> Loading regression-suite.json...');
  const raw = readFileSync('regression-suite.json', 'utf8');
  const suite = JSON.parse(raw);
  let fixtures = suite.fixtures;

  if (smokeOnly) {
    fixtures = fixtures.filter(f => f.smoke === true);
    if (!fixtures.length) { console.error('Fatal: --smoke set but no fixtures have smoke:true'); process.exit(1); }
  }
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
  const client = createApiClient(false);
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
    const { getBaseUrl } = await import('./src/utils.mjs');
    console.log(`\n-- Dry run --`);
    console.log(`   env  : ${resolvedEnv}${resolvedPrNumber ? ` (PR #${resolvedPrNumber})` : ''}`);
    console.log(`   url  : ${getBaseUrl()}`);
    console.log(`   smoke: ${smokeOnly}`);
    console.log(`   fixtures that would be tested:\n`);
    for (const f of fixtures) {
      const type = f.testType || 'default';
      const smokeTag = f.smoke ? ' [smoke]' : '';
      console.log(`  ${f.id} (${f.documentType}) [${type}]${smokeTag} -- ${f.files?.length || 0} file(s), ${f.endpoints?.length || 0} endpoint(s)`);
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

import { fileURLToPath } from 'url';
import { realpathSync } from 'fs';
let invokedDirectly = false;
try {
  const entry = process.argv[1] ? realpathSync(process.argv[1]) : '';
  const self = realpathSync(fileURLToPath(import.meta.url));
  invokedDirectly = entry === self;
} catch { /* non-file entry (e.g. -e, REPL) -> not direct */ }
if (invokedDirectly) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
