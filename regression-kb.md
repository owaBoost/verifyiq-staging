---
name: regression-kb
description: Advisory knowledge base for VerifyIQ regression triage. Read at
  the start of every triage session. Contains known warning patterns, fixture
  registry with clean run history, fragile areas, and recurring issues.
  Advisory only - never overrides current run evidence.
---

# Regression Knowledge Base

Advisory context only. Update cadence: after each triage session via approved
proposals only. Staleness rule: warning pattern entries unconfirmed after 180 days.

---

## Warning Patterns

### Tampered/Damaged ID - fraudScore null + missing ID fields
- Fixtures: PHILID-FRAUD-TAMPERED-001, PHILID-FRAUD-DAMAGED-001
- Warning text: 'fraudScore is null (extraction complete, summaryOCR present)'
  'missing ID number/PCN (checked id_number, pcn)'
- Classification: Expected/Known
- Reason: Tampered and damaged IDs have degraded data quality. Null fraudScore
  and missing ID fields are consistent behavior — stable across 3 consecutive
  runs with no escalation. Auto-reclassified from Monitor per 3-run rule.
- First seen: 2026-04-10
- Last seen: 2026-04-16
- Recurrence: 3
- Notes: Reclassified to Expected/Known on run 3 (2026-04-16). If fraudScore
  behavior changes (non-null on tampered, or null on clean docs), re-escalate.

### Legitimate Passport - fraudCheckFindings on false-positive fixture
- Fixtures: PASS-FRAUD-FP-001
- Warning text: '1 fraudCheckFinding(s) present on legitimate document'
- Classification: Expected/Known
- Reason: Single finding on legitimate passport is stable across 3 consecutive
  runs with no count increase. Auto-reclassified from Monitor per 3-run rule.
- First seen: 2026-04-10
- Last seen: 2026-04-16
- Recurrence: 3
- Notes: Reclassified to Expected/Known on run 3 (2026-04-16). If count
  increases to 2+ findings per fixture, or CRITICAL findings appear, re-escalate
  to Needs Investigation. Duplicate log entries persist — pipeline logging bug
  drafted (bug-drafts/2026-04-16_PASS-FRAUD-FP-001-duplicate-log.md).

### Tonik - transactionsOCR empty array
- Fixtures: BS-TONIK-001
- Warning text: 'transactionsOCR is empty array'
- Classification: Needs Investigation
- Reason: Empty transactionsOCR on a bank statement is unexpected.
  3rd consecutive run — persistent Tonik-specific parsing gap.
- First seen: 2026-04-10
- Last seen: 2026-04-16
- Recurrence: 3
- Notes: Bug draft filed 2026-04-16. Tonik-specific parsing gap likely.
  Needs dev investigation into Tonik statement format handling.

### ACR I-Card - missing ssrn field
- Fixtures: ACRI-001
- Warning text: 'missing ssrn (checked ssrn)'
- Classification: Expected/Known
- Reason: ssrn not present on this ACR I-Card variant. Stable across 3
  consecutive runs with no escalation. Auto-reclassified from Monitor per
  3-run rule.
- First seen: 2026-04-10
- Last seen: 2026-04-16
- Recurrence: 3
- Notes: Reclassified to Expected/Known on run 3 (2026-04-16). If ssrn
  appears on a different ACR I-Card variant and is expected, re-evaluate.

### PASS-FRAUD-FP-001 - duplicate warning log entries
- Fixtures: PASS-FRAUD-FP-001
- Warning text: '1 fraudCheckFinding(s) present on legitimate document' (appears twice, identical)
- Classification: Known (pipeline bug)
- Reason: Regression runner emits two identical warning lines for this fixture.
  Cosmetic issue — does not affect test pass/fail.
- First seen: 2026-04-10
- Last seen: 2026-04-16
- Recurrence: 3
- Notes: Pipeline logging bug drafted (bug-drafts/2026-04-16_PASS-FRAUD-FP-001-duplicate-log.md).

### Hybrid status check — callback suppression fast-path
- Fixtures: all batch fixtures (applies to pollWebhookCallbacks globally)
- Warning text: 'Application callback suppressed — status COMPLETED verified via GET'
- Classification: Expected/Known
- Reason: 2026-05-22 — Added hybrid status check to pollWebhookCallbacks.
  When all doc callbacks are received but the app callback is missing
  (fraud score threshold breach causes suppression), the polling loop now
  immediately calls GET /api/v1/applications/{id}. If status is COMPLETED,
  the poll closes early instead of waiting the full 300s timeout. Eliminates
  ~5 min per suppressed fixture (8 fixtures x 5 min = ~40 min off full-suite).
