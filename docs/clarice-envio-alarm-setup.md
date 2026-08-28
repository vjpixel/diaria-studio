# Alarme de rodada falha do Diaria-Clarice-Envio

Issue: [#5058](https://github.com/vjpixel/diaria-studio/issues/5058).

`scripts/clarice-envio-alarm.ts` + `scripts/lib/clarice-envio-alarm.ts` fecham o buraco de observabilidade encontrado ao vivo em 260811: a task `Diaria-Clarice-Envio` (19:00 BRT, planeja e agenda a onda Clarice do dia seguinte) falhou em rate limit transitório da Brevo e o único sinal foi um unit systemd vermelho que ninguém olha — a onda de 12/08 só existiu porque o editor montou à mão.

## O que ele checa

`scripts/clarice-envio-run.ts` (`Diaria-Clarice-Envio`) escreve **exatamente 1 relatório** em `data/clarice-subscribers/envio-reports/envio-{aammdd}*.md` em TODO caminho de saída — sucesso, pausa legítima (kill switch, ciclo não pronto, teste A/B/C precisa do editor, onda já existe pra amanhã, fila insuficiente, sem volume) ou falha (`EnvioAbort`, lock detido). Esta task lê o relatório **mais recente de HOJE** (mtime, em caso de retry manual no mesmo dia) e classifica pelo sufixo do `reportId`:

- sem sufixo (`envio-{aammdd}`) — sucesso ou agendamento incerto-reconciliável (code 0/2). Onda foi criada. **OK, sem alarme.**
- `-paused`, `-sem-ciclo-elegivel`, `-abc-iniciar`, `-onda-ja-existe`, `-fila-insuficiente`, `-freio-stop`, `-sem-volume` — pausas **esperadas e documentadas**. **OK, sem alarme.**
- qualquer outro sufixo (`-abort`, `-lock-held`, ou um motivo de pausa futuro ainda não listado) — **ALARME**. Fail-toward-alarming de propósito: um sufixo desconhecido prefere alarmar à toa a deixar uma falha nova passar despercebida.
- **nenhum relatório encontrado** pra hoje — a task nem chegou a rodar (systemd não disparou, máquina desligada/hibernando, crash antes do `try`). **ALARME** — este é o caso que uma alarme baseado só em `OnFailure=` de unit NÃO cobriria sozinho tão bem quanto uma checagem explícita "existe relatório de hoje?".

## Por que checar o relatório local em vez de reconsultar a Brevo

Reconsultar `GET /api/campaigns` ao vivo seria uma 2ª fonte de verdade — e uma 2ª chance de bater no mesmo rate limit que motivou a issue. O relatório que `runEnvio` já escreve é local, determinístico, e cobre os dois modos de falha que a issue pede: "morreu com erro" (`-abort`) e "rodou, saiu exit 0, mas não agendou nada" (qualquer pausa fora da lista OK, ou um bug futuro que produza um `reportId` inesperado).

## Horário: 20:30 BRT

1h30 depois da task das 19:00 — folga suficiente pro retry-com-backoff embutido em `clarice-envio-run.ts` (#5058, até 3 tentativas, cap de 35min cada, ~1h10 no pior caso) esgotar **antes** desta checagem rodar. Rodar cedo demais alarmaria em cima de um retry ainda em curso que teria sucesso minutos depois.

## Idempotência

`data/clarice-subscribers/envio-alarm-state.json` guarda só `lastAlarmedAammdd` — 1 alarme por dia, mesmo que esta task rode mais de 1x (ex: retry manual de debug). Um dia novo com falha nova sempre alarma de novo, independente do dia anterior.

## Como o editor confere o alarme

- **Passivo**: chega por e-mail (Gmail, conta de `platform.config.json` → `inbox.editor_personal_email`) só quando há falha.
- **Ativo** (debug/auditoria), sem enviar e-mail nem avançar o estado:
  ```powershell
  npx tsx scripts/clarice-envio-alarm.ts --dry-run
  ```
  `--to email@x` sobrepõe o destinatário do alarme (debug).
- **Log da task agendada**: `data/clarice-subscribers/.envio-alarm.log`.

## O que fazer quando o alarme dispara

1. Abra o relatório citado no e-mail (`data/clarice-subscribers/envio-reports/{reportId}.md`, também na superfície de Relatórios do Studio, `/relatorios`) — a causa exata está lá.
2. Se for algo que só o editor resolve (crédito Brevo, store desatualizado, teste A/B/C precisa de assunto novo), monte a onda manualmente via `/diaria-clarice-envio` (skill manual) — não espere a task de amanhã sozinha, ela só monta a onda de 1 dia à frente.
3. Se o e-mail disser que **nenhum relatório foi encontrado** (em vez de citar um `reportId`), a task de 19:00 nem chegou a rodar — verifique `systemctl --user status diaria-clarice-envio.service` / `journalctl --user -u diaria-clarice-envio.service -n 100`.

## Setup (ação local one-time do editor — NÃO feito nesta unidade)

Requer `data/.credentials.json` com o scope `gmail.send` (mesmo requisito dos outros alarmes locais deste repo) — só necessário pra **enviar** o alarme quando há falha; a leitura dos relatórios em si não precisa de credencial nenhuma. Requer o junction `data/` (OneDrive) — o guard de registro (`requiredFile: clarice-subscribers/clarice-users.db`) já cobre isso: sem o junction montado, a task aborta cedo em vez de mandar um "nenhum relatório encontrado" enganoso numa máquina que nunca roda o `Diaria-Clarice-Envio` de qualquer forma.

Linux/systemd (molde da épica #4798, cutover já concluído — desde o #5115 é a única via, nenhuma tarefa `Diaria-*` roda no Windows):

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Envio-Alarm
systemctl --user daemon-reload
systemctl --user enable --now diaria-clarice-envio-alarm.timer
```

Isso registra a task `Diaria-Clarice-Envio-Alarm` (diária, 20:30 BRT). Idempotente — re-rodar o `setup-systemd-timers.ts` regenera os units sem duplicar.

**Por que nunca teve `.ps1` de setup:** mesmo padrão de `Diaria-Home-Meta-Check` (#5005, 1ª task registrada depois do cutover pra systemd, épica #4798) — nasceu sem contraparte Windows/Task Scheduler, por decisão explícita de não criar mais `.ps1` como via de execução real. Os `.ps1` das demais tasks (que tinham nascido antes do cutover) foram removidos no #5115.

**Nenhuma execução ao vivo desta checagem rodou nesta unidade** (worktree isolado, sem `data/.credentials.json` real; e a regra de dispatch overnight #738/#3453 proíbe qualquer chamada de rede real nesta sessão) — validado só via testes com a lógica pura + I/O de arquivo local em diretório temporário (`test/clarice-envio-alarm.test.ts`, `test/clarice-envio-alarm-script.test.ts`) e via `test/scheduled-tasks.test.ts` (estrutura do registro), mesma disciplina do #4320/#4382/#4490/#4534/#4723/#4750/#4910/#5005.
