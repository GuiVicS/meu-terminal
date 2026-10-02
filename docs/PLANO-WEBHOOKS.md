# Plano de ação: Webhooks e tela administrativa (/admin)

Status: proposta revisada (token, CRUD, modelos de ação, inputs), nada implementado.
Escopo: dois pedidos que se complementam.

1. Configurar **webhooks** que disparam comandos no terminal.
2. Transformar o popup de **Configurações** numa tela administrativa em **`/admin`**, com as opções organizadas.

Os webhooks entram como uma seção do `/admin`, então a ordem de entrega é: primeiro a base do `/admin`, depois os webhooks.

---

## 1. Ponto de partida (o que já existe)

| Peça | Onde está | Aproveitamento |
|---|---|---|
| Popup de configurações | `public/ui/dialogs.js` (`createSettingsDialog`) e `public/managers/settings.js` | Seções atuais: Comandos rápidos, Terminal, Interface, Sessão, Conectar outro aparelho, Notificações, Modo UI dos agentes. Viram as páginas do `/admin`. |
| Comandos rápidos | `scripts/command-store.js`, rotas `/api/commands` | Modelo de store em SQLite que o webhook pode copiar. |
| Banco SQLite | `data/meuterminal.db`, conexão aberta pelo `SessionStore` | Nova tabela para os webhooks, mesma conexão. |
| Sessões de terminal | `scripts/session-manager.js`, `POST /api/sessions`, `pty.write` | É por aqui que o webhook escreve no terminal. |
| Autenticação do MCP | `mcpAuth` em `server.js`: token Bearer, só loopback, sem `Origin` | Referência para o token do webhook. O webhook externo não pode ser só loopback. |
| Login normal | cookie de sessão, `/login`, PIN, 2FA | O `/admin` fica atrás dele. |

---

## 2. Parte A: tela `/admin`

### Objetivo
Trocar o popup por uma página inteira, com navegação lateral, que funcione bem no celular.

### Estrutura proposta

```
/admin                  → visão geral (status do servidor, atalhos)
/admin/terminal         → fonte, cursor, scrollback, atalhos
/admin/interface        → tema, barra de atalhos, densidade
/admin/comandos         → comandos rápidos (hoje em "Comandos rápidos")
/admin/sessoes          → sessões abertas, ordem, recentes, reinício
/admin/aparelhos        → conectar outro aparelho (pareamento)
/admin/notificacoes     → push, sons
/admin/agentes          → modo UI dos agentes, preferências
/admin/webhooks         → NOVO (Parte B)
/admin/seguranca        → PIN, 2FA, tokens (MCP e webhooks), sessões de login
```

### Passos
1. **Rota e casca.** `GET /admin` e `GET /admin/*` no `server.js`, protegidas pelo mesmo login. Sem sessão, redireciona para `/login?next=/admin`. Serve `public/admin/index.html`.
2. **Módulos por seção.** Cada seção do popup vira um módulo em `public/admin/sections/*.js`. Mover a lógica de `dialogs.js` sem reescrever, para não quebrar o que funciona.
3. **Navegação.** Menu lateral no desktop e menu recolhível no celular. A URL reflete a seção, então dá para abrir direto `/admin/webhooks`.
4. **Estado compartilhado.** Reaproveitar `SettingsManager` e `appConfig`, para que alterar no `/admin` reflita no app principal (evento `onChange` já existe).
5. **Ponto de entrada.** O item "Configurações" e o atalho `Ctrl+,` passam a abrir `/admin` (nova aba). Manter o popup por uma versão com aviso, depois remover.
6. **Permissões.** Seções sensíveis (segurança, webhooks) pedem o PIN de novo, usando o mecanismo `verify-pin` que já existe.

### Critérios de pronto
- Todas as opções do popup atual existem no `/admin`, sem perder nenhuma.
- Funciona em tela de 360 px e no desktop.
- `NOTES_ENABLED`, `FILES_ENABLED` e `browserAvailable` continuam escondendo o que estiver desligado.

---

## 3. Parte B: Webhooks (CRUD de ações executáveis)

### A ideia em uma frase
Um **webhook é uma ação nomeada**: um script bash, com **entradas declaradas** (inputs), que roda no servidor quando alguém chama a URL dele com um **token** válido, ou quando o usuário clica em **Executar** no `/admin`.

```
  quem chama (GitHub, n8n, celular, curl)      /admin/webhooks
            │ POST /hooks/<slug>                       │ botão "Executar" (formulário dos inputs)
            │ Authorization: Bearer mtwh_…             │
            ▼                                          ▼
     autentica → valida inputs → enfileira → roda o script (bash) com os inputs como variáveis
                                                   │
                                     histórico (saída, código de saída, duração)
```

