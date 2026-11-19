// apps/worker/src/startup-graph.test.ts
//
// R10: the modules main.ts loads *statically* must be free of the database and
// of the web app, because both read process.env as they are imported and would
// therefore fail (or read a half-validated environment) before configuration has
// been validated.
//
// This walks the graph from main.ts along relative imports only, skipping
// `import type` (erased at compile time) and dynamic `import()` (deliberately
// deferred to after validation), and fails with the full chain when anything
// reachable statically reaches:
//
//   - '@repo/database' or any subpath of it,
//   - anything under '@/' (the web app), or
//   - jobs/deps.ts, the one module allowed to value-import from the web app.
//
// The walker is also tested against temporary trees, so a change that stops it
// detecting anything fails the suite instead of passing it quietly.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/** Tests live in apps/worker/src, so this is the worker's source root. */
const WORKER_SRC = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(WORKER_SRC, 'main.ts');

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function isForbidden(specifier: string): boolean {
  if (specifier === '@repo/database' || specifier.startsWith('@repo/database/')) return true;
  if (specifier.startsWith('@/')) return true;
  // './jobs/deps', './jobs/deps.js' and any other spelling of the same file.
  return /(^|\/)jobs\/deps(?:\.js)?$/.test(specifier);
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/**
 * Comments are removed first: a commented-out import is not a static import, and
 * a false positive here would be indistinguishable from a real one.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Static value imports and re-exports only.
 *
 *   `import { a } from 'x'`   matched
 *   `export { a } from 'x'`   matched (a re-export loads the module too)
 *   `import 'x'`              matched by SIDE_EFFECT
 *   `import type ... from`    NOT matched: erased at compile time
 *   `export type ... from`    NOT matched
 *   `import('x')`             NOT matched: deferred
 *
 * The clause pattern excludes quotes and semicolons, so a match can never run
 * past its own statement into the next one.
 */
const VALUE_FROM = /\b(?:import|export)\s+(?!type\b)[^;'"]*?\bfrom\s*['"]([^'"\n]+)['"]/g;
const SIDE_EFFECT = /\bimport\s*['"]([^'"\n]+)['"]/g;

function staticSpecifiers(rawSource: string): string[] {
  const source = stripComments(rawSource);
  const found = new Set<string>();

  for (const pattern of [VALUE_FROM, SIDE_EFFECT]) {
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

const SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

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

/** Resolves a relative specifier inside `root`; anything else is not walked. */
function resolveRelative(specifier: string, fromFile: string, root: string): string | null {
  if (!specifier.startsWith('.')) return null;

  const base = path.resolve(path.dirname(fromFile), specifier);
  // ESM sources in this repo may name a file 'x.js' where the source is 'x.ts'.
  const bases = specifier.endsWith('.js') ? [base, base.slice(0, -'.js'.length)] : [base];

  for (const candidateBase of bases) {
    for (const suffix of SUFFIXES) {
      const candidate = `${candidateBase}${suffix}`;
      if (!isFile(candidate)) continue;
      // A file outside the worker's source tree is not part of this graph.
      return isUnder(candidate, root) ? candidate : null;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

/** Safety valve: a loop the visited set does not catch must not hang the suite. */
const MAX_FILES = 1_000;

function displayPath(file: string, root: string): string {
  return path.relative(root, file).split(path.sep).join('/') || path.basename(file);
}

/** One readable chain per forbidden import reachable from `entry`. */
function findViolations(entry: string, root: string): string[] {
  const violations: string[] = [];
  const visited = new Set<string>();
  const queue: Array<{ file: string; chain: string }> = [
    { file: entry, chain: displayPath(entry, root) },
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (visited.has(current.file)) continue;
    visited.add(current.file);

    if (visited.size > MAX_FILES) {
      throw new Error(`startup graph walked more than ${MAX_FILES} files starting at ${entry}`);
    }

    const source = readFileSync(current.file, 'utf8');
    for (const specifier of staticSpecifiers(source)) {
      if (isForbidden(specifier)) {
        violations.push(`${current.chain} -> '${specifier}'`);
        continue;
      }

      const resolved = resolveRelative(specifier, current.file, root);
      if (resolved === null) continue;

      queue.push({
        file: resolved,
        chain: `${current.chain} -> '${specifier}'`,
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------

describe('worker startup graph (R10)', () => {
  it('main.ts statically reaches no database, web app or deps module', () => {
    const violations = findViolations(ENTRY, WORKER_SRC);

    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Self-tests on temporary trees
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];

function makeTempTree(files: Record<string, string>): { root: string; entry: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'worker-startup-graph-'));
  tempRoots.push(root);

  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents, 'utf8');
  }

  return { root, entry: path.join(root, 'main.ts') };
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe('walk the startup graph', () => {
  it('detects the database two hops deep and reports the chain', () => {
    const { root, entry } = makeTempTree({
      'main.ts': "import { start } from './lib/start';\nexport const run = start;\n",
      'lib/start.ts': "import { prisma } from '@repo/database';\nexport const start = prisma;\n",
    });

    const violations = findViolations(entry, root);

    expect(violations).toHaveLength(1);
    const chain = violations[0]!;
    expect(chain).toContain("main.ts -> './lib/start'");
    expect(chain).toContain("'@repo/database'");
    expect(chain.indexOf('main.ts')).toBeLessThan(chain.indexOf("'./lib/start'"));
  });

  it('detects a value import from the web app and a static re-export of deps', () => {
    const { root, entry } = makeTempTree({
      'main.ts': [
        "import { a } from './a';",
        "export { b } from './jobs/deps';",
        'export const all = [a, b];',
        '',
      ].join('\n'),
      'a.ts': "import { json } from '@/lib/http/json';\nexport const a = json;\n",
    });

    const violations = findViolations(entry, root);

    expect(violations).toHaveLength(2);
    expect(violations.some((chain) => chain.includes("'@/lib/http/json'"))).toBe(true);
    expect(violations.some((chain) => chain.includes("'./jobs/deps'"))).toBe(true);
  });

  it('ignores dynamic imports and type-only imports', () => {
    const { root, entry } = makeTempTree({
      'main.ts': [
        "import type { PrismaClient } from '@repo/database';",
        "import type { JobDeps } from './jobs/deps';",
        '',
        'export async function start(): Promise<JobDeps> {',
        "  const database = await import('@repo/database');",
        "  const deps = await import('./jobs/deps.js');",
        '  const client: PrismaClient | undefined = database.prisma;',
        '  return deps.buildDeps(client);',
        '}',
        '',
      ].join('\n'),
    });

    expect(findViolations(entry, root)).toEqual([]);
  });

  it('ignores a commented-out import', () => {
    const { root, entry } = makeTempTree({
      'main.ts': [
        "// import { prisma } from '@repo/database';",
        "/* import { prisma } from '@/db'; */",
        "import { leaf } from './leaf';",
        'export const value = leaf;',
        '',
      ].join('\n'),
      'leaf.ts': 'export const leaf = 1;\n',
    });

    expect(findViolations(entry, root)).toEqual([]);
  });
});
