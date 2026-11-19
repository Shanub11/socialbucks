// apps/worker/src/import-guard.test.ts
//
// ADR-0005 D4. The worker imports settlement code straight out of
// apps/web/src, with no build step, so that code must stay loadable in a plain
// Node process. This walker starts at the modules the worker will import and
// fails with the full chain when anything reachable imports a Next.js, Clerk or
// React dependency, or a path that only exists inside the web app.
//
// The walker is also tested against temporary trees, so a change to the walker
// itself cannot quietly stop detecting anything.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const WEB_SRC = path.join(REPO_ROOT, 'apps', 'web', 'src');
const PACKAGES_DIR = path.join(REPO_ROOT, 'packages');

interface WalkerRoots {
  /** Directory the '@/' alias points at (apps/web/src). */
  webSrc: string;
  /** Directory holding workspace packages, each exposing src/index.ts. */
  packagesDir: string;
  /** Base used to print short paths in a chain. */
  baseDir: string;
}

const REAL_ROOTS: WalkerRoots = { webSrc: WEB_SRC, packagesDir: PACKAGES_DIR, baseDir: REPO_ROOT };

/** Modules the worker imports today or in the next stage (ADR-0003 D5). */
const ENTRY_MODULES = [
  'lib/settlement/settle-slot.ts',
  'lib/settlement/adapters/youtube.ts',
  'lib/slots/resolve-dispute.ts',
  'lib/slots/constants.ts',
] as const;

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Web-only packages the worker cannot load. */
const FORBIDDEN_SPECIFIERS = ['next', 'react', 'react-dom', 'server-only', 'client-only'];

/** Same packages by subpath: 'react/jsx-runtime' is as unloadable as 'react'. */
const FORBIDDEN_SPECIFIER_PREFIXES = ['next/', '@clerk/', 'react/', 'react-dom/'];

/** Web-only paths, by their alias form. */
const FORBIDDEN_ALIASES = ['@/lib/http', '@/lib/auth', '@/app', '@/components'];

/** The same directories, by path, so a relative import cannot slip past. */
const FORBIDDEN_DIRECTORIES = ['lib/http', 'lib/auth', 'app', 'components'];

function isForbiddenSpecifier(specifier: string): boolean {
  if (FORBIDDEN_SPECIFIERS.includes(specifier)) return true;
  if (FORBIDDEN_SPECIFIER_PREFIXES.some((prefix) => specifier.startsWith(prefix))) return true;
  return FORBIDDEN_ALIASES.some(
    (alias) => specifier === alias || specifier.startsWith(`${alias}/`),
  );
}

function isForbiddenPath(file: string, roots: WalkerRoots): boolean {
  const relative = path.relative(roots.webSrc, file).split(path.sep).join('/');
  if (relative === '' || relative.startsWith('..')) return false;
  return FORBIDDEN_DIRECTORIES.some(
    (directory) => relative === directory || relative.startsWith(`${directory}/`),
  );
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

// Covers the four ways a module can name another: `... from 'x'` (import and
// export), bare `import 'x'`, dynamic `import('x')` and `require('x')`.
const IMPORT_PATTERNS: readonly RegExp[] = [
  /\bfrom\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

function extractSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) found.add(specifier);
    }
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

