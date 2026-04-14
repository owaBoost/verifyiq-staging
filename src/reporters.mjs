/**
 * Reporters: ClickUp task posting + Slack summary notifications.
 */

import axios from 'axios';
import { clickupClient, CLICKUP_LIST_ID, SLACK_WEBHOOK_URL } from './utils.mjs';
import { extractKeyFields } from './validators.mjs';

// -- Module-level state -------------------------------------------------------

let runListId = CLICKUP_LIST_ID;
let existingTasks = {}; // name-prefix -> task id

// -- ClickUp: per-run list creation -------------------------------------------
//
// Creates (or reuses) a dated list "Regression YYYY-MM-DD" in the same folder
// as CLICKUP_LIST_ID. On subsequent runs the same day it finds and reuses the
// existing dated list so task updates hit the correct list.

export async function createClickUpList() {
  if (!clickupClient) return;
  const dateStr = new Date().toISOString().slice(0, 10);
  const listName = `Regression ${dateStr}`;
  try {
    // Find the folder that contains the default CLICKUP_LIST_ID
    const { data: listData } = await clickupClient.get(`/list/${CLICKUP_LIST_ID}`);
    const folderId = listData.folder?.id;
    if (!folderId) { console.warn('  Could not find folder_id -- using default list'); return; }

    // Check if today's dated list already exists in that folder
    const { data: folderLists } = await clickupClient.get(`/folder/${folderId}/list`);
    const existing = (folderLists.lists || []).find(l => l.name === listName);
    if (existing) {
      runListId = existing.id;
      console.log(`  Reusing ClickUp list: ${listName} (${runListId})`);
      return;
    }

    // Otherwise create a new list for today
    const { data: newList } = await clickupClient.post(`/folder/${folderId}/list`, { name: listName });
    runListId = newList.id;
    console.log(`  Created ClickUp list: ${listName} (${runListId})`);
  } catch (err) {
    console.warn(`  Could not create/find run list: ${err.message} -- using default list`);
  }
}

// -- ClickUp: load existing tasks for dedup -----------------------------------

export async function loadClickUpTasks() {
  if (!clickupClient) { console.warn('  CLICKUP_API_TOKEN not set -- disabled'); return; }
  console.log(`  Using ClickUp list ${runListId}`);
  try {
    const { data } = await clickupClient.get(`/list/${runListId}/task?include_closed=true`);
    for (const task of (data.tasks ?? [])) existingTasks[task.name] = task.id;
    console.log(`  Loaded ${Object.keys(existingTasks).length} existing tasks for dedup`);
  } catch (err) { console.warn(`  Could not load tasks: ${err.message}`); }
}

// -- ClickUp description format helpers --------------------------------------

// Doc-type specific assertions (mirrors RESPONSE_VALIDATORS)
function getDocTypeAssertions(documentType) {
  const map = {
    BankStatement: ['transactionsOCR is an array', 'account_holder_name or account_name present', 'account_number present'],
    Payslip: ['gross_pay or net_pay present (hard fail)', 'company_name or employer_name present', 'employee_name present'],
    PhilippineNationalID: ['id_number or pcn present', 'first_name or last_name present'],
    DriversLicense: ['license_number present', 'full_name or last_name present'],
    Passport: ['passport_number present', 'full_name or last_name present'],
    ElectricUtilityBillingStatement: ['billing_period present', 'gs_amountdue_elecbill present', 'account_number present', 'account_name or customer_name present'],
    UMID: ['crn_id_number present', 'first_name or last_name present'],
    SSSID: ['prn_id_number present', 'first_name or last_name present'],
    NBIClearance: ['nbi_id_number present', 'full_name or last_name present'],
    PRCID: ['registration_number present', 'first_name or last_name present'],
    ACRICard: ['ssrn present', 'first_name or last_name present'],
    HDMFID: ['mid_no present', 'first_name or last_name present'],
    PostalID: ['prn_id_number present', 'first_name or last_name present'],
    VotersID: ['vin present', 'first_name or last_name present'],
    PhilHealthID: ['philhealth_number or id_number present', 'full_name or last_name present'],
    BIRForm2303: ['tin present'],
    DTIRegistrationCertificate: ['business_name present', 'business_registration_number present'],
    CertificateOfEmployment: ['employee_name or full_name present', 'employer_name or company_name present'],
    GcashTransactionHistory: ['summaryOCR or transactionsOCR present', 'document_type == GcashTransactionHistory'],
    CreditCardStatement: ['account_number or card_number present', 'total_amount_due or minimum_amount_due present'],
    PLDTTelcoBill: ['account_number present', 'amount_due or total_amount_due present'],
    WaterUtilityBillingStatement: ['summaryOCR non-empty'],
  };
  return map[documentType] || [];
}

