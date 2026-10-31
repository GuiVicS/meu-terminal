# Plano de ação: ponte MCP entre o Claude (claude.ai) e o MeuTerminal

Status: **fases 0 a 3 implementadas** (v2.8.0). Ver "O que foi feito" no fim da seção 7.

Objetivo: o Claude do claude.ai (chat, app do celular) usar o servidor do MeuTerminal como uma
**extensão do próprio ambiente**. O ambiente do Claude tem a rede bloqueada (sem npm, pip, apt,
Hugging Face) e não guarda nada entre conversas; o servidor tem rede livre, os programas
instalados e disco persistente. Exemplos do que passa a ser possível numa conversa:

- pesquisar na web e **salvar o resultado lá** (arquivo, Anotação, Google Drive via rclone);
- **instalar e rodar** o que o ambiente do Claude não consegue (npm, pip, Docker, modelos);
- subir um projeto, **abrir no Chromium do servidor e ver o screenshot**;
- deixar um processo longo rodando e **receber push no celular** quando terminar.

O MCP atual (`/mcp`) continua igual: só loopback + token, para os agentes que rodam dentro dos
terminais. A ponte é um endpoint **novo e separado** (`/mcp/remote`), desligado por padrão.

---

## 1. Viabilidade

**Alta.** Quase tudo de que a ponte precisa já existe e está bem feito; o que falta é a porta de
entrada (OAuth) e uma camada fina de ferramentas.

| Precisa de | Já existe | Situação |
|---|---|---|
| Protocolo MCP (JSON-RPC, Streamable HTTP) | `scripts/mcp-server.js` → `createMcpHandler` | Pronto. Só falta separar "protocolo" de "lista de ferramentas". |
| Rodar comando com timeout, saída limitada e segredos mascarados | `scripts/webhook-runner.js` → `WebhookRunner.execute` (env limpo, `detached` + kill do grupo, 64 KB, `mask()`) | Excelente base. Extrair um `ProcessRunner` genérico. |
| Ler, escrever, buscar, enviar e baixar arquivos (local + Google Drive) | `scripts/file-manager.js` → `FileManager` (`readText`, `writeText`, `list`, `search`, `upload`, `send`, rclone) | Pronto. Falta um modo "raiz restrita" opcional. |
| Salvar pesquisas onde você lê no celular | `scripts/notes-store.js` (`.md` por nota) + `notesChanged()` (avisa os aparelhos) | Pronto: vira `save_note`. |
| Ver páginas renderizadas | `BrowserManager.screenshot` / `readText` + ferramentas `open_url`, `screenshot`, `read_page` | Pronto: o screenshot já volta como imagem MCP. |
| Avisar no celular | ferramenta `notify` + `PushNotifier` | Pronto. |
| Terminal visível ao vivo | `SessionManager` (`create`, `runCommand`, headless xterm com `SerializeAddon`) | Pronto: falta só ler a tela pelo MCP. |
| Login forte | email + senha + TOTP, lockout, `requireReauth` (step-up de 5 min) | Pronto: vira a tela de autorização do OAuth. |
| Classificar comandos perigosos | `public/agent/risk.js` (`rm -rf`, `sudo`, `curl \| sh`, force push...) | Pronto (hoje no front). Mover/compartilhar com o servidor. |
| Testes | `node --test`, CI em `.github/workflows/tests.yml` | Pronto: mesmo padrão para os novos módulos. |
| **OAuth 2.1 (exigido pelo claude.ai)** | — | **Novo.** É a maior parte do trabalho. |
| **Jobs em segundo plano** | parcial (fila do `WebhookRunner`, tabela de runs) | **Novo**, copiando o modelo dos webhooks. |
| **Auditoria da ponte** | parcial (`webhook_runs`) | **Novo**, mesmo modelo. |

### O que o claude.ai exige de um conector personalizado

- Transporte **Streamable HTTP** (o handler atual já responde JSON puro, permitido pela especificação).
- Autenticação **OAuth** (com ou sem registro dinâmico de cliente, o DCR) ou nenhuma. Token Bearer
  estático, como o do `/mcp`, não está entre as opções. Sem DCR, dá para cadastrar no Claude um
  **client ID + secret** fixos.
