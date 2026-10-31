# Análise de UX: jornadas, redundâncias e layout com menos toques

Status: análise do código da branch `feat/visual-vidro-ios` (v2.7.0 + redesign de iPhone).
Foco: **iPhone em retrato** (PWA instalado), que é como o dono usa o app. Onde uma proposta
também valeria para o desktop, isso está dito.

Princípio que guia tudo: **menos toques e menos lugares, sem perder nenhuma função**. Uma função
pode mudar de lugar (ir para um "•••", um toque longo ou uma folha), mas nunca deixar de existir.

---

## 1. Quem usa e para quê

Uma pessoa, dona do servidor, que pelo celular quer:

1. voltar ao que estava fazendo (terminais e conversas continuam rodando no servidor);
2. rodar comandos e acompanhar processos;
3. pedir coisas a um agente (Claude Code) num projeto e aprovar o que ele pede;
4. criar um projeto novo com IA (vibecoding), ver a prévia e publicar;
5. ver no navegador o que está rodando no servidor (`localhost`);
6. mexer em arquivos (servidor e Google Drive) e anotar ideias;
7. de vez em quando, configurar o app.

---

## 2. Mapa das superfícies (onde as ações moram hoje)

| Superfície | O que tem | Arquivo |
|---|---|---|
| Pílula da sessão (topo, iPhone) | sessão atual → folha de sessões | `index.js`, `ui/sessionSheet.js` |
| Folha de sessões (iPhone) | trocar, fechar, segurar = menu da aba, nova sessão, histórico | `ui/sessionSheet.js` |
| Menu ⋮ do app | **até 19 itens** (17 no iPhone): 7 de criar (Nova sessão, Navegador, Arquivos, Anotações, Nova sessão com opções…, Conversa com agente, Vibecoding), Dividir tela, Reabrir fechada, Buscar, Comandos rápidos, Copiados, Modo foco, Tema, Configurações, Guia, Atalhos (desktop), Sair | `index.js` (`menuBtn`) |
| Menu da aba (toque longo) | abrir pasta nos Arquivos, dividir, duplicar, renomear, fixar, mover, fechar, fechar outras/à direita | `TerminalManager.openTabMenu` |
| Página de apps | 6 apps, formulário (seletor de tipo, nome, pasta/endereço), sessões recentes, ⚙ (vai para `/admin`), ✕ | `ui/newSession.js` |
| Barra de status | conexão, pasta, (desktop: shell, processo, branch, tamanho, relógio), botão lista de sessões | `ui/statusBar.js` |
| Barra de atalhos | ESC TAB CTRL ALT setas, ⚡ comandos rápidos, 📋 colar/copiados, 🎤 ditado, … mais teclas | `ui/shortcutBar.js` |
| Cabeçalho do chat do agente | publicar, trocar agente, conversas, terminal na pasta, arquivos da pasta, painel lateral | `managers/agentSession.js` |
| Compositor do chat (iPhone) | ＋ anexar, pílula "Modelo · Modo" → folha de configurações, enviar/parar | `agent/composer.js` |
| Navegador (iPhone) | voltar, endereço + recarregar, ••• (avançar, teclado, portas, tamanho/qualidade) | `managers/browserSession.js` |
| Popup "Deseja usar o modo UI?" | aparece ao digitar `claude`/`codex` no terminal | `ui/agentLaunch.js` |
| Configurações (popup) | as mesmas seções do `/admin` | `ui/dialogs.js` (`createSettingsDialog`) |
| `/admin` (página separada) | comandos, terminal, interface, sessão, backup, webhooks, aparelhos, notificações, agentes | `public/admin/` |
| Gesto da borda esquerda (iPhone) | abre/fecha a página de apps | `ui/edgeSwipe.js` |
| Push no celular | agente pedindo permissão; avisos do MCP (`notify`) | `server.js`, `scripts/push.js` |

---

## 3. Jornadas: caminho atual e proposto

Toques contados no iPhone, já com o redesign desta branch. "Digitar" não conta como toque.

