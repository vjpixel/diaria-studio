# Alarme de staleness da retro semanal

Issue: [#11069](https://github.com/vjpixel/diaria-studio/issues/11069).

`scripts/retro-semanal-staleness-alarm.ts` + `scripts/lib/retro-semanal-staleness-alarm.ts` avisam quando a `/diaria-retro-semanal` ainda não agendou o carrossel de sábado. Na semana 261024 a skill só rodou no sábado 24/10 às 23:12 BRT, os dois carrosséis saíram no domingo e o slot de sábado foi perdido sem que nada avisasse.

Irmão do [`Diaria-LinkedIn-Weekly-Staleness-Alarm`](linkedin-weekly-staleness-alarm-setup.md) (#5111): mesmo molde de issue automática (`alarm-issues.ts`) e aviso ao editor (`notifyEditorForOutcomes`, severidade `acao`).

## O que ele checa

A task roda no sábado de manhã e resolve o sábado-âncora da semana (o próprio dia; num catch-up de domingo em diante, o sábado anterior). Procura evidência do carrossel `highlights`, o que publica no próprio sábado:

1. **Store local** `data/weekly/{AAMMDD}/06-weekly-published.json`, escrito por `publish-weekly-social.ts --schedule`: alguma entrada `destaque: "weekly-highlights"` com status `scheduled`, `published` ou `draft`. Entrada só `failed`/`skipped`/`deleted` não conta: a rodada existiu, mas nada ficou agendado.
2. **Fila do Worker** `diaria-linkedin-cron` (`GET /list`, só leitura), consultada só quando o store não prova: algum item `destaque: "weekly-highlights"` com `scheduled_at` nesse sábado (BRT).

- Evidência em qualquer das duas → **OK, sem alarme.**
- Nenhuma → **ALARME** (issue + aviso).

O estado do carrossel `clicked` (domingo) aparece no corpo da issue como informação, mas não decide o veredito.

## Por que consultar o Worker

`data/` replica por OneDrive. Se a skill rodou na máquina do editor e o store ainda não chegou em `300`, o arquivo ausente não prova que nada rodou (`context/overnight-dispatch-rules.md` item 23). A fila do Worker é a fonte do que está de fato agendado. Sem credencial ou com o Worker fora do ar, o veredito usa só o store e a issue registra que o Worker não foi consultado. Nesse caso o alarme pode ser falso, o que é aceitável: a issue fecha sozinha, e ficar em silêncio sobre um slot perdido é o problema que a #11069 pede pra resolver.

## Horário: sábado 07:00 BRT

O carrossel `highlights` publica às 11:00 fora do teste rotativo. Durante o teste (#10305), `publishing.social.rotation.weekend_candidates` inclui 08:00. Às 07:00 ainda sobra tempo antes do candidato mais cedo. A issue sugeria 09:00 como exemplo, mas nesse horário o aviso poderia chegar depois do slot.

## Idempotência

Um achado por sábado (`fingerprint` = `AAMMDD`). Rodar de novo no mesmo sábado reusa a issue e não reenvia e-mail (`legacyResendIntent: "dedupe-new-occurrences-only"`). A issue fecha sozinha depois de 2 execuções limpas consecutivas.

Estado: `data/weekly/retro-semanal-staleness-alarm-issues.json`. Log da task: `data/weekly/.retro-semanal-staleness-alarm.log`.

## Como conferir à mão

```bash
npx tsx scripts/retro-semanal-staleness-alarm.ts --dry-run
npx tsx scripts/retro-semanal-staleness-alarm.ts --dry-run --saturday 261024
```

O `--dry-run` não chama `gh` nem envia e-mail, mas ainda faz o GET de leitura na fila do Worker quando o store não basta. `--to email@x` troca o destinatário.

## O que fazer quando o alarme dispara

Rode `/diaria-retro-semanal {AAMMDD do sábado}`. Se o slot de sábado já tiver passado, o `--check-slot` da skill avisa antes de agendar.

## Setup (ação one-time em `300`, NÃO feita nesta unidade)

Requer `DIARIA_LINKEDIN_CRON_URL` (ou `publishing.social.linkedin.cloudflare_worker_url`) e `DIARIA_LINKEDIN_CRON_TOKEN` no `.env` para consultar o Worker, as mesmas vars do `publish-weekly-social.ts`. Sem elas, a task roda só com o store local.

Sem `.ps1`/Task Scheduler: nenhuma task `Diaria-*` roda no Windows (#5074). Linux/systemd:

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Retro-Semanal-Staleness-Alarm
systemctl --user daemon-reload
systemctl --user enable --now diaria-retro-semanal-staleness-alarm.timer
```
