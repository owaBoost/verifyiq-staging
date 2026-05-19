import 'dotenv/config';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const STAGING_URL = (process.env.STAGING_URL || 'https://ai-boostform-api-1019050071398.us-central1.run.app').replace(/\/$/, '');
const VERIFYIQ_KEY = process.env.VERIFYIQ_API_KEY;
const sa = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_FILE, 'utf8'));
const now = Math.floor(Date.now() / 1000);
const iap = jwt.sign(
  { iss: sa.client_email, sub: sa.client_email, aud: STAGING_URL, iat: now, exp: now + 3600, target_audience: STAGING_URL },
  sa.private_key, { algorithm: 'RS256', keyid: sa.private_key_id },
);

const client = axios.create({
  baseURL: STAGING_URL,
  headers: { Authorization: `Bearer ${VERIFYIQ_KEY}`, 'X-Tenant-Token': VERIFYIQ_KEY, 'Content-Type': 'application/json' },
  validateStatus: () => true,
  timeout: 120_000,
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

// -- List GCS files via gsutil ------------------------------------------------

function listGcs(prefix) {
  try {
    const out = execSync(`gsutil ls "${prefix}"`, { encoding: 'utf8', timeout: 30_000 });
    return out.trim().split('\n').filter(l => l && !l.endsWith('/'));
  } catch { return []; }
}

const FOLDERS = [
  { prefix: 'gs://rafi-images-staging/bir2303/', docType: 'BIRForm2303', folder: 'bir2303' },
  { prefix: 'gs://rafi-images-staging/electricity-bills/', docType: 'ElectricUtilityBillingStatement', folder: 'electricity-bills' },
  { prefix: 'gs://rafi-images-staging/various-ids/', docType: 'PhilippineNationalID', folder: 'various-ids' },
  { prefix: 'gs://rafi-images-staging/water-bills/', docType: 'WaterUtilityBillingStatement', folder: 'water-bills' },
];

console.log('Listing GCS files...');
const allFiles = [];
for (const f of FOLDERS) {
  const files = listGcs(f.prefix);
  console.log(`  ${f.folder}: ${files.length} files`);
  for (const file of files) allFiles.push({ file, docType: f.docType, folder: f.folder });
}
console.log(`Total: ${allFiles.length} files\n`);

// -- Parse each file ----------------------------------------------------------

const results = [];
let idx = 0;

for (const entry of allFiles) {
  idx++;
  const filename = entry.file.split('/').pop();
  const tag = `[${idx}/${allFiles.length}] ${entry.folder}/${filename}`;
  process.stdout.write(`${tag} ... `);

  let res;
  try {
    const start = Date.now();
    res = await client.post('/v1/documents/parse', {
      file: entry.file, fileType: entry.docType, classification: 'PRIMARY',
    });
    const elapsed = Date.now() - start;

    // If various-ids returned no summaryOCR, retry as DriversLicense
    if (entry.folder === 'various-ids' && res.status === 200 &&
        (!Array.isArray(res.data.summaryOCR) || res.data.summaryOCR.length === 0)) {
      process.stdout.write('(retry as DriversLicense) ');
      await sleep(2000);
      const start2 = Date.now();
      const res2 = await client.post('/v1/documents/parse', {
        file: entry.file, fileType: 'DriversLicense', classification: 'PRIMARY',
      });
      const elapsed2 = Date.now() - start2;
      if (res2.status === 200 && Array.isArray(res2.data.summaryOCR) && res2.data.summaryOCR.length > 0) {
        res = res2;
        entry.docType = 'DriversLicense';
        res._elapsed = elapsed2;
      } else {
        res._elapsed = elapsed;
      }
    } else {
      res._elapsed = elapsed;
    }
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
    results.push({ file: entry.file, folder: entry.folder, filename, docType: entry.docType, status: 0, error: err.message });
    await sleep(2000);
    continue;
  }

  const d = res.data || {};
  const ocr0 = d.summaryOCR?.[0] || null;
  const gs = d.gshare_fields || null;
  const cScore = d.completenessScore ?? null;
  const cPct = d.completenessBreakdown?.percentage ?? null;
  const apiDocType = d.documentType ?? null;

  // Find null / FOUND_EMPTY / NOT_FOUND fields
  const missingFields = [];
  if (ocr0) {
    for (const [k, v] of Object.entries(ocr0)) {
      if (v === null || v === 'FOUND_EMPTY' || v === 'NOT_FOUND') missingFields.push(`${k}=${v}`);
    }
  }
  if (gs) {
    for (const [k, v] of Object.entries(gs)) {
      if (v === null || v === 'FOUND_EMPTY' || v === 'NOT_FOUND') missingFields.push(`gs.${k}=${v}`);
    }
  }

  const record = {
    file: entry.file,
    folder: entry.folder,
    filename,
    docType: entry.docType,
    status: res.status,
    elapsed: res._elapsed,
    apiDocType,
    completenessScore: cScore,
    completenessPercentage: cPct,
    summaryOCR_keys: ocr0 ? Object.keys(ocr0) : [],
    summaryOCR_0: ocr0,
    gshare_fields: gs,
    missingFields,
    rawResponse: d,
  };
  results.push(record);

  const hasSummary = !!ocr0;
  const statusIcon = res.status === 200 && hasSummary ? 'PASS' : res.status === 200 ? 'WARN' : 'FAIL';
  console.log(`${statusIcon} HTTP ${res.status} (${res._elapsed}ms) docType=${apiDocType} completeness=${cScore ?? '-'} missing=${missingFields.length}`);

  await sleep(2000);
}

// -- Save full results --------------------------------------------------------

writeFileSync('rafi-results.json', JSON.stringify(results, null, 2));
console.log(`\nSaved ${results.length} results to rafi-results.json`);

// -- Summary table ------------------------------------------------------------

console.log('\n=== SUMMARY ===\n');
console.log('folder              | filename                                                    | status | completeness | missing fields');
console.log('-'.repeat(150));

for (const r of results) {
  const fn = r.filename.slice(0, 57).padEnd(57);
  const folder = r.folder.padEnd(19);
  const st = r.status === 200 ? (r.summaryOCR_keys.length > 0 ? 'PASS' : 'WARN') : `F${r.status}`;
  const cs = r.completenessScore != null ? String(r.completenessScore).padEnd(12) : '-'.padEnd(12);
  const mf = r.missingFields.length > 0 ? r.missingFields.slice(0, 5).join(', ') + (r.missingFields.length > 5 ? ` (+${r.missingFields.length - 5} more)` : '') : '-';
  console.log(`${folder} | ${fn} | ${st.padEnd(6)} | ${cs} | ${mf}`);
}

const passed = results.filter(r => r.status === 200 && r.summaryOCR_keys.length > 0).length;
const warned = results.filter(r => r.status === 200 && r.summaryOCR_keys.length === 0).length;
const failed = results.filter(r => r.status !== 200).length;
console.log(`\n-> ${passed} PASS, ${warned} WARN (no summaryOCR), ${failed} FAIL out of ${results.length} total.`);
