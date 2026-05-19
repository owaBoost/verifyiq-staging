# VerifyIQ Regression Suite

Automated regression runner for the VerifyIQ API. Loops through ~62 permanent
fixtures in `regression-suite.json`, sends each to the staging, dev, or PR
preview API, and posts results to ClickUp and Slack.

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

# PR preview environment — build URL from PR number (uses PR_URL_TEMPLATE)
node run_regression.mjs --env pr --pr 487 --smoke

# PR preview environment — explicit URL (CI usage)
node run_regression.mjs --env pr --base-url https://ai-parser-pr-487-z6thvhgnxa-uc.a.run.app --smoke

# Single fixture
node run_regression.mjs --fixture BS-BDO-001

# Dry run — list fixtures without sending requests
node run_regression.mjs --dry-run
node run_regression.mjs --env dev --smoke --dry-run
node run_regression.mjs --env pr --pr 487 --smoke --dry-run
```

### Options

| Flag | Description |
|---|---|
| `--env <staging\|dev\|pr>` | Target environment. Overrides `TARGET_ENV` env var. Default: `staging`. |
| `--pr <number>` | PR number for `--env pr`; builds URL from `PR_URL_TEMPLATE`. |
| `--base-url <url>` | Explicit base URL for `--env pr` (takes precedence over `--pr`). |
| `--smoke` | Run only the 7 smoke-tagged fixtures (fast sanity check). |
| `--fixture <id>` | Run a single fixture by ID (e.g. `--fixture BS-BDO-001`). |
| `--dry-run` | List fixtures and target URL without sending any requests. |

You can also set `TARGET_ENV=dev` in your shell instead of passing `--env dev`
every time.

## Environments

| Environment | Base URL | API Key var | Auth |
|---|---|---|---|
| staging (default) | `STAGING_URL` | `VERIFYIQ_API_KEY` | IAP (batch) / API key |
| dev | `DEV_URL` | `DEV_VERIFYIQ_API_KEY` | API key only |
| pr | `--base-url` or `PR_URL_TEMPLATE` | `VERIFYIQ_API_KEY` | None (default) or Cloud Run ID token (`PR_AUTH_MODE=id-token`) |

Dev and PR environments have no webhook server — batch tests are skipped
automatically when `WEBHOOK_SERVER_URL` is unset.

### PR environments

PR Cloud Run services have ephemeral URLs. Two ways to target them:

- `--pr 487` — resolves the URL using `PR_URL_TEMPLATE` from `.env`
  (template: `https://ai-parser-pr-{n}-z6thvhgnxa-uc.a.run.app`)
- `--base-url <url>` — explicit URL, intended for CI pipelines that know the
  exact service URL

PR Cloud Run auth defaults to unauthenticated (`PR_AUTH_MODE=none`). Set
`PR_AUTH_MODE=id-token` if the service requires Cloud Run invoker auth (requires
`GOOGLE_SA_KEY_FILE`). Verify the correct mode against a live PR environment.

## Reporting

All environments share one ClickUp folder (`CLICKUP_FOLDER_ID`). Each run
creates a dated list tagged with the environment:

| Environment | ClickUp list name |
|---|---|
| staging | `Regression [staging] YYYY-MM-DD` |
| dev | `Regression [dev] YYYY-MM-DD` |
| pr | `Regression [pr-487] YYYY-MM-DD` |

Slack summary header is also tagged with the environment name.

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
