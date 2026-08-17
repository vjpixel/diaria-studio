#!/usr/bin/env node
/**
 * scripts/clarice-envio-alarm.ts (#5058, item 2)
 *
 * Task diária (20:30 BRT — 1h30 depois do `Diaria-Clarice-Envio` das 19:00,
 * folga suficiente pro retry-com-backoff embutido em `clarice-envio-run.ts`
 * — até 3 tentativas, cap de 35min cada — esgotar antes desta checagem
 * rodar): lê o relatório mais recente que `runEnvio` escreveu HOJE
 * (`data/clarice-subscribers/envio-reports/envio-{aammdd}*.md`, TODO
 * caminho de saída grava exatamente 1) e classifica o desfecho. Se a rodada
 * falhou (ou nem rodou), alarma o editor por e-mail — sem isso, o único
 * sinal era um unit systemd vermelho que ninguém olha (achado ao vivo
 * 260811: a onda de 12/08 só existiu porque um humano montou à mão).
 *
 * Lógica pura em `scripts/lib/clarice-envio-alarm.ts` — este arquivo é só
 * I/O (listar arquivos, ler mtimes, enviar e-mail).
 *
 * Uso:
 *   npx tsx scripts/clarice-envio-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/clarice-envio-alarm.ts --dry-run      # avalia + imprime, NÃO envia nem persiste
 *   npx tsx scripts/clarice-envio-alarm.ts --to email@x   # override do destinatário
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` (mesmo requisito
 * dos outros alarmes locais deste repo) — só necessário pra ENVIAR o alarme;
 * a leitura dos relatórios não precisa de credencial nenhuma.
 *
 * Estado (idempotência): `data/clarice-subscribers/envio-alarm-state.json` —
 * 1 alarme por `aammdd`, mesmo que esta task rode mais de 1x no mesmo dia.
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
  evaluateEnvioAlarm,
  shouldSendEnvioAlarm,
  markEnvioAlarmed,
  emptyEnvioAlarmState,
  buildEnvioAlarmEmail,
  type EnvioAlarmEvaluation,
  type EnvioAlarmReportFile,
  type EnvioAlarmState,
} from "./lib/clarice-envio-alarm.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  type AlarmFinding,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS_DIR = resolve(ROOT, "data", "clarice-subscribers", "envio-reports");
const STATE_PATH = resolve(ROOT, "data", "clarice-subscribers", "envio-alarm-state.json");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "clarice-subscribers", "envio-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[clarice-envio-alarm]";
/** #5339: task roda diária (20:30) — 2 execuções limpas consecutivas (2
 * dias, já que o fingerprint inclui `aammdd`) fecham a issue automaticamente,
 * mesmo valor de cadência diária usado pelos alarmes já wired (lote 1/3). */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

export function loadState(statePath: string = STATE_PATH): EnvioAlarmState {
  if (!existsSync(statePath)) return emptyEnvioAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<EnvioAlarmState>;
    const lastAlarmedAammdd = typeof raw.lastAlarmedAammdd === "string" || raw.lastAlarmedAammdd === null
      ? raw.lastAlarmedAammdd ?? null
      : null;
    return { lastAlarmedAammdd };
  } catch {
    return emptyEnvioAlarmState();
  }
}

export function saveState(state: EnvioAlarmState, statePath: string = STATE_PATH): void {
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
 * ("clarice-envio"); `fingerprint` inclui `aammdd` — cada dia é seu próprio
 * achado (a rodada de amanhã é logicamente outro EVENTO), então uma falha de
 * HOJE nunca "esconde" atrás do estado de ontem. Sem PII: só `aammdd`,
 * verdict e `reportId` (nenhum e-mail de assinante entra aqui).
 *
 * `family: "evento"` (#5553) — a falha de um `aammdd` específico é um fato
 * histórico: a checagem de amanhã avalia OUTRO dia, então este achado
 * simplesmente sai de `pending` sem que nada tenha sido corrigido. Mesmo
 * racional de `clarice-guardrail-alarm.ts` (fingerprint `campaign-{id}`). */
export function toAlarmFinding(evaluation: EnvioAlarmEvaluation, aammdd: string): AlarmFinding {
  return {
    check: "clarice-envio",
    fingerprint: `${aammdd}:${evaluation.verdict}:${evaluation.reportId ?? "no-report"}`,
    family: "evento",
    title:
      evaluation.verdict === "alarm-no-report"
        ? `[diar.ia.br] Diaria-Clarice-Envio: nenhum relatório encontrado pra ${aammdd}`
        : `[diar.ia.br] Diaria-Clarice-Envio falhou em ${aammdd} (${evaluation.reportId})`,
    body: [
      "Achado automático do alarme `Diaria-Clarice-Envio-Alarm`",
      "(`scripts/clarice-envio-alarm.ts`).",
      "",
      `aammdd: ${aammdd}`,
      `verdict: ${evaluation.verdict}`,
      evaluation.reportId ? `reportId: ${evaluation.reportId}` : "Nenhum relatório encontrado — a rodada nem chegou a rodar.",
      "",
      "Monte a onda manualmente via /diaria-clarice-envio (skill manual) se ainda",
      "não houver onda agendada pra amanhã 06:00 BRT — não espere a task de amanhã.",
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
 * Lista os relatórios `envio-{aammdd}*.md` de HOJE — cada `writeAndRegisterReport`
 * de `runEnvio` grava exatamente 1 por invocação, então >1 candidato só
 * acontece se a rodada rodou mais de 1x no dia (retry manual). Ausência de
 * `data/` (junction não montada) devolve `[]` — o guard de registro
 * (`requiredFile: "clarice-subscribers/clarice-users.db"`) já cobre esse
 * caso antes de a task chegar aqui, mas `existsSync` defensivo evita um
 * `readdirSync` lançando em cima disso.
 */
export function listTodayEnvioReports(reportsDir: string, aammdd: string): EnvioAlarmReportFile[] {
  if (!existsSync(reportsDir)) return [];
  const prefix = `envio-${aammdd}`;
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
  const candidates = listTodayEnvioReports(REPORTS_DIR, aammdd);
  const evaluation = evaluateEnvioAlarm(candidates, aammdd);
  console.log(
    `${LOG_PREFIX} aammdd=${aammdd} candidatos=${candidates.length} verdict=${evaluation.verdict}` +
      (evaluation.reportId ? ` reportId=${evaluation.reportId}` : ""),
  );

  // #5339 — reconcilia issue pro achado (se houver) ANTES de montar o
  // e-mail (o e-mail cita a issue), mesmo padrão do lote 1/3. Roda toda
  // execução não-dry-run, independente de o e-mail idempotente disparar
  // nesta rodada (ver `shouldSendEnvioAlarm` abaixo, que é sobre o E-MAIL).
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
  if (!shouldSendEnvioAlarm(evaluation, state, aammdd)) {
    console.log(
      evaluation.verdict === "ok"
        ? `${LOG_PREFIX} rodada de ${aammdd} OK — nenhum alarme necessário.`
        : `${LOG_PREFIX} já alarmado pra ${aammdd} nesta invocação anterior — não reenvia.`,
    );
    return;
  }

  const { subject, body } = buildEnvioAlarmEmail(evaluation, aammdd, issueRef);
  const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    console.log(`${LOG_PREFIX} --dry-run: estado NÃO gravado.`);
    return;
  }
  await sendGmailMessage(to, subject, body);
  saveState(markEnvioAlarmed(state, aammdd));
  console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to} (aammdd=${aammdd}, verdict=${evaluation.verdict}).`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
