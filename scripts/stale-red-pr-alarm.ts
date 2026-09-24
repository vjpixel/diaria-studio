#!/usr/bin/env node
/**
 * scripts/stale-red-pr-alarm.ts (#8530)
 *
 * Alarme: PR aberta, não-draft, com CI vermelho (verdict `"fail"` do gate
 * de `scripts/lib/pr-checks-gate.ts`) e sem commit novo há mais de
 * `--threshold-hours` (default 3h). Achado da #8530: 3 de 3 PRs abertas na
 * varredura de 20/09/2026 estavam paradas sem dono ativo — o denominador
 * comum é uma PR entrar em vermelho, o autor (sessão `/diaria-overnight`/
 * `/diaria-continuo`) já ter encerrado o tick, e nada voltar nela. Ver
 * `scripts/lib/stale-red-pr-alarm.ts` pra lógica pura + docs completas.
 *
 * Uso:
 *   npx tsx scripts/stale-red-pr-alarm.ts                       # avalia + persiste + alarma se achado NOVO
 *   npx tsx scripts/stale-red-pr-alarm.ts --dry-run              # avalia + imprime, NÃO alarma
 *   npx tsx scripts/stale-red-pr-alarm.ts --to email@x           # override do destinatário
 *   npx tsx scripts/stale-red-pr-alarm.ts --threshold-hours 4    # default 3
 *
 * Env: `gh` autenticado (mesmo requisito de `alarm-issues.ts`) +
 * `data/.credentials.json` com o scope `gmail.send` só pra ENVIAR (sob
 * `email_policy: "urgent_only"`, que é o default de `resolveEmailPolicy`,
 * a issue "acao" nunca dispara e-mail — só a issue em si).
 *
 * I/O em 2 estágios (#8530 achado ao vivo): `gh pr list` primeiro SEM
 * `commits` (pedir `commits` em lote pra até 100 PRs multiplica o custo de
 * nó do GraphQL e estourou o teto de 500k nós do GitHub com só 6 PRs
 * abertas), depois `gh pr view {N} --json commits` — um round-trip barato
 * por PR — só pros candidatos (CI vermelho + não-draft). Ver
 * `scripts/lib/stale-red-pr-alarm.ts` (`selectStaleRedPrCandidates`).
 *
 * Sem estado/idempotência LOCAL — mesmo desenho de
 * `on-hold-vencimento-alarm.ts`: o alarme reavalia o conjunto completo de
 * PRs paradas a cada execução; a dedup vive no GitHub via
 * `notifyEditor`/`ensureAlarmIssue` com fingerprint FIXO
 * (`STALE_RED_PR_ALARM_FINGERPRINT`, #8767) — 1 issue enquanto houver PR
 * parada; conjunto novo (`staleRedPrFindingSetKey`) vira comentário nela, e
 * a issue fecha quando a lista esvazia. Antes o fingerprint ERA o conjunto,
 * e cada conjunto novo abria issue nova sem fechar a anterior.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { notifyEditor } from "./lib/editor-notify.ts";
import { findExistingAlarmIssue } from "./lib/alarm-issues.ts";
import { spawnGhSync } from "./lib/shared/gh-run.ts";
import {
  selectStaleRedPrCandidates,
  evaluateStaleRedPrs,
  shouldAlarmStaleRedPrs,
  staleRedPrFindingSetKey,
  buildStaleRedPrAlarmEmail,
  needsSetUpdateComment,
  staleRedPrSetMarker,
  STALE_RED_PR_ALARM_FINGERPRINT,
  type StaleRedPrBasicEntry,
  type StaleRedPrListEntry,
  type PrCommitEntry,
} from "./lib/stale-red-pr-alarm.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[stale-red-pr-alarm]";
const DEFAULT_THRESHOLD_HOURS = 3;

interface GhPrListEntry {
  number: number;
  title: string;
  isDraft: boolean;
  mergeable?: string | null;
  statusCheckRollup: unknown;
}

interface GhPrViewCommitsEntry {
  commits?: PrCommitEntry[];
}

/**
 * Lista PRs abertas via `gh pr list` — SEM `commits` (#8530 achado ao
 * vivo): pedir `commits` no mesmo `gh pr list --limit 100` multiplica o
 * custo de nó do GraphQL (commits × authors × N PRs) e estourou o teto de
 * 500k nós do GitHub com só 6 PRs abertas na medição real. `null` em falha
 * do `gh` (não autenticado, offline, rate limit, JSON malformado) — caller
 * decide como tratar; NUNCA lido como "0 PRs abertas" (mesma disciplina de
 * `listOpenOnHoldIssues` em `on-hold-vencimento-alarm.ts`).
 */
export function listOpenPrsBasic(cwd: string = ROOT): StaleRedPrBasicEntry[] | null {
  const res = spawnGhSync(
    ["pr", "list", "--state", "open", "--json", "number,title,isDraft,mergeable,statusCheckRollup", "--limit", "100"],
    cwd,
  );
  if (res.status !== 0) return null;
  try {
    const entries = JSON.parse(res.stdout) as GhPrListEntry[];
    return entries.map((e) => ({
      number: e.number,
      title: e.title,
      isDraft: e.isDraft,
      mergeable: e.mergeable ?? null,
      statusCheckRollup: e.statusCheckRollup,
    }));
  } catch {
    return null;
  }
}

