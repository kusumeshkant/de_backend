/**
 * Custom esbuild step for Cloudflare Workers.
 * - mainFields excludes 'browser' so mongoose uses Node.js build (not browser UMD)
 * - polyfillNode inlines all Node.js built-in polyfills (events, stream, crypto, etc.)
 *   so CF Workers validator doesn't reject dynamic requires at deploy time
 */

import esbuild from 'esbuild';
import { polyfillNode } from 'esbuild-plugin-polyfill-node';
import { mkdirSync } from 'fs';

mkdirSync('dist', { recursive: true });

await esbuild.build({
  entryPoints: ['worker.js'],
  bundle: true,
  platform: 'browser',
  // Exclude 'browser' field — forces mongoose to resolve from 'main' (Node.js build)
  mainFields: ['module', 'main'],
  format: 'esm',
  target: 'es2022',
  outfile: 'dist/worker.js',
  plugins: [
    polyfillNode(),
  ],
  logLevel: 'info',
});

console.log('✓ Worker bundled to dist/worker.js');
