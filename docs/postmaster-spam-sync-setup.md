# Sync automático do spamRate do Google Postmaster Tools

Issue: [#4154](https://github.com/vjpixel/diaria-studio/issues/4154).

Substitui a leitura MANUAL do painel do Google Postmaster Tools
(`scripts/postmaster-spam-entry.ts`, mantido como fallback) por um sync
automático.

## O que ele faz

`scripts/run-postmaster-spam-sync.ps1` → `scripts/postmaster-spam-sync.ts`,
rodando diariamente às 12:30 (mudou de "a cada 12h", decisão do editor
260810 — a leitura já é uma MÉDIA sobre uma janela de dias, 1x/dia basta; a
cadência de 12h nunca leu nada mais fresco, só gastava a chamada à toa).
Grava a MÉDIA do
`userReportedSpamRatio` de `clarice.ai` sobre uma janela de dias (mesma
janela — `HEALTH_SAMPLE_DAYS` — das outras métricas da aba Rampa, #4345) na
mesma chave KV (`postmaster:spam`) que o breaker de spam da Rampa consome
(`resolveSpamSignal` em `workers/brevo-dashboard/src/thresholds.ts`).

**Histórico completo** do bloqueio original, da correção do erro de HTTP vs.
"dado ainda não publicado" e da semântica de `userReportedSpamRatio` AUSENTE
(#4154/#4345 — a interpretação mudou; ver a data do commit antes de confiar
de cabeça) fica direto no docstring de `scripts/postmaster-spam-sync.ts`
(fonte única de verdade — não duplicar aqui).

## Log

`data/clarice-subscribers/.postmaster-spam-sync.log` (append-only).

## Setup (ação local one-time do editor)

`local` — precisa do junction `data/` (OneDrive) + `data/.credentials.json`
com o scope `postmaster.readonly` + `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_WORKERS_TOKEN`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-postmaster-spam-sync-schedule.ps1
```

Isso registra a task `Diaria-Postmaster-Spam-Sync` (diária, 12:30). Idempotente
— re-executar atualiza a task. Remover: mesmo comando com `-Unregister`.
