/**
 * webhook-presets.js
 * Ready-made webhooks a user can start from in /admin (see docs/PLANO-WEBHOOKS.md, section 3.2).
 * Each one is just a starting script + inputs - everything stays editable afterward.
 */
const PRESETS = [
    {
        key: 'update-repo',
        label: 'Atualizar repositório',
        description: 'git fetch + checkout + pull --ff-only numa pasta.',
        script: 'cd "$PASTA" && git fetch && git checkout "$BRANCH" && git pull --ff-only',
        inputs: [
            { name: 'PASTA', label: 'Pasta', type: 'path', required: true, source: 'fixed' },
            { name: 'BRANCH', label: 'Branch', type: 'text', default: 'main', source: 'body.ref', extract: '^refs/heads/(.+)$' },
        ],
    },
    {
        key: 'docker-compose-deploy',
        label: 'Deploy com Docker Compose',
        description: 'git pull + docker compose up -d --build.',
        script: 'cd "$PASTA" && git pull --ff-only && docker compose up -d --build',
        inputs: [{ name: 'PASTA', label: 'Pasta', type: 'path', required: true, source: 'fixed' }],
    },
    {
        key: 'npm-script',
        label: 'Rodar script npm',
        description: 'npm run <script> numa pasta.',
        script: 'cd "$PASTA" && npm run "$SCRIPT"',
        inputs: [
            { name: 'PASTA', label: 'Pasta', type: 'path', required: true, source: 'fixed' },
            { name: 'SCRIPT', label: 'Script', type: 'text', required: true, source: 'fixed' },
        ],
    },
    {
        key: 'restart-service',
        label: 'Reiniciar serviço',
        description: 'systemctl restart (ou pm2 restart) um serviço.',
        script: 'if command -v systemctl >/dev/null && systemctl is-enabled --quiet "$SERVICO" 2>/dev/null; then\n'
            + '  systemctl restart "$SERVICO"\nelse\n  pm2 restart "$SERVICO"\nfi',
        inputs: [{ name: 'SERVICO', label: 'Serviço', type: 'text', required: true, source: 'fixed' }],
    },
    {
        key: 'backup-db',
        label: 'Backup do banco',
        description: 'Backup pontual de um arquivo SQLite (ver também a seção Backup do /admin).',
        script: 'sqlite3 "$BANCO" ".backup \'$DESTINO/backup-$(date +%F-%H%M).db\'"',
        inputs: [
            { name: 'BANCO', label: 'Arquivo do banco', type: 'path', required: true, source: 'fixed' },
            { name: 'DESTINO', label: 'Pasta de destino', type: 'path', required: true, source: 'fixed' },
        ],
    },
    {
        key: 'call-agent',
        label: 'Chamar agente (Claude Code)',
        description: 'Roda o Claude Code com um prompt numa pasta.',
        script: 'cd "$PASTA" && claude -p "$PROMPT"',
        inputs: [
            { name: 'PASTA', label: 'Pasta', type: 'path', required: true, source: 'fixed' },
            { name: 'PROMPT', label: 'Prompt', type: 'textarea', required: true, source: 'fixed' },
        ],
    },
    {
        key: 'notify-phone',
        label: 'Notificar no celular',
        description: 'Manda um aviso (mesma notificação push da seção Notificações). Edite o comando com o seu próprio meio de notificar (ex.: curl para um Apprise/ntfy, ou a ferramenta MCP de um agente).',
        script: '# Exemplo: ntfy.sh, Apprise, ou qualquer webhook de notificação que você já use.\n'
            + 'echo "$TITULO: $MENSAGEM"',
        inputs: [
            { name: 'TITULO', label: 'Título', type: 'text', required: true, source: 'fixed' },
            { name: 'MENSAGEM', label: 'Mensagem', type: 'text', required: true, source: 'fixed' },
        ],
    },
    { key: 'custom', label: 'Personalizado', description: 'Em branco.', script: '', inputs: [] },
];

function list() {
    return PRESETS.map(({ key, label, description }) => ({ key, label, description }));
}

function get(key) {
    return PRESETS.find(p => p.key === key) || null;
}

module.exports = { list, get };
