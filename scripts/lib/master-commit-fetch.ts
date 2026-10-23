/**
 * scripts/lib/master-commit-fetch.ts (#7020)
 *
 * Único ponto do repo que busca "quais commits de `origin/master` citam a
 * issue #N" pro preflight de duplicidade (`scripts/lib/issue-duplicate-preflight.ts`).
 *
 * **Sempre `git log origin/master --grep "#N"`, NUNCA `git log --all --grep
 * "#N"`.** `--all` inclui `refs/remotes/origin/pull/*`, branches locais
 * nunca mergeadas e qualquer outra ref alcançável — exatamente a classe de
 * falso-positivo que já produziu citação errada nesta mesma rodada (uma
 * issue "resolvida" que na verdade só existe numa PR fechada sem merge). Um
 * SHA que existe em ref de PR fechada mas não em `master` deve dar
 * "não está em master" — é esse comportamento que separa este módulo de um
 * `--all` ingênuo, e é o que o teste de regressão trava.
 *
 * Fail-soft (#738): qualquer falha (`git` ausente, `origin/master` nunca
 * fetchado localmente, timeout) volta como `{ commits: [], error }` — nunca
 * lança. Sem indício de duplicidade quando o fetch falha é o mesmo
 * trade-off já aceito por `check-decision-label-drift.ts`/
 * `fetchOpenIssuesForConvergence`: degradar pra "não sei" é melhor do que
 * travar o preflight inteiro por uma falha de rede.
 *
 * @see scripts/lib/issue-duplicate-preflight.ts (lógica pura de veredito)
 */

import { spawnSync } from "node:child_process";
import { citesIssueNumber, type MasterCommitInfo } from "./issue-duplicate-preflight.ts";

export interface FetchMasterCommitsResult {
  commits: MasterCommitInfo[];
  error?: string;
  /** Busca incompleta mas NÃO bloqueante (#10901): o chamador segue com
   * `commits` como "sem indício" e só registra o aviso. */
  warning?: string;
}

// Separadores de campo/registro improváveis de aparecer em mensagem de
// commit normal (0x1f/0x1e — mesma técnica de `git log --format` usada em
// scripts vizinhos que precisam parsear corpo multi-linha com segurança).
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

/**
 * Busca commits de `origin/master` cujo assunto OU corpo cita `#issueNumber`
 * (mesmo comportamento de `--grep` do `git log`, que casa contra a mensagem
 * inteira). `cwd` deve ser um checkout com `origin/master` já resolvível
 * localmente (checkout normal do repo — não precisa fetch explícito aqui,
 * mesma premissa de qualquer outro `git log origin/master` já usado no
 * repo).
 */
/** Busca commits de `origin/master` que citam uma PROVENIÊNCIA (string de
 * identificação do achado — ex: range de diff `615b0de0..8b959ef2`, PR `#7605`,
 * SHA `44205ff0`) em vez do número da issue. Mesmas restrições: sempre
 * `origin/master`, `--fixed-strings`, nunca `--all`. Fail-soft (#738). */
