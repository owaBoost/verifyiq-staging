#!/usr/bin/env node
/**
 * Diagnostic script — captures raw responses for all 7 regression failures.
 */
import 'dotenv/config';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';

const STAGING_URL = (process.env.STAGING_URL || 'https://ai-boostform-api-1019050071398.us-central1.run.app').replace(/\/$/, '');
const VERIFYIQ_KEY = process.env.VERIFYIQ_API_KEY;
const GOOGLE_SA_KEY_FILE = process.env.GOOGLE_SA_KEY_FILE;

let _iapToken;
function getIapToken() {
  if (_iapToken) return _iapToken;
  const sa = JSON.parse(readFileSync(GOOGLE_SA_KEY_FILE, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600;
  _iapToken = jwt.sign(
    { iss: sa.client_email, sub: sa.client_email, aud: STAGING_URL, iat: now, exp, target_audience: STAGING_URL },
    sa.private_key, { algorithm: 'RS256' }
  );
  return _iapToken;
}

function makeClient(useIap) {
  const authHeader = useIap ? `Bearer ${getIapToken()}` : `Bearer ${VERIFYIQ_KEY}`;
  return axios.create({
    baseURL: STAGING_URL,
    headers: { Authorization: authHeader, 'X-Tenant-Token': VERIFYIQ_KEY, 'Content-Type': 'application/json' },
    validateStatus: () => true,
  });
}

const sep = '='.repeat(80);

// ── 1. BS-DEEP-BDO-001: bank-deep parse ────────────────────────────────────
async function diagBankDeep() {
  console.log(`\n${sep}\n1. BS-DEEP-BDO-001 — bank-deep BDO parse\n${sep}`);
  const client = makeClient(false);
  const res = await client.post('/v1/documents/parse', {
    file: 'gs://verifyiq-internal-testing/QA/bank_financial/BankStatement/BDO_BankStatement.png',
    fileType: 'BankStatement',
    classification: 'PRIMARY',
  });
  console.log(`HTTP ${res.status}`);
  console.log('\n--- Top-level keys ---');
  console.log(Object.keys(res.data));
  console.log('\n--- documentData (full) ---');
  console.log(JSON.stringify(res.data?.documentData, null, 2));
  console.log('\n--- summaryOCR[0] keys ---');
  const ocr0 = res.data?.summaryOCR?.[0];
  if (ocr0) console.log(Object.keys(ocr0));
  else console.log('(no summaryOCR[0])');
  console.log('\n--- transactionsOCR count ---');
  console.log(Array.isArray(res.data?.transactionsOCR) ? res.data.transactionsOCR.length : 'NOT ARRAY');
  console.log('\n--- fraudCheckFindings ---');
  console.log(JSON.stringify(res.data?.fraudCheckFindings, null, 2));
  // Check if calculated fields are anywhere
  const flat = JSON.stringify(res.data);
  for (const k of ['calculated_debits', 'calculated_credits', 'calculatedDebits', 'calculatedCredits', 'total_debits', 'total_credits', 'totalDebits', 'totalCredits']) {
    if (flat.includes(k)) console.log(`  FOUND "${k}" somewhere in response`);
  }
}

// ── 2. ELEC-FRAUD-001: fraud parse of electric bill ─────────────────────────
async function diagElecFraud() {
  console.log(`\n${sep}\n2. ELEC-FRAUD-001 — electric bill fraud parse\n${sep}`);
  const client = makeClient(false);
  const res = await client.post('/v1/documents/parse', {
    file: 'gs://verifyiq-internal-testing/QA/Electric/Fraud_Meralco_Bill.png',
    fileType: 'ElectricUtilityBillingStatement',
    classification: 'PRIMARY',
    pipeline: { fraud_detection: true, use_cache: false },
  });
  console.log(`HTTP ${res.status} (${res.data?.elapsed || 'no elapsed'})`);
  console.log('\n--- Top-level keys ---');
  console.log(Object.keys(res.data));
  console.log('\n--- summaryOCR ---');
  console.log(JSON.stringify(res.data?.summaryOCR, null, 2));
  console.log('\n--- fraudScore ---');
  console.log(res.data?.fraudScore);
  console.log('\n--- fraudCheckFindings ---');
  console.log(JSON.stringify(res.data?.fraudCheckFindings, null, 2));
  console.log('\n--- documentData ---');
  console.log(JSON.stringify(res.data?.documentData, null, 2));
}

// ── 3. CROSS-001: crosscheck endpoint ───────────────────────────────────────
async function diagCrosscheck() {
  console.log(`\n${sep}\n3. CROSS-001 — crosscheck endpoint\n${sep}`);
  const client = makeClient(false);

  // Parse both docs first
  console.log('Parsing payslip...');
  const psRes = await client.post('/v1/documents/parse', {
    file: 'gs://verifyiq-internal-testing/QA/employment/Payslip/PS-002.png',
    fileType: 'Payslip', classification: 'PRIMARY',
  });
  console.log(`  Payslip: HTTP ${psRes.status}, summaryOCR keys: ${Object.keys(psRes.data?.summaryOCR?.[0] || {}).join(', ')}`);

  await new Promise(r => setTimeout(r, 2500));

  console.log('Parsing bank statement...');
  const bsRes = await client.post('/v1/documents/parse', {
    file: 'gs://verifyiq-internal-testing/QA/bank_financial/BankStatement/BPI_eStatement_Dec 2025.pdf',
    fileType: 'BankStatement', classification: 'PRIMARY',
  });
  console.log(`  BS: HTTP ${bsRes.status}, summaryOCR keys: ${Object.keys(bsRes.data?.summaryOCR?.[0] || {}).join(', ')}`);

  await new Promise(r => setTimeout(r, 2500));

  // Build crosscheck payload
  const payload = {
    documents: [
      { fileType: 'Payslip', summaryOCR: psRes.data?.summaryOCR },
      { fileType: 'BankStatement', summaryOCR: bsRes.data?.summaryOCR, transactionsOCR: bsRes.data?.transactionsOCR },
    ],
  };
  console.log('\n--- Crosscheck payload ---');
  console.log(JSON.stringify(payload, null, 2).slice(0, 3000));

  console.log('\nPOST /v1/documents/crosscheck ...');
  const res = await client.post('/v1/documents/crosscheck', payload);
  console.log(`HTTP ${res.status}`);
  console.log('\n--- Response body ---');
  console.log(JSON.stringify(res.data, null, 2));
}

// ── 4. BLS-001: upload-urls endpoint ────────────────────────────────────────
async function diagBls() {
  console.log(`\n${sep}\n4. BLS-001 — POST /api/v1/applications/upload-urls\n${sep}`);
  const client = makeClient(true);
  const payload = { files: [{ filename: 'test.pdf', contentType: 'application/pdf' }] };
  console.log('--- Request ---');
  console.log(`POST ${STAGING_URL}/api/v1/applications/upload-urls`);
  console.log('Headers: Authorization=Bearer <IAP_TOKEN>, X-Tenant-Token=<VERIFYIQ_KEY>');
  console.log('Body:', JSON.stringify(payload));

  const res = await client.post('/api/v1/applications/upload-urls', payload);
  console.log(`\nHTTP ${res.status}`);
  console.log('--- Response headers ---');
  console.log(JSON.stringify(Object.fromEntries(Object.entries(res.headers).filter(([k]) => ['allow', 'content-type', 'x-error', 'www-authenticate'].includes(k.toLowerCase()))), null, 2));
  console.log('--- Response body ---');
  console.log(JSON.stringify(res.data, null, 2));
}

// ── 5. COST-001: cost-tracking endpoints ────────────────────────────────────
async function diagCost() {
  console.log(`\n${sep}\n5. COST-001 — cost-tracking endpoints\n${sep}`);
  const endpoints = [
    '/monitoring/api/v1/costs/overview',
    '/monitoring/api/v1/costs/by-tenant',
  ];
  // Show what auth we're sending
  const iapClient = makeClient(true);
  console.log('Auth: IAP token (useIap=true)');
  console.log(`X-Tenant-Token: ${VERIFYIQ_KEY?.slice(0, 8)}...`);

  for (const ep of endpoints) {
    console.log(`\nGET ${ep}`);
    const res = await iapClient.get(ep);
    console.log(`  HTTP ${res.status}`);
    console.log('  Headers:', JSON.stringify(Object.fromEntries(Object.entries(res.headers).filter(([k]) => ['content-type', 'www-authenticate', 'x-error'].includes(k.toLowerCase()))), null, 2));
    console.log('  Body:', JSON.stringify(res.data, null, 2)?.slice(0, 1000));
  }

  // Also try with non-IAP auth
  console.log('\n--- Retry with non-IAP auth (Bearer VERIFYIQ_KEY) ---');
  const apiClient = makeClient(false);
  for (const ep of endpoints.slice(0, 1)) {
    console.log(`\nGET ${ep}`);
    const res = await apiClient.get(ep);
    console.log(`  HTTP ${res.status}`);
    console.log('  Body:', JSON.stringify(res.data, null, 2)?.slice(0, 1000));
  }
}

// ── 6. HEALTH-001: /health/detailed ─────────────────────────────────────────
async function diagHealth() {
  console.log(`\n${sep}\n6. HEALTH-001 — /health/detailed\n${sep}`);
  const client = makeClient(false);
  const res = await client.get('/health/detailed');
  console.log(`HTTP ${res.status}`);
  console.log('\n--- Full response body ---');
  console.log(JSON.stringify(res.data, null, 2));
}

// ── Run all ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Staging URL: ${STAGING_URL}`);
  console.log(`API key: ${VERIFYIQ_KEY?.slice(0, 8)}...`);
  console.log(`SA key file: ${GOOGLE_SA_KEY_FILE}`);

  await diagBankDeep();
  await diagElecFraud();
  await diagCrosscheck();
  await diagBls();
  await diagCost();
  await diagHealth();

  console.log(`\n${'='.repeat(80)}\nDiagnostics complete.\n`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
