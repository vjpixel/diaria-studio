/**
 * scripts/lib/clarice-envio-guard-alarm.ts (#5220)
 *
 * Alarme PRÓPRIO do guard das 05:00 (`clarice-envio-guard.ts`) — não estende
 * `Diaria-Clarice-Envio-Alarm` (20:30 BRT, #5058), que só olha
 * `envio-{aammdd}*.md` do dia inteiro e escolhe o MAIS RECENTE por mtime
 * (`pickLatestEnvioReport` em `clarice-envio-alarm.ts`). Os dois processos
 * gravam sob o mesmo prefixo `envio-{aammdd}` no mesmo dia (guard às 05:00,
 * run às 19:00) — às 20:30 o relatório do run é sempre ~15h mais novo e
 * vence, então um abort do guard daquela manhã ficava invisível; e se o
 * guard fosse o mais recente por algum motivo, um `-guard-ok` (desfecho
 * normal) viraria alarme falso-positivo, já que os sufixos `-guard-*` não
 * estão em `OK_SUFFIXES` de `clarice-envio-alarm.ts` (Gap 2 da issue #5220).
 *
 * Este módulo filtra e classifica só os relatórios da FAMÍLIA do guard
 * (`envio-{aammdd}-guard-*`) — nunca compete por "mais recente" contra os
 * do run das 19:00, e nunca é lido pela task `Diaria-Clarice-Envio-Alarm`.
 *
 * Classificação por SUFIXO (ver cada `writeAndRegisterReport` em
 * `clarice-envio-guard.ts` — esta lista precisa acompanhar se um novo
 * desfecho for adicionado lá):
 *   - `-paused` — kill switch desligado. OK.
 *   - `-nada-a-fazer` — sem onda pendente hoje. OK.
 *   - `-ok` — freio fresco reavaliado, dentro do aceitável. OK.
 *   - `-cancelou` — freio fresco em STOP, onda cancelada com sucesso (o
 *     guard fez exatamente o que devia). OK — é o caminho normal
 *     funcionando, não uma falha da automação.
 *   - QUALQUER OUTRO sufixo — ALARME. Cobre, deliberadamente:
 *     `-cancelamento-incompleto` (cancelamento não confirmado),
 *     `-lock-held`/`-abort` (falha dura), e TODOS os `-prereq-*` (#5220 —
 *     mesmo quando o fallback "funcionou", deixando a onda passar com o
 *     freio anterior OK ou suspendendo por precaução, o guard NÃO conseguiu
 *     reavaliar o freio com dado FRESCO, que é a função inteira dele; isso
 *     é sempre digno de atenção do editor, nunca silencioso). Fail-TOWARD-
 *     alarming de propósito, mesmo racional de `clarice-envio-alarm.ts`.
 *   - NENHUM relatório `-guard-*` encontrado pra `aammdd` — a task nem
 *     rodou (crash antes do try, systemd não disparou, máquina desligada
 *     na janela 05:00) — ALARME.
 *
 * **#6221 — sufixo `-prereq-fallback-override-vigente` é caso à PARTE
 * dentro de "QUALQUER OUTRO", com verdict próprio: `alarm-escalated`, não
 * `alarm-failure`.** É o único desfecho em que o guard, de propósito, NÃO
 * agiu sozinho — pré-requisito falhou, freio da noite era HOLD, e há
 * override do editor vigente sobre esse HOLD (#6134): cancelar desfaria uma
 * decisão explícita do editor, então o guard escala pro humano em vez de
 * cancelar. Ainda gera e-mail/issue (ação humana É necessária — o freio não
 * foi reavaliado com dado fresco), mas o VOCABULÁRIO muda: "escalou", não
 * "falhou". Achado ao vivo (#6215): o e-mail/issue anterior ("falhou")
 * levou um coordenador de overnight a ler um comportamento CORRETO como bug
 * e quase recomendar uma ação (liberar IP na Brevo) que teria revertido a
 * decisão do editor. Todo outro sufixo `-prereq-*`/`-cancelamento-
 * incompleto`/`-lock-held`/`-abort`/desconhecido continua `alarm-failure`,
 * sem mudança.
 */

// Notas de evento (alarm-evento, #5553):
//   - #6041 (P2, 260824): `envio-{aammdd}-guard-prereq-fallback-cancelamento-incompleto-nao-ok`
//     → causa raiz #6029 (cota Brevo ?fresh=1, corrigido em #6044 / 8805ab15).
//     Registra como evento histórico (family: "evento"); não se auto-resolve.
//     Regressão: test/clarice-envio-guard-alarm.test.ts.

