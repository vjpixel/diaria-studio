---
name: diaria-shorts
description: Publica o vídeo CURTO (vertical) da edição — o recorte do "diar.ia.br comentada" — como YouTube Shorts e como Reels nas páginas do Facebook (diar.ia.br e VJ Pixel), no Instagram pessoal do editor com a diar.ia.br em collab e no perfil pessoal do editor, para divulgar o canal @diariabr. Reels de página e Instagram saem pela Graph API (`scripts/publish-shorts.ts`); YouTube Shorts e perfil pessoal são passos guiados no Claude in Chrome, com o editor escolhendo o arquivo. Uso — `/diaria-shorts AAMMDD`.
---

# /diaria-shorts AAMMDD (#10769)

Vídeo curto de cada edição, decisão do editor de 21/10/2026: além do vídeo longo do YouTube (`/diaria-youtube`, #10659), o vertical sai **todo dia** como Shorts e como Reels. O objetivo é levar gente pro canal do YouTube. O 1º Short (edição 261021) foi publicado à mão e serviu de modelo: https://youtube.com/shorts/nhMUtgPPs4U.

Invocar a skill é o pedido de publicação: publicar nos destinos abaixo não precisa de confirmação extra.

**Data:** se o editor não passar `AAMMDD`, assumir D+1 com o banner padrão do `CLAUDE.md` (`Data não informada — assumindo {AAMMDD} (D+1). Passe AAMMDD explicitamente para outra edição.`), nunca perguntar, e passar a data explicitamente ao script (ele exige).

## Destinos (`platform.config.json` → `publishing.shorts`)

| Destino | Como | Observação |
|---|---|---|
| `youtube_shorts` | guiado (Chrome) | a API trava todo upload em `private` sem a auditoria do GCP (#10659) |
| `facebook:diaria`, `facebook:vjpixel` | API | agenda pro horário do vertical (abaixo) se faltar mais de 10 min (piso do Facebook); senão, na hora. Até 90 s sobe como Reels (`video_reels`); acima disso, como vídeo da Página (`/videos`, upload resumable em blocos, #10815), que o Facebook mostra como Reel quando é vertical |
| `instagram` | API (Reels resumable) | autora = conta pessoal do editor (@vjpixel), a conta do Instagram vinculada à página VJ pixel (`instagram_author_page`), publicando com o token dessa página; `diar.ia.br` entra como collab (`instagram_collaborators`) e aceita o convite no app. Sem conta vinculada, ou com token sem `instagram_content_publish` (conferido no dry-run, #10820), o destino é pulado com o passo que destrava, nunca cai na conta da diar.ia.br. Depois do publish o script relê os collabs e avisa se o convite foi descartado. O Instagram não agenda Reels por API: com horário futuro o script sobe o vertical pro R2 e põe o Reels na fila do Worker `diaria-linkedin-cron`, que publica no horário (#10823; conta por `ig_account`, collabs na entry). Sem Worker (`DIARIA_LINKEDIN_CRON_URL`/`_TOKEN`) ou sem R2 (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `SHORTS_R2_BUCKET`, `SHORTS_R2_PUBLIC_BASE`; a cada upload o script apaga os verticais com mais de 7 dias em `shorts/`, com a mesma chave, e o bucket fica perto de 2 GB, dentro dos 10 GB gratuitos, #10923), fica pendente até rodar de novo depois do horário do vertical (ou `--now`), como antes. **Teto de duração (#10893, por conta desde #10916):** a API recusa Reels acima de um teto que muda por conta, sempre por duração e não por tamanho (rupload `400 ProcessingFailedError` / container `2207076`): @vjpixel aceita 40 s e recusa 42 s (22/10/2026); @diar.ia.br aceita 55 s e recusa 58 s (23/10/2026). Config: `publishing.shorts.instagram_api_max_seconds_by_account` (chave = slug de `instagram_author_page`; `diaria` = autora `null`, a conta do env), com fallback pro `instagram_api_max_seconds` legado e depois 40; `null` desliga o teto da conta. O plano lê a duração do MP4 e, acima do teto da autora, o Instagram vira passo **guiado** pelo Chrome (Passo 3b). O script nunca corta o vídeo: uma versão recortada só pro Instagram muda o conteúdo e é decisão editorial. Só a qualidade cai (720p, perda aceita pelo editor em 22/10) |
| `linkedin_profile` | API (Videos API, #10772) | vídeo **nativo** no perfil pessoal do editor, com o token do 4º post (`LINKEDIN_PERSONAL_*`, `docs/linkedin-personal-setup.md`). Texto: título, gancho, vídeo completo do YouTube (`_internal/05-video-url.txt`; sem ele, o canal) e a edição com `utm_source=linkedin&utm_medium=video&utm_campaign={AAMMDD}`. A Posts API **não agenda**: antes do horário fica `pending_schedule` — rodar de novo depois do horário (ou `--now`). Envio ambíguo (timeout/5xx) grava `send_unknown` e nunca re-posta: conferir o perfil e registrar com `--mark linkedin_profile=URL` |
| `linkedin_page_repost` | guiado (Chrome) | repost do vídeo do perfil **pela página** diar.ia.br, no horário `at` do plano: a grade da página (rotação #10305) decide, com 2 h de distância dos posts dela e ≥30 min depois do perfil. Guiado porque não há token de organização local |
| `x` | guiado (Buffer MCP) | X @diariabr. O plano traz o texto (≤280 ponderado) e o `scheduledAt`; o `--publish` sobe o vertical pro R2 e devolve `results[].buffer` (`text`, `dueAt`, `videoUrl`). Sem R2 o destino é pulado com aviso |
| `facebook_profile` | guiado (Chrome) | a Graph API não publica em perfil pessoal |

**Horário do vertical (#10831):** o horizontal sai às 06:00 junto da newsletter; o vertical (Short, Reels e Instagram) sai em horário **próprio**, nunca às 06:00. Teste de 15 dias úteis (261026, segunda, a 261113, sexta; só há edição de segunda a sexta) alternando **06:30, 08:00 e 12:00 BRT** dia a dia (revisto em 22/10/2026: os cliques da newsletter concentram 59% entre 06h e 10h e só 2% às 19h; o teste 12:00/19:00 valeu só para 261022 e 261023) (`publishing.shorts.schedule`, `resolveShortTime`), comparando as visualizações nas primeiras 24 h; fora da janela vale `default_time`. O plano traz o horário em `shortTime` (`hhmm`, `at`). **Grade (#10819):** o plano lê o que já está agendado no dia (`_internal/06-social-published.json` + `06-shorts-published.json` + a fila do Worker, `GET /list`, que traz os posts das skills de divulgação; sem Worker vira `[aviso]` e segue só com os stores). O Instagram em collab conta também como post da @diar.ia.br (decisão do editor 261023). Durante o teste, o horário do teste vale pra todos os destinos e a grade só vira `[aviso]` quando ele cola (<2 h) num post da mesma conta; fora do teste, cada destino de API tem horário próprio em `slots` (alinha a post de outra conta; na mesma conta, espaçamento mínimo de 2 h e preferência pelos picos de uso 07–09, 12–14 e 18–21 BRT, decisão do editor no briefing 261022b, `scripts/lib/social-slot-planner.ts`). Destinos guiados seguem `shortTime`.

Os dois destinos guiados aparecem no plano, mas o script não os executa: são os Passos 4 e 5. MemeLab saiu da rotina em 22/10/2026 (#10790). Jandig, Teatro vs Game e Criaturas Afetivas também ficam **fora** da rotina — só quando o editor pedir.

Página sem token (`[aviso] facebook:{slug}: sem credencial`) não bloqueia as outras. Para gerar o token, o **editor** roda no terminal dele (o token nunca passa pelo chat):

```bash
npx tsx scripts/facebook-page-token-setup.ts --pages vjpixel
```

O script pede o User Access Token do Graph API Explorer (permissões `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`; para a página `vjpixel`, que também publica o Instagram pessoal, mais `instagram_basic` e `instagram_content_publish`), lê sem eco na tela e grava id + token de página no `.env` e no Doppler. Nunca pedir nem colar o token aqui.

## Passo 1 — O vídeo

Convenção: `data/editions/{AAMM}/{AAMMDD}/diaria-comentada-{AAMMDD}-short.mp4`.

Se não estiver lá, achar o id no Drive pelo conector do Google Drive (`search_files`, `mimeType contains 'video/'`, `modifiedTime` recente, título com `Vertical`) e baixar pelo id. O download usa o OAuth do próprio projeto (`data/.credentials.json`), não o conector: se falhar por token, renovar com `oauth-setup.ts`. O script exige `02-reviewed.md` antes de baixar.

```bash
npx tsx scripts/publish-shorts.ts {AAMMDD} --from-drive {FILE_ID}
```

Mais de um candidato (V1, V2, V3…): usar a versão mais alta. Se a escolha não for óbvia, mostrar os nomes ao editor.

## Passo 2 — Plano

```bash
npx tsx scripts/publish-shorts.ts {AAMMDD}
```

Dry-run: imprime título/descrição e horário do Shorts, a legenda de cada Reels, o horário e o que será pulado (já publicado, sem credencial, pendente). Link da edição: `--edition-url` > `_internal/05-edition-url.txt` > slug derivado do título (vira `[aviso]` — conferir antes de publicar).

## Passo 3 — Reels por API

```bash
npx tsx scripts/publish-shorts.ts {AAMMDD} --publish
```

Cada destino é gravado em `_internal/06-shorts-published.json` assim que sai. Re-rodar pula o que já foi feito, então pode rodar de novo depois do horário do vertical só para o Instagram (quando ele ficou pendente por falta de fila). Instagram enfileirado é gravado `scheduled` com a key da fila no `id` — re-rodar não enfileira de novo. Registro ilegível aborta em vez de republicar. `(processamento não confirmado em 5 min — confira)` numa linha `[ok]` pede uma olhada na página antes de relatar como publicado.

## Passo 3b — Instagram acima do teto (Chrome, #10915)

Só quando o item `instagram` do plano vem `guided` (vertical acima do teto da autora). O item traz `at`: o horário do slot que o plano já reservou na grade para ele (#10933, #10819), então os outros destinos e o repost do LinkedIn foram planejados contando com esse post — publicar nesse horário, não no `shortTime` cru. Roda **só na máquina Windows do editor**, com o Chrome logado no instagram.com como @vjpixel (label `windows`); fora dela, deixar o passo pro editor e seguir.

O `--publish` do Passo 3, depois de publicar os destinos de API, gera a versão para o `file_upload` do Claude in Chrome: `_internal/diaria-comentada-{AAMMDD}-short-instagram-chrome.mp4`, ffmpeg 2-pass em 720x1280, AAC 64k 48 kHz, `+faststart`, bitrate calculado pela duração mirando 9,5 MB (abaixo do limite de 10 MB do `file_upload`). Vídeos muito longos podem não caber nem no bitrate mínimo (250 kbps de vídeo: acima de ~4 min o arquivo passa dos 10 MB). O item traz `upload: { path, sizeBytes, fitsChromeUpload }` e a legenda pronta em `caption`. Se o ffmpeg falhar (ou passar de 15 min por passada), `upload.path` aponta pro original com `fitsChromeUpload: false` (sai `[aviso]`). Rodar de novo reaproveita o arquivo gerado só quando o sidecar `.json` ao lado dele bate com o vertical atual (caminho, tamanho, mtime) e com o bitrate.

1. Carregar as ferramentas do Claude in Chrome e abrir `https://www.instagram.com/` numa aba nova. Conferir no avatar que a conta é @vjpixel.
2. **Criar > Post.** Conferir `upload.fitsChromeUpload` antes de subir. Se for `true`, subir `upload.path` pelo `<input type="file">` do diálogo com `file_upload`. Se for `false` (arquivo acima de 10 MB ou compressão falhou), **não** chamar `file_upload`: chamar o editor para escolher o arquivo no diálogo.
3. **Proporção 9:16.** O diálogo abre em 1:1: abrir o seletor de proporção (ícone de recorte no canto inferior esquerdo) e escolher 9:16. O seletor **fecha** ao clicar em "Original"; se isso acontecer, abrir de novo e escolher 9:16.
4. Avançar **duas vezes** (recorte e depois filtros) até a tela da legenda.
5. Colar a legenda do `caption` do item.
6. **Add collaborators:** digitar `diar.ia.br` e escolher a conta na lista.
7. **Share.** O processamento leva de 30 a 60 s depois do clique. A tela de "publicado" não é confirmação.
8. **Confirmar pela API** (lê `/{ig-user}/media`, só leitura, e grava a entrada `instagram` em `06-shorts-published.json`):

   ```bash
   npx tsx scripts/publish-shorts.ts {AAMMDD} --confirm-instagram
   ```

   Ele lê as 15 mídias mais recentes da autora e registra o único Reels desde 00:00 BRT do dia da edição (`--since ISO` muda o corte) cuja legenda tem o marcador da edição: o título do D1, que abre a legenda (ou `utm_campaign={AAMMDD}`/URL da edição, se a legenda trouxer o link). Sem nenhum match, ou com mais de um, recusa (exit 1) sem gravar e lista os candidatos (id, horário, permalink); aí escolher com `--media-id {id}`. Avisa quando o collab ficou `Pending` (a @diar.ia.br ainda precisa aceitar o convite no app), `Declined` (convidar de novo) ou foi descartado. "Nenhum Reels desde…" logo depois do Share costuma ser o processamento: esperar um minuto e rodar de novo. Se o `instagram` já está registrado, não grava nada e sai não-zero quando o registro não é `published`. Sem acesso à API, registrar à mão com `--mark instagram={URL do Reel}`.

Relatar o Instagram como publicado só depois do `--confirm-instagram` (#573), e com o collab `Pending` ou `Declined` dito explicitamente quando for o caso.

## Passo 4 — YouTube Shorts (Chrome)

Carregar as ferramentas do Claude in Chrome. Abrir `https://studio.youtube.com/channel/UCSsppeUnBy6q-4a5hsl5u0w/videos/upload?d=ud`.

1. **Chamar o editor** para clicar em "Selecionar arquivos" e escolher o vertical: o upload de arquivo é bloqueado no Chrome (e o `file_upload` tem limite de 10 MB).
2. Título e descrição do plano (`youtube.title`, `youtube.description`). Em "Mostrar mais": tags do vídeo longo, idioma Português (Brasil), categoria Ciência e tecnologia. Público: "Não é conteúdo para crianças".
3. **Capa:** um frame do próprio vídeo com o lettering do título (orientação na #10800; enquanto a geração não existir, escolher o frame no Studio).
4. Visibilidade **Agendar** para o horário do vertical (`shortTime.hhmm` BRT do dia da edição; se já passou, Público). **Esperar "Verificações concluídas"** antes de confirmar: publicar durante a verificação mostra o aviso "Ainda estamos verificando seu conteúdo" (risco de advertência ou visibilidade restrita).
5. **Vídeo relacionado não se vincula no upload:** o seletor só lista vídeo público e o horizontal ainda está agendado. O vínculo (Elementos do vídeo → Vídeo relacionado → o horizontal da edição) acontece depois que o horizontal publica às 06:00 e antes do horário do Short — automação na #10811; até ela existir, é passo manual nessa janela.
6. Sem comentário fixado: desde 2023 link em descrição e em comentário de Short não é clicável (#10831). O único caminho clicável até a edição é o vídeo relacionado.
7. Registrar: `npx tsx scripts/publish-shorts.ts {AAMMDD} --mark youtube_shorts={URL do Short}` (`--mark` só aceita os destinos guiados — `youtube_shorts`, `facebook_profile`, `linkedin_page_repost`, `x` —, o `instagram` quando o plano o devolve como guiado pelo teto de duração, #10893, e o `linkedin_profile` depois de conferir um `send_unknown`, #10772; sempre com URL http/https, exceto `x=buffer:{id}`).

## Passo 5 — Perfil pessoal (Chrome)

O Facebook do Chrome costuma estar na identidade da página diar.ia.br. Trocar para o perfil pessoal (menu do avatar → perfil do editor), criar Reel e **chamar o editor** para escolher o arquivo. Legenda: `caption` do item `facebook_profile`. Publicar e registrar com `--mark facebook_profile={URL}`. **Voltar o Chrome para a identidade da página diar.ia.br no fim.**

Atalho aceitável: compartilhar no perfil o Reels já publicado na página diar.ia.br, com a mesma legenda.

## Passo 5b — X e repost da página no LinkedIn (#10772)

**X:** com o `results[].buffer` do Passo 3, chamar a Buffer no canal @diariabr: `create_post` com o `text`, `mode: "customScheduled"` e `dueAt` (se `dueAt` for null, publicar já) e o vídeo como asset por URL (`assets: [{ video: { url: videoUrl } }]`). Se o schema do conector recusar o formato, conferir com `introspect_schema` e usar `execute_mutation` com a mesma mutation `createPost` (mesma armadilha do array de imagens do Stage 5, #8056). **Conferir na 1ª execução real (#10772 F5):** o formato `assets: [{ video: { url } }]` é premissa não verificada contra o schema do conector, e o limite de tamanho de vídeo da Buffer para o X não foi medido (o vertical de 261022 tinha 275 MB) — se a Buffer recusar por tamanho, registrar o motivo e postar o X à mão. Registrar: `npx tsx scripts/publish-shorts.ts {AAMMDD} --mark x=buffer:{id do post} --scheduled-at {dueAt}`.

**Repost da página:** só é oferecido quando `linkedin_profile` já está registrado ou sai nesta rodada; se o perfil foi pulado ou falhou, o item vem `skip_invalid` com o motivo (#10772 F1). O `linkedin_profile` que passou mais de 3 h do horário vem `skip_late` (#10772 F4): postar à mão e registrar com `--mark linkedin_profile={URL}`, ou rodar com `--now`. Depois que `linkedin_profile` saiu, no horário `at` do item `linkedin_page_repost`, abrir o post do perfil no Chrome com a identidade da página diar.ia.br, "Repostar" e registrar com `--mark linkedin_page_repost={URL}`.

## Link do vídeo no post do D1 (#10772)

Decisão do editor (22/10/2026): no LinkedIn página, no X, no Threads e no Facebook diar.ia.br o vídeo não sobe nativo — o link do YouTube entra no post do D1.

```bash
npx tsx scripts/link-video-d1.ts {AAMMDD} --video-url {URL do YouTube} --save
```

`--save` grava `_internal/05-video-url.txt`. Se isso acontecer antes do Stage 5, o próprio Stage 5 põe o link no D1 do X (1º link do texto), do Threads e do Facebook diar.ia.br (X e Threads só se couber no limite). O JSON impresso é o plano para posts do D1 já agendados ou publicados: `edit_scheduled` (editar antes do disparo), `comment_after` (comentar/responder; no LinkedIn é sempre o 1º comentário). O script não edita nem comenta nada: aplicar o plano ainda é manual.

Se o vídeo subiu por `publish-youtube.ts --upload`, `--video-url` é opcional (vale a `url` de `_internal/05-youtube-published.json`) e o script recusa (exit 1) o vídeo que o registro diz privado ou agendado para depois do D1 (#10858). Confirmado público no Studio, rodar com `--assume-public`.

## Passo 6 — Relatar

Uma linha por destino, com o estado normalizado da linha `[ok] … (estado …)` (`resolveShortEntryState`): publicado/agendado (com URL), `send_unknown` do LinkedIn (conferir o perfil), X agendado na Buffer (`scheduled` até o `dueAt`, depois `unknown` até conferir), na fila do Worker (Instagram, `scheduled` até a hora, depois `unknown` até confirmar no app — `resolveWorkerQueueState`), pendente (Instagram sem fila, antes do horário do vertical), Instagram manual acima do teto (pendente até o `--confirm-instagram` ou `--mark instagram=URL` do Passo 3b), pulado (sem credencial, com o comando de setup). Normalizar o estado como manda o #573: "agendado" não é "publicado".

Teste de 2 semanas a partir de 261022 (#10769, destinos; o teste de horário do #10831 é outro, ver acima): no fim, comparar os visualizadores e as visitas ao canal por destino, e manter só os destinos que trouxerem gente.
