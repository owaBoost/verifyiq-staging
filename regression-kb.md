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
- Classification: Monitor
- Reason: Tampered and damaged IDs have degraded data quality. Null fraudScore
  on completed extraction may be by design but needs dev confirmation.
- First seen: 2026-04-10
- Last seen: 2026-04-16
- Recurrence: 2
- Notes: If confirmed by-design, reclassify to Expected / Known.
  If fraudScore should never be null when extraction completes, escalate.

### Legitimate Passport - fraudCheckFindings on false-positive fixture
- Fixtures: PASS-FRAUD-FP-001
- Warning text: '1 fraudCheckFinding(s) present on legitimate document'
- Classification: Monitor
- Reason: False positive fraud detection on legitimate passports. Two occurrences
  in the April 10 run suggest 2 of the legitimate passport fixtures triggered a
  finding. May indicate fraud threshold too sensitive.
- First seen: 2026-04-10
- Last seen: 2026-04-16
- Recurrence: 2
- Notes: If count increases (2+ findings per fixture), escalate to Needs
  Investigation and review fraud threshold config. Duplicate log entries
  (two identical warning lines for this fixture) have now persisted for 2
  consecutive runs. If duplicate entries recur on next run, file a separate
  pipeline logging bug.

### Tonik - transactionsOCR empty array
- Fixtures: BS-TONIK-001
- Warning text: 'transactionsOCR is empty array'
- Classification: Needs Investigation
- Reason: Empty transactionsOCR on a bank statement is unexpected.
  Recurred on 2nd consecutive run — escalated per KB recurrence rule.
- First seen: 2026-04-10
- Last seen: 2026-04-16
- Recurrence: 2
- Notes: Bug draft filed 2026-04-16. Tonik-specific parsing gap likely.

### ACR I-Card - missing ssrn field
- Fixtures: ACRI-001
- Warning text: 'missing ssrn (checked ssrn)'
- Classification: Monitor
- Reason: ssrn may not be present on all ACR I-Card variants.
  Needs developer confirmation on whether ssrn is always expected.
- First seen: 2026-04-10
- Last seen: 2026-04-16
- Recurrence: 2
- Notes: If confirmed as not always present, reclassify to Expected / Known.
  If recurs a 3rd time without dev confirmation, escalate to Needs Investigation.

---

## Fragile Fixtures

### PHILID-FRAUD-TAMPERED-001 and PHILID-FRAUD-DAMAGED-001
- Category: Fraud
- Known behavior: Tampered/damaged Philippine National IDs. Degraded quality
  causes inconsistent field extraction. id_number and pcn frequently absent.
- Watch for: fraudScore null - if recurs, confirm with dev if intentional.
- Last validated: 2026-04-16

### PASS-FRAUD-FP-001
- Category: Fraud
- Known behavior: Tests legitimate passports are NOT flagged as fraudulent.
  Threshold is fraudScore < 20 with no CRITICAL findings.
- Watch for: Findings escalating from 1 to 2+ per fixture, or CRITICAL findings.
  Also watch for duplicate log entries persisting.
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
after every run. Status: Stable (5+), New (<3), Watched (active Monitor),
Flagged (was Stable, now has new warning).