export type EnvioGuardAlarmVerdict = "ok" | "alarm-no-report" | "alarm-failure" | "alarm-escalated";

export interface EnvioGuardAlarmReportFile {
  reportId: string;
  mtimeMs: number;
}

/** Sufixos de `reportId` (após `envio-{aammdd}-guard`) que representam desfecho ESPERADO — nunca alarme. Ver docstring do módulo pra origem de cada um. */
const OK_SUFFIXES = new Set(["-paused", "-nada-a-fazer", "-ok", "-cancelou"]);

/** #6221 — sufixo(s) que representam ESCALADA DELIBERADA (o guard fez o
 * certo, não agiu sozinho por precaução): ainda alarma (ação humana é
 * necessária), mas com vocabulário/verdict distintos de `alarm-failure`.
 * Ver docstring do módulo. Hoje só o caso do override vigente (#6134) —
 * lista deixada extensível de propósito, mas sem generalizar sem um caso
 * concreto novo. */
const ESCALATED_SUFFIXES = new Set(["-prereq-fallback-override-vigente"]);

/** Entre candidatos do MESMO `aammdd`, o mais recente por mtime — se o guard rodou 2x no dia (retry manual + task agendada), o desfecho que importa é o ÚLTIMO. */
export function pickLatestGuardReport(
  candidates: ReadonlyArray<EnvioGuardAlarmReportFile>,
): EnvioGuardAlarmReportFile | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
}

/** `reportId` que não começa com `envio-{aammdd}-guard` é forma inesperada — trata como alarme (mesmo racional fail-toward-alarming do módulo).
 * #6221 — 3 valores agora, não 2: `"escalated"` é o caso do override vigente
 * (ver `ESCALATED_SUFFIXES`), distinto de `"alarm"` (falha real) mesmo os
 * dois alarmando. */
export function classifyGuardReportId(reportId: string, aammdd: string): "ok" | "escalated" | "alarm" {
  const prefix = `envio-${aammdd}-guard`;
  if (!reportId.startsWith(prefix)) return "alarm";
  const suffix = reportId.slice(prefix.length);
  if (OK_SUFFIXES.has(suffix)) return "ok";
  if (ESCALATED_SUFFIXES.has(suffix)) return "escalated";
  return "alarm";
}

export interface EnvioGuardAlarmEvaluation {
  verdict: EnvioGuardAlarmVerdict;
  /** `null` só quando `verdict === "alarm-no-report"`. */
  reportId: string | null;
}

export function evaluateGuardAlarm(
  candidates: ReadonlyArray<EnvioGuardAlarmReportFile>,
  aammdd: string,
): EnvioGuardAlarmEvaluation {
  const latest = pickLatestGuardReport(candidates);
  if (!latest) return { verdict: "alarm-no-report", reportId: null };
  const classification = classifyGuardReportId(latest.reportId, aammdd);
  // #6221 — 3 vias, não 2: "escalated" vira `alarm-escalated` (ação humana
  // necessária, mas NÃO é falha — ver docstring do módulo), nunca colapsado
  // em `alarm-failure`.
  const verdict: EnvioGuardAlarmVerdict =
    classification === "ok" ? "ok" : classification === "escalated" ? "alarm-escalated" : "alarm-failure";
  return { verdict, reportId: latest.reportId };
}

// ---------------------------------------------------------------------------
// Idempotência — 1 alarme por `aammdd`, nunca reenviado no mesmo dia mesmo
// que a task de alarme rode mais de 1x (ex: retry manual de debug).
// ---------------------------------------------------------------------------

export interface EnvioGuardAlarmState {
  lastAlarmedAammdd: string | null;
}

export function emptyEnvioGuardAlarmState(): EnvioGuardAlarmState {
  return { lastAlarmedAammdd: null };
}

export function shouldSendGuardAlarm(evaluation: EnvioGuardAlarmEvaluation, state: EnvioGuardAlarmState, aammdd: string): boolean {
  if (evaluation.verdict === "ok") return false;
  return state.lastAlarmedAammdd !== aammdd;
}

export function markGuardAlarmed(_state: EnvioGuardAlarmState, aammdd: string): EnvioGuardAlarmState {
  return { lastAlarmedAammdd: aammdd };
}

