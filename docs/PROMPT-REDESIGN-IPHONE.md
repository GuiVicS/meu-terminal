# Prompt: terminar e validar o redesign de iPhone do MeuTerminal

> Cole este arquivo inteiro como mensagem para o agente (Claude Code rodando no servidor do
> MeuTerminal, na pasta do repositório). Ele traz o contexto, o que já está pronto, as regras
> de design, o que falta e como verificar. Trabalhe na branch `feat/visual-vidro-ios`.

---

## 1. Contexto

O MeuTerminal (este repositório) é um PWA para usar o servidor pelo celular: terminais, navegador
(Chromium no servidor, transmitido como imagem), arquivos, anotações e chat de agentes (Claude Code
via ACP). O dono usa o app principalmente num **iPhone, como PWA instalado** (tela cheia).

O objetivo do redesign é dar ao app, **só no iPhone e só em retrato**, a cara do iOS 26
(Liquid Glass) e a filosofia do app do Claude no iPhone: **simples, com poucos botões, sem
perder funções**, agrupando o que é secundário em botões que abrem folhas deslizantes ou menus.
A prioridade é **aproveitar a tela ao máximo**.

Desktop, Android, iPad e iPhone deitado **não podem mudar**.

---

## 2. O que já está pronto na branch `feat/visual-vidro-ios`

Commits (do mais antigo ao mais novo):

1. `feat: visual de vidro (estilo iOS 26) no celular` - primeira versão do vidro.
2. `feat: layout de iPhone com Liquid Glass e chat flutuante` - restringe ao iPhone, aplica as
   diretrizes da Apple e cria o compositor flutuante do chat com a folha de configurações.
3. `feat: aba de navegador no estilo do Safari do iOS 26 (iPhone)`.
4. `feat: abas do iPhone como pílula da sessão atual + folha de sessões`.
5. `feat: histórico de abas na folha de sessões do iPhone`.
6. `feat: página inicial de apps no estilo da tela de início do iOS 26 (iPhone)`.
7. `feat: arrastar da borda esquerda abre a página de apps (iPhone)`.

### 2.1 Como o "modo iPhone" liga

- `public/index.html`: o script inline antes da primeira pintura faz
  `if (/iPhone|iPod/.test(navigator.userAgent)) document.documentElement.setAttribute('data-iphone', '')`.
- `public/styles.css`: todo o visual de iPhone está em blocos
  `@media (orientation: portrait) { [data-iphone] { ... } }` usando **CSS nesting nativo**
  (Safari 17.2+). Regras que dependem de outros atributos do `<html>` usam `&[data-keyboard]`,
  `&[data-expanded]`.
- `public/agent/composer.js`: constante `IPHONE` lida do mesmo atributo.

### 2.2 Tokens de vidro (fim do `styles.css`, bloco "Liquid glass (iPhone)")

`--glass-bg`, `--glass-bg-dense` (para áreas com texto/inputs), `--glass-fill` e
`--glass-fill-pressed` (preenchimento de controles **dentro** do vidro), `--glass-border`,
`--glass-rim`, `--glass-rim-low`, `--glass-sheen`, `--glass-shadow`, `--glass-blur`.
Há variantes claro/escuro, um `@supports` para `backdrop-filter` e um fallback sólido para
`prefers-reduced-transparency: reduce` e `prefers-contrast: more`.

### 2.3 Telas já redesenhadas

