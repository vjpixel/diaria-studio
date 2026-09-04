# Alarme de defasagem de versão do Claude Code (disco × npm upstream)

Issue: [#6960](https://github.com/vjpixel/diaria-studio/issues/6960) — item 2 do comentário do editor na [#6927](https://github.com/vjpixel/diaria-studio/issues/6927) (decisão do editor em 03/09 via `/diaria-desbloqueia`: **N = 7 dias**).

## O que ele faz — e o que ele NÃO faz

**Isto é um alarme SEM POLÍTICA (mesma decisão do #6927 pro alarme irmão).** Ele
não atualiza o binário, não reinicia sessão nenhuma, e não escolhe entre as opções
de fundo que o #6927 deixou em aberto. O único objetivo é **nomear o estado exato**
que sobrou quando o auto-updater foi desligado: "desligamos o updater" virando
"esquecido em 2.1.257 por três meses" — pra alguém decidir com informação, não às
cegas.

### O problema que ele nomeia

O editor desligou o auto-updater do Claude Code no `helios` (#6927, 01/09) porque
o updater comparava a versão contra a que o **processo em execução** carregou, não
contra a do disco, e isso realimentava o ciclo de reinstalação (5 quebras do
binário no mesmo dia, ~214MB por ciclo). Com o updater desligado, o silêncio do
alarme do #6927 (`Diaria-Claude-Session-Version-Drift-Alarm`) passa a ser
indistinguível de saúde — aquele detecta reinstalação RECENTE
(`/proc/<pid>/exe` terminando em `(deleted)`), e com o updater desligado a
reinstalação para de acontecer, então o marcador nunca aparece.

Este alarme mede outra coisa: **há quantos dias a versão em disco diverge da
versão publicada no npm.** É o contrapeso que o item 1 do comentário de arme da
#6927 aponta como faltante.

### Como detecta

- **Disco:** `npm root -g` → `<global>/@anthropic-ai/claude-code/package.json` → campo `version`.
- **Upstream:** `npm view @anthropic-ai/claude-code version`.
- **Defasagem:** `driftSince` (ISO) persistido em `data/npm-version-drift-alarm/state.json` — mantém a data do 1º dia em que a divergência apareceu, **não reinicia a cada execução**; reseta pra `null` assim que disco == upstream de volta (atualização manual).
- **Alarme:** quando `ageDays >= thresholdDays` (default 7) E o fingerprint `disco->upstream` difere do último já alarmado.

O limiar de 7 dias é o ponto em que "desligamos o updater" deixou de ser uma
decisão recente e passou a ser, na prática, "ninguém atualizou esta semana". O
Claude Code publica com frequência alta (2.1.251 → 2.1.257 em um dia, medição na
#6960), então 1-2 dias de defasagem é ruído de cadência normal de release, não
sinal.

### Estados possíveis

| status | quando | ação |
|---|---|---|
| `in-sync` | disco == upstream | nada |
| `drift-fresh` | disco != upstream, há < 7d | nada — cadência normal de release |
| `drift-stale` | disco != upstream, há ≥ 7d | **alarme** (e-mail, se fingerprint for novo) |

## Restrição de desenho central: nunca falhar em silêncio

`npm root -g`, a leitura do `package.json` em disco, e `npm view` **PROPAGAM**
qualquer erro (rede indisponível, `npm` não encontrado, path mudou de lugar,
`package.json` ilegível/corrompido/sem campo `version`) — `main()` sai com
`exitCode = 1` sem tocar `saveState`, nunca lê um erro como "sem defasagem" por
omissão. Silenciar um erro de leitura é exatamente a garantia falsa que a issue
pede pra evitar: um `npm view` que falhou não pode virar "0 defasagem".

## Idempotência

`data/npm-version-drift-alarm/state.json` — fingerprint do par `disco->upstream`.
O mesmo par não repete e-mail a cada execução; o upstream avançando de novo
(par muda) dispara outro alarme. `driftSince` é mantido entre execuções, então a
contagem de dias não reinicia a cada checagem.

## Sem issue automática

Diferente de alguns alarmes do repo que abrem issue via `alarm-issues.ts`
(`family: "estado"`), este **não abre issue** — decisão explícita, mesma do
alarme irmão do #6927: o achado é recorrente por natureza (reaparece toda semana
que ninguém atualizar), uma issue reaberta a cada ciclo seria ruído, não sinal.
Só e-mail via Gmail.

## Log

`data/npm-version-drift-alarm/.alarm.log` (append-only).

## Uso manual

```bash
npx tsx scripts/npm-version-drift-alarm.ts                    # avaliar + persistir + alarmar se achado NOVO
npx tsx scripts/npm-version-drift-alarm.ts --dry-run          # avaliar + imprimir, NÃO persistir nem alarmar
npx tsx scripts/npm-version-drift-alarm.ts --to email@x       # override do destinatário
npx tsx scripts/npm-version-drift-alarm.ts --threshold-days 7 # default 7
```

## Setup (ação local one-time do editor)

`local` — precisa do junction `data/` (OneDrive) + `data/.credentials.json` com
o scope `gmail.send` (só quando há achado pra de fato enviar o e-mail). Roda em
qualquer plataforma que tenha `npm` — não é específico do `helios`.

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Npm-Version-Drift-Alarm
systemctl --user daemon-reload
systemctl --user enable --now diaria-npm-version-drift-alarm.timer
```

Cadência: `daily, 10:40 BRT` (`scripts/lib/scheduled-tasks.ts`) — 1 checagem/dia
já dá granularidade suficiente pro limiar de 7d sem custo de rodar mais vezes.
**DECLARADA, NÃO ARMADA nesta unidade** (worktree isolado, mesma disciplina das
outras entradas do registro) — armar via `scripts/setup-systemd-timers.ts` na
checkout compartilhada (`helios`) é ação POSTERIOR do editor.