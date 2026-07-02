/**
 * test/_helpers/make-edition-dir.ts
 *
 * Cria um diretório temporário de edição com `_internal/` já criado —
 * fixture repetida byte-idêntica (exceto o prefixo do tmpdir) em
 * consent-binding-invariant.test.ts, merge-social-md.test.ts e
 * stage-4-review-completed.test.ts (#2836). Uso: `makeEditionDir("meu-prefixo-")`.
 */
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeEditionDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}
