import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  addedLines,
  assertSafeRev,
  globToRegExp,
  loadProtectedPatterns,
  matchesAny,
  parseDiffText,
  validatePattern,
} from './lib/changes.mjs';

const CLI = fileURLToPath(new URL('./ci-protected-paths.mjs', import.meta.url));
const CONFIG = fileURLToPath(new URL('./protected-paths.json', import.meta.url));
const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Cleanup is best effort; the OS reaps the temp directory.
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
    throw new Error(`git ${args[0]} failed while preparing a fixture`);
  }
  return result.stdout;
}

function mkRepo() {
  const dir = track(mkdtempSync(join(tmpdir(), 'cpx-guard-')));
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

function remove(dir, relative) {
  rmSync(join(dir, ...relative.split('/')), { force: true });
}

function renameInRepo(dir, from, to) {
  const target = join(dir, ...to.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  gitIn(dir, ['mv', from, to]);
}

function commitAll(dir, message) {
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['commit', '-q', '-m', message]);
  return gitIn(dir, ['rev-parse', 'HEAD']).trim();
}

function fixture(files) {
  const dir = mkRepo();
  write(dir, 'README.md', '# fixture\n');
  for (const [path, content] of Object.entries(files ?? {})) {
    write(dir, path, content);
  }
  return { dir, base: commitAll(dir, 'base') };
}

function guard(dir, base, head, options = {}) {
  const { headRef = 'fb/test', config = CONFIG, extraArgs = [], cwd = dir, unsetRef = false } = options;
  const env = { ...process.env };
  delete env.HEAD_REF;
  if (!unsetRef) {
    env.HEAD_REF = headRef;
  }
  const args = [CLI, '--repo', dir, '--base', base, '--head', head, '--config', config, ...extraArgs];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env, cwd });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function lines(stdout) {
  return stdout.split('\n').filter((line) => line !== '');
}

const UI_FILE = 'apps/web/src/components/ui/button.tsx';
const EXISTING_TEST = 'apps/web/src/utils/math.test.ts';
const PROTECTED_FILE = 'apps/web/src/lib/settlement/settle-slot.ts';

// ---------------------------------------------------------------- patterns

test('globToRegExp: "**" under a directory matches nested files only', () => {
  const regexp = globToRegExp('apps/web/src/app/api/**');
  assert.equal(regexp.test('apps/web/src/app/api/orgs/route.ts'), true);
  assert.equal(regexp.test('apps/web/src/app/api/x'), true);
  assert.equal(regexp.test('apps/web/src/app/apiary/x'), false);
});

test('globToRegExp: "**/name" matches at the root and in nested directories', () => {
  const regexp = globToRegExp('**/package.json');
  assert.equal(regexp.test('package.json'), true);
  assert.equal(regexp.test('apps/web/package.json'), true);
  assert.equal(regexp.test('apps/web/package.jsonx'), false);
});

test('globToRegExp: a trailing "*" stays within one file name segment', () => {
  const regexp = globToRegExp('apps/web/next.config.*');
  assert.equal(regexp.test('apps/web/next.config.ts'), true);
  assert.equal(regexp.test('apps/web/src/next.config.ts'), false);
});

test('globToRegExp: "*" never crosses a directory separator', () => {
  const regexp = globToRegExp('apps/*/package.json');
  assert.equal(regexp.test('apps/web/package.json'), true);
  assert.equal(regexp.test('apps/web/sub/package.json'), false);
});

test('globToRegExp: parentheses in a pattern are matched literally', () => {
  const regexp = globToRegExp('apps/web/src/app/(protected)/**');
  assert.equal(regexp.test('apps/web/src/app/(protected)/x/page.tsx'), true);
  assert.equal(regexp.test('apps/web/src/app/protected/x/page.tsx'), false);
});

test('globToRegExp: matching is case-insensitive', () => {
  const workerRegexp = globToRegExp('apps/worker/**');
  assert.equal(workerRegexp.test('Apps/Worker/x'), true);

  const scriptsRegexp = globToRegExp('scripts/**');
  assert.equal(scriptsRegexp.test('SCRIPTS/a.mjs'), true);

  const nextRegexp = globToRegExp('apps/web/next.config.*');
  assert.equal(nextRegexp.test('apps/web/Next.config.ts'), true);
});

test('globToRegExp: "?" matches exactly one non-separator character', () => {
  const regexp = globToRegExp('a/?.ts');
  assert.equal(regexp.test('a/b.ts'), true);
  assert.equal(regexp.test('a/.ts'), false);
  assert.equal(regexp.test('a/bc.ts'), false);
});

