VerifyIQ Staging Regression — 2026-04-16 07:34 UTC
Result: ALL PASSED
Score: 121/121 assertions
Fixtures: 62/62 passed
Duration: 37m 6s

Bank / Financial — 18/18
- BS-BDO-001 — BDO bank statement — default parse + batch upload (2/2)
- BS-BPI-001 — BPI bank statement — default parse + batch upload (2/2)
- BS-GOTYME-001 — GoTyme bank statement — default parse + batch upload (2/2)
- BS-MAYA-001 — Maya Savings bank statement — default parse + batch upload (2/2)
- BS-PNB-001 — PNB bank statement — default parse + batch upload (2/2)
- BS-UB-001 — UnionBank bank statement — default parse + batch upload (2/2)
- BS-DEEP-BDO-001 — BDO bank statement — deep transaction + calculated field validation (1/1)
- BS-DEEP-BPI-001 — BPI bank statement — deep transaction + calculated field validation (1/1)
- BS-DEEP-MAYA-001 — Maya bank statement — deep transaction + calculated field validation (1/1)
- CC-BDO-001 — BDO credit card statement — default parse (1/1)
- GCASH-TXN-001 — GCash transaction history — default parse + batch upload (3/3)
- BS-GCASH-001 — GCash bank statement files from QA/Gcash — happy path (3/3)
- BS-MAYA-EDGE-001 — Maya edge cases — null date rows, compact dates, date reversals (4/4)
- BS-METRO-001 — Metrobank bank statement — default parse (3/3)
- BS-TONIK-001 — Tonik bank statement — single and multi account (3/3)
- BS-UBQE-001 — UnionBank (UB) existing QA bank statements (3/3)
- GCASH-90180-001 — 91-day GCash statement — asserts gs_90days_consec=1 and gs_180days_valid=1 (1/1)
- DEDUP-GCASH-001 — GCash dedup — same BPI statement 3x + supporting doc. Asserts totals not multiplied by 3 (1/1)

Employment — 5/5
- PS-001 — Payslip default parse — PS-002 and PS-013 (3/3)
- PS-DEEP-001 — Payslip deep validation — gross/net pay, SSS deduction, completeness (1/1)
- PS-EDGE-001 — Payslip edge cases — zero deductions, null deductions, zero gross (4/4)
- PS-SAFC-001 — SAFC payslips — multiple employer variants (4/4)
- COE-001 — Certificate of Employment — default parse (2/2)

Identity / KYC — 18/18
- PHILID-001 — Philippine National ID — default parse (2/2)
- DL-001 — Driver's License — default parse (1/1)
- PASS-001 — Passport — default parse (1/1)
- UMID-001 — UMID — default parse (1/1)
- SSS-001 — SSS ID — default parse (1/1)
- PHILHEALTH-001 — PhilHealth ID — default parse (1/1)
- NBI-001 — NBI Clearance — default parse (1/1)
- PRC-001 — PRC ID — default parse (1/1)
- ACRI-001 — ACR I-Card — default parse (1/1)
- HDMF-001 — HDMF / Pag-IBIG ID — default parse (1/1)
- POSTAL-001 — Postal ID — default parse (1/1)
- VOTERS-001 — Voter's ID — default parse (1/1)
- DL-RAFI-001 — Driver's license — rafi staging various-ids, 3 high-quality samples (3/3)
- PASS-RAFI-001 — Passport — rafi staging various-ids, 3 high-quality samples (3/3)
- UMID-RAFI-001 — UMID — rafi staging various-ids, 3 high-quality samples (3/3)
- PRC-RAFI-001 — PRC ID — rafi staging various-ids, all 3 corrected samples (3/3)
- POSTAL-RAFI-001 — Postal ID — rafi staging various-ids, 2 high-quality samples (2/2)
- PHILID-RAFI-001 — Philippine National ID — rafi staging various-ids, 3 correctly classified samples (3/3)

Utility Bills — 4/4
- ELEC-001 — Meralco electric bill — default parse (2/2)
- PLDT-001 — PLDT telco bill — default parse (1/1)
- ELEC-RAFI-001 — Meralco electric bill — rafi staging batch, 3 high-quality samples (4/4)
- WATER-RAFI-001 — Water utility bill — rafi staging batch, 3 high-quality samples (3/3)

KYB — 3/3
- BIR-001 — BIR Form 2303 — default parse (1/1)
- DTI-001 — DTI Registration Certificate — default parse (1/1)
- BIR-RAFI-001 — BIR Form 2303 — rafi staging batch, 3 high-quality samples (3/3)

Fraud — 8/8
- PS-FRAUD-001 — Payslip fraud detection — undertime fraud test document (1/1)
- PHILID-FRAUD-TAMPERED-001 — Philippine National ID — tampered QR fraud detection (1/1)
- PHILID-FRAUD-DAMAGED-001 — Philippine National ID — damaged QR fraud detection (1/1)
- DL-FRAUD-FP-001 — Driver's License — false positive fraud check (expect fraudScore < 30) (3/3)
- PASS-FRAUD-TAMPERED-001 — Passport — tampered document (Marlon Raquel). Expect fraudScore > 20 + CRITICAL finding. (1/1)
- PASS-FRAUD-FP-001 — Passport — false positive check. Legitimate passports should NOT be flagged. (2/2)
- ELEC-FRAUD-001 — Meralco electric bill — fraud detection (GIMP metadata fraud) (1/1)
- BIR-FRAUD-001 — BIR Form 2303 — manipulated document fraud detection (1/1)

Infrastructure — 6/6
- HEALTH-001 — Health endpoints — startup, live, ready, detailed, circuit breakers (5/5)
- SEC-001 — Security headers + auth (200, 401, 403) (3/3)
- CACHE-001 — Cache hit validation — parse same doc twice, assert fromCache (2/2)
- CROSS-001 — Cross-document validation — strict crossCheckFindings assertions (1/1)
- BLS-001 — BLS application endpoints — GET + POST /api/v1/applications/* (2/2)
- DEDUP-001 — Deduplication — same file 3x in one batch, assert no tripling (1/1)

No failures

Warnings (8):
- [Bank / Financial] BS-TONIK-001: transactionsOCR is empty array
- [Fraud] PHILID-FRAUD-TAMPERED-001: missing ID number/PCN (checked id_number, pcn)
- [Fraud] PHILID-FRAUD-TAMPERED-001: fraudScore is null (extraction complete, summaryOCR present)
- [Fraud] PHILID-FRAUD-DAMAGED-001: missing ID number/PCN (checked id_number, pcn)
- [Fraud] PHILID-FRAUD-DAMAGED-001: fraudScore is null (extraction complete, summaryOCR present)
- [Fraud] PASS-FRAUD-FP-001: 1 fraudCheckFinding(s) present on legitimate document
- [Fraud] PASS-FRAUD-FP-001: 1 fraudCheckFinding(s) present on legitimate document
- [Identity / KYC] ACRI-001: missing ssrn (checked ssrn)

ClickUp: Regression 2026-04-16
