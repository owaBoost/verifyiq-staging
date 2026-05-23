# Test Case Validation Audit Report

**Date:** 2026-05-23
**Suite size:** 93 fixtures across 21 testTypes
**KB registry:** 92 fixtures (1 missing: PS-QR-001)

---

## Executive Summary

**Top issues to address (ranked by impact):**

1. **BLS-001 accepts HTTP 404 as PASS** — masks endpoint removal. Both endpoints in the fixture treat 404 as "exists". This is a logic bug, not a design choice.

2. **EXPORT fixtures are structure-only** — EXPORT-APP-001 and EXPORT-DOC-001 assert field presence (applicationId, status, ocrResult exist) but never validate content. An empty `ocrResult: {}` would pass.

3. **CACHE-CHECK-001 passes on empty results** — `items: []` with `cached_count: 0` satisfies all assertions. No check that the submitted file actually has a cache entry.

4. **6 undocumented warning patterns in runners** — code fires warnings for conditions not tracked in KB Warning Patterns (e.g., missing fraudCheckFindings on non-fraud fixtures, missing billing_period on electricity bills).

5. **PS-QR-001 missing from KB Fixture Registry** — the only fixture not tracked.

6. **SSS-001 HTTP 503 not documented** — KB shows 3 clean runs (2026-04-16) but the latest full run returned 503 "Service Unavailable".

---

## Check 1: Export Fixtures — Value Validation vs Structure-Only

### EXPORT-APP-001

| Assertion | Type | Detail |
|-----------|------|--------|
| HTTP 200 | value-validating | Strict status check |
| assertApplicationIdMatch | **value-validating** | `response.applicationId === seededApplicationId` (strict ===) |
| requiredFields: applicationId | structure-only | Checks `!== undefined && !== null` only |
| requiredFields: status | structure-only | Presence check only |
| requiredFields: ocrResult | structure-only | Presence check only — `ocrResult: {}` would pass |

**Verdict:** 1 value-validating assertion (applicationId match), 3 structure-only. No validation of ocrResult content (computedFields, crossCheckFindings, summaryOCR).

### EXPORT-DOC-001

| Assertion | Type | Detail |
|-----------|------|--------|
| HTTP 200 | value-validating | Strict status check |
| needsDocId | value-validating | Fails if docId couldn't be resolved from list endpoint |
| assertApplicationIdMatch | **value-validating** | Strict equality |
| requiredFields: applicationId | structure-only | Presence only |
| requiredFields: documentId | structure-only | Presence only — does NOT verify it matches the seeded docId |
| requiredFields: status | structure-only | Presence only |
| requiredFields: documentType | structure-only | Presence only |
| requiredFields: ocrResult | structure-only | Presence only |

**Verdict:** 2 value-validating (applicationId match, needsDocId gate), 5 structure-only. `documentId` presence is checked but NOT compared to the seeded docId. No validation of ocrResult.documentData, transactions, or fraudChecks content.

**Recommendations:**
- Add `"assertDocumentIdMatch": true` (new assertion type needed)
- Add nested requiredFields: `"ocrResult.documentData"`, `"ocrResult.documentType"`
- Consider asserting `status === "COMPLETED"` rather than just presence

---

## Check 2: Endpoint Chaining — Real IDs vs Hardcoded

### Summary

| Fixture | applicationId source | docId source | Chained correctly? |
|---------|---------------------|-------------|-------------------|
| API-APP-LIFECYCLE-001 | batchResult.body.applicationId | N/A | Yes |
| API-DOC-LIFECYCLE-001 | batchResult.body.applicationId | callListDocuments[0].id | Yes |
| API-BATCH-LIFECYCLE-001 | batchResult.body.applicationId | N/A | Yes |
| API-ACTIVITIES-001 | batchResult.body.applicationId | N/A | Yes |
| EXPORT-APP-001 | batchResult.body.applicationId | N/A | Yes |
| EXPORT-DOC-001 | batchResult.body.applicationId | callListDocuments[0].id | Yes |
| BLS-CROSSVALIDATE-001 | batchResult.body.applicationId | N/A (uses app-level cross-validate) | Yes |
| BATCH-QR-RANDOM-001 | batchResult.body.applicationId | randomUUID() (client-side) | Yes |
| BATCH-WRONG-TYPE-001 | batchResult.body.applicationId | randomUUID() (client-side) | Yes |
| API-SEC-NEGATIVE-001 | 00000000-0000-0000-0000-000000000000 | Same null UUID | Yes (intentional for negative testing) |

**Finding:** All fixtures use real, server-generated IDs from staging. No fixture incorrectly uses hardcoded IDs where dynamic ones should be used. API-SEC-NEGATIVE-001 correctly uses null UUIDs for negative testing (documented in code comments).

