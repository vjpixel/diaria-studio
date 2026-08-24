/**
 * file-md5.ts (#6068 — extraído de `scripts/upload-images-public.ts`, #1418)
 *
 * `md5OfFile` nasceu dentro do `upload-images-public.ts`, que roda
 * `loadProjectEnv()` no topo do módulo e puxa `google-auth`/googleapis junto.
 * Importar aquele script de dentro de um invariante (`invariant-checks/`) só
 * pra ter o md5 carregaria .env e a stack do Drive em todo
 * `check-invariants.ts` — daí a extração. O script original re-exporta esta
 * função, então nenhum caller antigo muda.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

/** #1418: md5 hex de um arquivo, pra detectar drift entre local e cache. */
export function md5OfFile(path: string): string {
  const bytes = readFileSync(path);
  return createHash("md5").update(bytes).digest("hex");
}
