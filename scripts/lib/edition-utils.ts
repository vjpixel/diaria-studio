/**
 * edition-utils.ts (#655)
 *
 * Helpers para localizar edições anteriores em data/editions/. Usado pelo
 * carry-over (load-carry-over.ts) que reaproveita candidatos não-selecionados
 * da edição imediatamente anterior.
 */

import { existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EDITIONS_DIR = resolve(ROOT, "data", "editions");

const AAMMDD_RE = /^\d{6}$/;

/**
 * Lista todas as pastas de edição válidas (AAMMDD), em ordem decrescente
 * (mais nova primeiro). Aceita um diretório alternativo para testes.
 */
export function listEditions(editionsDir: string = EDITIONS_DIR): string[] {
  if (!existsSync(editionsDir)) return [];
  return readdirSync(editionsDir)
    .filter((name) => AAMMDD_RE.test(name))
    .sort((a, b) => b.localeCompare(a));
}

/**
 * Retorna o AAMMDD da edição imediatamente anterior a `currentAammdd`,
 * ou `null` se não houver. Considera apenas edições que existem no
 * filesystem — a comparação é lexicográfica (AAMMDD bate com ordem
 * cronológica desde que o ano corra de 26 → 27 → ... sem voltar).
 *
 * Comportamento:
 *  - Se `currentAammdd` é a edição mais antiga → retorna null
 *  - Se `currentAammdd` não existe na pasta → retorna a edição
 *    imediatamente anterior na ordem cronológica
 */
export function getPreviousEditionDate(
  currentAammdd: string,
  editionsDir: string = EDITIONS_DIR,
): string | null {
  if (!AAMMDD_RE.test(currentAammdd)) {
    throw new Error(`getPreviousEditionDate: AAMMDD inválido: ${currentAammdd}`);
  }
  const editions = listEditions(editionsDir);
  // Filtra apenas edições estritamente anteriores à atual e pega a mais nova.
  const prev = editions.find((e) => e < currentAammdd);
  return prev ?? null;
}