test('validatePattern rejects unsafe patterns', () => {
  const bad = [
    '',
    '/absolute/path',
    'apps/../database/**',
    'apps\\web\\**',
    'apps/web/n\u00e4me.ts',
    'x'.repeat(201),
  ];
  for (const pattern of bad) {
    assert.throws(() => validatePattern(pattern), Error, `expected rejection of ${JSON.stringify(pattern)}`);
  }
  assert.equal(validatePattern('apps/web/**'), 'apps/web/**');
});

test('loadProtectedPatterns rejects an invalid config', () => {
  const dir = track(mkdtempSync(join(tmpdir(), 'cpx-config-')));
  const cases = [
    ['{not json', 'valid JSON'],
    ['{"version":2,"protected":["a/**"],"fbForbiddenContent":[{"id":"a","pattern":"x"}]}', 'version'],
    ['{"version":1,"protected":[],"fbForbiddenContent":[{"id":"a","pattern":"x"}]}', 'at least one'],
    ['{"version":1,"protected":"a/**","fbForbiddenContent":[{"id":"a","pattern":"x"}]}', 'at least one'],
    ['{"version":1,"protected":["/abs/**"],"fbForbiddenContent":[{"id":"a","pattern":"x"}]}', 'absolute'],
    ['[]', 'object'],
    ['{"version":1,"protected":["a/**"]}', 'missing fbForbiddenContent'],
    ['{"version":1,"protected":["a/**"],"fbForbiddenContent":[]}', 'empty array'],
    ['{"version":1,"protected":["a/**"],"fbForbiddenContent":[{"id":"dup","pattern":"x"},{"id":"dup","pattern":"y"}]}', 'duplicate id'],
    ['{"version":1,"protected":["a/**"],"fbForbiddenContent":[{"id":"BAD_ID","pattern":"x"}]}', 'bad id'],
    ['{"version":1,"protected":["a/**"],"fbForbiddenContent":[{"id":"a","pattern":"[unclosed"}]}', 'pattern does not compile'],
    ['{"version":1,"protected":["a/**"],"fbForbiddenContent":[{"id":"a","pattern":"a*"}]}', 'pattern matches empty string'],
    ['{"version":1,"protected":["a/**"],"fbForbiddenContent":[{"id":"a","pattern":123}]}', 'non-string pattern'],
  ];
  let index = 0;
  for (const [body] of cases) {
    const path = join(dir, `config-${index}.json`);
    writeFileSync(path, body, 'utf8');
    assert.throws(() => loadProtectedPatterns(path), Error);
    index += 1;
  }
  assert.throws(() => loadProtectedPatterns(join(dir, 'missing.json')), Error);
});

test('loadProtectedPatterns: the shipped config protects the expected paths', () => {
  const { patterns, regexps } = loadProtectedPatterns(CONFIG);
  assert.ok(patterns.length >= 29);

  const protectedPaths = [
    '.github/workflows/ci.yml',
    'apps/web/src/app/api/orgs/route.ts',
    'apps/web/src/lib/settlement/settle-slot.ts',
    'packages/database/prisma/schema.prisma',
    'apps/web/.env.local',
    'pnpm-lock.yaml',
    'docs/adr/0007-x.md',
    'apps/web/package.json',
    'turbo.json',
    'scripts/lib/changes.mjs',
    'docs/engineering/agent-rules.md',
    'apps/web/tsconfig.json',
    'apps/web/src/lib/creator/format.ts',
    'apps/web/src/lib/campaigns/x.ts',
    'apps/web/src/test/setup.ts',
    '.gitleaks.toml',
    'apps/web/.gitignore',
    'docker-compose.test.yml',
    '.freebuff/project-id',
    'package-lock.json',
    'apps/web/server.pem',
  ];
  for (const path of protectedPaths) {
    assert.equal(matchesAny(path, regexps), true, `expected ${path} to be protected`);
  }

  const openPaths = [
    'apps/web/src/app/(protected)/creator/dashboard/page.tsx',
    'apps/web/src/components/ui/button.tsx',
    'docs/runbooks/worker.md',
    'README.md',
  ];
  for (const path of openPaths) {
    assert.equal(matchesAny(path, regexps), false, `expected ${path} to be open`);
  }
});

test('assertSafeRev rejects option injection and ambiguous revisions', () => {
  for (const rev of ['main', 'origin/main', 'HEAD~1', '0'.repeat(40)]) {
    assert.equal(assertSafeRev(rev, '--base'), rev);
  }
  for (const rev of ['--output=x', 'a..b', '', '-x', 'x'.repeat(201)]) {
    assert.throws(() => assertSafeRev(rev, '--base'), Error);
  }
});

