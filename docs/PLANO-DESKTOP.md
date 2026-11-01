# Plano: tema iOS no desktop + chat como o Claude Desktop

Situação em 2.14.0 (fotos do desktop 1440×900 tiradas para este plano) e o que muda. Nada aqui
está implementado ainda.

## 1. Caminho de uso: o que você já faz no celular e como fica no desktop

O desktop deve repetir os hábitos do celular (mesmos nomes, ícones, cores, ordem), só trocando
gestos por clique/teclado e aproveitando a largura.

| Tarefa | Celular hoje (2.14) | Desktop hoje | Desktop proposto |
|---|---|---|---|
| Ver/achar conversas | ☰ na bolinha ou arrastar da esquerda → lista lateral (Fixadas, Recentes, busca, online, girando) | Não existe; só o ícone de histórico (menu) | **Barra lateral fixa** com a mesma lista (recolhível ⌘B) |
| Nova conversa | "Nova conversa" no rodapé da lista; menu Agente → lista com "Nova conversa" no topo | Abre aba nova direto | Botão **Nova conversa** no topo da barra lateral (⌘⇧O) + tela vazia com o campo no centro |
| Trocar de conversa do mesmo agente | Toque na lista (uma aba por agente) | Abas | Clique na barra lateral; abas ficam para terminal/arquivos/notas/navegador |
| Trocar modelo / rota / conta | Seletor no campo; botão da rota | Fileira de seletores acima do campo | Dentro do campo, canto inferior (como o Claude): **modelo ▾**, rota/conta num menu "⋯" |
| Aprovar permissão do agente | Cartão no chat | Cartão no chat **e** barra embaixo (duplicado), em inglês | **Um cartão só**, em português ("Permitir", "Permitir sempre", "Recusar"), teclas ⏎/Esc |
| Abrir outro app (terminal, arquivos, notas, navegador) | Página de apps (grade) | Página de apps (grade) em tela cheia | Seção **Apps** na barra lateral + ⌘T com a grade em janela central |
| Configurações | Página inteira com seções estilo Ajustes do iPhone | /admin (página separada) | **Janela de Ajustes estilo macOS**: lista à esquerda, detalhe à direita, sem sair do app |
| Apagar / fixar conversa | Toque longo → menu | — | Clique direito ou "⋯" ao passar o mouse na linha |
| Colar imagem / arquivo | Botão + e colar | Clipe + colar | Arrastar e soltar no chat inteiro + colar (⌘V) |

## 2. Tema iOS no desktop (macOS / iPadOS)

Mesmos tokens do celular (`--glass-*`, roxo `--accent`, Inter), com regras de desktop:

- **Barra lateral translúcida** (vidro do sistema, `--glass-blur` só nela e na barra de cima:
  vidro em muitos elementos grandes foi o que pesou no celular - orçamento: no máximo 3 superfícies
  com desfoque por tela).
- **Barra de cima unificada** (como Safari/Finder): botão da barra lateral, abas compactas em
  pílula (arrastáveis, ⌘1-9), título da conversa, ações à direita.
- **Abas estilo Safari**: pílulas arredondadas, ícone do tipo, fechar ao passar o mouse, a ativa
  com fundo de vidro; mais de 8 abas → rolagem horizontal + menu "todas as abas".
- **Controles**: interruptores do iOS, controle segmentado, menus de contexto estilo macOS
  (cantos 10 px, separadores finos, atalho à direita), folhas centralizadas (não de baixo).
- **Estados de mouse**: hover em tudo que é clicável, foco visível pelo teclado, cursor certo.
- **Espaçamento 8 pt**, raios 10/12/16, sombras suaves; claro e escuro.
- **Tipografia**: Inter com pesos do SF (títulos 600, corpo 400, 15 px no chat), mono JetBrains.

## 3. Chat no desktop como o Claude Desktop

Layout em três colunas:

