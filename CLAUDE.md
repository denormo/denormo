# denormo

denormo keeps denormalized snapshot fields in MongoDB eventually consistent with their sources, using change streams and a declarative sync contract. The full design is in `docs/HLD.md`; read it before making architectural changes.

## Repository layout

```
packages/
  core/       @denormo/core      ODM-agnostic engine; depends only on `mongodb`
  mongoose/   @denormo/mongoose  Mongoose adapter; compiles schemas to core config
  cli/        @denormo/cli       (Phase 3) CLI commands
docs/
  HLD.md      design source of truth
```

## Stack

- Node.js 22+, TypeScript (strict), ESM with CJS builds via `tsup`
- pnpm workspaces
- Vitest for tests
- `mongodb` driver (current major) in core; `mongoose` as a peer dependency (`^8 || ^9`) in the adapter only
- `mongodb-memory-server` in replica-set mode for integration tests (change streams need a replica set)
- ESLint + Prettier; Changesets for versioning

## Hard rules

1. **`packages/core` must never import `mongoose`.** Enforced by an ESLint `no-restricted-imports` rule. Core speaks in collection names and field paths, never model names.
2. **The compiled config is the public contract.** Its types live in `packages/core/src/config/types.ts`. Changing them is a breaking change; ask first.
3. **The planner is pure.** `packages/core/src/planner` takes config + a normalized change event and returns update operations. No I/O, no driver calls, no clocks. This keeps correctness logic fully unit-testable.
4. **Every sync update carries the version guard** (`<path>._v: { $lt: version }`) and the no-op filter (`$ne` on at least one changed value). Never emit an unguarded update.
5. **Versions are BSON Timestamps** from change-event `clusterTime` (stream mode) or `session.operationTime` (inline mode). Never use `Date` or wall-clock time for ordering.
6. **Test-first for core logic.** Write or update the failing test before the implementation.
7. **Don't build ahead of the roadmap.** Work only on the phase requested. If something from a later phase seems necessary, stop and explain why.

## Commands

```
pnpm install
pnpm build          # build all packages
pnpm test           # unit + integration tests
pnpm test:unit      # fast, no database
pnpm lint
pnpm typecheck
```

## Conventions

- Named exports only; no default exports.
- Errors: throw `DenormoConfigError` (validation) or `DenormoRuntimeError` (engine), each with a `code` string and the relation id when relevant.
- Field paths use dot notation; array segments in planned updates use named `arrayFilters` identifiers, never positional `$`.
- Keep public API changes reflected in `docs/HLD.md` (Public API surface section) in the same change.
- Commit messages: Conventional Commits (`feat(core): ...`, `test(core): ...`).