// ---------------------------------------------------------------------------
// E-mail
// ---------------------------------------------------------------------------

/** `issueRef` (#5339, opcional) — outcome de `applyAlarmReconciliation`
 * (`scripts/lib/alarm-issues.ts`) pro achado desta rodada. `undefined`
 * (dry-run, ou wiring ainda não chamado) omite a citação sem quebrar nada —
 * mesmo fallback de `buildEnvioAlarmEmail`/`buildHubDriftAlarmEmail`. */
export function buildGuardAlarmEmail(
  evaluation: EnvioGuardAlarmEvaluation,
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
      subject: `⚠️ Diaria-Clarice-Envio-Guard: nenhum relatório encontrado pra ${aammdd}`,
      body:
        `A task Diaria-Clarice-Envio-Guard (05:00 BRT) deveria ter escrito um relatório em ` +
        `data/clarice-subscribers/envio-reports/envio-${aammdd}-guard-*.md, e não escreveu nenhum. ` +
        `Isso significa que a rodada nem chegou a rodar (systemd não disparou, máquina ` +
        `desligada/hibernando na janela 05:00, ou um crash ANTES do bloco try — mais grave que ` +
        `qualquer falha capturada normalmente) — o freio da onda de hoje NÃO foi reavaliado com ` +
        `dado fresco antes do disparo das 06:00. Verifique:\n\n` +
        `  systemctl --user status diaria-clarice-envio-guard.service\n` +
        `  journalctl --user -u diaria-clarice-envio-guard.service -n 100\n\n` +
        `Se ainda der tempo antes das 06:00, verifique a campanha manualmente no painel Brevo.` +
        issueLine,
    };
  }
  if (evaluation.verdict === "alarm-escalated") {
    return {
      subject: `⚠️ Diaria-Clarice-Envio-Guard ESCALOU em ${aammdd} (${evaluation.reportId}) — ação humana requerida`,
      body:
        `A rodada de ${aammdd} da task Diaria-Clarice-Envio-Guard (05:00 BRT) ESCALOU pra você — ` +
        `relatório: data/clarice-subscribers/envio-reports/${evaluation.reportId}.md ` +
        `(também na superfície de Relatórios do Studio, /relatorios).\n\n` +
        `**Isto NÃO é uma falha do guard.** Os pré-requisitos (clarice-plan-wave/clarice-envio-risk) ` +
        `falharam mesmo após retry, o freio da noite era HOLD, e há um override SEU vigente sobre esse ` +
        `HOLD (#6134) — o guard leu isso corretamente e NÃO cancelou a onda por precaução, porque ` +
        `cancelar teria desfeito a sua própria decisão. Nenhuma ação automática foi tomada. É o ` +
        `comportamento DESEJADO sempre que há override vigente — o guard escala pra você em vez de agir ` +
        `sozinho justamente porque a decisão já é sua, e ele não tem como saber se ela ainda vale com ` +
        `dado fresco.\n\n` +
        `Leia o relatório pra confirmar o motivo/prazo do override; se ele expirar antes da onda disparar ` +
        `(06:00 BRT) numa próxima rodada, o guard volta a decidir sozinho com base no fallback normal.` +
        issueLine,
    };
  }
  return {
    subject: `⚠️ Diaria-Clarice-Envio-Guard falhou em ${aammdd} (${evaluation.reportId})`,
    body:
      `A rodada de ${aammdd} da task Diaria-Clarice-Envio-Guard (05:00 BRT) terminou num desfecho ` +
      `que merece atenção — relatório: data/clarice-subscribers/envio-reports/${evaluation.reportId}.md ` +
      `(também na superfície de Relatórios do Studio, /relatorios).\n\n` +
      `Isso quer dizer que o guard NÃO conseguiu reavaliar o freio com dado FRESCO antes do disparo ` +
      `das 06:00 — seja porque os pré-requisitos (clarice-plan-wave/clarice-envio-risk) falharam mesmo ` +
      `após retry e caiu no fallback (#5220 — que decide sozinho deixar passar ou suspender por ` +
      `precaução, com base no ÚLTIMO freio conhecido, não num dado fresco), seja por cancelamento ` +
      `incompleto ou erro duro. Leia o relatório pra causa exata; se a onda de hoje ainda não disparou ` +
      `(antes das 06:00 BRT), considere checar/suspender manualmente pelo painel Brevo.` +
      issueLine,
  };
}
