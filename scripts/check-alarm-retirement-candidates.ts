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
  parseGithubStateReason,
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
export interface GhApiIssueRow {
  number: number;
  title: string;
  body: string | null;
  state_reason: string | null;
  closed_at: string | null;
  pull_request?: unknown;
}

/**
 * Pura — parseia o array bruto devolvido por `gh api .../issues` (REST, ver
 * `GhApiIssueRow`), filtra pull requests (o endpoint mistura issues e PRs) e
 * normaliza `state_reason` via `parseGithubStateReason`. Extraída do
 * `spawnSync` pra ser testável com fixture, sem processo filho nem rede —
 * finding P1 do fleet review (PR #7049): o bug de casing que a normalização
 * abaixo corrige (achado no self-review original desta PR, ver histórico do
 * commit) não tinha NENHUM teste cobrindo este caminho — só a lógica pura
 * downstream, com fixtures já normalizadas, que não pega regressão aqui.
 * Um `JSON.parse` malformado propaga a exceção pro caller (`fetchClosedAlarmIssues`
 * decide o que fazer com ela).
 */
export function parseGhApiIssueRows(raw: string): ClosedAlarmIssueRecord[] {
  const rows = JSON.parse(raw) as GhApiIssueRow[];
  return rows
    .filter((r) => !("pull_request" in r))
    .map((r) => ({
      number: r.number,
      title: r.title,
      body: r.body ?? "",
      stateReason: parseGithubStateReason(r.state_reason),
      closedAt: r.closed_at ?? null,
    }));
}

/** Resultado discriminado de `fetchClosedAlarmIssues` — substitui o antigo
 * `T[] | null` (finding P2 do fleet review, PR #7049): `null` sozinho
 * descartava o diagnóstico real (stderr do `gh`, erro de spawn, mensagem da
 * exceção de parse) e o caller imprimia sempre a mesma frase genérica
 * chutando 5 causas possíveis. `reason` carrega o sinal de verdade. */
type FetchClosedAlarmIssuesResult =
  | { ok: true; data: ClosedAlarmIssueRecord[] }
  | { ok: false; reason: string };

/** Busca todas as issues FECHADAS com a label `alarm` — fail-soft: `gh`
 * indisponível/rate-limited/JSON malformado devolve `{ ok: false, reason }`
 * (nunca lista vazia fabricada, que pareceria "nenhum candidato" em vez de
 * "não sei") com o diagnóstico real, não um chute genérico.
 * `--paginate` percorre todas as páginas (o backlog de alarme já passou de
 * 100 issues fechadas na auditoria original do #6798 — um único `per_page`
 * não bastaria) e o `gh` moderno concatena as páginas num único array JSON
 * válido no stdout. `maxBuffer` explícito: as 117 issues fechadas atuais já
 * produzem 626KB de JSON (medido no fleet review, PR #7049) contra o
 * default de 1MB do Node — o backlog só cresce, então sobe a folga antes de
 * estourar em silêncio, não depois. */
function fetchClosedAlarmIssues(cwd: string): FetchClosedAlarmIssuesResult {
  const res = spawnSync(
    "gh",
    [
      "api",
      "--paginate",
      `/repos/{owner}/{repo}/issues?state=closed&labels=${encodeURIComponent(ALARM_LABEL)}&per_page=100`,
    ],
    { cwd, encoding: "utf8", timeout: 45_000, maxBuffer: 10 * 1024 * 1024 },
  );
  if (res.error) return { ok: false, reason: res.error.message };
  if (res.status !== 0) {
    return { ok: false, reason: res.stderr?.trim() || `gh saiu com status ${res.status}` };
  }
  try {
    return { ok: true, data: parseGhApiIssueRows(res.stdout) };
  } catch (e) {
    return { ok: false, reason: `JSON malformado: ${(e as Error).message}` };
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

  const fetchResult = fetchClosedAlarmIssues(process.cwd());
  if (!fetchResult.ok) {
    console.error(`${LOG_PREFIX} gh issue list falhou — sem dado pra avaliar. Motivo: ${fetchResult.reason}`);
    process.exit(0);
  }
  const closedIssues = fetchResult.data;

  // Finding P2 do fleet review (PR #7049): se o parse não reconhecer um
  // `stateReason`, ele vira "UNKNOWN" (nunca silêncio, ver
  // `parseGithubStateReason`) — mas UNKNOWN só é útil como rede de proteção
  // se aparecer. Foi só a contagem estranha ("0 candidatos com 19
  // not_planned reais") que expôs o bug de casing original; o próximo bug
  // da mesma classe precisa se denunciar sozinho.
  const unknownCount = closedIssues.filter((i) => i.stateReason === "UNKNOWN").length;
  if (unknownCount > 0) {
    console.error(
      `${LOG_PREFIX} ${unknownCount} issue(s) com stateReason não-reconhecido (UNKNOWN) — fora da contagem de "sem ação"; investigar se é um caso legítimo (issue reaberta/refechada sem reason) ou uma regressão de parse.`,
    );
  }

  const candidates = findAlarmRetirementCandidates(closedIssues, threshold);
  if (asJson) {
    console.log(JSON.stringify(candidates, null, 2));
  } else {
    printReport(candidates, threshold);
  }
  process.exit(0);
}
