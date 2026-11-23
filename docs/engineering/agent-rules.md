# Agent rules (standing, apply to every task)

Intended repo path: docs/engineering/agent-rules.md. Every agent prompt starts with: "Read
docs/engineering/agent-rules.md and docs/plan/launch-plan.md first." Rules in a task prompt win over this
file only when the prompt says so explicitly.

## Git and process

1. The FIRST tool call of every task is the precondition gate given in the prompt (branch, HEAD or ancestor
   check, porcelain status). If it fails, STOP and report. Do nothing else.
2. Never run git add, commit, push, merge, rebase, stash, checkout or switch. The owner does all git writes.
3. Work only in the main folder C:\Shanu\socialbucks. No second worktree.
4. If the prompt and the code conflict, STOP and report. The owner decides. Do not improvise.
5. Work in stages when the prompt says so: do one edit set, send a report, STOP until the owner replies "continue".
6. .freebuff/project-id is tracked, gets rewritten by the tool and must never be edited by you or staged.

## Tests

7. Never edit or delete an existing test file unless the prompt names the exact file. New tests go in new files.
8. Never run database tests. Never set TEST_DATABASE_URL, DATABASE_URL, DIRECT_URL or RUN_DB_TESTS. Never print
   an environment variable value. Never run the full suite unless the prompt says so.
9. You may run: pnpm exec tsc --noEmit, pnpm exec eslint on the files you touched, and vitest on the NEW
   non-database test files you created.
10. A test must fail when the behaviour it guards is removed. Assert outcomes and logged fields exactly. For
    secrets, assert that sentinel strings never appear in logs, responses or thrown messages.

## File hygiene

11. ASCII only in every file you create or edit. Keep a final newline. Quote paths that contain parentheses or
    brackets. If your edit tool cannot patch a single-line CRLF file, you may delete and recreate THAT listed
    file only.
12. Only edit files the prompt lists. Create only files the prompt lists.
13. No new dependency without the prompt naming it. Dependencies must respect pnpm-workspace.yaml
    minimumReleaseAge (14 days). Never change package.json, the lockfile or pnpm-workspace.yaml unless listed.

## Security rules for all code

14. Every API route: authenticate (Clerk), then authorise (organisation role or resource ownership through the
    existing helpers), then validate input with a strict zod schema, in that order. Never trust ids, roles or
    amounts from the client.
15. Money: Prisma Decimal or decimal strings only, never floats. State changes are compare-and-swap and
    idempotent. A webhook is trusted only after signature verification, and is processed idempotently.
16. Database access: Prisma query API or tagged $queryRaw only. No string-built SQL. Select only the fields needed.
17. Logs and errors: never log or return tokens, ciphertext, secrets, personal data, provider response bodies,
    provider error text, database error messages or stack traces. Log ids, outcome codes, counts and durations.
    Return generic messages to clients.
18. Environment variables are read only in the env modules (lib/env.ts, lib/env-parts.ts). Do not call
    process.env elsewhere.
19. No dangerouslySetInnerHTML, eval, new Function, or untrusted URL construction. User-controlled redirect
    targets must be validated as same-origin relative paths.
20. No any, no @ts-ignore, no eslint-disable without a one-line justification the owner can review.
21. UI never decides security. A hidden button is not authorisation; the API must enforce it.

## Protected paths (Tier C agents must NOT touch; Tier A and B only with an explicit prompt)

The authoritative list is scripts/protected-paths.json; if this text differs, the JSON wins. In short: all of
packages/database, apps/worker, apps/web/src/lib (every file, including env, auth, crypto, oauth, youtube,
instagram, social, settlement, campaigns, invites, slots, orgs, http, db, payments), apps/web/src/test,
apps/web/src/app/api (all routes and webhooks), apps/web/src/proxy.ts, build and tool config (next.config,
vitest, eslint, tsconfig, turbo.json, docker-compose, Dockerfile, vercel.json, .npmrc, .gitignore,
.gitattributes), every package.json and lockfile, .github, .freebuff, .gitleaks.toml, scripts, docs/adr,
docs/engineering, docs/plan, every .env* file and any .pem or .key file. Matching is case-insensitive.

## Extra rules for Tier C (fb/ branches)

22. Tier C changes are presentational. They must not import @repo/database or @prisma/*, must not import
    @clerk/nextjs/server, must not define server actions ('use server'), must not use next/headers,
    NextRequest or NextResponse, must not read process.env, and must not use dangerouslySetInnerHTML or
    raw SQL. The guard fails the branch if an added line contains any of these.
23. A page or layout that needs data calls an existing function in apps/web/src/lib created by Tier A or B.
    If none exists, STOP and report; never query the database from a page.
24. Tier C may add new files and edit files outside the protected paths. It may not modify or delete an
    existing test file.
25. An EXISTING file that already contains any construct listed in rule 22 (for example a server-rendered
    page that queries the database) is Tier B. The guard fails an fb/ branch that edits or deletes it. Do not
    edit such a file; STOP and report so the work can be moved to a cl/ branch.

## Report format (every report)

1. Gate output. 2. git status --porcelain and git diff --stat. 3. Full diff of every protected-path or
route file touched. 4. New test counts and tsc, eslint and vitest results. 5. Any deviation, surprise or
rule you could not follow. Then STOP.
