# Troca de arquivos entre o Claude e o MeuTerminal

Revisão do plano de 01/11/2026, conferida contra o código da Ponte (`scripts/remote/tools.js`,
`routes/remote.js`) e com quatro ferramentas novas na versão 2.12.0.

## Ideia central

**Arquivo não passa pela conversa.** Os bytes viajam direto entre o servidor, o seu celular/computador
e a internet; para mim chega só o que preciso olhar: tamanho, sha256, alguns quadros de um vídeo, um
texto extraído. Tudo o que entra na conversa (base64, por exemplo) gasta contexto e tem limite pequeno.

## O que mudou em relação ao plano anterior

| Antes | Agora |
|---|---|
| Arquivo grande do usuário só pelo Google Drive | **`upload_link`**: um link com uma página onde você escolhe os arquivos no celular ou no computador; eles vão direto para `troca/entrada`, de qualquer tamanho (padrão até 20 GB por arquivo) |
| Conferir tamanho e hash com comandos soltos | **`file_info`**: tamanho exato, sha256, tipo e, para vídeo/áudio, duração, formato e resolução |
| Ver um vídeo exigia baixar ou cortar à mão | **`media_preview`**: alguns quadros do vídeo (ou a imagem reduzida) chegam como imagens que eu vejo direto |
| Pastas de troca a criar | `troca/entrada` e `troca/saida` existem sempre na pasta de trabalho da Ponte (`/root/claude`) |
| `ffmpeg` não instalado | `ffmpeg`, `ffprobe` e `file` vêm na imagem |
| "`upload_base64` até 2 MB" sem ressalva | Confirmado no código: 2 MB **depois** de decodificar, e o base64 passa pelo contexto (≈2,7 MB de texto). Na prática, use só para arquivos de poucas centenas de KB |

## Ferramentas e limites reais

| Direção | Ferramenta | Limite (do código) | Observação |
|---|---|---|---|
| Você → servidor, qualquer tamanho | `upload_link` + `upload_received` | Padrão 20 GB por arquivo, até 100 GB; link de 1 min a 24 h (padrão 60 min); exige ≥ 2 GB livres depois do arquivo | Grava em fluxo, calcula o sha256 enquanto recebe, nunca sobrescreve (`nome (2).ext`) e anota em `manifest.txt` |
| Eu → servidor, pequeno | `upload_base64` | 2 MB decodificados | Passa pelo contexto |
| Eu → servidor, texto | `write_file` | 5 M caracteres | Também grava num remote do rclone |
| Internet → servidor | `fetch_url` | Tempo máximo 600 s; para mais, `start_job` com `curl`/`wget` | Não passa pela conversa |
| Servidor → você | `share_link` | Link de 1 min a 24 h (padrão 30 min); só arquivo (pasta: compacte antes) | Some se o servidor reiniciar |
| Servidor → eu, texto | `read_file` | Até 2.000 linhas por chamada | Leia por partes |
| Servidor → eu, saída de job | `job_output` | 48 KB por leitura | Use `offset` |
| Servidor → eu, mídia | `media_preview` | Até 8 quadros, até 1280 px | Só as imagens, nunca o arquivo |
| Verificação | `file_info` | Qualquer tamanho (lido em fluxo) | sha256 + ffprobe |
| Servidor ↔ Google Drive | `rclone` (`run_command`/`start_job`), `list_dir`/`read_file` com `source: gdrive` | Limite do Drive | Opcional: o `upload_link` já cobre a maioria dos casos |

Os links (`share_link` e `upload_link`) ficam só na memória do servidor: um reinício (deploy) encerra
todos. Isso é proposital para links de "agora".

## Regra por tamanho

| Tamanho | Você → servidor | Eu → servidor | Servidor → você | Servidor → eu |
|---|---|---|---|---|
| Até ~300 KB | `upload_link` (ou anexo no chat, que eu reenvio com `upload_base64`) | `upload_base64` | `share_link` | `read_file` (texto) ou `media_preview` |
| Acima de ~300 KB | `upload_link` | Gero no próprio servidor (`run_command`) ou baixo da internet (`fetch_url`) | `share_link` | Só o essencial: `file_info`, `media_preview`, texto extraído |
| Vários arquivos ou pastas | `upload_link` (aceita vários) ou Drive | — | Compacto em `troca/saida` e `share_link` | Listagem + amostras |

## Fluxos

