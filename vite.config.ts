import { defineConfig } from 'vite';

const env = (globalThis as { process?: { env?: Record<string, string> } }).process?.env ?? {};

export default defineConfig({
  // '/' for local dev + the headless tests; the GitHub Pages build sets PAGES_BASE=/Iron-Empire/.
  base: env.PAGES_BASE || '/',
  server: {
    host: '127.0.0.1',
    port: Number(env.PORT) || 5175,
  },
  build: { target: 'es2021', sourcemap: true },
});
