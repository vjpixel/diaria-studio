#!/usr/bin/env npx tsx
/**
 * scripts/check-pre-dispatch-claim.ts (#13154)
 *
 * Reconferência de claim LOGO ANTES do dispatch de cada unidade, juntando os
 * três sinais de "outra sessão já está nesta issue":
 *
 * 1. `session-registry` (`isIssueClaimedByOther`, a mesma consulta de
 *    `is-claimed`): rápido, mas entre máquinas depende do sync de `data/`.
 * 2. PR aberta cobrindo a issue (`assessOpenPrCoverage`, a mesma lógica de
 *    `check-issue-open-pr.ts`, inclusive branch `develop/fix-N...`): uma PR
 *    aberta entre a composição da onda e o dispatch.
 * 3. Marcador de claim no GitHub (`github-claim-marker.ts`): comentário na
 *    issue, visível na hora em qualquer máquina.
 *
 * Incidente (rodada 261115c): o overnight do 300 despachou #13120 e
 * #13128-#13132 dezessete minutos depois de a sessão develop do Neo
 * reivindicá-las, porque o registro do Neo ainda não tinha replicado. O sinal 3
 * é o que fecha esse caso; os sinais 1 e 2 são os de sempre, reconferidos no
 * último instante em vez de só na composição da onda.
 *
 * Uso:
 *   npx tsx scripts/check-pre-dispatch-claim.ts --issues A,B --session-id ID [--kind overnight --announce]
 *   npx tsx scripts/check-pre-dispatch-claim.ts --issues A,B --session-id ID --release
 *
 * `--session-id` é obrigatório (exclui a própria sessão dos sinais 1 e 3; o
 * hook `inject-session-id.mjs` não cobre este script, passar explicitamente).
 * `--announce` (exige `--kind`) grava o marcador de claim como comentário em
 * cada issue que saiu `livre` e que ainda não tem claim ativa desta sessão.
 * Depois de postar, relê os comentários (#13172): duas sessões que conferem
 * com 1-2 s de diferença recebem `livre` e postam as duas; na releitura, a que
 * tem a claim mais nova vê a outra em `claimedByOther`, grava o próprio
 * release e sai `ocupada` (motivo `github-claim-race`), exit 1. A de claim
 * mais antiga segue `livre`. Releitura que falha sai `cannot-verify` (exit 2),
 * também com release best-effort da claim recém-postada.
 * Claim de sessão que `data/session-lifecycle.jsonl` mostra encerrada depois
 * do `at` da claim é ignorada (#13172, `endedSessionsFromLifecycle`).
 * `--release` grava o marcador de release nas issues em que esta sessão tem
 * claim ativa no GitHub (nenhuma checagem; usar junto do `unclaim-issue`).
 *
 * Saída (stdout): JSON `{ issues: PreDispatchIssueResult[] }`.
 * Exit codes (modo checagem):
 *   0 — todas `livre`: dispatch normal.
 *   1 — alguma `ocupada` (e nenhuma `cannot-verify`): pular a unidade da issue
 *       ocupada (`claimed-por-outra-sessao`; com só `pr-aberta`, seguir o
 *       `orphanAction` do item 28 de context/overnight-dispatch-rules.md).
 *   2 — alguma `cannot-verify`, ou uso incorreto. NUNCA tratar como livre.
 * Falha ao GRAVAR o marcador (`--announce`/`--release`) não muda o exit code:
 * sai como `announce.error` no JSON e em stderr (o registro local segue
 * valendo; a rodada registra a falha e segue).
 *
 * @see scripts/lib/github-claim-marker.ts
 * @see scripts/check-issue-open-pr.ts
 * @see context/overnight-dispatch-rules.md item 18 e item 28
 */
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { assessOpenPrCoverage, type OpenPrCheckResult } from "./lib/issue-open-pr-check.ts";
import { fetchOpenPrs, type FetchOpenPrsResult } from "./lib/gh-open-pr-fetch.ts";
import { formatIssueRef, legacyIssueNumber, parseIssueRef, type IssueRef } from "./lib/issue-repos.ts";
import { isIssueClaimedByOther, readSessionLifecycleEvents } from "./lib/session-registry.ts";
import {
  assessGithubClaims,
  endedSessionsFromLifecycle,
  formatClaimComment,
  formatReleaseComment,
  type GithubClaimMarker,
} from "./lib/github-claim-marker.ts";