- First seen: 2026-05-22
- Recurrence: 0 (infrastructure change, not a warning pattern per se)
- Notes: The 300s timeout fallback is preserved as a safety net for true
  failures. The log message text changed from the timeout-fallback version
  to include elapsed milliseconds.

### Callback identity field mismatch
- Fixtures: infra-callback-echo-publicuserid-numeric, infra-callback-echo-submissionid,
  infra-callback-echo-bearer-token, infra-callback-echo-publicuserid-uuid,
  infra-callback-echo-multidoc-batch
- Warning text: 'Callback response identity field (publicUserId/submissionId/
  Authorization) does not match the value in the originating BatchUploadRequest.'
- Classification: Needs Investigation
- Reason: Downstream clients rely on verbatim echo to correlate callbacks with
  their originating request. Any mutation is a contract break.
- First seen: 2026-04-17
- Related tickets: 86b9fkm0u
- Recurrence: 1
- Notes: Pattern covers publicUserId (numeric and UUID variants), submissionId,
  and Authorization header preservation across document-listener and
  application-listener callback endpoints. Authorization header is gateway-internal
  and not echoed in callback payloads. Pattern guards publicUserId and submissionId
  only. The bearer-token echo fixture tests coercion resistance via publicUserId.

### Document type mismatch signal inconsistency
- Fixtures: BATCH-WRONG-TYPE-001
- Classification: Needs Investigation
- First seen: 2026-05-22 (corrected analysis 2026-05-23)
- Recurrence: 1
- Description: The batch-upload pipeline detects DOCUMENT_TYPE_MISMATCH
  for all three tested doc types, but signals the result inconsistently:
    - PAYSLIP and ELECTRICITY_BILL: failureReason field (document-level)
    - BANK_STATEMENT: fraudChecks.gs_fraudCheckStatusReason_bankstatement
      (routed through fraud checks, flagged as gs_isFraudulent=1 even
      though fraud check was skipped)
  The detection logic works for all three. The contract is inconsistent
  — consumers must check different fields per doc type to handle the
  same logical event.
- Distinguishing signal: BANK_STATEMENT mismatch is
  gs_fraudCheckStatusReason_bankstatement === "document_type_mismatch" +
  gs_isFraudulent_bankstatement === 1 + fraudCheckFindings contains
  type "others_fraud" with "does not match the declared document type"
- Notes: BATCH-WRONG-TYPE-001 asserts per-docType signals — both cases PASS.

### Bank-deep posting_date format regression
- Fixtures: BS-DEEP-BDO-001, BS-DEEP-BPI-001, BS-DEEP-MAYA-001
- Warning text: 'posting_date "September 10, 2023" not YYYY-MM-DD' (varies per fixture)
- Classification: Needs Investigation
- Reason: Bank-deep single-parse runner validates posting_date format as YYYY-MM-DD
  but BDO, BPI, and Maya bank statements return non-ISO date formats from the API
  (e.g. "September 10, 2023", "Sep 16", "14 Nov, 06:33 PM"). These are API-side
  format inconsistencies, not runner bugs — the batch-deep variants (Metro, UB, GoTyme)
  return MM/DD/YYYY which the runner parses correctly.
- First seen: 2026-05-19
- Recurrence: 2+ (fires every full regression run)

### PS-QR-001 quality-reject runner summaryOCR check
- Fixtures: PS-QR-001
- Warning text: 'HTTP 200 but validation failed: missing or empty summaryOCR'
- Classification: Needs Investigation
- Reason: PS-QR-001 uses the quality-reject testType which validates via parseDocument.
  The blurry test document returns HTTP 200 but summaryOCR is empty/missing. The
  quality-reject runner should check qualityCheck fields (qualityCheckFindings,
  gs_overallQualityScore) rather than summaryOCR, since quality-rejected docs may
  legitimately have no summaryOCR. This is a runner assertion bug, not an API bug.
- First seen: 2026-04-16
- Recurrence: 3+ (fires every full regression run)

### Undocumented code-level warning patterns (audit 2026-05-23)
- Classification: Expected/Known (infrastructure — these fire in validators but
  are not regressions; they document known field gaps per document type)
