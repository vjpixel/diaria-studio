# Alarme diário de diff pendente do sync de apoio

Issue: [#4485](https://github.com/vjpixel/diaria-studio/issues/4485) (item 2).

Fecha a lacuna do #4485: a cadência de `/diaria-apoios-sync` era zero — só
invocação manual. Sem alarme, um diff pendente entre o nível de apoio no
apoia.se e o custom field `apoio_nivel` na Beehiiv podia ficar dias sem
ninguém notar.

## O que ele faz

Task `Diaria-Apoios-Diff-Alarm` (`scripts/lib/scheduled-tasks.ts`) → `scripts/apoios-diff-alarm.ts`, rodando
diariamente às 09:45 via systemd (o antigo wrapper `.ps1` do Windows foi removido no #5115, cutover final). Computa o MESMO diff do dry-run de
`scripts/sync-apoio-nivel-beehiiv.ts` (apoia.se × custom field `apoio_nivel`
na Beehiiv) — se houver diff pendente (adições/trocas/remoções), alarma o
editor por e-mail (Gmail).

**Nunca aplica `--push`** — o gate humano de `/diaria-apoios-sync` (Passo 3)
continua sendo a única forma de gravar de verdade.

## Idempotência

Fingerprint do diff (`data/apoios-diff-alarm-state.json`,
`scripts/lib/apoios-diff-alarm.ts`) — não reenvia o mesmo e-mail todo dia
enquanto o editor não agir, mas RE-ARMA (volta a alarmar) assim que o diff
limpar e reaparecer depois.

## Log

`data/apoia-se/.diff-alarm.log` (append-only).

## Setup (ação local one-time do editor)

`local` — precisa do junction `data/` (OneDrive) + `BEEHIIV_API_KEY` +
`APOIA_SE_API_KEY`/`APOIA_SE_API_SECRET`/`APOIA_SE_CAMPAIGN` +
`data/.credentials.json` com o scope `gmail.send`.

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Apoios-Diff-Alarm
systemctl --user daemon-reload
systemctl --user enable --now diaria-apoios-diff-alarm.timer
```

Isso registra a task `Diaria-Apoios-Diff-Alarm` (diária, 09:45). Idempotente
— re-executar regenera os units. Remover: `systemctl --user disable --now diaria-apoios-diff-alarm.timer`.

**Registro da task + 1ª execução ao vivo não feitos no PR #4490/#4485**
(worktrees isolados, sem Task Scheduler real nem credenciais
Beehiiv/apoia.se/Gmail ao vivo, mesma disciplina do #4320/#4382) — ação
pendente do editor.
