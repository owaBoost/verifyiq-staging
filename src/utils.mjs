/**
 * Shared utilities: config, IAP tokens, HTTP clients, webhook lifecycle.
 */

import 'dotenv/config';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';

// -- Config -------------------------------------------------------------------

export const STAGING_URL = (process.env.STAGING_URL || 'https://ai-boostform-api-1019050071398.us-central1.run.app').replace(/\/$/, '');
export const DEV_URL     = (process.env.DEV_URL || 'https://parser-dev.boostkh.com').replace(/\/$/, '');

// PR environments are ephemeral; their URL is resolved at runtime from
// --base-url / --pr flags and stored in state.prBaseUrl (set by orchestrator).
export const PR_URL_TEMPLATE = (process.env.PR_URL_TEMPLATE || '').trim();

export const VERIFYIQ_KEY     = process.env.VERIFYIQ_API_KEY;
export const DEV_VERIFYIQ_KEY = process.env.DEV_VERIFYIQ_API_KEY;

export const GOOGLE_SA_KEY_FILE = process.env.GOOGLE_SA_KEY_FILE;
export const CLICKUP_TOKEN      = process.env.CLICKUP_API_TOKEN;

// All runs share one ClickUp folder; the list is named per env + date.
export const CLICKUP_FOLDER_ID = process.env.CLICKUP_FOLDER_ID || '90147720582';
export const CLICKUP_LIST_ID   = process.env.CLICKUP_LIST_ID   || '901415181079';

export const WEBHOOK_SERVER_URL = (process.env.WEBHOOK_SERVER_URL || '').trim().replace(/\/$/, '');
export const DECRYPT_URL        = process.env.DECRYPT_URL || 'https://us-central1-boost-capital-staging.cloudfunctions.net/verifyiq-gateway/utils/decrypt';
export const SLACK_WEBHOOK_URL  = (process.env.SLACK_WEBHOOK_URL || '').trim();

// PR Cloud Run auth mode.
// "none"     — unauthenticated (default; Cloud Run service must allow allUsers).
// "id-token" — attach a Google-signed ID token for the Cloud Run invoker role.
//              Requires GOOGLE_SA_KEY_FILE.
// TODO: verify the correct mode against a live PR environment.
export const PR_AUTH_MODE = (process.env.PR_AUTH_MODE || 'none').trim().toLowerCase();

// Mutable shared state (set by orchestrator, read by keywords/reporters)
export const state = {
  webhookTokenId: null,
  env: 'staging', // resolved from --env / TARGET_ENV; one of: staging | dev | pr
  prBaseUrl: null, // set by orchestrator for --env pr
  prNumber:  null, // set by orchestrator when --pr <n> is used
};

// Returns the base URL for the resolved environment.
export function getBaseUrl() {
  if (state.env === 'dev') return DEV_URL;
  if (state.env === 'pr')  return state.prBaseUrl;
  return STAGING_URL;
}

// -- Doc-type mapping ---------------------------------------------------------

export const GATEWAY_DOCTYPE_MAP = {
  BankStatement: 'BANK_STATEMENT',
  Payslip: 'PAYSLIP',
  ElectricUtilityBillingStatement: 'ELECTRICITY_BILL',
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
  SSSPersonalRecord: 'SSS_PERSONAL_RECORD',
  BIRForm2303: 'BIRForm2303',
  WaterUtilityBillingStatement: 'WaterBill',
  TelcoBill: 'TelcoBill',
  CertificateOfEmployment: 'COE',
  CreditCardStatement: 'CREDIT_CARD_STATEMENT',
  GcashTransactionHistory: 'GCASH_TRANSACTION_HISTORY',
  DTIRegistrationCertificate: 'DTIRegistrationCertificate',
};

export const SUPPORTED_BATCH_DOCTYPES = new Set(Object.keys(GATEWAY_DOCTYPE_MAP));

// -- Sleep helper -------------------------------------------------------------

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// -- IAP token generation (for staging API) ----------------------------------

let _iapToken = null;
let _iapTokenExp = 0;

export function generateIapToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_iapToken && now < _iapTokenExp - 60) return _iapToken;
  const sa = JSON.parse(readFileSync(GOOGLE_SA_KEY_FILE, 'utf8'));
  const exp = now + 3600;
  _iapToken = jwt.sign(
    { iss: sa.client_email, sub: sa.client_email, aud: STAGING_URL, iat: now, exp, target_audience: STAGING_URL },
    sa.private_key, { algorithm: 'RS256', keyid: sa.private_key_id },
  );
  _iapTokenExp = exp;
  console.log(`  IAP token generated (aud=${STAGING_URL}, ${_iapToken.length} chars)`);
  return _iapToken;
}

// -- Webhook server IAP auth --------------------------------------------------

let _webhookIapToken = null;

