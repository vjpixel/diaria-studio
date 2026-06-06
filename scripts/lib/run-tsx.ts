/**
 * run-tsx.ts (#1811)
 *
 * Helper único pra spawnar um script `.ts` via `node --import tsx` (sem npx
 * middleware, sem `shell:true` — args com espaços preservados, #213). Consolida
 * as cópias quase-idênticas de `eia-compose.ts` (runScript) e
 * `preflight-poll-dispatch.ts` (defaultRunner), que divergiam só no tratamento
 * de stdout.
 *
 * `--import tsx` registra os loader hooks do tsx (tsx 4.7+).
 */

import { execFileSync } from "node:child_process";

export type TsxStdout = "ignore" | "capture" | "inherit";

/** Pure: mapeia o modo de stdout pro valor de stdio do child (stdin/stderr sempre inherit). */
export function tsxStdio(mode: TsxStdout): ["inherit", "ignore" | "pipe" | "inherit", "inherit"] {
  const out = mode === "capture" ? "pipe" : mode === "ignore" ? "ignore" : "inherit";
  return ["inherit", out, "inherit"];
}

export interface RunTsxOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * `inherit` (default): stream pro terminal. `ignore`: descarta stdout (eia —
   * não polui o JSON de saída). `capture`: pipa e RETORNA o stdout (preflight).
   */
  stdout?: TsxStdout;
}

/**
 * Roda `node --import tsx <script> <args...>`. Retorna o stdout capturado quando
 * `stdout: "capture"`, senão "". Lança (execFileSync) em exit ≠ 0 — o caller
 * trata.
 */
export function runTsx(script: string, args: string[], opts: RunTsxOpts = {}): string {
  const mode = opts.stdout ?? "inherit";
  const out = execFileSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: tsxStdio(mode),
    encoding: mode === "capture" ? "utf8" : undefined,
  });
  return mode === "capture" ? (out as string) ?? "" : "";
}