export interface RunnerResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type Runner = (cmd: string, args: string[], opts: { cwd: string; input?: string }) => RunnerResult;

const defaultRunner: Runner = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    input: opts.input,
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: (r.stderr ?? "").toString(), error: r.error };
};

/** Registro de outra sessão que segura a issue; `null` = livre; `undefined`
 * = a consulta falhou (fail-closed: `cannot-verify`). */
export type RegistryLookup = (
  issue: number | IssueRef,
  excludeSessionId: string,
) => { kind: string; sessionId: string } | null | undefined;

function defaultRegistryLookup(cwd: string): RegistryLookup {
  return (issue, excludeSessionId) => {
    try {
      const rec = isIssueClaimedByOther(cwd, issue, excludeSessionId);
      return rec === null ? null : { kind: rec.kind, sessionId: rec.sessionId };
    } catch {
      return undefined;
    }
  };
}

export interface Deps {
  runner?: Runner;
  registryLookup?: RegistryLookup;
  now?: () => number;
  host?: string;
  /** Fins de sessão do log de lifecycle (`sessionId` → `ts`). Default: lê
   * `data/session-lifecycle.jsonl` (fail-soft: ausente = mapa vazio, a claim
   * segue valendo). */
  endedSessions?: () => ReadonlyMap<string, string>;
}

export type PreDispatchVerdict = "livre" | "ocupada" | "cannot-verify";

export interface PreDispatchIssueResult {
  issue: string;
  verdict: PreDispatchVerdict;
  /** `registry`, `github-claim`, `pr-aberta`, `github-claim-race`. */
  reasons: string[];
  registryClaim?: { kind: string; sessionId: string } | null;
  githubClaim?: GithubClaimMarker | null;
  openPr?: { number: number; headRefName: string; orphanAction?: string } | null;
  errors: string[];
  announce?: { posted: boolean; skipped?: string; error?: string };
  release?: { posted: boolean; skipped?: string; error?: string };
}

/** Decide o veredito a partir dos três sinais. Pura. */
export function combineVerdict(signals: {
  registry: { kind: string; sessionId: string } | null | undefined;
  github: GithubClaimMarker | null | undefined;
  openPr: OpenPrCheckResult | undefined;
}): { verdict: PreDispatchVerdict; reasons: string[] } {
  const reasons: string[] = [];
  if (signals.registry) reasons.push("registry");
  if (signals.github) reasons.push("github-claim");
  if (signals.openPr?.verdict === "open-pr-covers-scope") reasons.push("pr-aberta");
  const unverifiable =
    signals.registry === undefined ||
    signals.github === undefined ||
    signals.openPr === undefined ||
    signals.openPr.verdict === "cannot-verify";
  if (unverifiable) return { verdict: "cannot-verify", reasons };
  return { verdict: reasons.length > 0 ? "ocupada" : "livre", reasons };
}

function repoArgs(ref: IssueRef): string[] {
  return legacyIssueNumber(ref) === null ? ["-R", ref.repo] : [];
}

function fetchIssueComments(
  runner: Runner,
  cwd: string,
  ref: IssueRef,
): { comments: unknown; error?: string } {
  const r = runner("gh", ["issue", "view", String(ref.number), ...repoArgs(ref), "--json", "comments"], { cwd });
  if (r.error) return { comments: null, error: `gh não pôde ser executado: ${r.error.message}` };
  if (r.status !== 0) return { comments: null, error: `gh issue view saiu com status ${r.status}: ${r.stderr.trim()}` };
  try {
    const parsed = JSON.parse(r.stdout) as { comments?: unknown };
    if (!Array.isArray(parsed?.comments)) return { comments: null, error: "gh issue view sem array `comments`" };
    return { comments: parsed.comments };
  } catch (e) {
    return { comments: null, error: `JSON malformado de gh issue view: ${(e as Error).message}` };
  }
}

