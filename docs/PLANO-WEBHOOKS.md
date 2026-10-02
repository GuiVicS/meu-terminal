# Plano de ação: Webhooks e tela administrativa (/admin)

Status: proposta, nada implementado.
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

## 3. Parte B: Webhooks que disparam comandos no terminal

### O que o usuário configura (em `/admin/webhooks`)
Cada webhook tem:

- **Nome** e **ativo/inativo**.
- **URL** gerada: `POST /hooks/<id>`, com segredo próprio. Mostrada uma vez, depois só dá para regenerar.
- **Destino**, uma das opções:
  - uma sessão de terminal específica;
  - a última sessão em foco;
  - **uma sessão nova** a cada disparo (com `cwd` e nome).
- **Comando**: texto fixo ou modelo com variáveis do payload (ver segurança abaixo).
- **Executar (Enter)**: liga/desliga, igual aos comandos rápidos.
- **Limites**: máximo de disparos por minuto e tempo mínimo entre disparos.
- **Histórico** dos últimos disparos: data, origem, resultado, resposta HTTP.
- Botão **Testar**.

### Modelo de dados (SQLite, mesma conexão)

```sql
CREATE TABLE webhooks (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  secret_hash   TEXT NOT NULL,        -- hash do segredo; o valor puro só aparece na criação
  target_kind   TEXT NOT NULL,        -- 'session' | 'focused' | 'new'
  target_id     TEXT,                 -- sessão fixa, quando target_kind = 'session'
  target_cwd    TEXT,                 -- para 'new'
  command       TEXT NOT NULL,        -- texto fixo ou modelo
  run           INTEGER NOT NULL DEFAULT 1,
  rate_per_min  INTEGER NOT NULL DEFAULT 6,
  created_at    INTEGER NOT NULL
);

CREATE TABLE webhook_deliveries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id  TEXT NOT NULL,
  at          INTEGER NOT NULL,
  source_ip   TEXT,
  status      TEXT NOT NULL,          -- 'ok' | 'rejeitado' | 'limitado' | 'erro'
  detail      TEXT
);
```

### Fluxo de um disparo

```
POST /hooks/<id>  (+ assinatura)
  → localiza o webhook, confere se está ativo
  → valida a assinatura (HMAC) e a janela de tempo
  → aplica o limite de disparos
  → monta o comando (modelo + campos permitidos do payload)
  → resolve o destino (sessão fixa / em foco / nova)
  → escreve no pty (com Enter, se configurado)
  → grava em webhook_deliveries e responde 202
```

### Segurança (parte mais importante)
Um webhook executa comando no shell do servidor. Qualquer falha aqui é execução remota de comandos. Regras:

1. **Autenticação própria.** Rota fora do login por cookie (quem chama é uma máquina), mas com **assinatura HMAC-SHA256** do corpo com o segredo do webhook, em header, mais **timestamp** com janela curta (5 min) contra replay. Comparação em tempo constante (`safeEqual` já existe no projeto).
2. **Segredo guardado como hash**, nunca em texto. Regenerar invalida o anterior.
3. **Sem injeção de shell.** O payload **nunca** vira comando cru. Duas opções, por webhook:
   - **Comando fixo** (padrão, o mais seguro): o payload não influencia o que roda.
   - **Modelo com variáveis**: só campos explicitamente declarados (`{{branch}}`, `{{tag}}`), cada um validado por um padrão (por exemplo `^[A-Za-z0-9._/-]{1,80}$`), com aspas escapadas e caracteres de controle e quebras de linha removidos. Valor que não passa na validação rejeita o disparo.
4. **Limite de disparos** por webhook e por IP, com bloqueio temporário após falhas seguidas de assinatura.
5. **Lista de IPs permitidos** opcional (por exemplo faixas do GitHub), por webhook.
6. **Tamanho máximo do corpo** (ex.: 64 KB) e `Content-Type` restrito.
7. **Auditoria**: todo disparo, aceito ou não, entra no histórico.
8. **Só HTTPS em produção**, e a URL pública só existe se o administrador ligar `WEBHOOKS_ENABLED=true` (padrão desligado, no mesmo estilo de `NOTES_ENABLED`).
9. **Confirmação ao criar** com PIN (a tela de webhooks é sensível).

### API interna (atrás do login)
```
GET    /api/webhooks                 lista (sem segredo)
POST   /api/webhooks                 cria, devolve o segredo uma única vez
PUT    /api/webhooks/:id             edita
POST   /api/webhooks/:id/rotate      novo segredo
DELETE /api/webhooks/:id             remove
POST   /api/webhooks/:id/test        dispara um teste
GET    /api/webhooks/:id/deliveries  histórico
```

### Arquivos novos previstos
- `scripts/webhook-store.js` (store, no modelo do `command-store.js`)
- `scripts/webhook-runner.js` (validação, montagem do comando, escrita no pty)
- `public/admin/sections/webhooks.js` (tela)
- `tests/webhook-store.test.js` e `tests/webhook-runner.test.js`

---

## 4. Ordem de entrega

| Fase | Entrega | Branch sugerida |
|---|---|---|
| 0 | Merge das Anotações na `main` e deploy | (feito: `feat/notes-app`) |
| 1 | `/admin` com as seções atuais migradas do popup | `feat/admin-page` |
| 2 | Store e runner de webhooks, com testes (sem UI) | `feat/webhooks-core` |
| 3 | Rota pública `/hooks/:id` e proteções | `feat/webhooks-core` |
| 4 | Tela `/admin/webhooks` e histórico | `feat/webhooks-ui` |
| 5 | Seção Segurança do `/admin` (tokens, PIN) e remoção do popup antigo | `feat/admin-page` |

Cada fase vira um PR separado, com testes rodando no CI (`npm test`).

---

## 5. Decisões em aberto

1. O webhook será chamado **de fora** (GitHub, Stripe, n8n) ou só de dentro da rede? Isso define se a rota fica pública e se a lista de IPs é obrigatória.
2. Modelos com variáveis entram já na primeira versão, ou começamos só com **comando fixo**? Recomendo começar só com comando fixo.
3. O destino "sessão nova" deve fechar a sessão sozinha ao terminar o comando?
4. O popup antigo é removido logo no lançamento do `/admin` ou fica por uma versão como fallback?

---

## 6. Riscos

- **Execução remota de comandos** se a validação falhar. Mitigação: comando fixo como padrão, assinatura obrigatória, testes de injeção na suíte.
- **Regressão de configurações** ao migrar o popup. Mitigação: mover o código das seções, sem reescrever, e conferir a lista de opções uma a uma.
- **Segredos expostos em log.** Mitigação: nunca registrar headers de assinatura nem o corpo completo.
