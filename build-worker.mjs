/**
 * Custom esbuild step for Cloudflare Workers.
 * Key setting: mainFields excludes 'browser' so mongoose uses its
 * Node.js build (lib/index.js) instead of the browser UMD bundle.
 */

import esbuild from 'esbuild';
import { mkdirSync } from 'fs';

mkdirSync('dist', { recursive: true });

await esbuild.build({
  entryPoints: ['worker.js'],
  bundle: true,
  platform: 'node',
  // Exclude 'browser' field — forces mongoose to resolve from 'main' (Node.js build)
  mainFields: ['module', 'main'],
  format: 'esm',
  target: 'es2022',
  outfile: 'dist/worker.js',
  logLevel: 'info',
});

console.log('✓ Worker bundled to dist/worker.js');