function postComment(runner: Runner, cwd: string, ref: IssueRef, body: string): string | undefined {
  const r = runner("gh", ["issue", "comment", String(ref.number), ...repoArgs(ref), "--body-file", "-"], {
    cwd,
    input: body,
  });
  if (r.error) return `gh não pôde ser executado: ${r.error.message}`;
  if (r.status !== 0) return `gh issue comment saiu com status ${r.status}: ${r.stderr.trim()}`;
  return undefined;
}

export function main(argv: string[], cwd: string, deps: Deps = {}): number {
  const { values, flags } = parseArgs(argv);
  const issuesRaw = typeof values.issues === "string" ? values.issues : typeof values.issue === "string" ? values.issue : "";
  const sessionId = typeof values["session-id"] === "string" ? values["session-id"].trim() : "";
  const kind = typeof values.kind === "string" ? values.kind.trim() : "";
  const announce = flags.has("announce");
  const release = flags.has("release");

  if (!issuesRaw || !sessionId) {
    console.error("[check-pre-dispatch-claim] uso: --issues A,B --session-id ID [--kind K --announce | --release]");
    return 2;
  }
  if (announce && release) {
    console.error("[check-pre-dispatch-claim] --announce e --release são exclusivos");
    return 2;
  }
  if (announce && !kind) {
    console.error("[check-pre-dispatch-claim] --announce exige --kind");
    return 2;
  }
  const refs: IssueRef[] = [];
  for (const part of issuesRaw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const ref = parseIssueRef(part);
    if (!ref) {
      console.error(`[check-pre-dispatch-claim] issue inválida: ${part} (esperado N ou owner/repo#N)`);
      return 2;
    }
    refs.push(ref);
  }
  if (refs.length === 0) {
    console.error("[check-pre-dispatch-claim] --issues vazio");
    return 2;
  }

  const runner = deps.runner ?? defaultRunner;
  const now = deps.now ?? Date.now;
  const host = (deps.host ?? hostname()).replace(/[^A-Za-z0-9._-]/g, "-") || "desconhecido";
  const registryLookup = deps.registryLookup ?? defaultRegistryLookup(cwd);
  const endedSessions = (deps.endedSessions ?? (() => endedSessionsFromLifecycle(readSessionLifecycleEvents(cwd))))();
  const assessOpts = () => ({ excludeSessionId: sessionId, now: now(), endedSessions });
  const results: PreDispatchIssueResult[] = [];

  const postRelease = (ref: IssueRef): { posted: boolean; error?: string } => {
    const err = postComment(runner, cwd, ref, formatReleaseComment({ sessionId, at: new Date(now()).toISOString() }));
    return err ? { posted: false, error: err } : { posted: true };
  };

  if (release) {
    for (const ref of refs) {
      const label = formatIssueRef(ref);
      const res: PreDispatchIssueResult = { issue: label, verdict: "livre", reasons: [], errors: [] };
      const fetched = fetchIssueComments(runner, cwd, ref);
      const assessed = fetched.error ? null : assessGithubClaims(fetched.comments, assessOpts());
      if (!assessed) {
        res.release = { posted: false, error: fetched.error ?? "comentários ilegíveis" };
      } else if (!assessed.ownClaim) {
        res.release = { posted: false, skipped: "sem claim ativa desta sessão no GitHub" };
      } else {
        res.release = postRelease(ref);
      }
      if (res.release.error) console.error(`[check-pre-dispatch-claim] ${label}: release não gravado: ${res.release.error}`);
      results.push(res);
    }
    console.log(JSON.stringify({ issues: results }, null, 2));
    return 0;
  }

  /**
   * #13172: relê os comentários depois de postar a claim. Se outra sessão tem
   * claim ativa mais antiga (postada entre a conferência e o post desta), esta
   * cede: grava o release e o veredito vira `ocupada`. A claim recém-postada
   * entra na leitura mesmo se a API ainda não a devolver, para a comparação
   * usar o `at` dela e não cair no caso "sem claim própria".
   */
  function recheckAfterAnnounce(ref: IssueRef, label: string, claimBody: string, res: PreDispatchIssueResult): void {
    const again = fetchIssueComments(runner, cwd, ref);
    const assessed = again.error
      ? null
      : assessGithubClaims(
          [...(again.comments as unknown[]), { body: claimBody, authorAssociation: "OWNER" }],
          assessOpts(),
        );
    if (!assessed) {
      res.verdict = "cannot-verify";
      res.errors.push(`releitura após --announce falhou: ${again.error ?? "comentários ilegíveis"}`);
    } else if (assessed.claimedByOther) {
      res.verdict = "ocupada";
      res.reasons.push("github-claim-race");
      res.githubClaim = assessed.claimedByOther;
    } else {
      return;
    }
    res.release = postRelease(ref);
    if (res.release.error) console.error(`[check-pre-dispatch-claim] ${label}: release não gravado: ${res.release.error}`);
  }

  const prCache = new Map<string, FetchOpenPrsResult>();
  for (const ref of refs) {
    const label = formatIssueRef(ref);
    const foreign = legacyIssueNumber(ref) === null;
    const errors: string[] = [];

    const registry = registryLookup(foreign ? ref : ref.number, sessionId);
    if (registry === undefined) errors.push("consulta ao session-registry falhou");

    const fetched = fetchIssueComments(runner, cwd, ref);
    let github: GithubClaimMarker | null | undefined = undefined;
    let ownClaim: GithubClaimMarker | null = null;
    if (fetched.error) {
      errors.push(fetched.error);
    } else {
      const assessed = assessGithubClaims(fetched.comments, assessOpts());
      if (assessed) {
        github = assessed.claimedByOther;
        ownClaim = assessed.ownClaim;
      } else {
        errors.push("comentários ilegíveis");
      }
    }

    const repoKey = foreign ? ref.repo : "";
    if (!prCache.has(repoKey)) prCache.set(repoKey, fetchOpenPrs(cwd, runner, foreign ? ref.repo : undefined));
    const prs = prCache.get(repoKey)!;
    let openPr: OpenPrCheckResult | undefined;
    if (prs.error) {
      errors.push(prs.error);
    } else {
      openPr = assessOpenPrCoverage(ref.number, prs.prs, foreign ? ref.repo : undefined, {
        claimedByActiveSession: registry === undefined ? null : registry !== null,
      });
    }

    const { verdict, reasons } = combineVerdict({ registry, github, openPr });
    const top = openPr?.verdict === "open-pr-covers-scope" ? openPr.matches.find((m) => m.matchKind !== "mention-only") : undefined;
    const res: PreDispatchIssueResult = {
      issue: label,
      verdict,
      reasons,
      registryClaim: registry ?? null,
      githubClaim: github ?? null,
      openPr: top ? { number: top.number, headRefName: top.headRefName, orphanAction: openPr?.orphanAction } : null,
      errors,
    };

    if (announce) {
      if (verdict !== "livre") {
        res.announce = { posted: false, skipped: `veredito ${verdict}` };
      } else if (ownClaim) {
        res.announce = { posted: false, skipped: "claim desta sessão já está no GitHub" };
      } else {
        const claimBody = formatClaimComment({ kind, sessionId, host, at: new Date(now()).toISOString() });
        const err = postComment(runner, cwd, ref, claimBody);
        res.announce = err ? { posted: false, error: err } : { posted: true };
        if (err) console.error(`[check-pre-dispatch-claim] ${label}: claim não gravada no GitHub: ${err}`);
        else recheckAfterAnnounce(ref, label, claimBody, res);
      }
    }
    results.push(res);
  }

  console.log(JSON.stringify({ issues: results }, null, 2));
  if (results.some((r) => r.verdict === "cannot-verify")) return 2;
  if (results.some((r) => r.verdict === "ocupada")) return 1;
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.cwd());
}
