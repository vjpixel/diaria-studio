/**
 * scripts/lib/clarice-envio-alarm.ts (#5058, item 2)
 *
 * Lógica PURA do alarme de rodada falha da task `Diaria-Clarice-Envio`
 * (19:00 BRT, `scripts/clarice-envio-run.ts`). Achado ao vivo 260811: a task
 * morreu com um `throw` (rate limit transitório do dashboard) e o único
 * sinal foi um unit systemd vermelho que ninguém olha — a onda de 12/08 só
 * existiu porque um humano montou à mão.
 *
 * Estratégia: "existe onda agendada pra amanhã?" (opção B da issue #5058,
 * preferida sobre `OnFailure=` de unit porque cobre MAIS — inclusive o caso
 * "rodou, saiu exit 0, mas não agendou nada"). Em vez de reconsultar a Brevo
 * ao vivo (2ª fonte de verdade, 2ª chance de rate limit), lê o RELATÓRIO que
 * `runEnvio` já escreve em TODA rodada, sem exceção (`writeAndRegisterReport`,
 * `data/clarice-subscribers/envio-reports/envio-{aammdd}*.md`) — cada
 * caminho de saída (sucesso, pausa legítima, abort) grava exatamente 1
 * relatório, então o `reportId` sozinho já classifica o desfecho.
 *
 * Classificação por SUFIXO do reportId (ver `runEnvio` em
 * `scripts/clarice-envio-run.ts` pra cada `writeAndRegisterReport` — esta
 * lista precisa acompanhar se um novo desfecho de pausa for adicionado lá):
 *   - `envio-{aammdd}` (sem sufixo) — sucesso (code 0) OU agendamento
 *     INCERTO reconciliável (code 2). Onda foi criada — OK.
 *   - `-paused` / `-sem-ciclo-elegivel` / `-abc-iniciar` / `-onda-ja-existe` /
 *     `-fila-insuficiente` / `-fila-insuficiente-pendente` (#10096) /
 *     `-freio-stop` / `-sem-volume` — pausas
 *     LEGÍTIMAS e documentadas (kill switch, ciclo não pronto, precisa do
 *     editor, onda já existe, sem público/volume suficiente). Nenhuma
 *     dessas é falha — OK, sem alarme.
 *   - `-fila-insuficiente-vencida` (#10118) — a parada durável do #10096
 *     passou de `CLARICE_ENVIO_HALT_MAX_AGE_DAYS`, o ciclo virou desde
 *     ela, ou `data/clarice-envio-halt.json` está ilegível (#10121), e
 *     ninguém decidiu. Fica FORA de `OK_SUFFIXES` de propósito —
 *     ALARME (e-mail próprio, não o de "falha").
 *   - qualquer OUTRO sufixo (`-abort`, `-lock-held`, ou um sufixo futuro
 *     ainda não listado aqui) — ALARME. Fail-TOWARD-alarming de propósito:
 *     um sufixo desconhecido preferimos alarmar à toa (o editor vê "ah, é
 *     só uma pausa nova, esquecemos de listar") a deixar uma falha nova
 *     passar despercebida por causa de uma lista desatualizada.
 *   - NENHUM relatório encontrado pra `aammdd` — a task nem rodou (crash
 *     antes do `try`, systemd nunca disparou, máquina desligada) — ALARME.
 */

import { HALT_STALE_REPORT_SUFFIX } from "./clarice-envio-halt.ts";

export type EnvioAlarmVerdict = "ok" | "alarm-no-report" | "alarm-failure";

export interface EnvioAlarmReportFile {
  reportId: string;
  mtimeMs: number;
}

/** Sufixos de `reportId` (após `envio-{aammdd}`) que representam desfecho ESPERADO — nunca alarme. Ver docstring do módulo pra origem de cada um. */
const OK_SUFFIXES = new Set([
  "", // sucesso (code 0) ou incerto-reconciliável (code 2) — onda foi criada
  "-paused",
  "-sem-ciclo-elegivel",
  "-abc-iniciar",
  "-onda-ja-existe",
  "-fila-insuficiente",
  // #10096 — rodada que encontrou a parada durável por fila insuficiente
  // ainda gravada (`data/clarice-envio-halt.json`): pausa legítima, espera
  // decisão do editor. O relatório diz isso todo dia; não é falha — DENTRO
  // do limite de idade/ciclo. Vencida, a rodada usa HALT_STALE_REPORT_SUFFIX
  // (#10118), que NÃO está aqui: vira alarme.
  "-fila-insuficiente-pendente",
  "-freio-stop",
  "-sem-volume",
]);

/** Entre candidatos do MESMO `aammdd`, o mais recente por mtime — se a rodada rodou 2x no dia (retry manual + task agendada), o desfecho que importa é o ÚLTIMO. */
export function pickLatestEnvioReport(
  candidates: ReadonlyArray<EnvioAlarmReportFile>,
): EnvioAlarmReportFile | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
}

/** `reportId` que não começa com `envio-{aammdd}` é forma inesperada — trata como alarme (mesmo racional fail-toward-alarming do módulo). */
export function classifyEnvioReportId(reportId: string, aammdd: string): "ok" | "alarm" {
  const prefix = `envio-${aammdd}`;
  if (!reportId.startsWith(prefix)) return "alarm";
  const suffix = reportId.slice(prefix.length);
  return OK_SUFFIXES.has(suffix) ? "ok" : "alarm";
}

