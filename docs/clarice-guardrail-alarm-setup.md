# Alarme de guardrail furado do ramp Clarice

Issue: [#4064](https://github.com/vjpixel/diaria-studio/issues/4064) (agendamento [#4131](https://github.com/vjpixel/diaria-studio/issues/4131) finding 1).

Avalia, ~10h após cada envio, se algum guardrail de saúde do ramp de migração
Clarice (bounce/unsub/spam — abertura aparece só como contexto no e-mail,
nunca gatilha, #5166) foi rompido — e, se sim, avisa o editor a tempo de agir.
**Correção (#4935, 260810):** uma campanha Brevo agendada
**não é imutável** — dá pra cancelar via API (`PUT /emailCampaigns/{id}/status`,
`status: cancel` ou `suspended`) ou pelo painel, e recriar com as
características desejadas. O alarme continua útil porque a janela até o
disparo é real e cancelar/recriar exige atenção do editor a tempo.

## O que ele faz

Task `Diaria-Clarice-Guardrail-Alarm` (`scripts/lib/scheduled-tasks.ts`) →
`scripts/clarice-guardrail-alarm.ts`, rodando a cada 4h via systemd (o antigo
wrapper `.ps1` do Windows foi removido no #5115, cutover final). Quando um guardrail está rompido, envia
e-mail ao editor via Gmail API nomeando o próximo envio agendado e o prazo
pra cancelá-lo.

## Idempotência

`data/clarice-guardrail-alarm-state.json` — uma campanha nunca é
reavaliada/realarmada 2×.

## Log

`data/clarice-subscribers/.guardrail-alarm.log` (append-only).

## Setup (ação local one-time do editor)

`local` — precisa do junction `data/` (OneDrive) + `BREVO_CLARICE_API_KEY` +
`data/.credentials.json` com o scope `gmail.send`.

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Guardrail-Alarm
systemctl --user daemon-reload
systemctl --user enable --now diaria-clarice-guardrail-alarm.timer
```

Isso registra a task `Diaria-Clarice-Guardrail-Alarm` (a cada 4h). Idempotente
— re-executar regenera os units. Remover: `systemctl --user disable --now diaria-clarice-guardrail-alarm.timer`.
