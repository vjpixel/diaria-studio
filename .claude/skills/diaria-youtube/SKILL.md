---
name: diaria-youtube
description: Prepara o vídeo diário "diar.ia.br comentada" (Pixel comentando o D1) para o canal @diariabr no YouTube — metadados derivados da edição (título do D1, descrição com resumo + link da edição com UTM + CTA com UTM youtube, 6 tags), capa e agendamento 06:00 BRT (ou na hora, se já passou). Roda depois do gate da Etapa 4 e antes do `/diaria-5-publicacao` (#10943), standalone, sem encadear. Default dry-run; `--upload` sobe de verdade pela YouTube Data API (#10659) — sem a auditoria do YouTube API Services o vídeo pode sair privado. Uso — `/diaria-youtube AAMMDD`.
---

# /diaria-youtube AAMMDD (#10659)

Vídeo diário no YouTube (`@diariabr`) com o Pixel comentando o D1 da edição, decisão do editor de 21/10/2026 (1º vídeo: edição 261021, https://youtu.be/QRbXMprk9o0). Esta skill cobre só esse vídeo, fora da pipeline: roda depois do gate da Etapa 4 e, no fluxo ideal (#10943), antes do `/diaria-5-publicacao`, para o link do vídeo entrar no D1 já na criação dos posts. Também serve para o caso em que o vídeo fica pronto depois do Stage 5. O publisher é o mesmo do passo do Stage 5 (`scripts/publish-youtube.ts`, §5b-youtube do `orchestrator-stage-5.md`).

**Data:** `AAMMDD` é obrigatório. Se não for passado, assumir D+1 com o banner padrão do `CLAUDE.md` (`Data não informada — assumindo {AAMMDD} (D+1). Passe AAMMDD explicitamente para outra edição.`), nunca perguntar.

## Estado atual: dry-run e `--upload`

O script tem dois modos, e um deles é obrigatório (sem nenhum, ou com os dois, sai exit 2):

- `--dry-run` — só o plano, sem rede. É o default da skill.
- `--upload` — upload real pela YouTube Data API v3 (#10659): `videos.insert` resumable com `privacyStatus`/`publishAt` do plano, `thumbnails.set` com a capa, releitura do estado por `resolveYouTubeState` (#573) e registro em `_internal/05-youtube-published.json`.

O token vem do OAuth do canal (`scripts/youtube-oauth-setup.ts`, PR #10757): `YOUTUBE_REFRESH_TOKEN` e `YOUTUBE_CHANNEL_ID` no Doppler/`.env`, mais o client `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`. Sem eles o script sai exit 1 dizendo quais faltam.

**Sem a auditoria do YouTube API Services, o upload via API pode sair `private`**, mesmo pedindo `public` ou `publishAt`. É a restrição de 2020 do histórico da API; a página atual de `videos.insert` diz o contrário, e o 1º upload real confirma pela releitura. A releitura mostra `draft` ou `scheduled`. Se o vídeo ficar privado, ele precisa ser publicado (ou agendado) à mão no Studio.

O vídeo vem do Drive (pasta `Mentoria Fluxo/VTSD/YouTube`, `publishing.youtube.drive_folder_id`) por `scripts/fetch-drive-video.ts` (Passo 1), e o Stage 5 faz o mesmo download + upload sozinho, fail-soft (§5b-youtube). Não contornar com o Claude in Chrome: upload de arquivo é bloqueado lá, e o projeto prefere API oficial.

## Passo 0 — Pré-condição: Stage 4 aprovado (#10943)

Fluxo do dia (decisão do editor, 22/10/2026): `/diaria-edicao` → `/diaria-youtube` → `/diaria-shorts` → `/diaria-5-publicacao`, cada skill numa sessão própria, nenhuma encadeia (#5578). O vídeo comenta o D1, e o D1 só está final depois do gate da Etapa 4, então esta skill só roda com o sentinel do Stage 4:

```bash
npx tsx scripts/pipeline-sentinel.ts exists --edition {AAMMDD} --step 4
```

- exit 0 → seguir.
- exit 1 → **parar**: "Etapa 4 (Revisão) da edição {AAMMDD} não aprovada (`_internal/.step-4-done.json` ausente). O D1 ainda pode mudar; aprove o gate (`/diaria-4-revisao {AAMMDD}` ou `/diaria-edicao {AAMMDD}`) e rode `/diaria-youtube` depois." Vale para `--dry-run` e `--upload`.

Ao terminar, sugerir o próximo comando (`/diaria-shorts {AAMMDD}`) sem rodá-lo.

**Edição sem vídeo (#11125).** Se o editor disser que não vai gravar o vídeo do dia, marcar a edição com `npx tsx scripts/set-d1-no-video.ts {AAMMDD}`: grava `_internal/no-video.json`, apaga a cópia `04-d1-2x1-play.jpg` com o convite "Clique e assista a notícia comentada" e faz o upload (`upload-images-public.ts --mode newsletter`) e o render pararem de usá-la — o D1 sai com o hero puro, sem link. Depois rodar o upload em modo newsletter (tira `d1_play` de `06-public-images.json`) e re-renderizar o HTML. O marcador vence a URL do vídeo; para religar, `--clear` e rodar o upload de novo.

## Passo 1 — Conferir os insumos

Na pasta da edição (`data/editions/{AAMM}/{AAMMDD}/`):

- `02-reviewed.md` — obrigatório (é de onde sai o D1);
- `diaria-comentada-{AAMMDD}.mp4` — o vídeo (convenção de nome; outro caminho via `--video`). Ausente vira aviso, não erro. **Sem o arquivo local, tentar o Drive antes** (passo opcional, #10659):

  ```bash
  npx tsx scripts/fetch-drive-video.ts --edition {AAMMDD} --orientation horizontal
  ```

  Critério do editor (25/10/2026): `.mp4` (extensão ou `video/mp4`; `.mov`/`.webm` não) com "final" como palavra no nome, sem diferenciar maiúsculas ("pré-final", "não final" e "finalizando" não contam), horizontal pela proporção que o Drive informa. Se a subpasta `{AAMMDD}/` existe, só ela conta (sem janela; a raiz é ignorada); senão, solto na raiz nas últimas 36h. Grava no caminho acima; arquivo já presente, ou vídeo já registrado em `_internal/05-youtube-published.json`, é no-op (`--force` troca o arquivo local). Exit 0 com `action: "none"` = nada no Drive ainda (seguir sem vídeo); exit 3 `needs-editor` = 2+ "final" horizontais (`candidates`), "final" sem proporção no Drive (`files`) ou 2+ subpastas `{AAMMDD}` (`folders`) — mostrar id, nome e `modifiedTime` de cada um ao editor, que escolhe; nunca escolher sozinho; exit 1 = pasta inacessível pela conta OAuth do projeto, rede ou token (renovar com `oauth-setup.ts`). `--dry-run` só mostra a escolha;
- `04-youtube-thumb.jpg` — capa 1280x720 aprovada (opcional; sem ela o YouTube gera a dele, que já veio com contorno neon no #1). Ausente: gerar no Passo 1b.

## Passo 1b — Capas no padrão diar.ia.br (#10800)

Regra do editor: **a única imagem realista é o editor.** Todo o resto é pintura Van Gogh/impasto, a linguagem das imagens de destaque. Referências aprovadas: `data/editions/2610/261021/04-youtube-thumb.jpg` e `data/editions/2610/261022/04-youtube-thumb.jpg`. A proposta da IA do YouTube Studio não serve (261022: laboratório e escorpião fotorrealistas, reprovada).

**Horizontal (`04-youtube-thumb.jpg`):**

1. **Gancho:** 2 ou 3 palavras derivadas do D1, pergunta ou tensão (ex.: "IA ladra?", "IA antiveneno?"). Propor e seguir com ele; o editor aprova vendo a capa no passo 5.
2. **Retrato:** Codex CLI pela assinatura ChatGPT (`codex exec -i frame1.png -i frame2.png`, mesmo guard de env do `scripts/codex-image.js`), a partir de 2 frames do vídeo do dia (`ffmpeg -ss {t} -i {vídeo} -frames:v 1 frameN.png`). Prompt: o mesmo homem, do peito pra cima, olhando pra câmera, sorriso leve, bem iluminado, camiseta cinza como no vídeo, fundo escuro liso. Recortar com `rembg` modelo `birefnet-portrait` (só a pessoa, PNG com transparência).
   No **Neo (Windows do editor)**, usar o ambiente de `docs/setup.md` (#11071): `.venv-rembg/Scripts/python.exe scripts/setup-rembg.py --input retrato-original.png --output retrato.png`. Se ausente/inválido, parar com a instrução `py -3.11 scripts/setup-rembg.py`; nunca instalar improvisado ou substituir o recorte silenciosamente.
3. **Fundo:** outpaint da `04-d1-2x1.jpg` pelo Codex para 16:9, com o objeto do D1 menor e inteiro à direita e o terço esquerdo livre, em pintura impasto nítida. Nunca desfoque.
4. **Composição** (determinística):

   ```bash
   npx tsx scripts/gen-youtube-thumb.ts {AAMMDD} --hook "IA ladra?" --portrait retrato.png --background fundo-16x9.png
   ```

   Grava `04-youtube-thumb.jpg` (1280x720, ≤ 2 MB): fundo sem desfoque, gradiente escuro embaixo, retrato à esquerda na base, gancho em Georgia bold cor papel no canto inferior direito com o `?` em teal. Retrato sem transparência é recusado. Sem `--background` usa a `04-d1-2x1.jpg` crua com recorte central e um `[aviso]`. Precisa de Georgia instalada (guard #4090).
5. **Mostrar ao editor antes de subir** (pedido explícito).

**Short (`04-youtube-short-capa.jpg`):** um frame do próprio vídeo vertical em que aparece o lettering do título do D1 (só nos ~3,5 s iniciais; depois entra a vinheta). Escolher o frame com a melhor expressão (olhando pra câmera, boca fechada ou sorriso, mãos fora do quadro):

```bash
npx tsx scripts/gen-youtube-thumb.ts {AAMMDD} --short-cover --at 1.8
```

Default do vídeo: `diaria-comentada-{AAMMDD}-short.mp4` na pasta da edição (`--video` para outro). Frame depois de 3,5 s vira `[aviso]`. Também mostrar ao editor; no Studio, "Enviar arquivo" com o frame.

## Passo 2 — Plano (dry-run)

```bash
npx tsx scripts/publish-youtube.ts {AAMMDD} --dry-run
```

Flags opcionais: `--episode N` (número do episódio; default = cadência diária desde 261021 = #1), `--edition-url URL` (link da edição quando o slug publicado divergir do derivado do título do D1), `--publish-at ISO` (outro horário), `--video PATH`, `--edition-dir DIR`.

O JSON no stdout traz título, descrição, tags, decisão de agendamento e o request de `videos.insert` que seria enviado (sem credencial). No stderr, as linhas `[premissa]` e `[aviso]`.

## Passo 3 — Upload (`--upload`)

Use `--upload` quando o editor pede para subir o vídeo e o `.mp4` está na pasta da edição. Nos outros casos, fique no dry-run. Invocar a skill para subir o vídeo já é o pedido:

```bash
npx tsx scripts/publish-youtube.ts {AAMMDD} --upload
```

Mesmas flags do dry-run. Saída:

- **exit 0** — vídeo enviado. O JSON no stdout traz `videoId`, `url` (`https://youtu.be/{id}`), `thumbnail` (`ok: false` + `error` quando só a capa falhou: o vídeo fica, e a capa vai à mão no Studio) e `state`, o estado RELIDO. Também sai exit 0, sem enviar nada, quando `_internal/05-youtube-published.json` já registra um vídeo desta edição (`skipped: true`); `--force` sobe de novo e cria OUTRO vídeo no canal.
- **exit 1** — nada enviado (credencial ausente, vídeo ausente, canal errado, erro da API antes dos bytes, registro ilegível ou de outra edição). A mensagem diz o que fazer. Três exceções em que o vídeo PODE existir, e a mensagem manda conferir o canal antes de rodar de novo:
  - falha a partir do envio dos bytes (5xx, rede caindo, resposta sem id). O registro vira `status: upload_indeterminado`, e o próximo `--upload` recusa até `--force`. Antes do `--force`, conferir no Studio se o vídeo subiu;
  - o YouTube marcou o vídeo como `failed`/`rejected`/`deleted` na releitura. O registro fica gravado, e a mensagem traz o motivo;
  - vídeo enviado sem conseguir gravar o registro.

  E um caso em que nada foi enviado mas o editor decide (#11132): o canal tem um vídeo no dia BRT da edição sem a marca dela (sem AAMMDD, `utm_campaign` nem o título do D1 — pode ser uma live ou um vídeo avulso). O log lista todos os candidatos por período, com VIDEO_ID, link, título e data; nada é gravado e o link não vai para o D1. Mostrar ao editor e, conforme a resposta, rodar de novo com `--accept-period-match VIDEO_ID` (seleciona o candidato desta edição pelo ID: registra com `source: "already-on-channel"` e põe o link no D1) ou com `--force` (não é: sobe o vídeo da edição).

Com `--force`, o registro anterior vai para `previous_uploads` no novo.

**Link do vídeo no D1 (#10772, #10858, #10960).** Depois do upload, o próprio `--upload` grava `_internal/05-video-url.txt` — o arquivo que o Stage 5 lê para pôr o link no D1 de X, Threads e Facebook — **sempre** que o YouTube aceitou o vídeo, inclusive quando o estado relido ainda não deixa o leitor abrir: `draft` (privado, a trava da auditoria), `unknown`, ou `scheduled` com `publishAt` depois do horário do post do D1 do dia (rotação do #10305 incluída). Nesses casos o log traz `[aviso] vídeo ainda pode não abrir para o leitor: … O link será incluído no D1 mesmo assim` — o link já está no D1, e o editor precisa publicar (ou agendar antes do D1) o vídeo no Studio antes do horário do D1. Não grava só com `uploadStatus` `failed`/`rejected`/`deleted` (exit 1); uma URL diferente já gravada à mão nunca é sobrescrita. Para gravar o link à mão (arquivo ausente, ou outra URL), o editor usa:

```bash
npx tsx scripts/link-video-d1.ts {AAMMDD} --save --assume-public
```

Sem `--video-url`, o `link-video-d1` usa a `url` do registro. Sem `--assume-public`, ele recusa (exit 1, nada gravado) o vídeo cujo registro diz privado, indeterminado ou agendado para depois do D1 — vídeo `private` nunca vira link no D1.

## Passo 4 — Relatar

Mostrar ao editor: título, primeiras linhas da descrição, tags, horário (`publishAt` ou "na hora") e as premissas/avisos. Depois de `--upload`, relatar o link e o `state` relido. Com `state: draft` (sem a auditoria do YouTube API Services), dizer que o vídeo subiu **privado** e precisa ser publicado ou agendado à mão no Studio. Com `state: scheduled` e `audit_blocked: true`, dizer que está agendado, mas que o agendamento pode não torná-lo público, e conferir no Studio depois do horário. Só com `--dry-run`, a publicação segue manual pelo YouTube Studio usando esses metadados.

**Estado de publicação:** ao relatar o estado de um vídeo já existente, normalizar pelo `resolveYouTubeState` (`scripts/lib/publish-state.ts`, #573) — `private` sem `publishAt` é rascunho, nunca "publicado".
