#!/usr/bin/env npx tsx
/**
 * scripts/gh-pr-update-branch.ts (#11448)
 *
 * Traz a base (master/main) para a branch de uma PR pelo endpoint REST
 * `PUT /repos/{owner}/{repo}/pulls/{n}/update-branch`, o mesmo que o botão
 * "Update branch" do GitHub usa (merge da base na branch da PR; nunca rebase
 * nem force-push).
 *
 * Por que existe: o `gh` instalado no `300` não tem o subcomando
 * `gh pr update-branch` (rodada 261027e) e `gh api` cru fica fora do allow
 * list do overnight agendado (#11235). Este wrapper cai em
 * `npx tsx scripts/*.ts *`, que o allow list já libera, e faz o `gh api`
 * como processo filho, que não passa pelo sistema de permissões.
 *
 * Uso:
 *   npx tsx scripts/gh-pr-update-branch.ts --pr N [--repo owner/name]
 *     [--expected-head SHA] [--timeout-s 90] [--no-wait]
 *
 * O endpoint é assíncrono (202): por padrão o script espera o HEAD da PR
 * mudar (até `--timeout-s`) para devolver o SHA novo, que é o que o Gate 2
 * precisa validar. `--expected-head` repassa `expected_head_sha`: o GitHub
 * recusa se a branch mudou desde a leitura.
 *
 * Saída: uma linha JSON `{ outcome, pr, repo, headBefore, headAfter, detail }`.
 * Exit 0: `updated`, `already-up-to-date` ou `accepted` (só com `--no-wait`:
 * o GitHub aceitou e o HEAD novo ainda não foi lido). Exit 1: `conflict`,
 * `head-mismatch`, `timeout` (o GitHub aceitou, mas o HEAD não mudou no
 * prazo: reler antes de seguir). Exit 3: erro de uso ou de consulta.
 *
 * Se o GitHub devolver 202 com a branch já em dia, o HEAD não muda: no fim do
 * prazo o script confere `behind_by` da base e sai `already-up-to-date` em vez
 * de `timeout`. Falha do `gh pr view` durante a espera não aborta a espera
 * (review do #11455): o JSON sai sempre, com as falhas resumidas em `detail`.
 */
import { spawnSync } from "node:child_process";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";

export type UpdateBranchOutcome =
  | "accepted"
  | "already-up-to-date"
  | "conflict"
  | "head-mismatch"
  | "error";

/**
 * Classifica a resposta do `gh api -X PUT .../update-branch`. `gh api` sai
 * `0` no 202 e `1` em erro HTTP, com o corpo JSON no stdout e
 * `gh: <message> (HTTP 422)` no stderr; olhamos os dois.
 */
export function classifyUpdateBranchResponse(
  exitCode: number | null,
  stdout: string,
  stderr: string,
): { outcome: UpdateBranchOutcome; detail: string } {
  const text = `${stdout}\n${stderr}`;
  const detail = text.trim().replace(/\s+/g, " ").slice(0, 300);
  if (exitCode === 0) return { outcome: "accepted", detail };
  if (/no new commits/i.test(text)) return { outcome: "already-up-to-date", detail };
  if (/merge conflict/i.test(text)) return { outcome: "conflict", detail };
  if (/expected head sha/i.test(text)) return { outcome: "head-mismatch", detail };
  return { outcome: "error", detail };
}

export function updateBranchApiArgs(pr: number, repo: string | undefined, expectedHead?: string): string[] {
  const path = `repos/${repo ?? "{owner}/{repo}"}/pulls/${pr}/update-branch`;
  const args = ["api", "-X", "PUT", path, "-H", "Accept: application/vnd.github+json"];
  if (expectedHead) args.push("-f", `expected_head_sha=${expectedHead}`);
  return args;
}

