/**
 * Helper cross-platform para spawnSync com npx (#311).
 * Em Windows, spawnSync('npx', ...) falha com ENOENT porque npx sem extensão não
 * é encontrado no PATH. Solução: usar shell:true que resolve via cmd.exe no Windows
 * e /bin/sh no Unix.
 */
import { spawnSync, type SpawnSyncOptions } from "node:child_process";

export const isWindows = process.platform === "win32";
// Em Windows, usamos sempre 'npx' mas com shell:true pra resolver via cmd.exe
export const NPX = "npx";

export function spawnNpx(args: string[], opts: SpawnSyncOptions = {}) {
  return spawnSync(NPX, args, { shell: isWindows, ...opts });
}
