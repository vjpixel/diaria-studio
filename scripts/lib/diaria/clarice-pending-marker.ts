/**
 * clarice-pending-marker.ts (#13711) — só o caminho e a existência do marcador
 * `_internal/02-clarice-pending.json` (#12257), sem dependências.
 *
 * Vive fora de `clarice-pending.ts` porque aquele módulo importa
 * `newsletter-parse.ts`, e o parser precisa saber se a Clarice está pendente
 * para tirar do rodapé a frase "A revisão foi feita pelo MCP da Clarice"
 * (`clarice-review-credit.ts`). Importar `clarice-pending.ts` do parser fecharia
 * um ciclo de import. `clarice-pending.ts` reexporta tudo daqui, então os
 * consumidores antigos não mudam.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export const CLARICE_PENDING_REL = join("_internal", "02-clarice-pending.json");

export function claricePendingPath(editionDir: string): string {
  return join(editionDir, CLARICE_PENDING_REL);
}

/** Há revisão da Clarice pendente? (o arquivo existe, legível ou não) */
export function isClaricePending(editionDir: string): boolean {
  return existsSync(claricePendingPath(editionDir));
}