export function getWebhookIapToken() {
  if (_webhookIapToken) return _webhookIapToken;
  const sa = JSON.parse(readFileSync(GOOGLE_SA_KEY_FILE, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  _webhookIapToken = jwt.sign(
    { iss: sa.client_email, sub: sa.client_email, aud: WEBHOOK_SERVER_URL, iat: now, exp: now + 3600 },
    sa.private_key, { algorithm: 'RS256', keyid: sa.private_key_id },
  );
  console.log(`  Webhook IAP token generated (${_webhookIapToken.length} chars)`);
  return _webhookIapToken;
}

// -- PR Cloud Run ID token (Cloud Run invoker auth) ---------------------------
// Only used when PR_AUTH_MODE=id-token. The audience is the Cloud Run service
// URL (state.prBaseUrl), which differs from IAP that uses STAGING_URL.

let _prIdToken = null;
let _prIdTokenForUrl = null; // invalidate when prBaseUrl changes

export function generatePrIdToken() {
  if (_prIdToken && _prIdTokenForUrl === state.prBaseUrl) return _prIdToken;
  _prIdToken = null;
  _prIdTokenForUrl = state.prBaseUrl;
  const sa = JSON.parse(readFileSync(GOOGLE_SA_KEY_FILE, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  _prIdToken = jwt.sign(
    { iss: sa.client_email, sub: sa.client_email, aud: state.prBaseUrl, iat: now, exp: now + 3600 },
    sa.private_key, { algorithm: 'RS256', keyid: sa.private_key_id },
  );
  console.log(`  PR Cloud Run ID token generated (aud=${state.prBaseUrl}, ${_prIdToken.length} chars)`);
  return _prIdToken;
}

// -- Axios clients ------------------------------------------------------------

export function createApiClient(useIap = false) {
  const env = state.env;
  let baseURL, key, authHeader;

  if (env === 'dev') {
    baseURL = DEV_URL;
    key = DEV_VERIFYIQ_KEY;
    // Dev does not use IAP — authenticate with the API key only.
    authHeader = `Bearer ${key}`;
  } else if (env === 'pr') {
    baseURL = state.prBaseUrl;
    key = VERIFYIQ_KEY; // PR deployments share the staging tenant key
    authHeader = `Bearer ${key}`; // always attach the API key, like dev
    if (PR_AUTH_MODE === 'id-token') {
      authHeader = `Bearer ${generatePrIdToken()}`; // override with Cloud Run invoker token
    }
  } else {
    // staging
    baseURL = STAGING_URL;
    key = VERIFYIQ_KEY;
    authHeader = useIap ? `Bearer ${generateIapToken()}` : `Bearer ${key}`;
  }

  const headers = { 'X-Tenant-Token': key, 'Content-Type': 'application/json' };
  if (authHeader) headers.Authorization = authHeader;

  return axios.create({ baseURL, headers, validateStatus: () => true });
}

// -- Batch parse (contract-negative guard testing) ----------------------------

export async function callParseBatch(files, documentType, env) {
  const client = createApiClient(false);
  const payload = {
    items: files.map(file => ({ file, fileType: documentType, classification: 'PRIMARY' })),
  };
  const res = await client.post('/v1/documents/batch', payload);
  return { status: res.status, body: res.data };
}

// Webhook-scoped client (axios with lenient status validation). Webhook requests
// attach Authorization headers manually using getWebhookIapToken().
export function createWebhookClient() {
  return axios.create({ validateStatus: () => true });
}

export const clickupClient = CLICKUP_TOKEN
  ? axios.create({ baseURL: 'https://api.clickup.com/api/v2', headers: { Authorization: CLICKUP_TOKEN } })
  : null;

// -- Callback decryption ------------------------------------------------------
// The decrypt Cloud Function is a shared service (same URL across all envs).
// Its IAP audience is DECRYPT_URL, not STAGING_URL — keep a separate token
// cache so the parser IAP token (aud=STAGING_URL) is unaffected.

let _decryptIapToken = null;
let _decryptIapTokenExp = 0;

function generateDecryptIapToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_decryptIapToken && now < _decryptIapTokenExp - 60) return _decryptIapToken;
  const sa = JSON.parse(readFileSync(GOOGLE_SA_KEY_FILE, 'utf8'));
  const exp = now + 3600;
  _decryptIapToken = jwt.sign(
    { iss: sa.client_email, sub: sa.client_email, aud: DECRYPT_URL, iat: now, exp, target_audience: DECRYPT_URL },
    sa.private_key, { algorithm: 'RS256', keyid: sa.private_key_id },
  );
  _decryptIapTokenExp = exp;
  console.log(`  Decrypt IAP token generated (aud=${DECRYPT_URL}, ${_decryptIapToken.length} chars)`);
  return _decryptIapToken;
}

export async function decryptCallback(rawBody) {
  if (state.env === 'pr') {
    throw Object.assign(new Error('callback decrypt skipped (pr environment)'), { prSkip: true });
  }
  const res = await axios.post(DECRYPT_URL, rawBody, {
    headers: { Authorization: `Bearer ${generateDecryptIapToken()}`, 'Content-Type': 'text/plain' },
    validateStatus: () => true,
  });
  if (res.status !== 200) throw new Error(`Decrypt returned HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
  return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
}

// -- Webhook token lifecycle --------------------------------------------------

export async function createWebhookToken() {
  console.log('-> Creating fresh webhook token...');
  const res = await axios.post(`${WEBHOOK_SERVER_URL}/token`, null, {
    headers: { Authorization: `Bearer ${getWebhookIapToken()}` }, validateStatus: () => true,
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`Webhook token creation failed: HTTP ${res.status}`);
  const uuid = res.data?.uuid;
  if (!uuid) throw new Error('Webhook server returned no uuid');
  console.log(`  Webhook token created: ${uuid}`);
  return uuid;
}

export async function deleteWebhookToken(uuid) {
  if (!uuid) return;
  console.log(`-> Deleting webhook token ${uuid}...`);
  try {
    await axios.delete(`${WEBHOOK_SERVER_URL}/token/${uuid}`, {
      headers: { Authorization: `Bearer ${getWebhookIapToken()}` }, validateStatus: () => true,
    });
    console.log('  Webhook token deleted');
  } catch (err) { console.warn(`  Could not delete webhook token: ${err.message}`); }
}

// -- Webhook polling ----------------------------------------------------------

export async function getWebhookBaseline() {
  const res = await axios.get(
    `${WEBHOOK_SERVER_URL}/token/${state.webhookTokenId}/requests?per_page=2000`,
    { headers: { Authorization: `Bearer ${getWebhookIapToken()}` }, validateStatus: () => true }
  );
  if (res.status !== 200) throw new Error(`Webhook baseline HTTP ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`);
  return res.data?.data?.length ?? 0;
}

export async function pollWebhookCallbacks(baselineCount, expectedCount, applicationId, timeoutMs = 300_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(3_000);
    const res = await axios.get(
      `${WEBHOOK_SERVER_URL}/token/${state.webhookTokenId}/requests?per_page=2000`,
      { headers: { Authorization: `Bearer ${getWebhookIapToken()}` }, validateStatus: () => true }
    );
    const all = res.data?.data ?? [];
    const newRequests = all.slice(0, all.length - baselineCount);
    if (newRequests.length >= expectedCount) return newRequests;

    // Hybrid status check: if all doc callbacks arrived but app callback is
    // missing (suppression scenario), probe the application status immediately
    // instead of waiting for the full timeout.
    if (newRequests.length === expectedCount - 1 && applicationId) {
      try {
        const appRes = await createApiClient(false).get(`/api/v1/applications/${applicationId}`);
        const appStatus = appRes.data?.status ?? appRes.data?.applicationStatus;
        if (appRes.status === 200 && (appStatus === 'COMPLETED' || appStatus === 'completed')) {
          const elapsed = Date.now() - start;
          console.log(`    Application callback suppressed — status COMPLETED verified via GET (${elapsed}ms)`);
          return newRequests;
        }
        // Still ACCEPTED/PROCESSING — continue polling normally
      } catch { /* status check failed — continue polling */ }
    }

    console.log(`    Polling... ${newRequests.length}/${expectedCount} callbacks received`);
  }

  // Final suppression fallback (timeout reached): one last check in case we
  // narrowly missed the window above.
  const finalRes = await axios.get(
    `${WEBHOOK_SERVER_URL}/token/${state.webhookTokenId}/requests?per_page=2000`,
    { headers: { Authorization: `Bearer ${getWebhookIapToken()}` }, validateStatus: () => true }
  );
  const finalAll = finalRes.data?.data ?? [];
  const finalNew = finalAll.slice(0, finalAll.length - baselineCount);

  if (finalNew.length === expectedCount - 1 && applicationId) {
    try {
      const appRes = await createApiClient(false).get(`/api/v1/applications/${applicationId}`);
      if (appRes.status === 200) {
        console.log(`    Application callback suppressed (fraud score threshold breach) — batch PASS based on doc callbacks + COMPLETED status`);
        return finalNew;
      }
    } catch { /* fall through */ }
  }

  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${expectedCount} callbacks`);
}

// -- API endpoint helpers (Wave 6) --------------------------------------------
// Endpoint paths verified 2026-05-22 against staging. Search and single-doc GET
// do not exist; batch status/result endpoints are not exposed. Helpers below
// cover the endpoints that actually respond.

export async function callGetApplication(applicationId) {
  const client = createApiClient(false);
  const res = await client.get(`/api/v1/applications/${applicationId}`);
  return { status: res.status, body: res.data };
}

export async function callListApplications() {
  const client = createApiClient(false);
  const res = await client.get('/api/v1/applications/');
  return { status: res.status, body: res.data };
}

export async function callListDocuments(applicationId) {
  const client = createApiClient(false);
  const res = await client.get(`/api/v1/applications/${applicationId}/documents`);
  return { status: res.status, body: res.data };
}

export async function callGetDocumentPages(applicationId, docId) {
  const client = createApiClient(false);
  const res = await client.get(`/api/v1/applications/${applicationId}/documents/${docId}/pages`);
  return { status: res.status, body: res.data };
}

export async function callReprocessDocument(applicationId, docId) {
  const client = createApiClient(false);
  const res = await client.post(`/api/v1/applications/${applicationId}/documents/${docId}/reprocess`, {});
  return { status: res.status, body: res.data };
}
