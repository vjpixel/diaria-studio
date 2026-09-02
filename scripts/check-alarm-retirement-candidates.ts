#!/usr/bin/env npx tsx
/**
 * scripts/check-alarm-retirement-candidates.ts (#6798)
 *
 * CLI do mecanismo de auto-aposentadoria de alarme — ver
 * `scripts/lib/alarm-retirement-candidates.ts` pra lógica pura, o critério
 * de "disparou sem gerar ação" e a limitação assumida. Este arquivo só busca
 * as issues fechadas com a label `alarm` via `gh issue list`, passa pra
 * lógica pura, e imprime o relatório.
 *
 * É RELATÓRIO, não gate — nunca aposenta nada sozinho, e sempre sai 0
 * (mesmo com candidatos encontrados, mesmo se `gh` falhar). A decisão de
 * cortar um alarme candidato é do editor.
 *
 * Uso:
 *   npx tsx scripts/check-alarm-retirement-candidates.ts [--threshold N] [--json]
 *
 *   --threshold N  override do limiar (default: ALARM_RETIREMENT_THRESHOLD, 3).
 *   --json         imprime o array de candidatos como JSON em vez da tabela
 *                   legível (consumo programático — mesmo padrão de
 *                   `scripts/lib/scheduled-tasks.ts --json`).
 */
import { spawnSync } from "node:child_process";
import { hasFlag, getIntArg, isMainModule } from "./lib/cli-args.ts";
import { ALARM_LABEL } from "./lib/alarm-issues.ts";
import {
  findAlarmRetirementCandidates,
  ALARM_RETIREMENT_THRESHOLD,
  type ClosedAlarmIssueRecord,
} from "./lib/alarm-retirement-candidates.ts";

const LOG_PREFIX = "[check-alarm-retirement-candidates]";

interface GhIssueListRow {
  number: number;
  title: string;
  body: string | null;
  stateReason: string | null;
  closedAt: string | null;
}

/** Busca todas as issues FECHADAS com a label `alarm` — fail-soft: `gh`
 * indisponível/rate-limited/JSON malformado devolve `null` (nunca lista
 * vazia fabricada, que pareceria "nenhum candidato" em vez de "não sei"). */
function fetchClosedAlarmIssues(cwd: string): ClosedAlarmIssueRecord[] | null {
  const res = spawnSync(
    "gh",
    [
      "issue",
      "list",
      "--state",
      "closed",
      "--label",
      ALARM_LABEL,
      "--json",
      "number,title,body,stateReason,closedAt",
      "--limit",
      "500",
    ],
    { cwd, encoding: "utf8", timeout: 30_000 },
  );
  if (res.status !== 0) return null;
  try {
    const rows = JSON.parse(res.stdout) as GhIssueListRow[];
    return rows.map((r) => ({
      number: r.number,
      title: r.title,
      body: r.body ?? "",
      stateReason: r.stateReason ?? null,
      closedAt: r.closedAt ?? null,
    }));
  } catch {
    return null;
  }
}

function printReport(candidates: ReturnType<typeof findAlarmRetirementCandidates>, threshold: number): void {
  if (candidates.length === 0) {
    console.log(`${LOG_PREFIX} nenhum alarme com >= ${threshold} issues fechadas sem ação (stateReason=NOT_PLANNED).`);
    return;
  }
  console.log(`${LOG_PREFIX} ${candidates.length} alarme(s) candidato(s) a aposentadoria (limiar N=${threshold}):\n`);
  for (const c of candidates) {
    console.log(`  ${c.check} — ${c.noActionCount} issues sem ação:`);
    for (const e of c.evidence) {
      console.log(`    #${e.issueNumber} "${e.title}" (fechada ${e.closedAt ?? "data desconhecida"})`);
    }
    console.log("");
  }
  console.log(`${LOG_PREFIX} isto é relatório, não gate — decisão de cortar continua do editor.`);
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const asJson = hasFlag(argv, "json");

  let threshold = ALARM_RETIREMENT_THRESHOLD;
  try {
    threshold = getIntArg(argv, "threshold", { min: 1 }) ?? ALARM_RETIREMENT_THRESHOLD;
  } catch (e) {
    // Relatório, nunca gate — mesmo --threshold inválido só vira aviso +
    // fallback pro default, nunca process.exit(1).
    console.error(`${LOG_PREFIX} ${(e as Error).message} — usando default (${ALARM_RETIREMENT_THRESHOLD}).`);
  }

  const closedIssues = fetchClosedAlarmIssues(process.cwd());
  if (closedIssues === null) {
    console.error(`${LOG_PREFIX} gh issue list falhou (offline, não autenticado, ou rate limit) — sem dado pra avaliar.`);
    process.exit(0);
  }

  const candidates = findAlarmRetirementCandidates(closedIssues, threshold);
  if (asJson) {
    console.log(JSON.stringify(candidates, null, 2));
  } else {
    printReport(candidates, threshold);
  }
  process.exit(0);
}
