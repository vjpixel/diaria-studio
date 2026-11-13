#!/usr/bin/env npx tsx
/**
 * CLI: teto global de PRs abertos (#12765). Ver `scripts/lib/open-pr-cap.ts`.
 *
 * Saída (stdout, JSON):
 *   medido:          `{"verified":true,"open":N,"cap":10,"slots":S,"counted":[...],"truncated":false}`
 *   não verificado:  `{"verified":false,"open":null,"cap":10,"slots":10,"counted":null,"reason":"..."}`
 * Exit 0 = medido. Exit 2 = `gh` falhou: `slots` = teto cheio (fail-soft do
 * #7746 — infra caída não trava a rodada), `open`/`counted` nulos para nunca
 * passarem por "0 PRs abertas" num relatório. Lista no limite de paginação
 * (200) é medição válida: já prova `open >= 200 > cap`, então `slots = 0`.
 */
import { spawnSync } from "node:child_process";
import { isMainModule } from "./lib/cli-args.ts";
import { computeOpenPrSlots, OPEN_PR_CAP, type OpenPrCapResult, type OpenPrLike } from "./lib/open-pr-cap.ts";

export const OPEN_PR_LIST_LIMIT = 200;
const REPO = "vjpixel/diaria-studio";

export function readOpenPrCap(run: typeof spawnSync = spawnSync, cap: number = OPEN_PR_CAP): OpenPrCapResult {
  const unverified = (reason: string): OpenPrCapResult =>
    ({ verified: false, open: null, cap, slots: cap, counted: null, reason });
  const res = run(
    "gh",
    ["pr", "list", "--repo", REPO, "--state", "open", "--limit", String(OPEN_PR_LIST_LIMIT), "--json", "number,headRefName,author"],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (res.error || res.status !== 0) {
    return unverified(String(res.stderr ?? "").trim() || res.error?.message || `gh saiu ${res.status}`);
  }
  let prs: OpenPrLike[];
  try {
    prs = JSON.parse(String(res.stdout || "[]")) as OpenPrLike[];
  } catch (e) {
    return unverified(`saída do gh não é JSON: ${e instanceof Error ? e.message : e}`);
  }
  if (!Array.isArray(prs)) return unverified("saída do gh não é array");
  const truncated = prs.length >= OPEN_PR_LIST_LIMIT;
  const slots = computeOpenPrSlots(prs, cap);
  return { ...slots, ...(truncated ? { slots: 0 } : {}), verified: true, truncated };
}

if (isMainModule(import.meta.url)) {
  const result = readOpenPrCap();
  if (!result.verified) {
    console.error(`[check-open-pr-cap] não verificado (${result.reason}); assumindo teto cheio de vagas (fail-soft)`);
  }
  console.log(JSON.stringify(result));
  process.exitCode = result.verified ? 0 : 2;
}
