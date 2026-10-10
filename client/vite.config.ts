import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import clientPkg from './package.json' assert { type: 'json' };

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(clientPkg.version),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@oblihub/shared': path.resolve(__dirname, '../shared/src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:3001', ws: true },
      '/health': { target: 'http://localhost:3001' },
    },
  },
});
