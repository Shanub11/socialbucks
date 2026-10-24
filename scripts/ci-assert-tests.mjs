#!/usr/bin/env node
/**
 * CI test-result assertion script.
 *
 * Reads the vitest JSON results file (path passed as argv[2]) and exits non-zero
 * if any test failed, was skipped/pending, or if zero tests ran.
 *
 * The purpose is to make skipped DB-backed tests (which vitest marks as
 * "pending" via describe.skip) impossible to miss in CI. When RUN_DB_TESTS=1
 * is not set or DATABASE_URL is misconfigured, those tests are skipped rather
 * than run, and vitest still exits green — so we add an explicit gate here.
 *
 * Usage:
 *   node scripts/ci-assert-tests.mjs <vitest-json-path>
 */

import { readFile } from 'node:fs/promises';

const resultsPath = process.argv[2];

if (!resultsPath) {
  console.error('[ci-assert-tests] No vitest JSON path provided (argv[2]); usage: node scripts/ci-assert-tests.mjs <vitest-json-path>');
  process.exit(1);
}

// --- Load and parse the vitest JSON report -----------------------------------

let results;
try {
  const content = await readFile(resultsPath, 'utf8');
  results = JSON.parse(content);
} catch {
  console.error(`[ci-assert-tests] vitest results file missing or unparseable: "${resultsPath}"`);
  process.exit(1);
}

// Vitest JSON reporter field names
const numTotalTests = results.numTotalTests ?? 0;
const numFailedTests = results.numFailedTests ?? 0;
const numPendingTests = results.numPendingTests ?? 0;
const numTodoTests = results.numTodoTests ?? 0;

const passed = numTotalTests - numFailedTests - numPendingTests - numTodoTests;

// --- Summary printer (always called on failure) -------------------------------

function printSummary() {
  console.log(`passed: ${passed}`);
  console.log(`failed: ${numFailedTests}`);
  console.log(`skipped: ${numPendingTests + numTodoTests}`);
  console.log(`total: ${numTotalTests}`);
}

// --- Failure conditions (checked in spec order) ------------------------------

// 1. numFailedTests > 0 — print first 5 failing test names + first 400 chars of message
if (numFailedTests > 0) {
  printSummary();
  console.error(`[ci-assert-tests] ${numFailedTests} test${numFailedTests !== 1 ? 's' : ''} failed`);

  const failingTests = (results.testResults ?? [])
    .filter((t) => t.status === 'failed' || (t.assertionErrors && Object.keys(t.assertionErrors).length > 0))
    .slice(0, 5);

  for (const test of failingTests) {
    const name = test.title || test.name || test.fullName || 'unknown';
    // Vitest JSON reporter stores errors under test.assertionErrors (object) or test.error (string)
    let message = '';
    if (test.assertionErrors) {
      const firstKey = Object.keys(test.assertionErrors)[0];
      if (firstKey) {
        message = test.assertionErrors[firstKey]?.message || '';
      }
    }
    if (!message && test.error) {
      message = typeof test.error === 'string' ? test.error : test.error.message || '';
    }
    const truncated = message.substring(0, 400);
    console.error(`  FAIL — ${name}: ${truncated}`);
  }

  process.exit(1);
}

// 2. numPendingTests > 0 || numTodoTests > 0 — DB tests were skipped
if (numPendingTests > 0 || numTodoTests > 0) {
  printSummary();
  console.error('DB tests were skipped: RUN_DB_TESTS or DATABASE_URL is misconfigured');
  process.exit(1);
}

// 3. numTotalTests === 0 — no tests ran at all
if (numTotalTests === 0) {
  printSummary();
  console.error('[ci-assert-tests] No tests ran (numTotalTests === 0)');
  process.exit(1);
}

// --- All checks passed -------------------------------------------------------
process.exit(0);
