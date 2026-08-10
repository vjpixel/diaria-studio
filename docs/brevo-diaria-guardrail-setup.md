# Circuit breaker de campanha do canal `brevo_diaria`

Issue: [#4476](https://github.com/vjpixel/diaria-studio/issues/4476) (item 9).

Pausa o rollout inteiro do canal `brevo_diaria` (reativação via segmento
Pending da Beehiiv) quando a saúde agregada da conta se degrada — camada
DIFERENTE do score por-contato (item 1, `brevo-diaria-score.ts`, que decide
sobre 1 pessoa por vez).

## O que ele faz

`scripts/run-check-brevo-diaria-guardrail.ps1` →
`scripts/check-brevo-diaria-guardrail.ts`, rodando a cada 4h via Task
Scheduler. Avalia a saúde AGREGADA (soma de todas as campanhas `sent` da
conta) contra os MESMOS limiares do ramp Clarice — abertura <15%, bounce
duro ≥2%, bounce total ≥5%, spam ≥0,1%, unsub ≥3%
(`scripts/lib/brevo-diaria-guardrail.ts`, reusa `evaluateArmGuardrails`/
`thresholds.ts` sem reimplementar limiar).

**Abertura furada sozinha NUNCA pausa** (decisão explícita da issue: cohort
fria de 7+ meses, "não é fracasso, é informação") — só bounce/spam/unsub
pausam.

## Efeito da pausa

`sync-pending-to-brevo.ts` lê o latch persistido
(`data/brevo-diaria/guardrail-state.json`) e zera o backfill (nenhum contato
novo ingerido) enquanto pausado, mesmo com slots livres na fila top-300
(item 5).

## Latch, não breaker automático

Uma vez pausado, **não despausa sozinho** numa checagem seguinte saudável —
só `npx tsx scripts/check-brevo-diaria-guardrail.ts --unpause` (ação
explícita do editor) limpa.

Alarme por e-mail (Gmail) na 1ª pausa é best-effort — falha no envio nunca
reverte o estado já persistido.

## Log

`data/brevo-diaria/.guardrail-check.log` (append-only).

## Setup (ação local one-time do editor)

`local` — precisa do junction `data/` (OneDrive) + `BREVO_DIARIA_API_KEY`;
alarme por e-mail precisa também de `data/.credentials.json` com o scope
`gmail.send` (best-effort sem ele).

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-check-brevo-diaria-guardrail-schedule.ps1
```

Isso registra a task `Diaria-Brevo-Diaria-Guardrail` (a cada 4h). Idempotente
— re-executar atualiza a task. Remover: mesmo comando com `-Unregister`.

**Registro da task + 1ª execução ao vivo não feitos em nenhuma unidade de
worktree isolado** (sem Task Scheduler real nem `BREVO_DIARIA_API_KEY` ao
vivo, mesma disciplina do #4320/#4382/#4490/#4534) — ação pendente do
editor.
