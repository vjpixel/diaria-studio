# Alarme próprio do guard das 05:00 (Diaria-Clarice-Envio-Guard-Alarm)

Issue: [#5220](https://github.com/vjpixel/diaria-studio/issues/5220).

`scripts/clarice-envio-guard-alarm.ts` + `scripts/lib/clarice-envio-guard-alarm.ts` cobrem o Gap 2 achado ao vivo na mesma issue que introduziu o retry/fallback do guard (ver "Retry e fallback do guard" em `docs/clarice-envio-daily-setup.md`): `Diaria-Clarice-Envio-Alarm` (20:30 BRT, #5058) lê `envio-{aammdd}*.md` do **dia inteiro** e escolhe o **mais recente por mtime** — às 20:30 o relatório do run das 19:00 é sempre ~15h mais novo que o do guard daquela MESMA manhã e vence, então um problema do guard das 05:00 (retry esgotado, cancelamento incompleto, erro duro) ficava **invisível**. No sentido inverso, um `-guard-ok` normal (desfecho esperado) viraria alarme falso-positivo se o guard fosse por algum motivo o mais recente, já que os sufixos `-guard-*` nunca estiveram na `OK_SUFFIXES` daquele alarme (que só conhece a família do RUN).

Esta task é **isolada**: lê só a família `envio-{aammdd}-guard-*`, nunca compete com o relatório do run das 19:00 por "mais recente", e nunca é lida por `Diaria-Clarice-Envio-Alarm`.

## O que ela checa

`clarice-envio-guard.ts` (`Diaria-Clarice-Envio-Guard`) escreve **exatamente 1 relatório** em `data/clarice-subscribers/envio-reports/envio-{aammdd}-guard-*.md` em TODO caminho de saída. Esta task lê o relatório **mais recente de HOJE dentro da família `-guard-`** (mtime, em caso de retry manual no mesmo dia) e classifica pelo sufixo do `reportId` (a parte depois de `envio-{aammdd}-guard`):

- `-paused` — kill switch desligado. **OK.**
- `-nada-a-fazer` — sem onda pendente hoje. **OK.**
- `-ok` — freio fresco reavaliado, dentro do aceitável (caminho normal, feliz). **OK.**
- `-cancelou` — freio fresco em STOP, onda cancelada com sucesso — o guard fez exatamente o que devia. **OK** — é o caminho normal funcionando, não uma falha da automação.
- **qualquer outro sufixo** — alarma (verdict `alarm-failure`, salvo o caso abaixo). Cobre deliberadamente:
  - `-cancelamento-incompleto` — cancelamento NÃO confirmado (mesmo achado CRITICAL do silent-failure-hunter que já protege o caminho normal do guard).
  - `-lock-held` / `-abort` — falha dura.
  - **TODOS os `-prereq-*` exceto `-prereq-fallback-override-vigente`** (#5220 — `-prereq-fallback-deixou-passar`, `-prereq-fallback-cancelou`, `-prereq-fallback-cancelamento-incompleto`, `-prereq-falhou-sem-pendencia`) — **mesmo quando o fallback "funcionou"** (deixou a onda passar com o freio anterior OK, ou suspendeu por precaução com sucesso), o guard NÃO conseguiu reavaliar o freio com dado FRESCO, que é a função inteira dele. Isso é sempre digno de atenção do editor, nunca silencioso.
  - um sufixo desconhecido/futuro — fail-toward-alarming de propósito, mesmo racional de `clarice-envio-alarm.ts`.
- **`-prereq-fallback-override-vigente`** — alarma com verdict **`alarm-escalated`**, DISTINTO de `alarm-failure` (#6221). É o único caso em que o guard NÃO tentou fazer nada sozinho de propósito: pré-requisito falhou, o freio da noite era HOLD, e há um override do editor vigente sobre esse HOLD (#6134) — cancelar teria desfeito a decisão do editor, então o guard escala em vez de agir. Ainda assim exige atenção humana (o freio não foi reavaliado com dado fresco) — o e-mail/issue deste caso usa vocabulário próprio ("escalou", nunca "falhou") e diz explicitamente que nenhuma ação automática foi tomada. Achado ao vivo (#6215): o vocabulário anterior ("falhou") levou um coordenador de overnight a ler esta escalada correta como bug e quase recomendar uma ação (liberar IP na Brevo) que teria revertido a decisão do editor.
- **nenhum relatório `-guard-*` encontrado** pra hoje — a task das 05:00 nem chegou a rodar (systemd não disparou, máquina desligada/hibernando na janela, crash antes do `try`). Verdict `alarm-no-report`. **ALARME.**

## Por que checar o relatório local em vez de reconsultar a Brevo

Mesmo racional de `clarice-envio-alarm.ts`: reconsultar a Brevo/dashboard ao vivo seria uma 2ª fonte de verdade e uma 2ª chance de bater no mesmo rate limit que motivou o retry/fallback do guard em primeiro lugar. O relatório que `runEnvioGuard` já escreve é local, determinístico, e cobre exatamente os desfechos que merecem alarme.

## Horário: 06:15 BRT

Depois do guard das 05:00 (o orçamento de retry+fallback do #5220 cabe folgado em ~20min no pior caso) e do horário de disparo da campanha (06:00 BRT) — roda logo depois pra o editor ainda ter uma janela de ação manual se o guard caiu no fallback e a decisão (deixar passar / suspender) merecer revisão.

## Idempotência

`data/clarice-subscribers/envio-guard-alarm-state.json` guarda só `lastAlarmedAammdd` — 1 alarme por dia, mesmo que esta task rode mais de 1x (ex: retry manual de debug). **Estado DEDICADO**, separado de `envio-alarm-state.json` (o alarme do run das 19:00) — um alarme de um não "consome" o slot do outro.

## Como o editor confere o alarme

- **Passivo**: chega por e-mail (Gmail, conta de `platform.config.json` → `inbox.editor_personal_email`) só quando há falha.
- **Ativo** (debug/auditoria), sem enviar e-mail nem avançar o estado:
  ```bash
  npx tsx scripts/clarice-envio-guard-alarm.ts --dry-run
  ```
  `--to email@x` sobrepõe o destinatário do alarme (debug).
- **Log da task agendada**: `data/clarice-subscribers/.envio-guard-alarm.log`.

## O que fazer quando o alarme dispara

1. Abra o relatório citado no e-mail (`data/clarice-subscribers/envio-reports/{reportId}.md`, também na superfície de Relatórios do Studio, `/relatorios`) — a causa exata está lá, inclusive qual decisão o fallback tomou (se aplicável).
2. Se o e-mail citar um `reportId` com sufixo `-prereq-fallback-deixou-passar`, a onda já foi deixada seguir pro disparo das 06:00 com base no ÚLTIMO freio conhecido (não num dado fresco) — se ainda der tempo antes das 06:00, verifique a campanha manualmente no painel Brevo.
3. Se o sufixo for `-prereq-fallback-cancelou` (ou `-guard-cancelou` do caminho normal), a onda já foi suspensa — nada urgente a fazer, mas vale entender a causa raiz do pré-requisito que falhou.
3a. Se o sufixo for `-prereq-fallback-override-vigente`, o guard NÃO agiu de propósito — é o comportamento desejado com um override do editor vigente (#6134). Confirme que o override ainda vale (motivo/prazo estão no relatório); se sim, nada a fazer.
4. Se o e-mail disser que **nenhum relatório foi encontrado**, o guard das 05:00 nem chegou a rodar — verifique `systemctl --user status diaria-clarice-envio-guard.service` / `journalctl --user -u diaria-clarice-envio-guard.service -n 100`, e considere checar a campanha manualmente no painel Brevo antes das 06:00.

## Setup (ação local one-time do editor)

Requer `data/.credentials.json` com o scope `gmail.send` (mesmo requisito dos outros alarmes locais deste repo) — só necessário pra **enviar** o alarme quando há falha; a leitura dos relatórios em si não precisa de credencial nenhuma. Requer o junction `data/` (OneDrive) — o guard de registro (`requiredFile: clarice-subscribers/clarice-users.db`) já cobre isso.

Linux/systemd (via o registro declarativo `scripts/lib/scheduled-tasks.ts`, épica #4798 — única via, nenhuma tarefa `Diaria-*` roda no Windows):

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Clarice-Envio-Guard-Alarm
systemctl --user daemon-reload
systemctl --user enable --now diaria-clarice-envio-guard-alarm.timer
```

Confirmar: `systemctl --user is-active diaria-clarice-envio-guard-alarm.timer` deve devolver `active`.

**Independente do par `Diaria-Clarice-Envio`/`Diaria-Clarice-Envio-Guard`** (que são indivisíveis, decisão do editor 260811) — esta task de alarme pode ser armada/desarmada sozinha sem afetar o funcionamento do par nem o kill switch compartilhado (`data/clarice-envio-enabled.json`).

**Nenhuma execução ao vivo desta checagem rodou nesta unidade** (worktree isolado, sem `data/.credentials.json` real; e a regra de dispatch overnight #738/#3453 proíbe qualquer chamada de rede real nesta sessão) — validado só via testes com a lógica pura + I/O de arquivo local em diretório temporário (`test/clarice-envio-guard-alarm.test.ts`, `test/clarice-envio-guard-alarm-script.test.ts`) e via `test/scheduled-tasks.test.ts` (estrutura do registro), mesma disciplina do #4320/#4382/#4490/#4534/#4723/#4750/#4910/#5005/#5058.