**One gap:** EXPORT-DOC-001 resolves docId via `callListDocuments(applicationId).body.items[0].id` (real server-assigned ID) but does NOT assert the exported `documentId` matches this resolved ID. The `requiredFields` check only verifies presence.

---

## Check 3: Tenant Key Consistency

**Finding: CLEAN.** No deviations.

| Pattern | Location | Status |
|---------|----------|--------|
| X-Tenant-Token from env var | createApiClient() in src/utils.mjs:148-175 | Standard |
| Authorization from env var | Same function, `Bearer ${key}` | Standard |
| Wrong-key value | `sk_wrong_key_12345` in SEC-001 (line 408) and API-SEC-NEGATIVE-001 (line 2001) | Consistent |
| No hardcoded keys in fixtures | regression-suite.json scanned | Clean |
| No hardcoded keys in runners | src/keywords.mjs scanned | Only `sk_wrong_key_12345` for negative testing |

Echo fixtures use test values (numeric IDs, UUIDs, bearer token strings) — all intentional test data, no production credentials.

---

## Check 4: Assertion Strength Sweep

### Assertion count by testType

| testType | Fixtures | Assertion strategy | Strength | Notes |
|----------|----------|-------------------|----------|-------|
| default | 43 | HTTP 200 + schema validator + batch callbacks | Medium | Schema validators in validators.mjs check field presence/format |
| fraud | 7 | Parse + fraudScore numeric + expectFraud logic | Medium | Checks score thresholds and finding counts |
| bank-deep | 3 | posting_date YYYY-MM-DD + deep field extraction | Medium | In-code format validation |
| bank-deep-batch | 4 | calculated_debits/credits with +/-0.01 tolerance | Strong | Numeric tolerance assertions on 3 of 4 fixtures |
| payslip-rules | 2 | 3 exact-value + 4 numeric + availability flags + crossCheck | Strong | Robust in-code assertions despite 0 fixture-level config |
| payslip-deep | 1 | gross_pay, net_pay, SSS, completenessScore presence | Weak | Presence only, no value bounds |
| gcash-rules | 1 | gs_90days_consec===1, gs_180days_valid===1 | Medium | Exact-value checks in runner code |
| health | 1 | 7 endpoints: status 200 + field-specific checks | Medium | Redis health is warn-only (non-blocking) |
| security | 1 | 3 checks: headers + 401 + 403 | Strong | |
| cache | 1 | fromCache===true on 2nd parse | Weak | No timing assertion |
| api-endpoints | 6 | requiredFields + expectedStatus + applicationId match | Medium | Structure-only for nested fields |
| api-security | 1 | 11 cases with expected HTTP status | Strong | |
| cache-check | 1 | Response shape: items[], cached_count, is_cached | Weak | Passes on empty results |
| contract-negative | 3 | expectedError substring match | Medium | |
| crosscheck-deep | 1 | crossCheckFindings field/match/riskLevel assertions | Strong | |
| cross-validate | 1 | tier2 address=fail assertion | Strong | |
| callback-echo | 5 | Round-trip echo of publicUserId/submissionId/auth | Strong | |
| dedup / dedup-gcash | 2 | Callback validation + dedup detection | Medium | Checks dedup, not totals |
| bls | 1 | GET /applications/ + /upload-urls | **Weak-Critical** | Accepts 404 as PASS |
| quality-reject | 1 | qualityCheck not null + documentData null | Weak | No quality score threshold |
| batch-quality-reject | 1 | QUALITY_REJECTED + qualityCheckFindings[0].status=failed | Medium | |
| batch-wrong-type | 1 | Per-docType mismatch signal assertions | Strong | |

### Weakest fixtures requiring attention

| Fixture | Issue | Impact |
|---------|-------|--------|
| **BLS-001** | Accepts HTTP 404 as PASS for both endpoints | **Critical** — masks endpoint removal |
| **CACHE-CHECK-001** | `items: []` with `cached_count: 0` passes | Medium — no actual cache validation |
| **CACHE-001** | Only checks `fromCache===true`, no timing | Low — cache flag is the correct check |
| **PS-QR-001** | quality-reject: no qualityScore threshold assertion | Low — checks structure is sufficient |
| **EXPORT-APP-001** | 1 endpoint, 3 structure-only assertions | Medium — should validate ocrResult content |
| **EXPORT-DOC-001** | documentId not compared to seeded docId | Medium — missing value assertion |
| **PS-DEEP-001** | Only checks field presence, no numeric bounds | Low |
| **API-ACTIVITIES-001** | 1 assertion (items non-empty + contains appId) | Low — sufficient for its purpose |

### Tautological / trivially-passing assertions

