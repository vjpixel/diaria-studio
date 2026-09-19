#!/usr/bin/env npx tsx
/**
 * check-continuo-stale-review-health.ts (#8445 — verificação automática do fix)
 *
 * Existe porque "confirmar no próximo tick" dependia de alguém lembrar. Checa a
 * INVARIANTE (PR com review obsoleto não fica assim) em vez do sintoma, e é
 * consumido pelo watch-continuo-health.sh (diário), que abre issue. Read-only:
 * nunca consome tentativa de re-review, nunca comenta, nunca mergeia.
 *
 * Uso: npx tsx scripts/check-continuo-stale-review-health.ts --json
 * Saída: {status: "ok"|"alarm"|"indeterminate", reason, findings[], readErrors[]}.
 * Exit SEMPRE 0 (quem alarma é o chamador) — mesma disciplina de
 * check-continuo-session-registration.ts (#7890).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  attemptsFilePath,
  evaluateStaleReviewHealth,
  type ReReviewAttempts,
  type StaleReviewProbe,
} from "./lib/continuo-review-staleness.ts";
import { extractIndependentReviewHeadSha } from "./lib/pr-review-authenticity.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function gh(args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync("gh", args, { encoding: "utf8", timeout: 30_000 });
  return { ok: !r.error && r.status === 0, stdout: r.stdout ?? "" };
}

function main(): void {
  const { values } = parseArgs(process.argv.slice(2));
  const attemptsFile = resolve(values["attempts-file"] ?? attemptsFilePath(REPO_ROOT));
  const readErrors: string[] = [];

  const list = gh([
    "pr", "list", "--state", "open", "--json", "number,headRefName",
    "--jq", '[.[] | select(.headRefName | startswith("bot/") | not)]',
  ]);
  let prs: Array<{ number: number; headRefName: string }> = [];
  try {
    prs = JSON.parse(list.stdout);
    if (!list.ok || !Array.isArray(prs)) throw new Error("lista inválida");
  } catch {
    console.log(JSON.stringify({ status: "indeterminate", reason: "gh pr list falhou", findings: [], readErrors }));
    return;
  }

  let attempts: ReReviewAttempts = {};
  try {
    if (existsSync(attemptsFile)) attempts = JSON.parse(readFileSync(attemptsFile, "utf8")) as ReReviewAttempts;
  } catch {
    readErrors.push(`${attemptsFile}: ilegível — tratado como zero tentativas`);
  }

  const probes: StaleReviewProbe[] = [];
  for (const { number, headRefName } of prs) {
    const v = gh(["pr", "view", String(number), "--json", "headRefOid,comments,commits"]);
    try {
      if (!v.ok) throw new Error("gh pr view falhou");
      const d = JSON.parse(v.stdout) as { headRefOid?: unknown; comments?: unknown; commits?: unknown };
      const commits = Array.isArray(d.commits) ? (d.commits as Array<{ committedDate?: unknown }>) : [];
      const last = commits[commits.length - 1]?.committedDate;
      probes.push({
        pr: number,
        headRefName,
        currentHeadSha: typeof d.headRefOid === "string" ? d.headRefOid : null,
        reviewedHeadSha: extractIndependentReviewHeadSha(d.comments),
        headCommittedAt: typeof last === "string" ? last : null,
      });
    } catch {
      readErrors.push(`#${number}: não foi possível ler (pulada)`);
    }
  }

  const findings = evaluateStaleReviewHealth(probes, attempts, new Date().toISOString());
  console.log(
    JSON.stringify({
      status: findings.length > 0 ? "alarm" : "ok",
      reason:
        findings.length > 0
          ? `${findings.length} PR(s) com review obsoleto sem resolução`
          : `${probes.length} PR(s) verificada(s), nenhuma com review obsoleto sem resolução`,
      findings,
      readErrors,
    }),
  );
}

if (isMainModule(import.meta.url)) main();