- Warning paths in validators.mjs not previously tracked in KB:
  1. `missing fraudCheckFindings` (BankStatement validator, line 68) — fires when
     fraudCheckFindings absent on bank statements. Expected on non-fraud pipelines.
  2. `missing billing_period in summaryOCR` (ElectricUtilityBillingStatement
     validator, line 36) — fires when billing_period not extracted.
  3. `missing gs_amountdue_elecbill in gshare_fields` (ElectricUtilityBillingStatement
     validator, line 38) — fires when gshare amount due field absent.
  4. `document_type != GcashTransactionHistory` (GcashTransactionHistory validator,
     line 120) — fires when API returns mismatched documentType.
  5. `callback documentType mismatch` (validateDocumentCallback, line 321) — fires
     when callback documentType doesn't match submitted gateway type.
  6. `crossCheckFindings not present in app callback` (payslip-rules runner,
     line 1311) — fires when app callback lacks crossCheckFindings.
- First seen: pre-2026-04-16 (present in code since initial validators)
- Notes: These are code-level guards, not regression patterns. Tracked here for
  completeness per audit recommendation. No action required unless frequency changes.

### SSS-001 intermittent HTTP 503
- Fixtures: SSS-001
- Warning text: 'HTTP 503 -- "Service Unavailable"'
- Classification: Monitor
- Reason: SSSID document type returns HTTP 503 intermittently. KB previously
  recorded 3 clean runs (2026-04-16) but the 2026-05-23 full regression returned
  503. May be transient service unavailability or a docType-specific backend issue.
- First seen: 2026-05-23 (first observed 503; prior runs were clean)
- Recurrence: 1

---

## Fragile Fixtures

### PHILID-FRAUD-TAMPERED-001 and PHILID-FRAUD-DAMAGED-001
- Category: Fraud
- Known behavior: Tampered/damaged Philippine National IDs. Degraded quality
  causes inconsistent field extraction. id_number and pcn frequently absent.
  fraudScore is null — now classified as Expected/Known.
- Watch for: Any change in fraudScore behavior (non-null on tampered, or null
  on clean docs).
- Last validated: 2026-04-16

### PASS-FRAUD-FP-001
- Category: Fraud
- Known behavior: Tests legitimate passports are NOT flagged as fraudulent.
  Threshold is fraudScore < 20 with no CRITICAL findings. Single finding
  present — now classified as Expected/Known.
- Watch for: Findings escalating from 1 to 2+ per fixture, or CRITICAL findings.
- Last validated: 2026-04-16

---

## Recurring Issues

(No recurring issues logged yet - add entries after confirmed bug fixes)

Schema for each entry:
Issue name, fixture(s), warning pattern that indicates regression,
root cause, fixed PR/ticket + date, what to do if it reappears.

---

## Fixture Registry

Tracks all fixtures with clean run history. Update consecutive_clean_runs
after every run. Status: Stable (5+), New (not yet Stable), Watched (active Monitor),
Flagged (was Stable, now warning).