### 3.1 CRUD na tela `/admin/webhooks`

**Lista:** nome, ativo/inativo, última execução (status e quando), botões Executar, Editar, Duplicar e Excluir.

**Editor de um webhook**, em abas:

| Aba | O que tem |
|---|---|
| **Geral** | Nome, slug da URL (`/hooks/deploy-site`), descrição, ativo/inativo. |
| **Ação** | Escolher uma **sugestão** (modelo pronto) ou **Personalizado**. Editor de script bash com destaque de sintaxe, chips das variáveis disponíveis (clicar insere `$NOME`), pasta de trabalho (`cwd`) e tempo limite. |
| **Inputs** | Lista das entradas do webhook (ver 3.3). Cada input vira uma variável do script. |
| **Execução** | Onde roda (segundo plano ou aba visível), fila/concorrência, limite de disparos. |
| **Acesso** | Tokens (criar, ver prefixo, revogar), modo de autenticação, IPs permitidos. |
| **Testar** | Formulário com os inputs, **pré-visualização** do que vai rodar e botão **Executar agora**, com a saída ao vivo. |
| **Histórico** | Últimas execuções: quando, origem (IP ou "manual"), inputs recebidos, código de saída, duração, saída (truncada). Botão **Repetir**. |

### 3.2 Sugestões (modelos de ação)

Ao criar, o usuário escolhe um modelo, que já vem com o script e os inputs preenchidos, e pode editar tudo depois. Ou começa em branco com **Personalizado**.

| Modelo | Script (resumido) | Inputs que já vêm |
|---|---|---|
| **Atualizar repositório** | `cd "$PASTA" && git fetch && git checkout "$BRANCH" && git pull --ff-only` | `PASTA` (caminho), `BRANCH` (padrão `main`) |
| **Deploy com Docker Compose** | `cd "$PASTA" && git pull --ff-only && docker compose up -d --build` | `PASTA` |
| **Rodar script npm** | `cd "$PASTA" && npm run "$SCRIPT"` | `PASTA`, `SCRIPT` (lista: build, test…) |
| **Reiniciar serviço** | `systemctl restart "$SERVICO"` ou `pm2 restart "$SERVICO"` | `SERVICO` (lista) |
| **Backup do banco** | `sqlite3 "$BANCO" ".backup '$DESTINO/backup-$(date +%F-%H%M).db'"` | `BANCO`, `DESTINO` |
| **Chamar agente (Claude Code)** | `cd "$PASTA" && claude -p "$PROMPT"` | `PASTA`, `PROMPT` (texto longo) |
| **Notificar no celular** | chama a ferramenta `notify` do MeuTerminal com `$TITULO` e `$MENSAGEM` | `TITULO`, `MENSAGEM` |
| **Personalizado** | em branco | nenhum |

Os modelos ficam num arquivo (`scripts/webhook-presets.js`), fácil de ampliar.

### 3.3 Inputs (as variáveis do webhook)

Cada webhook declara as entradas que aceita. Uma entrada tem:

| Campo | Exemplo | Para quê |
|---|---|---|
| `name` | `BRANCH` | Nome da variável no script (`$BRANCH`). Só `A-Z`, `0-9`, `_`. |
| `label` | "Branch" | Rótulo no formulário. |
| `type` | `text`, `number`, `boolean`, `select`, `path`, `textarea`, `secret` | Validação e tipo do campo no formulário. |
| `required` / `default` | `true` / `main` | Se falta e tem padrão, usa o padrão. Se falta e é obrigatório, rejeita. |
| `options` | `["main","dev"]` | Para `select`: só aceita esses valores. |
| `pattern` / `maxLength` | `^[A-Za-z0-9._/-]+$` / `80` | Validação extra. Cada tipo já vem com um padrão seguro. |
| `source` | `body.ref`, `query.branch`, `header.x-github-event`, `fixed` | De onde o valor vem quando o webhook é chamado de fora. `fixed` = valor definido no `/admin`, quem chama não muda. |
| `extract` | `^refs/heads/(.+)$` | Opcional: regex que tira só uma parte do valor (ex.: a branch do `ref` do GitHub). |

**"Preenchido depois"** acontece de dois jeitos:
- **Chamada externa:** os valores chegam no corpo JSON (`{"BRANCH": "dev"}`) ou no caminho definido em `source`.
- **Execução manual:** o `/admin` mostra um formulário gerado a partir dos inputs; o usuário preenche e executa.