- Callback: `https://claude.ai/api/mcp/auth_callback` (a Anthropic avisa que pode passar a ser um
  domínio `claude.com`; aceitar os dois).
- URL pública em HTTPS (o `BASE_URL` atrás do Coolify já resolve).
- Planos Pro, Max, Team ou Enterprise; adicionado em Configurações → Conectores, e depois funciona
  também no app do celular.

Fonte: https://support.claude.com/en/articles/11503834

---

## 2. Problemas encontrados no código (corrigir antes ou junto)

Em ordem de importância para a ponte.

### 2.1 Segredos do app vazam para todo processo filho
`spawnShell` (`server.js`, ~linha 1892) passa `...process.env` para cada terminal, e o
`AgentGateway` recebe `env: { ...process.env, ... }` (~linha 851). Resultado: `AUTH_PASSWORD`,
`AUTH_TOTP_SECRET`, `VERCEL_TOKEN` e `WEBHOOK_SECRET_KEY` aparecem num simples `env` em qualquer
terminal e em qualquer agente. Hoje o risco é contido (quem tem terminal já é root), mas com a
ponte **qualquer saída de comando vai para uma conversa fora do servidor**.
**Correção:** uma função `childEnv()` com lista de variáveis do app que nunca descem
(`AUTH_*`, `MEUTERMINAL_PIN`, `WEBHOOK_SECRET_KEY`, `VERCEL_TOKEN`...), usada em `spawnShell`, no
gateway e no runner da ponte. Na ponte, além disso, mascarar esses valores na saída (`mask()`).

### 2.2 Rotas públicas casadas por prefixo
O middleware global libera qualquer caminho que **comece** com um item de `publicPaths`
(`req.path.startsWith(path)`, ~linha 369). Com `'/mcp'` na lista, `/mcp/remote`, `/mcpqualquer`
etc. também pulam o login. Hoje não há rota assim, mas a ponte criaria uma.
**Correção:** comparar caminho exato (ou prefixo com `/` no fim, como já é `'/assets/'`) e listar
`/mcp/remote`, `/oauth/*` e `/.well-known/*` explicitamente, cada uma com a sua própria checagem.
O mesmo vale para a isenção da checagem de origem (~linha 340), que hoje só conhece `/mcp`.

### 2.3 PIN padrão `1234` e PIN em texto no cookie
`docker-compose.yml` (linha 29) usa `MEUTERMINAL_PIN: ${MEUTERMINAL_PIN:-1234}`: quem sobe sem
configurar email e senha fica protegido por `1234`. E no modo PIN o cookie guarda o próprio PIN
(`res.cookie(..._PIN, pin)`, ~linha 652).
**Correção:** padrão vazio no compose (ou recusar subir sem login). Para a ponte: **só ligar com
email + senha**, e de preferência com 2FA; com PIN ou sem login, `/mcp/remote` nem é montado.

### 2.4 `server.js` com 2.128 linhas
Ainda legível (bons comentários), mas a ponte acrescentaria umas 600 linhas. Hoje o arquivo mistura
auth, sessões, arquivos, agentes, vibecoding, push, notas, backup, webhooks e WebSocket.
**Correção (incremental, sem mudar comportamento):** mover cada bloco para `routes/<area>.js`
exportando `register(app, ctx)`, onde `ctx` reúne `sessions`, `files`, `notes`, `notifier`,
`requireReauth` etc. Começar pelos blocos que a ponte toca: auth e MCP.

### 2.5 Código morto
`requirePin` (~linha 258) usa `COOKIE_NAME`, `isValidPin` e `secureCompare`, que não existem, e
não é usado em lugar nenhum. Remover.

### 2.6 Sem testes de autenticação
Há bons testes de notas, webhooks, backup e agentes, mas nenhum de login, cookie assinado, lockout
ou da checagem de origem. O OAuth vai mexer exatamente aí.
**Correção:** extrair as funções puras (`signToken`, `verifyAuthToken`, `isSameOrigin`, lockout)
para `scripts/auth.js` e testar com `node --test`.