// ------------------------------------------------------------------- guard

test('guard: fb/ branch with a UI-only change passes', () => {
  const { dir, base } = fixture({ [UI_FILE]: 'export const a = 1;\n' });
  write(dir, UI_FILE, 'export const a = 2;\n');
  const head = commitAll(dir, 'ui change');

  const result = guard(dir, base, head);
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(lines(result.stdout), ['[protected-paths] OK']);
});

test('guard: fb/ branch adding a new test file passes', () => {
  const { dir, base } = fixture({ [UI_FILE]: 'export const a = 1;\n' });
  write(dir, 'apps/web/src/utils/format.test.ts', 'export const t = 1;\n');
  const head = commitAll(dir, 'new test');

  const result = guard(dir, base, head);
  assert.equal(result.status, 0, result.stdout);
});

test('guard: fb/ branch modifying an existing test file fails', () => {
  const { dir, base } = fixture({ [EXISTING_TEST]: 'export const t = 1;\n' });
  write(dir, EXISTING_TEST, 'export const t = 2;\n');
  const head = commitAll(dir, 'edit test');

  const result = guard(dir, base, head);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /^\[protected-paths\] VIOLATION M apps\/web\/src\/utils\/math\.test\.ts$/m);
});

test('guard: fb/ branch deleting an existing test file fails', () => {
  const { dir, base } = fixture({ [EXISTING_TEST]: 'export const t = 1;\n' });
  remove(dir, EXISTING_TEST);
  const head = commitAll(dir, 'delete test');

  const result = guard(dir, base, head);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /VIOLATION D apps\/web\/src\/utils\/math\.test\.ts/);
});

test('guard: fb/ branch touching a protected file fails and lists it', () => {
  const { dir, base } = fixture({ [PROTECTED_FILE]: 'export const a = 1;\n' });
  write(dir, PROTECTED_FILE, 'export const a = 2;\n');
  const head = commitAll(dir, 'touch protected');

  const result = guard(dir, base, head);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, new RegExp(`VIOLATION M ${PROTECTED_FILE}`));
});

test('guard: fb/ branch deleting a protected file fails', () => {
  const { dir, base } = fixture({ [PROTECTED_FILE]: 'export const a = 1;\n' });
  remove(dir, PROTECTED_FILE);
  const head = commitAll(dir, 'delete protected');

  const result = guard(dir, base, head);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, new RegExp(`VIOLATION D ${PROTECTED_FILE}`));
});

test('guard: fb/ branch renaming a file into a protected path fails', () => {
  const { dir, base } = fixture({ [UI_FILE]: 'export const a = 1;\n' });
  renameInRepo(dir, UI_FILE, PROTECTED_FILE);
  const head = commitAll(dir, 'rename into protected');

  const result = guard(dir, base, head);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, new RegExp(`VIOLATION A ${PROTECTED_FILE}`));
});

test('guard: fb/ branch renaming a file out of a protected path fails', () => {
  const { dir, base } = fixture({ [PROTECTED_FILE]: 'export const a = 1;\n' });
  renameInRepo(dir, PROTECTED_FILE, 'apps/web/src/components/ui/settle-slot.tsx');
  const head = commitAll(dir, 'rename out of protected');

  const result = guard(dir, base, head);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, new RegExp(`VIOLATION D ${PROTECTED_FILE}`));
});

test('guard: cl/ branch touching protected paths exits 0 with a NOTICE count', () => {
  const { dir, base } = fixture({ [PROTECTED_FILE]: 'export const a = 1;\n' });
  write(dir, PROTECTED_FILE, 'export const a = 2;\n');
  write(dir, UI_FILE, 'export const b = 1;\n');
  const head = commitAll(dir, 'tier a work');

  const result = guard(dir, base, head, { headRef: 'cl/money-design' });
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(lines(result.stdout), [
    '[protected-paths] NOTICE branch cl/money-design is not fb/: 1 protected path(s) touched; Tier A or B review required',
  ]);
});

test('guard: chore/ branch exits 0 with a NOTICE', () => {
  const { dir, base } = fixture({ [UI_FILE]: 'export const a = 1;\n' });
  write(dir, UI_FILE, 'export const a = 3;\n');
  const head = commitAll(dir, 'chore');

  const result = guard(dir, base, head, { headRef: 'chore/phase0-guard' });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /NOTICE branch chore\/phase0-guard is not fb\/: 0 protected path\(s\) touched/);
});

