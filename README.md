# MeuTerminal

Um navegador de sessões para o seu servidor, pensado para o celular: terminais, páginas e
arquivos em abas, iguais em todos os aparelhos. Os terminais continuam rodando no servidor
quando você fecha o app.

- **Terminal**: shell real (xterm.js + node-pty) com barra de atalhos para o celular, gestos,
  comandos rápidos, histórico de copiados e ditado por voz.
- **Navegador**: Chromium rodando no servidor, para ver o projeto em `localhost` sem expor portas.
- **Arquivos**: gerenciador de arquivos do servidor e do Google Drive (rclone): ver, editar,
  enviar, baixar, copiar/mover, buscar, favoritos.
- **Anotações**: notas em Markdown iguais em todos os aparelhos, com busca, tags, fixar, lixeira,
  visualização formatada e salvamento automático.
- **Agentes**: servidor MCP próprio, para o Claude Code (e outros) abrir páginas, pastas e avisos no app.
- **Login**: email e senha, com verificação em duas etapas opcional (app autenticador).
- **PWA**: instala como app no celular.

O guia completo fica no próprio app, em **`/guia`** (menu ⋮ → Guia do app).

## Rodar com Docker

```bash
cp .env.example .env   # preencha AUTH_EMAIL, AUTH_PASSWORD e BASE_URL
docker compose up -d --build
```

Abra `http://localhost:3000`. O `docker-compose.yml` já guarda em volumes a home (`/root`),
as configurações (`./config`) e o banco do app (`./db`), para nada se perder nos deploys.
Veja "Não perder dados" no guia.

Em painéis como o Coolify, use o `docker-compose.yml` do repositório e cadastre as variáveis
do `.env.example` no painel.

## Rodar sem Docker

Requer Node.js 22.13+ e as ferramentas de build do `node-pty`.

```bash
npm install
npm start
```

## Variáveis principais

| Variável | Para quê |
| --- | --- |
| `AUTH_EMAIL` / `AUTH_PASSWORD` | Login |
| `AUTH_TOTP_SECRET` | Verificação em duas etapas (gere com `npm run 2fa`) |
| `BASE_URL` | Endereço onde o app é aberto |
| `SITE_TITLE` | Nome mostrado no app |
| `FILES_HOME` | Pasta onde o gerenciador de arquivos abre |
| `NOTES_ENABLED` | `false` desliga a aba de Anotações (padrão: ligada) |
| `MEUTERMINAL_PIN` | PIN, só quando não há email e senha |

A lista completa está no `.env.example` e no guia.

## Scripts

- `npm start`: inicia o servidor
- `npm run dev`: inicia com recarga automática (nodemon)
- `npm run 2fa`: gera a chave do app autenticador
- `npm run icons`: gera o conjunto de ícones (Lucide) usado pela interface
- `npm run build-tiptap`: gera `public/vendor/tiptap.bundle.js` (editor das Anotações) após mudar `scripts/tiptap-entry.js` ou atualizar algum pacote `@tiptap/*` - o arquivo gerado é commitado

## Licença

GPL-3.0 (veja `LICENSE`). Derivado do projeto DumbTerm, também GPL-3.0, com modificações.
