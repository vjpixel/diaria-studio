---
name: diaria-publica-video
description: Publica os dois vídeos da edição ("diar.ia.br comentada", o Pixel comentando o D1) numa invocação — Parte A, o horizontal no canal @diariabr do YouTube (metadados derivados da edição, capa no padrão diar.ia.br, upload pela API com a legenda SRT — o agente sobe, o link entra no D1 sozinho; o YouTube Studio é só fallback, #11385) e Parte B, o vertical como YouTube Shorts, Reels nas páginas do Facebook, Instagram da diar.ia.br em collab com @vjpixel, perfil pessoal, X, Threads e LinkedIn (`scripts/publish-shorts.ts`). O vídeo vem da pasta `{AAMMDD}/Final/` do Drive (#11222). Roda depois do gate da Etapa 4 e antes do `/diaria-5-publicacao` (#10943), standalone, sem encadear. Substitui `/diaria-youtube` e `/diaria-shorts` (#11209), que viraram aliases. Uso — `/diaria-publica-video AAMMDD [--so horizontal|vertical] [--video-url URL]`.
---

# /diaria-publica-video AAMMDD (#11209)

Os dois vídeos da edição numa skill só (decisão do editor, 26–27/10/2026): **Parte A** é o horizontal no YouTube (`@diariabr`, #10659), **Parte B** é o vertical (Shorts, Reels e afins, #10769). A ordem A → B é a dependência real: o Short aponta para o horizontal (descrição, vídeo relacionado, #10831/#10811), então o horizontal vem primeiro. Juntar as duas não cruza gate nenhum da pipeline (#5578): roda depois do gate da Etapa 4 e antes do `/diaria-5-publicacao`, cada um numa sessão própria, e esta skill nunca roda a Etapa 5.

`/diaria-youtube AAMMDD` e `/diaria-shorts AAMMDD` continuam funcionando como **aliases** (`--so horizontal` e `--so vertical`). Este arquivo é o único com o fluxo; os dois antigos só redirecionam.

**Argumentos:**

- `AAMMDD` — obrigatório. Se não for passado, assumir D+1 com o banner padrão do `CLAUDE.md` (`Data não informada — assumindo {AAMMDD} (D+1). Passe AAMMDD explicitamente para outra edição.`), nunca perguntar, e passar a data explicitamente aos scripts (eles exigem).
- `--so horizontal|vertical` — roda só uma das partes (só um vídeo ficou pronto, ou o outro já saiu). Sem a flag, as duas, na ordem A → B.
- `--video-url URL` — o link do horizontal quando ele já está no canal (subido pelo Studio, fallback do Passo A5). Sem ele, a skill sobe o vídeo pela API (Passo A3, o padrão desde #11385).

**Retomada:** cada parte pula o que já foi feito, pelos registros em disco. Parte A está feita quando existe `_internal/05-video-url.txt` (link no D1) ou `_internal/05-youtube-published.json` com `videoId` desta edição; Parte B, destino a destino, por `_internal/06-shorts-published.json` (o `publish-shorts.ts` já pula o que está registrado). Só uma das partes presente no Drive vira aviso para a outra, nunca aborto.

## Passo 0 — Pré-condição: Stage 4 aprovado (#10943)

Fluxo do dia (#10943, revisto em #11209 e #11208): `/diaria-edicao` → `/diaria-video-montagem` (bruto até XML do Premiere, legendas e prévia; o editor exporta para `{AAMMDD}/Final/`) → `/diaria-publica-video` → `/diaria-5-publicacao`, cada skill numa sessão própria, nenhuma encadeia (#5578). O vídeo comenta o D1, e o D1 só está final depois do gate da Etapa 4, então esta skill só roda com o sentinel do Stage 4:

```bash
npx tsx scripts/pipeline-sentinel.ts exists --edition {AAMMDD} --step 4
```

- exit 0 → seguir.
- exit 1 → **parar**: "Etapa 4 (Revisão) da edição {AAMMDD} não aprovada (`_internal/.step-4-done.json` ausente). O D1 ainda pode mudar; aprove o gate (`/diaria-4-revisao {AAMMDD}` ou `/diaria-edicao {AAMMDD}`) e rode `/diaria-publica-video` depois." Vale para as duas partes, em dry-run ou não.

Ao terminar, sugerir o próximo comando (`/diaria-5-publicacao {AAMMDD}`) sem rodá-lo.

**Capa do Drive (#11542):** antes de A1/A2 e B1, rodar `fetch-drive-video.ts --edition {AAMMDD} --orientation horizontal` e depois `--orientation vertical` (primeiro com `--dry-run` para conferir; sem a flag para baixar). O fetch procura imagens JPG/JPEG/PNG com **Still** no nome em `Final/` e `Editado(s)/` da edição, nunca em outras edições ou na raiz. Sequência YouTube serve o horizontal; Instagram/Outras redes serve todos os verticais, inclusive nomes antigos como `261027 Vertical (Instagram).00_00_03_08.Still001.jpg`. Dois candidatos da mesma orientação, mesmo nome ou pastas diferentes, dão `needs-editor` com id/nome/modifiedTime: parar e registrar bloqueio, nunca desempatar por timecode. O JSON `cover` informa arquivo, origem e caminho. Baixa JPEG real em `04-youtube-thumb.jpg` / `04-youtube-short-capa.jpg`, substituindo capa gerada. Com `cover.source: "drive"`, **pular A2 inteiro, inclusive check-video-env**. Com capa local, preservá-la; sem capa, seguir o fallback de geração abaixo. Precedência: Drive > local gerada > frame automático. Relatar origem e destinos no fim.

O plano de `publish-shorts.ts` inclui `cover.path` e `cover.destinations`: Instagram usa `cover_url` (imagem pública no R2, inclusive no timer e na fila do Worker); sem R2, avisa no plano e usa frame automático. Desde #11547: YouTube Shorts pela API recebe `thumbnails.set` com o Still logo depois do `videos.insert` (medido pelo editor em 28/10/2026: HTTP 200 num Short; no passo guiado, Miniatura → Enviar arquivo no Studio); Facebook (Reels e `/videos`) recebe `POST /{video-id}/thumbnails` logo depois do upload; `linkedin_profile` sobe a miniatura (`uploadThumbnail`) e, se a falha for atribuível à capa, repete uma vez sem ela; X recebe só o `thumbnailOffset` (ms, do timecode do Still); Threads não tem parâmetro de capa. Capa é sempre opcional: falha vira `cover.ok: false` no registro e aviso, nunca derruba o vídeo. Sem `04-youtube-short-capa.jpg` na pasta da edição da máquina que publica (ex.: timer do 300 antes de o OneDrive replicar), o registro de cada destino traz `cover.method: "missing_local"` (#11660).

**Máquina (#11223):** a skill roda no Neo ou no `300` (comandada do celular, durante a viagem do editor). Antes da Parte A, saber se a capa sai nesta máquina:

```bash
npx tsx scripts/check-video-env.ts
```

Exit 0 → a capa (Passo A2) sai aqui. Exit 1 → o relatório diz o que falta (ffmpeg, Codex CLI, Georgia ou o venv do rembg) e o comando de setup; **nunca instalar no meio da skill**. No `300` o Codex fica em `~/.npm-global/bin/codex`, fora do PATH de shell não interativa: a sonda e o `codex-image.js` o acham lá sozinhos (#11532, `docs/codex-image-setup.md`). O `publish-youtube.ts --dry-run` sem capa pronta repete a lista em `cover_prerequisites`. Seguir com o resto e deixar a capa para o Neo (ou sem capa própria), avisando no relato final. O vertical não depende disso: o `publish-shorts.ts` baixa o vídeo da pasta `Final/` do Drive (`--from-drive`, Passo B1).

**Edição sem vídeo (#11125).** Se o editor disser que não vai gravar o vídeo do dia, marcar a edição com `npx tsx scripts/set-d1-no-video.ts {AAMMDD}`: grava `_internal/no-video.json`, apaga a cópia `04-d1-2x1-play.jpg` com o convite "Clique para assistir meus comentários" e faz o upload (`upload-images-public.ts --mode newsletter`) e o render pararem de usá-la — o D1 sai com o hero puro, sem link. Depois rodar o upload em modo newsletter (tira `d1_play` de `06-public-images.json`) e re-renderizar o HTML. O marcador vence a URL do vídeo; para religar, `--clear` e rodar o upload de novo.

## Onde está o vídeo (Drive, #11222)

Pasta `Mentoria Fluxo/VTSD/YouTube` (`publishing.youtube.drive_folder_id`), uma subpasta por edição (`{AAMMDD}/`). Desde a edição 261027, e assim em todas (palavra do editor), o vídeo pronto fica em **`{AAMMDD}/Final/`** — "Final" é o nome da PASTA, não do arquivo — com o destino no nome:

| Arquivo | Destino | Quem usa |
|---|---|---|
| `Diaria comentada_Youtube_V3.mp4` | horizontal | Parte A (YouTube) |
| `Diaria comentada_Vertical_V3.mp4` | vertical única | Parte B: todos os destinos verticais, inclusive Instagram |

**Variações (#11385).** A pasta também vale como "Finais" ou "Versão final"; sem `.mp4` nela, o fetch procura em **`{AAMMDD}/Editado/`** (e "Editados", "Edição", "Exportado"), com a mesma regra de destino — na 261028 o horizontal veio em `Editado/Diaria comentada_Youtube_FINAL.mp4`. Se ainda assim o fetch disser `none` e o arquivo estiver no Drive com outro nome ou lugar, subir direto do caminho do Drive for desktop: `publish-youtube.ts {AAMMDD} --upload --video "G:/…/arquivo.mp4"` (Passo A3), sem esperar o editor mover nada.

Desde #11491 há uma única vertical. Para edições antigas, na falta de `_Vertical_`, escolher `_Outras redes_` e por último `_Instagram_`, inclusive no timer e no Passo B3b. Ao lado de `Final/` fica o **bruto** (ex.: `20261026_191548.mp4`, 4K HEVC) — fonte do retrato da capa (Passo A2).

`scripts/fetch-drive-video.ts --edition {AAMMDD} --orientation horizontal|vertical [--target youtube|outras-redes|instagram]` escolhe o arquivo: com `.mp4` em `Final/`, só ela conta e o sufixo decide (sem exigir "final" no nome; a proporção do Drive só exclui um arquivo de orientação contrária). Sem `Final/` (edições antigas), vale a regra de 25/10/2026: `.mp4` com "final" como palavra no nome ("pré-final", "não final" e "finalizando" não contam), na subpasta `{AAMMDD}/` (sem janela; a raiz é ignorada quando ela existe), ou solto na raiz nas últimas 36h. Saídas:

- exit 0 `action: "none"` — nada no Drive ainda (o vídeo não subiu): seguir sem ele ou esperar;
- `premise` no JSON (`[premissa]` no stderr) — veio de `Editados/` com várias versões do mesmo destino (`_Youtube_V1`…`_V5`) e o fetch ficou com o maior `V{n}` (#11556; empate no `n` desfeito pelo `modifiedTime`). Repetir a premissa ao editor no resumo. Com `--promote` (implícito em `--download`) o escolhido é copiado para `Final/` (criada se faltar; `promoted` no JSON), e o timer do 300 lê o mesmo arquivo;
- exit 3 `needs-editor` — 2+ arquivos do mesmo destino em `Final/` (V2 e V3 lado a lado, `candidates`), ou em `Editados/` sem versão no nome ou empatados no mesmo `V{n}` e na mesma data, um "final" sem proporção (`files`) ou 2+ subpastas `{AAMMDD}` (`folders`): mostrar ao editor id, nome e `modifiedTime` de cada um (o Drive aceita nomes repetidos, o id é o que distingue) e esperar ele dizer qual; nunca escolher sozinho;
- exit 1 — pasta inacessível pela conta OAuth do projeto, rede ou token (renovar com `oauth-setup.ts`). Para conferir, o conector do Google Drive também serve (`search_files`, `mimeType contains 'video/'`).

## Parte A — Horizontal (YouTube)

Vídeo diário no YouTube (`@diariabr`) com o Pixel comentando o D1, decisão do editor de 21/10/2026 (1º vídeo: edição 261021, https://youtu.be/QRbXMprk9o0). O publisher é o mesmo do passo do Stage 5 (`scripts/publish-youtube.ts`, §5b-youtube do `orchestrator-stage-5.md`).

**Fluxo desde 261028 (#11385):** **o agente sobe o horizontal pela API** (`--upload`, Passo A3), com a capa e a legenda SRT; o próprio upload grava o link no D1 (`05-video-url.txt`). Invocar a skill já é o pedido de upload, como na Parte B; o editor não é o executor do upload. O YouTube Studio (Passo A5) é só fallback: a API falhou, ou o editor pediu para subir ele mesmo. Entre 261027 e 261028 o fluxo foi o inverso (o editor subia pelo Studio e colava o link, #11222) — o editor corrigiu: "você é quem faz isso".

### Passo A1 — Insumos e metadados (dry-run)

Na pasta da edição (`data/editions/{AAMM}/{AAMMDD}/`): `02-reviewed.md` é obrigatório (é de onde sai o D1).

```bash
npx tsx scripts/publish-youtube.ts {AAMMDD} --dry-run
```

O script tem três modos, e exatamente um é obrigatório (sem nenhum, ou com mais de um, sai exit 2): `--dry-run` (só o plano, sem rede; o Passo A1), `--upload` (Passo A3) e `--captions-only` (só a legenda do vídeo registrado, Passo A3). Flags opcionais: `--episode N` (número do episódio; default = cadência diária desde 261021 = #1), `--edition-url URL` (link da edição quando o slug publicado divergir do derivado do título do D1), `--publish-at ISO` (outro horário), `--video PATH`, `--edition-dir DIR`.

O JSON no stdout traz título, descrição (resumo + link da edição com UTM + CTA com UTM youtube), 6 tags e o agendamento (06:00 BRT, ou na hora se já passou). No stderr, as linhas `[premissa]` e `[aviso]`. Título, descrição e tags vão no upload do Passo A3 (e no relato); só no fallback do Passo A5 o editor os cola no Studio.

### Passo A2 — Capa no padrão diar.ia.br (#10800, #11220, #11228)

Regra do editor: **a única imagem realista é o editor.** Todo o resto é pintura Van Gogh/impasto, a linguagem das imagens de destaque. Referências aprovadas: `data/editions/2610/261021/04-youtube-thumb.jpg`, `261022/04-youtube-thumb.jpg` e, no padrão atual (gancho no topo), `261027/04-youtube-thumb.jpg`. A proposta da IA do YouTube Studio não serve (261022: laboratório e escorpião fotorrealistas, reprovada). Sem `04-youtube-thumb.jpg` o YouTube gera a dele (no #1 veio com contorno neon).

**Horizontal (`04-youtube-thumb.jpg`, 1280x720):**

1. **Gancho:** 2 a 4 palavras derivadas do D1, pergunta ou tensão (ex.: "IA ladra?", "IA antiveneno?", "Google Photos te vigia?"). Propor e seguir com ele; o editor aprova vendo a capa no item 6.
2. **Frame do retrato, do BRUTO (#11228).** O frame do vídeo final (1080p) sai com baixa resolução; o bruto 4K, ao lado de `Final/` na subpasta `{AAMMDD}/`, dá um recorte nítido. Achar o id do bruto (conector do Drive, ou a listagem da subpasta) e extrair as opções direto da Drive API, sem baixar os gigabytes:

   ```bash
   npx tsx scripts/gen-youtube-thumb.ts {AAMMDD} --frames-from-drive {FILE_ID_DO_BRUTO} [--count 5 | --times 12,30.5,48]
   ```

   Sem o bruto no Drive (na 261029 a subpasta só tinha o áudio e o `Final/`), o fallback explícito é o horizontal do `Final/`: `--frames-from-drive {FILE_ID_DO_FINAL} --from-final` (o id sai de `fetch-drive-video.ts --edition {AAMMDD} --orientation horizontal --dry-run`). Não espelha (a exportação já vem certa), o `--pick-frame` desses frames também não, e o `[aviso]` da resolução menor vai para o relato (#11532).

   Grava `_internal/youtube-thumb-frames/frame-{N}.png` e a folha numerada `opcoes.jpg` (5 instantes no miolo do vídeo por padrão). **Mostrar a folha ao editor; ele escolhe o número** (critério: olhando para a câmera, boca fechada, mãos fora do quadro). Nunca escolher sozinho. Depois:

   ```bash
   npx tsx scripts/gen-youtube-thumb.ts {AAMMDD} --pick-frame {N}
   ```

   que copia o escolhido para `_internal/youtube-thumb-frames/escolhido.png`.
3. **Recorte:** `rembg` modelo `birefnet-portrait` (só a pessoa, PNG com transparência). No **Neo (Windows do editor)**, o ambiente de `docs/setup.md` (#11071): `.venv-rembg/Scripts/python.exe scripts/setup-rembg.py --input _internal/youtube-thumb-frames/escolhido.png --output retrato.png`. No **`300` (Linux)**, desde #11223: `.venv-rembg/bin/python scripts/setup-rembg.py --input _internal/youtube-thumb-frames/escolhido.png --output retrato.png`. Se ausente/inválido, parar com a instrução de setup que o `check-video-env.ts` imprime (`py -3.11 scripts/setup-rembg.py` no Neo; `uv python install 3.11.9` + `setup-rembg.py` no `300`, `docs/setup.md`); nunca instalar improvisado ou substituir o recorte silenciosamente. Sem o venv na máquina, deixar o passo para o Neo e seguir com o resto.
4. **Fundo:** outpaint da `04-d1-2x1.jpg` para 16:9 pelo Codex, com a imagem como referência (#11228), o objeto do D1 menor e inteiro à direita e o terço esquerdo livre, em pintura impasto nítida. Nunca desfoque:

   ```bash
   node scripts/codex-image.js prompt-fundo.json fundo-16x9.jpg --ref data/editions/{AAMM}/{AAMMDD}/04-d1-2x1.jpg
   ```

   `prompt-fundo.json` com `positive` (a cena e a regra do terço esquerdo livre) e `final_width: 1536`, `final_height: 864`. O `--ref` anexa a imagem ao `codex exec -i` e o prompt pede para estender a cena mantendo a pintura.
5. **Composição** (determinística):

   ```bash
   npx tsx scripts/gen-youtube-thumb.ts {AAMMDD} --hook "IA ladra?" --portrait retrato.png --background fundo-16x9.jpg --enhance-portrait
   ```

   Grava `04-youtube-thumb.jpg` (≤ 2 MB): fundo sem desfoque, gradiente escuro no **topo** (até 45% da altura), retrato à esquerda na base, gancho em Georgia bold cor papel no canto **superior direito** com o `?` em teal (#11220). O gancho encolhe sozinho para não invadir a cabeça do retrato (#11228); abaixo de 320 px vira `[aviso]` (encurtar o gancho). `--enhance-portrait` aplica o realce aprovado em 261027: contraste +25% (`linear(1.25, -32)`), nitidez e saturação leve, preservando o alfa do rembg. Retrato sem transparência é recusado. Sem `--background` usa a `04-d1-2x1.jpg` crua com recorte central e um `[aviso]`. Precisa de Georgia instalada (guard #4090).
6. **Mostrar ao editor antes de subir** (pedido explícito). As capas de 261021 e 261022 já publicadas não são regeneradas.

**Short (`04-youtube-short-capa.jpg`):** um frame do próprio vídeo vertical em que aparece o lettering do título do D1 (só nos ~3,5 s iniciais; depois entra a vinheta). Escolher o frame com a melhor expressão (olhando pra câmera, boca fechada ou sorriso, mãos fora do quadro):

```bash
npx tsx scripts/gen-youtube-thumb.ts {AAMMDD} --short-cover --at 1.8
```

Default do vídeo: `diaria-comentada-{AAMMDD}-short.mp4` na pasta da edição (`--video` para outro). Frame depois de 3,5 s vira `[aviso]`. Também mostrar ao editor; no Studio, "Enviar arquivo" com o frame.

### Passo A3 — Upload pela API (`--upload`, o padrão)

Com os metadados do A1 e a capa do A2, a skill sobe o vídeo. Para trazer o arquivo do Drive:

```bash
npx tsx scripts/fetch-drive-video.ts --edition {AAMMDD} --orientation horizontal --download
npx tsx scripts/publish-youtube.ts {AAMMDD} --upload
```

O fetch grava `diaria-comentada-{AAMMDD}.mp4` só com `--download` (#11551); sem a flag ele só imprime o plano (arquivo, tamanho, destino) e não grava nada, que é o que serve para conferir. Arquivo já presente, ou vídeo já registrado em `_internal/05-youtube-published.json`, é no-op (`--force` troca o arquivo local). Acima de `--max-mb` (default 2048) o download não começa: exit 1 `phase: "size-limit"`; `--force` passa.

O token do upload vem do OAuth do canal (`scripts/youtube-oauth-setup.ts`, PR #10757): `YOUTUBE_REFRESH_TOKEN` e `YOUTUBE_CHANNEL_ID` no Doppler/`.env`, mais o client `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`. Sem eles o script sai exit 1 dizendo quais faltam. **Sem a auditoria do YouTube API Services, o upload via API pode sair `private`**, mesmo pedindo `public` ou `publishAt` (restrição de 2020 do histórico da API; a releitura confirma). Se o vídeo ficar privado, ele precisa ser publicado (ou agendado) à mão no Studio.

Saída do `--upload`:

- **exit 0** — vídeo enviado. O JSON no stdout traz `videoId`, `url` (`https://youtu.be/{id}`), `thumbnail` (`ok: false` + `error` quando só a capa falhou: o vídeo fica, e a capa vai à mão no Studio) e `state`, o estado RELIDO. Também sai exit 0, sem enviar nada, quando `_internal/05-youtube-published.json` já registra um vídeo desta edição (`skipped: true`); `--force` sobe de novo e cria OUTRO vídeo no canal.
- **exit 1** — nada enviado (credencial ausente, vídeo ausente, canal errado, erro da API antes dos bytes, registro ilegível ou de outra edição). A mensagem diz o que fazer. Três exceções em que o vídeo PODE existir, e a mensagem manda conferir o canal antes de rodar de novo:
  - falha a partir do envio dos bytes (5xx, rede caindo, resposta sem id). O registro vira `status: upload_indeterminado`, e o próximo `--upload` recusa até `--force`. Antes do `--force`, conferir no Studio se o vídeo subiu;
  - o YouTube marcou o vídeo como `failed`/`rejected`/`deleted` na releitura. O registro fica gravado, e a mensagem traz o motivo;
  - vídeo enviado sem conseguir gravar o registro.

  E um caso em que nada foi enviado mas o editor decide (#11132): o canal tem um vídeo no dia BRT da edição sem a marca dela (sem AAMMDD, `utm_campaign` nem o título do D1 — pode ser uma live ou um vídeo avulso). O log lista todos os candidatos por período, com VIDEO_ID, link, título e data; nada é gravado e o link não vai para o D1. Mostrar ao editor e, conforme a resposta, rodar de novo com `--accept-period-match VIDEO_ID` (seleciona o candidato desta edição pelo ID: registra com `source: "already-on-channel"` e põe o link no D1) ou com `--force` (não é: sobe o vídeo da edição).

Com `--force`, o registro anterior vai para `previous_uploads` no novo. O próprio `--upload` grava `_internal/05-video-url.txt` **sempre** que o YouTube aceitou o vídeo, inclusive quando o estado relido ainda não deixa o leitor abrir (`draft`, `unknown`, ou `scheduled` com `publishAt` depois do horário do post do D1, rotação do #10305 incluída); nesses casos o log traz `[aviso] vídeo ainda pode não abrir para o leitor: … O link será incluído no D1 mesmo assim`, e o editor precisa publicar (ou agendar antes do D1) no Studio. Não grava só com `uploadStatus` `failed`/`rejected`/`deleted` (exit 1); uma URL diferente já gravada à mão nunca é sobrescrita.

**Legenda SRT (#11384, #11385).** O `--upload` envia junto `diaria-comentada-{AAMMDD}.srt` da pasta da edição (`captions.insert`, faixa pt-BR, publicada, sem rascunho) e grava o `captionId` em `captions` no `05-youtube-published.json`; `--captions PATH` aponta outro arquivo, `--no-captions` sobe sem. Se houver `.srt` ao lado do vídeo no Drive, **conferir a legenda contra o roteiro aprovado antes de subir**: cues depois do fim do vídeo, números ("15%" × "15 pontos percentuais") e grafia (OpenAI, diar.ia.br, Intelligence Index, nomes de modelo como GPT-6.1). A versão corrigida vai para uma cópia ao lado (o `diaria-comentada-{AAMMDD}.srt` da pasta da edição), nunca por cima do original. Sem `.srt`, o plano traz `[premissa] sem legenda` e o vídeo sobe sem ela.

Token sem o escopo `youtube.force-ssl` (gerado antes do #11384): o vídeo sobe normalmente e sai `[aviso] legenda NÃO enviada` com o comando de setup. É o **único** passo para o editor: rodar no terminal dele `npx tsx scripts/youtube-oauth-setup.ts` (renova o refresh token com o escopo novo; no 300, `npm run sync-env`). Depois, só a legenda, pelo `videoId` do registro:

```bash
npx tsx scripts/publish-youtube.ts {AAMMDD} --captions-only
```

(`--force` envia outra faixa quando já há uma registrada.) Até o setup ser refeito, a legenda vai pelo Studio (Legendas → Enviar arquivo) e entra no relato como pendência do editor.

### Passo A4 — Link do vídeo no D1 (#10772, #10858, #11222)

Depois do Passo A3 nada a fazer: o `--upload` já gravou `_internal/05-video-url.txt`. Este passo é para o link vindo de fora — vídeo subido pelo Studio (Passo A5) ou já no canal, com o link que o editor passou (`--video-url`, ou colado na conversa):

```bash
npx tsx scripts/link-video-d1.ts {AAMMDD} --video-url {URL} --save
```

`--save` grava `_internal/05-video-url.txt`, o arquivo que o Stage 5 lê para pôr o link no D1 de X, Threads e Facebook diar.ia.br já na criação dos posts (1º link do texto no X; X e Threads só se couber no limite, tirando as hashtags do fim quando é isso que falta, #11402). Com o link gravado, o passo do YouTube no Stage 5 (`stage5-youtube.ts`) não busca nem sobe nada: o vídeo já está no canal (#11222).

Vídeo agendado para o mesmo horário do envio da newsletter do D1 (06:00 BRT, ou o `scheduled_at` do broadcast) ou antes **não é recusado** (#11548): o `link-video-d1` grava com `[aviso] agendado para o mesmo horário do D1`, sem `--assume-public` e sem pergunta. Se o `link-video-d1` ainda recusar (exit 1, nada gravado) porque um registro do upload diz privado sem data, indeterminado ou agendado para depois do envio do D1, a **pergunta única** ao editor é: "o vídeo está público no Studio (ou agendado antes do horário do D1)?" (#10865 — sem a auditoria do YouTube API Services, vídeo `private` nunca vira link no D1). Com o "sim", rodar de novo com `--assume-public`.

Sem link nesta invocação (só acontece se o Passo A3 não subiu o vídeo): relatar no fim que falta o link e o comando para gravá-lo (`/diaria-publica-video {AAMMDD} --so horizontal --video-url URL`). O JSON impresso pelo `link-video-d1` é também o plano para posts do D1 já agendados ou publicados: `edit_scheduled` (editar antes do disparo), `comment_after` (comentar/responder; no LinkedIn é sempre o 1º comentário). O script não edita nem comenta nada: aplicar esse plano ainda é manual.

### Passo A5 — Fallback: o editor sobe pelo Studio

Só quando o Passo A3 falhou de um jeito que a skill não resolve (quota, credencial, erro da API antes dos bytes) ou o editor pediu para subir ele mesmo. Com os metadados do A1 e a capa do A2, o editor sobe o `_Youtube_` (pasta `Final/` ou `Editado/`) pelo YouTube Studio, agenda ou publica e passa o link, que entra no D1 pelo Passo A4. Não contornar com o Claude in Chrome: upload de arquivo é bloqueado lá.

## Parte B — Vertical (Shorts, Reels e afins)

Vídeo curto de cada edição, decisão do editor de 21/10/2026: além do horizontal, o vertical sai **todo dia** como Shorts e como Reels. O objetivo é levar gente pro canal do YouTube. O 1º Short (edição 261021) foi publicado à mão e serviu de modelo: https://youtube.com/shorts/nhMUtgPPs4U.

Invocar a skill é o pedido de publicação: publicar nos destinos abaixo não precisa de confirmação extra.

### Destinos (`platform.config.json` → `publishing.shorts`)

| Destino | Como | Observação |
|---|---|---|
| `youtube_shorts` | API (YouTube Data API, #11070) | `videos.insert` private + `publishAt` no horário do vertical (o agendado vira público sozinho sem a auditoria, medido em 23/10/2026), credencial do horizontal (`YOUTUBE_*`). Capa: `thumbnails.set` com o Still depois do `videos.insert` (#11547); falha não desfaz o Short, só registra `cover.ok: false` e avisa (trocar no Studio). Antes de enviar confere o canal: Short da edição já lá (título `{D1} #Shorts` ou AAMMDD) vira registro sem novo upload; reconhecido só pelo dia, pede `--mark youtube_shorts=URL` (é ele) ou `--force-youtube` (não é). Falha a partir do envio dos bytes grava `send_unknown` (nunca re-envia: conferir o canal e registrar com `--mark`). Sem `YOUTUBE_*` ou com `publishing.shorts.youtube_shorts_api: false`, volta ao passo guiado (Passo B4) |
| `facebook:diaria`, `facebook:vjpixel` | API | agenda pro horário do vertical (abaixo) se faltar mais de 10 min (piso do Facebook); senão, na hora. Até 90 s sobe como Reels (`video_reels`); acima disso, como vídeo da Página (`/videos`, upload resumable em blocos, #10815), que o Facebook mostra como Reel quando é vertical |
| `instagram` | API (Reels resumable) | autora = @diar.ia.br desde #11223 (27/10/2026; `instagram_author_page: null`, a conta do env), com a @vjpixel em collab (`instagram_collaborators`), que aceita o convite no app. Antes (#10790) era o inverso: autora @vjpixel pela página VJ pixel. Sem `INSTAGRAM_BUSINESS_ACCOUNT_ID`/`INSTAGRAM_ACCESS_TOKEN` o destino é pulado; com a autora da diar.ia.br (env) o dry-run não confere o escopo `instagram_content_publish` (só confere quando a autora é uma página, #10820), então escopo faltando só aparece no `--publish`. Depois do publish o script relê os collabs e avisa se o convite foi descartado. O Instagram não agenda Reels por API. **Desde #11265 (decisão do editor, 27/10/2026) quem publica é o timer do `300`** (`Diaria-Shorts-Instagram`, `scripts/shorts-instagram-timer.ts`, `publishing.shorts.instagram_backend: "timer-300"`): no horário do vertical ele baixa o vertical único (legado: `_Outras redes_`, depois `_Instagram_`) da pasta `Final/` do Drive e publica pelo upload resumível da Graph API, sem URL pública; confere antes na conta se o Reels da edição já saiu e, se não conseguir publicar (acima do teto, credencial, falha, atraso de mais de 3 h), abre um alarme para o editor. Esta skill recebe o destino como `skip_delegated` e não o publica (duas máquinas, registro não sincronizado = Reels duplicado). Para publicar daqui mesmo assim (ou gerar o arquivo do Passo B3b), conferir antes a conta e rodar só esse destino: `--only instagram --publish --instagram-timer` (o `--instagram-timer` recusa qualquer outro destino; grava em `06-shorts-published.instagram-timer.json`). O caminho antigo (#10823: R2 + fila do Worker `diaria-linkedin-cron`) segue como `instagram_backend: "worker-r2"`. O R2 foi habilitado em 27/10/2026 (#10772), depois dessa decisão, e o editor manteve o `timer-300` (#11411: o timer funciona e o vertical único (legado: `_Outras redes_`, depois `_Instagram_`) do Drive não chega ao R2). **Teto de duração (#10893, por conta desde #10916):** a API recusa Reels acima de um teto que muda por conta (rupload `400 ProcessingFailedError` / container `2207076`): @vjpixel aceita 40 s e recusa 42 s (22/10/2026). Na @diar.ia.br as medições divergem: sintéticos até 55 s passaram (23/10), mas um sintético de 40 s (22/10) e o vertical real de 49,9 s (27/10) foram recusados, então o teto configurado é 30 s, o maior valor sem recusa registrada (#11281). Na prática o vertical da diar.ia.br passa do teto e vai direto pro passo guiado: o de 261028 tinha 75 s (`durationMs` 75267 no asset da Buffer, #11471), e não os ~50 s citados antes. Subir o teto só com nova medição num vertical real. Config: `publishing.shorts.instagram_api_max_seconds_by_account` (chave = slug de `instagram_author_page`; `diaria` = autora `null`, a conta do env), com fallback pro `instagram_api_max_seconds` legado e depois 40; `null` desliga o teto da conta. O plano lê a duração do MP4 e, acima do teto da autora, o Instagram vira passo **guiado** pelo Chrome (Passo B3b) — com o timer, isso aparece na rodada do timer (`--instagram-timer`), que avisa o editor por alarme; a rodada normal desta skill só mostra `skip_delegated`. O script nunca corta o vídeo: uma versão recortada só pro Instagram muda o conteúdo e é decisão editorial — desde #11491 o editor entrega uma única vertical para todos os destinos. Só a qualidade cai (720p, perda aceita pelo editor em 22/10) |
| `linkedin_profile` | API (Videos API, #10772) | vídeo **nativo** no perfil pessoal do editor, com o token do 4º post (`LINKEDIN_PERSONAL_*`, `docs/linkedin-personal-setup.md`). Texto: título, gancho e hashtags, sem link (#11617). A Posts API **não agenda**: antes do horário fica `pending_schedule`, com dono `agent-scheduled-task` no `owners[]` — a skill cria a task one-shot que roda o `command` no horário (#11550). Envio ambíguo (timeout/5xx) grava `send_unknown` e nunca re-posta: conferir o perfil e registrar com `--mark linkedin_profile=URL`. **Desde #10982 sai pelo timer do `300`** (`Diaria-Shorts-LinkedIn-Profile`, `publishing.shorts.linkedin_profile_via_timer: true`): ele baixa o vertical do Drive e publica no horário do vertical; esta skill recebe o destino como `skip_delegated` e não o publica (duas máquinas, registro não sincronizado = post duplicado). Para publicar daqui mesmo assim, conferir antes o perfil e rodar só esse destino: `--only linkedin_profile --publish --linkedin-timer` (o `--linkedin-timer` recusa qualquer outro destino, #11159: as entradas dele vão pro registro do timer, e outro destino ali voltaria a ter duas máquinas escrevendo o mesmo arquivo) |
| `linkedin_page_repost` | guiado (Chrome) | repost do vídeo do perfil **pela página** diar.ia.br, no horário `at` do plano: a grade da página (rotação #10305) decide, com 2 h de distância dos posts dela e ≥30 min depois do perfil. Guiado porque não há token de organização local |
| `x` | guiado (Buffer MCP) | X @diariabr. O plano traz o texto (≤280 ponderado) e o `scheduledAt`; o `--publish` sobe o vertical pro R2 e devolve `results[].buffer` (`text`, `dueAt`, `videoUrl`). O R2 está habilitado desde 27/10/2026 (#10772: bucket `diaria-shorts`, `https://media.diar.ia.br`, objetos em `shorts/` apagados após 7 dias) e os secrets `R2_*`/`SHORTS_R2_*` estão no Neo e no 300, então o destino entra no plano normalmente. Só numa máquina sem esses secrets ele é pulado com aviso e fica **pendente** (#11478/#11498): o `-short.mp4` fica no disco e o destino publica numa máquina com os secrets do R2. Postar à mão só registrando logo depois com `--mark x=buffer:{id} --scheduled-at {dueAt}`, senão a outra máquina publica de novo e o post sai duplicado |
| `threads_profile` | API (Threads API, #11122) | vertical no Threads **pessoal** do editor (`THREADS_PERSONAL_ACCESS_TOKEN`/`THREADS_PERSONAL_USER_ID`, `scripts/lib/threads-personal-video.ts`), com o vertical por URL pública do R2. Texto: título e gancho, sem link (#11617). Token e R2 existem desde 27/10/2026 (#10772; o R2 é o mesmo bucket do `x`), então o destino entra no plano normalmente. Sem token, é pulado com aviso (terminal, #11240). Sem os secrets do R2 na máquina, é pulado com aviso e fica **pendente** (#11478/#11498): publica numa máquina com os secrets; postar à mão só registrando com `--mark threads_profile=URL`, senão sai duplicado. Com `publishing.shorts.threads_profile_via_timer: true` (#11410, hoje `false`, tasks registradas desligadas) o destino vem `skip_delegated` e sai pelo timer do 300 (`Diaria-Shorts-Threads-Profile`) no horário do vertical. A API **não agenda**: mesmo `pending_schedule`/`skip_late` do `linkedin_profile`, com o dono no `owners[]` (#11550: sem o timer ligado, a skill cria a task one-shot do horário; o dono permanente é ligar o timer no 300). Envio ambíguo grava `send_unknown` e nunca re-posta: conferir o perfil e registrar com `--mark threads_profile=URL`. O repost pela diar.ia.br não entra (a Threads API não documenta repost) |
| `facebook_profile` | guiado (Chrome) | a Graph API não publica em perfil pessoal. **Pausado durante a viagem do editor** (#11223, `publishing.shorts.facebook_profile: false`): fora do plano, a skill não oferece nem cobra o Passo B5, e a limpeza do vertical não espera por ele. Volta com `true` |

**Horário do vertical (#10831):** o horizontal sai às 06:00 junto da newsletter; o vertical (Short, Reels e Instagram) sai em horário **próprio**, nunca às 06:00. Teste de 15 dias úteis (261026, segunda, a 261113, sexta; só há edição de segunda a sexta) alternando **06:30, 08:00 e 12:00 BRT** dia a dia (revisto em 22/10/2026: os cliques da newsletter concentram 59% entre 06h e 10h e só 2% às 19h; o teste 12:00/19:00 valeu só para 261022 e 261023) (`publishing.shorts.schedule`, `resolveShortTime`), comparando as visualizações nas primeiras 24 h; fora da janela vale `default_time`. O plano traz o horário em `shortTime` (`hhmm`, `at`). **Grade (#10819):** o plano lê o que já está agendado no dia (`_internal/06-social-published.json` + `06-shorts-published.json` + a fila do Worker, `GET /list`, que traz os posts das skills de divulgação; sem Worker vira `[aviso]` e segue só com os stores). O Instagram em collab conta também como post da @diar.ia.br (decisão do editor 261023). Durante o teste, o horário do teste vale pra todos os destinos e a grade só vira `[aviso]` quando ele cola (<2 h) num post da mesma conta; fora do teste, cada destino de API tem horário próprio em `slots`, exceto o Instagram com `timer-300`, sempre no horário do vertical (#11265) (alinha a post de outra conta; na mesma conta, espaçamento mínimo de 2 h e preferência pelos picos de uso 07–09, 12–14 e 18–21 BRT, decisão do editor no briefing 261022b, `scripts/lib/social-slot-planner.ts`). Destinos guiados seguem `shortTime`.

Os destinos guiados aparecem no plano, mas o script não os executa: o YouTube Shorts sem credencial (Passo B4) e o perfil pessoal (Passo B5). MemeLab saiu da rotina em 22/10/2026 (#10790). Jandig, Teatro vs Game e Criaturas Afetivas também ficam **fora** da rotina — só quando o editor pedir.

Página sem token (`[aviso] facebook:{slug}: sem credencial`) não bloqueia as outras. Para gerar o token, o **editor** roda no terminal dele (o token nunca passa pelo chat):

```bash
npx tsx scripts/facebook-page-token-setup.ts --pages vjpixel
```

O script pede o User Access Token do Graph API Explorer (permissões `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`; os escopos `instagram_basic` e `instagram_content_publish` só são necessários se o Instagram voltar a ter uma página como autora — desde #11223 a autora é a diar.ia.br, pelo token do env), lê sem eco na tela e grava id + token de página no `.env` e no Doppler. Nunca pedir nem colar o token aqui.

### Passo B1 — O vídeo

Convenção: `data/editions/{AAMM}/{AAMMDD}/diaria-comentada-{AAMMDD}-short.mp4`. Se não estiver lá, achar o id no Drive (seção "Onde está o vídeo"):

```bash
npx tsx scripts/fetch-drive-video.ts --edition {AAMMDD} --orientation vertical --promote
```

Escolhe o corte `_Outras redes_` da pasta `Final/` (ou, sem ela, o vertical "final" da regra antiga) e imprime em `next_command` o comando abaixo com o `FILE_ID` pronto. Ele não baixa nada sozinho; com o short já no disco, `next_command` é o plano do `publish-shorts.ts` sobre ele. O download usa o OAuth do próprio projeto (`data/.credentials.json`), não o conector; o script exige `02-reviewed.md` antes de baixar.

```bash
npx tsx scripts/publish-shorts.ts {AAMMDD} --from-drive {FILE_ID}
```

### Passo B2 — Plano

```bash
npx tsx scripts/publish-shorts.ts {AAMMDD}
```

Dry-run: imprime título/descrição e horário do Shorts, a legenda de cada Reels, o horário e o que será pulado (já publicado, sem credencial, pendente). Link da edição: `--edition-url` > `_internal/05-edition-url.txt` > slug derivado do título do D1. No fluxo do dia (#10943: `/diaria-publica-video` → `/diaria-5-publicacao`) o vertical sai **antes** da Etapa 5, então `05-edition-url.txt` ainda não existe: com `publishing.newsletter.backend` = `"kit"` (o atual) o link derivado é **premissa**, não aviso, porque é a mesma regra com que o Stage 5 grava o arquivo (`publish-newsletter-kit.ts`, #7420). Com `"beehiiv"` continua `[aviso]` — o wizard da Beehiiv pode mudar o slug; conferir antes de publicar ou passar `--edition-url`.

### Passo B3 — Reels por API

```bash
npx tsx scripts/publish-shorts.ts {AAMMDD} --publish
```

Cada destino é gravado em `_internal/06-shorts-published.json` assim que sai (o vídeo do perfil que o timer do 300 publica fica em `06-shorts-published.linkedin-timer.json`, que só o timer escreve; a leitura une os dois e as cópias de conflito do OneDrive, e cada destino é reconferido no disco antes de publicar, #11157). Re-rodar pula o que já foi feito. O Instagram sai pelo timer do `300` (`skip_delegated` aqui, #11265), que grava em `06-shorts-published.instagram-timer.json`. Com `instagram_backend: "worker-r2"`, o Instagram enfileirado é gravado `scheduled` com a key da fila no `id` — re-rodar não enfileira de novo. Registro ilegível aborta em vez de republicar. `(processamento não confirmado em 5 min — confira)` numa linha `[ok]` pede uma olhada na página antes de relatar como publicado.

### Passo B3b — Instagram acima do teto (Chrome, #10915)

Só quando o item `instagram` do plano vem `guided` (vertical acima do teto da autora). Com o timer do `300` dono do Instagram (#11265), isso aparece no alarme do timer ou numa rodada `--only instagram --publish --instagram-timer` desta máquina (que gera o arquivo abaixo); a rodada normal mostra `skip_delegated`. O item traz `at`: o horário do slot que o plano já reservou na grade para ele (#10933, #10819), então os outros destinos e o repost do LinkedIn foram planejados contando com esse post — publicar nesse horário, não no `shortTime` cru. Roda **só na máquina Windows do editor**, com o Chrome logado no instagram.com como @vjpixel (label `windows`); fora dela, deixar o passo pro editor e seguir. **Rota do passo à mão (#11390):** @vjpixel é o autor e a @diar.ia.br entra como colaboradora (`INSTAGRAM_CHROME_ROUTE` em `scripts/lib/diaria/short-video.ts`), o inverso da rota da API (autora @diar.ia.br com a @vjpixel em collab, #11223). Com vertical acima do teto o timer do 300 não publica nem manda `late`: manda um lembrete único por edição (`guided`, #11389), antes do horário quando o corte já está no disco.

**Vertical único (#11491):** o Passo B3b usa o mesmo `Diaria comentada_Vertical_V{n}.mp4` dos demais destinos. `fetch-drive-video.ts --edition {AAMMDD} --orientation vertical --target instagram --promote` resolve esse arquivo, com fallback histórico para `_Outras redes_` e depois `_Instagram_`.

**Preparar o passo na máquina Windows (#11476):** o `.mp4` comprimido que o timer do `300` gera não chega pelo OneDrive (só o sidecar `.json`), e o vertical local costuma não existir. Um comando só prepara tudo a partir do vertical único (legado: `_Outras redes_`, depois `_Instagram_`):

```bash
npx tsx scripts/prepare-instagram-guided.ts {AAMMDD}            # acha e baixa o corte do Drive (mesma regra do timer)
npx tsx scripts/prepare-instagram-guided.ts {AAMMDD} --video "G:/.../Final/Diaria comentada_Vertical_V1.mp4"   # arquivo local, sem Drive
```

Ele planeja só o `instagram` com a duração desse corte e aplica a mesma compressão do `--publish` (abaixo), em `_internal/diaria-comentada-{AAMMDD}-short-instagram-chrome.mp4`. O JSON traz `upload`, `caption` e `at` (os mesmos campos do item guiado) e o `next_command` do registro. Nunca publica nem grava o registro do vertical. `action` diferente de `guided`: `already-registered` (não repostar), `fits-api` (o corte cabe na API, quem publica é o timer), `no-video` (sem corte no Drive nem vertical no disco), `needs-editor` (exit 3, Drive ambíguo) ou `error` (exit 1).

O `--publish` do Passo B3, depois de publicar os destinos de API, gera a versão para o `file_upload` do Claude in Chrome: `_internal/diaria-comentada-{AAMMDD}-short-instagram-chrome.mp4`, ffmpeg 2-pass em 720x1280, AAC 64k 48 kHz, `+faststart`, bitrate calculado pela duração mirando 9,5 MB (abaixo do limite de 10 MB do `file_upload`). Vídeos muito longos podem não caber nem no bitrate mínimo (250 kbps de vídeo: acima de ~4 min o arquivo passa dos 10 MB). O item traz `upload: { path, sizeBytes, fitsChromeUpload }` e a legenda pronta em `caption`. Se o ffmpeg falhar (ou passar de 15 min por passada), `upload.path` aponta pro original com `fitsChromeUpload: false` (sai `[aviso]`). Rodar de novo reaproveita o arquivo gerado só quando o sidecar `.json` ao lado dele bate com o vertical atual (caminho, tamanho, mtime) e com o bitrate.

1. Carregar as ferramentas do Claude in Chrome e abrir `https://www.instagram.com/` numa aba nova. Conferir no avatar que a conta é @vjpixel.
2. **Criar > Post.** Conferir `upload.fitsChromeUpload` antes de subir. Se for `true`, subir `upload.path` pelo `<input type="file">` do diálogo com `file_upload`. Se for `false` (arquivo acima de 10 MB ou compressão falhou), **não** chamar `file_upload`: chamar o editor para escolher o arquivo no diálogo.
3. **Proporção vertical.** O diálogo abre em 1:1: abrir o seletor de proporção (ícone de recorte no canto inferior esquerdo) e escolher a opção que mantém o vídeo inteiro em pé. O nome muda entre versões do instagram.com e ainda não foi conferido ao vivo (#10978 item 2): pode aparecer "9:16" ou "Original" (para vídeo vertical, "Original" já sai 9:16). Escolher a que existir; com as duas, tanto faz. O seletor pode **fechar** ao clicar numa opção: abrir de novo e conferir na prévia que o vídeo não ficou cortado em quadrado.
4. Avançar **duas vezes** (recorte e depois filtros) até a tela da legenda.
5. Colar a legenda do `caption` do item.
6. **Add collaborators:** digitar `diar.ia.br` e escolher a conta na lista.
7. **Share.** O processamento leva de 30 a 60 s depois do clique. A tela de "publicado" não é confirmação.
8. **Confirmar pela API** (lê `/{ig-user}/media`, só leitura, e grava a entrada `instagram` em `06-shorts-published.json`):

   ```bash
   npx tsx scripts/publish-shorts.ts {AAMMDD} --confirm-instagram
   ```

   Ele lê as mídias mais recentes da conta da API (@diar.ia.br) e, se nada da edição aparece lá, as do perfil do @vjpixel (#11390: enquanto o convite de collab está pendente o Reel só existe no perfil do autor; a leitura usa o token da página `vjpixel`, sem ele a recusa diz isso). Com o permalink em mãos, `--confirm-instagram --url https://www.instagram.com/reel/CODIGO/` registra direto, sem a API. Em cada conta lê páginas de 15, seguindo a paginação até cobrir o corte ou achar o `--media-id`, no máximo 75 mídias, #10978) e registra o único Reels desde 00:00 BRT do dia da edição (`--since ISO` muda o corte) cuja legenda tem o marcador da edição: o título do D1, que abre a legenda, ou o gancho (1ª frase do D1, 2º parágrafo), ou `utm_campaign={AAMMDD}`/URL da edição, se a legenda trouxer o link. Editar a 1ª linha no Chrome não derruba o match (#10978 item 5): o gancho ainda casa; e se os dois foram trocados, vale o **único** Reels a até 90 min do horário do vertical que ainda tem o formato da legenda (a frase "A diar.ia.br é a newsletter que resume as notícias de IA do dia em 5 minutos.", #11388; nas legendas antigas, a linha `youtube.com/@diariabr`), com aviso pra conferir o permalink. Sem nenhum match, com mais de um, ou com dois Reels nessa janela, recusa (exit 1) sem gravar e lista os candidatos (id, horário, permalink); aí escolher com `--media-id {id}`. Avisa quando o collab ficou `Pending` (a colaboradora, @diar.ia.br na rota do Chrome ou @vjpixel na da API, ainda precisa aceitar o convite no app), `Declined` (convidar de novo) ou foi descartado. "Nenhum Reels desde…" logo depois do Share costuma ser o processamento: esperar um minuto e rodar de novo. Se o `instagram` já está registrado, não grava nada e sai não-zero quando o registro não é `published`. Sem acesso à API, registrar à mão com `--mark instagram={URL do Reel}`.

Relatar o Instagram como publicado só depois do `--confirm-instagram` (#573), e com o collab `Pending` ou `Declined` dito explicitamente quando for o caso.

### Passo B4 — YouTube Shorts (Chrome, só quando o plano o devolve guiado)

Com `YOUTUBE_*` no ambiente o Short sai no Passo B3, pela API (#11070); este passo só vale quando o item `youtube_shorts` vem `guided` (credencial ausente ou `youtube_shorts_api: false`). O vídeo relacionado (item 5) continua manual nos dois caminhos.

Carregar as ferramentas do Claude in Chrome. Abrir `https://studio.youtube.com/channel/UCSsppeUnBy6q-4a5hsl5u0w/videos/upload?d=ud`.

1. **Chamar o editor** para clicar em "Selecionar arquivos" e escolher o vertical: o upload de arquivo é bloqueado no Chrome (e o `file_upload` tem limite de 10 MB).
2. Título e descrição do plano (`youtube.title`, `youtube.description`). Em "Mostrar mais": tags do vídeo longo, idioma Português (Brasil), categoria Ciência e tecnologia. Público: "Não é conteúdo para crianças".
3. **Capa:** `04-youtube-short-capa.jpg` (Passo A2), ou um frame escolhido no Studio.
4. Visibilidade **Agendar** para o horário do vertical (`shortTime.hhmm` BRT do dia da edição; se já passou, Público). **Esperar "Verificações concluídas"** antes de confirmar: publicar durante a verificação mostra o aviso "Ainda estamos verificando seu conteúdo" (risco de advertência ou visibilidade restrita).
5. **Vídeo relacionado não se vincula no upload:** o seletor só lista vídeo público e o horizontal ainda está agendado. O vínculo (Elementos do vídeo → Vídeo relacionado → o horizontal da edição) acontece depois que o horizontal publica às 06:00. Com a task local `diaria-short-video-relacionado` criada no Neo (dias úteis às 06:05 BRT, #10811; estado em `docs/scheduled-tasks-registry.md`; roteiro em `short-related-task.md` nesta pasta; plano em `scripts/youtube-short-related-plan.ts`), é ela quem vincula. Sem a task, ou quando ela alerta por e-mail, o passo é manual: o quanto antes, de preferência antes do horário do Short, mas o vínculo vale também depois.
6. Sem comentário fixado: desde 2023 link em descrição e em comentário de Short não é clicável (#10831). O único caminho clicável até a edição é o vídeo relacionado.
7. Registrar: `npx tsx scripts/publish-shorts.ts {AAMMDD} --mark youtube_shorts={URL do Short}` (`--mark` só aceita os destinos guiados — `youtube_shorts`, `facebook_profile`, `linkedin_page_repost`, `x` —, o `instagram` quando o plano o devolve como guiado pelo teto de duração, #10893, e o `linkedin_profile`/`threads_profile` depois de conferir um `send_unknown`, #10772/#11122; sempre com URL http/https, exceto `x=buffer:{id}`).

### Passo B5 — Perfil pessoal (Chrome)

Só quando o plano traz o item `facebook_profile`. Com `publishing.shorts.facebook_profile: false` (pausa da viagem, #11223) o item não existe: pular o passo sem mencionar pendência.

O Facebook do Chrome costuma estar na identidade da página diar.ia.br. Trocar para o perfil pessoal (menu do avatar → perfil do editor), criar Reel e **chamar o editor** para escolher o arquivo. Legenda: `caption` do item `facebook_profile`. Publicar e registrar com `--mark facebook_profile={URL}`. **Voltar o Chrome para a identidade da página diar.ia.br no fim.**

Atalho aceitável: compartilhar no perfil o Reels já publicado na página diar.ia.br, com a mesma legenda.

### Passo B5b — X e repost da página no LinkedIn (#10772)

**X:** com o `results[].buffer` do Passo B3, chamar a Buffer no canal @diariabr (`channelId` = `publishing.social.twitter.buffer_channel_id`): `create_post` com o `text`, `schedulingType: "automatic"` (campo obrigatório, `automatic` ou `notification`; sem ele a chamada falha na validação, #11471) e o vídeo como asset por URL, `assets: [{ video: { url: videoUrl } }]`; com `results[].buffer.thumbnailOffset` presente, o asset vai como `assets: [{ video: { url: videoUrl, metadata: { thumbnailOffset } } }]` (ms, a capa do X, #11547). O modo depende do `dueAt`: com `dueAt` no futuro, `mode: "customScheduled"` + `dueAt`; com `dueAt` null (o horário já passou), `mode: "shareNow"` e sem `dueAt` (`customScheduled` sem data futura não serve). `assets` vai como **array JSON**, nunca objeto; se o conector entregar o array como string (`expected array, received string`, a armadilha do array de imagens do Stage 5, #8056), usar `execute_mutation` com a mesma mutation `createPost` só se o conector o expuser (o conector atual não expõe, #11564: aí registrar o erro e postar o X à mão). **Formato verificado na execução real de 261028 (#11471):** `assets: [{ video: { url } }]` foi aceito e a Buffer devolveu um `VideoAsset` mp4 com `durationMs` 75267 (o vertical tem ~75 s). O limite de tamanho de vídeo da Buffer para o X segue não medido (o vertical de 261022 tinha 275 MB): se a Buffer recusar por tamanho, registrar o motivo e postar o X à mão. Registrar: `npx tsx scripts/publish-shorts.ts {AAMMDD} --mark x=buffer:{id do post} --scheduled-at {dueAt}` (no `shareNow`, sem `--scheduled-at`), acrescentando `--thumbnail-offset {ms}` quando o offset foi no `create_post` (sem ele, o registro não afirma capa).

**Confirmar que o X publicou:** o `create_post` volta com `status: "sending"` (ou `scheduled`), e o `--mark x=buffer:{id}` grava o destino como `scheduled`, nunca como publicado (#573). Depois do horário (no `shareNow`, alguns minutos depois), ler o post com `get_post` (id do Buffer): `status: "sent"` com o link do tweet (`externalLink`) confirma; `error` é falha (registrar o motivo e postar à mão); `sending` ainda não confirma, ler de novo mais tarde. Confirmado, registrar com a URL: `npx tsx scripts/publish-shorts.ts {AAMMDD} --mark x={URL do tweet}`, que substitui a entrada `buffer:` pela publicada. Sem o link no `get_post`, conferir o perfil @diariabr e usar a URL de lá.

**Repost da página:** só é oferecido quando `linkedin_profile` já está registrado ou sai nesta rodada; se o perfil foi pulado ou falhou, o item vem `skip_invalid` com o motivo (#10772 F1). O `linkedin_profile` que passou mais de 3 h do horário vem `skip_late` (#10772 F4): o agente publica com o `command` do `owners[]` (`--now`), ou registra com `--mark linkedin_profile={URL}` se já saiu; nunca devolve ao editor (#11550). Depois que `linkedin_profile` saiu, no horário `at` do item `linkedin_page_repost` (com `at` no futuro, o `owners[]` traz `agent-scheduled-task`: a skill agenda a própria re-execução para esse horário), abrir o post do perfil no Chrome com a identidade da página diar.ia.br, "Repostar" e registrar com `--mark linkedin_page_repost={URL}`.

## Relato único

Uma mensagem só, com os dois vídeos:

- **Horizontal:** título, primeiras linhas da descrição, tags, horário (`publishAt` ou "na hora"), a capa, e o link no D1 (`05-video-url.txt` gravado, ou o que falta). Depois de `--upload`, o link e o `state` relido: com `state: draft` (sem a auditoria do YouTube API Services), dizer que o vídeo subiu **privado** e precisa ser publicado ou agendado à mão no Studio; com `state: scheduled` e `audit_blocked: true`, que está agendado mas o agendamento pode não torná-lo público — conferir no Studio depois do horário. Ao relatar o estado de um vídeo já existente, normalizar pelo `resolveYouTubeState` (`scripts/lib/publish-state.ts`, #573) — `private` sem `publishAt` é rascunho, nunca "publicado".
- **Vertical:** uma linha por destino, com o estado normalizado da linha `[ok] … (estado …)` (`resolveShortEntryState`): publicado/agendado (com URL), `send_unknown` do LinkedIn (conferir o perfil), X agendado na Buffer (`scheduled` até o `dueAt`, depois `unknown` até conferir com `get_post` e registrar a URL, Passo B5b), na fila do Worker (só com `instagram_backend: "worker-r2"`: Instagram `scheduled` até a hora, depois `unknown` até confirmar no app — `resolveWorkerQueueState`), pendente (Instagram sem fila, antes do horário do vertical — só `worker-r2`), delegado ao timer do 300 (`skip_delegated`: Instagram e `linkedin_profile`, relatar como "sai pelo timer às HH:MM", nunca como publicado), Instagram manual acima do teto (pendente até o `--confirm-instagram` ou `--mark instagram=URL` do Passo B3b), pulado (sem credencial, com o comando de setup). Normalizar o estado como manda o #573: "agendado" não é "publicado".
- A parte que não rodou (`--so`, vídeo ausente no Drive) com o motivo, e o próximo comando: `/diaria-5-publicacao {AAMMDD}`.
- **"Próximo passo" do editor (#11385):** listar só o que de fato exige ação dele (ex.: refazer o `youtube-oauth-setup.ts` quando a legenda saiu com `scopeMissing`, publicar no Studio um vídeo que ficou privado, escolher entre candidatos `needs-editor`). Nunca devolver como passo dele uma etapa que a skill executa: subir o vídeo, gravar o link no D1, enviar a legenda com o token certo.
- **Todo destino tem dono automático (#11550, decisão do editor de 28/10/2026: "sempre é você que precisa publicar").** O JSON do `publish-shorts.ts` traz `owners[]`, um por destino `pending_schedule`, `skip_late`, `skip_delegated`, `guided` ou `buffer`, com `by`: `timer-300` (a task do 300 em `task` publica; só relatar), `agent-scheduled-task` (criar uma task agendada one-shot para `at` que roda `command`; relatar o nome e o horário da task) ou `agent` (executar nesta rodada: `skip_late` publica com `command`, que leva `--now`, ou registra com `--mark` se já saiu; guiado e Buffer, o passo da skill). O relato final diz o dono de cada destino. O "Próximo passo" do editor **nunca** lista "rodar o comando X depois do horário", "publicar à mão" ou "registrar com --mark" de um destino com dono.

Teste de 2 semanas a partir de 261022 (#10769, destinos; o teste de horário do #10831 é outro, ver acima): no fim, comparar os visualizadores e as visitas ao canal por destino, e manter só os destinos que trouxerem gente.