- **BLS-001**: `status === 200 || status === 404` — passes whether endpoint exists or not
- **HEALTH-001 /health/startup,live,ready**: Accepts `'ok'` OR `'healthy'` OR just HTTP 200 — very permissive but reasonable for health checks
- **CACHE-CHECK-001 batch format**: Empty `items: []` satisfies `Array.isArray(items)` — trivially true

---

## Check 5: KB Pattern Alignment

### Watched fixture warnings — all verified

| Fixture | KB Warning | Runner fires it? | Verified |
|---------|-----------|------------------|----------|
| BS-TONIK-001 | transactionsOCR is empty array | validators.mjs:67 — BankStatement validator | Yes |
| PHILID-FRAUD-TAMPERED-001 | fraudScore null + missing ID/PCN | keywords.mjs:209 + validators.mjs:49 | Yes |
| PHILID-FRAUD-DAMAGED-001 | fraudScore null + missing ID/PCN | Same paths | Yes |
| PASS-FRAUD-FP-001 | 1 fraudCheckFinding on legitimate doc | keywords.mjs:239 | Yes |
| ACRI-001 | missing ssrn | validators.mjs:190 | Yes |
| BATCH-WRONG-TYPE-001 | Signal inconsistency | keywords.mjs:2234-2268 | Yes |
| BS-DEEP-PNB-001 | Missing transactions (batch deep) | keywords.mjs:1453 | Yes |

### Failures NOT documented in KB

| Fixture | Failure | Status in KB | Issue |
|---------|---------|-------------|-------|
| BS-DEEP-BDO-001 | posting_date "September 10, 2023" not YYYY-MM-DD | "New" (no warning) | Undocumented recurring failure |
| BS-DEEP-BPI-001 | posting_date "Sep 16" not YYYY-MM-DD | "New" (no warning) | Undocumented recurring failure |
| BS-DEEP-MAYA-001 | posting_date "14 Nov, 06:33 PM" not YYYY-MM-DD | "New" (no warning) | Undocumented recurring failure |
| PS-QR-001 | missing or empty summaryOCR | Not in KB at all | Missing from registry |
| SSS-001 | HTTP 503 "Service Unavailable" | "New" with 3 clean runs | 503 not documented |

### Undocumented warning patterns in code

These warning paths exist in validators/runners but have no KB Warning Pattern entry:

1. **`missing fraudCheckFindings`** — validators.mjs:68 (BankStatement validator)
2. **`missing billing_period in summaryOCR`** — validators.mjs:36 (ElectricUtilityBillingStatement)
3. **`missing gs_amountdue_elecbill in gshare_fields`** — validators.mjs:38
4. **`document_type != GcashTransactionHistory`** — validators.mjs:120
5. **`callback documentType mismatch`** — validators.mjs:321
6. **`crossCheckFindings not present in app callback`** — keywords.mjs:1311

### Registry completeness

- **93 fixtures in regression-suite.json**
- **92 fixtures in KB Fixture Registry**
- **Missing:** PS-QR-001

---

## Recommendations (ranked by impact)

### Critical

1. **Fix BLS-001 assertion logic** — Change `res.status === 200 || res.status === 404` to `res.status === 200` for the `/api/v1/applications/` endpoint. The `/upload-urls` endpoint may legitimately return 422 (already handled) but 404 should not be a PASS.

### High

2. **Add content assertions to EXPORT fixtures** — At minimum:
   - EXPORT-DOC-001: assert `documentId` matches seeded docId (new `assertDocumentIdMatch` flag)
   - Both: assert `status === "COMPLETED"` (value check, not just presence)
   - Both: add nested requiredFields for `ocrResult.documentData`

3. **Document 5 undocumented failures in KB** — BS-DEEP-BDO/BPI/MAYA posting_date failures, PS-QR-001 summaryOCR, SSS-001 HTTP 503. These are recurring failures that should have KB Warning Pattern entries.

4. **Add PS-QR-001 to KB Fixture Registry** — Currently the only fixture missing from the registry.

### Medium

5. **Strengthen CACHE-CHECK-001** — Add assertion that `cached_count + uncached_count === items.length` and that at least 1 item is present.

6. **Add 6 undocumented warning patterns to KB** — Missing fraudCheckFindings, billing_period, electricity gshare fields, GcashTransactionHistory type check, callback documentType mismatch, crossCheckFindings presence.

### Low

7. **Consider CACHE-001 timing assertion** — The `fromCache===true` check is the correct signal; timing is a secondary indicator. Low priority.

8. **PS-DEEP-001 numeric bounds** — Currently only checks field presence. Could add `gross_pay > 0` or similar floor checks. Low impact since payslip-rules already validates computed fields with exact values.
