// Shared helpers for the Phase 0 working-agreement scripts.
// Node 22 built-ins only. Every git call goes through the single git() helper
// below, which passes an argument array and never a shell string.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MAX_PATTERN_LENGTH = 200;
const MAX_SANITIZE_LENGTH = 200;
const MAX_BUFFER = 256 * 1024 * 1024;
const SAFE_REV = /^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,199}$/;
const REGEX_SPECIAL = '\\^$.*+?()[]{}|';
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const FORBIDDEN_ID = /^[a-z0-9-]{1,40}$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export const TEST_FILE_PATTERN = /(^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\//;

function escapeLiteral(char) {
  return REGEX_SPECIAL.includes(char) ? `\\${char}` : char;
}

// Converts a protected-path glob into an anchored, case-insensitive RegExp.
// Rules: a "**" that is a whole path segment matches any number of directories
// ("a/**" matches everything under a/ but not "a" itself; "**/x" matches "x"
// and "d/e/x"). "*" matches any run of characters within one segment and never
// crosses "/". "?" matches exactly one non-"/" character. Every other
// regex-special character is escaped literally. Character classes are not
// supported.
export function globToRegExp(glob) {
  if (typeof glob !== 'string' || glob.length === 0) {
    throw new Error('glob must be a non-empty string');
  }

  let source = '';
  let index = 0;

  while (index < glob.length) {
    const char = glob[index];

    if (char === '*') {
      const atSegmentStart = index === 0 || glob[index - 1] === '/';
      if (glob[index + 1] === '*') {
        const afterDoubles = index + 2;
        const atSegmentEnd = afterDoubles === glob.length || glob[afterDoubles] === '/';
        if (atSegmentStart && atSegmentEnd) {
          if (afterDoubles === glob.length) {
            source += index === 0 ? '.*' : '.+';
            index = afterDoubles;
            continue;
          }
          source += '(?:[^/]+/)*';
          index = afterDoubles + 1;
          continue;
        }
      }
      source += '[^/]*';
      index += 1;
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }

    source += escapeLiteral(char);
    index += 1;
  }

  return new RegExp(`^${source}$`, 'i');
}

// Throws a short, safe Error for any pattern the guard cannot trust.
export function validatePattern(pattern) {
  if (typeof pattern !== 'string') {
    throw new Error('protected pattern must be a string');
  }
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error('protected pattern has an invalid length');
  }
  if (!PRINTABLE_ASCII.test(pattern)) {
    throw new Error('protected pattern must be printable ASCII');
  }
  if (pattern.startsWith('/')) {
    throw new Error('protected pattern must not be absolute');
  }
  if (pattern.includes('\\')) {
    throw new Error('protected pattern must not contain a backslash');
  }
  if (pattern.split('/').includes('..')) {
    throw new Error('protected pattern must not contain a ".." segment');
  }
  return pattern;
}

// Reads the protected-paths config. Any problem throws a safe Error, so the
// guard fails closed instead of silently protecting nothing.
export function loadProtectedPatterns(configPath) {
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    throw new Error('protected paths config could not be read');
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error('protected paths config is not valid JSON');
  }

  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('protected paths config must be an object');
  }
  if (config.version !== 1) {
    throw new Error('protected paths config must declare version 1');
  }
  if (!Array.isArray(config.protected) || config.protected.length === 0) {
    throw new Error('protected paths config must list at least one pattern');
  }

  const patterns = [];
  const regexps = [];
  for (const pattern of config.protected) {
    try {
      patterns.push(validatePattern(pattern));
      regexps.push(globToRegExp(pattern));
    } catch {
      throw new Error('protected paths config contains an invalid pattern');
    }
  }

  if (!Array.isArray(config.fbForbiddenContent) || config.fbForbiddenContent.length === 0) {
    throw new Error('protected paths config must list at least one forbidden content rule');
  }

  const forbidden = [];
  const seenIds = new Set();

  for (const rule of config.fbForbiddenContent) {
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error('forbidden content rule must be an object');
    }

    const { id, pattern } = rule;

    if (typeof id !== 'string' || !FORBIDDEN_ID.test(id)) {
      throw new Error('forbidden content rule id is invalid');
    }
    if (seenIds.has(id)) {
      throw new Error('forbidden content rule id is not unique');
    }
    seenIds.add(id);

    if (typeof pattern !== 'string') {
      throw new Error('forbidden content rule pattern must be a string');
    }
    if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) {
      throw new Error('forbidden content rule pattern has an invalid length');
    }
    if (!PRINTABLE_ASCII.test(pattern)) {
      throw new Error('forbidden content rule pattern must be printable ASCII');
    }

    let compiled;
    try {
      compiled = new RegExp(pattern);
    } catch {
      throw new Error('forbidden content rule pattern is not a valid regular expression');
    }
    if (compiled.test('')) {
      throw new Error('forbidden content rule pattern must not match the empty string');
    }

    forbidden.push({ id, regexp: compiled });
  }

  return { patterns, regexps, forbidden };
}

export function matchesAny(path, regexps) {
  if (typeof path !== 'string' || !Array.isArray(regexps)) {
    return false;
  }
  return regexps.some((regexp) => regexp.test(path));
}

