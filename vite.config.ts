import { defineConfig } from 'vite';

const env = (globalThis as { process?: { env?: Record<string, string> } }).process?.env ?? {};

export default defineConfig({
  // '/' for local dev + the headless tests; the GitHub Pages build sets PAGES_BASE=/Iron-Empire/.
  base: env.PAGES_BASE || '/',
  // A visible build stamp so it's always clear which version is actually loaded (CI sets
  // GITHUB_SHA; local dev shows 'dev'). Build date is the second half.
  define: {
    __BUILD_ID__: JSON.stringify((env.GITHUB_SHA || 'dev').slice(0, 7) + ' · ' + new Date().toISOString().slice(0, 10)),
  },
  server: {
    host: '127.0.0.1',
    port: Number(env.PORT) || 5175,
  },
  build: { target: 'es2021', sourcemap: true },
});
