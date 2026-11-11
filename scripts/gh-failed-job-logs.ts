#!/usr/bin/env npx tsx
/**
 * scripts/gh-failed-job-logs.ts (#12733)
 *
 * Imprime o fim do log de cada job que falhou numa run do GitHub Actions,
 * lendo pelo REST (`GET /repos/{owner}/{repo}/actions/jobs/{id}/logs`).
 *
 * Por que existe: no `300`, o `gh` instalado (2.46.0) devolve ZERO linhas em
 * `gh run view --log-failed` e em `gh run view --job J --log`, para qualquer
 * job, inclusive com a run concluída e o log disponível no GitHub (medido em
 * 10/11/2026 na run 42874610549: os 5 jobs testados vieram vazios, e o REST
 * devolveu o log inteiro do job que falhou). Foi isso que fez o vermelho do
 * job Shell tests na PR #12717 parecer "sem log recuperável": o log existia,
 * o cliente é que não lia. `gh api` cru fica fora do allow list do overnight
 * agendado (#11235); este wrapper cai em `npx tsx scripts/*.ts *`, já
 * liberado, e chama o `gh api` como processo filho.
 *
 * Uso:
 *   npx tsx scripts/gh-failed-job-logs.ts --run R [--attempt A] [--job J]
 *     [--repo owner/name] [--tail 100]
 *
 * Sem `--job`, lista os jobs da run (da tentativa `--attempt`, ou da última)
 * e imprime os que terminaram `failure`/`timed_out`. `--tail` limita as
 * linhas por job (padrão 100, `0` = log inteiro), contadas antes da limpeza
 * pós-job do runner, que fica de fora.
 *
 * Exit 0: imprimiu ao menos um log. Exit 1: nenhum job com falha na run (ou
 * na tentativa pedida). Exit 3: erro de uso ou de consulta (o log de algum
 * job não veio; a mensagem diz qual).
 */
import { spawnSync } from "node:child_process";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";

export interface RunJob {
  id: number;
  name: string;
  conclusion: string | null;
}

/**
 * Conclusões de job que contam como falha a investigar. `cancelled` fica de
 * fora de propósito: job cancelado por concorrência ou à mão não é falha, e o
 * cancelado por `timeout-minutes` já vem `timed_out`. Para ler o log de um job
 * qualquer, seja qual for a conclusão, use `--job J`.
 */
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out"]);

export function jobsApiPath(run: number, repo: string | undefined, attempt?: number): string {
  const base = `repos/${repo ?? "{owner}/{repo}"}/actions/runs/${run}`;
  return attempt !== undefined ? `${base}/attempts/${attempt}/jobs?per_page=100` : `${base}/jobs?per_page=100`;
}

export function jobLogApiPath(job: number, repo: string | undefined): string {
  return `repos/${repo ?? "{owner}/{repo}"}/actions/jobs/${job}/logs`;
}

/** Lê a resposta de `GET .../jobs` e devolve os jobs com falha, na ordem da API. */
export function selectFailedJobs(jobsJson: string): RunJob[] {
  const parsed = JSON.parse(jobsJson) as { jobs?: unknown };
  if (!Array.isArray(parsed.jobs)) throw new Error("resposta de jobs sem o campo `jobs`");
  return parsed.jobs
    .map((j) => j as { id?: unknown; name?: unknown; conclusion?: unknown })
    .filter((j) => typeof j.id === "number" && typeof j.conclusion === "string" && FAILED_CONCLUSIONS.has(j.conclusion))
    .map((j) => ({ id: j.id as number, name: String(j.name ?? ""), conclusion: j.conclusion as string }));
}

/**
 * Corta o log na linha `Post job cleanup.` do runner: o que vem depois é a
 * limpeza do checkout/setup (~20 linhas de `git config`), que empurraria a
 * falha para fora do `--tail`. Log sem essa linha volta inteiro. Corta na
 * ÚLTIMA ocorrência: a marca do runner vem depois de todos os steps, então um
 * step que imprima a mesma frase sozinha na linha não esconde a falha real.
 */
