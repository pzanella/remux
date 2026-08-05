## What & why

<!-- What this changes, and the problem it solves. Link the issue it addresses, if any (Closes #). -->

## How was this tested?

<!--
There's no automated test suite on the TypeScript side yet, so this section
carries real weight in review — see CONTRIBUTING.md#before-opening-a-pr.

- If you touched wasm/src/lib.rs: did you add/update unit tests? (expected)
- If you touched remux.worker.ts or anything encoding/muxing-related: which
  file(s) did you convert end to end, on which path (fast / Adaptive HLS /
  FFmpeg fallback), and did the result play back correctly in the app's own
  player?
- If you touched UI only: which browser did you check it in?
-->

## Checklist

- [ ] `cargo clippy --all-targets --release --manifest-path wasm/Cargo.toml -- -D warnings` passes
- [ ] `cargo test --release --manifest-path wasm/Cargo.toml` passes
- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run build` succeeds
- [ ] I tested this against a real file end to end (see above), not just a type-check
