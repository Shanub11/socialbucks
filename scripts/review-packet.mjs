#!/usr/bin/env node
// Generates a compact review packet for Tier A and Tier B PRs.
// Read-only; always exits 0 on success; exits 1 with "[review-packet] ERROR: <msg>"
// on argument, config or git errors.
//
// Usage:
//   node scripts/review-packet.mjs [--repo .] [--base origin/main] [--head HEAD]
//     [--config scripts/protected-paths.json]

import {
  addedLines,
  assertSafeRev,
  git,
  listChanges,
  loadProtectedPatterns,
  matchesAny,
  mergeBase,
  sanitize,
  TEST_FILE_PATTERN,
} from './lib/changes.mjs';

const LIST_CAP = 40;
const DOC_FILE_PATTERN = /\.(?:md|mdx|txt)$/i;
const LOCKFILE_NAMES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']);
const KNOWN_FLAGS = {
  '--repo': 'repo',
  '--base': 'base',
  '--head': 'head',
  '--config': 'config',
};

const PROCESS_ENV_ALLOWLIST = new Set([
  'apps/web/src/lib/env.ts',
  'apps/web/src/lib/env-parts.ts',
  'apps/worker/src/config.ts',
  'apps/worker/src/logger.ts',
  'apps/worker/src/main.ts',
  'apps/worker/src/test-support/reset-test-db.ts',
  'packages/database/src/index.ts',
  'packages/database/prisma.config.ts',
  'apps/web/scripts/resolve-dispute.ts',
  'apps/web/verify-youtube-shorts.ts',
]);

const SECRET_RULES = [
  { id: 'google-api-key', regexp: /AIza[0-9A-Za-z_-]{20,}/ },
  { id: 'google-oauth-secret', regexp: /GOCSPX-[A-Za-z0-9_-]{10,}/ },
  { id: 'google-access-token', regexp: /ya29\.[A-Za-z0-9_-]*/ },
  { id: 'stripe-style-key', regexp: /sk_(?:live|test)_[A-Za-z0-9]+/ },
  { id: 'webhook-secret', regexp: /whsec_[A-Za-z0-9]+/ },
  { id: 'razorpay-key', regexp: /rzp_(?:live|test)_[A-Za-z0-9]{6,}/ },
  { id: 'private-key', regexp: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'credentials-url', regexp: /:\/\/[^:\s/@]+:[^@\s/]+@(?!(?:localhost|127\.0\.0\.1)(?:[:/]|$))/ },
  { id: 'jwt-token', regexp: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./ },
  { id: 'generic-secret', regexp: /(?:secret|token|password|apikey|api_key)\s*[:=]\s*["'][^"'\s]{12,}["']/i },
];