| Fixture ID | Category | Assertions | Clean Runs | Last Clean | Last Warning | Status |
|---|---|---|---|---|---|---|
| BS-BDO-001 | Bank / Financial | 2 | 2 | 2026-04-16 | - | New |
| BS-BPI-001 | Bank / Financial | 2 | 2 | 2026-04-16 | - | New |
| BS-GOTYME-001 | Bank / Financial | 2 | 2 | 2026-04-16 | - | New |
| BS-MAYA-001 | Bank / Financial | 2 | 2 | 2026-04-16 | - | New |
| BS-PNB-001 | Bank / Financial | 2 | 2 | 2026-04-16 | - | New |
| BS-UB-001 | Bank / Financial | 2 | 2 | 2026-04-16 | - | New |
| BS-DEEP-BDO-001 | Bank / Financial | 1 | 2 | 2026-04-16 | - | New |
| BS-DEEP-BPI-001 | Bank / Financial | 1 | 2 | 2026-04-16 | - | New |
| BS-DEEP-MAYA-001 | Bank / Financial | 1 | 2 | 2026-04-16 | - | New |
| CC-BDO-001 | Bank / Financial | 1 | 2 | 2026-04-16 | - | New |
| GCASH-TXN-001 | Bank / Financial | 3 | 2 | 2026-04-16 | - | New |
| BS-GCASH-001 | Bank / Financial | 3 | 2 | 2026-04-16 | - | New |
| BS-MAYA-EDGE-001 | Bank / Financial | 4 | 2 | 2026-04-16 | - | New |
| BS-METRO-001 | Bank / Financial | 3 | 2 | 2026-04-16 | - | New |
| BS-TONIK-001 | Bank / Financial | 3 | 0 | - | 2026-04-16 | Watched |
| BS-UBQE-001 | Bank / Financial | 3 | 2 | 2026-04-16 | - | New |
| GCASH-90180-001 | Bank / Financial | 1 | 2 | 2026-04-16 | - | New |
| DEDUP-GCASH-001 | Bank / Financial | 1 | 2 | 2026-04-16 | - | New |
| PS-001 | Employment | 3 | 2 | 2026-04-16 | - | New |
| PS-DEEP-001 | Employment | 1 | 2 | 2026-04-16 | - | New |
| PS-EDGE-001 | Employment | 4 | 2 | 2026-04-16 | - | New |
| PS-SAFC-001 | Employment | 4 | 2 | 2026-04-16 | - | New |
| COE-001 | Employment | 2 | 2 | 2026-04-16 | - | New |
| PS-GCASH-SM-001 | Employment | 7 | 0 | - | - | New |
| PS-GCASH-MO-001 | Employment | 6 | 0 | - | - | New |
| PHILID-001 | Identity / KYC | 2 | 2 | 2026-04-16 | - | New |
| DL-001 | Identity / KYC | 1 | 2 | 2026-04-16 | - | New |
| PASS-001 | Identity / KYC | 1 | 2 | 2026-04-16 | - | New |
| UMID-001 | Identity / KYC | 1 | 2 | 2026-04-16 | - | New |
| SSS-001 | Identity / KYC | 1 | 2 | 2026-04-16 | - | New |
| PHILHEALTH-001 | Identity / KYC | 1 | 2 | 2026-04-16 | - | New |
| NBI-001 | Identity / KYC | 1 | 2 | 2026-04-16 | - | New |
| PRC-001 | Identity / KYC | 1 | 2 | 2026-04-16 | - | New |
| ACRI-001 | Identity / KYC | 1 | 0 | - | 2026-04-16 | Watched |
| HDMF-001 | Identity / KYC | 1 | 2 | 2026-04-16 | - | New |
| POSTAL-001 | Identity / KYC | 1 | 2 | 2026-04-16 | - | New |
| VOTERS-001 | Identity / KYC | 1 | 2 | 2026-04-16 | - | New |
| DL-RAFI-001 | Identity / KYC | 3 | 2 | 2026-04-16 | - | New |
| PASS-RAFI-001 | Identity / KYC | 3 | 2 | 2026-04-16 | - | New |
| UMID-RAFI-001 | Identity / KYC | 3 | 2 | 2026-04-16 | - | New |
| PRC-RAFI-001 | Identity / KYC | 3 | 2 | 2026-04-16 | - | New |
| POSTAL-RAFI-001 | Identity / KYC | 2 | 2 | 2026-04-16 | - | New |
| PHILID-RAFI-001 | Identity / KYC | 3 | 2 | 2026-04-16 | - | New |
| ELEC-001 | Utility Bills | 2 | 2 | 2026-04-16 | - | New |
| PLDT-001 | Utility Bills | 1 | 2 | 2026-04-16 | - | New |
| ELEC-RAFI-001 | Utility Bills | 4 | 2 | 2026-04-16 | - | New |
| WATER-RAFI-001 | Utility Bills | 3 | 2 | 2026-04-16 | - | New |
| BIR-001 | KYB | 1 | 2 | 2026-04-16 | - | New |
| DTI-001 | KYB | 1 | 2 | 2026-04-16 | - | New |
| BIR-RAFI-001 | KYB | 3 | 2 | 2026-04-16 | - | New |
| PS-FRAUD-001 | Fraud | 1 | 2 | 2026-04-16 | - | New |
| PHILID-FRAUD-TAMPERED-001 | Fraud | 1 | 0 | - | 2026-04-16 | Watched |
| PHILID-FRAUD-DAMAGED-001 | Fraud | 1 | 0 | - | 2026-04-16 | Watched |
| DL-FRAUD-FP-001 | Fraud | 3 | 2 | 2026-04-16 | - | New |
| PASS-FRAUD-TAMPERED-001 | Fraud | 1 | 2 | 2026-04-16 | - | New |
| PASS-FRAUD-FP-001 | Fraud | 2 | 0 | - | 2026-04-16 | Watched |
| ELEC-FRAUD-001 | Fraud | 1 | 2 | 2026-04-16 | - | New |
| BIR-FRAUD-001 | Fraud | 1 | 2 | 2026-04-16 | - | New |
| HEALTH-001 | Infrastructure | 5 | 2 | 2026-04-16 | - | New |
| SEC-001 | Infrastructure | 3 | 2 | 2026-04-16 | - | New |
| CACHE-001 | Infrastructure | 2 | 2 | 2026-04-16 | - | New |
| CROSS-001 | Infrastructure | 1 | 2 | 2026-04-16 | - | New |
| BLS-001 | Infrastructure | 2 | 2 | 2026-04-16 | - | New |
| DEDUP-001 | Infrastructure | 1 | 2 | 2026-04-16 | - | New |

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
