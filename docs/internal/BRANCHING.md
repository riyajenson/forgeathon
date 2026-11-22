# Branching and commit convention

Shared by the harness and editor workstreams.

## Branches

```text
main                         Stable, integrated code only. Changed ONLY by the human merging a pushed
                             branch (git merge --no-ff). No one commits directly to main.
contracts/v<semver>          Changes to contracts/. Merged to main FIRST, before any branch that depends
                             on it. e.g. contracts/v0.3.1
harness/<phase>-<topic>      Harness work (Claude Code). e.g. harness/p2a-turn-runner,
                             harness/p3-agents-setup, harness/p4-context-engine
editor/<phase>-<topic>       Editor work (Codex). e.g. editor/e1-scaffold, editor/e2-inline-edit,
                             editor/e3-diff-review, editor/e4-agent-panel
integration/<task>           Short-lived branches where harness and editor are combined to rehearse a
                             fixed task. e.g. integration/task-a, integration/task-b, integration/task-c.
                             Fixes found there go back to the owning harness/ or editor/ branch.
docs/<topic>                 README, write-up material, setup docs. e.g. docs/readme-setup
```

Final submission: the original Round 1 submission was commit `2b265c7` on main; the final build is tagged `round1-final` (the human creates and pushes it).

## Rules

1. Create each branch from the latest main. If it depends on an unmerged branch of your own, branch
   from that one and state the base in your report ("based on harness/p2a-turn-runner").
2. One branch = one reviewable unit (one phase or feature). Keep branches small and short-lived; aim to
   merge within hours.
3. Stay inside your ownership:
   - harness/: `src/harness/**`, `agent/**`, `scripts/**`, `config/*.example.json`, `docs/harness/**`
   - editor/: `extension/**`
   - contracts/: `contracts/**` only
   - docs/: `README.md`, `docs/**` (not `docs/harness/**`)

   Never edit the other side's paths. Request changes through the human.
4. Never push, force-push, rebase pushed branches, or delete remote branches. The human pushes.
   Local rebase is allowed only on never-pushed branches.
5. Before handing a branch over: it builds, its tests pass, and the tree is clean. In the report, list
   the branch name, its base, its commits (hash + subject), test results, and anything the other side
   must do.
6. After the human merges to main: the owner deletes the local branch, and both sides merge main into
   their active branches (merge, not rebase, since those branches may be pushed).
7. Worktrees (so the two agents never switch each other's files):
   harness: `~/projects/forgeathon`, editor: `~/projects/forgeathon-editor` (same .git, different branches).

## Commits

- Micro-commits, one logical change each, imperative subject ≤ 72 chars: `<area>: <summary>`,
  where area ∈ `harness | editor | contracts | agent | scripts | docs | test`,
  e.g. `harness: add TrueForge turn runner with approval round trip`.
- Optional body explaining why. No AI/tool mentions, no Co-Authored-By or other trailers.
- Never commit secrets, node_modules, dist/out, .data, logs, or local model configs (only `*.example`).

## Merge order (the human follows this)

`contracts/*` → `harness/*` and `editor/*` (any order) → `integration/*` → `docs/*` → tag `round1-final` (on main)
