#!/usr/bin/env -S npx tsx
/**
 * scripts/backlog-reconcile.ts (#6198)
 *
 * CLI (I/O) da reconciliação diária do backlog aberto. Lógica pura em
 * `scripts/lib/backlog-reconcile.ts` — este arquivo só busca dado via `gh`,
 * aplica as correções seguras via `routeIssue` (`scripts/route-issue.ts`,
 * o único caminho de escrita — nunca `gh issue edit` direto) e imprime o
 * relatório, separando o que foi CORRIGIDO do que foi só ALARMADO.
 *
 * Uso:
 *   npx tsx scripts/backlog-reconcile.ts              # avalia + corrige + relata
 *   npx tsx scripts/backlog-reconcile.ts --dry-run     # avalia + relata, NÃO escreve nada
 *   npx tsx scripts/backlog-reconcile.ts --limit 500   # teto de issues buscadas (default 300)
 *
 * Idempotente por construção: rodar contra um backlog já convergido não
 * encontra nenhum achado de padrão 1/2 (a contradição já foi resolvida) —
 * ver `test/backlog-reconcile.test.ts`. `routeIssue` releva/revalida o
 * estado pós-escrita sozinho (passo 4 dele), então mesmo uma corrida entre
 * duas rodadas da task (achado ao vivo na auditoria #6191 — 3s entre duas
 * ações de sessões diferentes na mesma issue) nunca aplica uma correção
 * sobre estado obsoleto: o `routeIssue` de CADA achado busca o estado da
 * issue de novo antes de escrever (`fetchIssueState` — não reusa a leitura
 * em lote deste script pra decidir o que escrever, só pra decidir SE há
 * algo a fazer).
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hasFlag, getIntArg, isMainModule } from "./lib/cli-args.ts";
import { spawnGhSync, type GhSpawnResult } from "./lib/shared/gh-run.ts";
import { classifyExecTrack } from "./lib/issue-exec-track.ts";
import { routeIssue, type RouteIssueResult } from "./route-issue.ts";
import {
  detectMarkerDeferralConflict,
  detectInheritedBlockLabel,
  detectOpenChecklistInTerminalIssue,
  detectSiblingBlockLabelInconsistency,
  extractParentRef,
  splitFindingsByAction,
  type BacklogIssueInput,
  type ReconcileFinding,
  type MarkerDeferralConflictFix,
} from "./lib/backlog-reconcile.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[backlog-reconcile]";
const DEFAULT_LIMIT = 300;

export type GhRunFn = (args: string[], cwd: string) => GhSpawnResult;

interface GhIssueListEntry {
  number: number;
  title: string;
  url: string;
  state: string;
  body: string | null;
  labels?: Array<{ name?: string }>;
}

function normalizeLabels(entry: GhIssueListEntry): string[] {
  return (entry.labels ?? []).map((l) => l.name ?? "").filter((n) => n.length > 0);
}

/** Busca TODAS as issues abertas (labels+body+state). `null` em falha do
 * `gh` — nunca segue avaliando sobre um resultado parcial/vazio que pareça
 * "backlog limpo". */
export function fetchOpenBacklog(cwd: string, limit: number, ghRun: GhRunFn = spawnGhSync): BacklogIssueInput[] | null {
  const res = ghRun(
    ["issue", "list", "--state", "open", "--json", "number,title,url,state,body,labels", "--limit", String(limit)],
    cwd,
  );
  if (res.status !== 0) return null;
  try {
    const entries = JSON.parse(res.stdout) as GhIssueListEntry[];
    return entries.map((e) => ({
      number: e.number,
      title: e.title,
      url: e.url,
      state: e.state,
      body: e.body ?? "",
      labels: normalizeLabels(e),
    }));
  } catch {
    return null;
  }
}

interface GhIssueViewMinimal {
  number: number;
  state: string;
  labels?: Array<{ name?: string }>;
}

/** Busca número + estado + labels de UMA issue (pra resolver a mãe de uma
 * referência "Fatia de #N" que não esteja no lote de abertas — a mãe pode
 * estar fechada). `null` em falha (issue inexistente, `gh` indisponível). */
function fetchIssueMinimal(issueNumber: number, cwd: string, ghRun: GhRunFn): { number: number; labels: string[] } | null {
  const res = ghRun(["issue", "view", String(issueNumber), "--json", "number,state,labels"], cwd);
  if (res.status !== 0) return null;
  try {
    const parsed = JSON.parse(res.stdout) as GhIssueViewMinimal;
    return { number: parsed.number, labels: (parsed.labels ?? []).map((l) => l.name ?? "").filter((n) => n.length > 0) };
  } catch {
    return null;
  }
}

/** Roda as 5 detecções sobre o backlog inteiro. Busca mãe sob demanda (com
 * cache local — várias filhas podem referenciar a mesma mãe) só quando o
 * padrão 3 tem uma referência a resolver. Padrão 5 (#6201) opera sobre o
 * conjunto inteiro de uma vez (agrupa por mãe internamente), não issue a
 * issue como os demais — roda uma única vez fora do loop. */
export function evaluateBacklog(
  issues: readonly BacklogIssueInput[],
  now: Date,
  cwd: string,
  ghRun: GhRunFn = spawnGhSync,
): ReconcileFinding[] {
  const findings: ReconcileFinding[] = [];
  const parentCache = new Map<number, { number: number; labels: string[] } | null>();

  for (const issue of issues) {
    const markerFinding = detectMarkerDeferralConflict(issue, now);
    if (markerFinding) findings.push(markerFinding);

    const parentRef = extractParentRef(issue.body);
    if (parentRef !== null) {
      if (!parentCache.has(parentRef)) {
        parentCache.set(parentRef, fetchIssueMinimal(parentRef, cwd, ghRun));
      }
      const parent = parentCache.get(parentRef) ?? null;
      const inheritedFinding = detectInheritedBlockLabel(issue, parent);
      if (inheritedFinding) findings.push(inheritedFinding);
    }

    const execTrack = classifyExecTrack({ labels: issue.labels, body: issue.body, state: issue.state, now });
    const checklistFinding = detectOpenChecklistInTerminalIssue(issue, execTrack);
    if (checklistFinding) findings.push(checklistFinding);
  }

  findings.push(...detectSiblingBlockLabelInconsistency(issues));

  return findings;
}