```
┌──────────────┬──────────────────────────────────────────┬──────────────┐
│ ☰  Nova conv.│  Título da conversa       Direto ▾   ⋯   │              │
│ 🔍 Buscar    ├──────────────────────────────────────────┤  Painel      │
│              │                                          │  (Plano,     │
│ Fixadas      │      coluna de leitura (máx. 760 px)     │  arquivos,   │
│  • conversa  │      você: balão à direita, discreto     │  comandos)   │
│ Recentes     │      agente: texto corrido, sem balão    │  - abre com  │
│  ◌ girando   │      ferramentas: "Usou 3 ferramentas ▸" │  ⌘\ ou ao    │
│  • online    │      raciocínio: recolhido               │  clicar num  │
│ Apps         │                                          │  arquivo     │
│  Terminal …  │  ┌────────────────────────────────────┐  │              │
│              │  │ Responder…                         │  │              │
│ ⚙ Ajustes    │  │ +  📎            Claude Sonnet ▾  ↑ │  │              │
└──────────────┴──┴────────────────────────────────────┴──┴──────────────┘
```

- **Tela vazia**: saudação ("Boa tarde, Gui"), campo grande no centro, atalhos de sugestão
  (Continuar a última, Revisar o projeto, Abrir terminal aqui) e a pasta atual como chip.
- **Mensagens**: coluna central (máx. 760 px); as suas em balão discreto à direita; as do agente
  em texto corrido; botões copiar/refazer ao passar o mouse; blocos de código com cabeçalho fixo.
- **Ferramentas**: agrupadas ("Leu 4 arquivos, rodou 2 comandos ▸"), abrem em detalhe; diffs no
  painel da direita.
- **Campo de mensagem** (o principal): cartão arredondado com sombra, cresce até 40% da altura,
  anexos como miniaturas dentro dele; embaixo à esquerda "+" (anexar, comando /, modo plano) e à
  direita **modelo ▾** e enviar/parar. Rota e conta no "⋯" do topo.
- **Permissões**: só o cartão no chat; ⏎ permite, Esc recusa; "Permitir sempre nesta conversa".
- **Teclado**: ⌘K busca tudo (conversas, apps, comandos), ⌘⇧O nova conversa, ⌘B barra lateral,
  ⌘\ painel, ⌘L foco no campo, ↑ edita a última mensagem, Esc para o agente, ⌘⇧C copia a resposta.
- **Várias conversas rodando**: na barra lateral, círculo girando e bolinha (o mesmo do celular);
  notificação do sistema quando termina/pede permissão com a aba em segundo plano.

## 4. Fases

| Fase | Entrega | Pronto quando |
|---|---|---|
| 0. Base | Tokens de desktop (`[data-desktop]`), orçamento de desfoque, medição de desempenho no CI (o `perf.js` desta rodada) | Medição roda e falha se piorar >15% |
| 1. Barra lateral | Lista lateral do celular reaproveitada (`conversationDrawer.js` em modo fixo), Nova conversa, busca, Apps, Ajustes; ⌘B | Mesmas ações do celular por clique e teclado |
| 2. Chat | Coluna central, mensagens estilo Claude, ferramentas agrupadas, tela vazia | Conversa longa rola a 60 fps; nada de largura fixa à esquerda |
| 3. Campo | Cartão novo com modelo ▾ dentro, anexos, arrastar e soltar | Mesmas opções do campo atual, menos cliques |
| 4. Permissões | Cartão único em português, atalhos ⏎/Esc | Sem barra duplicada; textos traduzidos |
| 5. Abas e tema | Abas estilo Safari, menus/folhas macOS, Ajustes em janela | Navegação por teclado completa; claro/escuro |
| 6. Painel direito | Plano, arquivos, diffs, comandos, abre ao clicar | ⌘\ alterna; lembra o estado |
| 7. Atalhos e ⌘K | Paleta de comandos | Tudo acessível sem mouse |

Cada fase: branch própria, testes de navegador (1440×900 e 1280×800, claro e escuro), medição
de desempenho antes/depois, deploy só com o seu sim.

## 5. Riscos e decisões

- **Desempenho**: desfoque só na barra lateral e na barra de cima; `content-visibility` nas
  mensagens; nada de animar variáveis CSS em contêineres grandes (lição da lista lateral).
- **Não quebrar o celular**: todo estilo novo sob `[data-desktop]`; o celular não muda.
- **Abas x barra lateral**: conversas de agente saem das abas (ficam na barra lateral); terminal,
  arquivos, notas e navegador continuam em abas. Dá para fixar uma conversa como aba se quiser.
- **Textos em inglês vindos do agente** ("Allow", "Reject"): tradução no MeuTerminal pelos tipos
  de opção do ACP (`allow_once`, `allow_always`, `reject_once`), não pelo texto.
