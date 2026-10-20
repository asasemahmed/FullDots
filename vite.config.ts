import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client' },
  server: {
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': { target: 'http://127.0.0.1:4310', ws: true } },
  },
  test: {
    // File writes are slow on Windows CI runners: the on-disk SQLite tests take 0.3 s elsewhere and
    // have passed 5 s there. Other platforms keep the default, so a real hang still fails fast.
    testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
  },
});
