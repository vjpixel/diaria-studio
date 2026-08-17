#!/usr/bin/env node
/**
 * scripts/clarice-envio-guard-alarm.ts (#5220)
 *
 * Task diária (~06:15 BRT — depois do guard das 05:00, antes/perto do
 * disparo das 06:00): lê o relatório MAIS RECENTE que `clarice-envio-guard.ts`
 * escreveu HOJE na própria FAMÍLIA (`data/clarice-subscribers/envio-reports/
 * envio-{aammdd}-guard-*.md` — TODO caminho de saída do guard grava
 * exatamente 1) e classifica o desfecho. Deliberadamente SEPARADA de
 * `Diaria-Clarice-Envio-Alarm` (20:30 BRT, #5058) — aquela olha
 * `envio-{aammdd}*.md` do dia inteiro e pega o mais recente por mtime, o que
 * faz o relatório do RUN das 19:00 sempre vencer o do guard da MESMA manhã
 * (~15h mais novo) e esconder uma falha do guard (Gap 2 da issue #5220).
 *
 * Lógica pura em `scripts/lib/clarice-envio-guard-alarm.ts` — este arquivo é
 * só I/O (listar arquivos, ler mtimes, enviar e-mail). Mesmo molde de
 * `scripts/clarice-envio-alarm.ts` (#5058).
 *
 * Uso:
 *   npx tsx scripts/clarice-envio-guard-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/clarice-envio-guard-alarm.ts --dry-run      # avalia + imprime, NÃO envia nem persiste
 *   npx tsx scripts/clarice-envio-guard-alarm.ts --to email@x   # override do destinatário
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` (mesmo requisito
 * dos outros alarmes locais deste repo) — só necessário pra ENVIAR o alarme;
 * a leitura dos relatórios não precisa de credencial nenhuma.
 *
 * Estado (idempotência): `data/clarice-subscribers/envio-guard-alarm-state.json`
 * (dedicado — NÃO compartilha `envio-alarm-state.json` do run das 19:00,
 * senão um alarme do run "consumiria" o slot do dia e o guard nunca
 * alarmaria, ou vice-versa) — 1 alarme por `aammdd`, mesmo que esta task
 * rode mais de 1x no mesmo dia.
 */
import { existsSync, readFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { datePartsInTz, toAammdd, BRT_TIMEZONE } from "./lib/next-edition-date.ts";
import {
  evaluateGuardAlarm,
  shouldSendGuardAlarm,
  markGuardAlarmed,
  emptyEnvioGuardAlarmState,
  buildGuardAlarmEmail,
  type EnvioGuardAlarmEvaluation,
  type EnvioGuardAlarmReportFile,
  type EnvioGuardAlarmState,
} from "./lib/clarice-envio-guard-alarm.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  type AlarmFinding,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS_DIR = resolve(ROOT, "data", "clarice-subscribers", "envio-reports");
const STATE_PATH = resolve(ROOT, "data", "clarice-subscribers", "envio-guard-alarm-state.json");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "clarice-subscribers", "envio-guard-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[clarice-envio-guard-alarm]";
/** #5339: task roda diária (~06:15) — 2 execuções limpas consecutivas (2
 * dias, já que o fingerprint inclui `aammdd`) fecham a issue automaticamente,
 * mesmo valor de cadência diária usado pelos alarmes já wired (lote 1/3). */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

export function loadState(statePath: string = STATE_PATH): EnvioGuardAlarmState {
  if (!existsSync(statePath)) return emptyEnvioGuardAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<EnvioGuardAlarmState>;
    const lastAlarmedAammdd = typeof raw.lastAlarmedAammdd === "string" || raw.lastAlarmedAammdd === null
      ? raw.lastAlarmedAammdd ?? null
      : null;
    return { lastAlarmedAammdd };
  } catch {
    return emptyEnvioGuardAlarmState();
  }
}

export function saveState(state: EnvioGuardAlarmState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

// ─── Estado (dedup/reconciliação de ISSUE por achado, #5339) ──────────────
// Arquivo separado de STATE_PATH de propósito — mesmo racional do lote 1/3:
// idempotência do E-MAIL (acima) e tracking de ISSUE são preocupações
// independentes.

export function loadAlarmIssuesState(statePath: string = ALARM_ISSUES_STATE_PATH): AlarmIssuesState {
  if (!existsSync(statePath)) return emptyAlarmIssuesState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AlarmIssuesState;
    return emptyAlarmIssuesState();
  } catch {
    return emptyAlarmIssuesState();
  }
}