// Return the most meaningful extracted value from a parse response for the Results column.
function getPrimaryValue(body, documentType) {
  const kf = extractKeyFields(body, documentType);
  if (!kf) return body?.completenessScore != null ? `completenessScore=${body.completenessScore}` : '-';
  for (const [k, v] of Object.entries(kf)) {
    if (k === 'completenessScore') continue;
    if (v != null && v !== '') return `${k}=${v}`;
  }
  return kf.completenessScore != null ? `completenessScore=${kf.completenessScore}` : '-';
}

// Derive a structured error code from a failing result.
function deriveErrorCode(r, fixture) {
  if (r.status && r.status !== 200) return `HTTP_${r.status}`;
  if (!r.body) return 'NO_RESPONSE_BODY';
  const body = r.body;
  if (body.extractionStatus && body.extractionStatus !== 'complete') return 'EXTRACTION_NOT_ATTEMPTED';
  if (!Array.isArray(body.summaryOCR) || body.summaryOCR.length === 0) return 'EMPTY_SUMMARY_OCR';
  const summary = (r.summary || '').toLowerCase();
  if (summary.includes('fraudscore not a number') || summary.includes('fraudscore is null')) return 'FRAUD_SCORE_NULL';
  if (summary.includes('missing')) return 'MISSING_REQUIRED_FIELD';
  if (summary.includes('callback')) return 'BATCH_CALLBACK_FAILED';
  if (fixture?.testType === 'fraud') return 'FRAUD_ASSERTION_FAILED';
  return 'ASSERTION_FAILED';
}

// Derive the failed assertion string from a failing result.
function deriveFailedAssertion(r, fixture) {
  if (r.status && r.status !== 200) return 'status_code == 200';
  const summary = (r.summary || '').toLowerCase();
  if (summary.includes('summaryocr') && summary.includes('empty')) return 'summaryOCR non-empty';
  if (summary.includes('missing summaryocr')) return 'summaryOCR exists';
  if (summary.includes('fraudscore')) return 'fraudScore is a number';
  if (summary.includes('callback')) return 'batch callback status == COMPLETED';
  if (summary.includes('missing')) {
    const m = r.summary.match(/missing ([^,;]+)/i);
    return m ? `${m[1].trim()} present` : 'required field present';
  }
  if (r.summary && r.summary.includes('fraud validation failed')) return r.summary.replace(/^HTTP \d+ fraud validation failed: /, '');
  return r.summary || 'unknown assertion';
}

// Compact JSON-like body snippet for the Failure Details section.
function compactResponseBody(body) {
  if (!body) return '{}';
  const ocr = body.summaryOCR?.[0];
  const obj = {
    documentType: body.documentType,
    extractionStatus: body.extractionStatus,
    completenessScore: body.completenessScore,
    fraudScore: body.fraudScore,
    fraudStatus: body.fraudStatus,
    summaryOCR_first: ocr ? Object.fromEntries(Object.entries(ocr).slice(0, 8)) : null,
    error: body.detail || body.error || null,
  };
  // Strip null/undefined for brevity
  const cleaned = Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null));
  return JSON.stringify(cleaned, null, 2);
}

