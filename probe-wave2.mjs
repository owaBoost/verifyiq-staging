#!/usr/bin/env node
/**
 * One-shot probe: parse Wave 2 candidate documents against staging.
 * Prints full API response JSON for each.
 */

import 'dotenv/config';
import { createApiClient } from './src/utils.mjs';

const client = createApiClient(false);

async function parse(label, file, documentType) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`PROBE: ${label}`);
  console.log(`  file:         ${file}`);
  console.log(`  documentType: ${documentType}`);
  console.log('='.repeat(72));

  const res = await client.post('/v1/documents/parse', { file, fileType: documentType, classification: 'PRIMARY' });

  console.log(`HTTP ${res.status}`);
  console.log(JSON.stringify(res.data, null, 2));
  return { label, documentType, status: res.status, data: res.data };
}

const results = [];

// File 1 — Mayor's Permit
results.push(await parse(
  'MayorsPermit',
  "gs://verifyiq-internal-testing/QA/GroundTruth/Mayor's Permit/2024_12_12_mayors_permit.jpeg",
  'MayorsPermit',
));

// File 2 — SEC Certificate of Incorporation
results.push(await parse(
  'SECCertificateOfIncorporation',
  'gs://verifyiq-internal-testing/QA/GroundTruth/SEC COI/55513_Applicant12345_SEC_COI.pdf',
  'SECCertificateOfIncorporation',
));

// File 3 — BIR page 1 (try BIRExemptionCertificate first)
results.push(await parse(
  'BIR-page1 (BIRExemptionCertificate)',
  'gs://verifyiq-internal-testing/QA/GroundTruth/BIR/Certificate of Registration (BIR Form 2303).pdf',
  'BIRExemptionCertificate',
));

// File 4 — BIR page 2
results.push(await parse(
  'BIR-page2 (BIRExemptionCertificate)',
  'gs://verifyiq-internal-testing/QA/GroundTruth/BIR/BIR cert page 2 (1).jpeg',
  'BIRExemptionCertificate',
));

// Summary
console.log('\n\n' + '='.repeat(72));
console.log('SUMMARY');
for (const r of results) {
  const apiDocType = r.data?.documentType ?? r.data?.document_type ?? '(not in top-level)';
  const fields = r.data?.documentData ? Object.keys(r.data.documentData) : [];
  const computed = r.data?.computedFields ? Object.keys(r.data.computedFields) : [];
  console.log(`\n[${r.label}]`);
  console.log(`  HTTP:          ${r.status}`);
  console.log(`  documentType:  ${apiDocType}`);
  console.log(`  documentData:  ${fields.join(', ') || '(none)'}`);
  console.log(`  computedFields:${computed.join(', ') || '(none)'}`);
}
