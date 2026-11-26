/**
 * Invariantes do Stage 4 — helpers usados por mais de uma família (#14057).
 *
 * Família extraída de `../stage-4.ts` (divisão sem mudança de lógica). O
 * registro `STAGE_4_RULES` e o reexport público continuam em `../stage-4.ts`:
 * importe sempre de lá.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// #6336: usado só por checkKitFixtureAudit, pra localizar
// scripts/audit-kit-fixtures.ts a partir de scripts/lib/invariant-checks/.
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

export interface PublicImageEntry {
  url?: string;
  file_id?: string;
  filename?: string;
  /** #1418: md5 dos bytes locais no momento do upload. Ausente em entries pré-#1418. */
  md5?: string;
}

export interface PublicImagesJson {
  images?: Record<string, PublicImageEntry | undefined>;
}
