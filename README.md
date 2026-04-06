# VerifyIQ Staging Regression Suite

Automated regression runner for the VerifyIQ staging environment. Loops through permanent fixtures in `regression-suite.json`, sends each to the staging API via `POST /v1/documents/parse` (single docs) or `POST /ai-gateway/batch-upload` (batch tests), and posts results to ClickUp.

## Setup

1. Copy `.env.example` to `.env` and fill in your values:
   ```
   cp .env.example .env
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Place your GCP service account key JSON file and set `GOOGLE_SA_KEY_FILE` to its path.

## Run

```bash
node run_regression.mjs
```

### Options

- `--fixture <id>` -- run a single fixture by ID (e.g. `--fixture BIR-001`)
- `--dry-run` -- list fixtures without sending requests

## Fixtures

Fixtures are defined in `regression-suite.json` and point to files in staging GCS buckets:

| ID | Document Type | Bucket |
|---|---|---|
| BIR-001 | BIRForm2303 | gs://rafi-images-staging/bir2303 |
| ELEC-RAFI-001 | ElectricUtilityBillingStatement | gs://rafi-images-staging/electricity-bills |
| ID-001 | PhilippineNationalID | gs://rafi-images-staging/various-ids |
| ID-002 | DriversLicense | gs://rafi-images-staging/various-ids |
| WATER-001 | WaterUtilityBillingStatement | gs://rafi-images-staging/water-bills |
| BS-001 | BankStatement | gs://gcash-test-data-staging/bank_statements |
| PS-001 | Payslip | gs://gcash-test-data-staging/payslips |
| ELEC-GCASH-001 | ElectricUtilityBillingStatement | gs://gcash-test-data-staging/electricity-bills |
| NBI-001 | NBIClearance | gs://gcash-test-data-staging/nbi |
| PASS-001 | Passport | gs://gcash-test-data-staging/passports |
| DTI-001 | DTIRegistrationCertificate | gs://gcash-test-data-staging/DTI |
