# Sync incremental diário do store Clarice

Issue: [#2932](https://github.com/vjpixel/diaria-studio/issues/2932).

Mantém o store SQLite de contatos Clarice (usado por `clarice-build-segment.ts` e
vizinhos) e a dashboard sincronizados com a Brevo, sem pagar o custo de um full
sync a cada execução.

## Horário

**08:30** — mudou de 03:40 (até 260727) para **depois** do envio canônico das
06:00 BRT, de propósito: só assim `sends_count`/`brevo_list_ids` refletem o
envio da manhã antes do editor montar a onda seguinte. Com 03:40 a onda do dia
ficava invisível pro store e o `--group` repetia as mesmas pessoas.

## O que ele faz (task `Diaria-Clarice-Sync`, dois passos)

1. **`clarice-sync-brevo.ts --incremental`** — sincroniza só os contatos
   MUDADOS desde o último sync (`modifiedSince` da Brevo, #2928). Barato
   comparado ao full sync: **142.573 chamadas** medido ao vivo em 260806
   (#4701) — esse número cresce com a base, re-derivar antes de citar (mesma
   disciplina do #1172). Atualiza o **store** (SQLite).
2. **`clarice-db-summary.ts`** — empurra o summary pra **KV**, que atualiza a
   **dashboard**. Store e KV são superfícies SEPARADAS: sem o passo 2 a
   dashboard fica defasada mesmo com o store fresco.

## Catch-up de opens (#4688)

Abrir um e-mail não toca `modifiedAt` do contato na Brevo — só clique/outras
mutações tocam — então o `modifiedSince` do passo 1 sozinho nunca revisita
quem só abre sem clicar, e `opens_count` degradava continuamente (medido ao
vivo em 260806: ~32% de subcontagem agregada antes de um full resync manual).

Todo `--incremental` (inclusive o da task diária) também varre os
destinatários das campanhas enviadas numa janela recente
(`--opens-window-days`, default 7 — encolhido de 30 no #5946 pra caber no
teto de 100 req/hora da Brevo) via
`POST /emailCampaigns/{id}/exportRecipients` (reusa a infra de
`clarice-engagement-cohorts-v2.ts`, #4451, já validada ao vivo) e re-busca
individualmente cada opener encontrado — independe do `modifiedAt` do
contato.

**Fatiamento por run (#5946 follow-up):** encolher a janela não bastou — o
volume de campanhas DENTRO dela cresceu com a cadência de envio (~62 em
260826) e sozinho voltou a se aproximar do teto de 100 req/hora
(compartilhado com `clarice-build-segment.ts`/`clarice-plan-wave.ts` na
mesma hora). `--opens-max-refresh` (default 20) limita quantas campanhas
**já cacheadas** são forçadas a re-exportar por execução — as demais reusam
o cache em disco (`OPENS_CATCHUP_CACHE_DIR`) sem gastar cota. Uma campanha
nunca vista ainda é sempre buscada (baseline), independente do teto.
Priorização por staleness (`pickCampaignsToRefresh`, sem cache primeiro,
depois `exportedAt` mais antigo) — o progresso é durável entre execuções via
o próprio `exportedAt` já persistido em disco, sem checkpoint dedicado: a
campanha que ficou de fora hoje sobe pro topo da fila amanhã. `0` desliga o
fatiamento (comportamento pré-#5946, refresca tudo todo dia).

Fail-soft: uma falha no catch-up nunca reprova o sync principal
(`opens_catchup.error` no summary). Desligável via `--no-catch-opens`.

O sucesso/erro desse catch-up é monitorado por um alarme dedicado de falha
sustentada — ver `docs/clarice-opens-catchup-alarm-setup.md`.

## Log

`data/clarice-subscribers/.brevo-sync-daily.log` (append-only).

## Setup (ação local one-time do editor)

`local` — precisa do junction `data/` (OneDrive) + `BREVO_CLARICE_API_KEY` +
credenciais Cloudflare (pro passo do KV summary).

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Sync
systemctl --user daemon-reload
systemctl --user enable --now diaria-clarice-sync.timer
```

Isso registra a task `Diaria-Clarice-Sync` (diária, 08:30). Idempotente —
re-executar regenera os units. Remover: `systemctl --user disable --now diaria-clarice-sync.timer`.

**1ª execução ao vivo do catch-up de opens dentro da task agendada não feita
em nenhuma unidade de worktree isolado** (sem `BREVO_CLARICE_API_KEY` real) —
mesma disciplina do #4320/#4382/#4490/#4534. A próxima run de
`Diaria-Clarice-Sync` já exercita o caminho novo automaticamente (nenhuma
mudança na task — o catch-up vive dentro do mesmo
`clarice-sync-brevo.ts --incremental` já agendado).
