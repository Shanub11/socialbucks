import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./review-packet.mjs', import.meta.url));
const CONFIG = fileURLToPath(new URL('./protected-paths.json', import.meta.url));
const tempDirs = [];

// Secret-shaped fixtures are assembled at runtime so no line of this file
// contains a contiguous credential-shaped token.
const joinSecret = (...parts) => parts.join('');
const FAKE_GOOGLE_API_KEY = joinSecret('AI', 'za', 'F'.repeat(30));
const FAKE_GOOGLE_OAUTH_SECRET = joinSecret('GOCS', 'PX-', 'F'.repeat(16));
const FAKE_GOOGLE_ACCESS_TOKEN = joinSecret('ya', '29.', 'F'.repeat(24));
const FAKE_STRIPE_LIVE_KEY = joinSecret('sk_', 'live', '_', 'F'.repeat(24));
const FAKE_WEBHOOK_SECRET = joinSecret('wh', 'sec_', 'F'.repeat(24));
const FAKE_RAZORPAY_LIVE_KEY = joinSecret('rzp_', 'live', '_', 'F'.repeat(16));
const FAKE_PRIVATE_KEY = joinSecret('-----', 'BEGIN', ' RSA ', 'PRIVATE KEY', '-----');
const FAKE_CREDENTIALS_URL = joinSecret(
  'https:',
  '//',
  'admin',
  ':',
  'F'.repeat(16),
  '@',
  'api.example.com',
  '/v1',
);
const FAKE_JWT = joinSecret(
  'ey',
  'J',
  'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  '.',
  'F'.repeat(32),
  '.',
  'F'.repeat(16),
);
const FAKE_GENERIC_SECRET = joinSecret('password', ' = ', '"', 'F'.repeat(20), '"');

after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort.
    }
  }
});

function track(dir) {
  tempDirs.push(dir);
  return dir;
}