Tipo `secret`: valor guardado no servidor (chave de API, senha), mascarado na tela e nos logs, nunca vem de quem chama.

### 3.4 Como o script roda (o ponto que garante a segurança)

**Os inputs nunca são colados dentro do texto do comando.** Eles são passados como **variáveis de ambiente** do processo, e o script as usa entre aspas (`"$BRANCH"`). Assim, um valor como `main; rm -rf ~` é só um texto dentro de uma variável, nunca vira comando.

- O editor também aceita `{{BRANCH}}` por conveniência, mas ao salvar isso é convertido para `"$BRANCH"` (com aspas). Nunca há substituição de texto no momento da execução.
- O script é gravado num arquivo temporário (`0700`) e executado com `bash --noprofile --norc -euo pipefail arquivo.sh`, via `child_process.spawn` **sem shell intermediário**.
- Ambiente **limpo**: só `PATH`, `HOME`, `LANG`, os inputs e as variáveis do webhook (`MT_WEBHOOK_ID`, `MT_RUN_ID`, `MT_TRIGGER=http|manual`). Nada do `process.env` do servidor vaza (tokens, chaves).
- Corpo bruto da requisição disponível, se o script quiser, em arquivo (`$MT_PAYLOAD_FILE`), nunca em variável interpolada.

**Onde roda** (por webhook):
1. **Segundo plano** (padrão): processo separado, saída capturada no histórico, tempo limite (padrão 5 min, mata o grupo de processos ao estourar).
2. **Aba visível**: abre uma **aba nova** de terminal com o nome do webhook e roda o script lá, para acompanhar ao vivo. Usa o `spawnShell` com um `env` extra (o `server.js` já monta o `env` do pty), então os inputs também entram como variáveis, sem digitar valores no terminal.

Digitar dentro de uma aba já aberta (com alguém usando) **fica fora** desta versão: é o caso mais arriscado e o menos útil.

**Concorrência** (por webhook): `fila` (padrão, uma de cada vez), `ignorar se já estiver rodando` ou `cancelar a anterior`.

### 3.5 Autenticação por token

**Token Bearer (padrão)**
- Formato `mtwh_<32 bytes aleatórios em base64url>`. Gerado pelo servidor, **mostrado uma vez** ao criar.
- Guardado só como **hash SHA-256**, mais o prefixo (`mtwh_ab12…`) para o usuário reconhecer na lista.
- Enviado **só no header** `Authorization: Bearer …`. Token na URL (`?token=`) é recusado, porque vaza em logs e no histórico do navegador.
- Comparação em tempo constante (`safeEqual`, já existe no `server.js`).
- Vários tokens por webhook (um por integração), cada um com nome, validade opcional, último uso e botão **Revogar**.

**Assinatura HMAC (opcional, para GitHub, Stripe e parecidos)**
- Valida `X-Hub-Signature-256` (ou o header configurado) com HMAC-SHA256 do corpo **bruto**.
- Aqui o segredo **não pode ser só hash** (é preciso o valor para recalcular a assinatura). Ele fica **cifrado** no banco (AES-256-GCM) com uma chave do servidor (`WEBHOOK_SECRET_KEY` no `.env`). Correção do plano anterior, que previa hash.
- Proteção contra replay: timestamp com janela de 5 min quando o provedor manda, e `X-Request-Id`/`Idempotency-Key` guardado por 24 h para ignorar repetição.

### 3.6 Outras proteções
1. **Desligado por padrão**: a rota `/hooks/*` só existe com `WEBHOOKS_ENABLED=true`.
2. **PIN obrigatório** para criar, editar o script, ver ou gerar tokens. Quem edita o script controla o servidor.
3. **Versões do script**: cada alteração guarda a versão anterior (quem, quando). Dá para comparar e voltar.
4. **Limite de disparos** por webhook e por IP; após 5 falhas de autenticação seguidas, bloqueio temporário do IP.
5. **IPs permitidos** opcional por webhook.
6. **Corpo máximo** de 64 KB, só `application/json` ou `application/x-www-form-urlencoded`.
7. **Resposta não vaza nada**: token inválido e webhook inexistente devolvem o mesmo `404`, para não permitir descobrir slugs.
8. **Logs**: nunca registrar headers de autenticação, inputs `secret` nem o corpo inteiro. A saída do script passa por máscara dos valores secretos antes de ir para o histórico.
9. **Só HTTPS** fora de localhost.
10. **Usuário do sistema**: o script roda com o mesmo usuário do servidor. Documentar isso na tela. Evolução futura: rodar num container ou usuário restrito.

