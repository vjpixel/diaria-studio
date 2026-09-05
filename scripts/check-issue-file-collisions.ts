#!/usr/bin/env npx tsx
/**
 * scripts/check-issue-file-collisions.ts (#7137, item 3)
 *
 * "Versão de tempo-de-plano" de `session-registry.ts conflicts --paths`
 * (que responde "quem mais está mexendo nisto AGORA" pra sessões em voo):
 * este script varre as issues ABERTAS do backlog, extrai os paths de
 * arquivo que cada uma já lista no corpo (convenção do #7112 — issues-
 * filhas listam caminhos concretos na seção "Escopo"), e reporta pares que
 * colidiriam se ambas fossem implementadas em paralelo. Lógica pura em
 * `scripts/lib/issue-file-collisions.ts`.
 *
 * **DERIVA, não DECLARA** (item 3 da #7137) — ninguém precisa marcar
 * manualmente "issue A colide com issue B"; a colisão sai do texto que a
 * issue já tem. Declaração apodrece (#7137 mediu isso 2x só nesta issue:
 * "10 entradas DECLARADA, NÃO ARMADA" viraram prosa vencida, e a própria
 * #7137 original errou 2 afirmações por falta de acesso ao servidor);
 * derivação, não.
 *
 * É RELATÓRIO — nunca bloqueia (`exit 0` sempre, mesmo com colisões
 * encontradas ou `gh` indisponível). **Fail-soft por desenho, não o #738**:
 * o #738 é sobre halt-banner + parada explícita quando um MCP cai no MEIO de
 * um stage do pipeline (o oposto de silencioso); aqui o `gh` indisponível é
 * um sinal fraco de auditoria opcional, então o comportamento correto é o
 * inverso — logar e seguir sem alarme, mesmo padrão de
 * `check-dependency-prose-lint.ts` (#7137 item 4). A decisão de serializar
 * ou fundir 2 issues em 1 PR (mesma família do `#4319` no `/diaria-develop`)
 * é de quem despacha o trabalho, não deste script.
 *
 * Uso:
 *   npx tsx scripts/check-issue-file-collisions.ts
 *   npx tsx scripts/check-issue-file-collisions.ts --json
 *   npx tsx scripts/check-issue-file-collisions.ts --limit 300
 *
 * @see scripts/lib/issue-file-collisions.ts (lógica pura + racional completo)
 * @see scripts/lib/session-registry.ts (`findSessionConflicts` — irmão em tempo-de-execução)
 */

import { spawnSync } from "node:child_process";
import { isMainModule, parseArgs, hasFlag } from "./lib/cli-args.ts";
import {
  extractFilePathsFromIssueBody,
  computeIssueFileCollisions,
  type IssueWithPaths,
} from "./lib/issue-file-collisions.ts";

interface GhIssueListItem {
  number: number;
  title?: string;
  body?: string;
}

interface FetchOpenIssuesResult {
  issues: GhIssueListItem[];
  error?: string;
}

const DEFAULT_ISSUE_LIMIT = 200;
const LOG_PREFIX = "[check-issue-file-collisions]";

/** Busca issues abertas (número + título + corpo) via `gh issue list` —
 * fail-soft, mesmo padrão de `check-dependency-prose-lint.ts` (#7137 item 4). */
export function fetchOpenIssues(cwd: string, limit: number): FetchOpenIssuesResult {
  const result = spawnSync(
    "gh",
    ["issue", "list", "--state", "open", "--json", "number,title,body", "--limit", String(limit)],
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

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const limit = values.limit ? Number.parseInt(values.limit, 10) : DEFAULT_ISSUE_LIMIT;
  const cwd = process.cwd();
  const asJson = hasFlag(process.argv.slice(2), "json");

  const fetched = fetchOpenIssues(cwd, limit);
  if (fetched.error) {
    console.error(`${LOG_PREFIX} gh indisponível — pulando checagem (fail-soft por desenho, não #738): ${fetched.error}`);
    process.exit(0);
  }

  if (fetched.issues.length >= limit) {
    console.error(
      `${LOG_PREFIX} AVISO: ${fetched.issues.length} issue(s) retornada(s) == --limit (${limit}) — ` +
        `possível truncamento silencioso do backlog real. Rode com --limit maior pra confirmar cobertura total.`,
    );
  }

  const issuesWithPaths: IssueWithPaths[] = fetched.issues.map((i) => ({
    number: i.number,
    title: i.title,
    paths: extractFilePathsFromIssueBody(i.body),
  }));

  const collisions = computeIssueFileCollisions(issuesWithPaths);

  if (asJson) {
    console.log(JSON.stringify({ issues_checked: issuesWithPaths.length, collisions }, null, 2));
  } else {
    console.log(
      `${LOG_PREFIX} ${issuesWithPaths.length} issue(s) aberta(s) verificada(s), ${collisions.length} colisão(ões) de arquivo encontrada(s).`,
    );
    for (const c of collisions) {
      console.log(
        `${LOG_PREFIX} #${c.a.number} × #${c.b.number} — ${c.paths.length} path(s) em comum: ${c.paths.join(", ")}`,
      );
    }
    if (collisions.length > 0) {
      console.log(
        `${LOG_PREFIX} decisão de serializar/fundir é de quem despacha (ex: worktrees concorrentes de ` +
          `/diaria-develop, #4319) — este script só reporta, nunca bloqueia.`,
      );
    }
  }

  process.exit(0);
}