| Fixture ID | Category | Assertions | Clean Runs | Last Clean | Last Warning | Status |
|---|---|---|---|---|---|---|
| BS-BDO-001 | Bank / Financial | 2 | 4 | 2026-05-19 | - | New |
| BS-BPI-001 | Bank / Financial | 2 | 3 | 2026-04-16 | - | New |
| BS-GOTYME-001 | Bank / Financial | 2 | 3 | 2026-04-16 | - | New |
| BS-MAYA-001 | Bank / Financial | 2 | 3 | 2026-04-16 | - | New |
| BS-PNB-001 | Bank / Financial | 2 | 3 | 2026-04-16 | - | New |
| BS-UB-001 | Bank / Financial | 2 | 3 | 2026-04-16 | - | New |
| BS-DEEP-BDO-001 | Bank / Financial | 1 | 4 | 2026-05-19 | - | New |
| BS-DEEP-BPI-001 | Bank / Financial | 1 | 3 | 2026-04-16 | - | New |
| BS-DEEP-MAYA-001 | Bank / Financial | 1 | 3 | 2026-04-16 | - | New |
| BS-DEEP-METRO-001 | Bank / Financial | 3 | 0 | - | - | New |
| BS-DEEP-UB-001 | Bank / Financial | 3 | 0 | - | - | New |
| BS-DEEP-PNB-001 | Bank / Financial | 3 | 0 | - | 2026-05-21 | Watched |
| BS-DEEP-GOTYME-001 | Bank / Financial | 3 | 0 | - | - | New |
| CC-BDO-001 | Bank / Financial | 1 | 3 | 2026-04-16 | - | New |
| GCASH-TXN-001 | Bank / Financial | 3 | 3 | 2026-04-16 | - | New |
| BS-GCASH-001 | Bank / Financial | 3 | 3 | 2026-04-16 | - | New |
| BS-MAYA-EDGE-001 | Bank / Financial | 4 | 3 | 2026-04-16 | - | New |
| BS-METRO-001 | Bank / Financial | 3 | 3 | 2026-04-16 | - | New |
| BS-TONIK-001 | Bank / Financial | 3 | 0 | - | 2026-04-16 | Watched |
| BS-UBQE-001 | Bank / Financial | 3 | 3 | 2026-04-16 | - | New |
| GCASH-90180-001 | Bank / Financial | 1 | 3 | 2026-04-16 | - | New |
| DEDUP-GCASH-001 | Bank / Financial | 1 | 3 | 2026-04-16 | - | New |
| PS-001 | Employment | 3 | 3 | 2026-04-16 | - | New |
| PS-DEEP-001 | Employment | 1 | 3 | 2026-04-16 | - | New |
| PS-EDGE-001 | Employment | 4 | 3 | 2026-04-16 | - | New |
| PS-SAFC-001 | Employment | 4 | 3 | 2026-04-16 | - | New |
| COE-001 | Employment | 2 | 3 | 2026-04-16 | - | New |
| PS-TC001 | Employment | 7 | 0 | - | - | New |
| PS-TC003 | Employment | 6 | 0 | - | - | New |
| PS-GCASH-SM-001 | Employment | 7 | 0 | - | - | New |
| PS-GCASH-MO-001 | Employment | 6 | 0 | - | - | New |
| PHILID-001 | Identity / KYC | 2 | 4 | 2026-05-19 | - | New |
| DL-001 | Identity / KYC | 1 | 3 | 2026-04-16 | - | New |
| PASS-001 | Identity / KYC | 1 | 3 | 2026-04-16 | - | New |
| UMID-001 | Identity / KYC | 1 | 3 | 2026-04-16 | - | New |
| SSS-001 | Identity / KYC | 1 | 3 | 2026-04-16 | - | New |
| PHILHEALTH-001 | Identity / KYC | 1 | 3 | 2026-04-16 | - | New |
| NBI-001 | Identity / KYC | 1 | 3 | 2026-04-16 | - | New |
| PRC-001 | Identity / KYC | 1 | 3 | 2026-04-16 | - | New |
| ACRI-001 | Identity / KYC | 1 | 0 | - | 2026-04-16 | Watched |
| HDMF-001 | Identity / KYC | 1 | 3 | 2026-04-16 | - | New |
| POSTAL-001 | Identity / KYC | 1 | 3 | 2026-04-16 | - | New |
| VOTERS-001 | Identity / KYC | 1 | 3 | 2026-04-16 | - | New |
| DL-RAFI-001 | Identity / KYC | 3 | 3 | 2026-04-16 | - | New |
| PASS-RAFI-001 | Identity / KYC | 3 | 3 | 2026-04-16 | - | New |
| UMID-RAFI-001 | Identity / KYC | 3 | 3 | 2026-04-16 | - | New |
| PRC-RAFI-001 | Identity / KYC | 3 | 3 | 2026-04-16 | - | New |
| POSTAL-RAFI-001 | Identity / KYC | 2 | 3 | 2026-04-16 | - | New |
| PHILID-RAFI-001 | Identity / KYC | 3 | 3 | 2026-04-16 | - | New |
| ELEC-001 | Utility Bills | 2 | 3 | 2026-04-16 | - | New |
| PLDT-001 | Utility Bills | 1 | 3 | 2026-04-16 | - | New |
| ELEC-RAFI-001 | Utility Bills | 4 | 3 | 2026-04-16 | - | New |
| WATER-RAFI-001 | Utility Bills | 3 | 3 | 2026-04-16 | - | New |
| BIR-001 | KYB | 1 | 3 | 2026-04-16 | - | New |
| DTI-001 | KYB | 1 | 3 | 2026-04-16 | - | New |
| BIR-RAFI-001 | KYB | 3 | 3 | 2026-04-16 | - | New |
| PS-FRAUD-001 | Fraud | 1 | 3 | 2026-04-16 | - | New |
| PS-QR-001 | Fraud | 1 | 0 | - | - | Watched - runner bug (summaryOCR check) |
| PHILID-FRAUD-TAMPERED-001 | Fraud | 1 | 0 | - | 2026-04-16 | Watched |
| PHILID-FRAUD-DAMAGED-001 | Fraud | 1 | 0 | - | 2026-04-16 | Watched |
| DL-FRAUD-FP-001 | Fraud | 3 | 3 | 2026-04-16 | - | New |
| PASS-FRAUD-TAMPERED-001 | Fraud | 1 | 3 | 2026-04-16 | - | New |
| PASS-FRAUD-FP-001 | Fraud | 2 | 0 | - | 2026-04-16 | Watched |
| ELEC-FRAUD-001 | Fraud | 1 | 3 | 2026-04-16 | - | New |
| BIR-FRAUD-001 | Fraud | 1 | 3 | 2026-04-16 | - | New |
| HEALTH-001 | Infrastructure | 7 | 4 | 2026-05-19 | - | New |
| SEC-001 | Infrastructure | 3 | 4 | 2026-05-19 | - | New |
| CACHE-001 | Infrastructure | 2 | 4 | 2026-05-19 | - | New |
| CROSS-001 | Infrastructure | 1 | 3 | 2026-04-16 | - | New |
| BLS-CROSSVALIDATE-001 | Infrastructure | 1 | 0 | - | - | New |
| BLS-001 | Infrastructure | 2 | 3 | 2026-04-16 | - | New |
| DEDUP-001 | Infrastructure | 1 | 3 | 2026-04-16 | - | New |
| infra-callback-echo-publicuserid-numeric | Infrastructure | 1 | 1 | 2026-05-20 | - | New |
| infra-callback-echo-submissionid | Infrastructure | 1 | 1 | 2026-05-20 | - | New |
| infra-callback-echo-bearer-token | Infrastructure | 1 | 1 | 2026-05-20 | - | New |
| infra-callback-echo-publicuserid-uuid | Infrastructure | 1 | 1 | 2026-05-20 | - | New |
| infra-callback-echo-multidoc-batch | Infrastructure | 1 | 1 | 2026-05-20 | - | New |
| BS-CONTRACT-PAGECOUNT-001 | Contract Negative | 0 | 1 | 2026-05-19 | - | New |
| BS-CONTRACT-MULTIACCOUNT-001 | Contract Negative | 0 | 1 | 2026-05-19 | - | New |
| UMID-CONTRACT-MEGAPIXEL-001 | Contract Negative | 0 | 1 | 2026-05-19 | - | New |
| MAYORS-001 | KYB | 2 | 1 | 2026-05-19 | - | New |
| SEC-CERT-001 | KYB | 2 | 1 | 2026-05-19 | - | New |
| BIREXEMPT-001 | KYB | 1 | 1 | 2026-05-19 | - | New |
| API-APP-LIFECYCLE-001 | Infrastructure | 2 | 0 | - | - | New |
| API-DOC-LIFECYCLE-001 | Infrastructure | 3 | 0 | - | - | New |
| API-BATCH-LIFECYCLE-001 | Infrastructure | 2 | 0 | - | - | New |
| API-SEC-NEGATIVE-001 | Infrastructure | 11 | 0 | - | - | New |
| API-ACTIVITIES-001 | Infrastructure | 1 | 0 | - | - | New |
| EXPORT-APP-001 | Infrastructure | 1 | 0 | - | - | New |
| EXPORT-DOC-001 | Infrastructure | 1 | 0 | - | - | New |
| CACHE-CHECK-001 | Infrastructure | 2 | 0 | - | - | New |
| BATCH-QR-RANDOM-001 | Contract Negative | 3 | 0 | - | - | New |
| BATCH-WRONG-TYPE-001 | Contract Negative | 2 | 1 | 2026-05-23 | - | Watched |

