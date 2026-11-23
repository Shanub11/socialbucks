## What and why

<!-- One short paragraph. -->

## Branch type

- [ ] fb/ (Freebuff only, Tier C): the Guard check must be green
- [ ] cl/ (Tier A or B): the review packet was reviewed by Claude
- [ ] other (owner-authored)

## Checklist

- [ ] tsc is clean, eslint has 0 errors and no new warnings, tests are green
- [ ] Full web suite green on a DB-on run (owner), and the CI test floor raised in its own commit if tests were added
- [ ] Review packet pasted to Claude for Tier A and B work (protected paths, existing tests, dependencies, findings)
- [ ] No secrets, tokens or personal data in code, logs, tests or fixtures
- [ ] Key-handling and money diffs reviewed by the owner personally
- [ ] Migrations, if any, are guarded for plain Postgres and were applied to a scratch database