| # | Jornada | Caminho hoje | Toques | Caminho proposto | Toques |
|---|---|---|---|---|---|
| J1 | Voltar ao trabalho | abrir o PWA: as abas voltam sozinhas | 0 | igual | 0 |
| J2 | Trocar de sessão | pílula → sessão | 2 | igual, ou deslizar na pílula (anterior/próxima) | 1-2 |
| J3 | Novo terminal | borda → Terminal → formulário (nome, pasta) → Criar | 3 | borda → Terminal (cria já na pasta da aba atual); segurar o ícone = opções | 2 |
| J4 | Conversar com o agente no projeto | ⋮ → Nova conversa com agente → escolher agente (ou digitar `claude` → popup → Sim) | 3 | borda → Agente (agente padrão, pasta atual); segurar = escolher agente/pasta | 2 |
| J5 | Aprovar permissão do agente pelo push | toque no push → abre o app no início, não na conversa → pílula → conversa → aprovar | 4 | toque no push → abre a conversa → aprovar | 2 |
| J6 | Ver o projeto rodando | borda → Navegador → formulário com portas → porta → Criar | 4 | borda → Navegador → porta (a aba nova já lista as portas abertas) | 3 |
| J6b | ...num projeto de vibecoding | trocar para a aba da prévia, ou ver a tela dividida (metade cada) | 2 | deslizar da borda direita, ou tocar no 👁 | 1 |
| J7 | Abrir arquivos | borda → Arquivos → formulário → Criar | 3 | borda → Arquivos (abre na pasta da aba atual) | 2 |
| J8 | Anotar uma ideia | borda → Anotações | 2 | igual | 2 |
| J9 | Novo projeto (vibecoding) | borda → Vibecoding → formulário (6 campos) → Criar | 3 | igual, mas pasta/agente/git ficam em "Opções" já preenchidas | 3 |
| J10 | Reabrir aba fechada | pílula → histórico → aba | 2 | igual | 2 |
| J11 | Usar um comando rápido | ⚡ → comando | 2 | igual | 2 |
| J12 | Mudar tema ou fonte | ⋮ → Configurações → **sai do app** (`/admin`, recarrega tudo) → seção → mudar → voltar (recarrega de novo) | 5+ e perde o contexto | ⋮ → Configurações (folha, sem sair) → mudar | 3 |
| J13 | Cadastrar comando rápido | ⚡ → Gerenciar comandos → **outro** painel de configurações (popup) | 3 | ⚡ → Gerenciar → a mesma folha de Configurações, já na seção | 3 |
| J14 | Buscar no terminal | ⋮ → Buscar | 2 | igual (o ⋮ passa a ser da aba atual, então Buscar fica no topo) | 2 |

Ganho principal: J3, J4, J7 (1 toque a menos cada, nas tarefas mais frequentes), J5 (metade dos
toques numa tarefa urgente), J6b (de 2 para 1) e J12 (sem sair do app).

---

## 4. Redundâncias encontradas

| # | Função | Onde aparece hoje | Problema | Proposta (iPhone) |
|---|---|---|---|---|
| R1 | **Criar uma aba** | ⋮ (7 itens), página de apps (6 ícones), "+" e "Nova sessão" na folha de sessões, atalhos de teclado | O ⋮ repete a página de apps item por item e chega a 19 itens | Uma porta só: **página de apps** (borda esquerda, "+" da folha). Tirar os 7 itens de criar do ⋮ no iPhone. Atalhos de teclado continuam no desktop. |
| R2 | **Configurações** | popup (`createSettingsDialog`) e página `/admin`, ambos montados por `mountSettingsSections` | Duas telas para a mesma coisa; o `/admin` tira você do app e recarrega os terminais | No iPhone, **uma folha de Configurações** dentro do app, reaproveitando `mountSettingsSections`; ⚙ da página de apps, ⋮ e "Gerenciar comandos" abrem a mesma folha na seção certa. `/admin` fica para o desktop e para Backup/Webhooks. |
| R3 | **Tema** | ⋮ (alternar) e Configurações | Item de uso raro ocupando o menu principal | Só em Configurações; padrão "Seguir o sistema". |
| R4 | **Modo foco / tela cheia** | ⋮ "Modo foco" e botão de tela cheia | No iPhone o app já é sempre "tela cheia" | Tirar os dois no iPhone (o botão já saiu). |
| R5 | **Comandos rápidos e copiados** | ⋮ e barra de atalhos (⚡, 📋) | Duplicado; só fazem sentido com um terminal aberto | Só na barra de atalhos. |
| R6 | **Reabrir aba fechada** | ⋮, histórico da folha de sessões, "Sessões recentes" da página de apps | Três lugares para a mesma lista | Histórico da folha de sessões (é onde se troca de aba). Página de apps fica só para criar. Tirar do ⋮. **Decidir com o dono** se a página de apps mantém os recentes. |
| R7 | **Lista de sessões** | pílula e botão de lista na barra de status | Duplicado no iPhone | Tirar o botão da barra de status no iPhone. |
| R8 | **Seletor de tipo no formulário** | página de apps e de novo no formulário | O tipo já foi escolhido no ícone | Esconder no formulário (já está no prompt, 4.6). |
| R9 | **Formulário de nome/pasta** | toda vez que se cria Terminal, Navegador ou Arquivos | Pede o que quase sempre fica no padrão ("Automático", pasta atual) | Criar direto com o padrão; formulário só com toque longo no ícone ("Personalizar…"). |
| R10 | **Escolher o agente** | ⋮ → lista de agentes; ícone Agente → lista; digitar `claude` → popup "Deseja usar o modo UI?" | Pergunta toda vez a mesma coisa | Agente padrão lembrado; o popup some no iPhone depois da primeira resposta (já existe "lembrar minha escolha" em `agent-prefs`: marcar por padrão). |
| R11 | **Ações do chat do agente** | 6 botões no cabeçalho + ⋮ global + folha do compositor | Cabeçalho cheio numa tela estreita | Cabeçalho só com título e status; as 6 ações vão para o ⋮, que passa a ser da aba atual (seção 5). |
| R12 | **Estado da conexão** | pílula (ícone pulsa), ponto na barra de status, ponto na marca (desktop) | Três indicadores | No iPhone, a pílula basta; a barra de status pode sumir e o aviso aparece só quando a conexão cai. Ganha ~38 px de tela. |
| R13 | **Tela dividida** | ⋮, menu da aba, vibecoding (agente \| prévia) | Em retrato no iPhone, cada metade fica pequena demais | No iPhone, sem divisão: agente e prévia viram duas telas cheias ligadas por gesto e pelo 👁 (seção 6). |
| R14 | **Push que não leva ao lugar** | push de permissão abre a raiz do app | O usuário precisa procurar a conversa | Mandar `url` com a aba (ex.: `/?tab=<id>`) e ativar essa aba ao abrir. |

