import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'

export default defineConfig({
  // Relative asset paths so the build works from a GitHub Pages project
  // subpath (https://<user>.github.io/<repo>/) without hardcoding the repo name.
  base: './',
  plugins: [react(), wasm(), topLevelAwait()],
  server: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
  build: {
    target: 'esnext',
  },
  optimizeDeps: {
    // remux-core: our Rust/Wasm package, injected by vite-plugin-wasm.
    // @ffmpeg/*: spawns its own Worker internally; pre-bundling breaks it.
    exclude: ['remux-core', '@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
})
