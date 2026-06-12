import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: Number((globalThis as { process?: { env?: Record<string, string> } }).process?.env?.PORT) || 5175,
  },
  build: { target: 'es2021', sourcemap: true },
});