---

## 3. Decisão central: em que ambiente os comandos da ponte rodam

O objetivo é usar **os programas que já estão no servidor**. Hoje tudo roda como `root` no
contêiner, e as ferramentas instaladas pelo usuário ficam em `/root` (`NPM_CONFIG_PREFIX=/root/.npm-global`,
`~/.local/bin`), que outro usuário não lê. Isso cria um conflito real entre utilidade e isolamento:

| Modo | Como | Utilidade | Risco |
|---|---|---|---|
| **A. Mesmo ambiente do terminal** | Comandos como root, mesma home, mesmas ferramentas. | Total: é exatamente o que você tem no terminal. | Igual ao do seu login: quem tiver o token manda no contêiner. |
| **B. Usuário dedicado** | Usuário `claude` com home própria; ferramentas globais em `/usr/local`. | Parcial: o que você instalou em `/root` não aparece. | Menor: não lê o banco, o `.env` nem a sua home. |
| **C. Contêiner worker** | Outro contêiner no compose, com só `/work` montado; o app chama por socket interno. | Parcial, mas com controle fino (CPU, RAM, rede). | O menor. |

**Recomendação para uso pessoal:** começar no **modo A**, porque é o único que cumpre o objetivo
("ter os programas de lá"), com as proteções da seção 5 obrigatórias. Deixar o modo configurável
(`REMOTE_MCP_RUN_AS=root|<usuário>`) para poder endurecer depois sem reescrever nada. O modo C fica
para quando o MeuTerminal virar produto para outras pessoas.

Pasta de trabalho padrão da ponte: `~/claude` (configurável, `REMOTE_MCP_WORKDIR`), para o que o
Claude cria não se misturar com os seus projetos.

---

## 4. Arquitetura proposta

```
claude.ai ──HTTPS──▶ Caddy/Coolify ──▶ MeuTerminal
                                         ├─ /.well-known/oauth-*      metadados (públicos)
                                         ├─ /oauth/authorize          login + 2FA + "Permitir?"
                                         ├─ /oauth/token              código → tokens (PKCE)
                                         └─ /mcp/remote ─ remoteAuth ─ handler MCP (ferramentas remotas)
                                                                         ├─ ProcessRunner (comandos e jobs)
                                                                         ├─ FileManager (arquivos, Drive)
                                                                         ├─ NotesStore (anotações)
                                                                         ├─ BrowserManager (prévia, screenshot)
                                                                         ├─ SessionManager (terminal visível)
                                                                         └─ PushNotifier (avisos)
                                                                       auditoria em SQLite
```

### 4.1 Arquivos novos e alterados

| Arquivo | O que é |
|---|---|
| `scripts/mcp-protocol.js` | O JSON-RPC que hoje está dentro de `createMcpHandler`, recebendo `{ tools, impl, instructions, serverInfo }`. Usado pelos dois endpoints. |
| `scripts/mcp-server.js` | Fica só com as ferramentas locais (sem mudar comportamento). |
| `scripts/process-runner.js` | Extraído do `WebhookRunner.execute`: spawn com env limpo, grupo de processos, timeout, saída limitada, `mask()`. O `WebhookRunner` passa a usá-lo. |
| `scripts/remote/oauth.js` | Servidor OAuth: metadados, authorize, token, refresh, revogação. Tabelas no mesmo SQLite. |
| `scripts/remote/tools.js` | Ferramentas da ponte (seção 6). |
| `scripts/remote/jobs.js` | Jobs em segundo plano: saída em arquivo, status no SQLite. |
| `scripts/remote/audit.js` | Registro de cada chamada. |
| `scripts/auth.js` | Funções de login extraídas do `server.js` (testáveis). |
| `routes/remote.js` | Monta tudo acima no Express, só se `REMOTE_MCP_ENABLED=true`. |
| `public/admin/remote.js` | Página "Ponte com o Claude" no `/admin`. |
| `tests/remote-*.test.js` | Testes do OAuth, das ferramentas e do runner. |

