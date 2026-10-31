# Plano de ação: MCP remoto (agentes de fora usando o servidor)

Status: proposta, nada implementado.
Escopo: permitir que um agente que **não** roda no servidor (ex.: o Claude em claude.ai, como
conector personalizado) use o MeuTerminal como ambiente auxiliar: rodar comandos, ler e escrever
arquivos, baixar coisas com a rede do servidor e acompanhar abas de terminal.

O MCP atual (`/mcp`) continua igual: só loopback + token, para os agentes que rodam dentro dos
terminais. O remoto é um endpoint **novo e separado**, desligado por padrão.

---

## 1. Ponto de partida (o que já existe)

| Peça | Onde está | Aproveitamento |
|---|---|---|
| Servidor MCP (JSON-RPC, Streamable HTTP, respostas JSON) | `scripts/mcp-server.js` (`createMcpHandler`) | Mesmo protocolo. Separar a lista de ferramentas para montar um segundo handler com outro conjunto. |
| Autenticação do MCP local | `mcpAuth` em `server.js`: só loopback, sem `Origin`, Bearer estático | **Não serve** para o remoto: o Claude chama a partir dos servidores da Anthropic, pela internet. |
| Login do app | email + senha, 2FA (`scripts/totp.js`), cookie de sessão | Vira a tela de login/consentimento do OAuth. |
| Sessões de terminal | `scripts/session-manager.js`: `create`, `runCommand`, headless xterm com `SerializeAddon` | Ferramentas de "terminal visível": o agente digita numa aba e lê a tela. |
| Arquivos | `scripts/file-manager.js` (local + rclone/Drive) | `list_dir`, `read_file`, `write_file` reaproveitam a classe, com os mesmos limites (`MAX_TEXT`). |
| Avisos | ferramenta `notify` (tela + push) | Reaproveitar: avisar no celular quando um job longo termina ou quando precisa de aprovação. |
| Banco SQLite | `data/meuterminal.db` | Tabelas novas: clientes OAuth, tokens, log de auditoria, jobs. |
| Modelo de webhooks | `scripts/webhook-*.js`, `/admin` | Referência para token por cliente, CRUD e tela no `/admin`. |

---

## 2. O que o Claude exige de um conector personalizado

- Transporte **Streamable HTTP** (o handler atual já responde assim). SSE também existe, mas pode ser descontinuado.
- Autenticação **OAuth** (com ou sem registro dinâmico de cliente, o DCR) ou **sem autenticação**.
  Token Bearer estático não aparece como opção. Sem autenticação está fora de cogitação aqui.
- Sem DCR, dá para cadastrar no Claude um **client ID + secret** fixos (mais simples de implementar).
- Callback do OAuth: `https://claude.ai/api/mcp/auth_callback`. A Anthropic avisa que pode passar a ser
  um domínio `claude.com`, então aceite os dois.
- URL pública em HTTPS (o `BASE_URL` atual atrás do Coolify/proxy já resolve).
- Disponível nos planos Pro, Max, Team e Enterprise. É adicionado em Configurações → Conectores, e
  depois funciona também no celular.

Fonte: https://support.claude.com/en/articles/11503834

---

## 3. Arquitetura proposta

```
claude.ai ──HTTPS──▶ /mcp/remote ──▶ authRemote (OAuth) ──▶ handler remoto ──▶ worker (usuário/contêiner isolado)
                     /oauth/*       (login + 2FA + tela de consentimento)
```

- Variável `REMOTE_MCP_ENABLED=false` (padrão). Com `false`, as rotas nem são montadas.
- `/mcp/remote` fica fora do login por cookie (como `/mcp` e `/hooks/`) e fora da checagem de
  mesma origem, mas com a sua própria checagem OAuth.
- Requisição sem token ou com token inválido → `401` com
  `WWW-Authenticate: Bearer resource_metadata="<BASE_URL>/.well-known/oauth-protected-resource"`.

### 3.1 OAuth (o app como servidor de autorização)

| Rota | Função |
|---|---|
| `GET /.well-known/oauth-protected-resource` | Diz qual é o servidor de autorização. |
| `GET /.well-known/oauth-authorization-server` | Metadados: endpoints, `code_challenge_methods_supported: ["S256"]`. |
| `POST /oauth/register` | DCR (opcional na 1ª versão: dá para usar client ID/secret do `.env`). |
| `GET /oauth/authorize` | Pede login (email, senha, 2FA) e mostra a tela "Permitir que <cliente> rode comandos neste servidor?". |
| `POST /oauth/token` | Troca o código (com PKCE S256) por access token curto (ex.: 1 h) + refresh token. |

- Guardar só o **hash** dos tokens no SQLite.
- Aceitar somente os `redirect_uri` da lista (claude.ai e claude.com).
- No `/admin`: lista de clientes conectados, último uso e botão **Revogar**.
- Trocar a senha do app revoga todos os tokens (mesmo comportamento do login hoje).

---

## 4. Ferramentas do MCP remoto

### Fase 1: o essencial

