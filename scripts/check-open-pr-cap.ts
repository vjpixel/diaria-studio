#!/usr/bin/env npx tsx
/**
 * CLI: teto global de PRs abertos (#12765). Ver `scripts/lib/open-pr-cap.ts`.
 *
 * Saída (stdout, JSON): `{"verified":true,"open":N,"cap":10,"slots":S,"counted":[...]}`.
 * Exit 0 = medido. Exit 2 = `gh` falhou: `verified:false`, `slots` = teto
 * cheio (fail-soft, #738 — infra caída não trava a rodada), motivo no stderr.
 * Quem consome trata `verified:false` como "não verificado", nunca como
 * "fila vazia".
 */
import { spawnSync } from "node:child_process";
import { isMainModule } from "./lib/cli-args.ts";
import { computeOpenPrSlots, OPEN_PR_CAP, type OpenPrLike, type OpenPrSlots } from "./lib/open-pr-cap.ts";

export type OpenPrCapResult = (OpenPrSlots & { verified: true }) | (OpenPrSlots & { verified: false; reason: string });

export function readOpenPrCap(run: typeof spawnSync = spawnSync): OpenPrCapResult {
  const res = run(
    "gh",
    ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,headRefName,author"],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (res.error || res.status !== 0) {
    const reason = String(res.stderr ?? "").trim() || res.error?.message || `gh saiu ${res.status}`;
    return { ...computeOpenPrSlots([]), verified: false, reason };
  }
  try {
    const prs = JSON.parse(String(res.stdout || "[]")) as OpenPrLike[];
    if (!Array.isArray(prs)) throw new Error("saída do gh não é array");
    if (prs.length >= 200) throw new Error("limite de paginação atingido (200) — contagem truncada");
    return { ...computeOpenPrSlots(prs, OPEN_PR_CAP), verified: true };
  } catch (e) {
    return { ...computeOpenPrSlots([]), verified: false, reason: String(e) };
  }
}

if (isMainModule(import.meta.url)) {
  const result = readOpenPrCap();
  if (!result.verified) {
    console.error(`[check-open-pr-cap] não verificado (${result.reason}); assumindo teto cheio de vagas (fail-soft)`);
  }
  console.log(JSON.stringify(result));
  process.exitCode = result.verified ? 0 : 2;
}