// Blocks option injection (for example "--output=x") in any revision we pass
// to git, and any revision that could ascend outside the repository.
export function assertSafeRev(rev, label) {
  const name = typeof label === 'string' && label.length > 0 ? label : 'revision';
  if (typeof rev !== 'string' || !SAFE_REV.test(rev) || rev.includes('..')) {
    throw new Error(`${name} is not a safe git revision`);
  }
  return rev;
}

// The single git helper. Arguments are always an array, the working directory
// is explicit, and stderr never reaches the caller's error message.
export function git(repo, args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error('git arguments must be a non-empty array');
  }
  const childEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) {
      childEnv[key] = value;
    }
  }
  childEnv.GIT_TERMINAL_PROMPT = '0';

  try {
    return execFileSync(
      'git',
      ['-C', repo, '-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', ...args],
      {
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv,
      },
    );
  } catch {
    throw new Error(`git ${sanitize(String(args[0]), 40)} failed`);
  }
}

export function mergeBase(repo, base, head) {
  const output = git(repo, ['merge-base', base, head]).trim();
  if (!/^[0-9a-f]{40}$/.test(output)) {
    throw new Error('merge base could not be resolved');
  }
  return output;
}

// Three-dot diff: only the changes introduced on the branch. --no-renames is
// mandatory so a rename shows up as a delete plus an add and both paths are
// checked.
export function listChanges(repo, base, head) {
  const raw = git(repo, ['diff', '--name-status', '--no-renames', '-z', `${base}...${head}`, '--']);
  const tokens = raw.split('\0');
  while (tokens.length > 0 && tokens[tokens.length - 1] === '') {
    tokens.pop();
  }

  const changes = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const statusToken = tokens[index] ?? '';
    const path = tokens[index + 1] ?? '';
    if (statusToken === '' || path === '') {
      continue;
    }
    changes.push({ status: statusToken.charAt(0), path });
  }
  return changes;
}

// Parses unified-diff text from `git diff -U0` into added lines with their
// new-file line numbers. Pure, so tests can feed crafted diffs directly. A
// "+++ " target that is neither /dev/null nor "b/<path>" (for example a
// quoted path) and a hunk header that does not parse both count as unparsed
// files, because their added lines cannot be attributed safely.
export function parseDiffText(rawText) {
  const lines = [];
  let unparsedFiles = 0;
  let currentPath = null;
  let nextLine = 0;
  let remainingOld = 0;
  let remainingNew = 0;

  for (const line of String(rawText).split('\n')) {
    if (remainingOld > 0 || remainingNew > 0) {
      if (line.startsWith('+')) {
        if (currentPath !== null) {
          lines.push({ path: currentPath, line: nextLine, text: line.slice(1) });
        }
        nextLine += 1;
        remainingNew -= 1;
        continue;
      }

      if (line.startsWith('-')) {
        remainingOld -= 1;
        continue;
      }

      if (line.startsWith(' ')) {
        nextLine += 1;
        remainingOld -= 1;
        remainingNew -= 1;
        continue;
      }

      if (line.startsWith('\\')) {
        continue;
      }
    }

    if (line.startsWith('--- ')) {
      continue;
    }

    if (line.startsWith('+++ ')) {
      let target = line.slice(4);
      if (target.endsWith('\t')) {
        target = target.slice(0, -1);
      }
      if (target === '/dev/null') {
        currentPath = null;
        continue;
      }
      if (target.startsWith('b/')) {
        currentPath = target.slice(2);
        continue;
      }
      unparsedFiles += 1;
      currentPath = null;
      continue;
    }

    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      currentPath = null;
      continue;
    }

    if (line.startsWith('@@ ')) {
      const match = HUNK_HEADER.exec(line);
      if (match) {
        remainingOld = match[2] !== undefined ? Number(match[2]) : 1;
        nextLine = Number(match[3]);
        remainingNew = match[4] !== undefined ? Number(match[4]) : 1;
      } else {
        unparsedFiles += 1;
        remainingOld = 0;
        remainingNew = 0;
        nextLine = 0;
      }
      continue;
    }
  }

  return { lines, unparsedFiles };
}

// Returns every line added on the branch, with its new-file line number. The
// prefix overrides make the "+++ b/<path>" header stable even when the repo
// sets diff.noprefix or diff.mnemonicPrefix.
export function addedLines(repo, base, head) {
  const raw = git(repo, [
    '-c',
    'diff.noprefix=false',
    '-c',
    'diff.mnemonicPrefix=false',
    'diff',
    '-U0',
    '--no-renames',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    `${base}...${head}`,
    '--',
  ]);
  return parseDiffText(raw);
}

// Returns the text of one file at one revision, or null when git cannot read
// it (for example a path that does not exist at that revision).
export function readFileAtRev(repo, rev, path) {
  const safeRev = assertSafeRev(rev, 'revision');
  if (typeof path !== 'string' || path.length === 0) {
    return null;
  }
  try {
    return git(repo, ['show', `${safeRev}:${path}`]);
  } catch {
    return null;
  }
}

// Every character outside printable ASCII becomes "?" so text that came from
// git or the environment can never emit a workflow command or terminal escape.
export function sanitize(text, max = MAX_SANITIZE_LENGTH) {
  const limit = Number.isInteger(max) && max > 0 ? max : MAX_SANITIZE_LENGTH;
  let output = '';
  for (const char of String(text)) {
    const code = char.codePointAt(0) ?? 0;
    output += code >= 0x20 && code <= 0x7e ? char : '?';
  }
  return output.length > limit ? output.slice(0, limit) : output;
}
