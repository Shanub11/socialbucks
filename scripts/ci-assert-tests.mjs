#!/usr/bin/env node
// CI gate for the vitest JSON report: exits non-zero unless every test ran and passed.
// Usage: node scripts/ci-assert-tests.mjs <vitest-json-path> [--min-tests=N]

import { readFile } from 'node:fs/promises';

const MAX_MESSAGE = 400;
const MAX_LISTED = 5;

function fail(message) {
  console.error(`[ci-assert-tests] ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const resultsPath = args.find((a) => !a.startsWith('--'));
const minArg = args.find((a) => a.startsWith('--min-tests='));
const minTests = minArg ? Number(minArg.split('=')[1]) : 1;

if (!resultsPath) {
  fail('usage: node scripts/ci-assert-tests.mjs <vitest-json-path> [--min-tests=N]');
}
if (!Number.isInteger(minTests) || minTests < 1) {
  fail('--min-tests must be a positive integer');
}

let report;
try {
  report = JSON.parse(await readFile(resultsPath, 'utf8'));
} catch {
  fail(`results file missing or not valid JSON: "${resultsPath}"`);
}

// Refuse to guess: a renamed field must not silently read as zero failures.
const COUNTERS = [
  'numTotalTests',
  'numPassedTests',
  'numFailedTests',
  'numPendingTests',
  'numTodoTests',
  'numFailedTestSuites',
];
for (const key of COUNTERS) {
  if (!Number.isInteger(report[key])) {
    fail(`unexpected report shape: "${key}" is missing or not a number (did the vitest JSON format change?)`);
  }
}
if (!Array.isArray(report.testResults)) {
  fail('unexpected report shape: "testResults" is missing');
}

const total = report.numTotalTests;
const passed = report.numPassedTests;
const failed = report.numFailedTests;
const failedSuites = report.numFailedTestSuites;
const skipped = report.numPendingTests + report.numTodoTests;

console.log(
  `[ci-assert-tests] passed=${passed} failed=${failed} skipped=${skipped} total=${total} failedSuites=${failedSuites}`,
);

const tests = report.testResults.flatMap((file) => file.assertionResults ?? []);
const short = (text) => String(text ?? '').replace(/\s+/g, ' ').slice(0, MAX_MESSAGE);

if (failed > 0 || failedSuites > 0) {
  for (const t of tests.filter((x) => x.status === 'failed').slice(0, MAX_LISTED)) {
    console.error(`  FAIL ${t.fullName || t.title}: ${short(t.failureMessages?.[0])}`);
  }
  const brokenFiles = report.testResults
    .filter((f) => f.status === 'failed' && !(f.assertionResults ?? []).some((t) => t.status === 'failed'))
    .slice(0, MAX_LISTED);
  for (const f of brokenFiles) {
    console.error(`  FAIL (suite did not run) ${f.name}: ${short(f.message)}`);
  }
  fail(`${failed} test(s) failed, ${failedSuites} suite(s) failed`);
}

if (skipped > 0) {
  for (const t of tests.filter((x) => x.status !== 'passed').slice(0, MAX_LISTED)) {
    console.error(`  SKIPPED ${t.fullName || t.title} (${t.status})`);
  }
  fail('tests were skipped: RUN_DB_TESTS or the database configuration is wrong');
}

if (total === 0) fail('no tests ran');
if (passed !== total) fail(`only ${passed} of ${total} tests passed`);
if (total < minTests) {
  fail(`only ${total} tests ran; expected at least ${minTests} (a test file may be missing or undiscovered)`);
}
if (report.success !== true) fail('vitest reported success=false');

console.log(`[ci-assert-tests] OK: ${passed} passed, 0 failed, 0 skipped (minimum ${minTests})`);