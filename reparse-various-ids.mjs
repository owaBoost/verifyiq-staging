import 'dotenv/config';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { readFileSync, writeFileSync } from 'fs';

const STAGING_URL = (process.env.STAGING_URL || 'https://ai-boostform-api-1019050071398.us-central1.run.app').replace(/\/$/, '');
const VERIFYIQ_KEY = process.env.VERIFYIQ_API_KEY;
const sa = JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_FILE, 'utf8'));
const now = Math.floor(Date.now() / 1000);
jwt.sign(
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

// -- Load original results, filter various-ids --------------------------------

const allResults = JSON.parse(readFileSync('rafi-results.json', 'utf8'));
const vids = allResults.filter(r => r.folder === 'various-ids');

// -- Classify by filename keywords --------------------------------------------

function classifyFilename(fn) {
  const lower = fn.toLowerCase();
  if (lower.includes('identification system id') || lower.includes('national id')) return 'PhilippineNationalID';
  if (lower.includes('driver') || lower.includes('license')) return 'DriversLicense';
  if (lower.includes('passport')) return 'Passport';
  if (lower.includes('unified multipurpose') || lower.includes('umid')) return 'UMID';
  if (lower.includes('postal id')) return 'PostalID';
  if (lower.includes('prc') || lower.includes('professional regulation')) return 'PRCID';
  return 'PhilippineNationalID'; // default for ambiguous (IMG*, PH ID, etc.)
}

// -- Find misclassified files -------------------------------------------------

const toReparse = [];
for (const r of vids) {
  const correctType = classifyFilename(r.filename);
  r._correctType = correctType;
  if (correctType !== r.docType) {
    toReparse.push(r);
  }
}

console.log(`various-ids: ${vids.length} total, ${toReparse.length} misclassified\n`);
console.log('Misclassified files to re-parse:');
for (const r of toReparse) {
  console.log(`  ${r.filename}  sent=${r.docType} -> correct=${r._correctType}  (was completeness=${r.completenessScore})`);
}

// -- Re-parse misclassified files ---------------------------------------------

console.log(`\nRe-parsing ${toReparse.length} files...\n`);

const correctedResults = [];
let idx = 0;

for (const orig of toReparse) {
  idx++;
  const correctType = orig._correctType;
  const tag = `[${idx}/${toReparse.length}] ${orig.filename} as ${correctType}`;
  process.stdout.write(`${tag} ... `);

  try {
    const start = Date.now();
    const res = await client.post('/v1/documents/parse', {
      file: orig.file, fileType: correctType, classification: 'PRIMARY',
    });
    const elapsed = Date.now() - start;

    const d = res.data || {};
    const ocr0 = d.summaryOCR?.[0] || null;
    const gs = d.gshare_fields || null;
    const cScore = d.completenessScore ?? null;
    const cPct = d.completenessBreakdown?.percentage ?? null;

    const missingFields = [];
    if (ocr0) {
      for (const [k, v] of Object.entries(ocr0)) {
        if (v === null || v === 'FOUND_EMPTY' || v === 'NOT_FOUND') missingFields.push(`${k}=${v}`);
      }
    }

    const record = {
      file: orig.file,
      filename: orig.filename,
      originalDocType: orig.docType,
      correctedDocType: correctType,
      originalCompleteness: orig.completenessScore,
      status: res.status,
      elapsed,
      apiDocType: d.documentType ?? null,
      completenessScore: cScore,
      completenessPercentage: cPct,
      summaryOCR_keys: ocr0 ? Object.keys(ocr0) : [],
      summaryOCR_0: ocr0,
      gshare_fields: gs,
      missingFields,
      originalMissingFields: orig.missingFields,
      rawResponse: d,
    };
    correctedResults.push(record);

    const hasSummary = !!ocr0;
    const delta = cScore != null && orig.completenessScore != null ? cScore - orig.completenessScore : null;
    const deltaStr = delta != null ? (delta >= 0 ? `+${delta}` : `${delta}`) : '?';
    const icon = res.status === 200 && hasSummary ? 'PASS' : res.status === 200 ? 'WARN' : 'FAIL';
    console.log(`${icon} HTTP ${res.status} (${elapsed}ms) completeness=${cScore ?? '-'} (was ${orig.completenessScore ?? '-'}, delta=${deltaStr}) missing=${missingFields.length}`);
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
    correctedResults.push({
      file: orig.file, filename: orig.filename,
      originalDocType: orig.docType, correctedDocType: correctType,
      originalCompleteness: orig.completenessScore,
      status: 0, error: err.message,
    });
  }
  await sleep(2000);
}

// -- Save corrected results ---------------------------------------------------

writeFileSync('rafi-various-ids-corrected.json', JSON.stringify(correctedResults, null, 2));
console.log(`\nSaved ${correctedResults.length} corrected results to rafi-various-ids-corrected.json`);

// -- Summary ------------------------------------------------------------------

console.log('\n=== CORRECTION SUMMARY ===\n');
console.log('filename                                                    | old type             | new type         | old compl | new compl | delta | missing');
console.log('-'.repeat(160));
for (const r of correctedResults) {
  const fn = r.filename.slice(0, 57).padEnd(57);
  const ot = (r.originalDocType || '').padEnd(20);
  const nt = (r.correctedDocType || '').padEnd(16);
  const oc = r.originalCompleteness != null ? String(r.originalCompleteness).padEnd(9) : '-'.padEnd(9);
  const nc = r.completenessScore != null ? String(r.completenessScore).padEnd(9) : '-'.padEnd(9);
  const delta = r.completenessScore != null && r.originalCompleteness != null
    ? String(r.completenessScore - r.originalCompleteness).padEnd(5) : '?'.padEnd(5);
  const mf = r.missingFields?.length ?? '?';
  console.log(`${fn} | ${ot} | ${nt} | ${oc} | ${nc} | ${delta} | ${mf}`);
}

const improved = correctedResults.filter(r => r.completenessScore != null && r.originalCompleteness != null && r.completenessScore > r.originalCompleteness).length;
const same = correctedResults.filter(r => r.completenessScore != null && r.originalCompleteness != null && r.completenessScore === r.originalCompleteness).length;
const worse = correctedResults.filter(r => r.completenessScore != null && r.originalCompleteness != null && r.completenessScore < r.originalCompleteness).length;
console.log(`\n-> ${improved} improved, ${same} same, ${worse} worse out of ${correctedResults.length} re-parsed.`);

// -- Flag low-quality electricity files ---------------------------------------

console.log('\n=== LOW-QUALITY ELECTRICITY FILES (44xxx) ===\n');
const elecResults = allResults.filter(r => r.folder === 'electricity-bills');
const lowQuality = elecResults.filter(r => r.filename.startsWith('44'));
for (const r of lowQuality) {
  console.log(`  ${r.filename}  completeness=${r.completenessScore}  missing=${r.missingFields.length}`);
}
console.log(`\n${lowQuality.length} files flagged as low quality (44xxx series).`);
