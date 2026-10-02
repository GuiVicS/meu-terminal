# Checklist de testes manuais

Para passar o app inteiro na mão depois de todo o trabalho recente (galeria inicial, editor de
anotações, `/admin`, backup automático, webhooks, anotações em arquivo `.md`). Marque cada item
conforme for testando. Teste pelo menos uma vez no computador e uma vez no celular — várias coisas
aqui (barra de atalhos, gestos, PWA, câmera do QR code) só existem ou só quebram no celular.

> **Antes de começar**: alguns itens abaixo dependem de PRs que ainda não estão no `main`. Está
> marcado em cada seção quando é o caso, com a branch/PR correspondente. Se for testar tudo de uma
> vez, dá para juntar as branches localmente (`git merge`) antes, ou testar cada PR no ar separado.

---

## 1. Login e acesso

- [ ] Login com email e senha (se configurado) entra e fica logado depois de recarregar a página.
- [ ] PIN (se não houver email/senha configurado) entra com o PIN certo e recusa um PIN errado.
- [ ] Depois de 5 tentativas erradas, a tela avisa o bloqueio temporário e recusa até passar o tempo.
- [ ] Verificação em duas etapas (2FA), se ligada: pede o código do app autenticador depois da senha.
- [ ] Logout (menu ⋮ → Sair) encerra a sessão e volta para o login.
- [ ] **Conectar outro aparelho por QR code**: em Configurações → Aparelhos, mostrar o QR code num
  aparelho já logado e escanear com a câmera de outro (celular) entra sem digitar a senha. Testar
  que o código para de funcionar depois de 2 minutos ou de já ter sido usado uma vez.
- [ ] Acessar sem estar logado redireciona para `/login` (tentar `/`, `/admin`, uma URL de API direto).

## 2. Tela inicial (galeria de apps)

- [ ] Sem nenhuma aba aberta, o app mostra a galeria (Terminal, Navegador, Arquivos, Anotações,
  Agente, Vibecoding) em vez de abrir algo por conta própria.
- [ ] Tocar em cada ícone abre o formulário certo (nome + pasta/endereço/agente conforme o tipo).
- [ ] O botão **+** na barra de abas também abre essa galeria.
- [ ] Reabrir uma aba fechada recentemente aparece na mesma tela da galeria.
- [ ] Atalhos de teclado abrem a aba direto, sem passar pela galeria: `Ctrl+Alt+T` (terminal),
  `Ctrl+Alt+B` (navegador), `Ctrl+Alt+E` (arquivos).

## 3. Terminal

- [ ] Criar uma sessão de terminal nova, digitar comandos, ver a saída normalmente.
- [ ] Fechar a aba (✕) encerra o processo de verdade (confirmar com `ps` em outra aba que ele não
  continua rodando).
- [ ] Fechar só o app/navegador (sem clicar no ✕) e abrir de novo: a sessão continua viva, com o
  histórico do terminal preservado.
- [ ] Reordenar abas (arrastar) e recarregar a página: a ordem é mantida.
- [ ] No celular: barra de atalhos (setas, Ctrl, Tab, Esc etc.) funciona e os gestos (deslizar para
  trocar de aba, etc. — conforme o guia) funcionam.
- [ ] Comandos rápidos (Configurações → Comandos rápidos): criar um, usá-lo num terminal, editar,
  excluir.
- [ ] Histórico de copiados (clipboard) mostra o que foi copiado no terminal e permite colar de novo.
- [ ] Ditado por voz (ícone de microfone) transcreve e insere o texto no terminal.
- [ ] Modo fila / pastas / rascunho / histórico do terminal (se aplicável na sua versão) funcionam
  como esperado ao navegar entre sessões.

## 4. Navegador (Chromium no servidor)

- [ ] Criar uma aba de navegador com um endereço (ex.: `localhost:3000` de outro projeto rodando no
  servidor) e ver a página carregar.
- [ ] **Tela dividida**: abrir um terminal e uma aba de navegador lado a lado.
- [ ] **Recarregar ao salvar**: com um projeto rodando (ex.: um site HTML), editar um arquivo e ver
  a prévia recarregar sozinha.
