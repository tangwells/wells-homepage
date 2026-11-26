## Agent skills

### Issue tracker

Issues and specs are tracked as local markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five triage roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` and `docs/adr/` at the repo root). See `docs/agents/domain.md`.

## Git worktrees

This repository lives inside iCloud Drive (`~/Library/Mobile Documents/`). **NEVER** create a linked git worktree anywhere inside `~/Library/Mobile Documents/` (including relative paths such as `.worktrees/` or `../...` resolved from this repo).

- Always place linked worktrees (e.g. during `/implement-spec`) outside iCloud Drive under `/tmp/carrot-home-worktrees/<name>`.
- Example: `git worktree add /tmp/carrot-home-worktrees/<ticket-slug> -b <branch> <base>`
- Mechanically enforced by `.githooks/post-checkout` and `.githooks/pre-commit`, which block linked worktrees located inside `Library/Mobile Documents`.