test('guard: more than 50 violations are capped with a remainder line', () => {
  const dir = mkRepo();
  write(dir, 'README.md', '# fixture\n');
  const base = commitAll(dir, 'base');
  for (let index = 0; index < 60; index += 1) {
    write(dir, `apps/web/src/app/api/r${index}/route.ts`, 'export const r = 1;\n');
  }
  const head = commitAll(dir, 'many protected');

  const result = guard(dir, base, head);
  assert.equal(result.status, 1, result.stdout);
  const output = lines(result.stdout);
  const violationLines = output.filter((line) => line.startsWith('[protected-paths] VIOLATION '));
  assert.equal(violationLines.length, 50);
  assert.equal(output[output.length - 1], '[protected-paths] ... and 10 more');
});

test('guard: an invalid config fails closed', () => {
  const { dir, base } = fixture({ [UI_FILE]: 'export const a = 1;\n' });
  write(dir, UI_FILE, 'export const a = 4;\n');
  const head = commitAll(dir, 'change');

  const scratch = track(mkdtempSync(join(tmpdir(), 'cpx-config-')));
  const configPath = join(scratch, 'bad.json');
  writeFileSync(configPath, '{"version":1,"protected":["/abs/**"]}', 'utf8');

  const result = guard(dir, base, head, { config: configPath });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /^\[protected-paths\] ERROR: /);
});

test('guard: a missing config fails closed', () => {
  const { dir, base } = fixture({ [UI_FILE]: 'export const a = 1;\n' });
  write(dir, UI_FILE, 'export const a = 5;\n');
  const head = commitAll(dir, 'change');

  const scratch = track(mkdtempSync(join(tmpdir(), 'cpx-config-')));
  const result = guard(dir, base, head, { config: join(scratch, 'absent.json') });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /^\[protected-paths\] ERROR: /);
});

test('guard: HEAD_REF unset on a detached HEAD fails closed', () => {
  const { dir, base } = fixture({ [UI_FILE]: 'export const a = 1;\n' });
  write(dir, UI_FILE, 'export const a = 6;\n');
  const head = commitAll(dir, 'change');
  gitIn(dir, ['update-ref', '--no-deref', 'HEAD', head]);

  const result = guard(dir, base, head, { unsetRef: true });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /^\[protected-paths\] ERROR: /);
});

test('guard: HEAD_REF unset on a normal branch uses that branch name', () => {
  const { dir, base } = fixture({ [UI_FILE]: 'export const a = 1;\n' });
  write(dir, UI_FILE, 'export const a = 7;\n');
  const head = commitAll(dir, 'change');

  const result = guard(dir, base, head, { unsetRef: true });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /NOTICE branch main is not fb\//);
});

test('guard: a hostile HEAD_REF cannot inject workflow commands', () => {
  const { dir, base } = fixture({ [UI_FILE]: 'export const a = 1;\n' });
  write(dir, UI_FILE, 'export const a = 8;\n');
  const head = commitAll(dir, 'change');

  const hostileRefs = ['fb/x\n::error::pwned', 'fb/\u00fcn\u00efcode', 'fb/x\r::warning::pwned'];
  for (const headRef of hostileRefs) {
    const result = guard(dir, base, head, { headRef });
    for (const line of lines(result.stdout + result.stderr)) {
      assert.ok(line.startsWith('[protected-paths]'), `unexpected line ${JSON.stringify(line)}`);
      assert.match(line, /^[\x20-\x7e]+$/);
    }
  }
});

test('guard: a protected path with spaces and non-ASCII is still detected', () => {
  const { dir, base } = fixture({ [UI_FILE]: 'export const a = 1;\n' });
  write(dir, '.github/workflows/ci d\u00e9ploy.yml', 'name: ci\n');
  const head = commitAll(dir, 'odd protected name');

  const result = guard(dir, base, head);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /VIOLATION A \.github\/workflows\/ci d\?ploy\.yml/);
  assert.match(result.stdout, /^[\x20-\x7e\n]*$/);
});

test('guard: an unknown argument is rejected', () => {
  const { dir, base } = fixture({ [UI_FILE]: 'export const a = 1;\n' });
  write(dir, UI_FILE, 'export const a = 9;\n');
  const head = commitAll(dir, 'change');

  const result = guard(dir, base, head, { extraArgs: ['--bogus'] });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /^\[protected-paths\] ERROR: unknown argument/);
});

