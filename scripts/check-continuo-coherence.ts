#!/usr/bin/env npx tsx
/**
 * scripts/check-continuo-coherence.ts (#6752)
 *
 * CLI do gate de coerência do `hermes-diaria-continuo` (§4, antes do
 * claim-issue) — ver `scripts/lib/continuo-coherence-gate.ts` pra lógica
 * pura/docs completas do POR QUÊ e do desenho. Este arquivo só coleta os 3
 * insumos via `gh`/`git`, trata falha de comando como resultado
 * INCONCLUSIVO (nunca "sem sinal, logo admite" — fail-closed, mesma
 * disciplina do `sensitive-path-guard.ts`), e imprime o veredito.
 *
 * Uso:
 *   npx tsx scripts/check-continuo-coherence.ts --issue 1234
 *   npx tsx scripts/check-continuo-coherence.ts --issue 1234 --recent-hours 72
 *
 * Exit codes:
 *   0 = admit      (baixa coerência medida — pode reivindicar)
 *   1 = reject      (≥1 sinal de alta coerência — NÃO reivindicar este tick)
 *   2 = error       (gh/git falhou, issue inexistente, JSON malformado —
 *       inconclusivo; o chamador trata como reject, nunca como admit)
 *   3 = uso inválido (--issue ausente/não-numérico)
 *
 * @see scripts/lib/continuo-coherence-gate.ts
 * @see hermes/skills/hermes-diaria-continuo/SKILL.md (§4, passo 1)
 */

import { spawnSync } from "node:child_process";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { evaluateContinuoCoherence, type CoherenceGateResult } from "./lib/continuo-coherence-gate.ts";

const DEFAULT_RECENT_HOURS = 48;

interface GateOutcome {
  readonly verdict: "admit" | "reject" | "error";
  readonly result?: CoherenceGateResult;
  readonly reason?: string;
}

function run(cmd: string, args: string[], cwd: string): { ok: boolean; stdout: string; error?: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return { ok: false, stdout: "", error: `${cmd} não pôde ser executado: ${r.error.message}` };
  if (r.status !== 0) {
    const stderr = (r.stderr ?? "").toString().trim();
    return { ok: false, stdout: "", error: `${cmd} ${args[0]} saiu com status ${r.status}${stderr ? `: ${stderr}` : ""}` };
  }
  return { ok: true, stdout: r.stdout ?? "" };
}

/** Busca título/corpo da issue. */
function fetchIssue(issueNumber: number, cwd: string): { ok: boolean; title?: string; body?: string; error?: string } {
  const r = run("gh", ["issue", "view", String(issueNumber), "--json", "title,body"], cwd);
  if (!r.ok) return { ok: false, error: r.error };
  try {
    const parsed = JSON.parse(r.stdout) as { title?: string; body?: string };
    return { ok: true, title: parsed.title ?? "", body: parsed.body ?? "" };
  } catch (e) {
    return { ok: false, error: `JSON malformado de gh issue view: ${(e as Error).message}` };
  }
}

/** Paths tocados por qualquer PR aberta agora (qualquer branch). */
function fetchActiveFiles(cwd: string): { ok: boolean; files?: string[]; error?: string } {
  const r = run("gh", ["pr", "list", "--state", "open", "--json", "files", "--limit", "200"], cwd);
  if (!r.ok) return { ok: false, error: r.error };
  try {
    const parsed = JSON.parse(r.stdout) as Array<{ files?: Array<{ path?: string }> }>;
    const files = parsed.flatMap((pr) => (pr.files ?? []).map((f) => f.path).filter((p): p is string => !!p));
    return { ok: true, files };
  } catch (e) {
    return { ok: false, error: `JSON malformado de gh pr list: ${(e as Error).message}` };
  }
}

/** Paths tocados por commits de master dentro da janela recente. */
function fetchRecentMasterFiles(cwd: string, recentHours: number): { ok: boolean; files?: string[]; error?: string } {
  const r = run("git", ["log", `--since=${recentHours} hours ago`, "origin/master", "--name-only", "--pretty=format:"], cwd);
  if (!r.ok) return { ok: false, error: r.error };
  const files = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return { ok: true, files: [...new Set(files)] };
}

export function checkContinuoCoherence(issueNumber: number, cwd: string, recentHours: number): GateOutcome {
  const issue = fetchIssue(issueNumber, cwd);
  if (!issue.ok) return { verdict: "error", reason: issue.error };

  const active = fetchActiveFiles(cwd);
  if (!active.ok) return { verdict: "error", reason: active.error };

  const recent = fetchRecentMasterFiles(cwd, recentHours);
  if (!recent.ok) return { verdict: "error", reason: recent.error };

  const result = evaluateContinuoCoherence({
    issueTitle: issue.title ?? "",
    issueBody: issue.body ?? "",
    activeFiles: active.files ?? [],
    recentMasterFiles: recent.files ?? [],
  });

  return { verdict: result.admit ? "admit" : "reject", result };
}

const EXIT_CODES: Record<GateOutcome["verdict"], number> = { admit: 0, reject: 1, error: 2 };

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const issueRaw = values.issue;
  const issueNumber = issueRaw ? Number(issueRaw) : NaN;
  if (!issueRaw || !Number.isInteger(issueNumber) || issueNumber <= 0) {
    console.error("[check-continuo-coherence] uso: --issue N [--recent-hours 48]");
    process.exit(3);
  }
  const recentHoursRaw = values["recent-hours"];
  const recentHours =
    recentHoursRaw && Number.isFinite(Number(recentHoursRaw)) && Number(recentHoursRaw) > 0
      ? Number(recentHoursRaw)
      : DEFAULT_RECENT_HOURS;

  const outcome = checkContinuoCoherence(issueNumber, process.cwd(), recentHours);
  const prefix = `[check-continuo-coherence] issue #${issueNumber}: verdict=${outcome.verdict}`;

  if (outcome.verdict === "error") {
    console.error(`${prefix} — ${outcome.reason} (inconclusivo trata-se como reject)`);
  } else if (outcome.verdict === "reject") {
    console.error(`${prefix} — ${outcome.result?.reasons.join(" | ")}`);
  } else {
    console.log(`${prefix} — nenhum sinal de alta coerência`);
  }

  process.exit(EXIT_CODES[outcome.verdict]);
}