export function fetchMasterCommitsForProvenance(
  cwd: string,
  provenance: string,
): FetchMasterCommitsResult {
  const format = `%H${FIELD_SEP}%s${FIELD_SEP}%aI${FIELD_SEP}%B${RECORD_SEP}`;
  const result = spawnSync(
    "git",
    ["log", "origin/master", "--grep", provenance, "--fixed-strings", `--format=${format}`],
    { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.error) {
    return { commits: [], error: `git error (provenance "${provenance}"): ${String(result.error)}` };
  }
  if (result.status !== 0) {
    // git log --grep retorna 0 mesmo sem match; não é erro.
  }
  const commits = parseProvenanceLogOutput(result.stdout || "");
  return { commits };
}

function parseProvenanceLogOutput(stdout: string): MasterCommitInfo[] {
  if (!stdout.trim()) return [];
  const records = stdout.split(RECORD_SEP).map((r) => r.trim()).filter(Boolean);
  const out: MasterCommitInfo[] = [];
  for (const record of records) {
    const [sha, subject, authorDateIso, ...bodyParts] = record.split(FIELD_SEP);
    if (!sha) continue;
    out.push({ sha: sha.trim(), subject: (subject ?? "").trim(), body: bodyParts.join(FIELD_SEP).trim(), authorDateIso: (authorDateIso ?? "").trim() });
  }
  return out;
}

export function fetchMasterCommitsForIssue(cwd: string, issueNumber: number): FetchMasterCommitsResult {
  const format = `%H${FIELD_SEP}%s${FIELD_SEP}%aI${FIELD_SEP}%B${RECORD_SEP}`;
  // `--grep "#N"` sozinho é deliberadamente amplo (o motor de regex do
  // `git` não suporta `\b` de forma portável) — casa `#N` como substring de
  // `#N0`/`#1N` também. A precisão de boundary de dígito é aplicada DEPOIS,
  // em JS, via `citesIssueNumber` — nunca confiar no `--grep` sozinho pra
  // decidir "cita a issue".
  const result = spawnSync(
    "git",
    ["log", "origin/master", "--grep", `#${issueNumber}`, "--fixed-strings", `--format=${format}`],
    { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
  );
  if (result.error) {
    return { commits: [], error: `git não pôde ser executado: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    return {
      commits: [],
      error: `git log origin/master saiu com status ${result.status}${stderr ? `: ${stderr}` : ""}`,
    };
  }
  const stdout = result.stdout ?? "";
  if (!stdout.trim()) {
    return { commits: [] };
  }
  const records = stdout.split(RECORD_SEP).map((r) => r.trim()).filter(Boolean);
  const commits: MasterCommitInfo[] = [];
  for (const record of records) {
    const [sha, subject, authorDateIso, ...bodyParts] = record.split(FIELD_SEP);
    if (!sha) continue;
    const body = bodyParts.join(FIELD_SEP).trim();
    // `--grep` acima é amplo de propósito — filtra aqui com boundary de
    // dígito preciso, descartando falso-positivo tipo `#42` casando dentro
    // de `#420`.
    if (!citesIssueNumber(body, issueNumber) && !citesIssueNumber(subject ?? "", issueNumber)) continue;
    commits.push({ sha, subject: subject ?? "", authorDateIso: authorDateIso ?? "", body });
  }
  return { commits };
}

/** Executor de comando injetável (teste sem rede). Mesmo shape de `spawnSync`. */
export type CommitFetchRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => { status: number | null; stdout?: string; stderr?: string; error?: Error };

function defaultCommitFetchRunner(cmd: string, args: string[], opts: { cwd: string }) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

/** #10901: teto de páginas (100 commits cada) da varredura FALLBACK da branch
 * default de outro repo — só usada quando a busca dirigida falha. */
export const REPO_COMMITS_MAX_PAGES = 10;
const REPO_COMMITS_PER_PAGE = 100;
const COMMIT_ROW_JQ = ".[] | {sha: .sha, message: .commit.message, date: .commit.author.date}";
const SEARCH_ROW_JQ = ".items[] | {sha: .sha, message: .commit.message, date: .commit.author.date}";

type CollectOutcome = { ok: true; rows: number } | { ok: false; error: string };

/**
 * Roda um `gh api` que devolve uma linha JSON `{sha, message, date}` por
 * commit e acumula em `into` (dedup por SHA) os que citam a issue.
 */
function collectCitingCommits(
  runner: CommitFetchRunner,
  cwd: string,
  args: string[],
  label: string,
  repo: string,
  issueNumber: number,
  into: Map<string, MasterCommitInfo>,
): CollectOutcome {
  const result = runner("gh", args, { cwd });
  if (result.error) return { ok: false, error: `gh não pôde ser executado: ${result.error.message}` };
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    return { ok: false, error: `gh api ${label} saiu com status ${result.status}${stderr ? `: ${stderr}` : ""}` };
  }
  let rows = 0;
  for (const line of (result.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    rows++;
    let row: { sha?: unknown; message?: unknown; date?: unknown };
    try {
      row = JSON.parse(line) as typeof row;
    } catch (e) {
      return { ok: false, error: `JSON malformado de gh api ${label}: ${(e as Error).message}` };
    }
    if (typeof row.sha !== "string" || typeof row.message !== "string") continue;
    const [subject = "", ...rest] = row.message.split("\n");
    const body = rest.join("\n").trim();
    // Citação qualificada de OUTRO repo (`vjpixel/diaria-studio#21` num
    // commit do design) não é esta issue — o matcher recebe o repo.
    if (!citesIssueNumber(body, issueNumber, repo) && !citesIssueNumber(subject, issueNumber, repo)) continue;
    if (!into.has(row.sha)) {
      into.set(row.sha, { sha: row.sha, subject, authorDateIso: typeof row.date === "string" ? row.date : "", body });
    }
  }
  return { ok: true, rows };
}

/**
 * #10618 (fatia 4): o mesmo "quais commits da branch default citam a issue
 * #N", para issue de OUTRO repo (ex: vjpixel/diaria-design). O checkout local
 * é do diaria-studio e não enxerga o outro repo, então a busca vai pela API —
 * sempre só a branch default (mesma regra do "nunca `--all`": commit de PR
 * fechada sem merge não aparece aí). O filtro de boundary de dígito é o mesmo
 * (`citesIssueNumber`). Fail-soft como o resto do módulo.
 *
 * #10901: busca DIRIGIDA, com custo que não cresce com o histórico:
 *   1. 1ª página de `repos/{repo}/commits` (100 mais recentes) — cobre o
 *      atraso de indexação da busca para um merge de minutos atrás e, se o
 *      histórico inteiro cabe nela, já é a resposta completa;
 *   2. `search/commits` com `repo:{repo} "#N"` (a busca de commits do GitHub
 *      só indexa a branch default) — prefiltro amplo, a precisão vem do
 *      `citesIssueNumber`.
 * Se a busca falhar (rate limit, 422), cai na varredura página a página até
 * `maxPages`. Teto atingido sem achado NUNCA vira `error` (cannot-verify, que
 * o preflight trata como exit 2 bloqueante): volta `commits: []` com
 * `warning` — "sem indício de duplicidade", aceitando um falso negativo raro
 * (busca fora do ar E commit além do teto) em vez de travar o despacho de
 * toda issue do repo. `error` fica só para `gh` quebrado de fato.
 */
export function fetchRepoCommitsForIssue(
  cwd: string,
  repo: string,
  issueNumber: number,
  runner: CommitFetchRunner = defaultCommitFetchRunner,
  maxPages: number = REPO_COMMITS_MAX_PAGES,
): FetchMasterCommitsResult {
  const found = new Map<string, MasterCommitInfo>();
  const commitsLabel = `repos/${repo}/commits`;
  const pageArgs = (page: number) => [
    "api",
    `${commitsLabel}?per_page=${REPO_COMMITS_PER_PAGE}&page=${page}`,
    "--jq",
    COMMIT_ROW_JQ,
  ];

  const first = collectCitingCommits(runner, cwd, pageArgs(1), commitsLabel, repo, issueNumber, found);
  if (!first.ok) return { commits: [], error: first.error };
  if (first.rows < REPO_COMMITS_PER_PAGE) return { commits: [...found.values()] };

  const search = collectCitingCommits(
    runner,
    cwd,
    [
      "api",
      "--paginate",
      "-X",
      "GET",
      "search/commits",
      "-f",
      `q=repo:${repo} "#${issueNumber}"`,
      "-f",
      `per_page=${REPO_COMMITS_PER_PAGE}`,
      "--jq",
      SEARCH_ROW_JQ,
    ],
    `search/commits (${repo} #${issueNumber})`,
    repo,
    issueNumber,
    found,
  );
  if (search.ok) return { commits: [...found.values()] };

  // Fallback: busca indisponível → varredura com teto.
  for (let page = 2; page <= maxPages; page++) {
    const r = collectCitingCommits(runner, cwd, pageArgs(page), commitsLabel, repo, issueNumber, found);
    if (!r.ok) return { commits: [], error: r.error };
    if (r.rows < REPO_COMMITS_PER_PAGE) return { commits: [...found.values()] };
  }
  if (found.size > 0) return { commits: [...found.values()] };
  return {
    commits: [],
    warning:
      `busca dirigida indisponível (${search.error}) e teto de ${maxPages} páginas ` +
      `(${maxPages * REPO_COMMITS_PER_PAGE} commits) de ${commitsLabel} atingido sem achar #${issueNumber} — ` +
      `tratado como sem indício de duplicidade; histórico mais antigo não consultado`,
  };
}
