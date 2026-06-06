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

/**
 * #1680: validação ESTRITA de nome de pasta de edição AAMMDD — 6 dígitos +
 * mês 01-12 + dia 01-31. Consolidada aqui (era duplicada em `dedup.ts`, que
 * agora re-exporta). Substitui o `/^\d{6}$/` frouxo anterior: barra sentinels
 * como `260999` (dia 99) e `261301` (mês 13), que NÃO devem entrar na lista de
 * edições reais (carry-over/getPreviousEditionDate não devem tratá-los como
 * edição anterior).
 */
export function isValidEditionDir(name: string): boolean {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(name);
  if (!m) return false;
  const year = 2000 + Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  // #1811: calendar-aware — rejeita dias impossíveis pro mês (260631 = 31 jun,
  // 260229 em ano não-bissexto). Dia 0 do mês seguinte = último dia deste (UTC).
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= lastDay;
}

/**
 * Lista todas as pastas de edição válidas (AAMMDD), em ordem decrescente
 * (mais nova primeiro). Aceita um diretório alternativo para testes.
 */
export function listEditions(editionsDir: string = EDITIONS_DIR): string[] {
  if (!existsSync(editionsDir)) return [];
  return readdirSync(editionsDir)
    .filter((name) => isValidEditionDir(name))
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
  if (!isValidEditionDir(currentAammdd)) {
    throw new Error(`getPreviousEditionDate: AAMMDD inválido: ${currentAammdd}`);
  }
  const editions = listEditions(editionsDir);
  // Filtra apenas edições estritamente anteriores à atual e pega a mais nova.
  const prev = editions.find((e) => e < currentAammdd);
  return prev ?? null;
}