| Ferramenta | O que faz | Limites |
|---|---|---|
| `run_command` | Roda `bash -lc "<comando>"` não interativo e devolve stdout, stderr, código de saída e duração. | Timeout padrão 120 s (máx. 600 s); saída cortada (ex.: 30 KB, mantendo começo e fim, com aviso). |
| `list_dir` | Lista uma pasta do workspace. | `MAX_ENTRIES`. |
| `read_file` | Lê texto, com `offset`/`limit` de linhas. | `MAX_TEXT`. |
| `write_file` | Cria ou substitui um arquivo de texto. | Só dentro do workspace. |
| `server_info` | SO, CPU, RAM, GPU (`nvidia-smi`), disco livre, ferramentas instaladas. | Para o agente saber onde está. |

### Fase 2: trabalhos longos e terminal visível

| Ferramenta | O que faz |
|---|---|
| `start_job` / `job_status` / `job_output` / `job_kill` | Comandos longos (build, download de modelo, render) em segundo plano, sem segurar a requisição HTTP. Saída gravada em arquivo. Ao terminar, `notify` opcional no celular. |
| `terminal_open` | Cria uma aba de terminal com nome (ex.: "Claude · build"), visível no app. |
| `terminal_send` | Digita numa aba (`sessions.runCommand`). |
| `terminal_read` | Lê as últimas N linhas da tela (headless xterm). |
| `notify` | A mesma do MCP local. |

A vantagem do terminal visível: você abre o app no celular e vê, ao vivo, o que o agente está fazendo.

### Fase 3: transferência de arquivos

- Arquivos pequenos: `read_file_base64` / `write_file_base64` (limite baixo, ex.: 2 MB).
- Arquivos grandes: não passar pela conversa. Opções:
  - o servidor faz `git push` para um repositório/branch, e o agente clona do outro lado;
  - um link de download temporário assinado (`/dl/<token>`, expira em minutos).

---

## 5. Segurança (o ponto mais importante)

Um endpoint público que executa comandos dá acesso total ao servidor para quem tiver o token.

1. **Isolar a execução.** Não rodar como `root` no contêiner do app (que tem `/root`, o banco e o
   `.env`). Opções, da mais simples à mais forte:
   - usuário Linux dedicado (`runuser -u mt-agent`) com workspace próprio (ex.: `/work`), sem permissão
     de leitura em `data/` e na home do root;
   - **contêiner separado** (`meuterminal-worker` no `docker-compose.yml`) com só `/work` montado;
     o app chama o worker por um socket interno. Recomendado.
2. **Limpar o ambiente dos processos filhos.** Não repassar `AUTH_PASSWORD`, `AUTH_TOTP_SECRET`,
   `VERCEL_TOKEN`, `WEBHOOK_SECRET_KEY`, `MEUTERMINAL_MCP_TOKEN` etc. Usar uma lista de variáveis
   permitidas, não de proibidas.
3. **Auditoria.** Tabela `mcp_audit` (data, cliente, ferramenta, argumentos, código de saída, duração),
   visível no `/admin`.
4. **Botão de emergência.** No `/admin`, um interruptor "MCP remoto: desligado" que corta na hora,
   além de revogar clientes.
5. **Limites.** Rate limit por cliente; número máximo de jobs simultâneos; timeout duro.
6. **Aprovação opcional** para comandos perigosos (`rm -rf`, `sudo`, mexer em `.env`): push no celular
   com Aprovar/Recusar antes de rodar. Avaliar se `public/agent/risk.js` já classifica isso e pode
   ser reaproveitado.
7. **Restringir quem chama (opcional).** Liberar só os IPs de saída da Anthropic (lista publicada
   pela Anthropic) no proxy ou firewall.

---

## 6. Ordem de entrega

1. Separar `TOOLS` e `createMcpTools` em conjuntos (local e remoto), sem mudar o comportamento do `/mcp`.
2. OAuth mínimo: metadados, `authorize` com login + 2FA + consentimento, `token` com PKCE, client
   ID/secret pelo `.env`. Testes em `tests/`.
3. Worker isolado + `run_command`, `list_dir`, `read_file`, `write_file`, `server_info` + auditoria.
4. Testar com o MCP Inspector e depois conectar no claude.ai (Configurações → Conectores).
5. Fase 2 (jobs, terminal visível, notify).
6. `/admin`: clientes, revogar, auditoria, interruptor.
7. DCR, transferência de arquivos, aprovação por push.

---

## 7. Decisões em aberto

- **DCR ou client ID/secret fixo?** Fixo é mais rápido; DCR deixa conectar sem mexer no `.env`.
- **Usuário dedicado ou contêiner worker?** O contêiner é mais seguro; o usuário é mais simples.
- **Workspace persistente?** Guardar `/work` num volume (as ferramentas instaladas sobrevivem aos
  deploys, como a home hoje) ou limpar periodicamente.
- **Limite de saída das ferramentas:** o tamanho que cabe bem numa resposta para o agente ainda
  precisa ser calibrado nos testes.
