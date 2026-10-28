#!/usr/bin/env npx tsx
/** #11372: executar imediatamente antes de cada push numa PR existente. */
import { spawnSync } from "node:child_process";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";

export function checkPrOpenForPush(state: unknown): { ok: boolean; reason: string } {
  if (state === "OPEN") return { ok: true, reason: "PR aberta" };
  if (state === "MERGED" || state === "CLOSED") return {
    ok: false, reason: `PR já ${state === "MERGED" ? "mergeada" : "fechada"}; abrir follow-up — não fazer push`,
  };
  return { ok: false, reason: "estado da PR desconhecido; não fazer push" };
}
if (isMainModule(import.meta.url)) {
  try {
    const { values } = parseArgs(process.argv.slice(2));
    const pr = Number(values.pr);
    if (!Number.isInteger(pr) || pr <= 0) throw new Error("uso: --pr N [--repo owner/name]");
    const r = spawnSync("gh", ["pr", "view", String(pr), ...(values.repo ? ["-R", values.repo] : []), "--json", "state"], { encoding: "utf8", timeout: 30_000 });
    if (r.error || r.status !== 0) throw new Error(`gh falhou: ${r.error?.message ?? r.stderr}`);
    const result = checkPrOpenForPush(JSON.parse(r.stdout).state);
    console.log(JSON.stringify(result));
    if (!result.ok) console.error(result.reason);
    process.exitCode = result.ok ? 0 : 1;
  } catch (e) { console.error(String(e)); process.exitCode = 3; }
}
