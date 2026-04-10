/**
 * Response validators (per docType), callback validators, and key field
 * extraction used by reporters and keywords.
 *
 * Validators return { errors: [...], warnings: [...] }
 *   errors   = hard fails (summaryOCR missing, wrong docType)
 *   warnings = soft checks (specific field names may vary per bank/issuer)
 */

// -- Internal helpers ---------------------------------------------------------

function requireSummaryOCR(body) {
  if (!Array.isArray(body.summaryOCR) || body.summaryOCR.length === 0) return { errors: ['missing or empty summaryOCR'], warnings: [] };
  return { errors: [], warnings: [] };
}

function softCheck(ocr, fieldA, fieldB, label) {
  if (ocr[fieldA] || ocr[fieldB]) return null;
  return `WARN: missing ${label} (checked ${fieldA}${fieldB ? ', ' + fieldB : ''})`;
}

// -- Per-doctype validators ---------------------------------------------------

export const RESPONSE_VALIDATORS = {
  BIRForm2303: (body) => {
    const r = requireSummaryOCR(body); if (r.errors.length) return r;
    const ocr = body.summaryOCR[0] || {};
    const w = softCheck(ocr, 'tin', null, 'TIN');
    if (w) r.warnings.push(w);
    return r;
  },
  ElectricUtilityBillingStatement: (body) => {
    const r = requireSummaryOCR(body); if (r.errors.length) return r;
    const ocr = body.summaryOCR[0] || {};
    if (!ocr.billing_period && !ocr.bill_period_start) r.warnings.push('WARN: missing billing_period in summaryOCR');
    const gs = body.gshare_fields || {};
    if (!gs.gs_amountdue_elecbill) r.warnings.push('WARN: missing gs_amountdue_elecbill in gshare_fields');
    const w1 = softCheck(ocr, 'account_number', null, 'account_number');
    if (w1) r.warnings.push(w1);
    const w2 = softCheck(ocr, 'account_name', 'customer_name', 'account/customer name');
    if (w2) r.warnings.push(w2);
    return r;
  },
  PhilippineNationalID: (body) => {
    const r = requireSummaryOCR(body); if (r.errors.length) return r;
    const ocr = body.summaryOCR[0] || {};
    const w1 = softCheck(ocr, 'id_number', 'pcn', 'ID number/PCN');
    if (w1) r.warnings.push(w1);
    const w2 = softCheck(ocr, 'full_name', 'last_name', 'name');
    if (w2) r.warnings.push(w2);
    return r;
  },
  DriversLicense: (body) => {
    const r = requireSummaryOCR(body); if (r.errors.length) return r;
    const ocr = body.summaryOCR[0] || {};
    const w1 = softCheck(ocr, 'license_number', null, 'license_number');
    if (w1) r.warnings.push(w1);
    const w2 = softCheck(ocr, 'full_name', 'last_name', 'name');
    if (w2) r.warnings.push(w2);
    return r;
  },
  WaterUtilityBillingStatement: (body) => requireSummaryOCR(body),
  BankStatement: (body) => {
    const r = requireSummaryOCR(body); if (r.errors.length) return r;
    if (!Array.isArray(body.transactionsOCR)) r.errors.push('missing transactionsOCR');
    else if (body.transactionsOCR.length === 0) r.warnings.push('WARN: transactionsOCR is empty array');
    if (!body.fraudCheckFindings) r.warnings.push('WARN: missing fraudCheckFindings');
    const ocr = body.summaryOCR[0] || {};
    const w1 = softCheck(ocr, 'account_holder_name', 'account_name', 'account holder name');
    if (w1) r.warnings.push(w1);
    const w2 = softCheck(ocr, 'account_number', null, 'account_number');
    if (w2) r.warnings.push(w2);
    return r;
  },
  Payslip: (body) => {
    const r = requireSummaryOCR(body); if (r.errors.length) return r;
    const ocr = body.summaryOCR[0] || {};
    if (!ocr.gross_pay && !ocr.net_pay) r.errors.push('missing both gross_pay and net_pay in summaryOCR');
    const w1 = softCheck(ocr, 'company_name', 'employer_name', 'company/employer name');
    if (w1) r.warnings.push(w1);
    const w2 = softCheck(ocr, 'employee_name', null, 'employee_name');
    if (w2) r.warnings.push(w2);
    return r;
  },
  NBIClearance: (body) => {
    const r = requireSummaryOCR(body); if (r.errors.length) return r;
    const ocr = body.summaryOCR[0] || {};
    const w1 = softCheck(ocr, 'full_name', 'last_name', 'name');
    if (w1) r.warnings.push(w1);
    const w2 = softCheck(ocr, 'nbi_id_number', null, 'nbi_id_number');
    if (w2) r.warnings.push(w2);
    return r;
  },
  Passport: (body) => {
    const r = requireSummaryOCR(body); if (r.errors.length) return r;
    const ocr = body.summaryOCR[0] || {};
    const w1 = softCheck(ocr, 'passport_number', null, 'passport_number');
    if (w1) r.warnings.push(w1);
    const w2 = softCheck(ocr, 'full_name', 'last_name', 'name');
    if (w2) r.warnings.push(w2);
    return r;
  },
  DTIRegistrationCertificate: (body) => {
    const r = requireSummaryOCR(body); if (r.errors.length) return r;
    const ocr = body.summaryOCR[0] || {};
    const w1 = softCheck(ocr, 'business_name', null, 'business_name');
    if (w1) r.warnings.push(w1);
    const w2 = softCheck(ocr, 'business_registration_number', null, 'business_registration_number');
    if (w2) r.warnings.push(w2);
    return r;
  },
  GcashTransactionHistory: (body) => {
    const hasSummary = Array.isArray(body.summaryOCR) && body.summaryOCR.length > 0;
    const hasTxns = Array.isArray(body.transactionsOCR) && body.transactionsOCR.length > 0;
    const errors = [];
    const warnings = [];
    if (!hasSummary && !hasTxns) errors.push('missing both summaryOCR and transactionsOCR');
    const ocrDocType = body.summaryOCR?.[0]?.document_type;
    if (ocrDocType && ocrDocType !== 'GcashTransactionHistory') warnings.push(`WARN: document_type="${ocrDocType}", expected GcashTransactionHistory`);
    return { errors, warnings };
  },
  CreditCardStatement: (body) => {
    const r = requireSummaryOCR(body); if (r.errors.length) return r;
    const ocr = body.summaryOCR[0] || {};
    const w1 = softCheck(ocr, 'account_number', 'card_number', 'account/card number');
    if (w1) r.warnings.push(w1);
    const w2 = softCheck(ocr, 'total_amount_due', 'minimum_amount_due', 'amount due');
    if (w2) r.warnings.push(w2);
    return r;
  },
  CertificateOfEmployment: (body) => {
    const r = requireSummaryOCR(body); if (r.errors.length) return r;
    const ocr = body.summaryOCR[0] || {};
    const w1 = softCheck(ocr, 'employee_name', 'full_name', 'employee name');
    if (w1) r.warnings.push(w1);
    const w2 = softCheck(ocr, 'employer_name', 'company_name', 'employer/company name');
    if (w2) r.warnings.push(w2);
    return r;
  },
  PLDTTelcoBill: (body) => {
    const r = requireSummaryOCR(body); if (r.errors.length) return r;
    const ocr = body.summaryOCR[0] || {};
    const w1 = softCheck(ocr, 'account_number', null, 'account_number');
    if (w1) r.warnings.push(w1);
    const w2 = softCheck(ocr, 'amount_due', 'total_amount_due', 'amount due');
    if (w2) r.warnings.push(w2);
    return r;
  },
  UMID: (body) => {
    const r = requireSummaryOCR(body); if (r.errors.length) return r;
    const ocr = body.summaryOCR[0] || {};
    const w1 = softCheck(ocr, 'crn_id_number', null, 'crn_id_number');
    if (w1) r.warnings.push(w1);
    const w2 = softCheck(ocr, 'first_name', 'last_name', 'name');
    if (w2) r.warnings.push(w2);
    return r;
  },
  SSSID: (body) => {
    const r = requireSummaryOCR(body); if (r.errors.length) return r;
    const ocr = body.summaryOCR[0] || {};
    const w1 = softCheck(ocr, 'prn_id_number', null, 'prn_id_number');
    if (w1) r.warnings.push(w1);
    const w2 = softCheck(ocr, 'first_name', 'last_name', 'name');
    if (w2) r.warnings.push(w2);
    return r;
  },
  PhilHealthID: (body) => {
    const r = requireSummaryOCR(body); if (r.errors.length) return r;
    const ocr = body.summaryOCR[0] || {};
    const w1 = softCheck(ocr, 'philhealth_number', 'id_number', 'PhilHealth/ID number');
    if (w1) r.warnings.push(w1);
    const w2 = softCheck(ocr, 'full_name', 'last_name', 'name');
    if (w2) r.warnings.push(w2);
    return r;
  },
  PRCID: (body) => {
    const r = requireSummaryOCR(body); if (r.errors.length) return r;
    const ocr = body.summaryOCR[0] || {};
    const w1 = softCheck(ocr, 'registration_number', null, 'registration_number');
    if (w1) r.warnings.push(w1);
    const w2 = softCheck(ocr, 'first_name', 'last_name', 'name');
    if (w2) r.warnings.push(w2);
    return r;
  },
  ACRICard: (body) => {
    const r = requireSummaryOCR(body); if (r.errors.length) return r;
    const ocr = body.summaryOCR[0] || {};
    const w1 = softCheck(ocr, 'ssrn', null, 'ssrn');
    if (w1) r.warnings.push(w1);
    const w2 = softCheck(ocr, 'first_name', 'last_name', 'name');
    if (w2) r.warnings.push(w2);
    return r;
  },
  HDMFID: (body) => {
    const r = requireSummaryOCR(body); if (r.errors.length) return r;
    const ocr = body.summaryOCR[0] || {};
    const w1 = softCheck(ocr, 'mid_no', null, 'mid_no');
    if (w1) r.warnings.push(w1);
    const w2 = softCheck(ocr, 'first_name', 'last_name', 'name');
    if (w2) r.warnings.push(w2);
    return r;
  },
  PostalID: (body) => {
    const r = requireSummaryOCR(body); if (r.errors.length) return r;
    const ocr = body.summaryOCR[0] || {};
    const w1 = softCheck(ocr, 'prn_id_number', null, 'prn_id_number');
    if (w1) r.warnings.push(w1);
    const w2 = softCheck(ocr, 'first_name', 'last_name', 'name');
    if (w2) r.warnings.push(w2);
    return r;
  },
  VotersID: (body) => {
    const r = requireSummaryOCR(body); if (r.errors.length) return r;
    const ocr = body.summaryOCR[0] || {};
    const w1 = softCheck(ocr, 'vin', null, 'vin');
    if (w1) r.warnings.push(w1);
    const w2 = softCheck(ocr, 'first_name', 'last_name', 'name');
    if (w2) r.warnings.push(w2);
    return r;
  },
};

