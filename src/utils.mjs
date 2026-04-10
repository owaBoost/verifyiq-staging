/**
 * Shared utilities: config, IAP tokens, HTTP clients, webhook lifecycle.
 */

import 'dotenv/config';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';

// -- Config -------------------------------------------------------------------

export const STAGING_URL = (process.env.STAGING_URL || 'https://ai-boostform-api-1019050071398.us-central1.run.app').replace(/\/$/, '');
export const VERIFYIQ_KEY = process.env.VERIFYIQ_API_KEY;
export const GOOGLE_SA_KEY_FILE = process.env.GOOGLE_SA_KEY_FILE;
export const CLICKUP_TOKEN = process.env.CLICKUP_API_TOKEN;
export const CLICKUP_FOLDER_ID = process.env.CLICKUP_FOLDER_ID || '90147720582';
export const CLICKUP_LIST_ID = process.env.CLICKUP_LIST_ID || '901415181079';
export const WEBHOOK_SERVER_URL = (process.env.WEBHOOK_SERVER_URL || '').trim().replace(/\/$/, '');
export const DECRYPT_URL = process.env.DECRYPT_URL || 'https://us-central1-boost-capital-staging.cloudfunctions.net/verifyiq-gateway/utils/decrypt';
export const SLACK_WEBHOOK_URL = (process.env.SLACK_WEBHOOK_URL || '').trim();

// Mutable shared state (set by orchestrator, read by keywords/reporters)
export const state = {
  webhookTokenId: null,
};

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

// -- Axios clients ------------------------------------------------------------

export function createStagingClient(useIap = false) {
  const authHeader = useIap ? `Bearer ${generateIapToken()}` : `Bearer ${VERIFYIQ_KEY}`;
  return axios.create({
    baseURL: STAGING_URL,
    headers: { Authorization: authHeader, 'X-Tenant-Token': VERIFYIQ_KEY, 'Content-Type': 'application/json' },
    validateStatus: () => true,
  });
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

export async function decryptCallback(rawBody) {
  const res = await axios.post(DECRYPT_URL, rawBody, {
    headers: { Authorization: `Bearer ${generateIapToken()}`, 'Content-Type': 'text/plain' },
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
    `${WEBHOOK_SERVER_URL}/token/${state.webhookTokenId}/requests?per_page=200`,
    { headers: { Authorization: `Bearer ${getWebhookIapToken()}` }, validateStatus: () => true }
  );
  return res.data?.data?.length ?? 0;
}

export async function pollWebhookCallbacks(baselineCount, expectedCount, applicationId, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(3_000);
    const res = await axios.get(
      `${WEBHOOK_SERVER_URL}/token/${state.webhookTokenId}/requests?per_page=200`,
      { headers: { Authorization: `Bearer ${getWebhookIapToken()}` }, validateStatus: () => true }
    );
    const all = res.data?.data ?? [];
    const newRequests = all.slice(0, all.length - baselineCount);
    if (newRequests.length >= expectedCount) return newRequests;
    console.log(`    Polling... ${newRequests.length}/${expectedCount} callbacks received`);
  }
  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${expectedCount} callbacks`);
}