---

## Fixture Details

### PS-GCASH-SM-001
- Description: GCash Payslip — Semi-Monthly, Blade Asia Inc., 6 payslips
- Category: Employment
- Employee: GARCIA, MARIA S.
- Employer: BLADE ASIA, INC.
- Pay Frequency: Semi-monthly
- Coverage: 2026-01-01 to 2026-03-31
- applicationId (staging): 3b90d7a9-90fd-491e-99e1-42b18d16055b
- ClickUp: https://app.clickup.com/t/86b9e4h08
- Staleness: Payslip dates go stale ~Sep 2026
- GCS Files (Staging):
  gs://verifyiq-internal-testing/QA/Gcash/Payslip/Blade Asia_Maria Garcia Payslip_2026-01-15.pdf
  gs://verifyiq-internal-testing/QA/Gcash/Payslip/Blade Asia_Maria Garcia Payslip_2026-01-31.pdf
  gs://verifyiq-internal-testing/QA/Gcash/Payslip/Blade Asia_Maria Garcia Payslip_2026-02-15.pdf
  gs://verifyiq-internal-testing/QA/Gcash/Payslip/Blade Asia_Maria Garcia Payslip_2026-02-28.pdf
  gs://verifyiq-internal-testing/QA/Gcash/Payslip/Blade Asia_Maria Garcia Payslip_2026-03-15.pdf
  gs://verifyiq-internal-testing/QA/Gcash/Payslip/Blade Asia_Maria Garcia Payslip_2026-03-31.pdf