// -- ClickUp task description builder -----------------------------------------

export function buildTaskDescription(fixture, results) {
  const passedCount = results.filter(r => r.passed).length;
  const totalCount = results.length;
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

  // Classify results
  const parseResults = results.filter(r => r.file && r.file !== 'cross-validate');
  const batchResult = results.find(r => !r.file && r.callbackDetails);
  const legacyBatch = results.find(r => !r.file && !r.callbackDetails && r.summary);
  const crossValidateResults = results.filter(r => r.file === 'cross-validate');

  // Endpoints
  const endpoints = ['POST /v1/documents/parse'];
  if (!fixture.skipBatch && (batchResult || legacyBatch)) endpoints.push('POST /ai-gateway/batch-upload');

  // Assertions
  const assertions = [
    'status_code == 200',
    `document_type == ${fixture.documentType}`,
    'latency < 30000ms',
    'summaryOCR exists and non-empty',
    ...getDocTypeAssertions(fixture.documentType),
  ];
  if (!fixture.skipBatch && (batchResult || legacyBatch)) {
    assertions.push('batch callback status == COMPLETED');
  }
  if (fixture.testType === 'fraud') {
    assertions.push('fraudScore is a number');
    if (fixture.expectFraud === true) {
      assertions.push('fraudScore > 20', 'at least 1 CRITICAL finding in fraudCheckFindings');
    } else if (fixture.expectFraud === false) {
      assertions.push('fraudScore < 20', 'no CRITICAL findings');
    }
  }
  if (fixture.testType === 'bank-deep') assertions.push('calculatedFields present');
  if (fixture.testType === 'gcash-rules') assertions.push('gs_90days_consec_bankstatement === 1', 'gs_180days_valid_bankstatement === 1');
  if (fixture.testType === 'dedup-gcash') assertions.push('totals not multiplied by 3', 'crosscheck name match === true', 'crosscheck address match === true');
  if (fixture.testType === 'crosscheck') assertions.push('cross-validate returns consistency_score');
  if (fixture.testType === 'crosscheck-deep') assertions.push(
    'name: valuePrimary non-empty, match===true, riskLevel==="low"',
    'address: valuePrimary non-empty OR match===null if missing; riskLevel!=="high" unless mismatch confirmed',
  );
  if (fixture.testType === 'cache') assertions.push('2nd parse fromCache === true');
  if (fixture.testType === 'security') assertions.push('security headers present', '401 without api key', '403 with wrong api key');
  if (fixture.testType === 'health') assertions.push('all health endpoints return 200');

  // Request template
  const reqTemplate = {
    file: '<input_file>',
    fileType: fixture.documentType,
    pipeline: fixture.pipeline || { use_cache: false },
  };

  // Build description in strict format
  const desc = [];
  const icon = passedCount === totalCount ? '✅ PASS' : passedCount > 0 ? '⚠️ PARTIAL' : '❌ FAIL';
  desc.push(`Result: ${icon} ${passedCount}/${totalCount}`);
  desc.push('');
  desc.push(`Test: ${fixture.id} — ${fixture.documentType} ${fixture.testType || 'default'}`);
  desc.push(`Run: ${timestamp}`);
  desc.push(`Environment: staging`);
  desc.push(`Endpoint: ${endpoints.join(' + ')}`);
  desc.push('');
  desc.push('Objective:');
  desc.push(fixture.description || '(no description)');
  desc.push('');
  desc.push('Assertions:');
  for (const a of assertions) desc.push(`- ${a}`);
  desc.push('');

  // Fixtures section
  if (fixture.files?.length) {
    desc.push('Fixtures:');
    for (const f of fixture.files) {
      const fn = f.split('/').pop();
      desc.push(`${fn} | ${f}`);
    }
    desc.push('');
  }

  // Request template
  desc.push('Request Template:');
  desc.push(JSON.stringify(reqTemplate, null, 2));
  desc.push('');

  // Results
  desc.push('Results:');
  const elapsedValues = [];
  for (const r of parseResults) {
    const fn = r.file.startsWith('/') ? r.file : r.file.split('/').pop();
    const pf = r.passed ? 'PASS' : 'FAIL';
    const elapsed = r.elapsed ?? '?';
    if (typeof r.elapsed === 'number') elapsedValues.push(r.elapsed);
    const primary = getPrimaryValue(r.body, fixture.documentType);
    desc.push(`${fn} | ${pf} | ${elapsed}ms | ${primary}`);
  }
  if (batchResult) {
    const pf = batchResult.passed ? 'PASS' : 'FAIL';
    const cbd = batchResult.callbackDetails;
    const doneCount = (cbd?.documents?.filter(d => d.status === 'COMPLETED').length ?? 0)
      + (cbd?.application?.status === 'COMPLETED' ? 1 : 0);
    const expected = (cbd?.documents?.length ?? 0) + (cbd?.application ? 1 : 0);
    desc.push(`batch | ${pf} | ${doneCount}/${expected} callbacks COMPLETED`);
    // computedFields + crossCheckFindings for gcash-rules / dedup-gcash / crosscheck
    if (cbd?.application?.computedFields) {
      for (const [section, val] of Object.entries(cbd.application.computedFields)) {
        const data = val?.data ?? val;
        if (data && typeof data === 'object') {
          const pairs = Object.entries(data).map(([k, v]) => `${k}=${v}`).join(', ');
          desc.push(`  ${section}: ${pairs}`);
        }
      }
    }
    if (Array.isArray(cbd?.application?.crossCheckFindings) && cbd.application.crossCheckFindings.length) {
      for (const f of cbd.application.crossCheckFindings) {
        const prim = Array.isArray(f.valuePrimary) ? f.valuePrimary.join(', ') : String(f.valuePrimary ?? '');
        const sec = Array.isArray(f.valueSecondary) ? f.valueSecondary.join(', ') : String(f.valueSecondary ?? '');
        desc.push(`  ${f.field}: primary=[${prim}] secondary=[${sec}] match=${f.match}`);
      }
    }
  } else if (legacyBatch) {
    const pf = legacyBatch.passed ? 'PASS' : 'FAIL';
    desc.push(`batch | ${pf} | ${legacyBatch.summary}`);
  }
  for (const r of crossValidateResults) {
    const pf = r.passed ? 'PASS' : 'FAIL';
    desc.push(`cross-validate | ${pf} | ${r.summary}`);
  }
  desc.push('');

  // Failure Details (only if any file/batch failed)
  const failedResults = results.filter(r => !r.passed);
  if (failedResults.length) {
    desc.push('Failure Details:');
    for (const r of failedResults) {
      if (r.file && r.file !== 'cross-validate') {
        const fn = r.file.startsWith('/') ? r.file : r.file.split('/').pop();
        desc.push(`[${fn}]`);
        desc.push(`error_code: ${deriveErrorCode(r, fixture)}`);
        desc.push(`assertion_failed: ${deriveFailedAssertion(r, fixture)}`);
        desc.push('response_body:');
        desc.push(compactResponseBody(r.body));
        desc.push('');
      } else if (!r.file) {
        // Batch failure
        desc.push('[batch]');
        desc.push('error_code: BATCH_CALLBACK_FAILED');
        desc.push('assertion_failed: callback status == COMPLETED');
        desc.push('response_body:');
        const cbd = r.callbackDetails;
        const batchBody = {
          applicationId: r.body?.applicationId,
          status: r.body?.status,
          documentCallbacks: cbd ? `${cbd.documents?.length ?? 0} received` : 'unknown',
          applicationCallback: cbd?.application?.status || 'unknown',
        };
        desc.push(JSON.stringify(batchBody, null, 2));
        desc.push('');
      } else if (r.file === 'cross-validate') {
        desc.push('[cross-validate]');
        desc.push('error_code: ASSERTION_FAILED');
        desc.push(`assertion_failed: ${r.summary}`);
        desc.push('response_body:');
        desc.push(JSON.stringify(r.body || {}, null, 2).slice(0, 500));
        desc.push('');
      }
    }
  }

  // Summary
  const allWarnings = results.flatMap(r => (r.warnings || []).map(w => w.replace(/^WARN:\s*/, '')));
  const avgLatency = elapsedValues.length ? Math.round(elapsedValues.reduce((a, b) => a + b, 0) / elapsedValues.length) : null;
  desc.push('Summary:');
  desc.push(`- total: ${totalCount}`);
  desc.push(`- passed: ${passedCount}`);
  desc.push(`- failed: ${totalCount - passedCount}`);
  if (avgLatency != null) desc.push(`- avg_latency: ~${avgLatency}ms`);
  if (allWarnings.length) {
    desc.push(`- warnings:`);
    for (const w of allWarnings) desc.push(`    • ${w}`);
  }
  if (batchResult || legacyBatch) {
    const b = batchResult || legacyBatch;
    desc.push(`- batch: ${b.passed ? 'PASS' : 'FAIL'}`);
  }

  return desc.join('\n');
}

