# Contributing

Thanks for helping! A few rules keep the project healthy.

## Setup

See "Build from source" in the README. Then:

```powershell
npm ci
npm run app:dev
```

## Before opening a pull request

```powershell
npm run typecheck
npm test
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

## Principles

- **Nothing simulated.** The UI shows real state only: an agent is "working" only
  while its Claude Code process runs a turn; a message is shown as delivered only
  once written to the recipient's session.
- **Crate boundaries.** `pcc-core` has no I/O. Persistence goes through
  `pcc-store`, processes through `pcc-claude`, git through `pcc-git`. The engine
  (`pcc-orchestrator`) is the only place that combines them.
- **Safety first.** New tool classifications must err on the side of asking the
  user. Never write secrets to the project folder or to logs.
- **Contract.** `src/lib/types.ts` and `src/lib/api.ts` mirror the Rust DTOs and
  commands; change both sides together.
