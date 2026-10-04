# Git

## Commits

- [Conventional Commits](https://www.conventionalcommits.org): `type(scope): summary`, checked by `committed` in CI.
  Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`. Scopes: a crate name (`core`,
  `dlmm`, `ledger`, `store`, `chain`, `engine`, `api`, `demo`, `binsight`), `web`, `xtask`, `deps`, `github`.
- The summary is imperative, lowercase, no trailing period, under 72 characters, and says what changes for the
  project, not which files moved.
- The body (wrapped at 72) explains **why**: the problem, the decision, the alternative rejected. Not a list of files.
- **One commit = one intent.** It compiles, passes `just check`, and could be reverted on its own. Formatting-only or
  renaming-only changes get their own commit.
- Never commit generated output that CI regenerates, local state, secrets or personal data.

## Branches and history

- One branch per piece of work, named after it (`feat/position-detail`, `fix/claim-dedup`).
- `main` is always green and linear: branches are merged with `--ff-only` after rebasing. No merge commits, no
  force-push on `main`.
- Rewrite your own branch freely before it is merged (squash fixups into the commit they fix); never after.
