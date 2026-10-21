---
name: diaria-youtube
description: Prepara o vídeo diário "diar.ia.br comentada" (Pixel comentando o D1) para o canal @diariabr no YouTube — metadados derivados da edição (título do D1, descrição com resumo + fonte + link da edição + CTA com UTM youtube, 6 tags), capa e agendamento 06:00 BRT (ou na hora, se já passou). Roda fora da pipeline, para o caso do vídeo ficar pronto depois do Stage 5. Hoje só em modo dry-run — o upload real depende do OAuth da conta @diariabr e da auditoria do projeto GCP (#10659). Uso — `/diaria-youtube AAMMDD`.
---

# /diaria-youtube AAMMDD (#10659)

Vídeo diário no YouTube (`@diariabr`) com o Pixel comentando o D1 da edição, decisão do editor de 21/10/2026 (1º vídeo: edição 261021, https://youtu.be/QRbXMprk9o0). Esta skill cobre só esse vídeo, fora da pipeline: o caso em que o vídeo fica pronto depois do Stage 5. O publisher é o mesmo que o passo futuro do Stage 5 vai usar (`scripts/publish-youtube.ts`).

**Data:** `AAMMDD` é obrigatório. Se não for passado, assumir D+1 com o banner padrão do `CLAUDE.md` (`Data não informada — assumindo {AAMMDD} (D+1). Passe AAMMDD explicitamente para outra edição.`), nunca perguntar.

## Estado atual: só dry-run

O upload real **ainda não existe**. Faltam, por bloqueio externo (registrado no #10659):

- OAuth da conta dona do `@diariabr` com scope `youtube.upload` e refresh token no Doppler;
- auditoria do projeto GCP no YouTube API Services (sem ela todo upload via API sai forçado `private`);
- integração do passo no Stage 5 (fail-soft quando o vídeo ainda não existir).

Sem `--dry-run` o script recusa com exit 2. Não contornar: nunca subir pelo Claude in Chrome (upload de arquivo é bloqueado lá, e o projeto prefere API oficial).

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

## Passo 3 — Relatar

Mostrar ao editor: título, primeiras linhas da descrição, tags, horário (`publishAt` ou "na hora") e as premissas/avisos. Como ainda não há upload real, a publicação desse dia segue manual pelo YouTube Studio usando esses metadados.

**Estado de publicação:** ao relatar o estado de um vídeo já existente, normalizar pelo `resolveYouTubeState` (`scripts/lib/publish-state.ts`, #573) — `private` sem `publishAt` é rascunho, nunca "publicado".
