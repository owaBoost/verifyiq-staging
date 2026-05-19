# VerifyIQ Regression Triage Agent

## Token Conservation Rules
- Do not read files unless explicitly required by the current step
- Do not summarize files you've already read
- Run shell commands directly without explaining what you're about to do
- Do not confirm actions for append-only files (reports/, bug-drafts/)
- Never narrate what you are about to do — just do it

---

## Real-World Pipeline
- **Regression runs** via `run_regression.mjs` (and related `test-*.mjs` scripts)
- **Reports are posted to Slack** — user pastes them into the prompt
- **Knowledge base** lives in `regression-kb.md` — grow it over time
- **Bug drafts** written to `bug-drafts/` — user copies to ClickUp manually

---

## Project Layout

```
verifyiq-staging/
├── CLAUDE.md
├── regression-kb.md
├── reports/
│   └── YYYY-MM-DD_regression.md
├── regression-session-logs/
│   └── YYYY-MM-DD_regression.json
├── bug-drafts/
│   └── YYYY-MM-DD_<fixture-id>.md
└── run_regression.mjs
```

**Document categories**: Bank / Financial, Employment, Identity / KYC, Utility Bills, KYB, Fraud, Infrastructure.

---

## Primary Principle
Regression report = **PRIMARY source of truth**. `regression-kb.md` = historical context only. If a warning contradicts a KB entry, investigate rather than dismiss.

---

## Session Opener — Pre-Flight Checks
Run in order. If any fail, halt and report to user.

### 1. Existing-log collision check
Check `regression-session-logs/` for a log matching the report's date or run_id.
- If found: **HALT.** Ask user: "Log exists at `<path>`. (a) view it, (b) re-triage and replace (requires confirmation), or (c) treat as new run_id?"
- Never overwrite without explicit confirmation ("yes, replace it").

### 2. KB state check
- Read `regression-kb.md` in full.
- If `regression-kb.md.DRAFT` exists: **HALT.** Tell user to resolve it first.

### 3. Report completeness check
- Confirm report has: timestamp, score, fixture list, warnings.
- If truncated or malformed, surface what's missing before triaging.

---

## Report Intake
1. Run pre-flight checks
2. Save verbatim copy to `reports/YYYY-MM-DD_regression.md` (append `_v2` if exists)
3. Read `regression-kb.md` in full
4. Proceed with Triage Workflow

If user says "triage the latest report" without pasting, use most recent file in `reports/`.

---

## Clean Run Tracking
Track every fixture that passes — not just warnings.

- Increment `consecutive_clean_runs` from KB (never reset to 1 if prior history exists)
- Fixture status:
  - **Stable** — 5+ clean runs
  - **New** — <3 runs
  - **Watched** — active Monitor
  - **Flagged** — was Stable, now has a warning this run

**Flagged fixtures** → always Needs Investigation, no exceptions.

---

## Knowledge Base Consultation
Before triaging any warning:
- Check `regression-kb.md` for known patterns, prior classifications, fixture status
- Never auto-dismiss without KB check
- Never classify as Expected/Known without a KB entry or explicit user confirmation
- Never write `kb_match: false` without grep-searching for fixture ID and warning text

---

## Drift Detection
If prior session log classifies a warning differently than this session would → surface a **Drift Report** before Step 6:
- Warning pattern
- Prior vs proposed classification
- Run IDs involved
- Recommended reconciliation

Never silently override a prior classification.

---

## Triage Workflow
**[FILE]** = written to disk. All others printed to chat.

### STEP 1 — Run Summary
Run ID, timestamp, environment, score, fixtures passed/total, duration, warning count.

### STEP 2 — Clean Fixture Update
```
[FIXTURE-ID] | Status: [Stable/New/Watched/Flagged] | Clean runs: [N] | [PASS/FLAGGED]
```
Note fixtures in KB that did NOT appear this run.

### STEP 3 — Warning Triage
```
[FIXTURE-ID] - [warning text]
Classification: [Needs Investigation / Monitor / Expected / Known]
Fixture status: [Stable / New / Watched / Flagged]
Reason: [one sentence]
Action: [file bug / watch next run / no action]
KB match: [Yes - entry: 'name'] or [No - new pattern]
```

### STEP 4 — Bug Drafts [FILE]
For each **Needs Investigation**, write to `bug-drafts/YYYY-MM-DD_<fixture-id>.md` using template at `bug-drafts/template.md`.
- If draft already exists for same fixture + pattern: do not duplicate, append a reference note
- Print summary table to chat for ClickUp copy-paste

### STEP 5 — Pattern Summary
- New patterns
- Recurring patterns (with recurrence count)
- Escalations
- Flagged fixtures
- Missing fixtures
- Drift Report (if any)

**Systemic escalation**: same warning on 3+ fixtures in one run → Needs Investigation regardless of KB.

### STEP 6 — Overall Verdict
- **Clean** — all Expected/Known. No action.
- **Monitor** — some warnings need watching.
- **Action Required** — one or more Needs Investigation.

### STEP 7 — Session Log [FILE]
Write to `regression-session-logs/YYYY-MM-DD_regression.json` using schema at `regression-session-logs/schema.json`.

---

## KB Update Draft
Never edit `regression-kb.md` directly. After every session:

1. Write proposed update to `regression-kb.md.DRAFT`
2. Show diff in chat (mark ADD / UPDATE / REMOVE)
3. Wait for explicit approval
4. On approval: overwrite `regression-kb.md`, delete `.DRAFT`

Each proposed change:
```
Action: ADD | UPDATE | REMOVE
Section: Warning Patterns | Fragile Fixtures | Fixture Registry
Entry name: [short name]
Proposed content: [exact text]
Evidence: [run IDs]
```

Rules:
- Match existing `regression-kb.md` format
- Every entry must include: exact warning text, fixture ID/category scope, one distinguishing signal
- Never reset `consecutive_clean_runs` unless fixture was genuinely Flagged
- Add `last_seen_run_id` to every entry, update on reappearance
- Scan for entries 20+ runs old → include in **Prune Candidates** (surface only, don't auto-remove)

### Auto-reclassification
- Monitor → Expected/Known: 3+ consecutive runs, no escalation
- Monitor → Needs Investigation: new fixture or increased count
- Stable fixture warned → Flagged in registry
- Clean fixture → increment `consecutive_clean_runs`

---

## Autonomous Operations

Claude Code may proceed without confirmation for:
- Moving misplaced files to their correct folder
- Committing clean working tree changes with a descriptive message
- Stripping KB/DRAFT entries for fixtures not present in regression-suite.json
- Applying a DRAFT after showing a diff, if the only changes are ADD operations with no classification downgrades
- Collapsing consecutive blank lines in markdown files

Claude Code must stop and wait for explicit approval for:
- Any write to regression-kb.md (always show diff first)
- Any change to src/keywords.mjs or run_regression.mjs
- Any deletion that is not regression-kb.md.DRAFT
- Any reclassification of an existing warning pattern
- Anything touching production environment config

---

## Claude Code Conventions
- Show proposed changes before writing to `regression-kb.md`
- Use report date for filenames, not today's date
- Create `reports/`, `bug-drafts/`, `regression-session-logs/` if missing
- Do not modify `run_regression.mjs` or `test-*.mjs` unless explicitly asked
- Ignore large JSON dumps (e.g. `rafi-results.json`) unless user points at them
- Do not touch `webview-ui/`
