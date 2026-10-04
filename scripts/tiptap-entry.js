/**
 * tiptap-entry.js
 * Bundling entry point: Tiptap ships as bare ES module imports (no self-contained browser build,
 * unlike xterm), so there is no way to <script type="module"> it directly without a bundler. This
 * file re-exports exactly what notesSession.js needs; build-tiptap.js bundles it with esbuild into
 * public/vendor/tiptap.bundle.js - a single dependency-free ESM file, same spirit as copy-xterm.js.
 */
export { Editor } from '@tiptap/core';
export { default as StarterKit } from '@tiptap/starter-kit';
export { default as Image } from '@tiptap/extension-image';
export { default as Placeholder } from '@tiptap/extension-placeholder';
export { default as TaskList } from '@tiptap/extension-task-list';
export { default as TaskItem } from '@tiptap/extension-task-item';
export { default as Link } from '@tiptap/extension-link';
export { Markdown } from 'tiptap-markdown';
export { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