Sem dependências novas: `node:crypto` cobre PKCE e tokens, e `node:sqlite` já é usado. (Alternativa:
o SDK oficial de MCP em TypeScript tem peças de servidor OAuth; avaliar se compensa trazer a
dependência só para isso. O projeto hoje evita dependências e o JSON-RPC já foi feito à mão.)

### 4.2 OAuth em detalhe

| Rota | Função |
|---|---|
| `GET /.well-known/oauth-protected-resource` | Aponta o servidor de autorização (o próprio app). |
| `GET /.well-known/oauth-authorization-server` | Endpoints, `response_types: ["code"]`, `code_challenge_methods_supported: ["S256"]`, `grant_types: ["authorization_code", "refresh_token"]`. |
| `POST /oauth/register` | DCR. Fase 2; na fase 1, client ID/secret do `.env`. |
| `GET /oauth/authorize` | Sem sessão → manda para `/login` e volta. Com sessão → exige step-up (`requireReauth`: senha + 2FA, mesmo das ações sensíveis dos webhooks) e mostra "Permitir que o Claude rode comandos neste servidor?". |
| `POST /oauth/token` | Código (uso único, 60 s, PKCE S256) → access token (1 h) + refresh token (30 dias, rotativo). |

- `redirect_uri` só da lista permitida (claude.ai e claude.com).
- No banco, só o **hash** dos tokens, mais a "impressão" do `TOKEN_KEY` atual: trocar a senha ou o
  2FA invalida todos os tokens da ponte, igual ao login de hoje.
- Sem token ou token inválido em `/mcp/remote` → `401` com
  `WWW-Authenticate: Bearer resource_metadata="<BASE_URL>/.well-known/oauth-protected-resource"`.
- Lockout próprio para `/oauth/*` (mesmo formato de `webhookAuthAttempts`).

---

## 5. Segurança da ponte (obrigatório no modo A)

1. **Liga só com email + senha** (seção 2.3), de preferência com 2FA; consentimento com step-up.
2. **Env limpo** nos comandos da ponte e **mascaramento** dos segredos do app na saída (2.1).
3. **Auditoria**: tabela `remote_audit` (quando, cliente, ferramenta, argumentos, código de saída,
   duração, bytes de saída), visível no `/admin`.
4. **Interruptor** no `/admin` ("Ponte com o Claude: ligada/desligada") que corta na hora, sem
   precisar de deploy, e **revogar** clientes.
5. **Aprovação por push** para comandos que o `risk.js` marca como perigosos: a ferramenta responde
   "aguardando aprovação", o celular recebe o push com Aprovar/Recusar e o Claude consulta de novo.
   Configurável: `sempre`, `só perigosos` (padrão) ou `nunca`.
6. **Limites**: timeout padrão 120 s (máx. 600 s) para `run_command`; jobs para o resto; saída
   cortada mantendo começo e fim; máximo de jobs simultâneos; rate limit por cliente.
7. **Pasta de trabalho padrão** `~/claude`; caminhos fora dela permitidos no modo A, mas registrados.

---

## 6. Ferramentas da ponte

### Fase 1: o essencial ("pesquisar aqui e salvar lá", "rodar o que eu não consigo")

| Ferramenta | Reaproveita | O que faz |
|---|---|---|
| `run_command` | `ProcessRunner` | `bash -lc` não interativo; devolve saída, código de saída e duração. |
| `read_file` / `write_file` / `list_dir` / `search_files` | `FileManager` | Arquivos do servidor **e dos remotes do rclone** (Google Drive). |
| `save_note` / `search_notes` / `read_note` | `NotesStore` + `notesChanged()` | O que o Claude pesquisa aparece na aba Anotações do celular. |
| `server_info` | — | SO, CPU, RAM, GPU (`nvidia-smi`), disco, ferramentas instaladas, pasta de trabalho. |
| `notify` | já existe | Push no celular. |