### 3.7 Respostas da rota pública

```
POST /hooks/<slug>
Authorization: Bearer mtwh_…
Content-Type: application/json
{"BRANCH": "dev"}

202 Accepted   {"run_id": "r_…", "status": "queued"}
400            {"error": "input_invalido", "input": "BRANCH"}     (sem ecoar o valor)
404            {"error": "nao_encontrado"}                          (slug ou token errado)
429            {"error": "limite"}
```

Opcional por webhook: **modo síncrono** (`?wait=30`), que espera até 30 s e devolve `exit_code` e as últimas linhas da saída. Útil para atalhos do celular.

### 3.8 Modelo de dados (SQLite, mesma conexão)

```sql
CREATE TABLE webhooks (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  enabled       INTEGER NOT NULL DEFAULT 1,
  preset        TEXT,                    -- modelo de origem, ou NULL para personalizado
  script        TEXT NOT NULL,
  inputs        TEXT NOT NULL DEFAULT '[]',  -- JSON: lista de inputs (3.3)
  cwd           TEXT,
  run_mode      TEXT NOT NULL DEFAULT 'background',  -- 'background' | 'tab'
  concurrency   TEXT NOT NULL DEFAULT 'queue',       -- 'queue' | 'skip' | 'cancel'
  timeout_sec   INTEGER NOT NULL DEFAULT 300,
  rate_per_min  INTEGER NOT NULL DEFAULT 6,
  auth_mode     TEXT NOT NULL DEFAULT 'bearer',      -- 'bearer' | 'hmac'
  hmac_secret   TEXT,                    -- cifrado (AES-256-GCM)
  allowed_ips   TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE webhook_tokens (
  id            TEXT PRIMARY KEY,
  webhook_id    TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL,           -- 'mtwh_ab12', para reconhecer
  token_hash    TEXT NOT NULL UNIQUE,    -- SHA-256
  expires_at    INTEGER,
  last_used_at  INTEGER,
  revoked_at    INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE TABLE webhook_secrets (           -- valores dos inputs do tipo 'secret'
  webhook_id    TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  value_enc     TEXT NOT NULL,           -- cifrado
  PRIMARY KEY (webhook_id, name)
);

CREATE TABLE webhook_versions (
  webhook_id    TEXT NOT NULL,
  version       INTEGER NOT NULL,
  script        TEXT NOT NULL,
  inputs        TEXT NOT NULL,
  changed_at    INTEGER NOT NULL,
  PRIMARY KEY (webhook_id, version)
);

CREATE TABLE webhook_runs (
  id            TEXT PRIMARY KEY,
  webhook_id    TEXT NOT NULL,
  trigger       TEXT NOT NULL,           -- 'http' | 'manual' | 'test'
  source_ip     TEXT,
  token_id      TEXT,
  inputs        TEXT NOT NULL,           -- JSON, com 'secret' mascarado
  status        TEXT NOT NULL,           -- 'queued' | 'running' | 'ok' | 'failed' | 'timeout' | 'rejected'
  exit_code     INTEGER,
  output        TEXT,                    -- últimos 64 KB, mascarado
  started_at    INTEGER,
  finished_at   INTEGER,
  created_at    INTEGER NOT NULL
);
```

Histórico com retenção configurável (padrão: últimas 200 execuções por webhook).

### 3.9 API interna (atrás do login e do PIN)

```
GET    /api/webhooks/presets              modelos disponíveis
GET    /api/webhooks                      lista
POST   /api/webhooks                      cria
GET    /api/webhooks/:id                  detalhe (sem segredos)
PUT    /api/webhooks/:id                  edita (gera nova versão se o script mudou)
DELETE /api/webhooks/:id                  remove
POST   /api/webhooks/:id/duplicate        duplica (sem tokens)
POST   /api/webhooks/:id/preview          mostra o script e o ambiente que rodariam com estes inputs (sem executar)
POST   /api/webhooks/:id/run              executa manualmente com os inputs do formulário
GET    /api/webhooks/:id/runs             histórico
GET    /api/webhooks/:id/runs/:run        detalhe; saída ao vivo pelo WebSocket já existente
POST   /api/webhooks/:id/runs/:run/cancel cancela
POST   /api/webhooks/:id/tokens           cria token (devolve o valor uma única vez)
DELETE /api/webhooks/:id/tokens/:token    revoga
GET    /api/webhooks/:id/versions         versões do script
```

