// Guard: refuse to run unless every configured database URL points at a LOCAL
// database whose name ends in _test, and all of them point at the same one.
// Never prints URLs (they contain passwords); prints host and database name only.

import { URL } from 'node:url';

const VARS = ['TEST_DATABASE_URL', 'DATABASE_URL', 'DIRECT_URL'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function fail(message) {
  console.error(`[guard] ${message}`);
  process.exit(1);
}

if (!process.env.TEST_DATABASE_URL) {
  fail('TEST_DATABASE_URL must be set');
}

const targets = [];
for (const name of VARS) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') continue;

  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`${name} is not a valid URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    fail(`${name} must be a postgres:// or postgresql:// URL`);
  }

  let dbName;
  try {
    dbName = decodeURIComponent(url.pathname.slice(1));
  } catch {
    fail(`${name} has a malformed database name`);
  }
  if (!dbName.endsWith('_test')) {
    fail(`${name}: database "${dbName}" does not end in _test`);
  }
  if (!LOCAL_HOSTS.has(url.hostname)) {
    fail(`${name}: host "${url.hostname}" is not local; test databases must run on localhost`);
  }

  targets.push({ name, key: `${url.hostname}:${url.port || '5432'}/${dbName}` });
}

const distinct = new Set(targets.map((t) => t.key));
if (distinct.size !== 1) {
  fail(
    'Database variables point at different databases: ' +
      targets.map((t) => `${t.name} -> ${t.key}`).join(', '),
  );
}

console.log(`[guard] OK: ${targets.length} variable(s) checked, all point at test database "${targets[0].key}"`);