function gitIn(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed while preparing fixture`);
  }
  return result.stdout;
}

function mkRepo() {
  const dir = track(mkdtempSync(join(tmpdir(), 'cpx-packet-')));
  gitIn(dir, ['init', '-q', '-b', 'main']);
  gitIn(dir, ['config', 'user.name', 'CPX Test']);
  gitIn(dir, ['config', 'user.email', 'cpx@example.test']);
  gitIn(dir, ['config', 'core.autocrlf', 'false']);
  gitIn(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

function write(dir, relative, content) {
  const target = join(dir, ...relative.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function commitAll(dir, message) {
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['commit', '-q', '-m', message]);
  return gitIn(dir, ['rev-parse', 'HEAD']).trim();
}

function fixture(files) {
  const dir = mkRepo();
  write(dir, 'README.md', '# base\n');
  for (const [path, content] of Object.entries(files ?? {})) {
    write(dir, path, content);
  }
  const base = commitAll(dir, 'base commit');
  return { dir, base };
}

function runPacket(dir, base, head, options = {}) {
  const { headRef, config = CONFIG, extraArgs = [], envExtra = {}, cwd = dir } = options;
  const env = { ...process.env, ...envExtra };
  if (headRef !== undefined) {
    env.HEAD_REF = headRef;
  }
  const args = [CLI, '--repo', dir, '--base', base, '--head', head, '--config', config, ...extraArgs];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env, cwd });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

// ------------------------------------------------------------------- test cases

test('review-packet: every section header is present and in the expected order', () => {
  const { dir, base } = fixture();
  write(dir, 'apps/web/src/components/ui/button.tsx', 'export const b = 1;\n');
  const head = commitAll(dir, 'add button');

  const result = runPacket(dir, base, head);
  assert.equal(result.status, 0, result.stderr);

  const expectedHeaders = [
    '== HEADER ==',
    '== SUMMARY ==',
    '== PROTECTED PATHS TOUCHED ==',
    '== OTHER FILES ==',
    '== EXISTING TESTS MODIFIED OR DELETED ==',
    '== NEW FILES ==',
    '== DEPENDENCIES ==',
    '== FINDINGS ==',
    '== TOTALS ==',
    '== NEXT ==',
  ];

  let lastIndex = -1;
  for (const header of expectedHeaders) {
    const idx = result.stdout.indexOf(header);
    assert.ok(idx !== -1, `missing section header: ${header}`);
    assert.ok(idx > lastIndex, `header ${header} out of order`);
    lastIndex = idx;
  }
});

test('review-packet: the whole output is printable ASCII only', () => {
  const { dir, base } = fixture();
  write(dir, 'apps/web/src/components/ui/button.tsx', 'export const b = 1;\n');
  const head = commitAll(dir, 'add button');

  const result = runPacket(dir, base, head);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^[\x20-\x7E\n]*$/);
});

test('review-packet: an empty diff produces all sections with zero totals', () => {
  const { dir, base } = fixture();
  const result = runPacket(dir, base, base);
  assert.equal(result.status, 0, result.stderr);

  assert.ok(result.stdout.includes('== HEADER =='));
  assert.ok(result.stdout.includes('== NEXT =='));
  assert.match(
    result.stdout,
    /TOTALS protected=0 existing_tests_changed=0 high=0 note=0 dep_changes=0 unparsed_files=0/,
  );
});

test('review-packet: protected and other files are split correctly using real config', () => {
  const { dir, base } = fixture();
  write(dir, 'apps/web/src/lib/creator/format.ts', 'export const f = 1;\n');
  write(dir, 'apps/web/src/components/ui/button.tsx', 'export const b = 1;\n');
  const head = commitAll(dir, 'mixed files');

  const result = runPacket(dir, base, head);
  assert.equal(result.status, 0);

  const protSection = result.stdout.slice(
    result.stdout.indexOf('== PROTECTED PATHS TOUCHED =='),
    result.stdout.indexOf('== OTHER FILES =='),
  );
  const otherSection = result.stdout.slice(
    result.stdout.indexOf('== OTHER FILES =='),
    result.stdout.indexOf('== EXISTING TESTS MODIFIED OR DELETED =='),
  );

  assert.ok(protSection.includes('A apps/web/src/lib/creator/format.ts'));
  assert.ok(!protSection.includes('apps/web/src/components/ui/button.tsx'));

  assert.ok(otherSection.includes('A apps/web/src/components/ui/button.tsx'));
  assert.ok(!otherSection.includes('apps/web/src/lib/creator/format.ts'));
});

test('review-packet: existing test file modification is listed while new test file is not', () => {
  const { dir, base } = fixture({
    'apps/web/src/utils/math.test.ts': 'export const t = 1;\n',
  });
  write(dir, 'apps/web/src/utils/math.test.ts', 'export const t = 2;\n');
  write(dir, 'apps/web/src/utils/new.test.ts', 'export const n = 1;\n');
  const head = commitAll(dir, 'edit and new test');

  const result = runPacket(dir, base, head);
  assert.equal(result.status, 0);

  const existingTestSection = result.stdout.slice(
    result.stdout.indexOf('== EXISTING TESTS MODIFIED OR DELETED =='),
    result.stdout.indexOf('== NEW FILES =='),
  );

  assert.ok(existingTestSection.includes('M apps/web/src/utils/math.test.ts'));
  assert.ok(!existingTestSection.includes('new.test.ts'));
  assert.match(result.stdout, /existing_tests_changed=1/);
});

test('review-packet: each HIGH rule family fires on a crafted line and secrets are never echoed', () => {
  const { dir, base } = fixture();
  const FILE = 'apps/web/src/components/ui/button.tsx';
  const TEST_F = 'apps/web/src/utils/helper.test.ts';

  const secretTokens = {
    googleApi: FAKE_GOOGLE_API_KEY,
    googleOauth: FAKE_GOOGLE_OAUTH_SECRET,
    googleToken: FAKE_GOOGLE_ACCESS_TOKEN,
    stripeKey: FAKE_STRIPE_LIVE_KEY,
    webhookSec: FAKE_WEBHOOK_SECRET,
    razorpayKey: FAKE_RAZORPAY_LIVE_KEY,
    privateKey: FAKE_PRIVATE_KEY,
    credsUrl: FAKE_CREDENTIALS_URL,
    jwtToken: FAKE_JWT,
    genericSecret: FAKE_GENERIC_SECRET,
  };

  const linesToAdd = [
    '<div dangerouslySetInnerHTML={{ __html: "x" }} />',
    'eval("1 + 1");',
    'new Function("return 1");',
    '// @ts-ignore',
    '/* eslint-disable */',
    'const x = foo as any;',
    'console.log("hello");',
    secretTokens.googleApi,
    secretTokens.googleOauth,
    secretTokens.googleToken,
    secretTokens.stripeKey,
    secretTokens.webhookSec,
    secretTokens.razorpayKey,
    secretTokens.privateKey,
    secretTokens.credsUrl,
    secretTokens.jwtToken,
    secretTokens.genericSecret,
  ];

  write(dir, FILE, linesToAdd.join('\n') + '\n');
  write(dir, TEST_F, 'it.only("focus", () => {});\n');
  const head = commitAll(dir, 'craft all high families');

  const result = runPacket(dir, base, head);
  assert.equal(result.status, 0);

  // Assert non-secret rules fired
  assert.match(result.stdout, /HIGH dangerouslySetInnerHTML/);
  assert.match(result.stdout, /HIGH eval/);
  assert.match(result.stdout, /HIGH new-Function/);
  assert.match(result.stdout, /HIGH ts-ignore/);
  assert.match(result.stdout, /HIGH eslint-disable/);
  assert.match(result.stdout, /HIGH any-type/);
  assert.match(result.stdout, /HIGH console-log/);
  assert.match(result.stdout, /HIGH focused-test/);

  // Assert secret rules fired
  assert.match(result.stdout, /HIGH google-api-key/);
  assert.match(result.stdout, /HIGH google-oauth-secret/);
  assert.match(result.stdout, /HIGH google-access-token/);
  assert.match(result.stdout, /HIGH stripe-style-key/);
  assert.match(result.stdout, /HIGH webhook-secret/);
  assert.match(result.stdout, /HIGH razorpay-key/);
  assert.match(result.stdout, /HIGH private-key/);
  assert.match(result.stdout, /HIGH credentials-url/);
  assert.match(result.stdout, /HIGH jwt-token/);
  assert.match(result.stdout, /HIGH generic-secret/);

  // Assert secrets are NOT present in output
  for (const [k, token] of Object.entries(secretTokens)) {
    assert.equal(result.stdout.includes(token), false, `secret token ${k} leaked in output!`);
  }
});

test('review-packet: process.env in allowlisted file does not fire while other file does', () => {
  const { dir, base } = fixture({
    'apps/web/src/lib/env.ts': 'export const env = {};\n',
    'apps/web/src/components/ui/button.tsx': 'export const b = 1;\n',
  });

  write(dir, 'apps/web/src/lib/env.ts', 'export const env = {};\nconst a = process.env.A;\n');
  write(dir, 'apps/web/src/components/ui/button.tsx', 'export const b = 1;\nconst b = process.env.B;\n');
  const head = commitAll(dir, 'env readers');

  const result = runPacket(dir, base, head);
  assert.equal(result.status, 0);

  assert.match(result.stdout, /HIGH env-access apps\/web\/src\/components\/ui\/button\.tsx:2/);
  assert.ok(!result.stdout.includes('HIGH env-access apps/web/src/lib/env.ts'));
});

test('review-packet: non-ASCII in a NEW file fires while non-ASCII in modified existing file does not', () => {
  const { dir, base } = fixture({
    'apps/web/src/components/ui/button.tsx': 'export const b = 1;\n',
  });

  // Modify existing file with non-ASCII
  write(dir, 'apps/web/src/components/ui/button.tsx', 'export const b = "\u00e9";\n');
  // Add new file with non-ASCII
  write(dir, 'apps/web/src/components/ui/card.tsx', 'export const c = "\u00e9";\n');
  const head = commitAll(dir, 'non ascii changes');

  const result = runPacket(dir, base, head);
  assert.equal(result.status, 0);

  assert.match(result.stdout, /HIGH non-ascii apps\/web\/src\/components\/ui\/card\.tsx:1/);
  assert.ok(!result.stdout.includes('HIGH non-ascii apps/web/src/components/ui/button.tsx'));
});

test('review-packet: a new .env file fires', () => {
  const { dir, base } = fixture();
  write(dir, 'apps/web/.env.local', 'KEY=val\n');
  const head = commitAll(dir, 'add env file');

  const result = runPacket(dir, base, head);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /HIGH secret-file apps\/web\/\.env\.local:1/);
});

test('review-packet: package.json changes show +, - and ~ entries, lockfile-only shows WARNING', () => {
  const basePkg = JSON.stringify(
    {
      name: 'root',
      dependencies: {
        unchanged: '1.0.0',
        changed: '1.0.0',
        removed: '1.0.0',
      },
    },
    null,
    2,
  ) + '\n';

  const { dir, base } = fixture({ 'package.json': basePkg });

  const headPkg = JSON.stringify(
    {
      name: 'root',
      dependencies: {
        unchanged: '1.0.0',
        changed: '2.0.0',
        added: '1.0.0',
      },
    },
    null,
    2,
  ) + '\n';

  write(dir, 'package.json', headPkg);
  const head1 = commitAll(dir, 'change deps');

  const res1 = runPacket(dir, base, head1);
  assert.equal(res1.status, 0);
  assert.match(res1.stdout, /\+ added 1\.0\.0/);
  assert.match(res1.stdout, /- removed 1\.0\.0/);
  assert.match(res1.stdout, /~ changed 1\.0\.0 -> 2\.0\.0/);

  // Lockfile-only change
  write(dir, 'pnpm-lock.yaml', 'lockfilecontent\n');
  const head2 = commitAll(dir, 'lockfile change');

  const res2 = runPacket(dir, head1, head2);
  assert.equal(res2.status, 0);
  assert.match(res2.stdout, /pnpm-lock\.yaml changed/);
  assert.match(res2.stdout, /WARNING: lockfile changed without package\.json change/);
});

test('review-packet: a migration file appears under migrations', () => {
  const { dir, base } = fixture();
  write(dir, 'packages/database/prisma/migrations/20261122_init/migration.sql', '-- init\n');
  const head = commitAll(dir, 'add migration');

  const result = runPacket(dir, base, head);
  assert.equal(result.status, 0);

  const newFilesSection = result.stdout.slice(
    result.stdout.indexOf('== NEW FILES =='),
    result.stdout.indexOf('== DEPENDENCIES =='),
  );

  assert.match(newFilesSection, /migrations \(1\):/);
  assert.ok(newFilesSection.includes('packages/database/prisma/migrations/20261122_init/migration.sql'));
});

test('review-packet: more than 40 files is capped with "... and N more"', () => {
  const { dir, base } = fixture();
  for (let i = 0; i < 45; i += 1) {
    write(dir, `apps/web/src/components/ui/comp${i}.tsx`, `export const c${i} = 1;\n`);
  }
  const head = commitAll(dir, 'many files');

  const result = runPacket(dir, base, head);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\.\.\. and 5 more/);
});

test('review-packet: a path containing spaces shows correctly in FINDINGS (no trailing tab)', () => {
  const { dir, base } = fixture();
  write(dir, 'apps/web/src/components/ui/my button.tsx', 'export const b = 1;\n<div dangerouslySetInnerHTML={{ __html: "x" }} />\n');
  const head = commitAll(dir, 'spaces in path');

  const result = runPacket(dir, base, head);
  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    /HIGH dangerouslySetInnerHTML apps\/web\/src\/components\/ui\/my button\.tsx:2/,
  );
  assert.ok(!result.stdout.includes('my button.tsx\t'));
});

test('review-packet: option injection rejected, unknown flag rejected, hostile branch sanitized', () => {
  const { dir, base } = fixture();
  write(dir, 'apps/web/src/components/ui/button.tsx', 'export const b = 1;\n');
  const head = commitAll(dir, 'add button');

  // Option injection
  const scratch = track(mkdtempSync(join(tmpdir(), 'cpx-rp-scratch-')));
  const resOpt = spawnSync(
    process.execPath,
    [CLI, '--repo', dir, '--base', '--output=pwn', '--head', head, '--config', CONFIG],
    { encoding: 'utf8', cwd: scratch },
  );
  assert.equal(resOpt.status, 1);
  assert.match(resOpt.stdout ?? '', /\[review-packet\] ERROR: /);
  assert.equal(existsSync(join(scratch, 'pwn')), false);

  // Unknown flag
  const resFlag = runPacket(dir, base, head, { extraArgs: ['--unknown'] });
  assert.equal(resFlag.status, 1);
  assert.match(resFlag.stdout, /\[review-packet\] ERROR: unknown argument --unknown/);

  // Hostile branch name sanitization
  const resBranch = runPacket(dir, base, head, { headRef: 'fb/pwn\n::error::pwned' });
  assert.equal(resBranch.status, 0);
  assert.match(resBranch.stdout, /^[\x20-\x7E\n]*$/);
  assert.match(resBranch.stdout, /branch: fb\/pwn\?\?\?error\?\?pwned/);
});

// ----------------------------------------------- sanitisation, docs, lockfiles, deps

test('review-packet: a filename with a newline cannot forge output', { skip: process.platform === 'win32' }, () => {
  const { dir, base } = fixture();
  write(dir, 'apps/web/src/components/ui/line\nbreak.tsx', 'export const b = 1;\n');
  const head = commitAll(dir, 'add newline file');

  const result = runPacket(dir, base, head);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^[\x20-\x7E\n]*$/);
  assert.match(result.stdout, /^A apps\/web\/src\/components\/ui\/line\?break\.tsx$/m);

  const isExpectedLine = (line) =>
    line === '' ||
    /^== [A-Z ]+ ==$/.test(line) ||
    /^branch: /.test(line) ||
    /^head: [0-9a-f]{12}$/.test(line) ||
    /^base: /.test(line) ||
    /^merge-base: [0-9a-f]{12}$/.test(line) ||
    /^commits: [0-9]+$/.test(line) ||
    /^  .*$/.test(line) ||
    /^files (?:changed|added|modified|deleted): [0-9]+$/.test(line) ||
    /^(?:insertions|deletions): [0-9]+$/.test(line) ||
    /^[AMDT] .*$/.test(line) ||
    /^migrations \([0-9]+\):$/.test(line) ||
    /^tests \([0-9]+\):$/.test(line) ||
    /^other: [0-9]+$/.test(line) ||
    /^TOTALS /.test(line) ||
    /^paste this packet to Claude;$/.test(line) ||
    /^and for every file under PROTECTED PATHS TOUCHED /.test(line) ||
    /^\.\.\. and [0-9]+ more$/.test(line) ||
    /^(?:HIGH|NOTE) /.test(line) ||
    /^WARNING: /.test(line) ||
    /^[^ ]+ changed$/.test(line);

  for (const line of result.stdout.split('\n')) {
    assert.ok(isExpectedLine(line), `unexpected output line ${JSON.stringify(line)}`);
  }
});

test('review-packet: a non-ASCII filename is printed sanitised and the output stays ASCII', () => {
  const { dir, base } = fixture();
  write(dir, 'apps/web/src/components/ui/caf\u00e9.tsx', 'export const c = 1;\n');
  const head = commitAll(dir, 'add accented file');

  const result = runPacket(dir, base, head);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^[\x20-\x7E\n]*$/);
  assert.match(result.stdout, /^A apps\/web\/src\/components\/ui\/caf\?\.tsx$/m);
});

test('review-packet: code-like prose in a markdown file produces no code findings', () => {
  const FILE = 'docs/runbooks/prose.md';
  const { dir, base } = fixture({ [FILE]: '# Prose\n' });
  write(
    dir,
    FILE,
    '# Prose\n' +
      'Never use dangerouslySetInnerHTML.\n' +
      '@ts-ignore is banned.\n' +
      'process.env belongs on the server.\n' +
      'console.log is noisy.\n' +
      'TODO: rewrite this later.\n',
  );
  const head = commitAll(dir, 'prose edit');

  const result = runPacket(dir, base, head);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.includes('HIGH'), false);
  assert.equal(result.stdout.includes('NOTE'), false);
});

test('review-packet: a secret in a markdown file still fires and is never echoed', () => {
  const FILE = 'docs/runbooks/creds.md';
  const token = FAKE_STRIPE_LIVE_KEY;
  const { dir, base } = fixture({ [FILE]: '# Creds\n' });
  write(dir, FILE, `# Creds\nkey: ${token}\n`);
  const head = commitAll(dir, 'add secret prose');

  const result = runPacket(dir, base, head);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /HIGH stripe-style-key docs\/runbooks\/creds\.md:2/);
  assert.equal(result.stdout.includes(token), false);
});

