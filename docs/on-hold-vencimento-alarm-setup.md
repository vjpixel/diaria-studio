# Alarme semanal de vencimento das issues `on-hold`

Issue: [#5317](https://github.com/vjpixel/diaria-studio/issues/5317), 14/08/2026.

Achado ao vivo na mesma sessão: 4 issues (#4556, #4469, #4554, #4549) carregavam
a label `on-hold` com data de vencimento escrita só no título — nada no repo
lia essa data, e o overnight trata `on-hold` como sinal de pular, então a fila
autônoma nunca as devolvia sozinha (mesma classe do #5111, staleness do
LinkedIn semanal).

## Fonte da data

Uma linha `Vencimento: AAAA-MM-DD` no **CORPO** da issue (nunca o título), com
2 sentinelas — ambos sempre alarmam, pra não reintroduzir o mesmo buraco de
silêncio que a task veio consertar:

- `Vencimento: sem data` — external-blocker sem prazo conhecido (caso do #4549).
- linha ausente — issue nunca declarou nada.

## Mecanismo

`scripts/on-hold-vencimento-alarm.ts` lista via `gh issue list --label on-hold
--state open`, avalia com `scripts/lib/on-hold-vencimento-alarm.ts` (lógica
pura, sem estado persistente — o alarme é um **digest semanal que re-envia
enquanto houver achado pendente**, decisão deliberada: suprimir reenvio
reintroduziria "só sai da geladeira se alguém lembrar do primeiro e-mail"), e
envia via Gmail.

**Nunca remove a label `on-hold` sozinho** — decisão explícita do editor
registrada na #5317, só o editor decide se a issue volta pra fila.

As 4 issues achadas foram retroalimentadas com a linha na mesma sessão que
abriu a #5317: #4556 → `2026-09-15` (adiado de ~16/08 por decisão do editor
registrada na própria issue); #4469 → `2026-09-29`; #4554 → `2026-09-30`;
#4549 → `sem data`.

## Setup (ação local one-time do editor)

Diária, domingos 11:00 BRT. Sem `.ps1`/Task Scheduler de propósito (nenhuma
tarefa `Diaria-*` roda no Windows, #5074).

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-On-Hold-Vencimento-Alarm
systemctl --user daemon-reload
systemctl --user enable --now diaria-on-hold-vencimento-alarm.timer
```

**Armado e confirmado ativo em `predator` em 17/08/2026** — rodado da checkout
compartilhada (`/home/vjpixel/diaria-studio`), como a nota anterior pedia.
Próxima corrida domingo 11:00 BRT. Motivo do arme ter saído nessa data: a
#4556 declara `Vencimento: 2026-09-15` e o retorno na data dependia deste
alarme, que até então nunca tinha rodado nesta máquina.

O carimbo (`~/.local/share/systemd/timers/stamp-diaria-on-hold-vencimento-alarm.timer`)
foi tocado ANTES do `enable --now`: `Persistent=true` num timer sem carimbo
trata "nunca rodou" como ocorrência devida e dispara na hora do arme, o que
aqui seria um e-mail real (havia 1 achado pendente). É a saída 3 do aviso que
o próprio `setup-systemd-timers.ts` imprime.
