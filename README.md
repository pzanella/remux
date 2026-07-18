# Remux

[![CI](https://github.com/pzanella/remux/actions/workflows/ci.yml/badge.svg)](https://github.com/pzanella/remux/actions/workflows/ci.yml)
[![Live demo](https://img.shields.io/badge/demo-github%20pages-blue)](https://pzanella.github.io/remux/)
[![License: MIT](https://img.shields.io/badge/license-MIT-informational)](LICENSE)

Turn a video into an HLS stream, right in your browser. No upload, no server,
no install.

**[Try it live →](https://pzanella.github.io/remux/)**

![Remux UI: a narrow rail with the video/output pickers and controls next to a wide preview stage with the player, log console, and playlist tabs](docs/screenshot.png)

Controls sit in a narrow rail on the left, the preview and log console sit on
the right — everything fits on one screen, no scrolling needed.

## Why

Normally, converting a video to HLS means running FFmpeg on a server. Remux
does the same job inside the browser tab. For MP4 and MOV files, it copies
the existing video and audio into HLS segments — no re-encoding, so it is
fast and the quality does not change. For other formats, it uses FFmpeg
compiled to WebAssembly to convert the file first. Your video never leaves
your computer.

## Features

- **Works with many formats** — MP4, MOV, MKV, WebM, AVI, WMV, FLV, and more.
- **Fast native path** — MP4/MOV files are remuxed by a small Rust program
  compiled to WebAssembly. No quality loss, no re-encoding.
- **Optional adaptive (multi-resolution) HLS** — generate a master playlist
  with 240p/360p/480p/720p renditions, picked in the UI. This mode re-encodes,
  using hardware acceleration when the browser supports it (see below).
- **Built-in player** — watch the video while it is still converting.
- **Crash recovery** — if the browser closes or crashes, you can pick up
  right where you left off.
- **Light on memory** — the file is never fully loaded into RAM, even for
  large videos.

## Project Structure

```
remux/
├── index.html
├── vite.config.ts
├── eslint.config.js
├── tsconfig.json
│
├── public/
│   └── coi-serviceworker.js    # supplies COOP/COEP on hosts that can't set headers (e.g. GitHub Pages)
│
├── wasm/                        # Rust crate, compiled to WebAssembly
│   ├── Cargo.toml
│   └── src/lib.rs                # reads MP4, writes MPEG-TS segments
│
└── src/
    ├── main.tsx
    ├── App.tsx                   # puts the whole page together
    ├── index.css                 # all styles, no CSS framework
    │
    ├── components/               # small pieces of UI (one job each)
    ├── hooks/
    │   ├── useTranscoder.ts      # runs the worker, tracks progress
    │   └── usePersistence.ts     # saves progress so you can resume later
    ├── worker/remux.worker.ts    # does the heavy work off the main thread
    └── types/
```

## Prerequisites

- [Node.js](https://nodejs.org/) `>=22.20.0` (this repo pins that version in
  `.nvmrc` — run `nvm use` if you have nvm)
- [Rust](https://rustup.rs/), installed with `rustup` (not Homebrew)
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  rustup target add wasm32-unknown-unknown
  ```
- [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/)
  ```bash
  cargo install wasm-pack
  ```

## Getting Started

```bash
git clone https://github.com/pzanella/remux.git
cd remux
npm install
npm run build:wasm   # compiles wasm/ and writes the output to src/wasm/
npm run dev          # starts the dev server at http://localhost:5173
```

Or run both build steps in one command:

```bash
npm run dev:full
```

Open the app, pick a video file, pick a folder to save the output, and press
**Start**.

## npm Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` | Type-check and build for production, into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run build:wasm` | Rebuild the Rust crate |
| `npm run dev:full` | `build:wasm`, then `dev` |
| `npm run lint` | Check the code with ESLint |
| `npm run typecheck` | Check types without building |

## How It Works

1. **The file goes into OPFS** — a private, in-browser file system. It is
   streamed in small chunks, so even a 500 MB file does not fill up RAM.
2. **A Web Worker takes over.** If the file is not MP4/MOV, FFmpeg.wasm
   converts it to H.264 + AAC MP4 first.
3. **The Rust remuxer reads the video's headers** and works out where every
   segment should start and end, always at a keyframe.
4. **For each segment**, the worker reads the matching bytes from OPFS,
   hands them to Rust to build an MPEG-TS segment, and writes the result to
   your chosen folder. The playlist (`index.m3u8`) is updated after every
   segment, so the built-in player can start before the job is finished.
5. **Progress is saved to IndexedDB** after every segment. If something goes
   wrong, reopen the app and press **Resume**.

## Adaptive (Multi-Resolution) HLS

Turn on **Adaptive HLS** in the rail and pick which renditions to generate —
240p, 360p, 480p, 720p. Renditions larger than the source are disabled
automatically (no upscaling).

Producing a genuinely different resolution means decoding and re-encoding,
something the fast path's Rust remuxer never does (it only copies existing
samples byte-for-byte). Adaptive HLS re-encodes — but rather than doing that
in software, it uses [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API),
the browser's own hardware-accelerated encode/decode API, on browsers that
support it (Chrome/Edge 94+ — inside this project's normal requirement):

- **The source is decoded exactly once**, no matter how many renditions are
  selected, and fanned out to one hardware encoder per rendition — the
  Rust parser (the same one the fast path uses) reads the sample table,
  `VideoDecoder`/`AudioDecoder` decode it once, each rendition's
  `VideoEncoder`/`AudioEncoder` re-encodes from those same decoded frames.
  Video and audio samples are fed to their decoders interleaved, in
  chronological order, so audio for a given moment is always available by
  the time that moment's video segment gets cut — not decoded as two
  separate back-to-back passes.
- **No file duplication in memory.** Samples stream in from OPFS one at a
  time, the same way the fast path reads them — never the whole source
  buffered at once, and never once per rendition.
- **Hardware, not WebAssembly.** Encoding runs on the OS/GPU's codec instead
  of a single-threaded software encoder.
- **One rendition's trouble doesn't sink the others.** If a specific
  rendition's encoder hits trouble partway through — a real, occasionally
  observed hardware quirk on some machines — only that rendition is dropped;
  the rest finish and ship normally.
- **Edit-list aware.** Some real-world files carry a trailing chunk of
  encoded data that a QuickTime-style edit list marks as "not for playback"
  (often a partial frame left over from when recording stopped). The parser
  reads that boundary from either track and trims both to it, the same way
  a normal player would, instead of trying to decode content nothing else
  ever plays.

If WebCodecs isn't available, or the selected renditions' encoder configs
aren't supported on that machine, Remux automatically falls back to
FFmpeg.wasm — the same software path used for non-native container
conversion, so keeping it as a fallback doesn't add a new dependency, just
reuses one already there. FFmpeg fallback jobs encode renditions in parallel,
each in its own instance, at the cost of one full copy of the source per
rendition in memory. Neither path supports pause/resume for Adaptive HLS — a
restart begins the whole job over — but Cancel stops either one mid-flight.

The output folder gets one `.m3u8` and one set of `.ts` segments per
rendition (e.g. `480p.m3u8`, `480p_0000.ts`, ...), plus a `master.m3u8` that
lists them all with `#EXT-X-STREAM-INF` so any HLS player can switch between
them — the same output shape regardless of which path produced it.

## Supported Formats

| Format | Extensions | How it's handled |
| --- | --- | --- |
| MPEG-4 / QuickTime | `.mp4` `.mov` `.m4v` `.3gp` `.f4v` | Native Rust remux, no re-encode |
| Everything else | `.mkv` `.webm` `.avi` `.wmv` `.flv` `.ts` `.ogv` `.mpg` ... | FFmpeg.wasm converts it first |

## Good to Know

- Needs Chrome or Edge 108+, and either `localhost` or HTTPS.
- The server (or `vite preview`) must send two headers —
  `Cross-Origin-Embedder-Policy: require-corp` and
  `Cross-Origin-Opener-Policy: same-origin` — or the browser will refuse to
  open files the way Remux needs. `vite.config.ts` sets both for dev/preview;
  on hosts that can't set custom headers (like GitHub Pages),
  `public/coi-serviceworker.js` supplies them client-side instead.
- HEVC and AV1 video are not supported by the fast native path.
- The FFmpeg fallback downloads its engine (~32 MB) from a public CDN the
  first time it runs, then caches it for later sessions.
- Adaptive HLS's audio floor is 96 kbps, even for the 240p rung — Chrome's
  WebCodecs AAC encoder was found (empirically, against real stereo footage)
  to reliably fail to finish encoding stereo audio below that, regardless of
  source content or resolution.

## CI/CD

Every push and pull request runs through
[`.github/workflows/ci.yml`](.github/workflows/ci.yml): `cargo clippy` and
`cargo test` for the Rust crate, then building the Wasm module, `eslint`,
`tsc --noEmit`, and a production build. Pushes to `main` additionally deploy
`dist/` to GitHub Pages.

## Acknowledgments

- [FFmpeg](https://ffmpeg.org/) via [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)
- [hls.js](https://github.com/video-dev/hls.js) for in-browser playback
- [wasm-bindgen](https://github.com/rustwasm/wasm-bindgen) for the Rust ⇄ JS bridge
- [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker), vendored in
  `public/coi-serviceworker.js`, for cross-origin isolation on static hosts

## License

[MIT](LICENSE)