test('guard: a base revision that looks like an option is rejected', () => {
  const { dir } = fixture({ [UI_FILE]: 'export const a = 1;\n' });
  write(dir, UI_FILE, 'export const a = 10;\n');
  const head = commitAll(dir, 'change');

  const scratch = track(mkdtempSync(join(tmpdir(), 'cpx-scratch-')));
  const env = { ...process.env, HEAD_REF: 'fb/test' };
  const result = spawnSync(
    process.execPath,
    [CLI, '--repo', dir, '--base', '--output=pwn', '--head', head, '--config', CONFIG],
    { encoding: 'utf8', env, cwd: scratch },
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout ?? '', /^\[protected-paths\] ERROR: /);
  assert.equal(existsSync(join(scratch, 'pwn')), false);
  assert.equal(existsSync(join(dir, 'pwn')), false);
});

// ------------------------------------------------------------------ content & review-fixes

test('guard: branch "FB/x" is enforced', () => {
  const { dir, base } = fixture({ [PROTECTED_FILE]: 'export const a = 1;\n' });
  write(dir, PROTECTED_FILE, 'export const a = 2;\n');
  const head = commitAll(dir, 'touch protected on FB/ branch');

  const result = guard(dir, base, head, { headRef: 'FB/feature-x' });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /VIOLATION M/);
});

test('guard: fb/ branch adding database-client forbidden content fails without leaking line text', () => {
  const PAGE = 'apps/web/src/app/(protected)/creator/dashboard/page.tsx';
  const { dir, base } = fixture({ [PAGE]: 'export default function Page() { return null; }\n' });
  write(dir, PAGE, "import { prisma } from '@repo/database';\nexport default function Page() { return null; }\n");
  const head = commitAll(dir, 'add db import');

  const result = guard(dir, base, head, { headRef: 'fb/page-update' });
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /VIOLATION CONTENT database-client apps\/web\/src\/app\/\(protected\)\/creator\/dashboard\/page\.tsx:1/,
  );
  assert.equal(result.stdout.includes("from '@repo/database'"), false);
  assert.equal(result.stdout.includes('import { prisma }'), false);
});

test('guard: fb/ branch adding forbidden content rules fails with corresponding rule-id', () => {
  const PAGE = 'apps/web/src/app/(protected)/creator/dashboard/page.tsx';
  const forbiddenSnippets = [
    ['server-action', "'use server';\n"],
    ['env-access', 'const key = process.env.KEY;\n'],
    ['server-only-api', "import { headers } from 'next/headers';\n"],
    ['html-injection', '<div dangerouslySetInnerHTML={{ __html: "x" }} />\n'],
    ['raw-sql', 'await prisma.$queryRaw`SELECT 1`;\n'],
  ];

  for (const [ruleId, snippet] of forbiddenSnippets) {
    const { dir, base } = fixture({ [PAGE]: 'export default function Page() { return null; }\n' });
    write(dir, PAGE, snippet + 'export default function Page() { return null; }\n');
    const head = commitAll(dir, `add ${ruleId}`);

    const result = guard(dir, base, head, { headRef: 'fb/forbidden-test' });
    assert.equal(result.status, 1, `expected status 1 for ${ruleId}: ${result.stdout}`);
    assert.match(
      result.stdout,
      new RegExp(`VIOLATION CONTENT ${ruleId} apps/web/src/app/\\(protected\\)/creator/dashboard/page\\.tsx:1`),
    );
  }
});

test('guard: forbidden content in a .md file on an fb/ branch is ignored (exit 0)', () => {
  const DOC = 'docs/runbooks/worker.md';
  const { dir, base } = fixture({ [DOC]: '# Worker Runbook\n' });
  const forbiddenInDoc = [
    "from '@repo/database'",
    "'use server'",
    'process.env',
    'next/headers',
    'dangerouslySetInnerHTML',
    'prisma.$queryRaw',
  ].join('\n') + '\n';
  write(dir, DOC, forbiddenInDoc);
  const head = commitAll(dir, 'add doc with code samples');

  const result = guard(dir, base, head, { headRef: 'fb/doc-update' });
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(lines(result.stdout), ['[protected-paths] OK']);
});

test('guard: forbidden content on a cl/ branch exits 0 with NOTICE only', () => {
  const PAGE = 'apps/web/src/app/(protected)/creator/dashboard/page.tsx';
  const { dir, base } = fixture({ [PAGE]: 'export default function Page() { return null; }\n' });
  write(dir, PAGE, "import { prisma } from '@repo/database';\nexport default function Page() { return null; }\n");
  const head = commitAll(dir, 'tier a page work');

  const result = guard(dir, base, head, { headRef: 'cl/db-page' });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /NOTICE branch cl\/db-page is not fb\/: 0 protected path\(s\) touched/);
  assert.equal(result.stdout.includes('VIOLATION'), false);
});