/**
 * Busca `commits` de UMA PR via `gh pr view {N}` — round-trip barato (o
 * custo de nó do GraphQL não se multiplica por N PRs, ver
 * `listOpenPrsBasic`). `null` em falha do `gh`/parse — caller trata como
 * "não dá pra avaliar esta PR", nunca como "sem commits".
 */
export function fetchPrCommits(prNumber: number, cwd: string = ROOT): PrCommitEntry[] | null {
  const res = spawnGhSync(["pr", "view", String(prNumber), "--json", "commits"], cwd);
  if (res.status !== 0) return null;
  try {
    const parsed = JSON.parse(res.stdout) as GhPrViewCommitsEntry;
    return Array.isArray(parsed.commits) ? parsed.commits : [];
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  const thresholdArg = getArg(argv, "threshold-hours");
  const thresholdHours = thresholdArg ? Number(thresholdArg) : DEFAULT_THRESHOLD_HOURS;
  if (!Number.isFinite(thresholdHours) || thresholdHours <= 0) {
    throw new Error(`--threshold-hours deve ser um número positivo, recebido "${thresholdArg}"`);
  }

  const basicPrs = listOpenPrsBasic();
  if (basicPrs === null) {
    console.error(`${LOG_PREFIX} 'gh pr list' falhou — não avalia, não alarma. Checar 'gh auth status'.`);
    process.exitCode = 1;
    return;
  }

  // Round-trip de `commits` só pros candidatos (CI vermelho + não-draft) —
  // ver docstring de `listOpenPrsBasic` pro porquê de não pedir `commits`
  // no `gh pr list` em lote.
  const candidates = selectStaleRedPrCandidates(basicPrs);
  const withCommits: StaleRedPrListEntry[] = [];
  for (const candidate of candidates) {
    const commits = fetchPrCommits(candidate.number);
    if (commits === null) {
      console.error(`${LOG_PREFIX} 'gh pr view ${candidate.number} --json commits' falhou — pulando esta PR nesta run (não inventa achado nem "sem commits").`);
      continue;
    }
    withCommits.push({ ...candidate, commits });
  }

  const now = new Date();
  const findings = evaluateStaleRedPrs(withCommits, now, thresholdHours);
  console.log(
    `${LOG_PREFIX} PRs abertas: ${basicPrs.length}, candidatas (CI vermelho + não-draft): ${candidates.length}, paradas (sem commit novo há >= ${thresholdHours}h): ${findings.length}`,
  );

  if (!shouldAlarmStaleRedPrs(findings)) {
    console.log(`${LOG_PREFIX} nenhum achado — nenhuma PR aberta está vermelha e parada além do limiar.`);
    if (!isDryRun) closeResolvedAlarmIssue();
    return;
  }

  const { subject, body: rawBody } = buildStaleRedPrAlarmEmail(findings, thresholdHours, now);
  const setKey = staleRedPrFindingSetKey(findings);
  const body = `${rawBody}\n\n${staleRedPrSetMarker(setKey)}`;
  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: registraria alarme:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    return;
  }

  // #8767: fingerprint FIXO — 1 issue enquanto houver PR parada; mudança de
  // conjunto vira comentário (abaixo), nunca issue nova.
  const result = await notifyEditor(
    { check: ALARM_CHECK, fingerprint: STALE_RED_PR_ALARM_FINGERPRINT, severity: "acao", subject, body },
    { cwd: ROOT, emailTo: toOverride },
  );
  if (result.issue?.action === "failed") {
    throw new Error(`ensureAlarmIssue falhou: ${result.issue.error}`);
  }
  const issueNumber = result.issue?.issueNumber;
  // "reopened" também: o comentário de reabertura de `ensureAlarmIssue` é
  // genérico e não lista as PRs.
  if (issueNumber && (result.issue?.action === "reused" || result.issue?.action === "reopened")) {
    commentIfSetChanged(issueNumber, setKey, body);
  }
  console.log(`${LOG_PREFIX} alarme registrado (issue #${issueNumber ?? "?"}, ${findings.length} achado(s)).`);
}

const ALARM_CHECK = "stale-red-pr-alarm";

/** Comenta o conjunto atual na issue reusada só se ele ainda não foi
 * reportado lá (corpo ou comentário) — mesmo conjunto = silêncio. */
function commentIfSetChanged(issueNumber: number, setKey: string, body: string): void {
  const res = spawnGhSync(["issue", "view", String(issueNumber), "--json", "body,comments"], ROOT);
  if (res.status !== 0) return; // fail-soft: sem leitura, não comenta às cegas
  let texts: string[];
  try {
    const parsed = JSON.parse(res.stdout) as { body?: string; comments?: { body: string }[] };
    texts = [parsed.body ?? "", ...(parsed.comments ?? []).map((c) => c.body)];
  } catch {
    return;
  }
  if (!needsSetUpdateComment(texts, setKey)) return;
  spawnGhSync(["issue", "comment", String(issueNumber), "--body", `Conjunto de PRs paradas mudou:\n\n${body}`], ROOT);
}

/** Lista vazia → fecha a issue única aberta, se houver. */
function closeResolvedAlarmIssue(): void {
  const existing = findExistingAlarmIssue(ALARM_CHECK, STALE_RED_PR_ALARM_FINGERPRINT, ROOT);
  if (!existing || existing.state !== "OPEN") return;
  spawnGhSync(
    ["issue", "close", String(existing.issueNumber), "--comment", "Nenhuma PR aberta está vermelha e parada — alarme resolvido.", "--reason", "completed"],
    ROOT,
  );
}


if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