**A. Você me manda arquivos (qualquer tamanho).**
1. Eu chamo `upload_link` e te entrego o link.
2. Você abre no celular ou no computador e escolhe os arquivos; a página mostra o progresso e o sha256 de cada um.
3. Eu chamo `upload_received`: vejo nome, tamanho e sha256 e confiro com o que a página te mostrou.

**B. Eu te entrego um resultado.**
1. O servidor grava em `troca/saida/`.
2. Eu chamo `file_info` (tamanho e sha256) e depois `share_link` com o menor prazo que servir.
3. Te passo o link, o tamanho e o sha256.

**C. Eu preciso ver um arquivo grande.**
- Vídeo: `file_info` (duração, resolução) e `media_preview` (quadros espalhados, ou só um trecho com `start_seconds`/`end_seconds`).
- Imagem grande: `media_preview` devolve uma versão reduzida.
- PDF, planilha, texto: o servidor extrai (`pdftotext`, `python`) para `troca/saida/` e eu leio com `read_file`.
- Pacotes e código: listo (`list_dir`, `tar -tf`) e abro só o necessário.

**D. Editar ou converter vídeo.**
O `ffmpeg` roda no servidor, como `start_job` com `notify=true` se for demorado; o resultado vai para
`troca/saida/`, conferido com `file_info` (duração e codec), e volta por `share_link`.

## Verificação (toda transferência)

- Compare tamanho e sha256 na origem e no destino: a página do `upload_link` e o `upload_received`
  mostram o sha256 do que chegou; `file_info` mostra o do arquivo no servidor.
- Vídeo: `file_info` mostra duração, codec e resolução.
- Se não bater, repita uma vez e avise. Nunca siga com um arquivo possivelmente corrompido.
- O `upload_link` recusa o envio se sobrarem menos de 2 GB livres; antes de gerar algo grande, confira com `server_info` ou `df -h`.

## Segurança e limpeza

- Links com o menor prazo possível; não publique o link fora da conversa. Um link de envio não serve para baixar, e um de download não serve para enviar.
- Gerar um `upload_link` passa pela mesma regra de aprovação no celular que gravar arquivos.
- Nada de credenciais pelos links ou pela conversa.
- Testes ficam em `tmp-claude-<assunto>/` e são apagados no fim. `troca/` só é esvaziada quando você confirmar que recebeu tudo; apagar arquivos pede aprovação.

## Testes feitos (2.12.0, container isolado)

Pelo mesmo caminho do claude.ai (OAuth com login e 2FA, ferramentas pelo `/mcp/remote`):
- `upload_link` → página sem login → arquivo de 25 MB enviado → sha256 idêntico; mesmo nome não sobrescreve; acima do limite é recusado (413).
- `upload_received` mostra tamanho e sha256; token de envio não baixa nada pelo `/dl/`.
- `file_info` em arquivo binário e em vídeo (duração, 1280x720, áudio aac).
- `media_preview`: 4 quadros de um vídeo de 10 s chegam como imagens.
- `share_link` devolve o arquivo com o mesmo sha256.

Ainda a testar com você: o limite do anexo no chat do claude.ai e o envio de um arquivo de vários GB pelo celular.

## Prompt pronto

Cole nas Preferências do Claude ou use na skill `meu-ambiente-servidor`:

```
Quando eu pedir para enviar, receber ou processar arquivos usando o MeuTerminal (Ponte):

1. Nunca passe arquivo grande pela conversa. Os bytes vão direto entre o servidor, eu e a internet; para a conversa vem só o essencial (file_info, media_preview, texto extraído).
2. Para eu te mandar arquivos (qualquer tamanho): gere um upload_link (pasta troca/entrada, menor prazo que servir) e me entregue o link. Depois confira com upload_received.
3. Para me entregar um resultado: grave em troca/saida, confira com file_info e gere share_link com o menor prazo possível. Me diga o link, o tamanho e o sha256.
4. Para ver um vídeo ou imagem grande: file_info + media_preview (quadros), nunca o arquivo inteiro.
5. upload_base64 só para arquivos de poucas centenas de KB; acima disso, gere ou baixe no próprio servidor (run_command, fetch_url, start_job).
6. Toda transferência: compare tamanho e sha256 na origem e no destino; se não bater, repita uma vez e me avise.
7. Processamento pesado (ffmpeg, conversão, OCR) roda no servidor; o demorado vai em start_job com notify=true.
8. Nada público, nada de credenciais, apague só o que você criou (com a minha aprovação quando pedir).
9. No fim, em poucas linhas: o que foi enviado/recebido, tamanho, resultado da verificação e onde está.
```
