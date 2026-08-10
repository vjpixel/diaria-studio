# Alarme de guardrail furado do ramp Clarice

Issue: [#4064](https://github.com/vjpixel/diaria-studio/issues/4064) (agendamento [#4131](https://github.com/vjpixel/diaria-studio/issues/4131) finding 1).

Avalia, ~10h após cada envio, se algum guardrail de saúde do ramp de migração
Clarice (abertura/bounce/unsub/spam) foi rompido — e, se sim, avisa o editor
a tempo de agir, já que uma campanha Brevo agendada é **imutável via API**
(só cancelável manualmente no painel).

## O que ele faz

`scripts/run-clarice-guardrail-alarm.ps1` → `scripts/clarice-guardrail-alarm.ts`,
rodando a cada 4h via Task Scheduler. Quando um guardrail está rompido, envia
e-mail ao editor via Gmail API nomeando o próximo envio agendado e o prazo
pra suspendê-lo manualmente.

## Idempotência

`data/clarice-guardrail-alarm-state.json` — uma campanha nunca é
reavaliada/realarmada 2×.

## Log

`data/clarice-subscribers/.guardrail-alarm.log` (append-only).

## Setup (ação local one-time do editor)

`local` — precisa do junction `data/` (OneDrive) + `BREVO_CLARICE_API_KEY` +
`data/.credentials.json` com o scope `gmail.send`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-clarice-guardrail-alarm-schedule.ps1
```

Isso registra a task `Diaria-Clarice-Guardrail-Alarm` (a cada 4h). Idempotente
— re-executar atualiza a task. Remover: mesmo comando com `-Unregister`.
