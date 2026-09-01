# Circuit breaker de campanha do canal `brevo_diaria`

Issue: [#4476](https://github.com/vjpixel/diaria-studio/issues/4476) (item 9).

Pausa o rollout inteiro do canal `brevo_diaria` (reativação via segmento
Pending da Beehiiv) quando a saúde agregada da conta se degrada — camada
DIFERENTE do score por-contato (item 1, `brevo-diaria-score.ts`, que decide
sobre 1 pessoa por vez).

## O que ele faz

Task `Diaria-Brevo-Diaria-Guardrail` (`scripts/lib/scheduled-tasks.ts`) →
`scripts/check-brevo-diaria-guardrail.ts`, rodando a cada 4h via systemd (o
antigo wrapper `.ps1` do Windows foi removido no #5115, cutover final).
Avalia a saúde AGREGADA (soma de todas as campanhas `sent` da
conta) contra os MESMOS limiares do ramp Clarice — abertura <15%, bounce
duro ≥2%, bounce total ≥5%, spam ≥0,1%, unsub ≥3%
(`scripts/lib/brevo-diaria-guardrail.ts`, reusa `evaluateArmGuardrails`/
`thresholds.ts` sem reimplementar limiar).

**#6793 "Faixa B" item 1 (01/09/2026, decisão do editor): o freio automático
foi REMOVIDO.** `shouldPauseRollout` sempre retorna `false` — bounce/spam/
unsub cruzando o limiar não pausa mais nada sozinho. Este script continua
avaliando/logando os breaches normalmente (`nonOpenBreach` no log — nada
ficou cego), só não age mais.

**Histórico (até 01/09/2026): abertura furada sozinha NUNCA pausava**
(decisão explícita da issue #4476: cohort fria de 7+ meses, "não é fracasso,
é informação") — só bounce/spam/unsub pausavam.

## Efeito da pausa (mecanismo preservado, só não é mais disparado automaticamente)

`sync-pending-to-brevo.ts` lê o latch persistido
(`data/brevo-diaria/guardrail-state.json`) e zeraria o backfill (nenhum
contato novo ingerido) enquanto pausado, mesmo com slots livres na fila
(que também não tem mais teto, #6793 item 6) — SE o estado estiver
`rollout_paused: true`, o que só acontece hoje por estado legado ou
manual, nunca mais automaticamente.

## Latch, não breaker automático

A MÁQUINA DE ESTADO continua igual: uma vez pausado (por qualquer motivo),
**não despausa sozinho** numa checagem seguinte saudável — só
`npx tsx scripts/check-brevo-diaria-guardrail.ts --unpause` (ação explícita
do editor) limpa. O que mudou é só que nada entra nesse estado sozinho.

Alarme por e-mail (Gmail) na 1ª pausa é best-effort — falha no envio nunca
reverte o estado já persistido.

## Log

`data/brevo-diaria/.guardrail-check.log` (append-only).

## Setup (ação local one-time do editor)

`local` — precisa do junction `data/` (OneDrive) + `BREVO_DIARIA_API_KEY`;
alarme por e-mail precisa também de `data/.credentials.json` com o scope
`gmail.send` (best-effort sem ele).

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Brevo-Diaria-Guardrail
systemctl --user daemon-reload
systemctl --user enable --now diaria-brevo-diaria-guardrail.timer
```

Isso registra a task `Diaria-Brevo-Diaria-Guardrail` (a cada 4h). Idempotente
— re-executar regenera os units. Remover: `systemctl --user disable --now diaria-brevo-diaria-guardrail.timer`.

**Registro da task + 1ª execução ao vivo não feitos em nenhuma unidade de
worktree isolado** (sem Task Scheduler real nem `BREVO_DIARIA_API_KEY` ao
vivo, mesma disciplina do #4320/#4382/#4490/#4534) — ação pendente do
editor.