/** Aplica UMA correção segura via `routeIssue` — nunca `gh issue edit`
 * direto (ver docstring do módulo). */
export function applyFix(fix: MarkerDeferralConflictFix, cwd: string, ghRun: GhRunFn = spawnGhSync, now?: Date): RouteIssueResult {
  const reason =
    `reconciliação diária (#6198): marcador aguardando-ate: ${fix.markerDate} coexistia com ${fix.conflictingLabels.join(", ")} — ` +
    (fix.routeTrack === "agendada"
      ? "marcador ainda futuro, vence sobre o deferimento vago."
      : "marcador já expirado, label conflitante removida e issue devolvida ao fluxo normal.");
  return routeIssue({
    issue: fix.issue,
    track: fix.routeTrack,
    until: fix.routeTrack === "agendada" ? fix.markerDate : undefined,
    reason,
    cwd,
    ghRun,
    now,
  });
}

function printReport(findings: readonly ReconcileFinding[], applied: Map<number, RouteIssueResult>, dryRun: boolean): void {
  const { fixes, alarms } = splitFindingsByAction(findings);

  console.log(`${LOG_PREFIX} ${findings.length} achado(s) — ${fixes.length} corrigível(is), ${alarms.length} só alarme.`);
  console.log("");

  console.log(dryRun ? "=== CORRIGÍVEIS (dry-run — nada escrito) ===" : "=== CORRIGIDOS ===");
  if (fixes.length === 0) console.log("(nenhum)");
  for (const f of fixes) {
    const result = applied.get(f.issue);
    const status = dryRun ? "dry-run" : result?.ok ? "ok" : `FALHOU: ${result?.error ?? "sem resultado"}`;
    console.log(
      `#${f.issue} — ${f.title} — padrão marker-deferral-conflict, labels removidas [${f.conflictingLabels.join(", ")}], marcador ${f.markerDate}, track ${f.routeTrack} — ${status}`,
    );
    console.log(`  ${f.url}`);
  }

  console.log("");
  console.log("=== SÓ ALARMADOS (exigem contexto — revisão humana) ===");
  if (alarms.length === 0) console.log("(nenhum)");
  for (const a of alarms) {
    if (a.patternId === "marker-deferral-conflict-ambiguous") {
      console.log(
        `#${a.issue} — ${a.title} — padrão ${a.patternId}: marcador ${a.markerDate} + [${a.conflictingLabels.join(", ")}], MAS outras labels roteáveis coexistem [${a.otherRoutableLabels.join(", ")}] — não corrigido automaticamente.`,
      );
    } else if (a.patternId === "marker-wontfix-conflict") {
      console.log(
        `#${a.issue} — ${a.title} — padrão ${a.patternId}: marcador ${a.markerDate} + \`wontfix\` — contradição real, mas NUNCA auto-corrigida: \`wontfix\` ("nunca") é veredito mais forte que a data ("ainda não"), então o candidato a obsoleto é o marcador. Resolver à mão.`,
      );
    } else if (a.patternId === "inherited-block-label") {
      console.log(
        `#${a.issue} — ${a.title} — padrão ${a.patternId}: herda [${a.sharedLabels.join(", ")}] da mãe #${a.parentNumber}.`,
      );
    } else if (a.patternId === "sibling-block-label-inconsistency") {
      const withStr = a.withLabel.map((s) => `#${s.number}`).join(", ");
      const withoutStr = a.withoutLabel.map((s) => `#${s.number}`).join(", ");
      console.log(
        `mãe #${a.parentNumber} — padrão ${a.patternId}: label \`${a.label}\` inconsistente entre filhas — COM: [${withStr}], SEM: [${withoutStr}]. ` +
          `Revisar se o bloqueio é genuinamente por eixo. Se for (decomposição correta), acrescentar ao corpo da #${a.parentNumber}: ` +
          `<!-- sibling-block-reviewed: ${a.label} --> — é o que faz este alarme parar de repetir. Sem isso ele nunca converge a zero.`,
      );
      continue;
    } else {
      console.log(
        `#${a.issue} — ${a.title} — padrão ${a.patternId}: track ${a.execTrack} com ${a.openCheckboxCount} checkbox(es) aberto(s).`,
      );
    }
    console.log(`  ${a.url}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, "dry-run");
  const limit = getIntArg(argv, "limit", { min: 1 }) ?? DEFAULT_LIMIT;

  const issues = fetchOpenBacklog(ROOT, limit);
  if (issues === null) {
    console.error(`${LOG_PREFIX} 'gh issue list' falhou — não avalia, não corrige. Checar 'gh auth status'.`);
    process.exitCode = 1;
    return;
  }

  const now = new Date();
  const findings = evaluateBacklog(issues, now, ROOT);
  const { fixes } = splitFindingsByAction(findings);

  const applied = new Map<number, RouteIssueResult>();
  let hadFailure = false;
  if (!dryRun) {
    for (const fix of fixes) {
      const result = applyFix(fix, ROOT, spawnGhSync, now);
      applied.set(fix.issue, result);
      if (!result.ok) hadFailure = true;
    }
  }

  printReport(findings, applied, dryRun);

  if (hadFailure) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main();
}
