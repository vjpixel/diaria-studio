# Alarme de staleness do monitor de citação GEO

Issue: [#4755](https://github.com/vjpixel/diaria-studio/issues/4755) (achado do fleet review da [#4754](https://github.com/vjpixel/diaria-studio/pull/4754), spun off do [#4558](https://github.com/vjpixel/diaria-studio/issues/4558) Parte C).

O monitor semanal de citação GEO (`geo-citation-monitor.ts`, task `Diaria-Geo-Citation-Monitor`, domingos 07:00) registra em `data/geo-citations/history.jsonl` se `diar.ia.br` foi citada pelos assistentes de IA configurados. Mas nada avisava quando essa task **para de produzir medição** — task desabilitada manualmente, task removida, máquina do editor fora do ar por semanas, ou todo provider (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY`) sem key configurada. Todos esses motivos colapsam no MESMO sintoma observável: `history.jsonl` para de crescer.

## Por que não basta checar se a task está registrada

Um guard que só confirma "a task existe no agendador" cobre só o registro INICIAL — não checa se ela está habilitada nem se a última execução teve sucesso: uma task registrada e depois desabilitada (ou um timer systemd parado) passa nesse tipo de checagem em silêncio, para sempre. Este alarme olha o SINTOMA (o histórico parado), não o registro da task — por isso pega os 4 motivos citados acima com o mesmo mecanismo, sem precisar distinguir qual deles está acontecendo. (`scripts/lib/pending-scheduled-tasks.ts`, que fazia esse tipo de checagem por registro contra os antigos `.ps1` do Windows, foi removido no #5115 — cutover final, nenhuma tarefa `Diaria-*` roda mais no Windows.)

## Como funciona (2 peças)

1. **Staleness pura (`scripts/lib/geo-citation-staleness-alarm.ts`)** — lógica pura: dado o `ts` do registro mais recente conhecido (ou `null`, quando não há nenhum registro legível), calcula quantos dias faz desde a última medição e se isso excede `STALENESS_THRESHOLD_DAYS` (21 dias — 2 execuções semanais perdidas + folga; a task é semanal). Idempotência por FINGERPRINT do último `ts` conhecido (mesmo molde de `apoios-diff-alarm.ts`): enquanto o histórico ficar parado no mesmo registro, o fingerprint não muda e o mesmo alarme não é reenviado a cada checagem semanal; quando um registro novo chega (task voltou a rodar), o fingerprint muda e — se isso tirar o histórico da zona de staleness — o estado RE-ARMA, pronto para alarmar de novo na próxima vez que o histórico parar de crescer.
2. **Alarme (`scripts/geo-citation-staleness-alarm.ts`)** — task semanal separada que lê o `ts` mais recente direto de `data/geo-citations/history.jsonl` (parser string-safe, linha a linha, andando de trás pra frente — uma linha corrompida no fim não invalida as anteriores), avalia a staleness, e manda e-mail (Gmail) ao editor quando necessário. **Nunca chama nenhum provider GEO** — só lê o arquivo já escrito pelo monitor.

## Como o editor confere o alarme

- **Passivo**: chega por e-mail (Gmail, conta de `platform.config.json` → `inbox.editor_personal_email`) só quando o histórico fica stale.
- **Ativo** (debug/auditoria), sem enviar e-mail nem avançar o estado:
  ```powershell
  npx tsx scripts/geo-citation-staleness-alarm.ts --dry-run
  ```
- **Log da task agendada**: `data/geo-citations/.staleness-alarm.log` (append-only, uma seção por execução).
- **Histórico bruto**: `data/geo-citations/history.jsonl`.

## O que fazer quando o alarme dispara

1. Confira `systemctl --user status diaria-geo-citation-monitor.timer` — a task está ativa? Quando foi o último disparo (`systemctl --user list-timers diaria-geo-citation-monitor.timer`)?
2. Confira `data/geo-citations/.monitor.log` (log da própria task do monitor) pelas últimas execuções.
3. Confirme que ao menos um provider está configurado: `npx tsx scripts/geo-citation-monitor.ts --dry-run` reporta quais tem API key, sem gastar nenhuma chamada de rede.
4. Se a task foi desabilitada manualmente, reabilite com `systemctl --user enable --now diaria-geo-citation-monitor.timer`. Se foi removida, re-registre com `npx tsx scripts/setup-systemd-timers.ts --task Diaria-Geo-Citation-Monitor`.
5. Depois do fix, a próxima run do monitor que escrever um registro novo tira o histórico da zona de staleness automaticamente — nenhuma limpeza manual de estado necessária.

## Setup (ação local one-time do editor — NÃO feito nesta unidade)

Requer Linux/systemd + junction `data/` (OneDrive) + `data/.credentials.json` com o scope `gmail.send` (mesmo requisito dos outros alarmes locais deste repo). **Não** requer nenhuma das API keys de provider GEO. Independente da task `Diaria-Geo-Citation-Monitor` já estar armada ou não — sem ela, este alarme só vai ler `history.jsonl` ausente e alarmar "nunca registrou nenhuma medição", que é exatamente o sinal correto nesse caso. O antigo `.ps1` do Windows foi removido no #5115 (cutover final).

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Geo-Citation-Staleness-Alarm
systemctl --user daemon-reload
systemctl --user enable --now diaria-geo-citation-staleness-alarm.timer
```

Isso registra a task `Diaria-Geo-Citation-Staleness-Alarm` (semanal, domingos 10:30 — mudou de segundas 14:00, decisão do editor 260810; 3h30 depois do monitor das 07:00). Idempotente — re-executar regenera os units. Remover: `systemctl --user disable --now diaria-geo-citation-staleness-alarm.timer`.

**Registro da task + 1ª execução ao vivo não feitos nesta unidade** (worktree isolado, sem Task Scheduler real nem `data/.credentials.json`/Gmail ao vivo, mesma disciplina do #4320/#4382/#4490/#4534/#4723). Validado só via testes da lógica pura + do reader string-safe (`test/geo-citation-staleness-alarm.test.ts`).