// The empty suffix matters: the generated Prisma client imports './enums.ts'.
const RESOLUTION_SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isUnder(file: string, directory: string): boolean {
  const relative = path.relative(directory, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolveSpecifier(specifier: string, fromFile: string, roots: WalkerRoots): string | null {
  let base: string;

  if (specifier.startsWith('.')) {
    base = path.resolve(path.dirname(fromFile), specifier);
  } else if (specifier.startsWith('@/')) {
    base = path.join(roots.webSrc, specifier.slice(2));
  } else if (specifier.startsWith('@repo/')) {
    // A workspace package: packages/<name>/src/index.ts, the shape every
    // package in this repository uses.
    base = path.join(roots.packagesDir, specifier.slice('@repo/'.length), 'src', 'index');
  } else {
    // A third-party package or a node: builtin. Not walked.
    return null;
  }

  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (!isFile(candidate)) continue;
    // Only files inside the shared trees are followed.
    if (!isUnder(candidate, roots.webSrc) && !isUnder(candidate, roots.packagesDir)) return null;
    return candidate;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

/** Safety valve: a loop the visited set does not catch must not hang the suite. */
const MAX_FILES = 5_000;

function displayPath(file: string, roots: WalkerRoots): string {
  return path.relative(roots.baseDir, file).split(path.sep).join('/');
}

/** Returns one readable chain per forbidden import reachable from `entry`. */
function findViolations(entry: string, roots: WalkerRoots): string[] {
  const violations: string[] = [];
  const visited = new Set<string>();
  const queue: Array<{ file: string; chain: string }> = [
    { file: entry, chain: displayPath(entry, roots) },
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (visited.has(current.file)) continue;
    visited.add(current.file);
    if (visited.size > MAX_FILES) {
      throw new Error(`import guard visited more than ${MAX_FILES} files starting at ${entry}`);
    }

    const source = readFileSync(current.file, 'utf8');
    for (const specifier of extractSpecifiers(source)) {
      if (isForbiddenSpecifier(specifier)) {
        violations.push(`${current.chain} -> '${specifier}'`);
        continue;
      }

      const resolved = resolveSpecifier(specifier, current.file, roots);
      if (resolved === null) continue;

      if (isForbiddenPath(resolved, roots)) {
        violations.push(
          `${current.chain} -> '${specifier}' -> ${displayPath(resolved, roots)}`,
        );
        continue;
      }

      queue.push({
        file: resolved,
        chain: `${current.chain} -> '${specifier}' -> ${displayPath(resolved, roots)}`,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------

describe('worker import guard (ADR-0005 D4)', () => {
  it.each(ENTRY_MODULES)('%s reaches no web-only module', (entry) => {
    const entryPath = path.join(WEB_SRC, entry);

    expect(existsSync(entryPath), `entry module is missing: ${entry}`).toBe(true);

    const violations = findViolations(entryPath, REAL_ROOTS);

    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Self-tests on temporary trees
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];

function makeTempTree(files: Record<string, string>): WalkerRoots {
  const root = mkdtempSync(path.join(tmpdir(), 'worker-import-guard-'));
  tempRoots.push(root);

  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents, 'utf8');
  }

  return {
    webSrc: path.join(root, 'apps', 'web', 'src'),
    packagesDir: path.join(root, 'packages'),
    baseDir: root,
  };
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe('walk import guard', () => {
  it('detects a forbidden import two hops deep and reports the chain', () => {
    const roots = makeTempTree({
      'apps/web/src/entry.ts': "import { middle } from './middle';\nexport const entry = middle;\n",
      'apps/web/src/middle.ts':
        "import { json } from '@/lib/http/json';\nexport const middle = json;\n",
      'apps/web/src/lib/http/json.ts': 'export const json = 1;\n',
    });

    const violations = findViolations(path.join(roots.webSrc, 'entry.ts'), roots);

    expect(violations).toHaveLength(1);
    const chain = violations[0]!;
    expect(chain).toContain("entry.ts -> './middle' -> apps/web/src/middle.ts");
    expect(chain).toContain("-> '@/lib/http/json'");
    expect(chain.indexOf('entry.ts')).toBeLessThan(chain.indexOf('middle.ts'));
  });

  it('passes a clean tree', () => {
    const roots = makeTempTree({
      'apps/web/src/entry.ts': "import { leaf } from './nested/leaf';\nexport const entry = leaf;\n",
      'apps/web/src/nested/leaf.ts':
        "import { z } from 'zod';\nimport { enums } from '@repo/database';\nexport const leaf = z;\nexport const value = enums;\n",
      'packages/database/src/index.ts': "export const enums = 1;\n",
    });

    expect(findViolations(path.join(roots.webSrc, 'entry.ts'), roots)).toEqual([]);
  });

  it('recognises every import form', () => {
    const roots = makeTempTree({
      'apps/web/src/entry.ts': [
        "import 'server-only';",
        "import { a } from 'next/server';",
        "export { b } from '@clerk/nextjs/server';",
        "const c = await import('@/components/button');",
        "const d = require('react');",
        'export const all = [a, b, c, d];',
        '',
      ].join('\n'),
    });

    const violations = findViolations(path.join(roots.webSrc, 'entry.ts'), roots);
    const specifiers = violations.map((chain) => /-> '([^']+)'$/.exec(chain)?.[1] ?? chain);

    expect(specifiers).toEqual(
      expect.arrayContaining([
        'server-only',
        'next/server',
        '@clerk/nextjs/server',
        '@/components/button',
        'react',
      ]),
    );
  });
});