function fail(message) {
  process.stdout.write(`[review-packet] ERROR: ${sanitize(message, 200)}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    repo: '.',
    base: 'origin/main',
    head: 'HEAD',
    config: 'scripts/protected-paths.json',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = Object.prototype.hasOwnProperty.call(KNOWN_FLAGS, flag) ? KNOWN_FLAGS[flag] : null;
    if (key === null) {
      return { error: `unknown argument ${flag}` };
    }
    const value = argv[index + 1];
    if (value === undefined) {
      return { error: `${flag} requires a value` };
    }
    options[key] = value;
    index += 1;
  }

  return { options };
}

function isAllowedProcessEnvReader(path) {
  if (path.startsWith('scripts/')) return true;
  if (PROCESS_ENV_ALLOWLIST.has(path)) return true;
  const base = path.split('/').pop() ?? '';
  if (/^vitest\.config\.[cm]?[jt]s$/.test(base)) return true;
  if (/^vitest\.global-setup\.[cm]?[jt]s$/.test(base)) return true;
  if (/^next\.config\.(?:mjs|ts|js)$/.test(base)) return true;
  if (/^prisma\.config\.[cm]?[jt]s$/.test(base)) return true;
  return false;
}

function formatList(items, cap = LIST_CAP) {
  if (items.length <= cap) {
    return items;
  }
  const shown = items.slice(0, cap);
  shown.push(`... and ${items.length - cap} more`);
  return shown;
}

function getHeader(repo, base, head, mb) {
  let branchName = process.env.HEAD_REF?.trim();
  if (!branchName) {
    try {
      branchName = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    } catch {
      branchName = 'unknown';
    }
  }
  if (!branchName || branchName === 'HEAD') {
    branchName = 'HEAD';
  }

  let sanitizedBranch = '';
  for (const char of branchName) {
    sanitizedBranch += /^[A-Za-z0-9._/-]$/.test(char) ? char : '?';
  }
  sanitizedBranch = sanitizedBranch.slice(0, 100);

  const headSha = sanitize(git(repo, ['rev-parse', head]).trim().slice(0, 12), 300);
  const mbSha = sanitize(mb.slice(0, 12), 300);
  const commitCount = sanitize(git(repo, ['rev-list', '--count', `${mb}..${head}`, '--']).trim(), 300);

  const rawSubjects = git(repo, ['log', '--format=%s', '-n', '30', `${mb}..${head}`, '--']).trim();
  const subjects = rawSubjects ? rawSubjects.split('\n').filter((s) => s.length > 0) : [];

  const lines = [
    `branch: ${sanitize(sanitizedBranch, 300)}`,
    `head: ${headSha}`,
    `base: ${sanitize(base, 300)}`,
    `merge-base: ${mbSha}`,
    `commits: ${commitCount}`,
  ];
  for (const s of subjects) {
    lines.push(`  ${sanitize(s, 300)}`);
  }
  return lines;
}

function getSummary(repo, base, head, changes) {
  const changed = changes.length;
  let added = 0;
  let modified = 0;
  let deleted = 0;

  for (const c of changes) {
    if (c.status === 'A') added += 1;
    else if (c.status === 'M') modified += 1;
    else if (c.status === 'D') deleted += 1;
  }

  let shortstat = '';
  try {
    shortstat = git(repo, ['diff', '--shortstat', `${base}...${head}`, '--']).trim();
  } catch {
    shortstat = '';
  }

  let insertions = 0;
  let deletions = 0;
  const insMatch = /(\d+)\s+insertion/.exec(shortstat);
  if (insMatch) insertions = Number(insMatch[1]);
  const delMatch = /(\d+)\s+deletion/.exec(shortstat);
  if (delMatch) deletions = Number(delMatch[1]);

  return [
    `files changed: ${changed}`,
    `files added: ${added}`,
    `files modified: ${modified}`,
    `files deleted: ${deleted}`,
    `insertions: ${insertions}`,
    `deletions: ${deletions}`,
  ];
}

function readPkgDeps(raw) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return null;
  }
  const deps = {};
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  for (const sec of sections) {
    if (json[sec] && typeof json[sec] === 'object' && !Array.isArray(json[sec])) {
      for (const [k, v] of Object.entries(json[sec])) {
        if (typeof v === 'string') {
          deps[k] = v;
        }
      }
    }
  }
  return deps;
}

// Reads one side of a package.json. A missing file at that revision is
// reported as "absent" (the side is treated as empty); a file that exists but
// does not parse is reported as "invalid" so the two cases stay distinct.
function readPkgSide(repo, rev, path) {
  let raw;
  try {
    raw = git(repo, ['show', `${rev}:${path}`]);
  } catch {
    return { state: 'absent', deps: {} };
  }
  const deps = readPkgDeps(raw);
  if (deps === null) {
    return { state: 'invalid', deps: {} };
  }
  return { state: 'present', deps };
}

function getDependencies(repo, mb, head, changes) {
  const pkgChanges = changes.filter((c) => c.path === 'package.json' || c.path.endsWith('/package.json'));
  const rawLines = [];
  let depChangesCount = 0;

  for (const c of pkgChanges) {
    rawLines.push(`${sanitize(c.path, 300)}:`);

    const baseSide = readPkgSide(repo, mb, c.path);
    const headSide = readPkgSide(repo, head, c.path);

    if (baseSide.state === 'invalid' || headSide.state === 'invalid') {
      if (baseSide.state === 'invalid') rawLines.push('  unreadable (base)');
      if (headSide.state === 'invalid') rawLines.push('  unreadable (head)');
      continue;
    }

    const baseDeps = baseSide.deps;
    const headDeps = headSide.deps;

    const allKeys = new Set([
      ...Object.keys(baseDeps),
      ...Object.keys(headDeps),
    ]);

    const sortedKeys = Array.from(allKeys).sort();
    for (const name of sortedKeys) {
      const inBase = Object.prototype.hasOwnProperty.call(baseDeps, name);
      const inHead = Object.prototype.hasOwnProperty.call(headDeps, name);

      if (!inBase && inHead) {
        rawLines.push(`  + ${sanitize(name, 200)} ${sanitize(headDeps[name], 200)}`);
        depChangesCount += 1;
      } else if (inBase && !inHead) {
        rawLines.push(`  - ${sanitize(name, 200)} ${sanitize(baseDeps[name], 200)}`);
        depChangesCount += 1;
      } else if (inBase && inHead && baseDeps[name] !== headDeps[name]) {
        rawLines.push(
          `  ~ ${sanitize(name, 200)} ${sanitize(baseDeps[name], 200)} -> ${sanitize(headDeps[name], 200)}`,
        );
        depChangesCount += 1;
      }
    }
  }

  const changedLockfiles = changes.filter((c) => LOCKFILE_NAMES.has(c.path.split('/').pop() ?? ''));
  for (const lockfile of changedLockfiles) {
    rawLines.push(`${sanitize(lockfile.path, 300)} changed`);
  }
  if (changedLockfiles.length > 0 && pkgChanges.length === 0) {
    rawLines.push('WARNING: lockfile changed without package.json change');
  }

  return { lines: formatList(rawLines), depChangesCount };
}

function getFindings(repo, base, head, changes) {
  const { lines: added, unparsedFiles } = addedLines(repo, base, head);
  const findings = [];
  let highCount = 0;
  let noteCount = 0;

  const addedStatusByPath = new Map();
  for (const c of changes) {
    addedStatusByPath.set(c.path, c.status);
    if (c.status === 'A') {
      const name = c.path.split('/').pop() ?? '';
      const isTemplate = /\.(?:example|sample|template)$/i.test(name);
      if (!isTemplate && /(?:^|\/)\.env(?:[./].*)?$|\.(?:pem|key)$/i.test(c.path)) {
        findings.push(`HIGH secret-file ${sanitize(c.path, 300)}:1 new secret file`);
        highCount += 1;
      }
    }
    if (c.path.startsWith('.github/') || c.path.startsWith('scripts/')) {
      findings.push(`NOTE tooling-change ${sanitize(c.path, 300)}:1 ${sanitize(c.path, 300)}`);
      noteCount += 1;
    }
  }

  for (const item of added) {
    const isTest = TEST_FILE_PATTERN.test(item.path);
    const isDoc = DOC_FILE_PATTERN.test(item.path);
    const isSource = /\.[cm]?[jt]sx?$/.test(item.path);
    const isAppsOrPackages = /^(?:apps|packages)\//.test(item.path);
    const fileStatus = addedStatusByPath.get(item.path) ?? 'M';

    // Secret-like rules (HIGH, never echo the line)
    let secretMatched = false;
    for (const rule of SECRET_RULES) {
      if (rule.regexp.test(item.text)) {
        findings.push(`HIGH ${rule.id} ${sanitize(item.path, 300)}:${item.line}`);
        highCount += 1;
        secretMatched = true;
        break;
      }
    }

    // Documentation is prose: only secrets and (on new files) non-ASCII apply.
    if (isDoc) {
      if (fileStatus === 'A' && /[^\x00-\x7F]/.test(item.text)) {
        findings.push(`HIGH non-ascii ${sanitize(item.path, 300)}:${item.line} ${sanitize(item.text.trim(), 100)}`);
        highCount += 1;
      }
      continue;
    }

    if (secretMatched) {
      continue;
    }

    // High rules
    if (/\bdangerouslySetInnerHTML\b/.test(item.text)) {
      findings.push(`HIGH dangerouslySetInnerHTML ${sanitize(item.path, 300)}:${item.line} ${sanitize(item.text.trim(), 100)}`);
      highCount += 1;
    }
    if (/\beval\s*\(/.test(item.text)) {
      findings.push(`HIGH eval ${sanitize(item.path, 300)}:${item.line} ${sanitize(item.text.trim(), 100)}`);
      highCount += 1;
    }
    if (/new\s+Function\s*\(/.test(item.text)) {
      findings.push(`HIGH new-Function ${sanitize(item.path, 300)}:${item.line} ${sanitize(item.text.trim(), 100)}`);
      highCount += 1;
    }
    if (/@ts-(?:ignore|nocheck)\b/.test(item.text)) {
      findings.push(`HIGH ts-ignore ${sanitize(item.path, 300)}:${item.line} ${sanitize(item.text.trim(), 100)}`);
      highCount += 1;
    }
    if (/\beslint-disable\b/.test(item.text)) {
      findings.push(`HIGH eslint-disable ${sanitize(item.path, 300)}:${item.line} ${sanitize(item.text.trim(), 100)}`);
      highCount += 1;
    }
    if (!isTest && isSource && /\b(?:as\s+any|:\s*any)\b/.test(item.text)) {
      findings.push(`HIGH any-type ${sanitize(item.path, 300)}:${item.line} ${sanitize(item.text.trim(), 100)}`);
      highCount += 1;
    }
    if (!isTest && isAppsOrPackages && /\bconsole\.log\b/.test(item.text)) {
      findings.push(`HIGH console-log ${sanitize(item.path, 300)}:${item.line} ${sanitize(item.text.trim(), 100)}`);
      highCount += 1;
    }
    if (isTest && /(?:\.only\(|\bfit\(|\bfdescribe\()/.test(item.text)) {
      findings.push(`HIGH focused-test ${sanitize(item.path, 300)}:${item.line} ${sanitize(item.text.trim(), 100)}`);
      highCount += 1;
    }
    if (fileStatus === 'A' && /[^\x00-\x7F]/.test(item.text)) {
      findings.push(`HIGH non-ascii ${sanitize(item.path, 300)}:${item.line} ${sanitize(item.text.trim(), 100)}`);
      highCount += 1;
    }
    if (!isTest && isSource && /\bprocess\.env\b/.test(item.text)) {
      if (!isAllowedProcessEnvReader(item.path)) {
        findings.push(`HIGH env-access ${sanitize(item.path, 300)}:${item.line} ${sanitize(item.text.trim(), 100)}`);
        highCount += 1;
      }
    }

    // Note rules
    if (/\b(?:TODO|FIXME|XXX|HACK)\b/.test(item.text)) {
      findings.push(`NOTE marker ${sanitize(item.path, 300)}:${item.line} ${sanitize(item.text.trim(), 100)}`);
      noteCount += 1;
    }
    if (isTest && /(?:\.skip\(|\.todo\()/.test(item.text)) {
      findings.push(`NOTE skipped-test ${sanitize(item.path, 300)}:${item.line} ${sanitize(item.text.trim(), 100)}`);
      noteCount += 1;
    }
  }

  return { findings: formatList(findings), highCount, noteCount, unparsedFiles };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    fail(parsed.error);
  }

  const { options } = parsed;
  let baseRev;
  let headRev;
  try {
    baseRev = assertSafeRev(options.base, '--base');
    headRev = assertSafeRev(options.head, '--head');
  } catch (err) {
    fail(err instanceof Error ? err.message : 'invalid revision');
  }

  let mb;
  try {
    mb = mergeBase(options.repo, baseRev, headRev);
  } catch (err) {
    fail(err instanceof Error ? err.message : 'merge-base failed');
  }

  let protectedConfig;
  try {
    protectedConfig = loadProtectedPatterns(options.config);
  } catch (err) {
    fail(err instanceof Error ? err.message : 'config error');
  }

  let changes;
  try {
    changes = listChanges(options.repo, baseRev, headRev);
  } catch (err) {
    fail(err instanceof Error ? err.message : 'list changes failed');
  }

  const headerLines = getHeader(options.repo, baseRev, headRev, mb);
  const summaryLines = getSummary(options.repo, baseRev, headRev, changes);

  const protectedPaths = [];
  const otherPaths = [];
  const existingTests = [];
  const newMigrations = [];
  const newTests = [];
  let otherNewCount = 0;

  for (const c of changes) {
    const isProt = matchesAny(c.path, protectedConfig.regexps);
    const line = `${sanitize(c.status, 4)} ${sanitize(c.path, 300)}`;
    if (isProt) {
      protectedPaths.push(line);
    } else {
      otherPaths.push(line);
    }

    if (c.status !== 'A' && TEST_FILE_PATTERN.test(c.path)) {
      existingTests.push(line);
    }

    if (c.status === 'A') {
      if (c.path.startsWith('packages/database/prisma/migrations/')) {
        newMigrations.push(sanitize(c.path, 300));
      } else if (TEST_FILE_PATTERN.test(c.path)) {
        newTests.push(sanitize(c.path, 300));
      } else {
        otherNewCount += 1;
      }
    }
  }

  const { lines: depLines, depChangesCount } = getDependencies(options.repo, mb, headRev, changes);
  const { findings, highCount, noteCount, unparsedFiles } = getFindings(
    options.repo,
    baseRev,
    headRev,
    changes,
  );

  const sections = [];

  sections.push('== HEADER ==');
  for (const l of headerLines) sections.push(l);

  sections.push('== SUMMARY ==');
  for (const l of summaryLines) sections.push(l);

  sections.push('== PROTECTED PATHS TOUCHED ==');
  for (const l of formatList(protectedPaths)) sections.push(l);

  sections.push('== OTHER FILES ==');
  for (const l of formatList(otherPaths)) sections.push(l);

  sections.push('== EXISTING TESTS MODIFIED OR DELETED ==');
  for (const l of formatList(existingTests)) sections.push(l);

  sections.push('== NEW FILES ==');
  sections.push(`migrations (${newMigrations.length}):`);
  for (const l of formatList(newMigrations)) sections.push(`  ${l}`);
  sections.push(`tests (${newTests.length}):`);
  for (const l of formatList(newTests)) sections.push(`  ${l}`);
  sections.push(`other: ${otherNewCount}`);

  sections.push('== DEPENDENCIES ==');
  for (const l of depLines) sections.push(l);

  sections.push('== FINDINGS ==');
  for (const l of findings) sections.push(l);

  sections.push('== TOTALS ==');
  sections.push(
    `TOTALS protected=${protectedPaths.length} existing_tests_changed=${existingTests.length} high=${highCount} note=${noteCount} dep_changes=${depChangesCount} unparsed_files=${unparsedFiles}`,
  );

  sections.push('== NEXT ==');
  sections.push('paste this packet to Claude;');
  sections.push('and for every file under PROTECTED PATHS TOUCHED also paste `git diff <base>...<head> -- <file>`.');

  process.stdout.write(sections.join('\n') + '\n');
  process.exit(0);
}

main();