test('guard: content hit in a file with spaces reports correct path with no trailing tab', () => {
  const FILE = 'apps/web/src/components/ui/my button.tsx';
  const { dir, base } = fixture({ [FILE]: 'export const b = 1;\n' });
  write(dir, FILE, 'export const b = 1;\nconst secret = process.env.SECRET;\n');
  const head = commitAll(dir, 'add env in path with spaces');

  const result = guard(dir, base, head, { headRef: 'fb/spaces-test' });
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /VIOLATION CONTENT env-access apps\/web\/src\/components\/ui\/my button\.tsx:2/,
  );
  assert.equal(result.stdout.includes('\t'), false);
});

test('guard: added line "++ b/apps/web/src/lib/x.ts" does not change attribution of later forbidden lines', () => {
  const FILE = 'apps/web/src/components/ui/button.tsx';
  const { dir, base } = fixture({ [FILE]: 'export const b = 1;\n' });
  write(
    dir,
    FILE,
    'export const b = 1;\n' +
      '// ++ b/apps/web/src/lib/x.ts\n' +
      'const secret = process.env.API_KEY;\n',
  );
  const head = commitAll(dir, 'trick header line');

  const result = guard(dir, base, head, { headRef: 'fb/header-trick' });
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /VIOLATION CONTENT env-access apps\/web\/src\/components\/ui\/button\.tsx:3/,
  );
  assert.equal(result.stdout.includes('apps/web/src/lib/x.ts'), false);
});

test(
  'guard: rename/new file with quotes or tabs causes VIOLATION UNPARSED and exit 1',
  { skip: process.platform === 'win32' },
  () => {
    const { dir, base } = fixture({ [UI_FILE]: 'export const a = 1;\n' });
    const trickyName = 'apps/web/src/components/ui/weird"file.tsx';
    write(dir, trickyName, 'export const w = 1;\n');
    const head = commitAll(dir, 'add quoted file');

    const result = guard(dir, base, head, { headRef: 'fb/quoted-file' });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /VIOLATION UNPARSED \d+ file\(s\) could not be checked/);
  },
);

test('guard: case-variant protected path ("Apps/worker/x.ts") on fb/ branch fails', () => {
  const { dir, base } = fixture({ [UI_FILE]: 'export const a = 1;\n' });
  write(dir, 'Apps/worker/x.ts', 'export const x = 1;\n');
  const head = commitAll(dir, 'add case variant protected');

  const result = guard(dir, base, head, { headRef: 'fb/case-variant' });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /VIOLATION A Apps\/worker\/x\.ts/i);
});

test('guard: fb/ branch modifying an existing .spec.ts file fails', () => {
  const SPEC_FILE = 'apps/web/src/utils/math.spec.ts';
  const { dir, base } = fixture({ [SPEC_FILE]: 'export const s = 1;\n' });
  write(dir, SPEC_FILE, 'export const s = 2;\n');
  const head = commitAll(dir, 'modify spec file');

  const result = guard(dir, base, head, { headRef: 'fb/edit-spec' });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /VIOLATION M apps\/web\/src\/utils\/math\.spec\.ts/);
});

// ------------------------------------------------------------- addedLines unit tests

test('addedLines: header with trailing tab parses correctly', () => {
  const { dir, base } = fixture({ 'file with spaces.txt': 'line 1\n' });
  write(dir, 'file with spaces.txt', 'line 1\nline 2\n');
  const head = commitAll(dir, 'append line');

  const { lines: diffLines, unparsedFiles } = addedLines(dir, base, head);
  assert.equal(unparsedFiles, 0);
  assert.equal(diffLines.length, 1);
  assert.equal(diffLines[0].path, 'file with spaces.txt');
  assert.equal(diffLines[0].line, 2);
  assert.equal(diffLines[0].text, 'line 2');
});

test('addedLines: hunk-count parsing with "-- comment" and "++ x" content lines', () => {
  const FILE = 'src/test.txt';
  const { dir, base } = fixture({ [FILE]: 'alpha\n-- comment\nomega\n' });
  write(dir, FILE, 'alpha\n++ x\nomega\n');
  const head = commitAll(dir, 'replace comment');

  const { lines: diffLines, unparsedFiles } = addedLines(dir, base, head);
  assert.equal(unparsedFiles, 0);
  assert.equal(diffLines.length, 1);
  assert.equal(diffLines[0].path, FILE);
  assert.equal(diffLines[0].line, 2);
  assert.equal(diffLines[0].text, '++ x');
});

