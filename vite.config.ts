import { defineConfig } from 'vite';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';

const API = `http://127.0.0.1:${process.env.R3_PORT ?? 3133}`;

// R3_LAN=1: serve on every interface over HTTPS so a headset browser on the network can open r3.
// WebXR needs a secure context, and a self-signed certificate is enough once accepted in the browser.
// This exposes the API (which browses the host filesystem) to the LAN.
const LAN = !!process.env.R3_LAN;

function selfSigned() {
  const dir = 'node_modules/.r3-cert';
  const key = `${dir}/key.pem`;
  const cert = `${dir}/cert.pem`;
  if (!existsSync(cert)) {
    mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825', '-subj', '/CN=r3', '-addext', 'subjectAltName=DNS:localhost', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

if (LAN) console.warn('\x1b[33m[r3] R3_LAN: serving on the network over HTTPS. Anyone on it can browse this host\'s files through r3.\x1b[0m');

export default defineConfig({
  base: './',
  server: {
    host: LAN ? '0.0.0.0' : '127.0.0.1',
    https: LAN ? selfSigned() : undefined,
    port: 5173,
    proxy: {
      '/api': API,
      '/ws': { target: API.replace('http', 'ws'), ws: true },
    },
  },
  build: { chunkSizeWarningLimit: 2000, target: 'es2022' },
  // pre-bundle deps only reached from the CFG layout worker, so the dev server never
  // discovers them lazily (which would force a full page reload mid-session)
  optimizeDeps: { include: ['@dagrejs/dagre', 'three', 'gsap', 'postprocessing', '@xterm/xterm', '@xterm/addon-fit'] },
  worker: { format: 'es' },
  assetsInclude: ['**/*.glsl'],
});