test('review-packet: non-ASCII in a new markdown file still fires', () => {
  const FILE = 'docs/runbooks/na\u00efve.md';
  const { dir, base } = fixture();
  write(dir, FILE, '# Na\u00efve\n');
  const head = commitAll(dir, 'add accented doc');

  const result = runPacket(dir, base, head);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /HIGH non-ascii docs\/runbooks\/na\?ve\.md:1/);
  assert.match(result.stdout, /^[\x20-\x7E\n]*$/);
});

test('review-packet: .env.example is not a secret file but .env.local is', () => {
  const { dir, base } = fixture();
  write(dir, 'apps/web/.env.example', 'KEY=placeholder\n');
  const head1 = commitAll(dir, 'add env example');

  const res1 = runPacket(dir, base, head1);
  assert.equal(res1.status, 0);
  assert.equal(res1.stdout.includes('HIGH secret-file'), false);

  write(dir, 'apps/web/.env.local', 'KEY=placeholder\n');
  const head2 = commitAll(dir, 'add env local');

  const res2 = runPacket(dir, head1, head2);
  assert.equal(res2.status, 0);
  assert.match(res2.stdout, /HIGH secret-file apps\/web\/\.env\.local:1/);
});

test('review-packet: package-lock.json and yarn.lock changes show the lockfile WARNING', () => {
  const { dir, base } = fixture();
  write(dir, 'package-lock.json', '{}\n');
  write(dir, 'yarn.lock', '# yarn\n');
  const head = commitAll(dir, 'add lockfiles');

  const result = runPacket(dir, base, head);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /package-lock\.json changed/);
  assert.match(result.stdout, /yarn\.lock changed/);
  const warnings = result.stdout.split('WARNING: lockfile changed without package.json change').length - 1;
  assert.equal(warnings, 1);
});