// -- ClickUp: post a fixture result -------------------------------------------

export async function postToClickUp(fixture, results) {
  if (!clickupClient) return;
  const passedCount = results.filter(r => r.passed).length;
  const totalCount = results.length;
  const icon = passedCount === totalCount ? 'PASS' : passedCount > 0 ? 'PARTIAL' : 'FAIL';
  // Board statuses: "to do" (created, not run), "passed" (all asserts ok, warnings
  // allowed), "failed" (any assertion failed). Warnings do not downgrade "passed".
  const status = passedCount === totalCount ? 'passed' : 'failed';
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

  const description = buildTaskDescription(fixture, results);

  // Comment summary (compact)
  const commentLines = results.map(r => {
    const rIcon = r.passed ? '✅' : '❌';
    const fn = r.file ? (r.file.startsWith('/') ? r.file : r.file.split('/').pop()) : 'batch';
    return `${rIcon} **${fn}** — ${r.summary}`;
  });

  // Name intentionally excludes PASS/FAIL — board status field already shows it.
  const taskNamePrefix = `${fixture.id} —`;
  const existingTaskId = Object.entries(existingTasks).find(([name]) => name.startsWith(taskNamePrefix))?.[1];
  const taskName = `${fixture.id} — ${fixture.description || fixture.documentType}`;

  try {
    if (existingTaskId) {
      await clickupClient.put(`/task/${existingTaskId}`, { name: taskName, description, status });
      console.log(`  ClickUp updated: ${existingTaskId}`);
      await clickupClient.post(`/task/${existingTaskId}/comment`, {
        comment_text: `**${timestamp}** — ${icon} ${passedCount}/${totalCount}\n\n${commentLines.join('\n')}`, notify_all: false,
      });
    } else {
      const { data } = await clickupClient.post(`/list/${runListId}/task`, {
        name: taskName, description, status,
      });
      existingTasks[taskName] = data.id;
      console.log(`  ClickUp created: ${data.url}`);
    }
  } catch (err) { console.warn(`  ClickUp failed for ${fixture.id}: ${err.message}`); }
}

