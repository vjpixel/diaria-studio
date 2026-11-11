#!/usr/bin/env node
/**
 * CLI: verifica teto de PRs continuo/* abertas (#7746) E o teto global de PRs
 * abertas no repo (#12765, `scripts/lib/open-pr-cap.ts`).
 * Saída JSON: {open, cap, mayClaim, counted, global: {open, cap, slots}}
 * `mayClaim` só é true se os DOIS tetos têm vaga: o contínuo não abre PR nova
 * enquanto o repo inteiro estiver no teto, mesmo com poucas `continuo/*`.
 * Fail-soft: se gh falhar → mayClaim=true, counted=[], motivo visível no stderr.
 */
import { spawnSync } from "child_process";
import { shouldClaimNewIssue } from "./lib/continuo-pr-cap.js";
import { computeOpenPrSlots, type OpenPrLike } from "./lib/open-pr-cap.ts";

function ghList(): { ok: boolean; prs: OpenPrLike[]; reason?: string } {
  const res = spawnSync(
    "gh",
    ["pr", "list", "--repo", "vjpixel/diaria-studio", "--state", "open", "--json", "number,headRefName,author", "--limit", "200"],
    { encoding: "utf8", timeout: 15000 }
  );
  if (res.error || res.status !== 0) {
    return { ok: false, prs: [], reason: res.stderr?.trim() || res.error?.message || "gh falhou" };
  }
  try {
    const arr = JSON.parse(res.stdout || "[]") as OpenPrLike[];
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
const global = computeOpenPrSlots(list.prs);

console.log(JSON.stringify({
  open: result.open,
  cap: result.cap,
  mayClaim: result.mayClaim && global.slots > 0,
  counted: result.counted,
  global: { open: global.open, cap: global.cap, slots: global.slots },
}));