### Fase 2: trabalho longo, prévia e terminal ao vivo

| Ferramenta | Reaproveita | O que faz |
|---|---|---|
| `start_job` / `job_status` / `job_output` / `job_kill` | `ProcessRunner` + modelo de `webhook_runs` | Instalações, builds, downloads de modelos sem travar a conversa; push opcional ao terminar. |
| `fetch_url` | `ProcessRunner` (curl) | O servidor baixa direto da internet para uma pasta. |
| `open_url` / `screenshot` / `read_page` | já existem | O Claude abre o projeto no Chromium do servidor e **vê a imagem**. |
| `terminal_open` / `terminal_send` / `terminal_read` | `SessionManager` + headless xterm | Uma aba "Claude" visível no app: você assiste ao vivo. |

### Fase 3: transferência e conforto

| Ferramenta | O que faz |
|---|---|
| `share_link` | Link temporário assinado (`/dl/<token>`, expira em minutos) para baixar um arquivo do servidor, usando `files.send`. |
| `upload_base64` | Arquivos pequenos do ambiente do Claude para o servidor (limite baixo, ex.: 2 MB). |
| DCR | Conectar sem mexer no `.env`. |

Regras gerais das respostas: texto curto e estruturado (JSON), saída longa cortada com aviso e
dica de como ler o resto (`job_output` com offset, `read_file` com linhas).

---

## 7. Ordem de entrega

**Fase 0: preparação (melhora o app mesmo sem a ponte)**
1. `childEnv()` em `spawnShell` e no gateway (2.1).
2. `publicPaths` com casamento exato (2.2); remover `requirePin` (2.5).
3. Compose sem PIN padrão (2.3).
4. `scripts/auth.js` + testes (2.6).
5. Extrair `scripts/mcp-protocol.js` e `scripts/process-runner.js` (o `WebhookRunner` passa a usar; os testes atuais dele garantem que nada mudou).

**Fase 1: ponte mínima**
6. `scripts/remote/oauth.js` com client fixo + testes (PKCE, expiração, uso único, revogação).
7. `routes/remote.js` + ferramentas da fase 1 + auditoria + interruptor.
8. Testar com o MCP Inspector; depois adicionar no claude.ai em Configurações → Conectores.

**Fase 2:** jobs, `fetch_url`, ferramentas de navegador e terminal visível; aprovação por push.

**Fase 3:** `share_link`, `upload_base64`, DCR, página completa no `/admin`.

Em paralelo, quando convier: quebrar o resto do `server.js` em `routes/` (2.4).

### Fase 0: o que foi feito

- `scripts/child-env.js`: terminais e agentes recebem o ambiente sem `AUTH_*`, `MEUTERMINAL_PIN`,
  `WEBHOOK_SECRET_KEY` e `VERCEL_TOKEN` (conferido num terminal aberto de verdade).
- `scripts/auth.js`: token de login, comparações, limitador de tentativas (login e webhooks),
  checagem de origem e `isPublicPath` (exato, ou prefixo só para itens terminados em `/`).
  Cookies de login existentes continuam válidos (mesma chave e formato; há teste disso).
- `/login/pair` passou a constar explicitamente da lista pública; `/login.html`, `/mcp/remote`,
  `/mcpqualquer` agora pedem login.
- `requirePin` removido.
- Compose sem PIN padrão. Como PIN vazio + sem email deixaria o app aberto, o servidor agora
  **se recusa a subir sem login**, a não ser com `ALLOW_NO_LOGIN=true` (o modo demo não é afetado).
- `scripts/process-runner.js` (usado pelo `WebhookRunner`) e `scripts/mcp-protocol.js` (usado pelo
  `/mcp`), prontos para a ponte reaproveitar.
- Testes novos: `auth`, `child-env`, `process-runner`, `mcp-protocol`.

### Fases 1 a 3: o que foi feito

Decisões da seção 9 confirmadas: modo **A** (configurável com `REMOTE_MCP_RUN_AS`), aprovação
**só perigosos** (padrão; muda no `/admin`), OAuth **à mão**, sem dependências novas.