test('addedLines: binary file is skipped without crashing', () => {
  const dir = mkRepo();
  write(dir, 'README.md', '# fixture\n');
  const base = commitAll(dir, 'base');
  const binPath = join(dir, 'image.png');
  writeFileSync(binPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  const head = commitAll(dir, 'add binary');

  const { lines: diffLines, unparsedFiles } = addedLines(dir, base, head);
  assert.equal(unparsedFiles, 0);
  assert.equal(diffLines.length, 0);
});

test('addedLines: multi-hunk line numbers are correct', () => {
  const FILE = 'src/multi.txt';
  const initial = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const { dir, base } = fixture({ [FILE]: initial });

  const modifiedLines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
  modifiedLines[2] = 'line 3 modified'; // line 3
  modifiedLines[44] = 'line 45 modified'; // line 45
  write(dir, FILE, modifiedLines.join('\n') + '\n');
  const head = commitAll(dir, 'modify line 3 and 45');

  const { lines: diffLines, unparsedFiles } = addedLines(dir, base, head);
  assert.equal(unparsedFiles, 0);
  assert.equal(diffLines.length, 2);
  assert.equal(diffLines[0].path, FILE);
  assert.equal(diffLines[0].line, 3);
  assert.equal(diffLines[0].text, 'line 3 modified');
  assert.equal(diffLines[1].path, FILE);
  assert.equal(diffLines[1].line, 45);
  assert.equal(diffLines[1].text, 'line 45 modified');
});

// ------------------------------------- diff prefix configs, diff parsing & legacy scans

test('guard: diff.noprefix and diff.mnemonicPrefix configs cannot hide added-line paths', () => {
  const PAGE = 'apps/web/src/app/(protected)/creator/dashboard/page.tsx';
  for (const key of ['diff.noprefix', 'diff.mnemonicPrefix']) {
    const { dir, base } = fixture({ [PAGE]: 'export default function Page() { return null; }\n' });
    gitIn(dir, ['config', key, 'true']);
    write(
      dir,
      PAGE,
      "import { prisma } from '@repo/database';\nexport default function Page() { return null; }\n",
    );
    const head = commitAll(dir, `db import with ${key}`);

    const result = guard(dir, base, head, { headRef: 'fb/prefix-config' });
    assert.equal(result.status, 1, `${key}: ${result.stdout}`);
    assert.match(
      result.stdout,
      /VIOLATION CONTENT database-client apps\/web\/src\/app\/\(protected\)\/creator\/dashboard\/page\.tsx:1/,
      key,
    );
  }
});

test('parseDiffText: an unrecognised "+++" target counts as unparsed', () => {
  const raw = ['diff --git a/x b/x', '--- a/x', '+++ weird', '@@ -1 +1 @@', '-old', '+new', ''].join('\n');
  const { lines: parsed, unparsedFiles } = parseDiffText(raw);
  assert.equal(unparsedFiles, 1);
  assert.equal(parsed.length, 0);
});

test('parseDiffText: a malformed hunk header counts as unparsed', () => {
  const raw = ['--- a/x', '+++ b/x', '@@ not-a-hunk @@', '-old', '+new', ''].join('\n');
  const { unparsedFiles } = parseDiffText(raw);
  assert.equal(unparsedFiles, 1);
});

test('guard: fb/ branch adding forbidden content in a .mdx file fails while .md stays ignored', () => {
  const MDX = 'docs/runbooks/widget.mdx';
  const MD = 'docs/runbooks/widget.md';
  const snippet = "import { prisma } from '@repo/database';\n";

  const mdx = fixture({ [MDX]: '# Widget\n' });
  write(mdx.dir, MDX, '# Widget\n' + snippet);
  const mdxHead = commitAll(mdx.dir, 'mdx db import');
  const mdxResult = guard(mdx.dir, mdx.base, mdxHead, { headRef: 'fb/mdx-doc' });
  assert.equal(mdxResult.status, 1, mdxResult.stdout);
  assert.match(mdxResult.stdout, /VIOLATION CONTENT database-client docs\/runbooks\/widget\.mdx:2/);

  const md = fixture({ [MD]: '# Widget\n' });
  write(md.dir, MD, '# Widget\n' + snippet);
  const mdHead = commitAll(md.dir, 'md db import');
  const mdResult = guard(md.dir, md.base, mdHead, { headRef: 'fb/md-doc' });
  assert.equal(mdResult.status, 0, mdResult.stdout);
  assert.deepEqual(lines(mdResult.stdout), ['[protected-paths] OK']);
});

test('guard: editing an existing legacy-sensitive file fails without printing line text', () => {
  const FILE = 'apps/web/src/components/ui/legacy-widget.tsx';
  const { dir, base } = fixture({
    [FILE]: "import { prisma } from '@repo/database';\nexport const a = 1;\n",
  });
  write(dir, FILE, "import { prisma } from '@repo/database';\nexport const a = 2;\n");
  const head = commitAll(dir, 'edit legacy file');

  const result = guard(dir, base, head, { headRef: 'fb/legacy-edit' });
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stdout,
    /^\[protected-paths\] VIOLATION LEGACY-SENSITIVE database-client apps\/web\/src\/components\/ui\/legacy-widget\.tsx$/m,
  );
  assert.equal(result.stdout.includes('@repo/database'), false);
  assert.equal(result.stdout.includes('prisma'), false);
});

