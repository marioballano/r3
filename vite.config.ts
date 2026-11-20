import { defineConfig } from 'vite';

const API = `http://127.0.0.1:${process.env.R3_PORT ?? 3133}`;

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': API,
      '/ws': { target: API.replace('http', 'ws'), ws: true },
    },
  },
  build: { chunkSizeWarningLimit: 2000, target: 'es2022' },
  assetsInclude: ['**/*.glsl'],
});
