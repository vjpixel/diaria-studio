#!/usr/bin/env node
/**
 * scripts/stuck-approved-pr-alarm.ts (#12950 item 5)
 *
 * Alarme: PR com review approve e CI verde aberta há mais de
 * `--threshold-hours` (default 4h), independentemente de escalada. Lógica
 * pura e racional em `scripts/lib/stuck-approved-pr-alarm.ts`.
 *
 * Uso:
 *   npx tsx scripts/stuck-approved-pr-alarm.ts                     # avalia + alarma
 *   npx tsx scripts/stuck-approved-pr-alarm.ts --dry-run            # avalia + imprime, NÃO alarma
 *   npx tsx scripts/stuck-approved-pr-alarm.ts --to email@x         # override do destinatário
 *   npx tsx scripts/stuck-approved-pr-alarm.ts --threshold-hours 6  # default 4
 *
 * I/O em 2 estágios, como `stale-red-pr-alarm.ts` (#8530): `gh pr list`
 * sem `comments` (custo de nó do GraphQL), depois `gh pr view N --json
 * comments` só para as candidatas (verdes, velhas, fora das exclusões) que
 * não têm `reviewDecision=APPROVED`.
 *
 * Sem estado local: reavalia o conjunto a cada run. Dedup no GitHub via
 * `notifyEditor` com fingerprint FIXO (1 issue enquanto houver PR parada,
 * conjunto novo vira comentário, lista vazia fecha a issue), igual ao
 * `stale-red-pr-alarm.ts` desde o #8767.
 *
 * `gh pr list` falho sai 1 sem alarmar (nunca lido como "0 PRs"). Falha no
 * `gh pr view` de uma candidata pula só ela, com aviso em stderr, e conta:
 * com alguma pulada a run NUNCA fecha a issue nem comenta conjunto novo, e
 * sai 1 (`decideStuckApprovedRunOutcome`, #12950 review). Falha de
 * `gh issue comment`/`gh issue close` é logada e também sai 1.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { applyCliAction, type CliSpec, hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { notifyEditor } from "./lib/editor-notify.ts";
import { findExistingAlarmIssue } from "./lib/alarm-issues.ts";
import { spawnGhSync } from "./lib/shared/gh-run.ts";
import {
  buildStuckApprovedPrAlarmEmail,
  decideStuckApprovedRunOutcome,
  DEFAULT_STUCK_APPROVED_THRESHOLD_HOURS,
  evaluateStuckApprovedPrs,
  needsStuckApprovedSetComment,
  selectStuckApprovedCandidates,
  STUCK_APPROVED_PR_ALARM_FINGERPRINT,
  stuckApprovedPrSetKey,
  stuckApprovedPrSetMarker,
  type StuckApprovedPrBasicEntry,
  type StuckApprovedPrEntry,
} from "./lib/stuck-approved-pr-alarm.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[stuck-approved-pr-alarm]";
const ALARM_CHECK = "stuck-approved-pr-alarm";

interface GhPrListEntry {
  number: number;
  title: string;
  body?: string | null;
  isDraft: boolean;
  labels?: { name?: string }[] | null;
  createdAt: string;
  mergeable?: string | null;
  statusCheckRollup: unknown;
  reviewDecision?: string | null;
  headRefOid?: string | null;
}

/** `null` em falha do `gh` ou JSON malformado; nunca "0 PRs abertas". */
export function listOpenPrsBasic(cwd: string = ROOT): StuckApprovedPrBasicEntry[] | null {
  const res = spawnGhSync(
    [
      "pr", "list", "--state", "open",
      "--json", "number,title,body,isDraft,labels,createdAt,mergeable,statusCheckRollup,reviewDecision,headRefOid",
      "--limit", "100",
    ],
    cwd,
  );
  if (res.status !== 0) return null;
  try {
    const entries = JSON.parse(res.stdout) as GhPrListEntry[];
    if (!Array.isArray(entries)) return null;
    return entries.map((e) => ({
      number: e.number,
      title: e.title,
      body: typeof e.body === "string" ? e.body : null,
      isDraft: e.isDraft === true,
      labels: (e.labels ?? []).map((l) => (typeof l?.name === "string" ? l.name : "")).filter((n) => n !== ""),
      createdAt: e.createdAt,
      mergeable: e.mergeable ?? null,
      statusCheckRollup: e.statusCheckRollup,
      reviewDecision: e.reviewDecision ?? null,
      headRefOid: e.headRefOid ?? null,
    }));
  } catch {
    return null;
  }
}

/** `comments` de UMA PR; `null` em falha (a candidata é pulada, nunca vira "sem review"). */
export function fetchPrComments(prNumber: number, cwd: string = ROOT): unknown[] | null {
  const res = spawnGhSync(["pr", "view", String(prNumber), "--json", "comments"], cwd);
  if (res.status !== 0) return null;
  try {
    const parsed = JSON.parse(res.stdout) as { comments?: unknown };
    return Array.isArray(parsed.comments) ? parsed.comments : [];
  } catch {
    return null;
  }
}

export const CLI_SPEC: CliSpec = {
  script: "scripts/stuck-approved-pr-alarm.ts",
  booleans: ["dry-run"],
  values: ["to", "threshold-hours"],
};

