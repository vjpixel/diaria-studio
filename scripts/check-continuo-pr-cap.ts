#!/usr/bin/env node
/**
 * CLI: verifica teto de PRs continuo/* abertas (#7746).
 * Saída JSON: {open, cap, mayClaim, counted}
 * Fail-soft: se gh falhar → mayClaim=true, counted=[], motivo visível no stderr.
 */
import { spawnSync } from "child_process";
import { shouldClaimNewIssue } from "./lib/continuo-pr-cap.js";

function ghList(): { ok: boolean; branches: string[]; reason?: string } {
  const res = spawnSync(
    "gh",
    ["pr", "list", "--repo", "vjpixel/diaria-studio", "--state", "open", "--json", "headRefName", "--limit", "100"],
    { encoding: "utf8", timeout: 15000 }
  );
  if (res.error || res.status !== 0) {
    return { ok: false, branches: [], reason: res.stderr?.trim() || res.error?.message || "gh falhou" };
  }
  try {
    const arr = JSON.parse(res.stdout || "[]") as Array<{ headRefName: string }>;
    const branches = arr
      .map((r) => r.headRefName)
      .filter((b): b is string => typeof b === "string" && b.startsWith("continuo/"));
    return { ok: true, branches };
  } catch (e) {
    return { ok: false, branches: [], reason: String(e) };
  }
}

const list = ghList();
let result: ReturnType<typeof shouldClaimNewIssue>;

if (!list.ok) {
  // Fail-soft na direção de PERMITIR (não trava tick por infra), #7746
  result = shouldClaimNewIssue([], 3);
  // Ajustar: quando gh falha, contamos 0 abertas, portanto mayClaim=true
  // Mas queremos sinalizar falha — expomos motivo via stderr, não alteramos JSON
  console.error(`continuo-pr-cap: gh falhou (${list.reason}); assumindo mayClaim=true (fail-soft)`);
} else {
  result = shouldClaimNewIssue(list.branches, 3);
}

console.log(JSON.stringify({
  open: result.open,
  cap: result.cap,
  mayClaim: result.mayClaim,
  counted: result.counted,
}));
