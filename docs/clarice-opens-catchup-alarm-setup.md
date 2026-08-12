# Alarme de falha sustentada do catch-up de opens da Clarice

Issue: [#4740](https://github.com/vjpixel/diaria-studio/issues/4740) (spun off do item 4 do [#4722](https://github.com/vjpixel/diaria-studio/issues/4722), fleet review retroativo do [#4688](https://github.com/vjpixel/diaria-studio/issues/4688)/[#4717](https://github.com/vjpixel/diaria-studio/issues/4717)).

O catch-up de opens (`#4688`) roda dentro de todo `clarice-sync-brevo.ts --incremental` (inclusive a task diária `Diaria-Clarice-Sync`, 08:30) e é **fail-soft por design**: uma falha nunca reprova o sync principal, que já persistiu com sucesso — o campo `opens_catchup.error` fica só no summary JSON e no log, e ninguém lê isso automaticamente. Como o catch-up é justamente o mecanismo que corrige a subcontagem de `opens_count` (~32% medido antes do #4688), uma falha **recorrente** desse mecanismo reintroduziria o mesmo problema silenciosamente — sem este alarme, indefinidamente.

## Por que não é `clarice-guardrail-alarm.ts`

`clarice-guardrail-alarm.ts` é um alarme de domínio **diferente** — avalia guardrails de engajamento POR CAMPANHA (abertura/bounce/unsub/spam) direto contra a API da Brevo, na sua própria cadência (a cada 4h), sem ler o summary/log do `clarice-sync-brevo.ts`. Acoplar a leitura de `opens_catchup.error` ali misturaria dois propósitos distintos sem necessidade.

## Como funciona (3 peças)

1. **Extração do status (`scripts/extract-opens-catchup-status.ts` + `scripts/lib/extract-opens-catchup-status.ts`)** — o step `extract` da task `Diaria-Clarice-Sync` (`scripts/lib/scheduled-tasks.ts`, via `scripts/lib/task-runner.ts`) chama este script logo depois do passo 1 (`clarice-sync-brevo.ts --incremental`), enquanto o log temporário da run ainda contém só a saída desse passo. Um scanner JSON-aware (string-safe — não conta `{`/`}` dentro de valores string) extrai o ÚLTIMO objeto que contém a chave `opens_catchup` do summary impresso em stdout, e persiste um status enxuto (`{status: "ok"|"error"|"not_run", error?, checked_at}`) em `data/clarice-subscribers/last-opens-catchup-status.json`. Best-effort — nunca reprova a run principal, mesmo se o log estiver ausente ou malformado.
2. **Streak de falhas consecutivas (`scripts/lib/clarice-opens-catchup-alarm.ts`)** — lógica pura: 1 falha isolada é normal (rede/rate-limit transitório da Brevo); `CONSECUTIVE_FAILURE_THRESHOLD` (3) falhas **consecutivas** é sinal real. `not_run` (modo full, `--no-catch-opens`, ou nenhum summary encontrado no log) é **neutro** — não soma nem zera o streak. Um `ok` zera o streak E re-arma o alarme (a próxima falha sustentada volta a alarmar).
3. **Alarme (`scripts/clarice-opens-catchup-alarm.ts`)** — task diária separada que lê o status mais recente, avança o streak, e manda e-mail (Gmail) ao editor quando o streak atinge o threshold. Idempotente por estado em `data/clarice-subscribers/opens-catchup-alarm-state.json` (`lastAlarmedAt` evita reenviar o mesmo alarme a cada checagem enquanto o streak fica acima do threshold sem resolver).

## Como o editor confere o alarme

- **Passivo**: chega por e-mail (Gmail, conta de `platform.config.json` → `inbox.editor_personal_email`) só quando o streak atinge 3 falhas consecutivas.
- **Ativo** (debug/auditoria), sem enviar e-mail nem avançar o estado:
  ```powershell
  npx tsx scripts/clarice-opens-catchup-alarm.ts --dry-run
  ```
- **Log da task agendada**: `data/clarice-subscribers/.opens-catchup-alarm.log` (append-only, uma seção por execução).
- **Status bruto da última run do sync**: `data/clarice-subscribers/last-opens-catchup-status.json`.

## O que fazer quando o alarme dispara

1. Confira `data/clarice-subscribers/.brevo-sync-daily.log` (últimas execuções) pra ver a mensagem de erro exata do catch-up.
2. Confirme `BREVO_CLARICE_API_KEY` e conectividade com a Brevo (`GET /emailCampaigns/{id}/exportRecipients` é o endpoint que o catch-up usa).
3. O sync principal (store SQLite) continua funcionando normalmente enquanto isso é investigado — este alarme não exige nenhuma ação de emergência, só atenção antes que `opens_count` volte a degradar por tempo suficiente pra afetar decisões de segmentação.
4. Depois do fix, a próxima run com `opens_catchup.ok === true` zera o streak automaticamente — nenhuma limpeza manual de estado necessária.

## Setup (ação local one-time do editor — NÃO feito nesta unidade)

Requer Linux/systemd + junction `data/` (OneDrive) + `data/.credentials.json` com o scope `gmail.send` (mesmo requisito dos outros alarmes locais deste repo; o antigo wrapper `.ps1` do Windows foi removido no #5115, cutover final). Depende da task `Diaria-Clarice-Sync` já estar armada — sem ela, `last-opens-catchup-status.json` nunca é escrito e este alarme sempre lê `not_run` (neutro: nunca alarma, mas também nunca detecta falha real).

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Opens-Catchup-Alarm
systemctl --user daemon-reload
systemctl --user enable --now diaria-clarice-opens-catchup-alarm.timer
```

Isso registra a task `Diaria-Clarice-Opens-Catchup-Alarm` (diário, 09:00 — depois do sync das 08:30, antes do `Diaria-Cursos-Kv-Sync` das 09:15). Idempotente — re-executar regenera os units. Remover: `systemctl --user disable --now diaria-clarice-opens-catchup-alarm.timer`.

**Registro da task + 1ª execução ao vivo não feitos nesta unidade** (worktree isolado, sem Task Scheduler real nem `data/.credentials.json`/Gmail ao vivo, mesma disciplina do #4320/#4382/#4490/#4534/#4723) — ação pendente do editor. Validado só via testes da lógica pura + extração determinística (`test/extract-opens-catchup-status.test.ts`, `test/clarice-opens-catchup-alarm.test.ts`).
