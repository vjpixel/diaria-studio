# Alarme de drift de versão em sessão Claude Code de vida longa

Issue: [#6927](https://github.com/vjpixel/diaria-studio/issues/6927), decisão fecha o que ficou aberto no [#6875](https://github.com/vjpixel/diaria-studio/issues/6875)/[#6891](https://github.com/vjpixel/diaria-studio/issues/6891).

## O que ele faz — e o que ele NÃO faz

**Isto é um alarme SEM POLÍTICA (opção 3 do #6927, decisão do editor).** Ele
não reinicia sessão nenhuma, não desliga o auto-update, e não escolhe entre
as duas opções de fundo que o #6927 deixou em aberto (reinício periódico das
sessões de vida longa vs. `DISABLE_AUTOUPDATER=1` também nas interativas). O
único objetivo é **nomear o estado exato** que causava o problema medido em
#6875/#6891, pra alguém decidir com informação, não às cegas.

### O problema que ele nomeia

O auto-updater do Claude Code compara a versão contra a que o **processo em
execução** carregou, não contra a versão em disco. Uma sessão de vida longa
(`--remote-control`, tmux) fica com uma versão velha carregada em memória
enquanto o disco já reinstalou — e esse descompasso realimenta o ciclo de
reinstalação. Medição de fechamento do #6875 (`helios`, 01/09/2026):
reinstalações a cada ~30min, ~214MB por ciclo sem ninguém consumir o
resultado, com duas sessões de 31h e 36h vivas; zero problemas em 1h22
depois de reiniciá-las.

**O dano operacional (3 crons quebrando em silêncio) já está fechado pelo
#6891** (Partes A/B — `DISABLE_AUTOUPDATER=1` escopado aos crons + auto-reparo
no preflight `claude-binary-preflight.sh`). Isto é a Parte C: só o alarme.

## Como detecta

`readlink /proc/<pid>/exe` de um processo `claude ... --remote-control` vivo
há mais de N horas (default 24h — a medição real usava 31h/36h). Quando o
kernel mantém o link apontando pra um caminho de staging temporário do npm
terminando em `(deleted)`, é porque o processo ainda tem aberto um binário
que o disco já removeu numa reinstalação — evidência direta de que aquele
PID está rodando uma versão anterior à atual. Mais confiável que comparar
`claude --version`, que sempre spawna um processo NOVO e lê o disco, nunca
revela o que a sessão de vida longa tem carregado.

Estados possíveis por sessão: `too-young` (mais nova que o threshold, nem
checada), `ok` (velha, mas o binário ainda está no disco), `drift` (achado
confirmado), `unresolved` (velha, mas `/proc/<pid>/exe` não pôde ser lido —
tratado como pendente, nunca como "ok" por omissão).

## O que ele NÃO cobre

- Não roda em nenhuma plataforma além de Linux (`process.platform !==
  "linux"` → sai 0 sem checar nada) — o achado é específico do `helios`,
  único servidor com sessões de vida longa hoje.
- Não abre issue automaticamente (diferente de `node-modules-loop-alarm.ts`)
  — o achado reaparece toda vez que uma sessão fica velha o bastante, então
  uma issue reaberta a cada ciclo seria ruído, não sinal. Só e-mail.
- Não distingue QUAL versão o processo carregou vs. qual está em disco —
  só que divergem. Extrair o número de versão do path de staging não é
  confiável o bastante pra virar parte da lógica; o sinal `(deleted)` já
  basta pra decidir que vale a pena olhar.

## Idempotência

`data/claude-session-version-drift-alarm/state.json` — fingerprint do
CONJUNTO de pids pendentes. O mesmo conjunto não re-alarma a cada execução;
um pid novo entrando em drift, ou o conjunto esvaziando e voltando a
preencher depois, dispara e-mail de novo.

## Log

`data/claude-session-version-drift-alarm/.alarm.log` (append-only).

## Uso manual

```bash
npx tsx scripts/claude-session-version-drift-alarm.ts               # avalia + persiste + alarma se achado NOVO
npx tsx scripts/claude-session-version-drift-alarm.ts --dry-run     # avalia + imprime, não persiste nem alarma
npx tsx scripts/claude-session-version-drift-alarm.ts --to email@x  # override do destinatário
npx tsx scripts/claude-session-version-drift-alarm.ts --threshold-hours 12
```

## Setup (ação local one-time do editor)

`local` — precisa do junction `data/` (OneDrive) + `data/.credentials.json`
com o scope `gmail.send`. Roda só em Linux (`helios`).

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Claude-Session-Version-Drift-Alarm
systemctl --user daemon-reload
systemctl --user enable --now diaria-claude-session-version-drift-alarm.timer
```

Cadência: `interval, hours: 6` (`scripts/lib/scheduled-tasks.ts`) — folga
suficiente acima do threshold de 24h sem deixar o achado dias sem e-mail.
