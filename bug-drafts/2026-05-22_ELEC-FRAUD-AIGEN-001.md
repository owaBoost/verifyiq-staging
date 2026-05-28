# [BUG DRAFT] ELEC-FRAUD-AIGEN-001 — AI-generated content not detected on electricity bill

**Summary**: Fraud detection pipeline does not flag AI-generated electricity utility billing statements. The same pipeline correctly detects AI-generated payslips with 99% confidence (ai-generatedContent + visualFraud findings), but returns gs_isFraudulent_elecbill=0 with empty fraudCheckFindings on a known-synthetic Meralco bill.
**Fixture**: ELEC-FRAUD-AIGEN-001 (planned, blocked on this bug)
**Warning observed**: gs_isFraudulent_elecbill === 0 with empty fraudCheckFindings on AI-generated electricity bill
**Fixture status**: N/A (not yet in suite)
**First seen**: 2026-05-22 (probe during wave 5 implementation)
**Recurrence**: 1

---
**Environment**:
- Environment: Staging
- GCS bucket: gs://verifyiq-internal-testing
- Document path: gs://verifyiq-internal-testing/QA/Gcash/Meralco.png
- Document type: ElectricUtilityBillingStatement

---
**Probe details**:
- Test document: gs://verifyiq-internal-testing/QA/Gcash/Meralco.png
- Document type: ElectricUtilityBillingStatement
- Expected: gs_isFraudulent_elecbill === 1, fraudCheckFindings contains { type: "ai-generatedContent" }
- Actual: gs_isFraudulent_elecbill === 0, gs_overallFraudScore_elecbill === 100, fraudCheckFindings = []
- Comparison: PS-FRAUD-AIGEN-001 payslip from same bucket returns isFraudulent=1, overallFraudScore=0.6, ai-generatedContent finding at 99% confidence + visualFraud finding

---
**Repro steps**:
1. Obtain access to the staging GCS bucket (`gs://verifyiq-internal-testing`).
2. Run the regression suite (or submit the document directly to the fraud endpoint) targeting `gs://verifyiq-internal-testing/QA/Gcash/Meralco.png` with document type `ElectricUtilityBillingStatement`.
   ```
   node run_regression.mjs   # or the relevant test-tc*.mjs for elec-bill fixtures once added
   ```
3. Inspect the response for the following fields:
   - `gs_isFraudulent_elecbill` — expected `1`, actual `0`
   - `gs_overallFraudScore_elecbill` — actual is `100` (incorrect; should reflect AI-generation risk)
   - `fraudCheckFindings` — expected to contain `{ type: "ai-generatedContent" }`, actual `[]`
4. For comparison, run the same check against `PS-FRAUD-AIGEN-001` (payslip fixture, same bucket). That document returns `isFraudulent=1`, `overallFraudScore=0.6`, with `ai-generatedContent` at 99% confidence and a `visualFraud` finding — confirming the detection pipeline works for payslips but not for `ElectricUtilityBillingStatement`.

---
**Proposed ClickUp fields**:
- **List**: Fraud Detection
- **Priority**: High
- **Severity**: High
- **Labels**: Fraud, ElectricUtilityBillingStatement, ai-generated-content, detection-gap
