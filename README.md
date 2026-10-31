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
| `ALLOW_NO_LOGIN` | `true` permite subir sem login nenhum (sem ele, o app se recusa a subir desprotegido) |
| `WEBHOOKS_ENABLED` | `true` liga a aba Webhooks em Configurações (padrão: desligada) |
| `VERCEL_TOKEN` | Publicar projetos de vibecoding na Vercel com um clique |
| `REMOTE_MCP_ENABLED` | `true` liga a Ponte com o Claude (padrão: desligada) |

## Ponte com o Claude

Deixa o Claude do claude.ai (chat e app do celular) usar este servidor como extensão do ambiente
dele: rodar comandos e programas instalados aqui, instalar pacotes, baixar arquivos, ler e gravar
arquivos (inclusive Google Drive via rclone), salvar anotações, abrir páginas no Chromium e ver o
screenshot, rodar jobs longos e mandar push no celular.

1. Com login por email e senha (de preferência com 2FA), defina `REMOTE_MCP_ENABLED=true` e reinicie.
2. No claude.ai: Configurações → Conectores → Adicionar conector personalizado, com a URL que aparece
   em `/admin` → Ponte com o Claude (`<BASE_URL>/mcp/remote`).
3. Ao conectar, o MeuTerminal pede email, senha e o código do autenticador.

Comandos arriscados pedem aprovação no celular (push com Aprovar/Recusar); tudo fica na auditoria do
`/admin`, onde também dá para desligar a ponte na hora e revogar clientes. Detalhes e as outras
variáveis (`REMOTE_MCP_*`): `.env.example` e `docs/PLANO-MCP-REMOTO.md`.

A lista completa está no `.env.example` e no guia.

## Scripts

- `npm start`: inicia o servidor
- `npm run dev`: inicia com recarga automática (nodemon)
- `npm run 2fa`: gera a chave do app autenticador
- `npm run icons`: gera o conjunto de ícones (Lucide) usado pela interface
- `npm run build-tiptap`: gera `public/vendor/tiptap.bundle.js` (editor das Anotações) após mudar `scripts/tiptap-entry.js` ou atualizar algum pacote `@tiptap/*` - o arquivo gerado é commitado

## Licença

GPL-3.0 (veja `LICENSE`). Derivado do projeto DumbTerm, também GPL-3.0, com modificações.