| Tela | Como ficou | Onde |
|---|---|---|
| Topo (todas as abas) | Só a **pílula da sessão atual** (ícone colorido, nome, ⌄) à esquerda e o botão ⋮ (menu do app) à direita, numa linha de 48 px. Sem marca "MeuTerminal", sem faixa de abas, sem botão de tela cheia. | `index.html` (`#sessionPill`), `index.js` (`renderPill`), CSS |
| Folha de sessões | "Sessões abertas": tocar troca, ✕ fecha, segurar abre o menu da aba (renomear, fixar, dividir...), "+" e "Nova sessão". Abaixo, "Fechadas recentemente": tocar reabre, ✕ esquece. Abre pela pílula e pelo botão de lista da barra de status. | `public/ui/sessionSheet.js`, `TerminalManager.openSessionList` |
| Terminal (embaixo) | Barra de status em texto simples (sem vidro). Teclas de atalho em **duas cápsulas de vidro**: teclas de texto (ESC, TAB, CTRL, ALT, setas) e ícones (comandos rápidos, colar, microfone, mais). | CSS |
| Chat do agente | Caixa de mensagem **flutuante** (cartão de vidro, raio 32), conversa passa por baixo com fade. Texto em cima; embaixo ＋ (anexar), pílula de resumo "Modelo · Modo" e enviar. Os seletores do agente foram para uma **folha deslizante** ("Modelo e configurações") aberta pela pílula. | `composer.js` (`setupIphone`, `settingsSummary`, `openSheet`, `dispose`), CSS |
| Navegador | Estilo **Safari compacto do iOS 26**: barra flutuante embaixo com voltar, pílula do endereço (mostra só o domínio; editar mostra o endereço completo e ocupa a barra) com recarregar dentro, e "•••" com Avançar, Teclado, Portas abertas e Tamanho e qualidade. Página ocupa a aba inteira. | `browserSession.js` (`.browser-pill`, `.browser-host`, `openMoreMenu`), CSS |
| Menus (`.menu`) | Popovers de vidro com cantos 22 px e itens de 44 px. | CSS |
| Gesto de borda | Arrastar da borda esquerda (24 px) para a direita abre a página de apps (no 4.9 isso vira "voltar", abrindo apps só na raiz); com ela aberta, arrastar para a esquerda fecha. Um círculo de vidro com o ícone de grade acompanha o dedo e fica roxo quando soltar vai agir (70 px). Arrasto vertical, toque fora da borda e folhas/menus abertos não disparam. | `public/ui/edgeSwipe.js`, `index.js` (`bindEdgeSwipe`), CSS `.edge-swipe-hint` |
| Página inicial de apps ("Nova sessão") | Título grande à esquerda; ícones de app como na tela de início (68 px, gradiente da cor do app, glifo branco, sem cartão em volta, rótulo embaixo); "Sessões recentes" como lista agrupada com ícone do tipo; formulário com controle segmentado, campos de 50 px e botões em cápsula; configurações e fechar como círculos de vidro; fundo com leve gradiente. | `ui/newSession.js` (`RECENT_ICONS`, `.recent-icon`), CSS |

No desktop o navegador mantém a ordem antiga graças a `.browser-pill { display: contents }` e
`order` nos botões. Não quebre isso.

---

## 3. Regras de design (siga sempre)

Baseadas em "Adopting Liquid Glass" e na página "Materials" das Human Interface Guidelines da Apple
(developer.apple.com), e nas preferências do dono:

1. **Vidro só na camada de controles e navegação**, nunca no conteúdo. Use com moderação.
2. **Agrupe controles relacionados numa mesma cápsula** em vez de um vidro por botão. Não misture
   texto e ícones dentro da mesma cápsula.
3. **Sem vidro sobre vidro**: controles dentro de um container de vidro usam `--glass-fill`.
4. **Cantos concêntricos**: raio interno = raio externo - espaçamento (ex.: cartão 32, padding 10,
   botões 22; cápsula 48 de altura com 4 de padding, itens de 40 com raio 20).
5. **Conteúdo que rola sob controles flutuantes some aos poucos** (scroll edge effect).
6. **Folhas**: afastadas das bordas da tela, cantos grandes (34), linhas altas (≥ 56 px),
   títulos de seção em caixa normal (sem CAIXA ALTA). Fecham tocando fora, no ✕, com Esc ou
   arrastando para baixo.
7. **Cor com parcimônia**: o roxo (`--accent`) só na ação principal (enviar, item ativo, CTRL ativo).
8. **Acessibilidade**: rótulo acessível em todo botão de ícone; "Reduzir transparência" e "Aumentar
   contraste" ficam sólidos; "Reduzir movimento" desliga animações; alvos de toque ≥ 44 px.
9. **Simplicidade sem perder função**: nada pode ficar inacessível. Função secundária vai para um
   menu "•••", uma folha ou um toque longo, nunca some.
10. **Escopo**: só `[data-iphone]` em retrato. Desktop, Android, iPad e paisagem iguais a `main`.
11. Estilo do código: comentários explicando o porquê, como o resto do projeto; Conventional
    Commits; mensagens em português.

