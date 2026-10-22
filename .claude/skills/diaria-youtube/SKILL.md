---
name: diaria-youtube
description: Prepara o vídeo diário "diar.ia.br comentada" (Pixel comentando o D1) para o canal @diariabr no YouTube — metadados derivados da edição (título do D1, descrição com resumo + fonte + link da edição + CTA com UTM youtube, 6 tags), capa e agendamento 06:00 BRT (ou na hora, se já passou). Roda fora da pipeline, para o caso do vídeo ficar pronto depois do Stage 5. Hoje só em modo dry-run — o upload real depende do OAuth da conta @diariabr e da auditoria do projeto GCP (#10659). Uso — `/diaria-youtube AAMMDD`.
---

# /diaria-youtube AAMMDD (#10659)

Vídeo diário no YouTube (`@diariabr`) com o Pixel comentando o D1 da edição, decisão do editor de 21/10/2026 (1º vídeo: edição 261021, https://youtu.be/QRbXMprk9o0). Esta skill cobre só esse vídeo, fora da pipeline: o caso em que o vídeo fica pronto depois do Stage 5. O publisher é o mesmo que o passo futuro do Stage 5 vai usar (`scripts/publish-youtube.ts`).

**Data:** `AAMMDD` é obrigatório. Se não for passado, assumir D+1 com o banner padrão do `CLAUDE.md` (`Data não informada — assumindo {AAMMDD} (D+1). Passe AAMMDD explicitamente para outra edição.`), nunca perguntar.

## Estado atual: dry-run e `--upload`

O script tem dois modos, e um deles é obrigatório (sem nenhum, ou com os dois, sai exit 2):

- `--dry-run` — só o plano, sem rede. É o default da skill.
- `--upload` — upload real pela YouTube Data API v3 (#10659): `videos.insert` resumable com `privacyStatus`/`publishAt` do plano, `thumbnails.set` com a capa, releitura do estado por `resolveYouTubeState` (#573) e registro em `_internal/05-youtube-published.json`.

O token vem do OAuth do canal (`scripts/youtube-oauth-setup.ts`, PR #10757): `YOUTUBE_REFRESH_TOKEN` e `YOUTUBE_CHANNEL_ID` no Doppler/`.env`, mais o client `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`. Sem eles o script sai exit 1 dizendo quais faltam.

**Sem a auditoria do YouTube API Services, o upload via API pode sair `private`**, mesmo pedindo `public` ou `publishAt`. É a restrição de 2020 do histórico da API; a página atual de `videos.insert` diz o contrário, e o 1º upload real confirma pela releitura. A releitura mostra `draft` ou `scheduled`. Se o vídeo ficar privado, ele precisa ser publicado (ou agendado) à mão no Studio.

Ainda fora daqui: o download do vídeo pelo Drive e o passo no Stage 5 (a convenção de nome do arquivo não foi confirmada). Não contornar com o Claude in Chrome: upload de arquivo é bloqueado lá, e o projeto prefere API oficial.

## Passo 1 — Conferir os insumos

Na pasta da edição (`data/editions/{AAMM}/{AAMMDD}/`):

- `02-reviewed.md` — obrigatório (é de onde sai o D1);
- `diaria-comentada-{AAMMDD}.mp4` — o vídeo (convenção de nome; outro caminho via `--video`). Ausente vira aviso, não erro;
- `04-youtube-thumb.jpg` — capa 1280x720 aprovada (opcional; sem ela o YouTube gera a dele, que já veio com contorno neon no #1).

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

Com `--force`, o registro anterior vai para `previous_uploads` no novo.

## Passo 4 — Relatar

Mostrar ao editor: título, primeiras linhas da descrição, tags, horário (`publishAt` ou "na hora") e as premissas/avisos. Depois de `--upload`, relatar o link e o `state` relido. Com `state: draft` (sem a auditoria do YouTube API Services), dizer que o vídeo subiu **privado** e precisa ser publicado ou agendado à mão no Studio. Com `state: scheduled` e `audit_blocked: true`, dizer que está agendado, mas que o agendamento pode não torná-lo público, e conferir no Studio depois do horário. Só com `--dry-run`, a publicação segue manual pelo YouTube Studio usando esses metadados.

**Estado de publicação:** ao relatar o estado de um vídeo já existente, normalizar pelo `resolveYouTubeState` (`scripts/lib/publish-state.ts`, #573) — `private` sem `publishAt` é rascunho, nunca "publicado".
