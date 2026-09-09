/**
 * scripts/lib/gh-open-pr-fetch.ts (#7788)
 *
 * Único ponto do repo que busca "quais PRs abertas existem, com título,
 * corpo, branch, autor, `updatedAt` e `statusCheckRollup`" pro preflight de
 * PR aberta (`scripts/lib/issue-open-pr-check.ts`). 1 chamada `gh pr list`
 * cobre a lista inteira — não pagina por issue, porque o custo que este
 * módulo existe pra evitar é justamente o de um subagente inteiro, não o
 * de uma 2ª chamada `gh`.
 *
 * Fail-soft na FORMA (nunca lança — `gh` ausente, sem auth, timeout, JSON
 * malformado viram `{ prs: [], error }`), mas **NUNCA fail-soft no
 * SIGNIFICADO**: o chamador (`scripts/check-issue-open-pr.ts`) trata
 * `error` presente como veredito `"cannot-verify"`, nunca como "nenhuma PR
 * aberta" — é essa distinção que o #7788 exige (regra inegociável: falha
 * de consulta nunca vira sinal verde, mesma classe do #7776). Diferente de
 * `master-commit-fetch.ts`, que aceita "sem indício" como degradação
 * aceitável do fetch de commits (o item 14, preflight do subagente, ainda
 * pega o resíduo) — aqui não há rede de segurança equivalente: um
 * `cannot-verify` tratado como `no-open-pr` reintroduziria o desperdício
 * em silêncio.
 *
 * @see scripts/lib/issue-open-pr-check.ts (lógica pura de veredito)
 * @see scripts/check-issue-open-pr.ts (CLI)
 */

import { spawnSync } from "node:child_process";
import type { OpenPrInfo } from "./issue-open-pr-check.ts";

export interface FetchOpenPrsResult {
  prs: OpenPrInfo[];
  error?: string;
}

/** Resultado mínimo de um executor de comando — o shape que
 * `node:child_process.spawnSync` já devolve, reduzido ao que este módulo
 * usa. Permite injetar um executor falso nos testes (#7788: "nos testes,
 * injete o executor de gh, não bata na API real") sem depender de mock de
 * módulo. */
export interface CommandRunnerResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type CommandRunner = (cmd: string, args: string[], opts: { cwd: string }) => CommandRunnerResult;

const defaultRunner: CommandRunner = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: (r.stderr ?? "").toString(), error: r.error };
};

const JSON_FIELDS = "number,title,body,headRefName,author,updatedAt,statusCheckRollup";

/**
 * Busca todas as PRs abertas do repo (limite alto — 300 — porque este
 * repo já teve dezenas abertas simultaneamente em rodada `continuo`/
 * `develop` de lote paralelo; um limite baixo reintroduziria um falso
 * `no-open-pr` por paginação silenciosa).
 *
 * `runner` é injetável (default: `spawnSync` real) — único ponto de I/O
 * deste módulo, pra permitir teste determinístico sem bater na API do
 * GitHub.
 */
export function fetchOpenPrs(cwd: string, runner: CommandRunner = defaultRunner): FetchOpenPrsResult {
  const result = runner("gh", ["pr", "list", "--state", "open", "--json", JSON_FIELDS, "--limit", "300"], { cwd });
  if (result.error) {
    return { prs: [], error: `gh não pôde ser executado: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    return { prs: [], error: `gh pr list saiu com status ${result.status}${stderr ? `: ${stderr}` : ""}` };
  }
  const stdout = result.stdout ?? "";
  if (!stdout.trim()) {
    return { prs: [], error: "gh pr list retornou stdout vazio" };
  }
  try {
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) {
      return { prs: [], error: "gh pr list retornou JSON que não é array" };
    }
    return { prs: parsed as OpenPrInfo[] };
  } catch (e) {
    return { prs: [], error: `JSON malformado de gh pr list: ${(e as Error).message}` };
  }
}