---

## 4. O que falta fazer (em ordem de prioridade)

### 4.1 Validar num iPhone de verdade (obrigatório antes de qualquer outra coisa)

Até aqui tudo foi verificado só no Chromium com a marcação real, não num iPhone. Suba a branch,
abra o PWA instalado e confira:

- [ ] `data-iphone` aparece no `<html>` (Safari: Ajustes do iPhone → Safari → Avançado → Web
      Inspector, ou um `console.log` temporário).
- [ ] O vidro aparece (`-webkit-backdrop-filter`) e não pesa: role o terminal e o chat e confira se
      não engasga. Se pesar, reduza o blur (`--glass-blur`) ou troque por fundo sólido nos elementos
      sobre o canvas do xterm.
- [ ] Áreas seguras: nada sob o notch/Dynamic Island nem sob o indicador de início.
- [ ] Teclado aberto (`data-keyboard`): o topo continua com uma linha; a caixa do chat sobe junto com
      o teclado; a barra do navegador fica acima do teclado; as teclas de atalho ficam visíveis.
- [ ] Folhas: abrem e fecham (tocar fora, ✕, arrastar), rolam quando a lista é grande, e os seletores
      dentro da folha do chat (que abrem a lista temática de `ui/select.js`) funcionam por cima dela.
- [ ] Chat: `--ag-composer-h` acompanha a altura da caixa (ResizeObserver); a última mensagem, a
      barra de permissão pendente (`.ag-pending`) e o botão "ir para o fim" (`.ag-jump`) não ficam
      escondidos atrás da caixa.
- [ ] Navegador: tocar na página manda o toque para o Chromium certo mesmo com a barra flutuando por
      cima; o "•••" e o menu de portas abrem ancorados no lugar certo.
- [ ] Gesto da borda esquerda: abre a página de apps sem conflitar com o gesto do sistema (num PWA
      instalado não há "voltar" do Safari; confira mesmo assim) nem com a rolagem do terminal.
- [ ] Girar para paisagem volta ao layout antigo sem quebrar nada.
- [ ] Tema claro e escuro.

Corrija o que falhar antes de seguir.

### 4.2 PWA: garantir que o iPhone receba a versão nova

O service worker usa `CACHE_NAME = MEUTERMINAL_CACHE_V<versão>` (`public/service-worker.js`,
`config.js` em `server.js`). Suba a versão em `package.json` (hoje `2.7.0` → `2.8.0`) para o PWA
trocar o cache. Confira que o iPhone carrega o CSS novo depois do deploy.

### 4.3 Microfone no compositor do chat (como no app do Claude)

O app do Claude tem 🎤 ao lado do enviar. Já existe ditado em `public/ui/dictation.js`
(`class Dictation`, `start()`, `stop()`, usado pela barra de atalhos em `ui/shortcutBar.js`). No iPhone:
- botão redondo `--glass-fill` 44 px na área `stop`/`send` da grade (`.ag-input-row`), entre a pílula e
  o enviar;
- o texto reconhecido entra na caixa (`composer.insert` ou direto no textarea + `autosize()`);
- estado "gravando" em vermelho pulsando (mesmo visual de `.shortcut-key.icon-key.recording`);
- só aparece se o navegador tiver reconhecimento de voz.

### 4.4 Navegador: barra que encolhe ao rolar (como o Safari)

No Safari, rolar para baixo encolhe a barra para uma pílula pequena só com o domínio; rolar para cima
volta. A página roda no servidor, mas os gestos de rolagem passam por `bindPointer()` em
`browserSession.js`. Detecte arrasto vertical (direção e distância), alterne uma classe
`.browser-toolbar.minimized` e, no CSS de iPhone, esconda voltar/••• e reduza a pílula
(ex.: 32 px, fonte 13). Tocar na pílula minimizada expande de novo. Respeite "Reduzir movimento".

### 4.5 Trocar de sessão com gesto

No Safari, deslizar para os lados na barra troca de aba. Faça o mesmo na **pílula da sessão**
(`#sessionPill`): arrastar horizontal > 40 px chama a sessão anterior/seguinte (o
`TerminalManager` já tem as ações `next`/`prev`). Animação curta do nome entrando pelo lado.

