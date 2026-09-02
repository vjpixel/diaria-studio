/**
 * clarice-envio-engajados-alarm.ts (#6945)
 *
 * Lógica PURA do alarme de rodada falha da task `Diaria-Clarice-Envio-Engajados`
 * — mesmo padrão de `clarice-envio-alarm.ts` (o alarme do ramp-warm, #5058
 * item 2), reimplementado aqui (não parametrizado sobre o módulo original)
 * porque os dois têm vocabulário de sufixo DIFERENTE: o vocabulário de
 * pausas legítimas do ramp-warm (`-freio-stop`, `-abc-iniciar`, etc.) não
 * existe pra `engajados` (sem freio/ABC próprio), e o inverso também
 * (`-sem-assunto-travado` só existe aqui). Duplicar um módulo pequeno e
 * genuinamente diferente é mais seguro que generalizar um módulo já
 * testado em produção pra um 2º formato de sufixo à base de string.
 *
 * Estratégia idêntica: lê o relatório que `runEnvioEngajados` já escreve em
 * TODA rodada (`data/clarice-subscribers/envio-reports/envio-engajados-{aammdd}*.md`)
 * e classifica pelo sufixo do `reportId`.
 */

export type EnvioEngajadosAlarmVerdict = "ok" | "alarm-no-report" | "alarm-failure";

export interface EnvioEngajadosAlarmReportFile {
  reportId: string;
  mtimeMs: number;
}

/**
 * Sufixos que representam desfecho ESPERADO — nunca alarme. Ver docstring
 * do módulo.
 *
 * `-lock-held` diverge DELIBERADAMENTE do irmão ramp-warm
 * (`clarice-envio-alarm.ts`, onde esse sufixo alarma): lá, o lock detido
 * significa "nenhuma onda foi planejada pro dia seguinte" — a rampa
 * PRINCIPAL de amanhã pode estar faltando, evento que vale alarmar mesmo
 * sem ser um bug de código. Aqui, quando `engajados` perde a corrida do
 * MESMO lock por ciclo (`clarice-envio-lock.ts`) é justamente porque o
 * ramp-warm está rodando (ele SEMPRE ganha por rodar primeiro, 19:10 vs
 * 20:15) — a onda principal do dia seguinte segue intacta, só o reforço de
 * retenção atrasa 1 dia, e a escalada de volume não perde progresso nisso
 * (`clarice-envio-engajados-state.ts` só avança em confirmação). Alarmar
 * aqui treinaria o editor a ignorar um alarme que, nesta automação, é
 * sempre benigno.
 */
const OK_SUFFIXES = new Set([
  "", // sucesso — campanha agendada
  "-paused", // kill switch desligado (default nesta automação — nunca alarma)
  "-sem-ciclo-elegivel",
  "-sem-assunto-travado",
  "-dry-run",
  "-lock-held", // rodada concorrente do ramp-warm no mesmo ciclo — self-heals amanhã (ver docstring acima)
]);

export function pickLatestEnvioEngajadosReport(
  candidates: ReadonlyArray<EnvioEngajadosAlarmReportFile>,
): EnvioEngajadosAlarmReportFile | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
}

export function classifyEnvioEngajadosReportId(reportId: string, aammdd: string): "ok" | "alarm" {
  const prefix = `envio-engajados-${aammdd}`;
  if (!reportId.startsWith(prefix)) return "alarm";
  const suffix = reportId.slice(prefix.length);
  return OK_SUFFIXES.has(suffix) ? "ok" : "alarm";
}

export interface EnvioEngajadosAlarmEvaluation {
  verdict: EnvioEngajadosAlarmVerdict;
  reportId: string | null;
}

export function evaluateEnvioEngajadosAlarm(
  candidates: ReadonlyArray<EnvioEngajadosAlarmReportFile>,
  aammdd: string,
): EnvioEngajadosAlarmEvaluation {
  const latest = pickLatestEnvioEngajadosReport(candidates);
  if (!latest) return { verdict: "alarm-no-report", reportId: null };
  const classification = classifyEnvioEngajadosReportId(latest.reportId, aammdd);
  return { verdict: classification === "ok" ? "ok" : "alarm-failure", reportId: latest.reportId };
}

export interface EnvioEngajadosAlarmState {
  lastAlarmedAammdd: string | null;
}

export function emptyEnvioEngajadosAlarmState(): EnvioEngajadosAlarmState {
  return { lastAlarmedAammdd: null };
}

export function shouldSendEnvioEngajadosAlarm(
  evaluation: EnvioEngajadosAlarmEvaluation,
  state: EnvioEngajadosAlarmState,
  aammdd: string,
): boolean {
  if (evaluation.verdict === "ok") return false;
  return state.lastAlarmedAammdd !== aammdd;
}

export function markEnvioEngajadosAlarmed(_state: EnvioEngajadosAlarmState, aammdd: string): EnvioEngajadosAlarmState {
  return { lastAlarmedAammdd: aammdd };
}

export function buildEnvioEngajadosAlarmEmail(
  evaluation: EnvioEngajadosAlarmEvaluation,
  aammdd: string,
): { subject: string; body: string } {
  if (evaluation.verdict === "alarm-no-report") {
    return {
      subject: `⚠️ Diaria-Clarice-Envio-Engajados: nenhum relatório encontrado pra ${aammdd}`,
      body:
        `A task Diaria-Clarice-Envio-Engajados deveria ter escrito um relatório em ` +
        `data/clarice-subscribers/envio-reports/envio-engajados-${aammdd}*.md, e não escreveu nenhum. ` +
        `A rodada nem chegou a rodar (systemd não disparou, máquina desligada/hibernando na janela, ou um ` +
        `crash ANTES do bloco try). Verifique:\n\n` +
        `  systemctl --user status diaria-clarice-envio-engajados.service\n` +
        `  journalctl --user -u diaria-clarice-envio-engajados.service -n 100\n\n` +
        `Não há gate humano no caminho normal — se a task ficar parada por dias, o backlog do grupo ` +
        `engajados volta a acumular sem que ninguém saiba.`,
    };
  }
  return {
    subject: `⚠️ Diaria-Clarice-Envio-Engajados falhou em ${aammdd} (${evaluation.reportId})`,
    body:
      `A rodada de ${aammdd} da task Diaria-Clarice-Envio-Engajados terminou em falha — ` +
      `relatório: data/clarice-subscribers/envio-reports/${evaluation.reportId}.md ` +
      `(também na superfície de Relatórios do Studio, /relatorios).\n\n` +
      `Leia o relatório pra causa exata. Diferente do ramp-warm, esta rodada NÃO retenta sozinha — ` +
      `se o problema for transitório (rate limit Brevo), a rodada de amanhã tenta de novo com o mesmo ` +
      `volume proposto (a escalada não perde progresso em um dia pulado).`,
  };
}
