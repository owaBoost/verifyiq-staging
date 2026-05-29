// test/suppression-guard.test.mjs
//
// Fault-injection coverage for the batchUpload and runDedup suppression guards.
//
// Strategy: mock.module withholds the app callback from pollWebhookCallbacks so
// that the real guard logic in keywords.mjs must detect the missing callback and
// return passed:false.
//
// Red-to-green proof:
//   RED  — git checkout 760e4f4^ -- src/keywords.mjs  (no guard in batchUpload;
//           runDedup pushes passed:true before the loop)
//   GREEN — git checkout HEAD   -- src/keywords.mjs  (guards in place)

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';

// ── Fake doc callback (no app callback in the payload) ────────────────────────
//
// decryptCallback is mocked to JSON.parse its input, so .content must be a
// JSON string of the decrypted shape.  documentId present → treated as doc
// callback; no applicationId field → app callback is never set.

const FAKE_DOC_CB = {
  content: JSON.stringify({
    documentId: 'doc-mock-aaa',
    status: 'COMPLETED',
    documentType: 'PAYSLIP',
    documentClassification: 'PRIMARY',
  }),
};

// ── Mocks — must be registered BEFORE the module under test is imported ───────

// src/utils.mjs — intercepts pollWebhookCallbacks and all network helpers
mock.module('../src/utils.mjs', {
  namedExports: {
    state: { webhookTokenId: 'mock-token' },
    sleep: async () => {},
    getWebhookIapToken: () => 'mock-iap-token',
    getWebhookBaseline: async () => 0,
    // Withhold the app callback: return (expectedCount - 1) doc callbacks only.
    pollWebhookCallbacks: async (_baseline, expectedCount, _appId, _opts) =>
      Array(expectedCount - 1).fill(FAKE_DOC_CB),
    decryptCallback: async (raw) => JSON.parse(raw),
    WEBHOOK_SERVER_URL: 'http://mock-webhook',
    GATEWAY_DOCTYPE_MAP: {},
    createApiClient: () => ({
      post: async () => ({
        status: 200,
        data: { applicationId: 'app-mock-123', status: 'PENDING' },
      }),
    }),
    // Unused in the two paths under test — stubs keep the import happy
    callParseBatch: async () => {},
    getBaseUrl: () => 'http://mock-base',
    callGetApplication: async () => {},
    callListApplications: async () => {},
    callListDocuments: async () => {},
    callGetDocumentPages: async () => {},
    callReprocessDocument: async () => {},
    callListActivities: async () => {},
    callExportApplication: async () => {},
    callExportDocument: async () => {},
  },
});

// src/validators.mjs — no validation errors, so they don't obscure the guard
mock.module('../src/validators.mjs', {
  namedExports: {
    RESPONSE_VALIDATORS: {},
    validateDocumentCallback: () => [],
    validateApplicationCallback: () => [],
  },
});

// run_regression.mjs — prevent the orchestrator from loading during import
mock.module('../run_regression.mjs', {
  namedExports: {
    isStubSkipped: () => false,
  },
});

// Dynamic import AFTER mocks are registered
const { batchUpload, runDedup } = await import('../src/keywords.mjs');

// ── Test 1: batchUpload guard ─────────────────────────────────────────────────

test('batchUpload: guard fires when app callback is withheld', async () => {
  const fixture = {
    id: 'GUARD-TEST-001',
    documentType: 'PAYSLIP',
    files: ['http://mock/payslip.jpg'],
  };

  const result = await batchUpload(fixture);

  assert.strictEqual(
    result.passed,
    false,
    `passed must be false when app callback is missing (got: ${result.summary})`,
  );
  assert.ok(
    result.summary.includes('Application callback missing'),
    `summary must mention missing app callback, got: "${result.summary}"`,
  );
});

// ── Test 2: runDedup guard ────────────────────────────────────────────────────

test('runDedup: guard fires when app callback is withheld', async () => {
  const fixture = {
    id: 'GUARD-DEDUP-001',
    documentType: 'PAYSLIP',
    files: ['http://mock/payslip.jpg'],
  };

  const results = [];
  await runDedup(fixture, results);

  assert.strictEqual(results.length, 1, 'runDedup must push exactly one result entry');
  assert.strictEqual(
    results[0].passed,
    false,
    `passed must be false when app callback is missing (got: ${results[0].summary})`,
  );
  assert.ok(
    results[0].summary.includes('Application callback missing'),
    `summary must mention missing app callback, got: "${results[0].summary}"`,
  );
});
