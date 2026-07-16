import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The Vite entry (index.html) lives at the repo root so it can be hosted as-is
// on GitHub Pages, so we point Vite's root there (two levels up from this
// config in the monorepo). `base: './'` keeps asset URLs relative, which is
// what a project-pages deploy under /<repo>/ needs.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

export default defineConfig({
  root: repoRoot,
  base: './',
  server: { port: 5173 },
  build: {
    outDir: resolve(repoRoot, 'dist'),
    emptyOutDir: true,
  },
});
