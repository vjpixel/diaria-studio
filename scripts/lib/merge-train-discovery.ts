/**
 * merge-train-discovery.ts (#6300)
 *
 * Descoberta de candidatos ao trem — compartilhada entre o planejador
 * read-only (`scripts/plan-merge-train.ts`) e o executor vivo
 * (`scripts/run-merge-train.ts`). Extraído de `plan-merge-train.ts`
 * quando o executor vivo nasceu, pra não duplicar `runGh`/`isGateOneGreen`/
 * `discoverOpenPrs`/`parsePrsArg` entre os dois CLIs.
 */

import { spawnSync } from "node:child_process";
import { evaluatePrChecksGate, isPrChecksGateGreen } from "./pr-checks-gate.ts";

export interface RunResult {
  ok: boolean;
  stdout: string;
  error?: string;
}

export function runGh(args: string[], cwd: string): RunResult {
  const result = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error) return { ok: false, stdout: "", error: result.error.message };
  if (result.status !== 0) {
    return { ok: false, stdout: "", error: (result.stderr || result.stdout || `exit ${result.status}`).trim() };
  }
  return { ok: true, stdout: result.stdout };
}

/** Lista arquivos tocados por um PR, via `gh pr diff N --name-only`. */
export function filesForPr(prNumber: number, cwd: string): string[] {
  const res = runGh(["pr", "diff", String(prNumber), "--name-only"], cwd);
  if (!res.ok) {
    throw new Error(`gh pr diff --name-only falhou pro PR #${prNumber}: ${res.error}`);
  }
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Condição 1 do Gate 2 (mesma lógica de `scripts/check-pr-checks-gate.ts`,
 * duplicada aqui em vez de importada porque `fetchPrChecksGate` não é
 * exportada de lá — CLI dedicado, não módulo de biblioteca). Não checa a
 * condição 2 (threads resolvidas) — isso exige `gh api graphql`, fora do
 * escopo da descoberta; quem for EXECUTAR o trem revalida as duas
 * condições de novo antes de mergear qualquer PR individual, mesmo padrão
 * do Gate 2 de sempre.
 */
export function isGateOneGreen(prNumber: number, cwd: string): boolean {
  const res = runGh(["pr", "view", String(prNumber), "--json", "statusCheckRollup"], cwd);
  if (!res.ok) return false; // erro de gh = não verde, nunca "assume verde"
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return false;
  }
  const rollup =
    typeof parsed === "object" && parsed !== null && "statusCheckRollup" in parsed
      ? (parsed as { statusCheckRollup: unknown }).statusCheckRollup
      : undefined;
  return isPrChecksGateGreen(evaluatePrChecksGate(rollup));
}

// `gh pr list` sem `--limit` usa o default de 30 (achado do fleet review,
// PR #6361) — silenciosamente truncaria `--open` em qualquer repo com mais
// de 30 PRs abertos, exatamente o cenário que a issue #6300 mede ao vivo
// ("rajada de merges com 4 sessões ativas"). 500 é folga generosa; se
// algum dia isso não bastar, `discoverOpenPrs` avisa (ver abaixo) em vez
// de truncar em silêncio.
const OPEN_PR_LIST_LIMIT = 500;

/**
 * Descoberta de PRs candidatos quando `--open` é passado em vez de `--prs`
 * explícito: todo PR aberto cujo Gate 2 condição 1 é `"pass"` (via
 * `isGateOneGreen`, 1 chamada `gh pr view` por PR aberto — aceitável pra
 * uso sob demanda, não num loop apertado).
 */
export function discoverOpenPrs(cwd: string, logPrefix: string): number[] {
  const res = runGh(["pr", "list", "--state", "open", "--json", "number", "--limit", String(OPEN_PR_LIST_LIMIT)], cwd);
  if (!res.ok) {
    throw new Error(`gh pr list falhou: ${res.error}`);
  }
  const parsed: unknown = JSON.parse(res.stdout);
  if (!Array.isArray(parsed)) throw new Error("gh pr list devolveu formato inesperado (não é array)");

  if (parsed.length === OPEN_PR_LIST_LIMIT) {
    console.error(
      `${logPrefix}: gh pr list retornou exatamente o limite (${OPEN_PR_LIST_LIMIT}) — pode haver mais PRs ` +
        `abertos não listados. Use --prs explícito se precisar do conjunto completo.`,
    );
  }

  const numbers: number[] = [];
  let malformed = 0;
  for (const p of parsed) {
    const n = typeof p === "object" && p !== null && "number" in p ? Number((p as { number: unknown }).number) : NaN;
    if (Number.isFinite(n)) numbers.push(n);
    else malformed++;
  }
  if (malformed > 0) {
    console.error(`${logPrefix}: gh pr list devolveu ${malformed} entrada(s) sem "number" válido — ignoradas.`);
  }

  return numbers.filter((n) => isGateOneGreen(n, cwd));
}

/**
 * Parseia `--prs N,M,...` FALHANDO ALTO no primeiro token inválido em vez
 * de filtrar em silêncio (achado do fleet review, PR #6361 — um typo como
 * `634l` por `6341` desaparecia da lista sem nenhum sinal, e o operador só
 * descobriria relendo o plano impresso e notando uma ausência).
 */
export function parsePrsArg(raw: string): number[] {
  const tokens = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const invalid: string[] = [];
  const numbers: number[] = [];
  for (const t of tokens) {
    const n = Number(t);
    if (Number.isFinite(n)) numbers.push(n);
    else invalid.push(t);
  }
  if (invalid.length > 0) {
    throw new Error(`--prs contém valor(es) inválido(s): ${invalid.map((t) => `"${t}"`).join(", ")}`);
  }
  return numbers;
}