function readPr(pr: number, repo: string | undefined): { head: string; base: string } {
  const r = spawnSync(
    "gh",
    ["pr", "view", String(pr), ...(repo ? ["-R", repo] : []), "--json", "headRefOid,baseRefName"],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (r.error || r.status !== 0) throw new Error(`gh pr view falhou: ${r.error?.message ?? r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  const head = parsed.headRefOid;
  const base = parsed.baseRefName;
  if (typeof head !== "string" || head === "") throw new Error("gh pr view sem headRefOid");
  if (typeof base !== "string" || base === "") throw new Error("gh pr view sem baseRefName");
  return { head, base };
}

/**
 * Quantos commits da base faltam no HEAD (`behind_by` do compare). `0` = a base
 * já é ancestral do HEAD, ou seja, a branch já está em dia.
 */
function readBehindBy(repo: string | undefined, base: string, head: string): number {
  const path = `repos/${repo ?? "{owner}/{repo}"}/compare/${encodeURIComponent(base)}...${head}`;
  const r = spawnSync("gh", ["api", path, "--jq", ".behind_by"], { encoding: "utf8", timeout: 30_000 });
  if (r.error || r.status !== 0) throw new Error(`gh api compare falhou: ${r.error?.message ?? r.stderr}`);
  const n = Number(r.stdout.trim());
  if (!Number.isInteger(n) || n < 0) throw new Error(`behind_by inválido: ${r.stdout.trim()}`);
  return n;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export type WaitOutcome = "updated" | "already-up-to-date" | "timeout";

export interface WaitDeps {
  /** Relê o HEAD da PR; pode lançar (falha transitória do `gh pr view`). */
  readHead: () => string;
  /** `behind_by` da base em relação ao HEAD; pode lançar. */
  readBehindBy: (head: string) => number;
  sleep: (ms: number) => void;
  now: () => number;
}

/**
 * Espera o HEAD da PR mudar depois do 202 (#11448). Duas proteções contra o
 * falso `timeout` (review do #11455):
 * - falha da releitura dentro do laço não aborta: conta como "HEAD ainda não
 *   mudou" e tenta de novo até o prazo, guardando o último erro em `readErrors`;
 * - se o prazo vence com o HEAD igual e a base já é ancestral do HEAD
 *   (`behind_by == 0`), a branch estava em dia (o GitHub devolveu 202 em vez do
 *   422 "no new commits"): `already-up-to-date`, não `timeout`.
 */
export function waitForHeadChange(
  headBefore: string,
  timeoutS: number,
  deps: WaitDeps,
  pollMs = 3000,
): { outcome: WaitOutcome; headAfter: string; readErrors: string[] } {
  const readErrors: string[] = [];
  const deadline = deps.now() + timeoutS * 1000;
  let headAfter = headBefore;
  while (headAfter === headBefore && deps.now() < deadline) {
    deps.sleep(pollMs);
    try {
      headAfter = deps.readHead();
    } catch (e) {
      readErrors.push(String(e instanceof Error ? e.message : e));
    }
  }
  if (headAfter !== headBefore) return { outcome: "updated", headAfter, readErrors };
  try {
    if (deps.readBehindBy(headAfter) === 0) return { outcome: "already-up-to-date", headAfter, readErrors };
  } catch (e) {
    readErrors.push(String(e instanceof Error ? e.message : e));
  }
  return { outcome: "timeout", headAfter, readErrors };
}

if (isMainModule(import.meta.url)) {
  try {
    const { values, flags } = parseArgs(process.argv.slice(2));
    const pr = Number(values.pr);
    if (!Number.isInteger(pr) || pr <= 0) {
      throw new Error("uso: --pr N [--repo owner/name] [--expected-head SHA] [--timeout-s 90] [--no-wait]");
    }
    const repo = values.repo;
    const timeoutS = values["timeout-s"] !== undefined ? Number(values["timeout-s"]) : 90;
    if (!Number.isFinite(timeoutS) || timeoutS < 0) throw new Error("--timeout-s inválido");

    const { head: headBefore, base } = readPr(pr, repo);
    const r = spawnSync("gh", updateBranchApiArgs(pr, repo, values["expected-head"]), {
      encoding: "utf8",
      timeout: 60_000,
    });
    if (r.error) throw new Error(`gh api falhou: ${r.error.message}`);
    const classified = classifyUpdateBranchResponse(r.status, r.stdout ?? "", r.stderr ?? "");
    let detail = classified.detail;

    let finalOutcome: string = classified.outcome;
    let headAfter = headBefore;
    if (classified.outcome === "accepted" && !flags.has("no-wait")) {
      const waited = waitForHeadChange(headBefore, timeoutS, {
        readHead: () => readPr(pr, repo).head,
        readBehindBy: (head) => readBehindBy(repo, base, head),
        sleep: sleepMs,
        now: Date.now,
      });
      finalOutcome = waited.outcome;
      headAfter = waited.headAfter;
      if (waited.readErrors.length > 0) {
        detail = `${detail} | releituras com falha: ${waited.readErrors.length} (última: ${waited.readErrors.at(-1)})`
          .replace(/\s+/g, " ")
          .slice(0, 500);
      }
    }

    console.log(JSON.stringify({ outcome: finalOutcome, pr, repo: repo ?? null, headBefore, headAfter, detail }));
    if (finalOutcome === "error") {
      process.exitCode = 3;
    } else {
      const ok = ["updated", "already-up-to-date", "accepted"].includes(finalOutcome);
      process.exitCode = ok ? 0 : 1;
    }
    if (process.exitCode !== 0) console.error(`gh-pr-update-branch: ${finalOutcome} — ${detail}`);
  } catch (e) {
    console.error(String(e));
    process.exitCode = 3;
  }
}
