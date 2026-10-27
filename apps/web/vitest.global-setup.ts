import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Runs once before any test file. When database tests are enabled it refuses to
// start unless every database variable points at the same local *_test database.
export default function setup(): void {
  if (!process.env.RUN_DB_TESTS) return;

  const guard = fileURLToPath(new URL('../../scripts/assert-test-db.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [guard], { encoding: 'utf8', env: process.env });

  if (result.status !== 0) {
    throw new Error(
      'Refusing to run database tests:\n' +
        (result.stderr || result.stdout || 'guard failed') +
        '\nSet TEST_DATABASE_URL and DATABASE_URL to the same local *_test database (see docker-compose.test.yml).',
    );
  }
}