#!/usr/bin/env node
/**
 * CLI: verifica teto de PRs continuo/* abertas (#7746) E o teto global de PRs
 * abertas no repo (#12765, `scripts/lib/open-pr-cap.ts`).
 * Saída JSON: {open, cap, mayClaim, counted, heldBy, verified, global: {open, cap, slots, verified}}
 * `mayClaim` só é true se os DOIS tetos têm vaga (`combineContinuoCaps`);
 * `heldBy` diz qual segurou ("continuo" | "global" | null).
 * Fail-soft (#7746): gh falhando → `verified:false`, mayClaim=true, counted=[],
 * motivo no stderr. Mesma leitura do `check-open-pr-cap.ts` (`readOpenPrCap`).
 */
import { spawnSync } from "child_process";
import { shouldClaimNewIssue } from "./lib/continuo-pr-cap.js";
import { combineContinuoCaps, type OpenPrLike } from "./lib/open-pr-cap.ts";
import { OPEN_PR_LIST_LIMIT, readOpenPrCap } from "./check-open-pr-cap.ts";

function ghList(): { ok: boolean; prs: OpenPrLike[]; reason?: string } {
  const res = spawnSync(
    "gh",
    ["pr", "list", "--repo", "vjpixel/diaria-studio", "--state", "open", "--json", "number,headRefName,author", "--limit", String(OPEN_PR_LIST_LIMIT)],
    { encoding: "utf8", timeout: 15000 }
  );
  if (res.error || res.status !== 0) {
    return { ok: false, prs: [], reason: res.stderr?.trim() || res.error?.message || "gh falhou" };
  }
  try {
    const arr = JSON.parse(res.stdout || "[]") as OpenPrLike[];
    if (!Array.isArray(arr)) throw new Error("saída do gh não é array");
    return { ok: true, prs: arr.filter((r) => typeof r?.headRefName === "string") };
  } catch (e) {
    return { ok: false, prs: [], reason: String(e) };
  }
}

const list = ghList();
if (!list.ok) {
  // Fail-soft na direção de PERMITIR (não trava tick por infra), #7746
  console.error(`continuo-pr-cap: gh falhou (${list.reason}); assumindo mayClaim=true (fail-soft)`);
}
const result = shouldClaimNewIssue(
  list.prs.map((p) => p.headRefName).filter((b) => b.startsWith("continuo/")),
  3,
);
// Reusa a mesma saída do gh (sem 2ª chamada) pela mesma função do CLI global.
const global = readOpenPrCap(
  (() => (list.ok
    ? { status: 0, stdout: JSON.stringify(list.prs), stderr: "" }
    : { status: 1, stdout: "", stderr: list.reason ?? "gh falhou" })) as unknown as typeof spawnSync,
);
const combined = combineContinuoCaps(result.mayClaim, global.verified ? global.slots : null);

console.log(JSON.stringify({
  open: result.open,
  cap: result.cap,
  mayClaim: combined.mayClaim,
  heldBy: combined.heldBy,
  counted: result.counted,
  verified: list.ok,
  global: { open: global.open, cap: global.cap, slots: global.slots, verified: global.verified },
}));