export interface EnvioAlarmEvaluation {
  verdict: EnvioAlarmVerdict;
  /** `null` só quando `verdict === "alarm-no-report"`. */
  reportId: string | null;
}

export function evaluateEnvioAlarm(
  candidates: ReadonlyArray<EnvioAlarmReportFile>,
  aammdd: string,
): EnvioAlarmEvaluation {
  const latest = pickLatestEnvioReport(candidates);
  if (!latest) return { verdict: "alarm-no-report", reportId: null };
  const classification = classifyEnvioReportId(latest.reportId, aammdd);
  return { verdict: classification === "ok" ? "ok" : "alarm-failure", reportId: latest.reportId };
}

// ---------------------------------------------------------------------------
// Idempotência — 1 alarme por `aammdd`, nunca reenviado no mesmo dia mesmo
// que a task de alarme rode mais de 1x (ex: retry manual de debug).
// ---------------------------------------------------------------------------

export interface EnvioAlarmState {
  lastAlarmedAammdd: string | null;
}

export function emptyEnvioAlarmState(): EnvioAlarmState {
  return { lastAlarmedAammdd: null };
}

export function shouldSendEnvioAlarm(evaluation: EnvioAlarmEvaluation, state: EnvioAlarmState, aammdd: string): boolean {
  if (evaluation.verdict === "ok") return false;
  return state.lastAlarmedAammdd !== aammdd;
}

export function markEnvioAlarmed(_state: EnvioAlarmState, aammdd: string): EnvioAlarmState {
  return { lastAlarmedAammdd: aammdd };
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

/** `issueRef` (#5339, opcional) — outcome de `applyAlarmReconciliation`
 * (`scripts/lib/alarm-issues.ts`) pro achado desta rodada. `undefined`
 * (dry-run, ou wiring ainda não chamado) omite a citação sem quebrar nada —
 * mesmo fallback de `buildHubDriftAlarmEmail`/`buildApoiosDiffAlarmEmail`. */
export function buildEnvioAlarmEmail(
  evaluation: EnvioAlarmEvaluation,
  aammdd: string,
  issueRef?: { issueNumber: number | null; url: string | null; action: string; error?: string },
): { subject: string; body: string } {
  const issueLine = issueRef
    ? "\n\n" +
      (issueRef.action === "failed"
        ? `Issue: falha ao criar/reusar (${issueRef.error})`
        : `Issue: #${issueRef.issueNumber} (${issueRef.url})`)
    : "";
  if (evaluation.verdict === "alarm-no-report") {
    return {
      subject: `⚠️ Diaria-Clarice-Envio: nenhum relatório encontrado pra ${aammdd}`,
      body:
        `A task Diaria-Clarice-Envio (19:00 BRT) deveria ter escrito um relatório em ` +
        `data/clarice-subscribers/envio-reports/envio-${aammdd}*.md, e não escreveu nenhum. ` +
        `Isso significa que a rodada nem chegou a rodar (systemd não disparou, máquina ` +
        `desligada/hibernando na janela, ou um crash ANTES do bloco try — mais grave que ` +
        `qualquer falha capturada normalmente). Verifique:\n\n` +
        `  systemctl --user status diaria-clarice-envio.service\n` +
        `  journalctl --user -u diaria-clarice-envio.service -n 100\n\n` +
        `Sem onda agendada pra amanhã 06:00 BRT, monte manualmente via /diaria-clarice-envio ` +
        `(skill manual) — não espere a task rodar de novo sozinha.` +
        issueLine,
    };
  }
  if (evaluation.reportId?.endsWith(HALT_STALE_REPORT_SUFFIX)) {
    return {
      subject: `⚠️ Diaria-Clarice-Envio: rampa parada há tempo demais (${evaluation.reportId})`,
      body:
        `A rampa Clarice está parada por fila insuficiente (regra 260811, parada durável #10096) ` +
        `e a parada venceu — passou do limite de dias ou o ciclo virou desde ela (#10118), ou o arquivo de parada está ilegível (#10121). ` +
        `Nenhuma onda é agendada até decisão explícita do editor. Detalhes no relatório: ` +
        `data/clarice-subscribers/envio-reports/${evaluation.reportId}.md (também em /relatorios).\n\n` +
        `Pra retomar a automação: npx tsx scripts/lib/clarice-envio-halt.ts --clear --reason "..."\n` +
        `Pra um envio pontual com volume confirmado: /diaria-clarice-envio com --volume N.` +
        issueLine,
    };
  }
  return {
    subject: `⚠️ Diaria-Clarice-Envio falhou em ${aammdd} (${evaluation.reportId})`,
    body:
      `A rodada de ${aammdd} da task Diaria-Clarice-Envio (19:00 BRT) terminou em falha — ` +
      `relatório: data/clarice-subscribers/envio-reports/${evaluation.reportId}.md ` +
      `(também na superfície de Relatórios do Studio, /relatorios).\n\n` +
      `Isso quer dizer que NENHUMA onda foi agendada pra amanhã 06:00 BRT (o retry com ` +
      `backoff embutido em clarice-envio-run.ts, #5058, já esgotou até 3 tentativas antes ` +
      `de desistir — se isto chegou até aqui, não foi um blip de rate limit passageiro). ` +
      `Leia o relatório pra causa exata; se for algo que só o editor resolve (crédito Brevo, ` +
      `store desatualizado, teste A/B/C precisa de assunto novo), monte manualmente via ` +
      `/diaria-clarice-envio — não espere a task de amanhã sozinha.` +
      issueLine,
  };
}