// -- Slack summary ------------------------------------------------------------

// Canonical section order for Slack report
const SECTION_ORDER = [
  'Bank / Financial',
  'Employment',
  'Identity / KYC',
  'Utility Bills',
  'KYB',
  'Fraud',
  'Infrastructure',
];

// Truncate a string to a max length, adding ellipsis if cut.
function truncate(s, max) {
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

// Build a markdown text for one section; splits into multiple chunks if it
// would exceed Slack's 3000-char per-section-block limit.
function buildSectionChunks(sectionName, items) {
  const passed = items.filter(i => i.passed).length;
  const tot = items.length;
  const icon = passed === tot ? '✅' : '❌';
  const header = `*${sectionName}* — ${passed}/${tot} ${icon}`;
  const lines = items.map(fr => {
    const rIcon = fr.passed ? '✅' : '❌';
    const detail = fr.passed ? truncate(fr.description, 140) : truncate(fr.reason, 240);
    return `${rIcon} ${fr.id} — ${detail} (${fr.passedCount}/${fr.totalCount})`;
  });

  const MAX = 2900;
  const chunks = [];
  let current = header;
  for (const line of lines) {
    const next = current + '\n' + line;
    if (next.length > MAX) {
      chunks.push(current);
      current = '(cont.) ' + line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function buildSlackMessage(fixtureResults, totalPassed, totalFailed, allWarnings, startTime) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(0, 16).replace('T', ' ');
  const elapsed = Date.now() - startTime;
  const minutes = Math.floor(elapsed / 60000);
  const seconds = Math.floor((elapsed % 60000) / 1000);
  const total = totalPassed + totalFailed;
  const allPassed = totalFailed === 0;
  const fixturePassed = fixtureResults.filter(fr => fr.passed).length;
  const fixtureTotal = fixtureResults.length;

  // Group fixtures by section
  const bySection = new Map();
  for (const fr of fixtureResults) {
    const key = fr.section || 'Uncategorized';
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(fr);
  }
  const orderedSections = [...SECTION_ORDER.filter(s => bySection.has(s)),
    ...[...bySection.keys()].filter(s => !SECTION_ORDER.includes(s))];

  // One section block per section (split into chunks if needed)
  const sectionBlocks = [];
  for (const section of orderedSections) {
    const chunks = buildSectionChunks(section, bySection.get(section));
    for (const chunk of chunks) {
      sectionBlocks.push({ type: 'section', text: { type: 'mrkdwn', text: chunk } });
    }
  }

  // Failed fixtures block (only if any)
  const failed = fixtureResults.filter(fr => !fr.passed);
  const failedText = failed.length
    ? `*❌ Failed Fixtures:*\n${failed.map(fr => `• ${fr.id}: ${truncate(fr.reason, 240)}`).join('\n')}`
    : `*✅ No failures*`;

  // Warnings block (truncate if huge)
  const warningText = allWarnings.length
    ? truncate(`*⚠️ Warnings (${allWarnings.length}):*\n${allWarnings.map(w => `• ${w}`).join('\n')}`, 2900)
    : `*⚠️ Warnings (0):*\nNone`;

  return [
    { type: 'header', text: { type: 'plain_text', text: `VerifyIQ Staging Regression — ${timeStr} UTC` } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Result:*\n${allPassed ? '✅ ALL PASSED' : '❌ FAILURES FOUND'}` },
        { type: 'mrkdwn', text: `*Score:*\n${totalPassed}/${total} assertions` },
        { type: 'mrkdwn', text: `*Fixtures:*\n${fixturePassed}/${fixtureTotal} passed` },
        { type: 'mrkdwn', text: `*Duration:*\n${minutes}m ${seconds}s` },
      ],
    },
    { type: 'divider' },
    ...sectionBlocks,
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: failedText } },
    { type: 'section', text: { type: 'mrkdwn', text: warningText } },
    { type: 'section', text: { type: 'mrkdwn', text: `*📋 ClickUp:* Regression ${dateStr}` } },
  ];
}

export async function postToSlack(fixtureResults, totalPassed, totalFailed, allWarnings, startTime) {
  if (!SLACK_WEBHOOK_URL) { console.warn('  SLACK_WEBHOOK_URL not set -- skipping Slack notification'); return; }
  const blocks = buildSlackMessage(fixtureResults, totalPassed, totalFailed, allWarnings, startTime);
  try {
    await axios.post(SLACK_WEBHOOK_URL, { blocks });
    console.log('  Slack notification sent');
  } catch (err) { console.warn(`  Slack notification failed: ${err.message}`); }
}
