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

/** Linha crua devolvida pela REST API `GET /issues` (via `gh api`) — usada
 * em vez de `gh issue list --json` porque `stateReason` NÃO é um campo
 * suportado por `--json` nesta versão do `gh` (confirmado ao vivo: `gh api`
 * REST devolve `state_reason`, mas `gh issue list --json stateReason` sai
 * `Unknown JSON field: "stateReason"` — a GraphQL-backed `--json` do `gh
 * issue list` não expõe esse campo, só a REST clássica expõe). O endpoint
 * `/issues` do repo devolve issues E pull requests juntos — `pull_request`
 * só existe na entrada quando é um PR, daí o filtro abaixo. */
interface GhApiIssueRow {
  number: number;
  title: string;
  body: string | null;
  state_reason: string | null;
  closed_at: string | null;
  pull_request?: unknown;
}

/** Busca todas as issues FECHADAS com a label `alarm` — fail-soft: `gh`
 * indisponível/rate-limited/JSON malformado devolve `null` (nunca lista
 * vazia fabricada, que pareceria "nenhum candidato" em vez de "não sei").
 * `--paginate` percorre todas as páginas (o backlog de alarme já passou de
 * 100 issues fechadas na auditoria original do #6798 — um único `per_page`
 * não bastaria) e o `gh` moderno concatena as páginas num único array JSON
 * válido no stdout. */
function fetchClosedAlarmIssues(cwd: string): ClosedAlarmIssueRecord[] | null {
  const res = spawnSync(
    "gh",
    [
      "api",
      "--paginate",
      `/repos/{owner}/{repo}/issues?state=closed&labels=${encodeURIComponent(ALARM_LABEL)}&per_page=100`,
    ],
    { cwd, encoding: "utf8", timeout: 45_000 },
  );
  if (res.status !== 0) return null;
  try {
    const rows = JSON.parse(res.stdout) as GhApiIssueRow[];
    return rows
      .filter((r) => !("pull_request" in r))
      .map((r) => ({
        number: r.number,
        title: r.title,
        body: r.body ?? "",
        // REST devolve `state_reason` em minúsculas ("not_planned",
        // "completed", "duplicate") — normalizado pra MAIÚSCULAS aqui
        // porque `alarm-retirement-candidates.ts` (e a docstring de
        // `closeAlarmIssue` em `alarm-issues.ts`, que este módulo cita)
        // descreve o valor na convenção GraphQL (`NOT_PLANNED`). Achado ao
        // vivo (self-review desta PR): sem esta normalização, o critério
        // nunca casava com dado real — 19 issues `not_planned` no repo no
        // momento desta PR, 0 candidatos detectados até a correção.
        stateReason: r.state_reason ? r.state_reason.toUpperCase() : null,
        closedAt: r.closed_at ?? null,
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