// -- Key field extraction (used by ClickUp description builder) --------------

export function extractKeyFields(body, documentType) {
  if (!body?.summaryOCR?.[0]) return null;
  const ocr = body.summaryOCR[0];
  const f = { completenessScore: body.completenessScore ?? null };
  switch (documentType) {
    case 'BankStatement':
      f.account_holder_name = ocr.account_holder_name || ocr.account_name || null;
      f.account_number = ocr.account_number || null;
      f.total_debits = ocr.total_debits ?? null;
      f.total_credits = ocr.total_credits ?? null;
      f.transactionsOCR_count = body.transactionsOCR?.length ?? 0;
      break;
    case 'Payslip':
      f.employer_name = ocr.employer_name || ocr.company_name || null;
      f.gross_pay = ocr.gross_pay ?? null;
      f.net_pay = ocr.net_pay ?? ocr.net_pay_amount ?? null;
      break;
    case 'PhilippineNationalID': case 'DriversLicense': case 'Passport':
      f.full_name = ocr.full_name || ocr.last_name || null;
      f.id_number = ocr.id_number || ocr.pcn || ocr.license_number || ocr.passport_number || null;
      break;
    case 'ElectricUtilityBillingStatement':
      f.account_name = ocr.account_name || ocr.customer_name || null;
      f.account_number = ocr.account_number || null;
      f.amount_due = ocr.amount_due ?? ocr.total_amount_due ?? null;
      break;
    default: break;
  }
  return f;
}