export function stripPostJobCleanup(text: string): string {
  let last = -1;
  for (const m of text.matchAll(/^\S*\s?Post job cleanup\.\s*$/gm)) last = m.index ?? last;
  return last >= 0 ? text.slice(0, last) : text;
}

/** Últimas `n` linhas de `text` (`n <= 0` devolve tudo). Ignora a quebra final. */
export function tailLines(text: string, n: number): string {
  const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
  if (n <= 0 || lines.length <= n) return lines.join("\n");
  return lines.slice(-n).join("\n");
}

export function jobHeader(job: RunJob): string {
  return `===== job ${job.id} — ${job.name} (${job.conclusion ?? "?"}) =====`;
}

function ghApi(path: string): string {
  const r = spawnSync("gh", ["api", path], { encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    throw new Error(`gh api ${path} falhou: ${(r.error?.message ?? r.stderr ?? "").trim()}`);
  }
  return r.stdout;
}

/**
 * Inteiro da flag `--{flag}`, com piso `min`. `--run`, `--attempt` e `--job`
 * usam piso 1 (#12775): `0` não é id de run/job nem número de tentativa, e
 * aceitá-lo fazia `--attempt 0` cair na tentativa mais recente (a que o rerun
 * deixou verde, respondendo "nenhum job com falha") e `--run 0`/`--job 0`
 * virarem consulta inválida em vez de erro de uso. `--tail` usa piso 0, onde
 * `0` quer dizer log inteiro.
 */
export function intFlag(raw: string | undefined, flag: string, min: 0 | 1): number | undefined {
  if (raw === undefined) return undefined;
  const n = raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`--${flag} inválido: ${raw} (esperado inteiro >= ${min})`);
  }
  return n;
}

export interface CliNumbers {
  run?: number;
  attempt?: number;
  job?: number;
  tail: number;
}

/** Valida as flags numéricas; lança com a mensagem de uso (exit 3 no `main`). */
export function parseCliNumbers(values: Record<string, string | undefined>): CliNumbers {
  return {
    run: intFlag(values.run, "run", 1),
    attempt: intFlag(values.attempt, "attempt", 1),
    job: intFlag(values.job, "job", 1),
    tail: intFlag(values.tail, "tail", 0) ?? 100,
  };
}

function main(): number {
  let run: number | undefined;
  let attempt: number | undefined;
  let jobId: number | undefined;
  let tail: number;
  const { values } = parseArgs(process.argv.slice(2));
  const repo = values.repo;
  try {
    ({ run, attempt, job: jobId, tail } = parseCliNumbers(values));
  } catch (e) {
    console.error(`[gh-failed-job-logs] ${e instanceof Error ? e.message : e}`);
    return 3;
  }
  if (run === undefined && jobId === undefined) {
    console.error("[gh-failed-job-logs] uso: --run R [--attempt A] [--job J] [--repo owner/name] [--tail 100]");
    return 3;
  }

  let jobs: RunJob[];
  try {
    jobs =
      jobId !== undefined
        ? [{ id: jobId, name: "(--job)", conclusion: null }]
        : selectFailedJobs(ghApi(jobsApiPath(run as number, repo, attempt)));
  } catch (e) {
    console.error(`[gh-failed-job-logs] ${e instanceof Error ? e.message : e}`);
    return 3;
  }
  if (jobs.length === 0) {
    console.error(
      `[gh-failed-job-logs] run ${run}${attempt !== undefined ? ` (tentativa ${attempt})` : ""}: nenhum job com falha. ` +
        "Se o vermelho foi numa tentativa anterior, passe --attempt.",
    );
    return 1;
  }

  let errors = 0;
  for (const job of jobs) {
    console.log(jobHeader(job));
    try {
      console.log(tailLines(stripPostJobCleanup(ghApi(jobLogApiPath(job.id, repo))), tail));
    } catch (e) {
      errors++;
      console.error(`[gh-failed-job-logs] log do job ${job.id} indisponível: ${e instanceof Error ? e.message : e}`);
    }
  }
  return errors === 0 ? 0 : 3;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
