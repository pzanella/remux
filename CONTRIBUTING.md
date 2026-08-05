# Contributing to Remux

Thanks for taking a look at Remux. It's a small project with two moving
parts — a TypeScript/React app and a Rust crate compiled to WebAssembly — so
a few things are worth knowing before you dive in.

## Before you start

For anything beyond a small fix (typo, obvious bug, small UI tweak), please
open an issue first to discuss the approach. This project runs entirely
client-side by design (no server, no upload) — that constraint shapes a lot
of decisions, and it's easier to align on a plan before you invest time in
an implementation that doesn't fit it.

## Setup

Follow [Prerequisites](README.md#prerequisites) and
[Getting Started](README.md#getting-started) in the README. In short:

```bash
nvm use              # Node version pinned in .nvmrc
npm install
npm run build:wasm   # compiles wasm/ — required once, and again after any wasm/ change
npm run dev
```

If you're only touching TypeScript/React and not `wasm/`, you still need to
run `build:wasm` once to produce `packages/remux-core/` — it's gitignored
and generated, not checked in.

## Where things live

See [Project Structure](README.md#project-structure) in the README for the
full layout. The two places most changes land:

- `wasm/src/lib.rs` — MP4 parsing, MPEG-TS muxing. Touch this for anything
  about container/segment format correctness.
- `src/worker/remux.worker.ts` — orchestrates the Rust core: reads samples
  from OPFS, drives WebCodecs/FFmpeg.wasm, writes segments and playlists.
  This is the densest file in the app; read the existing helpers before
  adding a new one; there's likely a pattern to follow.

## Before opening a PR

Run the same checks CI runs:

```bash
cargo clippy --all-targets --release --manifest-path wasm/Cargo.toml -- -D warnings
cargo test --release --manifest-path wasm/Cargo.toml
npm run build:wasm
npm run lint
npm run typecheck
npm run build
```

**There is no automated test suite on the TypeScript side yet** — only the
Rust crate has unit tests. Until that changes, PRs that touch
`remux.worker.ts` or anything encoding/muxing-related need to be verified by
hand: convert a real file end to end (fast path and, if relevant, Adaptive
HLS) and confirm it plays back correctly in the app's own Shaka player.
Describe what you tested in the PR description — reviewers have no other
way to know a change works. If you're adding a new Rust function, unit
tests for it (alongside the existing ones in `wasm/src/lib.rs`) are expected.

## Commit messages

This repo loosely follows [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `docs:`, `refactor:`, etc. Not strictly enforced, but keeps
`git log` useful.

## Code style

- Lint/format are enforced by `npm run lint` (ESLint) and `cargo clippy`
  (`-D warnings`, so warnings fail CI) — run both before pushing.
- Comments should explain *why*, not *what* — the codebase leans on
  descriptive names and doc comments for non-obvious constraints (see
  existing comments in `wasm/src/lib.rs` and `types/index.ts` for the tone
  to match).

## Scope note

Issues and PRs that add server-side components, uploads, or any dependency
on a backend will likely be declined — "never leaves the browser" is the
project's core constraint, not an implementation detail up for negotiation.
