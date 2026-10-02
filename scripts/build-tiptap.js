#!/usr/bin/env node
/**
 * build-tiptap.js
 * Bundles scripts/tiptap-entry.js (Tiptap core + extensions) into public/vendor/tiptap.bundle.js,
 * a single self-contained ES module the browser can import directly - no CDN, no bundler at
 * runtime. Re-run after changing tiptap-entry.js or updating any @tiptap/* package.
 */
const esbuild = require('esbuild');
const path = require('path');

esbuild.build({
    entryPoints: [path.join(__dirname, 'tiptap-entry.js')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    outfile: path.join(__dirname, '..', 'public', 'vendor', 'tiptap.bundle.js'),
}).then(() => {
    console.log('Tiptap bundle built: public/vendor/tiptap.bundle.js');
}).catch(e => {
    console.error('Failed to build the Tiptap bundle:', e.message);
    process.exit(1);
});
