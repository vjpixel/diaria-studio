/**
 * Helper cross-platform para spawnSync com npx (#311).
 * Em Windows, spawnSync('npx', ...) falha com ENOENT porque npx sem extensão não
 * é encontrado no PATH. Solução: usar shell:true que resolve via cmd.exe no Windows
 * e /bin/sh no Unix.
 *
 * ## Ressalva medida no #6206 — `shell: true` não é neutro
 *
 * `shell: true` resolve o ENOENT, mas passa a linha por `cmd.exe`, que reprocessa
 * o quoting dos argumentos. Caminho ABSOLUTO do Windows passado como argumento
 * (`C:\Users\...`) pode chegar deformado do outro lado — foi o que aconteceu em
 * `test/file-lock.test.ts`, onde o caminho ainda virava especificador ESM e
 * estourava `ERR_UNSUPPORTED_ESM_URL_SCHEME` (`c:` lido como scheme) mesmo com
 * este helper.
 *
 * **Para spawnar um script TS deste repo, prefira spawnar o próprio node:**
 *
 * ```ts
 * spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], { cwd })
 * ```
 *
 * Dispensa shell (nada reprocessa o quoting), dispensa a resolução do `npx`, e é
 * o idioma que a produção já usa (`scripts/lib/run-tsx.ts` e vizinhos). O #6206
 * migrou 4 arquivos assim; os demais chamadores deste helper seguem funcionando
 * — só não use `spawnNpx` para caso novo que passe caminho absoluto como
 * argumento.
 */
import { spawnSync, type SpawnSyncOptions } from "node:child_process";

export const isWindows = process.platform === "win32";
// Em Windows, usamos sempre 'npx' mas com shell:true pra resolver via cmd.exe
export const NPX = "npx";

export function spawnNpx(args: string[], opts: SpawnSyncOptions = {}) {
  return spawnSync(NPX, args, { shell: isWindows, ...opts });
}
