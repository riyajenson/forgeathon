# Retrieval coverage and evidence checks

The context engine requests up to 20,000 repository paths (the shared listing limit,
`LIST_LIMIT`; origin's 2,000 was raised when merging) instead of inheriting the editor's
500-file default. Reaching the cap is reported as possibly incomplete coverage in the
existing panel's skipped-items section.
Unreadable, disappeared, binary and oversized files are reported there too;
one unreadable code file does not discard the rest of the index. If any `.gitignore`
(root or nested) exists but cannot be read, automatic indexing stops with a visible warning instead
of sending potentially excluded files. Very small configured budgets are honored.

This remains a bounded index, not complete retrieval for arbitrary monorepos.
Narrow the workspace when the inventory warning appears. Token values estimate
the packed code, not the entire session's prompts, tool results and output.

## Submission evidence gate

```bash
node scripts/check-submission.mjs
node --test scripts/submission-readiness.test.mjs
```

The first command deliberately fails while the write-up has placeholders or no
real-model evidence. Copy `config/rehearsal.example.json` to
`docs/writeup/rehearsal.json` and replace the fields with actual observations.
Never include keys, authorization headers or provider credentials in evidence.
Alternative file paths can be supplied with `--writeup` and `--evidence`.

Record the tested repository revision, pinned Flask revision, model names,
hosting, approximate costs, A/B/C session links, verification results, token
usage and video timestamps. Run `scripts/smoke-real-model.mjs --tasks A,B,C`
against configured real providers, then verify the editor interactions manually.
Mock runs are useful plumbing tests and do not satisfy real-model evidence.

This is a completeness check of team-declared evidence. It does not attest that
claims are true, inspect videos, verify PDF length or check public link access.
A passing gate does not replace those checks. Missing information stays pending;
no names, costs, timestamps or rehearsal results are generated automatically.
