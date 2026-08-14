# Alarme semanal de saúde de aquisição por canal

Issue: [#5249](https://github.com/vjpixel/diaria-studio/issues/5249) (depende de [#5235](https://github.com/vjpixel/diaria-studio/issues/5235)/[#5236](https://github.com/vjpixel/diaria-studio/issues/5236), já mergeadas).

Não existia nenhuma tarefa vigiando degradação de canal de aquisição. Este alarme roda **semanalmente**, sobre o snapshot já produzido pela task `Diaria-Beehiiv-Backup` (`data/beehiiv-backup/`, #5229) — **nunca chama a API Beehiiv ao vivo**.

## Os 3 sinais

| Sinal | Alarma quando |
|---|---|
| Sobrevivência (ativos ÷ cadastros do canal) | cai abaixo de um piso absoluto, ou cai N pontos percentuais vs a semana anterior do MESMO canal |
| CTR agregado do canal | fica abaixo da BASE (mediana dos canais elegíveis na MESMA semana — nunca um número fixo) por 2 semanas seguidas |
| Volume de cadastros novos por canal | canal conhecido que zera cadastros novos na janela (`canal_parou`), ou canal nunca visto antes (`canal_desconhecido`) |

`canal_desconhecido` é o sinal de maior valor imediato — foi assim que o SparkLoop ([#5255](https://github.com/vjpixel/diaria-studio/issues/5255)) foi descoberto.

## Guardrails de desenho

- **Nunca alarma com `n` insuficiente**: `amostraPequena`/`amostraVazia` (mesmo vocabulário de `scripts/cohort-engagement.ts`) suprimem o sinal de CTR; o streak zera nesse caso em vez de carregar um valor obsoleto adiante.
- **Nunca alarma sobre coorte recém-criada**: `amostraNova` (cadastros abaixo de `cohortMinSize`, default 20) suprime sobrevivência e CTR — mas NUNCA `canal_desconhecido`, que é o oposto (a novidade É o sinal).
- **Compara sempre contra a base do MESMO período**: a base de CTR é recalculada a cada rodada (mediana da própria semana), nunca lida de um valor congelado.

Lógica pura + limiares documentados: `scripts/lib/acquisition-health.ts`. CLI: `scripts/check-acquisition-health.ts`.

## Por que até 3 snapshots

Sobrevivência/CTR comparam só "semana atual" vs "semana anterior" (2 snapshots bastam). `canal_parou` precisa saber se o canal JÁ estava entregando cadastros antes de zerar — exige uma 3ª data pra formar a janela anterior. Com menos de 3 snapshots disponíveis, esse sinal específico fica automaticamente desligado (degradação silenciosa e correta, não um erro) até o histórico crescer.

## Idempotência

`data/acquisition-health/state.json` guarda `knownChannels` (baseline de canais já vistos — 1ª execução nunca alarma `canal_desconhecido`, só estabelece o baseline), o streak de semanas seguidas abaixo da base de CTR por canal, e um fingerprint dos últimos achados (mesmo padrão de `apoios-diff-alarm.ts`/`hub-drift-check.ts` — findings inalterados não reenviam e-mail; achados resolvidos re-armam o cursor).

## Como o editor confere o alarme

- **Passivo**: chega por e-mail (Gmail, conta de `platform.config.json` → `inbox.editor_personal_email`) só quando há achados novos.
- **Ativo** (debug/auditoria), sem enviar e-mail nem avançar o state:
  ```bash
  npx tsx scripts/check-acquisition-health.ts --dry-run
  ```
- **Log da task agendada**: `data/acquisition-health/.check.log`.

## Setup (ação local one-time do editor — NÃO feito nesta unidade)

Requer Linux/systemd + `data/.credentials.json` com o scope `gmail.send` (mesmo requisito dos outros alarmes locais deste repo) pra ENVIAR o alarme — a leitura/detecção em si não precisa de credencial nenhuma, só do junction `data/` (OneDrive) pra ler `data/beehiiv-backup/` e persistir `data/acquisition-health/state.json`.

**NÃO armar via este worktree isolado** — o gerador de unit (`setup-systemd-timers.ts`) resolve `WorkingDirectory=`/`ExecStart=` a partir do path do script no momento em que roda; rodar de dentro de um worktree de PR geraria um unit apontando pro worktree, apagado no cleanup pós-merge. Rodar da checkout compartilhada DEPOIS do merge:

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Acquisition-Health-Alarm
systemctl --user daemon-reload
systemctl --user enable --now diaria-acquisition-health-alarm.timer
```

Isso registra a task `Diaria-Acquisition-Health-Alarm` (semanal, domingo 03:30 BRT — 30min depois de `Diaria-Beehiiv-Backup`, 03:00). Remover: `systemctl --user disable --now diaria-acquisition-health-alarm.timer`.

**Nenhuma execução ao vivo desta checagem rodou nesta unidade** (worktree isolado, sem o junction `data/` nem `data/.credentials.json` reais) — validado só via testes da lógica pura + fixtures de snapshot em disco (`test/acquisition-health.test.ts`, `test/check-acquisition-health-script.test.ts`), mesma disciplina do #4320/#4382/#4490/#4534/#4723/#4740/#4750.