- [ ] Navegar para frente/trás, abrir uma nova URL na mesma aba.

## 5. Arquivos

- [ ] Ver, abrir e editar um arquivo de texto do servidor.
- [ ] Enviar (upload) e baixar (download) um arquivo.
- [ ] Copiar, mover, renomear e excluir um arquivo/pasta.
- [ ] Busca de arquivos por nome.
- [ ] Favoritos: marcar uma pasta, ela aparece na lista de favoritos, desmarcar remove.
- [ ] **Google Drive (rclone)**: configurar um remote, navegar pelos arquivos do Drive, enviar/baixar
  algo de lá.
- [ ] **Backup da home** (pela aba Arquivos, diferente do backup automático do `/admin`): gerar um
  backup manual e confirmar que o arquivo aparece no destino configurado.

## 6. Anotações

> Esta seção descreve a versão **atual do `main`** (editor com tela de escrever/visualizar e notas
> guardadas no banco SQLite). Se o PR `feat/notes-file-storage` (#19) já estiver mesclado, veja a
> subseção **6a** abaixo também.

- [ ] Criar uma nota nova, digitar texto com Markdown (títulos, listas, checklist `- [ ]`), ver a
  formatação aparecer corretamente na visualização.
- [ ] Marcar/desmarcar um item de checklist direto na visualização (sem precisar editar o texto).
- [ ] Editar o título — ele aparece atualizado na lista.
- [ ] Buscar notas por texto e por tag.
- [ ] Adicionar/remover tags de uma nota; filtrar a lista por tag.
- [ ] Fixar uma nota (ela sobe para o topo da lista) e desafixar.
- [ ] Mover uma nota para a lixeira, restaurar, e apagar de vez.
- [ ] Salvamento automático: editar uma nota, esperar um pouco, recarregar a página sem salvar
  manualmente — a edição deve estar lá.
- [ ] Abrir a mesma nota em dois aparelhos (ou duas abas) e confirmar que uma edição aparece no
  outro depois de recarregar (sincronização entre aparelhos).

### 6a. Se `feat/notes-file-storage` (PR #19) já estiver no ar

- [ ] Depois de criar uma nota, confirmar que existe um arquivo `.md` de verdade na pasta configurada
  (`NOTES_DIR`, padrão `data/notes/`), com o **nome do arquivo igual ao título** da nota.
- [ ] Abrir esse arquivo `.md` num editor qualquer (fora do MeuTerminal) e ver o frontmatter
  (`id`, `tags`, `pinned`, `created`, `updated`) e o corpo em Markdown puro.
- [ ] Editar o `.md` direto no disco (fora do app) e recarregar a lista de notas no MeuTerminal: a
  mudança deve aparecer.
- [ ] Renomear o título de uma nota com o mesmo nome de outra já existente: o arquivo deve virar
  `Nome (2).md` em vez de sobrescrever a outra.
- [ ] Mover para a lixeira e confirmar que o arquivo foi para a subpasta `.trash` dentro de
  `NOTES_DIR`, não apagado de verdade.
- [ ] Reiniciar o servidor (`docker compose restart` ou `npm start` de novo) e confirmar que as
  notas continuam todas lá (persistência real em arquivo, não em memória).
- [ ] Acentos e caracteres especiais (ex.: "café", "ação", "§") no título e no corpo sobrevivem
  intactos depois de salvar e recarregar.

## 7. Agentes (MCP) e modos especiais

- [ ] Rodar o comando mostrado em Configurações → Agentes num terminal do app (registra o MCP no
  Claude Code) e confirmar que o agente reconhece as ferramentas do MeuTerminal.
- [ ] Pedir ao agente para abrir uma página (`open_url`) e ver a aba de navegador abrir ao lado do
  terminal dele.
- [ ] **Modo UI dos agentes**: digitar `claude` (ou `codex`/`opencode`) num terminal e aceitar abrir
  no modo com chat, ferramentas, diffs e pedidos de permissão. Testar aprovar e negar uma permissão.
- [ ] **Vibecoding**: criar um projeto novo pelo formulário (nome, tipo, pasta, agente), confirmar
  que a pasta é criada (com `git init` se marcado), a tela divide em terminal do agente + prévia ao
  vivo, e os arquivos do projeto abrem numa aba separada.
- [ ] Notificação (`notify` do MCP): pedir ao agente para notificar algo e ver o aviso chegar no
  celular (com Notificações ativadas em Configurações).

## 8. Notificações push

- [ ] Ativar notificações neste aparelho (Configurações → Notificações).
- [ ] Botão "Enviar teste" entrega uma notificação de verdade, com som, mesmo com o app em segundo
  plano ou fechado.
- [ ] Desativar e confirmar que o teste não chega mais.

## 9. PWA

- [ ] Instalar o app no celular (via o prompt do navegador ou "Adicionar à tela inicial").
- [ ] Abrir pelo ícone instalado e confirmar que abre em tela cheia, sem a barra do navegador.
- [ ] Publicar uma nova versão (deploy) e confirmar que o app instalado atualiza sozinho (ou avisa
  para atualizar) em vez de ficar preso numa versão antiga.

## 10. `/admin` (tela de configurações cheia)

- [ ] Abrir `/admin` (ou pelo atalho que substituiu o popup) e navegar entre todas as seções do
  menu lateral: Comandos rápidos, Terminal, Interface, Sessão, Backup, Aparelhos, Notificações,
  Agentes, e Webhooks (se a flag estiver ligada).
- [ ] Funciona em tela de celular (menu lateral recolhível) e no computador.
- [ ] Alterar uma opção em `/admin` (ex.: tema) e confirmar que o app principal reflete a mudança
  sem precisar recarregar.
- [ ] Todas as opções que existiam no popup antigo de Configurações continuam presentes aqui, sem
  nada faltando.

### 10a. Backup automático (parte do `/admin`)

- [ ] Ligar o backup automático, escolher um remote do rclone já configurado e uma pasta de destino.
- [ ] "Fazer backup agora" gera um backup de verdade e aparece no histórico (data, tamanho, status).
- [ ] Configurar "manter os últimos N" e confirmar que backups mais antigos são removidos do remote
  depois de um novo backup passar do limite.
- [ ] Esperar o intervalo configurado (ou simular) e confirmar que o backup automático dispara sem
  precisar abrir o app.

## 11. Webhooks (requer `WEBHOOKS_ENABLED=true` — PRs #18 e #20, branch `feat/webhooks-public`)

### CRUD e execução manual (em `/admin` → Webhooks)

- [ ] Criar um webhook a partir de um modelo pronto (ex.: "Atualizar repositório") e confirmar que
  script e inputs já vêm preenchidos.
- [ ] Criar um webhook personalizado do zero, com script bash e pelo menos um input de cada tipo
  que for usar (texto, número, boolean, select, secret).
- [ ] Editar o script e os inputs de um webhook existente; confirmar que uma nova versão aparece em
  "Versões" só quando o script/inputs realmente mudam (editar só o nome não deve criar versão nova).
- [ ] Duplicar um webhook: a cópia tem um slug novo e **não** vem com os tokens do original.
- [ ] Excluir um webhook e confirmar que ele desaparece da lista e seus tokens deixam de funcionar.
- [ ] Aba **Testar**: preencher os inputs, "Executar agora" e ver a saída ao vivo, código de saída e
  status.
- [ ] Aba **Histórico**: cada execução (manual ou via token/HMAC) aparece com data, origem, inputs
  (com os `secret` mascarados como `••••`), código de saída e saída truncada.
- [ ] Um input do tipo `secret`: configurar o valor na aba de Inputs/Acesso, e confirmar que ele
  **nunca** aparece em texto puro em lugar nenhum da tela (histórico, preview) — só `••••`.
- [ ] Concorrência "fila": disparar duas execuções rápido e ver a segunda esperar a primeira acabar.
  "ignorar se já estiver rodando": a segunda é rejeitada. "cancelar a anterior": a primeira é
  interrompida e a segunda roda.
- [ ] Um script que estoura o tempo limite configurado é encerrado e aparece como "timeout" no
  histórico (processos filhos dele — ex.: um `sleep` dentro do script — também são encerrados, não
  ficam soltos no servidor).

### Tokens e disparo externo (`POST /hooks/<slug>`)

- [ ] Criar um token para um webhook: o valor completo só aparece **uma vez**, na hora da criação.
- [ ] Disparar o webhook de fora com `curl`:
  ```bash
  curl -X POST https://seu-dominio/hooks/<slug> \
    -H "Authorization: Bearer mtwh_..." \
    -H "Content-Type: application/json" \
    -d '{"CAMPO": "valor"}'
  ```
  Deve responder `202` com um `run_id`, e a execução aparece no histórico do `/admin` com origem
  pelo IP de quem chamou.
- [ ] Chamar sem o header `Authorization`, com um token errado, ou com um slug que não existe: as
  três devem responder o **mesmo** `404 {"error":"nao_encontrado"}` — não dá para distinguir qual
  foi o motivo de fora.
- [ ] Revogar um token e confirmar que ele deixa de funcionar imediatamente.
- [ ] Passar o token na URL (`?token=...`) em vez do header: deve ser recusado (token só é aceito
  no header `Authorization`).
- [ ] Disparar o mesmo webhook mais vezes do que o limite configurado (`ratePerMin`) dentro de um
  minuto: as chamadas depois do limite voltam `429 {"error":"limite"}`.
- [ ] Depois de 5 tentativas com token errado do mesmo IP, chamadas seguintes (mesmo com token
  certo) voltam `429` por um tempo (bloqueio temporário do IP).
- [ ] Se o webhook tiver "IPs permitidos" configurado, chamar de um IP fora da lista deve ser
  recusado (mesmo `404` genérico).
- [ ] `?wait=10` na URL: se o script terminar dentro dos 10s, a resposta já vem com o resultado
  final (`exit_code`, saída) em vez de só `202`.
- [ ] Um input com `source` configurado (`body.algumacoisa`, `query.x`, `header.x-evento`) pega o
  valor do lugar certo quando chamado de fora.
- [ ] Um input com `extract` (ex.: tirar a branch de um `ref` do GitHub: `refs/heads/main` → `main`)
  funciona corretamente **depois de o webhook já ter sido salvo e recarregado** (criar o webhook,
  recarregar a página do `/admin`, e só então disparar — não só testar na mesma sessão em que foi
  criado).

### Modo HMAC (assinatura, estilo GitHub/Stripe)

- [ ] Configurar um webhook para modo HMAC com um segredo.
- [ ] Simular um disparo do GitHub: calcular `X-Hub-Signature-256: sha256=<hmac-sha256 do corpo>`
  com o segredo configurado e mandar — deve executar.
- [ ] Mandar com uma assinatura errada, ou alterar o corpo depois de calcular a assinatura (corpo
  não bate mais com a assinatura): deve recusar com o `404` genérico.
- [ ] Mandar duas vezes a mesma requisição com o mesmo `X-Request-Id` (ou `Idempotency-Key`): a
  segunda deve ser tratada como repetida (não executa de novo), mesmo com a assinatura válida.

## 12. Segurança geral (conferir de propósito, não só por acaso)

- [ ] Um valor de input com `;`, `` ` ``, `$()`, aspas ou quebra de linha, mandado para um webhook,
  aparece **intacto** como texto na saída do script — nunca é interpretado como comando.
- [ ] A rota `/hooks/*` não existe (dá 404) quando `WEBHOOKS_ENABLED` não está `true`.
- [ ] Sem estar logado, nenhuma rota de `/api/*` ou `/admin` responde dados — todas redirecionam
  para `/login` ou dão 401/403.
- [ ] O token do MCP e os tokens de webhook nunca aparecem em texto puro em lugar nenhum além do
  momento em que são criados.

---

**Depois de rodar este checklist**: qualquer item que falhar, anote o passo exato e o que
aconteceu em vez do esperado — isso é o que entra num relatório de bug (não precisa já saber a
causa).