- Assertions (7):
  gs_180days_valid_payslip          = 1
  gs_90days_consec_payslip          = 1
  gs_90days_oneemployer_payslip     = 1
  gs_90days_gross_payslip           = 60164.10
  gs_90days_onetime_payslip         = 4500.00
  gs_90days_personalexpense_payslip = 38426.26
  gs_inferredincome_payslip         = 7245.95

### PS-GCASH-MO-001
- Description: GCash Payslip — Monthly, Alorica Teleservices Inc., 3 payslips
- Category: Employment
- Employee: MARIA SANTOS GARCIA
- Employer: Alorica Teleservices, Inc.
- Pay Frequency: Monthly
- Coverage: 2026-01-01 to 2026-03-31
- ClickUp: https://app.clickup.com/t/86b9e4h4v
- Staleness: Payslip dates go stale ~Sep 2026
- Bucket migrated 2026-04-16: from gs://test-ai-docs-data-dev/qa-test-data/gcash/payslip/
  to gs://verifyiq-internal-testing/QA/Gcash/
- GCS Files (Staging):
  gs://verifyiq-internal-testing/QA/Gcash/Payslip_January2026_MARIA_SANTOS_GARCIA.pdf
  gs://verifyiq-internal-testing/QA/Gcash/Payslip_February2026_MARIA_SANTOS_GARCIA.pdf
  gs://verifyiq-internal-testing/QA/Gcash/Payslip_March2026_MARIA_SANTOS_GARCIA.pdf
- Assertions (6):
  gs_180days_valid_payslip      = 1
  gs_90days_consec_payslip      = 1
  gs_90days_oneemployer_payslip = 1
  gs_90days_gross_payslip       = 86795.62
  gs_90days_onetime_payslip     = 0
  gs_inferredincome_payslip     = 10145.11
- Notes:
  No overtime on any payslip — gs_90days_onetime_payslip must always be 0
  SSS MPF (₱500) captured as otherDeductionAmount — correctly treated as govt contribution
  PhilHealth and HDMF are ₱0 — handled at employer level

### infra-callback-echo-publicuserid-numeric
- Description: Callback echo — numeric publicUserId round-trip (GCash GGIVES repro)
- Category: Infrastructure
- origin_ticket: 86b9fkm0u
- regression_for: PublicUserId mismatch in OCR callback response
- Notes: Guards GCash GGIVES numeric publicUserId round-trip. Do not
  normalize or mutate publicUserId at any callback hop.

### infra-callback-echo-submissionid
- Description: Callback echo — submissionId preserved in callback response
- Category: Infrastructure
- origin_ticket: 86b9fkm0u

### infra-callback-echo-bearer-token
- Description: Tests coercion-free string round-tripping using a Bearer-format publicUserId
  value. The gateway does not echo the Authorization header (it is
  webhook-server-internal IAP only). echoField: publicUserId,
  echoValue: Bearer regression-echo-verbatim.
- Category: Infrastructure
- origin_ticket: 86b9fkm0u

### infra-callback-echo-publicuserid-uuid
- Description: Callback echo — UUID publicUserId round-trip
- Category: Infrastructure
- origin_ticket: 86b9fkm0u

### infra-callback-echo-multidoc-batch
- Description: Callback echo — multi-document batch (4 docs, 3 PAYSLIP + 1 BANK_STATEMENT)
- Category: Infrastructure
- origin_ticket: 86b9fkm0u
- Notes: Mirrors exact GCash repro (4 docs, 3 PAYSLIP + 1 BANK_STATEMENT).
  Uses skipAppCallback — validates 4 doc-listener callbacks only.

---

## API Endpoint Notes

### Endpoints unavailable on staging as of 2026-05-22
Per Wave 6 probe (no nell-cmyk/verifyiq-smoke access during session — probed
staging directly):

Not available:
- GET /api/v1/applications/search — no search endpoint exists
- GET /api/v1/applications/{id}/documents/{docId} — single-doc GET unavailable
  (must use list /documents and filter)
- GET /ai-gateway/batch-upload/{id}/status — batch status endpoint
- GET /ai-gateway/batch-upload/{id}/result — batch result endpoint

