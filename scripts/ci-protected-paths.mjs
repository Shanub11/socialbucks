#!/usr/bin/env node
// Protected-paths guard for Phase 0.
// A branch starting with fb/ (Tier C, case-insensitive) must not touch a
// protected path, must not modify or delete an existing test file, and must not
// add forbidden content (database client, Clerk server auth, server actions,
// server headers/requests, process.env, dangerouslySetInnerHTML, eval/Function,
// child_process, or raw SQL), and must not edit or delete a file whose base
// version already contains forbidden content (that file is Tier B). Every
// other branch name is only reported, because Tier A and Tier B work may touch
// protected paths after review.
// Every output line starts with "[protected-paths] ".
//
// Usage:
//   node scripts/ci-protected-paths.mjs --base <rev> --head <rev>
//     [--repo <dir>] [--config <path>]

import {
  addedLines,
  assertSafeRev,
  git,
  listChanges,
  loadProtectedPatterns,
  matchesAny,
  mergeBase,
  readFileAtRev,
  sanitize,
  TEST_FILE_PATTERN,
} from './lib/changes.mjs';

const PREFIX = '[protected-paths] ';
const MAX_VIOLATIONS = 50;
const BRANCH_CHAR = /^[A-Za-z0-9._/-]$/;
const SKIPPED_CONTENT_EXTENSIONS = /\.(?:md|txt)$/i;
const MAX_CHANGED_FILES = 1000;
const KNOWN_FLAGS = {
  '--repo': 'repo',
  '--base': 'base',
  '--head': 'head',
  '--config': 'config',
};

function out(line) {
  process.stdout.write(`${PREFIX}${line}\n`);
}

function fail(message) {
  process.stdout.write(`${PREFIX}ERROR: ${sanitize(message, 200)}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = {
    repo: '.',
    base: null,
    head: null,
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

function sanitizeBranch(name) {
  let output = '';
  for (const char of name) {
    output += BRANCH_CHAR.test(char) ? char : '?';
  }
  return output.slice(0, 100);
}

function resolveBranch(repo) {
  const fromEnv = process.env.HEAD_REF;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return fromEnv.trim();
  }

  let name;
  try {
    name = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch {
    return null;
  }
  if (name === '' || name === 'HEAD') {
    return null;
  }
  return name;
}

function classify({ repo, config, base, head, enforced }) {
  const resolved = loadProtectedPatterns(config);
  const changes = listChanges(repo, base, head);

  const violations = [];
  let protectedCount = 0;

  for (const change of changes) {
    const isProtected = matchesAny(change.path, resolved.regexps);
    if (isProtected) {
      protectedCount += 1;
    }
    if (!enforced) {
      continue;
    }
    if (isProtected) {
      violations.push(`VIOLATION ${sanitize(change.status, 4)} ${sanitize(change.path, 300)}`);
      continue;
    }
    if (change.status !== 'A' && TEST_FILE_PATTERN.test(change.path)) {
      violations.push(`VIOLATION ${sanitize(change.status, 4)} ${sanitize(change.path, 300)}`);
    }
  }

  if (enforced) {
    if (changes.length > MAX_CHANGED_FILES) {
      violations.push(`VIOLATION TOO-MANY-FILES ${changes.length}`);
      return { violations, protectedCount };
    }

    const mb = mergeBase(repo, base, head);

    const { lines, unparsedFiles } = addedLines(repo, base, head);
    for (const item of lines) {
      if (!item.path || SKIPPED_CONTENT_EXTENSIONS.test(item.path)) {
        continue;
      }
      for (const rule of resolved.forbidden) {
        if (rule.regexp.test(item.text)) {
          violations.push(
            `VIOLATION CONTENT ${sanitize(rule.id, 40)} ${sanitize(item.path, 300)}:${item.line}`,
          );
        }
      }
    }
    if (unparsedFiles > 0) {
      violations.push(`VIOLATION UNPARSED ${unparsedFiles} file(s) could not be checked`);
    }

    for (const change of changes) {
      if (change.status !== 'M' && change.status !== 'D' && change.status !== 'T') {
        continue;
      }
      if (SKIPPED_CONTENT_EXTENSIONS.test(change.path)) {
        continue;
      }
      const baseText = readFileAtRev(repo, mb, change.path);
      if (baseText === null) {
        violations.push(`VIOLATION LEGACY-UNREADABLE ${sanitize(change.path, 300)}`);
        continue;
      }
      const baseLines = baseText.split(/\r?\n/);
      let matchedRule = null;
      for (const rule of resolved.forbidden) {
        if (baseLines.some((line) => rule.regexp.test(line))) {
          matchedRule = rule.id;
          break;
        }
      }
      if (matchedRule !== null) {
        violations.push(
          `VIOLATION LEGACY-SENSITIVE ${sanitize(matchedRule, 40)} ${sanitize(change.path, 300)}`,
        );
      }
    }
  }

  return { violations, protectedCount };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    fail(parsed.error);
  }

  const { options } = parsed;
  if (!options.base || !options.head) {
    fail('--base and --head are required');
  }

  const branch = resolveBranch(options.repo);
  if (branch === null) {
    fail('branch name could not be determined');
  }
  const enforced = branch.toLowerCase().startsWith('fb/');

  let result;
  try {
    result = classify({
      repo: options.repo,
      config: options.config,
      base: assertSafeRev(options.base, '--base'),
      head: assertSafeRev(options.head, '--head'),
      enforced,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : 'guard could not run');
  }

  if (!enforced) {
    out(
      `NOTICE branch ${sanitizeBranch(branch)} is not fb/: ` +
        `${result.protectedCount} protected path(s) touched; Tier A or B review required`,
    );
    process.exit(0);
  }

  if (result.violations.length === 0) {
    out('OK');
    process.exit(0);
  }

  const shown = result.violations.slice(0, MAX_VIOLATIONS);
  for (const violation of shown) {
    out(violation);
  }
  if (result.violations.length > shown.length) {
    out(`... and ${result.violations.length - shown.length} more`);
  }
  process.exit(1);
}

main();
