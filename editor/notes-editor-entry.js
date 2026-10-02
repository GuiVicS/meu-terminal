/**
 * notes-editor-entry.js
 * Source for the Notes block editor (Notion-style: one surface, "/" to insert blocks, inline
 * formatting, checklists, images and file attachments). Built with Tiptap/ProseMirror - vanilla
 * JS, no React, to match the rest of the app. Bundled by scripts/build-notes-editor.js (esbuild)
 * into public/vendor/notes-editor.js; nothing here ships to the browser unbundled, and nothing
 * is fetched from a CDN at runtime (the app is self-hosted - this stays that way).
 *
 * The server keeps storing/syncing notes as plain Markdown text (unchanged API): tiptap-markdown
 * serializes the editor's document to/from that string, so this is purely a client-side editing
 * surface swap.
 */
import { Editor, Node, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import Suggestion from '@tiptap/suggestion';
import { Markdown } from 'tiptap-markdown';

// ---------- Attachment node (a non-image file, shown as a chip with an icon) ----------

const Attachment = Node.create({
    name: 'attachment',
    group: 'block',
    atom: true,
    draggable: true,
    addAttributes() {
        return {
            href: { default: null },
            name: { default: 'arquivo' },
            size: { default: null },
        };
    },
    parseHTML() {
        return [{ tag: 'a[data-attachment]' }];
    },
    renderHTML({ HTMLAttributes }) {
        return ['a', mergeAttributes(HTMLAttributes, { 'data-attachment': '', class: 'nt-attachment', target: '_blank', rel: 'noopener noreferrer' }),
            ['span', { class: 'nt-attachment-name' }, HTMLAttributes.name || 'arquivo']];
    },
    addCommands() {
        return {
            setAttachment: attrs => ({ commands }) => commands.insertContent({ type: this.name, attrs }),
        };
    },
    // Markdown round-trip: a plain link with a leading 📎, so it stays readable as raw Markdown too.
    addStorage() {
        return {
            markdown: {
                serialize(state, node) {
                    state.write(`[📎 ${node.attrs.name}](${node.attrs.href})`);
                    state.closeBlock(node);
                },
                parse: {},
            },
        };
    },
});

// ---------- "/" command palette ----------

/** @typedef {{ key: string, label: string, hint: string, icon: string, group: string, run: (editor: import('@tiptap/core').Editor) => void }} SlashItem */

/** @param {(onPickImage: () => void, onPickFile: () => void) => void} [openPickers] */
function buildSlashItems({ pickImage, pickFile }) {
    /** @type {SlashItem[]} */
    return [
        { key: 'h1', group: 'Títulos', label: 'Título 1', hint: 'Título principal', icon: 'h1', run: e => e.chain().focus().setNode('heading', { level: 1 }).run() },
        { key: 'h2', group: 'Títulos', label: 'Título 2', hint: 'Seção', icon: 'h2', run: e => e.chain().focus().setNode('heading', { level: 2 }).run() },
        { key: 'h3', group: 'Títulos', label: 'Título 3', hint: 'Subseção', icon: 'h3', run: e => e.chain().focus().setNode('heading', { level: 3 }).run() },
        { key: 'paragraph', group: 'Blocos', label: 'Parágrafo', hint: 'Texto comum', icon: 'paragraph', run: e => e.chain().focus().setNode('paragraph').run() },
        { key: 'bullet', group: 'Blocos', label: 'Lista', hint: 'Lista com marcadores', icon: 'list', run: e => e.chain().focus().toggleBulletList().run() },
        { key: 'ordered', group: 'Blocos', label: 'Lista numerada', hint: 'Lista ordenada', icon: 'listOrdered', run: e => e.chain().focus().toggleOrderedList().run() },
        { key: 'task', group: 'Blocos', label: 'Checklist', hint: 'Lista com caixinhas', icon: 'squareCheck', run: e => e.chain().focus().toggleTaskList().run() },
        { key: 'quote', group: 'Blocos', label: 'Citação', hint: 'Bloco de citação', icon: 'quote', run: e => e.chain().focus().toggleBlockquote().run() },
        { key: 'code', group: 'Blocos', label: 'Bloco de código', hint: 'Com destaque de sintaxe', icon: 'codeXml', run: e => e.chain().focus().toggleCodeBlock().run() },
        { key: 'hr', group: 'Blocos', label: 'Divisória', hint: 'Linha horizontal', icon: 'minus', run: e => e.chain().focus().setHorizontalRule().run() },
        { key: 'table', group: 'Avançado', label: 'Tabela', hint: 'Tabela com células editáveis', icon: 'grid', run: e => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
        { key: 'image', group: 'Mídia', label: 'Imagem', hint: 'Enviar uma imagem', icon: 'fileImage', run: () => pickImage() },
        { key: 'file', group: 'Mídia', label: 'Arquivo', hint: 'Anexar um arquivo', icon: 'paperclip', run: () => pickFile() },
    ];
}

/**
 * The "/" command extension: shows a floating menu while typing "/query" and runs the chosen
 * item's command, replacing the typed text. `renderMenu` draws the actual DOM (vanilla, owned by
 * the caller) and returns { update, destroy } - this module only drives *what* to show, not how.
 */
function SlashCommand({ items, renderMenu }) {
    return Node.create({
        name: 'slashCommand',
        addOptions() {
            return {
                suggestion: {
                    char: '/',
                    startOfLine: false,
                    command: ({ editor, range, props }) => {
                        editor.chain().focus().deleteRange(range).run();
                        props.run(editor);
                    },
                },
            };
        },
        addProseMirrorPlugins() {
            return [
                Suggestion({
                    editor: this.editor,
                    ...this.options.suggestion,
                    items: ({ query }) => items().filter(i => !query || i.label.toLowerCase().includes(query.toLowerCase()) || i.key.includes(query.toLowerCase())),
                    render: renderMenu,
                }),
            ];
        },
    });
}

// ---------- editor factory ----------

/**
 * @param {object} opts
 * @param {HTMLElement} opts.element - mounted here
 * @param {string} opts.content - initial Markdown
 * @param {boolean} opts.editable
 * @param {string} [opts.placeholder]
 * @param {(markdown: string) => void} opts.onUpdate - debounced by the caller, called on every change
 * @param {() => void} [opts.onFocus]
 * @param {() => void} [opts.onBlur]
 * @param {(file: File) => Promise<{url: string}>} opts.onImageUpload
 * @param {(file: File) => Promise<{url: string, name: string}>} opts.onFileUpload
 * @param {(items: SlashItem[], opts: object) => { update: Function, destroy: Function }} opts.renderSlashMenu
 */
export function createNotesEditor(opts) {
    const { element, content, editable, placeholder, onUpdate, onFocus, onBlur, onImageUpload, onFileUpload, renderSlashMenu } = opts;

    const pickFile = accept => new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        if (accept) input.accept = accept;
        input.addEventListener('change', () => resolve(input.files?.[0] || null), { once: true });
        input.click();
    });

    async function insertImageFile(file) {
        if (!file || !file.type.startsWith('image/')) return;
        const { url } = await onImageUpload(file);
        editor.chain().focus().setImage({ src: url, alt: file.name }).run();
    }

    async function insertAttachmentFile(file) {
        if (!file) return;
        const { url, name } = await onFileUpload(file);
        editor.chain().focus().insertContent({ type: 'attachment', attrs: { href: url, name: name || file.name, size: file.size } }).run();
    }

    const slashItems = buildSlashItems({
        pickImage: () => pickFile('image/*').then(insertImageFile),
        pickFile: () => pickFile().then(insertAttachmentFile),
    });

    const editor = new Editor({
        element,
        editable,
        extensions: [
            StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
            TaskList,
            TaskItem.configure({ nested: true }),
            Image,
            Link.configure({ openOnClick: false, autolink: true }),
            Placeholder.configure({ placeholder: placeholder || 'Escreva, ou digite "/" para inserir um bloco…' }),
            Table.configure({ resizable: false }),
            TableRow,
            TableHeader,
            TableCell,
            Attachment,
            Markdown.configure({ html: false, transformPastedText: true }),
            SlashCommand({ items: () => slashItems, renderMenu: renderSlashMenu }),
        ],
        content,
        onUpdate: ({ editor: e }) => onUpdate(e.storage.markdown.getMarkdown()),
        onFocus: () => onFocus?.(),
        onBlur: () => onBlur?.(),
        editorProps: {
            handlePaste: (view, event) => {
                const items = Array.from(event.clipboardData?.items || []);
                const imageItem = items.find(i => i.type.startsWith('image/'));
                if (!imageItem) return false;
                event.preventDefault();
                const file = imageItem.getAsFile();
                if (file) void insertImageFile(file);
                return true;
            },
            handleDrop: (view, event) => {
                const files = Array.from(event.dataTransfer?.files || []);
                if (!files.length) return false;
                event.preventDefault();
                files.forEach(f => void (f.type.startsWith('image/') ? insertImageFile(f) : insertAttachmentFile(f)));
                return true;
            },
        },
    });

    return {
        editor,
        getMarkdown: () => editor.storage.markdown.getMarkdown(),
        setMarkdown: md => editor.commands.setContent(md, false),
        setEditable: value => editor.setEditable(value),
        focus: () => editor.commands.focus('end'),
        destroy: () => editor.destroy(),
    };
}
