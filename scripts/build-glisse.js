#!/usr/bin/env node
/**
 * build-glisse.js
 * Empacota scripts/glisse-entry.js (glisse + React) em public/vendor/glisse.bundle.js, um módulo ES
 * único, sem CDN. O arquivo gerado vai para o git e só é baixado no PC com Chromium
 * (public/ui/liquidGlass.js). Rode `npm run build-glisse` ao atualizar o glisse ou o React.
 */
const esbuild = require('esbuild');
const path = require('path');

esbuild.buildSync({
    entryPoints: [path.join(__dirname, 'glisse-entry.js')],
    outfile: path.join(__dirname, '..', 'public', 'vendor', 'glisse.bundle.js'),
    bundle: true,
    format: 'esm',
    minify: true,
    target: 'es2022',
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: '/* glisse (c) Kelvin Zhang, MIT. React e React DOM (c) Meta Platforms, Inc., MIT. */' },
});
