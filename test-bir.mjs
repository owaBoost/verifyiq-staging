import 'dotenv/config';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';

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
});

const FILES = [
  'gs://rafi-images-staging/bir2303/2024_10_04_bir_registration_certificate_form_2303.jpeg',
  'gs://rafi-images-staging/bir2303/2024_11_20_bir_registration_certificate_form_2303(2).jpeg',
  'gs://rafi-images-staging/bir2303/2024_11_20_bir_registration_certificate_form_2303.jpeg',
  'gs://rafi-images-staging/bir2303/2024_11_21_bir_registration_certificate_form_2303 (3).jpg',
  'gs://rafi-images-staging/bir2303/2024_11_21_bir_registration_certificate_form_2303(1).jpeg',
  'gs://rafi-images-staging/bir2303/2024_11_23_bir_registration_certificate_form_2303.jpeg',
  'gs://rafi-images-staging/bir2303/2024_11_25_bir_registration_certificate_form_2303.jpeg',
  'gs://rafi-images-staging/bir2303/2024_11_28_bir_registration_certificate_form_2303(1).jpeg',
  'gs://rafi-images-staging/bir2303/2024_12_04_bir_registration_certificate_form_2303.pdf',
  'gs://rafi-images-staging/bir2303/2024_12_09_bir_registration_certificate_form_2303_additional_1.pdf',
  'gs://rafi-images-staging/bir2303/2024_12_16_bir_registration_certificate_form_2303.jpeg',
  'gs://rafi-images-staging/bir2303/202601_BIR page 1.jpeg',
  'gs://rafi-images-staging/bir2303/202603_BIR Form 2303 1(1).jpeg',
  'gs://rafi-images-staging/bir2303/202604_BIR certifcate 2 jpeg.jpeg',
  'gs://rafi-images-staging/bir2303/202605_BIR Cert page 1(1).png',
  'gs://rafi-images-staging/bir2303/202606_BIR 2303 PAGE1.jpeg',
  'gs://rafi-images-staging/bir2303/202607_BIR 2303 PAGE 1(5).jpeg',
  'gs://rafi-images-staging/bir2303/459394971_1043524854163939_4926841367180304386_n.jpg',
  'gs://rafi-images-staging/bir2303/465309615_555762550492314_9086242866643910982_n.jpg',
  'gs://rafi-images-staging/bir2303/494817091_695548789737557_6883052897656686418_n.jpeg',
  'gs://rafi-images-staging/bir2303/496626535_559459000535659_4217560907426208006_n.jpeg',
  'gs://rafi-images-staging/bir2303/BIR 2303 page 1(1).jpg',
  'gs://rafi-images-staging/bir2303/BIR Cert page 1 (1).png',
  'gs://rafi-images-staging/bir2303/BIR Form 2303 1 (1).jpeg',
  'gs://rafi-images-staging/bir2303/BIR Form 2303 1.jpeg',
  'gs://rafi-images-staging/bir2303/BIR PAGE1jpeg(1).jpg',
  'gs://rafi-images-staging/bir2303/BIR page 1(1).jpeg',
  'gs://rafi-images-staging/bir2303/BIR page1(1).jpeg',
  'gs://rafi-images-staging/bir2303/BIR2303 Page1.jpeg',
  'gs://rafi-images-staging/bir2303/Scan bir 2303_registration 2.jpeg',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;

console.log(`Testing ${FILES.length} BIR 2303 files against /v1/documents/parse\n`);

for (const file of FILES) {
  const filename = file.split('/').pop();
  try {
    const start = Date.now();
    const res = await client.post('/v1/documents/parse', {
      file, fileType: 'BIRForm2303', classification: 'PRIMARY',
    });
    const elapsed = Date.now() - start;

    if (res.status !== 200) {
      console.log(`FAIL  ${filename}  HTTP ${res.status}  ${JSON.stringify(res.data).slice(0, 150)}`);
      failed++;
    } else {
      const hasSummary = Array.isArray(res.data.summaryOCR) && res.data.summaryOCR.length > 0;
      const ocr = res.data.summaryOCR?.[0] || {};
      const hasTin = !!(ocr.tin_number || ocr.tin);
      const hasRegNum = !!(ocr.registration_number || ocr.reg_number);
      const tinVal = ocr.tin_number || ocr.tin || '-';
      const regVal = ocr.registration_number || ocr.reg_number || '-';

      const status = hasSummary ? 'PASS' : 'FAIL';
      if (hasSummary) passed++; else failed++;

      // Show all top-level keys in summaryOCR[0] for field discovery
      const ocrKeys = Object.keys(ocr).join(', ');

      console.log(`${status}  ${filename}  HTTP 200 (${elapsed}ms)  summaryOCR=${hasSummary ? 'YES' : 'NO'}  tin=${hasTin ? tinVal : 'NO'}  reg=${hasRegNum ? regVal : 'NO'}  fields=[${ocrKeys}]`);
    }
  } catch (err) {
    console.log(`ERROR  ${filename}  ${err.message}`);
    failed++;
  }
  await sleep(2000);
}

console.log(`\n-> Done. ${passed} passed, ${failed} failed out of ${FILES.length} total.`);
if (failed > 0) process.exit(1);