Available (covered by Wave 6–8 fixtures):
- GET /api/v1/applications/{id}
- GET /api/v1/applications/  (list)
- GET /api/v1/applications/{id}/documents  (list)
- GET /api/v1/applications/{appId}/documents/{docId}/pages  (app-scoped; /api/v1/documents/{docId}/pages does NOT exist)
- POST /api/v1/applications/{appId}/documents/{docId}/reprocess  (app-scoped; /api/v1/documents/{docId}/reprocess does NOT exist)
- GET /api/v1/activities  (audit log; returns {items, meta}; wave 8)
- POST /ai-gateway/health  (gateway health; GET returns 405, must POST; wave 8)
- GET {WEBHOOK_SERVER_URL}/health  (webhook server health; wave 8)
- GET /api/v1/applications/{id}/export  (app-level export; returns JSON with applicationId, status, ocrResult; wave 8b)
- GET /api/v1/applications/{id}/documents/{docId}/export  (doc-level export; returns JSON with Content-Disposition attachment; wave 8b)
- POST /v1/documents/check-cache  (dedicated cache check; batch format {items} and legacy {file, fileType}; wave 8b)
- GET /openapi.json  (OpenAPI 3.1.0 spec; covers /v1/* and /health/* only — /api/v1/* and /ai-gateway/* are separate services; wave 8b)
- GET /docs, GET /redoc  (Swagger UI and ReDoc HTML; wave 8b)

Skipped (destructive per smoke convention):
- DELETE /v1/documents/cache  (invalidate cache; exists per OpenAPI spec)
- DELETE /v1/documents/cache/ocr  (invalidate OCR cache; exists per OpenAPI spec)

Note: Document IDs differ between callbacks (client-generated UUID) and the
API list endpoint (server-assigned). Resolve via list endpoint when querying
by docId.

Note: GET /applications/{id} returns no `status` field. Fields present:
applicationId, fullName, partnerName, source, documentsCount,
underReviewDocumentsCount, approvedDocumentsCount, rejectedDocumentsCount,
createdAt, lastActivity. Documents stay `underReview` even after callback
processing completes — approval is a separate step.

### Quality-reject callback path (Wave 9, 2026-05-23)

Quality-reject path: failureReason='QUALITY_REJECTED' with status='COMPLETED'
(not FAILED), documentData undefined (not null), qualityCheck populated under
ocrResult.qualityCheck (not at root). App callback IS suppressed (same as
fraud threshold breach — hybrid status-check fallback needed).

Quality score field prefixes per gateway documentType:
- BANK_STATEMENT → gs_overallQualityScore_bankStatement (camelCase)
- PAYSLIP → gs_overallQualityScore_payslip
- ELECTRICITY_BILL → gs_overallQualityScore_elecbill

When a single random image is submitted as all 3 docTypes in one batch,
each callback correctly returns its own documentType and prefix.
When submitted individually, all 3 return BANK_STATEMENT (gateway normalizes
single-doc uploads to BANK_STATEMENT regardless of submitted type).

qualityCheckFindings example:
  [{type: "others", status: "failed", description: "Image does not appear to contain a valid document."}]

### Document type mismatch path (Wave 9b, 2026-05-23)

When a valid document is submitted as the wrong documentType in a multi-doc
batch via POST /ai-gateway/batch-upload, the batch-upload pipeline returns
failureReason='DOCUMENT_TYPE_MISMATCH' with status='COMPLETED', documentData
undefined.

Behavior by submitted type (using a valid electricity bill as test doc):
- As PAYSLIP → DOCUMENT_TYPE_MISMATCH (correctly rejected)
- As ELECTRICITY_BILL → no failure (correctly accepted)
- As BANK_STATEMENT → no failure (batch-upload pipeline is permissive for
  BANK_STATEMENT — the BankStatement extractor runs against the wrong
  document and emits partial data with null fields and low completenessScore)

Note: single-doc batch uploads normalize all types to BANK_STATEMENT at the
gateway level. DOCUMENT_TYPE_MISMATCH only fires in multi-doc batches where
the gateway preserves the submitted documentType per document.

App callback is suppressed for wrong-type batches (same hybrid fallback).

Minor contract anomalies in the same response (Wave 9b, 2026-05-23):
- statementPeriodStart/End returned as Excel-style serial dates (e.g. 46049,
  46079) not ISO format
- Mixed casing in field names: gs_overallQualityScore_bankStatement (camelCase)
  vs gs_isFraudulent_bankstatement (lowercase) in the same response
- gs_fraudCheckStatus="skipped" but gs_isFraudulent=1 — flagged fraudulent
  despite skipped fraud check (because of type mismatch routing through
  fraud checks layer)

### Non-standard contract behavior on staging (2026-05-22)
Discovered during Wave 7 negative endpoint probing:
- Missing X-Tenant-Token returns 422 (Unprocessable Entity), not 401.
  API uses validation-error semantics for missing auth headers rather than
  standard auth-error semantics.
- POST /reprocess with non-existent docId returns 403, not 404. This may
  leak existence information (attacker can infer whether a docId exists by
  observing 403 vs 200/400 responses).
- GET /applications/{id}/documents with bad applicationId returns 200 with
  empty list, not 404. Cannot detect bad app IDs via this endpoint.
- GET /v1/documents/fraud-status/{id} has no auth enforcement — returns 404
  for any caller, even unauthenticated. Potential information disclosure
  if endpoint becomes functional.

These are not regression bugs but contract design concerns worth surfacing
to the API team.

### Negative-case response codes (Wave 7 probe, 2026-05-23)

Staging does NOT return 401 for missing auth. All /api/v1/* endpoints return
**422** ("X-Tenant-Token required") when no auth headers are provided.

| Endpoint | Case | Expected (spec) | Actual (staging) |
|----------|------|-----------------|------------------|
| GET /api/v1/applications/{id} | bad ID | 404 | 404 |
| GET /api/v1/applications/{id} | no auth | 401 | 422 |
| GET /api/v1/applications/{id} | wrong key | 403 | 403 |
| GET /api/v1/applications/ | no auth | 401 | 422 |
| GET /api/v1/applications/ | wrong key | 403 | 403 |
| GET /api/v1/applications/{id}/documents | bad ID | 404 | 200 (empty list) |
| GET /api/v1/applications/{id}/documents | no auth | 401 | 422 |
| GET /api/v1/applications/{appId}/documents/{docId}/pages | bad IDs | 404 | 404 |
| GET /api/v1/applications/{appId}/documents/{docId}/pages | no auth | 401 | 422 |
| POST /api/v1/applications/{appId}/documents/{docId}/reprocess | bad IDs | 404 | 403 |
| POST /api/v1/applications/{appId}/documents/{docId}/reprocess | no auth | 401 | 422 |

### Wave 8 endpoint discovery (2026-05-23)

Probed staging for uncovered endpoints beyond wave 6–7 coverage:

Discovered (covered by new fixtures):
- GET /api/v1/activities — audit log endpoint, returns paginated activity items
  (DOCUMENT_CREATED, etc.) per tenant. Filter param ?application_id= is
  ignored — returns all activities regardless. HEALTH-001 expanded to include
  POST /ai-gateway/health and GET {WEBHOOK}/health.

Discovered (not fixture-worthy):
- POST /v1/documents/crosscheck — exists, requires previousDocumentsData field;
  already covered by BLS-CROSSVALIDATE-001 via batch upload path
- POST /api/v1/cross-validate — exists, requires real applicationId; already
  covered by BLS-CROSSVALIDATE-001
- POST /api/v1/applications/ — exists, requires documents[] array; app creation
  is via this endpoint (same as batch upload path)
- GET /ai-gateway/health — returns 405 (GET not allowed), must use POST
- GET {WEBHOOK}/token/{id} — returns specific 404 "Token not found" (endpoint
  exists but no persistent token listing)

Confirmed dead-end (generic 404):
- GET /ai-gateway/applications/{id}, /batch-upload/{id}, /documents, /config
- GET /api/v1/documents/{id} (single doc GET — confirmed missing, wave 6 finding)
- GET /api/v1/document-types, /documents/, /tenants/me, /stats, /usage
- GET /v1/health, /v1/documents/types
- GET {WEBHOOK}/tokens

---

## Pending

- TC-ELEC-03 / TC-ELEC-04: fixtures confirmed in GCS, not yet in suite. Blocked on elecbill-rules runner (PRIMARY bank statement + SUPPORTING electricity bill assembly, extract computedFields.ELECTRICITY_BILL.data.gs_180days_valid_elecbill). Wire in when runner is ready.
- PS-FRAUD-ASYNC-001: async fraud-status endpoint partially deployed on staging as of 2026-05-23. GET /v1/documents/fraud-status/{id} exists (returns 404 "Fraud job not found or expired." for bad ID, 405 for POST). No submit endpoint found (POST /v1/documents/fraud-check → generic 404). Blocked — no way to trigger async fraud job.
