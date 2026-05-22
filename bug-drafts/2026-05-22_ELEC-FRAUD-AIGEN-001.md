# [BUG DRAFT] ELEC-FRAUD-AIGEN-001 — AI-generated content not detected on electricity bill

**Summary**: Fraud detection pipeline does not flag AI-generated electricity utility billing statements. The same pipeline correctly detects AI-generated payslips with 99% confidence (ai-generatedContent + visualFraud findings), but returns gs_isFraudulent_elecbill=0 with empty fraudCheckFindings on a known-synthetic Meralco bill.
**Fixture**: ELEC-FRAUD-AIGEN-001 (planned, blocked on this bug)
**Warning observed**: gs_isFraudulent_elecbill === 0 with empty fraudCheckFindings on AI-generated electricity bill
**Fixture status**: N/A (not yet in suite)
**First seen**: 2026-05-22 (probe during wave 5 implementation)
**Recurrence**: 1

---
**Probe details**:
- Test document: gs://verifyiq-internal-testing/QA/Gcash/Meralco.png
- Document type: ElectricUtilityBillingStatement
- Expected: gs_isFraudulent_elecbill === 1, fraudCheckFindings contains { type: "ai-generatedContent" }
- Actual: gs_isFraudulent_elecbill === 0, gs_overallFraudScore_elecbill === 100, fraudCheckFindings = []
- Comparison: PS-FRAUD-AIGEN-001 payslip from same bucket returns isFraudulent=1, overallFraudScore=0.6, ai-generatedContent finding at 99% confidence + visualFraud finding

---
**Proposed ClickUp fields**:
- **List**: Fraud Detection
- **Priority**: High
- **Labels**: Fraud, ElectricUtilityBillingStatement, ai-generated-content, detection-gap