### 3.10 Arquivos novos previstos
- `scripts/webhook-store.js`: CRUD, tokens, versões, histórico (no modelo do `command-store.js`).
- `scripts/webhook-inputs.js`: validação e extração dos inputs (tipos, `pattern`, `source`, `extract`).
- `scripts/webhook-runner.js`: fila, `spawn` com ambiente limpo, tempo limite, captura e máscara da saída.
- `scripts/webhook-crypto.js`: geração e hash de tokens, cifra dos segredos, verificação HMAC.
- `scripts/webhook-presets.js`: os modelos da seção 3.2.
- `public/admin/sections/webhooks.js`: lista, editor em abas, formulário de execução.
- Testes: `tests/webhook-inputs.test.js`, `tests/webhook-runner.test.js` (inclui **testes de injeção**: `;`, `$( )`, crases, quebras de linha, `../`), `tests/webhook-auth.test.js`.

---

## 4. Ordem de entrega

| Fase | Entrega | Branch sugerida |
|---|---|---|
| 0 | Merge das Anotações na `main` e deploy | (feito: `feat/notes-app`) |
| 1 | `/admin` com as seções atuais migradas do popup | `feat/admin-page` |
| 2 | Store, inputs, runner e crypto, com testes (sem UI e sem rota pública) | `feat/webhooks-core` |
| 3 | Tela `/admin/webhooks`: CRUD, modelos, inputs, **Executar manual** e histórico | `feat/webhooks-ui` |
| 4 | Rota pública `/hooks/:slug` com token Bearer e proteções | `feat/webhooks-public` |
| 5 | HMAC (GitHub/Stripe), modo síncrono, versões do script | `feat/webhooks-public` |
| 6 | Seção Segurança do `/admin` (tokens, PIN) e remoção do popup antigo | `feat/admin-page` |

A fase 3 já entrega valor sozinha (ações com formulário, rodando pelo app) antes de abrir qualquer porta para fora.

---

## 5. Decisões já tomadas
- Autenticação por **token**, guardado como hash, enviado só no header.
- Webhooks são um **CRUD** no `/admin`, cada um com sua **ação** (modelo ou script personalizado) e seus **inputs**.
- Inputs entram no script como **variáveis de ambiente**, nunca por substituição de texto.

## 6. Decisões em aberto
1. A rota pública vai ser chamada de fora (GitHub, n8n) já na primeira versão, ou primeiro só a execução manual pelo app? Recomendo a ordem da seção 4.
2. Precisamos do modo **aba visível** já na fase 3, ou só segundo plano no começo?
3. Quais modelos (3.2) entram primeiro? Sugestão: Atualizar repositório, Rodar script npm, Chamar agente e Personalizado.
4. O popup antigo sai no lançamento do `/admin` ou fica uma versão como fallback?

---

## 7. Riscos
- **Execução remota de comandos** por um token vazado. Mitigação: token por integração e revogável, IPs permitidos, limite de disparos, PIN para editar, histórico de tudo.
- **Injeção pelos inputs.** Mitigação: variáveis de ambiente em vez de interpolação, validação por tipo, testes de injeção na suíte.
- **Script travado ou pesado.** Mitigação: tempo limite, fila, cancelar, matar o grupo de processos.
- **Segredos em log ou na saída.** Mitigação: máscara dos valores `secret`, nunca registrar headers de autenticação.
- **Regressão de configurações** ao migrar o popup. Mitigação: mover o código das seções sem reescrever e conferir as opções uma a uma.

---

## 8. Prompt para implementar (copiar e colar no agente)

> Implemente a fase **N** do `docs/PLANO-WEBHOOKS.md` no projeto MeuTerminal (`/root/projetos/meu-terminal`).
> Siga o estilo do código existente (`scripts/command-store.js`, `scripts/notes-store.js`, rotas em `server.js`, mesma conexão SQLite).
> Regras que não podem ser quebradas:
> 1. Inputs entram no script só como variáveis de ambiente; nunca interpolar valores no texto do script.
> 2. Executar com `spawn('bash', ['--noprofile','--norc','-euo','pipefail', arquivo])`, ambiente limpo, tempo limite e kill do grupo de processos.
> 3. Tokens `mtwh_…` gerados com `crypto.randomBytes(32)`, guardados como SHA-256, aceitos só em `Authorization: Bearer`, comparados com `safeEqual`.
> 4. Tudo atrás de `WEBHOOKS_ENABLED` (padrão `false`); criar, editar script e gerar token exigem PIN.
> 5. Nunca logar headers de autenticação, segredos ou o corpo inteiro.
> Escreva os testes da seção 3.10 (incluindo injeção) e rode `npm test` antes de terminar. Um PR por fase, na branch indicada na seção 4.
