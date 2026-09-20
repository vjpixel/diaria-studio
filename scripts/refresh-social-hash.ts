/**
 * refresh-social-hash.ts (#8596)
 *
 * Recalcula `_internal/.social-source-hash.json` a partir de
 * `_internal/01-approved.json`. Use quando o `03-social.md` já foi corrigido
 * (à mão ou por reorder) e o invariante `social-hash-fresh` (stage 4) acusa
 * hash velho — alternativa a re-despachar o social-writer.
 *
 * Uso: npx tsx scripts/refresh-social-hash.ts --edition-dir data/editions/AAMMDD
 *
 * Mesma função de hash do merge-social-md.ts e do invariante
 * (`hashFromApprovedFile`). Exit 1 se 01-approved.json ausente/ilegível.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isMainModule, parseArgsSimple } from "./lib/cli-args.ts";
import { hashFromApprovedFile, writeSocialSourceHash } from "./lib/social-source-hash.ts";

export function refreshSocialHash(editionDir: string): { path: string; hash: string } {
  const internalDir = resolve(editionDir, "_internal");
  const approvedPath = resolve(internalDir, "01-approved.json");
  if (!existsSync(approvedPath)) {
    throw new Error(`01-approved.json ausente: ${approvedPath}`);
  }
  const hash = hashFromApprovedFile(approvedPath);
  return { path: writeSocialSourceHash(internalDir, hash), hash };
}

if (isMainModule(import.meta.url)) {
  const editionDir = parseArgsSimple(process.argv.slice(2))["edition-dir"];
  if (!editionDir) {
    console.error("uso: refresh-social-hash.ts --edition-dir <dir>");
    process.exit(1);
  }
  try {
    const r = refreshSocialHash(editionDir);
    console.log(`refresh-social-hash: OK — ${r.path} (hash ${r.hash})`);
  } catch (e) {
    console.error(`refresh-social-hash: ${(e as Error).message}`);
    process.exit(1);
  }
}
