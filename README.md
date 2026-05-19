# VerifyIQ Regression Suite

Automated regression runner for the VerifyIQ API. Loops through ~62 permanent
fixtures in `regression-suite.json`, sends each to the staging or dev API, and
posts results to ClickUp and Slack.

## Setup

1. Copy `.env.example` to `.env` and fill in your values:
   ```
   cp .env.example .env
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Place your GCP service account key JSON and set `GOOGLE_SA_KEY_FILE` to its
   path (required for staging batch uploads / IAP-gated endpoints).

## Run

```bash
# Full suite against staging (default)
node run_regression.mjs

# Full suite against dev
node run_regression.mjs --env dev

# Smoke subset (7 fixtures) against dev — fast first-check
node run_regression.mjs --env dev --smoke

# Single fixture
node run_regression.mjs --fixture BS-BDO-001

# Dry run — list fixtures without sending requests
node run_regression.mjs --dry-run
node run_regression.mjs --env dev --smoke --dry-run
```

### Options

| Flag | Description |
|---|---|
| `--env <staging\|dev>` | Target environment. Overrides `TARGET_ENV` env var. Default: `staging`. |
| `--smoke` | Run only the 7 smoke-tagged fixtures (fast sanity check). |
| `--fixture <id>` | Run a single fixture by ID (e.g. `--fixture BS-BDO-001`). |
| `--dry-run` | List fixtures and target URL without sending any requests. |

You can also set `TARGET_ENV=dev` in your shell instead of passing `--env dev`
every time.

## Environments

| Environment | Base URL | API Key var |
|---|---|---|
| staging (default) | `STAGING_URL` | `VERIFYIQ_API_KEY` |
| dev | `DEV_URL` | `DEV_VERIFYIQ_API_KEY` |

Dev runs have no webhook server — batch tests are skipped automatically.

## Smoke fixtures

The following 7 fixtures are tagged `"smoke": true` and run with `--smoke`.
They cover single-doc, no-batch paths and serve as a fast check that the
target environment is operational before running the full suite.

| ID | Document Type | Test type |
|---|---|---|
| HEALTH-001 | health | health |
| SEC-001 | BankStatement | security |
| BS-BDO-001 | BankStatement | default |
| PHILID-001 | PhilippineNationalID | default |
| BS-DEEP-BDO-001 | BankStatement | bank-deep |
| PHILID-FRAUD-TAMPERED-001 | PhilippineNationalID | fraud |
| CACHE-001 | BankStatement | cache |

## Full fixture list

All ~62 fixtures live in `regression-suite.json` and point to files in
`gs://verifyiq-internal-testing/QA/`. Document categories:

- **Bank / Financial** — BankStatement, GcashTransactionHistory, CreditCardStatement
- **Employment** — Payslip, CertificateOfEmployment, BIRForm2303
- **Identity / KYC** — PhilippineNationalID, DriversLicense, Passport, UMID, SSSID, TINID, PhilHealthID, HDMFID, PostalID, PRCID, VotersID, NBIClearance, ACRICard, SSSPersonalRecord
- **Utility Bills** — ElectricUtilityBillingStatement, WaterUtilityBillingStatement, TelcoBill
- **KYB** — DTIRegistrationCertificate
- **Fraud** — fraud-detection fixtures across ID and bank doc types
- **Infrastructure** — health, security, cache validation

## Reporting

- **ClickUp**: a new dated list is created per run (`Regression YYYY-MM-DD` for
  staging, `Regression [dev] YYYY-MM-DD` for dev). Configure separate
  `DEV_CLICKUP_FOLDER_ID` / `DEV_CLICKUP_LIST_ID` to keep dev noise out of
  staging history.
- **Slack**: summary posted to `SLACK_WEBHOOK_URL` (optional). Header and
  ClickUp link are tagged with the environment name.