export function saveAlarmIssuesState(state: AlarmIssuesState, statePath: string = ALARM_ISSUES_STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

/** Converte uma avaliação NÃO-ok no `AlarmFinding` genérico que
 * `scripts/lib/alarm-issues.ts` consome (#5339). `check` fixo
 * ("clarice-envio-guard"); `fingerprint` inclui `aammdd` — cada dia é seu
 * próprio achado, mesmo racional de `clarice-envio-alarm.ts`. Sem PII: só
 * `aammdd`, verdict e `reportId`.
 *
 * `family: "evento"` (#5553) — mesmo racional de `clarice-envio-alarm.ts`:
 * a falha de um `aammdd` específico é um fato histórico, não uma condição
 * que "volta a ficar ok". */
export function toAlarmFinding(evaluation: EnvioGuardAlarmEvaluation, aammdd: string): AlarmFinding {
  return {
    check: "clarice-envio-guard",
    fingerprint: `${aammdd}:${evaluation.verdict}:${evaluation.reportId ?? "no-report"}`,
    family: "evento",
    title:
      evaluation.verdict === "alarm-no-report"
        ? `[diar.ia.br] Diaria-Clarice-Envio-Guard: nenhum relatório encontrado pra ${aammdd}`
        : `[diar.ia.br] Diaria-Clarice-Envio-Guard falhou em ${aammdd} (${evaluation.reportId})`,
    body: [
      "Achado automático do alarme `Diaria-Clarice-Envio-Guard-Alarm`",
      "(`scripts/clarice-envio-guard-alarm.ts`).",
      "",
      `aammdd: ${aammdd}`,
      `verdict: ${evaluation.verdict}`,
      evaluation.reportId ? `reportId: ${evaluation.reportId}` : "Nenhum relatório encontrado — a rodada nem chegou a rodar.",
      "",
      "Se a onda de hoje ainda não disparou (antes das 06:00 BRT), considere",
      "checar/suspender manualmente pelo painel Brevo.",
      "",
      "Esta issue é criada automaticamente pelo alarme (#5339) — achado de EVENTO",
      "PASSADO (#5553): a falha é do dia acima, não se auto-fecha quando a checagem",
      "seguinte avaliar outro dia. Fica aberta até um humano investigar/fechar",
      "(rota Overnight na Triagem).",
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
  };
}

/**
 * Lista os relatórios `envio-{aammdd}-guard-*.md` de HOJE — cada
 * `writeAndRegisterReport` de `runEnvioGuard` grava exatamente 1 por
 * invocação, então >1 candidato só acontece se o guard rodou mais de 1x no
 * dia (retry manual). Filtra pelo prefixo `-guard` explicitamente — NUNCA
 * pega um relatório do run das 19:00 (`envio-{aammdd}.md`,
 * `envio-{aammdd}-paused.md`, etc — sem o `-guard`), que é justamente o Gap
 * 2 da issue #5220. Ausência de `data/` (junction não montada) devolve
 * `[]` — o guard de registro (`requiredFile`) já cobre esse caso antes de a
 * task chegar aqui, mas `existsSync` defensivo evita um `readdirSync`
 * lançando em cima disso.
 */
export function listTodayGuardReports(reportsDir: string, aammdd: string): EnvioGuardAlarmReportFile[] {
  if (!existsSync(reportsDir)) return [];
  const prefix = `envio-${aammdd}-guard`;
  return readdirSync(reportsDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
    .map((f) => {
      const reportId = f.slice(0, -".md".length);
      const mtimeMs = statSync(resolve(reportsDir, f)).mtimeMs;
      return { reportId, mtimeMs };
    });
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const aammdd = toAammdd(datePartsInTz(new Date(), BRT_TIMEZONE));
  const candidates = listTodayGuardReports(REPORTS_DIR, aammdd);
  const evaluation = evaluateGuardAlarm(candidates, aammdd);
  console.log(
    `${LOG_PREFIX} aammdd=${aammdd} candidatos=${candidates.length} verdict=${evaluation.verdict}` +
      (evaluation.reportId ? ` reportId=${evaluation.reportId}` : ""),
  );

  // #5339 — reconcilia issue pro achado (se houver) ANTES de montar o
  // e-mail, mesmo padrão do lote 1/3. Roda toda execução não-dry-run,
  // independente de o e-mail idempotente disparar nesta rodada.
  const alarmFindings: AlarmFinding[] = evaluation.verdict !== "ok" ? [toAlarmFinding(evaluation, aammdd)] : [];
  const alarmState = loadAlarmIssuesState();
  let issueRef: { issueNumber: number | null; url: string | null; action: string; error?: string } | undefined;

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado.`,
    );
  } else {
    const { nextState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
      cwd: ROOT,
      closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
    });
    saveAlarmIssuesState(nextState);
    const outcome = findingOutcomes[0];
    if (outcome) {
      issueRef = { issueNumber: outcome.issueNumber, url: outcome.url, action: outcome.action, error: outcome.error };
      if (outcome.action === "failed") {
        console.error(`${LOG_PREFIX} issue não criada/reusada: ${outcome.error}`);
      } else {
        console.log(`${LOG_PREFIX} issue #${outcome.issueNumber} (${outcome.action}): ${outcome.url}`);
      }
    }
  }

  const state = loadState();
  if (!shouldSendGuardAlarm(evaluation, state, aammdd)) {
    console.log(
      evaluation.verdict === "ok"
        ? `${LOG_PREFIX} rodada de ${aammdd} OK — nenhum alarme necessário.`
        : `${LOG_PREFIX} já alarmado pra ${aammdd} nesta invocação anterior — não reenvia.`,
    );
    return;
  }

  const { subject, body } = buildGuardAlarmEmail(evaluation, aammdd, issueRef);
  const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    console.log(`${LOG_PREFIX} --dry-run: estado NÃO gravado.`);
    return;
  }
  await sendGmailMessage(to, subject, body);
  saveState(markGuardAlarmed(state, aammdd));
  console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to} (aammdd=${aammdd}, verdict=${evaluation.verdict}).`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