// -- Callback validators ------------------------------------------------------

function resolvePath(obj, dotPath) {
  const keys = dotPath.split('.');
  let current = obj;
  for (const key of keys) {
    if (current == null) throw new Error(`null at "${key}"`);
    current = Array.isArray(current) ? current[Number(key)] : current[key];
  }
  return current;
}

function assertField(obj, path, label) {
  try {
    const val = resolvePath(obj, path);
    if (val == null) return `${label}: ${path} is null`;
    return null;
  } catch { return `${label}: ${path} not found`; }
}

export function validateDocumentCallback(decrypted, expectedDocType) {
  const coreFields = [
    'applicationId', 'submissionId', 'documentId', 'publicUserId',
    'status', 'documentType', 'documentClassification',
  ];
  const errors = coreFields.map(f => assertField(decrypted, f, 'doc-callback')).filter(Boolean);

  // Hard fail: status must be COMPLETED
  if (decrypted.status && decrypted.status !== 'COMPLETED') {
    errors.push(`doc-callback: status="${decrypted.status}", expected "COMPLETED"`);
  }

  // Hard fail: documentClassification must be non-empty string
  if (typeof decrypted.documentClassification !== 'string' || !decrypted.documentClassification.trim()) {
    errors.push('doc-callback: documentClassification is empty or not a string');
  }

  // Warn (logged but not a fail): documentType should match expected
  if (expectedDocType && decrypted.documentType && decrypted.documentType !== expectedDocType) {
    console.log(`    WARN: callback documentType="${decrypted.documentType}", expected "${expectedDocType}"`);
  }

  return errors;
}

