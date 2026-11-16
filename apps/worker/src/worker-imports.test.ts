// apps/worker/src/worker-imports.test.ts
//
// R9: exactly one module in the worker - jobs/deps.ts - may value-import from
// apps/web. Everywhere else a web type comes in with `import type`, which the
// compiler erases, so the worker can start without the web app's module graph
// (and without its module-scope environment parsing).
//
// It also pins the allow-list: the four settlement modules the worker is meant
// to depend on (ADR-0005 D4, ADR-0006 D7). A new `import type` from anywhere else
// under apps/web fails here, which is the point - the worker's coupling to the web
// app is a decision, not a convenience.
//
// The scanner is tested against a temporary tree so a broken pattern cannot pass
// the real tree silently.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const WORKER_SRC = path.dirname(fileURLToPath(import.meta.url));
const WEB_PREFIX = '@/';
const DEPS_FILE = 'jobs/deps.ts';

/** The only web modules the worker may name, and the only ones deps.ts may bind. */
const ALLOWED_WEB_IMPORTS = [
  '@/lib/settlement/settle-slot',
  '@/lib/settlement/adapters/youtube',
  '@/lib/slots/resolve-dispute',
  '@/lib/slots/constants',
] as const;

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

type ImportKind = 'value' | 'type';

export interface ExtractedImport {
  specifier: string;
  kind: ImportKind;
}

/** `import type ... from` and `export type ... from`: erased at compile time. */
const TYPE_FROM = /\b(?:import|export)\s+type\b[^;'"]*?\bfrom\s*['"]([^'"\n]+)['"]/g;

/** `import ... from` and `export ... from` that are not type-only. */
const VALUE_FROM = /\b(?:import|export)\s+(?!type\b)[^;'"]*?\bfrom\s*['"]([^'"\n]+)['"]/g;

/** Every other way to load a module at runtime. */
const VALUE_LOADS = [
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** A specifier imported both ways is reported as a value import: that is the stricter rule. */
export function extractImports(rawSource: string): ExtractedImport[] {
  const source = stripComments(rawSource);
  const found = new Map<string, ImportKind>();

  for (const match of source.matchAll(TYPE_FROM)) {
    const specifier = match[1];
    if (specifier !== undefined && !found.has(specifier)) found.set(specifier, 'type');
  }

  const valuePatterns = [VALUE_FROM, ...VALUE_LOADS];
  for (const pattern of valuePatterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) found.set(specifier, 'value');
    }
  }

  return [...found].map(([specifier, kind]) => ({ specifier, kind }));
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function isAllowed(specifier: string): boolean {
  return (ALLOWED_WEB_IMPORTS as readonly string[]).includes(specifier);
}

/** Every violation of R9 among `files`, relative to `root`, with a readable reason. */
function findViolations(root: string, files: readonly string[]): string[] {
  const violations: string[] = [];

  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const imports = extractImports(readFileSync(file, 'utf8')).filter((entry) =>
      entry.specifier.startsWith(WEB_PREFIX),
    );

    for (const { specifier, kind } of imports) {
      if (relative === DEPS_FILE) {
        if (!isAllowed(specifier)) {
          violations.push(`${relative}: '${specifier}' is not one of the four bound web modules`);
        }
        continue;
      }

      if (kind === 'value') {
        violations.push(
          `${relative}: value import from '${specifier}' - only ${DEPS_FILE} may value-import from the web app`,
        );
        continue;
      }

      if (!isAllowed(specifier)) {
        violations.push(`${relative}: type import from '${specifier}' is not on the allow-list`);
      }
    }
  }

  return violations;
}

function listSources(root: string, options: { includeTests: boolean }): string[] {
  const files: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts')) {
        if (!options.includeTests && entry.name.endsWith('.test.ts')) continue;
        files.push(full);
      }
    }
  };

  walk(root);
  return files;
}

// ---------------------------------------------------------------------------
// The real tree
// ---------------------------------------------------------------------------

describe('worker imports of the web app (R9)', () => {
  it('no module except jobs/deps.ts value-imports from apps/web', () => {
    const files = listSources(WORKER_SRC, { includeTests: false });

    expect(files.length).toBeGreaterThan(0);
    expect(findViolations(WORKER_SRC, files)).toEqual([]);
  });

  it('jobs/deps.ts imports only the four modules it is meant to bind', () => {
    const deps = path.join(WORKER_SRC, DEPS_FILE);

    expect(findViolations(WORKER_SRC, [deps])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Self-test on a temporary tree
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];

function makeTempTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'worker-imports-'));
  tempRoots.push(root);

  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents, 'utf8');
  }

  return root;
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe('scan worker imports', () => {
  it('reports a value import, an allowed type import and an unlisted type import', () => {
    const root = makeTempTree({
      'jobs/expire.ts': "import { SlotStatus } from '@repo/database';\nexport const status = SlotStatus;\n",
      'jobs/sweep.ts': [
        "import type { SlotStatus } from '@/lib/slots/constants';",
        "import { settleSlot } from '@/lib/settlement/settle-slot';",
        'export const both = [settleSlot, null as unknown as SlotStatus];',
        '',
      ].join('\n'),
      'jobs/other.ts': [
        "import type { Logger } from '@/lib/logging';",
        'export const logger = null as unknown as Logger;',
        '',
      ].join('\n'),
    });

    const files = listSources(root, { includeTests: false });
    const violations = findViolations(root, files);

    expect(violations).toHaveLength(2);
    expect(violations.some((line) => line.startsWith('jobs/sweep.ts: value import'))).toBe(true);
    expect(violations.some((line) => line.startsWith('jobs/other.ts: type import'))).toBe(true);
  });
});
