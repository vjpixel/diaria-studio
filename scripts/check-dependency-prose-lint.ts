#!/usr/bin/env npx tsx
/**
 * check-dependency-prose-lint.ts (#7137 item 4)
 *
 * CLI de AUDITORIA (nunca gate — ver docstring de
 * `scripts/lib/dependency-prose-lint.ts` pro porquê) sobre o backlog
 * aberto: reporta issues que citam prosa de dependência ("pré-requisito",
 * "depende do #N", "depois que #N", "só depois") sem carregar o marcador
 * `<!-- depends-on: #N -->` (`scripts/lib/issue-depends-on.ts`).
 *
 * Sempre sai com `exit 0` — nunca bloqueia a rodada (a correção de um
 * achado exige julgamento humano sobre qual issue é a dependência real, ou
 * se é falso positivo; ver a lib pro racional completo). `gh` indisponível
 * → fail-soft (#738): warning em stderr, `exit 0`.
 *
 * Uso:
 *   npx tsx scripts/check-dependency-prose-lint.ts
 *   npx tsx scripts/check-dependency-prose-lint.ts --limit 100
 *
 * @see scripts/lib/dependency-prose-lint.ts (lógica pura + racional completo)
 * @see scripts/lib/issue-depends-on.ts (marcador que este lint cobra a ausência de)
 * @see context/overnight-dispatch-rules.md item 26 (onde o coordenador roda isto)
 */

import { spawnSync } from "node:child_process";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { detectDependencyProseWithoutMarker, type DependencyProseFinding } from "./lib/dependency-prose-lint.ts";

interface GhIssueListItem {
  number: number;
  body?: string;
}

interface FetchOpenIssuesResult {
  issues: GhIssueListItem[];
  error?: string;
}

const DEFAULT_ISSUE_LIMIT = 200;

/** Busca issues abertas (número + corpo) via `gh issue list` — fail-soft. */
export function fetchOpenIssues(cwd: string, limit: number): FetchOpenIssuesResult {
  const result = spawnSync(
    "gh",
    ["issue", "list", "--state", "open", "--json", "number,body", "--limit", String(limit)],
    { cwd, encoding: "utf8", timeout: 30_000 },
  );
  if (result.error) {
    return { issues: [], error: `gh não pôde ser executado: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    return { issues: [], error: `gh issue list saiu com status ${result.status}${stderr ? `: ${stderr}` : ""}` };
  }
  if (!result.stdout) {
    return { issues: [], error: "gh issue list retornou stdout vazio" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    return { issues: [], error: `JSON malformado de gh issue list: ${(e as Error).message}` };
  }
  if (!Array.isArray(parsed)) {
    return { issues: [], error: "gh issue list retornou payload que não é um array" };
  }
  return { issues: parsed as GhIssueListItem[] };
}

function fmtFinding(f: DependencyProseFinding): string {
  return `#${f.issueNumber}\t${f.patternId}\t${f.description}\t${f.excerpt}`;
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const limit = values.limit ? Number.parseInt(values.limit, 10) : DEFAULT_ISSUE_LIMIT;
  const cwd = process.cwd();

  const fetched = fetchOpenIssues(cwd, limit);
  if (fetched.error) {
    console.error(
      `[check-dependency-prose-lint] gh indisponível — pulando checagem (fail-soft, #738): ${fetched.error}`,
    );
    process.exit(0);
  }

  const findings = detectDependencyProseWithoutMarker(
    fetched.issues.map((i) => ({ number: i.number, body: i.body ?? null })),
  );

  if (findings.length === 0) {
    console.log("ok — nenhuma issue aberta cita prosa de dependência sem marcador depends-on:");
    process.exit(0);
  }

  console.log(
    `check-dependency-prose-lint: ${findings.length} issue(s) citam prosa de dependência sem marcador depends-on: (auditoria, não bloqueia).`,
  );
  console.log("");
  console.log("issue\tpadrão\tdescrição\ttrecho");
  for (const f of findings) {
    console.log(fmtFinding(f));
  }
  console.log("");
  console.log(
    "Se for dependência genuína, adicionar `<!-- depends-on: #N -->` no corpo (scripts/reconcile-issue-dependencies.ts assume dali em diante). Se for falso positivo, ignorar.",
  );

  process.exit(0);
}