export function validateApplicationCallback(decrypted) {
  const topFields = ['applicationId', 'submissionId', 'publicUserId', 'status'];
  const errors = topFields.map(f => assertField(decrypted, f, 'app-callback')).filter(Boolean);

  // Hard fail: application status must be COMPLETED
  if (decrypted.status && decrypted.status !== 'COMPLETED') {
    errors.push(`app-callback: status="${decrypted.status}", expected "COMPLETED"`);
  }

  return errors;
}

// -- Computed fields validator (generic helper) -------------------------------
//
// Used by gcash-rules and dedup-gcash test types. Given a computedFields
// object and an array of assertions:
//   [{ key, expected, tripled?, tolerance? }]
// returns { errors: [...] }.
//
// Note: the existing test type keywords have inline assertion logic with
// per-field PASS/FAIL console logs. This helper is exposed for reuse but is
// not currently called by the keywords (behavior preservation).
export function validateComputedFields(computedFields, assertions) {
  const errors = [];
  for (const { key, expected, tripled, tolerance } of assertions) {
    const actual = computedFields[key];
    const tol = tolerance || 0.001;
    const pass = typeof actual === 'number' && Math.abs(actual - expected) < tol;
    const isTripled = tripled != null && typeof actual === 'number' && Math.abs(actual - tripled) < tol;
    if (isTripled) errors.push(`${key}=${actual} (3x detected)`);
    else if (!pass) errors.push(`${key}=${JSON.stringify(actual)}`);
  }
  return { errors };
}

// -- Cross-check validator (generic helper) -----------------------------------
//
// Validates crossCheckFindings array for name+address match === true.
// Used by dedup-gcash — exposed for reuse but kept inline in the keyword
// function to preserve console output.
export function validateCrossCheck(findings) {
  const errors = [];
  if (!Array.isArray(findings)) {
    errors.push('crossCheckFindings missing or not an array');
    return { errors };
  }
  for (const field of ['name', 'address']) {
    const entry = findings.find(f => f.field === field);
    if (!entry) { errors.push(`crossCheck: "${field}" entry not found`); continue; }
    if (!Array.isArray(entry.valuePrimary) || entry.valuePrimary.length === 0) errors.push(`crossCheck ${field}: valuePrimary is empty`);
    if (!Array.isArray(entry.valueSecondary) || entry.valueSecondary.length === 0) errors.push(`crossCheck ${field}: valueSecondary is empty`);
    if (entry.match !== true) errors.push(`crossCheck ${field}: match=${JSON.stringify(entry.match)}, expected true`);
  }
  return { errors };
}