---

## 5. Layout proposto (iPhone)

Três camadas, como no iOS:

1. **Conteúdo** em tela cheia: a aba atual (terminal, chat, navegador, arquivos, anotações).
2. **Navegação**, sempre no mesmo lugar e com gesto + botão visível:
   - **pílula da sessão** (topo): trocar, histórico, nova aba; deslizar para os lados troca de aba;
   - **borda esquerda**: "voltar"; na raiz, abre a página de apps;
   - **borda direita**: avançar para a tela ligada (no vibecoding, a prévia).
3. **Ações**, num lugar só:
   - **⋮ contextual**: primeiro as ações da aba atual (as do menu da aba + as do cabeçalho do agente
     + Buscar no terminal), depois uma linha, depois **Configurações**, Guia e Sair.
   - **toque longo** no que for item (aba na folha, ícone de app) para opções avançadas.
   - **folhas** para conjuntos de opções (Configurações, Modelo e configurações do agente).

Como fica o ⋮ no iPhone, por tipo de aba (máximo ~8 itens):

| Terminal | Chat do agente | Navegador |
|---|---|---|
| Buscar no terminal | Conversas anteriores | (o ••• da barra já cobre) |
| Nova conversa com agente aqui | Abrir terminal na pasta | Abrir pasta nos Arquivos |
| Abrir pasta nos Arquivos | Abrir arquivos da pasta | Renomear |
| Renomear · Fixar · Duplicar | Trocar agente · Publicar (vibecoding) | Fixar · Duplicar |
| Fechar | Painel do agente · Fechar | Fechar |
| — | — | — |
| Configurações · Guia · Sair | Configurações · Guia · Sair | Configurações · Guia · Sair |

Nada some: criar está na página de apps; reabrir no histórico; tema, foco e comandos nas
Configurações ou na barra de atalhos; dividir tela continua no desktop.

---

## 6. Vibecoding no iPhone: agente ↔ prévia por gesto e 👁

**Faz sentido?** Sim, por três motivos:
- em retrato, a tela dividida agente | prévia deixa cada metade com ~340 px de altura (852 px menos topo e barras, dividido por dois): ruim para
  ler o chat e ruim para ver a página;
- agente e prévia são **duas telas do mesmo projeto**, não abas independentes: um gesto que vai e
  volta entre elas é mais natural do que procurar na lista de abas;
- é o modelo de navegação do iOS: **borda esquerda = voltar**, **borda direita = avançar**.

**Proposta:**
- Num projeto de vibecoding (`Vibe.projectForTab` / `GET /api/vibe/tab/:tabId`), no iPhone em
  retrato, **não dividir a tela**: o agente fica em tela cheia e a prévia é a tela "seguinte".
- **Arrastar da borda direita para a esquerda** no chat do agente abre a prévia (com o mesmo círculo
  de vidro do gesto de apps, mas com o ícone 👁 `eye`).
- **Arrastar da borda esquerda para a direita** na prévia volta ao agente. Ou seja, a borda esquerda
  é "voltar": só abre a página de apps quando não há uma tela anterior ligada. Isso resolve o
  conflito com o gesto atual e segue o iOS.
- **Botão visível 👁 "Prévia"** no chat do agente (gestos não aparecem; a Apple pede sempre uma
  alternativa visível): uma cápsula de vidro pequena no canto superior direito do chat, ou um item
  na pílula de resumo do compositor. Na prévia, o botão voltar da barra do Safari, quando a página
  não tem histórico, vira "‹ Agente" (ícone de chat).
- A prévia continua recarregando sozinha quando um arquivo é salvo (live reload já existe); quando
  o agente terminar um passo e a prévia recarregar, um aviso discreto "Prévia atualizada · ver" no
  chat leva para lá com um toque.

---

## 7. Ordem sugerida de implementação

1. **R14** (push abre a conversa): pequeno e resolve a jornada mais urgente.
2. **R1 + R3 + R4 + R5 + R6 + R11**: ⋮ contextual no iPhone (só reorganiza menus, sem lógica nova).
3. **R9 + R10**: criar direto com padrões; toque longo para personalizar; agente padrão lembrado.
4. **R2**: folha de Configurações dentro do app.
5. **Seção 6**: vibecoding com gesto e 👁 (depende do gesto de borda já existente).
6. **R7 + R12**: barra de status some no iPhone; aviso só quando a conexão cai.

Cada item deve vir com a contagem de toques antes/depois no PR, para provar que reduziu.