async function main(): Promise<void> {
  const cliExit = applyCliAction(process.argv.slice(2), CLI_SPEC);
  if (cliExit !== null) {
    process.exitCode = cliExit;
    return;
  }
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  const thresholdArg = getArg(argv, "threshold-hours");
  const thresholdHours = thresholdArg ? Number(thresholdArg) : DEFAULT_STUCK_APPROVED_THRESHOLD_HOURS;
  if (!Number.isFinite(thresholdHours) || thresholdHours <= 0) {
    throw new Error(`--threshold-hours deve ser um número positivo, recebido "${thresholdArg}"`);
  }

  const basicPrs = listOpenPrsBasic();
  if (basicPrs === null) {
    console.error(`${LOG_PREFIX} 'gh pr list' falhou: não avalia, não alarma. Checar 'gh auth status'.`);
    process.exitCode = 1;
    return;
  }

  const now = new Date();
  const candidates = selectStuckApprovedCandidates(basicPrs, now, thresholdHours);
  const withComments: StuckApprovedPrEntry[] = [];
  let skipped = 0;
  for (const candidate of candidates) {
    if (candidate.reviewDecision === "APPROVED") {
      withComments.push({ ...candidate, comments: [] });
      continue;
    }
    const comments = fetchPrComments(candidate.number);
    if (comments === null) {
      console.error(`${LOG_PREFIX} 'gh pr view ${candidate.number} --json comments' falhou: pulando esta PR nesta run.`);
      skipped++;
      continue;
    }
    withComments.push({ ...candidate, comments });
  }

  const findings = evaluateStuckApprovedPrs(withComments, now, thresholdHours);
  console.log(
    `${LOG_PREFIX} PRs abertas: ${basicPrs.length}, candidatas (verdes, abertas há >= ${thresholdHours}h): ${candidates.length}, aprovadas e paradas: ${findings.length}, puladas por falha do gh: ${skipped}`,
  );

  const outcome = decideStuckApprovedRunOutcome(findings.length, skipped);
  if (outcome === "hold") {
    console.error(
      `${LOG_PREFIX} nenhum achado, mas ${skipped} candidata(s) não puderam ser checadas: não fecha a issue, não comenta. Sai 1.`,
    );
    process.exitCode = 1;
    return;
  }
  if (outcome === "close") {
    console.log(`${LOG_PREFIX} nenhum achado: nenhuma PR aprovada e verde está parada além do limiar.`);
    if (!isDryRun && !closeResolvedAlarmIssue()) process.exitCode = 1;
    return;
  }

  const { subject, body: rawBody } = buildStuckApprovedPrAlarmEmail(findings, thresholdHours, now);
  const setKey = stuckApprovedPrSetKey(findings);
  const body = `${rawBody}\n\n${stuckApprovedPrSetMarker(setKey)}`;
  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: registraria alarme:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    return;
  }

  const result = await notifyEditor(
    { check: ALARM_CHECK, fingerprint: STUCK_APPROVED_PR_ALARM_FINGERPRINT, severity: "acao", subject, body },
    { cwd: ROOT, emailTo: toOverride },
  );
  if (result.issue?.action === "failed") {
    throw new Error(`ensureAlarmIssue falhou: ${result.issue.error}`);
  }
  const issueNumber = result.issue?.issueNumber;
  if (outcome === "notify-partial") {
    console.error(
      `${LOG_PREFIX} ${skipped} candidata(s) não puderam ser checadas: conjunto incompleto, não comenta. Sai 1.`,
    );
    process.exitCode = 1;
  } else if (issueNumber && (result.issue?.action === "reused" || result.issue?.action === "reopened")) {
    if (!commentIfSetChanged(issueNumber, setKey, body)) process.exitCode = 1;
  }
  console.log(`${LOG_PREFIX} alarme registrado (issue #${issueNumber ?? "?"}, ${findings.length} achado(s)).`);
}

/** Comenta o conjunto atual na issue reusada só se ele ainda não foi reportado lá. `false` = falha do gh (logada). */
function commentIfSetChanged(issueNumber: number, setKey: string, body: string): boolean {
  const res = spawnGhSync(["issue", "view", String(issueNumber), "--json", "body,comments"], ROOT);
  if (res.status !== 0) {
    console.error(`${LOG_PREFIX} gh issue view ${issueNumber} falhou (status ${res.status}): conjunto não comparado.`);
    return false;
  }
  let texts: string[];
  try {
    const parsed = JSON.parse(res.stdout) as { body?: string; comments?: { body: string }[] };
    texts = [parsed.body ?? "", ...(parsed.comments ?? []).map((c) => c.body)];
  } catch {
    console.error(`${LOG_PREFIX} gh issue view ${issueNumber}: JSON malformado, conjunto não comparado.`);
    return false;
  }
  if (!needsStuckApprovedSetComment(texts, setKey)) return true;
  const commented = spawnGhSync(
    ["issue", "comment", String(issueNumber), "--body", `Conjunto de PRs aprovadas paradas mudou:\n\n${body}`],
    ROOT,
  );
  if (commented.status !== 0) {
    console.error(`${LOG_PREFIX} gh issue comment ${issueNumber} falhou (status ${commented.status}).`);
    return false;
  }
  return true;
}

/** Lista vazia: fecha a issue única aberta, se houver. `false` = falha do gh (logada). */
function closeResolvedAlarmIssue(): boolean {
  const existing = findExistingAlarmIssue(ALARM_CHECK, STUCK_APPROVED_PR_ALARM_FINGERPRINT, ROOT);
  if (!existing || existing.state !== "OPEN") return true;
  const closed = spawnGhSync(
    ["issue", "close", String(existing.issueNumber), "--comment", "Nenhuma PR aprovada e verde está parada: alarme resolvido.", "--reason", "completed"],
    ROOT,
  );
  if (closed.status !== 0) {
    console.error(`${LOG_PREFIX} gh issue close ${existing.issueNumber} falhou (status ${closed.status}).`);
    return false;
  }
  return true;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