### 4.6 Telas que ainda não foram adaptadas ao iPhone

**Primeiro, um ajuste pedido pelo dono no formulário de nova sessão** (`ui/newSession.js`):
o controle segmentado **Terminal / Navegador / Arquivos / Anotações** (`.kind-toggle`) é
**redundante**: o usuário já escolheu o tipo ao tocar no ícone do app na tela anterior
(`showForm(tile.dataset.kind)`). No iPhone:
- esconda o `.kind-toggle` quando o formulário vier de um ícone da grade;
- o título passa a dizer o tipo escolhido ("Novo terminal", "Novo navegador", "Nova aba de
  arquivos") em vez de "Nova sessão", para ficar claro o que vai ser criado;
- quem quiser outro tipo volta pelo "‹ Início" (ou arrasta da borda), como em qualquer app de iPhone;
- o único caminho que não tem tipo pré-escolhido é "Nova sessão com opções…" do menu ⋮
  (`open({ advanced: true })`, que chama `showForm('terminal')`). Ali, decida com o dono: ou mostra
  o seletor só nesse caso, ou esse item do menu passa a abrir a grade de apps.
- Na mesma tela, o botão "Criar sessão" aparece com um anel roxo em volta (o `:focus-visible` ou a
  borda do `.btn-primary`); remova no iPhone, o botão já é a ação principal pela cor.

Depois, aplique as regras da seção 3 a:

- [ ] **Arquivos** (`managers/filesSession.js`): barra de caminho e ações. Botão principal flutuante
      embaixo; ações secundárias num "•••"; lista com linhas de 56 px.
- [ ] **Anotações** (`managers/notesSession.js` e o PWA separado `/notas`): barra de busca/filtro
      como pílula de vidro; editor sem bordas; ações num "•••".
- [ ] **Diálogos** (`.dialog`, Configurações via `ui/dialogs.js`): no celular já viram bottom sheet;
      no iPhone, use o mesmo visual das folhas novas (afastadas das bordas, raio 34, vidro denso).
- [ ] **Toasts** (`ui/toast.js`) e **prompt/confirm** (`ui/prompt.js`): vidro e cantos grandes.
- [ ] **Busca no terminal** (`ui/search.js`, `.search-bar`): pílula de vidro flutuante.
- [ ] **Login** (`login.html`) e **/admin**: só ajustar cantos e espaçamentos; vidro não é necessário
      (conteúdo, não controles).
- [ ] **Painel lateral do agente** (`agent/sidepanel.js`) no iPhone: virar folha em vez de painel.

### 4.7 Opção nas Configurações

Em Configurações → Interface: "Visual do iPhone: vidro / clássico" (salvo junto com as outras
preferências em `managers/settings.js`). "Clássico" remove `data-iphone`. Opcional: "Usar o visual de
iPhone em outros celulares" para quem tiver Android (adiciona `data-iphone` também com
`(pointer: coarse)` e largura < 720).

### 4.8 Simplificar os fluxos (menos toques, mesmas funções)

A análise completa está em **`docs/ANALISE-UX.md`** (jornadas com contagem de toques, 14
redundâncias com evidência e o layout proposto). Leia antes de mexer. Resumo do que implementar,
nesta ordem, **só no iPhone em retrato** (o desktop mantém o ⋮ e os atalhos como estão):

1. **Push abre a conversa** (R14): o push de permissão (`agentGateway.on('event')` em `server.js`)
   hoje não manda `url`, então abre a raiz. Mande `url: /?tab=<id da aba do agente>` e, no
   `index.js`, ative essa aba ao abrir (o service worker já usa `notification.data.url`).
2. **⋮ contextual** (R1, R3, R4, R5, R6, R11): no iPhone o ⋮ mostra primeiro as ações da aba atual
   (as do menu da aba, as do cabeçalho do chat do agente, Buscar no terminal), depois Configurações,
   Guia e Sair. Saem do ⋮ no iPhone: os 7 itens de criar (estão na página de apps), Reabrir fechada
   (está no histórico), Comandos rápidos e Copiados (estão na barra de atalhos), Modo foco (o iPhone
   já é sempre tela cheia) e Tema (vai para Configurações). O cabeçalho do chat do agente fica só com
   título e status. Tabela por tipo de aba na seção 5 da análise.
