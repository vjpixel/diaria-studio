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
