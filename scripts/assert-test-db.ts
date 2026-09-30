#!/usr/bin/env node
/**
 * Guard: refuses to run if DATABASE_URL or DIRECT_URL doesn't end in _test.
 * Prevents accidental migration against production/live databases.
 */

import { URL } from 'node:url';

const envVar = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;

if (!envVar) {
  console.error('[guard] No DATABASE_URL, DIRECT_URL, or TEST_DATABASE_URL set');
  process.exit(1);
}

let url: URL;
try {
  url = new URL(envVar);
} catch {
  console.error('[guard] Invalid database URL');
  process.exit(1);
}

const dbName = url.pathname.slice(1); // remove leading '/'
if (!dbName.endsWith('_test')) {
  console.error(`[guard] Refusing to run: database name "${dbName}" does not end in _test`);
  console.error(`[guard] Set TEST_DATABASE_URL to a _test database (e.g. socialbucks_test)`);
  process.exit(1);
}

console.log(`[guard] OK: database "${dbName}" is a test database`);