#!/usr/bin/env node
/**
 * build-notes-editor.js
 * Bundles editor/notes-editor-entry.js (Tiptap/ProseMirror - ESM packages, no browser-ready
 * build like xterm.js has) into a single static file the browser loads directly, same spirit as
 * copy-xterm.js: everything the app needs ships from this server, nothing is fetched from a CDN.
 * Run via `npm run build:notes-editor` (wired into `start`/`dev`, like copy-xterm).
 */
const esbuild = require('esbuild');
const path = require('path');

const entry = path.join(__dirname, '..', 'editor', 'notes-editor-entry.js');
const outfile = path.join(__dirname, '..', 'public', 'vendor', 'notes-editor.js');

esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    minify: process.env.NODE_ENV === 'production',
    sourcemap: process.env.NODE_ENV !== 'production',
    logLevel: 'info',
}).catch(err => {
    console.error('Falha ao empacotar o editor de anotações:', err);
    process.exit(1);
});