- `routes/remote.js` monta tudo só com `REMOTE_MCP_ENABLED=true` **e** login por email; com PIN,
  sem login ou no modo demo a ponte não liga (e as rotas nem existem).
- `scripts/remote/oauth.js`: metadados (RFC 8414 / 9728), código de uso único (60 s) com PKCE S256,
  access token de 1 h, refresh de 30 dias que **roda** a cada uso (reuso de um refresh antigo revoga a
  autorização inteira), revogação (RFC 7009), cliente fixo do `.env` e **DCR**. Só hashes no banco;
  trocar senha/2FA invalida tudo.
- `scripts/remote/tools.js`: as ferramentas das fases 1, 2 e 3 (seção 6). As de terminal só existem
  quando os comandos rodam como o usuário do servidor, e `terminal_send/read` só mexem em abas abertas
  pela própria ponte.
- `scripts/remote/approvals.js`: aprovação presa ao comando exato (hash de ferramenta + argumentos),
  uso único, expira em 10 min. Push com botões Aprovar/Recusar (service worker) e lista no `/admin`.
  A chamada espera até ~40 s pela resposta antes de devolver "aguardando aprovação".
- `scripts/remote/jobs.js`, `audit.js`, `exec.js`, `shares.js`, `risk.js` (reaproveita
  `public/agent/risk.js` + padrões só da ponte: credenciais, docker rm, firewall, rclone delete...).
- `/admin` → Ponte com o Claude: interruptor, modo de aprovação, como conectar, aprovações pendentes,
  clientes (revogar / desconectar todos), jobs (saída, encerrar) e auditoria. Ligar a ponte ou
  afrouxar a aprovação pede a senha de novo (step-up).

Diferenças em relação ao texto do plano:
- **Consentimento pede email + senha (+ 2FA) na própria página**, em vez de depender da sessão: o
  cookie de login é `SameSite=Strict` e não chega quando o claude.ai redireciona para cá. Na prática é
  o mesmo step-up previsto.
- **DCR ligado por padrão** (`REMOTE_MCP_DCR=false` desliga): registrar um cliente não dá acesso a
  nada sem passar pelo consentimento, e os `redirect_uri` ficam presos ao claude.ai/claude.com
  (mais `REMOTE_MCP_REDIRECT_URIS`, para o MCP Inspector).
- Aprovações pendentes e links de `share_link` ficam em memória: um reinício só significa pedir de novo.
- 2.4 só começou: a ponte já nasceu em `routes/remote.js`; o resto do `server.js` continua lá.
- De brinde: a seção "Agentes" aparecia em todas as páginas do `/admin` (o fetch dela reexibia a
  seção por cima do roteamento). Corrigido.

Estimativa de tamanho: fase 0 ~300 linhas (boa parte é mover código), fase 1 ~800 linhas com
testes, fase 2 ~600 linhas.

---

## 8. Limites que continuam existindo

- Cada chamada é uma ida e volta pela internet: bom para tarefas, ruim para dezenas de comandos
  minúsculos em sequência (melhor mandar um script só).
- O que a ferramenta devolve precisa ser curto; logs grandes vão para arquivo ou job.
- Os dois ambientes continuam separados: o caminho natural é fazer o trabalho **no servidor**
  (ele baixa, instala, gera), não transferir arquivos grandes entre os dois.
- O app do Claude pode pedir sua confirmação antes de usar ferramentas do conector.
- Para programar por horas num projeto, o Claude Code rodando **dentro** do MeuTerminal continua
  melhor; a ponte é para o chat do claude.ai.

---

## 9. Decisões em aberto

- **Modo de execução:** A (root, recomendado para uso pessoal), B ou C.
- **Aprovação:** `só perigosos` (recomendado), `sempre` ou `nunca`.
- **DCR já na fase 1** ou client fixo primeiro (recomendado: fixo).
- **OAuth à mão ou com o SDK oficial de MCP** (recomendado: à mão, seguindo o estilo do projeto).