test('review-packet: invalid JSON in the head package.json prints unreadable (head)', () => {
  const basePkg = JSON.stringify({ name: 'web', dependencies: { a: '1.0.0' } }, null, 2) + '\n';
  const { dir, base } = fixture({ 'apps/web/package.json': basePkg });
  write(dir, 'apps/web/package.json', '{ "name": "web",\n');
  const head = commitAll(dir, 'break package json');

  const result = runPacket(dir, base, head);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /  unreadable \(head\)/);
  assert.equal(result.stdout.includes('  unreadable (base)'), false);
});

test('review-packet: a package.json absent in base lists its dependencies as added', () => {
  const { dir, base } = fixture();
  const headPkg = JSON.stringify({ name: 'web', dependencies: { addeddep: '1.2.3' } }, null, 2) + '\n';
  write(dir, 'apps/web/package.json', headPkg);
  const head = commitAll(dir, 'add package json');

  const result = runPacket(dir, base, head);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\+ addeddep 1\.2\.3/);
  assert.equal(result.stdout.includes('unreadable'), false);
});

test('review-packet: the renamed stripe-style-key rule id is used', () => {
  const { dir, base } = fixture();
  write(dir, 'apps/web/src/components/ui/key.ts', `const k = "${FAKE_STRIPE_LIVE_KEY}";\n`);
  const head = commitAll(dir, 'add stripe key');

  const result = runPacket(dir, base, head);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /HIGH stripe-style-key apps\/web\/src\/components\/ui\/key\.ts:1/);
  assert.equal(result.stdout.includes('stripe-or-openai-key'), false);
});