3. **Criar direto** (R9, R10): tocar em Terminal, Navegador, Arquivos ou Agente na página de apps cria
   na hora, com os padrões (nome automático, pasta da aba atual, agente padrão lembrado). O formulário
   só aparece com **toque longo** no ícone ("Personalizar…"). Navegador abre uma página inicial com as
   portas abertas no servidor. No iPhone, o popup "Deseja usar o modo UI?" lembra a escolha por padrão.
4. **Configurações numa folha** (R2): no iPhone, ⋮ → Configurações, o ⚙ da página de apps e
   "Gerenciar comandos" abrem uma **folha** dentro do app (reaproveite `mountSettingsSections` de
   `ui/dialogs.js`), já na seção certa, sem navegar para `/admin` (que recarrega e derruba o contexto).
   Backup e Webhooks podem continuar só no `/admin`.
5. **Barra de status** (R7, R12): no iPhone, tire o botão de lista de sessões (a pílula já faz isso)
   e avalie tirar a barra inteira, mostrando um aviso só quando a conexão cair (~38 px a mais de tela).
   **Pergunte ao dono** antes de tirar a barra inteira.

### 4.9 Vibecoding no iPhone: agente ↔ prévia por gesto e 👁

Pedido do dono, avaliado na seção 6 da análise (faz sentido: em retrato a tela dividida deixa cada
metade com ~340 px). Em um projeto de vibecoding (`GET /api/vibe/tab/:tabId`, `scripts/vibe.js`):
- **não dividir a tela** no iPhone em retrato (o servidor manda `{ type: 'split', a, b }`; no cliente,
  ignore a divisão nesse caso e mantenha o par agente → prévia como "tela atual → tela seguinte");
- **arrastar da borda direita para a esquerda** no chat do agente abre a prévia (estenda
  `ui/edgeSwipe.js`: mesma dica de vidro, com o ícone `eye`);
- **arrastar da borda esquerda para a direita** na prévia volta ao agente. Regra geral nova da borda
  esquerda: é **"voltar"**; só abre a página de apps quando não há tela anterior ligada;
- **botão visível 👁 "Prévia"** no chat do agente (gestos não aparecem; sempre dê uma alternativa
  visível). Na prévia, o botão voltar da barra do navegador, quando a página não tem histórico, vira
  "‹ Agente";
- quando a prévia recarregar por causa de um arquivo salvo, mostrar no chat um aviso discreto
  "Prévia atualizada · ver" que leva para ela com um toque.

### 4.10 Pendência de decisão (pergunte ao dono antes)

No mock que o dono desenhou, a **barra de status é uma pílula de vidro** e **cada tecla de atalho
tem o próprio vidro**. A implementação atual segue a Apple (status em texto; teclas em duas
cápsulas). Mostre os dois lado a lado e deixe o dono escolher.

---

## 5. Como verificar cada mudança

1. `node --test "tests/**/*.test.js"` (hoje: 137 testes passando) e
   `node --check` em todos os `.js` alterados (`node --input-type=module --check < arquivo` para os
   módulos de `public/`).
2. Prévia sem iPhone: abra o app no Chromium com o tamanho do iPhone (393×852, `isMobile`) e
   force o modo com `document.documentElement.setAttribute('data-iphone', '')` antes de carregar os
   módulos (ou um parâmetro temporário `?iphone=1` só em desenvolvimento). Tire screenshots antes e
   depois, tema claro e escuro, teclado fechado e aberto.
3. Desktop: confira em 1000 px de largura que nada mudou em relação a `main`.
4. iPhone de verdade (seção 4.1).
5. Commits pequenos, um por item, em Conventional Commits com mensagem em português.
6. Ao terminar: abra um PR de `feat/visual-vidro-ios` para `main` com screenshots antes/depois e a
   lista do que foi validado no iPhone.

---

## 6. Fora deste escopo (outra frente)

A ponte MCP para o Claude do claude.ai usar o servidor está planejada em
`docs/PLANO-MCP-REMOTO.md`, na branch `docs/plano-mcp-remoto`. Não misture com este trabalho.