test('guard: editing an existing file with no forbidden construct passes the legacy scan', () => {
  const FILE = 'apps/web/src/components/ui/plain-widget.tsx';
  const { dir, base } = fixture({ [FILE]: 'export const a = 1;\n' });
  write(dir, FILE, 'export const a = 2;\n');
  const head = commitAll(dir, 'edit plain file');

  const result = guard(dir, base, head, { headRef: 'fb/plain-edit' });
  assert.equal(result.status, 0, result.stdout);
  assert.equal(result.stdout.includes('LEGACY'), false);
});

test('guard: deleting an existing legacy-sensitive file fails', () => {
  const FILE = 'apps/web/src/components/ui/old-sql.ts';
  const { dir, base } = fixture({ [FILE]: 'export const q = prisma.$queryRaw`SELECT 1`;\n' });
  remove(dir, FILE);
  const head = commitAll(dir, 'delete legacy file');

  const result = guard(dir, base, head, { headRef: 'fb/legacy-delete' });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /VIOLATION LEGACY-SENSITIVE raw-sql apps\/web\/src\/components\/ui\/old-sql\.ts/);
});

test('guard: a new file with forbidden content yields one CONTENT violation and no LEGACY line', () => {
  const FILE = 'apps/web/src/components/ui/new-db.ts';
  const { dir, base } = fixture();
  write(dir, FILE, "import { prisma } from '@repo/database';\nexport const p = prisma;\n");
  const head = commitAll(dir, 'add new db file');

  const result = guard(dir, base, head, { headRef: 'fb/new-db' });
  assert.equal(result.status, 1, result.stdout);
  const violationLines = lines(result.stdout).filter((line) => line.includes('VIOLATION'));
  assert.equal(violationLines.length, 1, result.stdout);
  assert.equal(
    violationLines[0],
    '[protected-paths] VIOLATION CONTENT database-client apps/web/src/components/ui/new-db.ts:1',
  );
  assert.equal(result.stdout.includes('LEGACY'), false);
});

test('guard: editing an existing .md file that mentions process.env exits 0', () => {
  const FILE = 'docs/runbooks/env-notes.md';
  const { dir, base } = fixture({ [FILE]: '# Env\nprocess.env is server-only.\n' });
  write(dir, FILE, '# Env\nprocess.env.FOO is server-only.\n');
  const head = commitAll(dir, 'edit env notes');

  const result = guard(dir, base, head, { headRef: 'fb/env-notes' });
  assert.equal(result.status, 0, result.stdout);
  assert.deepEqual(lines(result.stdout), ['[protected-paths] OK']);
});

test('guard: a cl/ branch editing a legacy-sensitive file exits 0 with NOTICE', () => {
  const FILE = 'apps/web/src/components/ui/legacy-widget.tsx';
  const { dir, base } = fixture({
    [FILE]: "import { prisma } from '@repo/database';\nexport const a = 1;\n",
  });
  write(dir, FILE, "import { prisma } from '@repo/database';\nexport const a = 2;\n");
  const head = commitAll(dir, 'tier a legacy edit');

  const result = guard(dir, base, head, { headRef: 'cl/legacy-edit' });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /NOTICE branch cl\/legacy-edit is not fb\//);
  assert.equal(result.stdout.includes('LEGACY'), false);
});

test('guard: more than 1000 changed files fails with TOO-MANY-FILES and skips content scans', () => {
  const dir = mkRepo();
  write(dir, 'README.md', '# fixture\n');
  const base = commitAll(dir, 'base');
  for (let index = 0; index < 1001; index += 1) {
    write(dir, `apps/web/src/components/ui/bulk-${index}.tsx`, 'export const b = 1;\n');
  }
  const head = commitAll(dir, 'bulk add');

  const result = guard(dir, base, head);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /^\[protected-paths\] VIOLATION TOO-MANY-FILES 1001$/m);
  assert.equal(lines(result.stdout).some((line) => line.includes('VIOLATION CONTENT')), false);
});
