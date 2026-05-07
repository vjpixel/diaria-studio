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

/**
 * Retorna AAMMDD da primeira edição publicada no mês corrente (BRT),
 * ou null se não houver nenhuma. Usado pelo cutoff do drain Gmail no
 * sorteio (#852 follow-up): pegar todas threads do mês todo, deixando
 * findByThreadId ser a defesa de idempotência.
 *
 * Mês corrente é determinado pelo `now` em BRT (UTC-3) — não UTC.
 * Antes da virada de mês, evita pegar edições do mês anterior.
 */
export function firstEditionOfCurrentMonth(
  now: Date = new Date(),
  editionsDir: string = EDITIONS_DIR,
): string | null {
  // Convert UTC → BRT (UTC-3). Edge case: no início do mês UTC, BRT ainda
  // pode estar no mês anterior por ~3h. Usar BRT é consistente com regra
  // editorial #716 (timestamps editor-facing em BRT).
  const brtNow = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  const yy = String(brtNow.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(brtNow.getUTCMonth() + 1).padStart(2, "0");
  const monthPrefix = `${yy}${mm}`;
  const editions = listEditions(editionsDir);
  // Filtra edições do mês corrente, pega a menor (mais antiga).
  const ofMonth = editions.filter((e) => e.startsWith(monthPrefix)).sort();
  return ofMonth[0] ?? null;
}

/**
 * Converte AAMMDD pra string Gmail-query no formato YYYY/MM/DD.
 *
 *   "260504" → "2026/05/04"
 */
export function aammddToGmailDate(aammdd: string): string {
  if (!AAMMDD_RE.test(aammdd)) {
    throw new Error(`aammddToGmailDate: AAMMDD inválido: ${aammdd}`);
  }
  const yyyy = `20${aammdd.slice(0, 2)}`;
  const mm = aammdd.slice(2, 4);
  const dd = aammdd.slice(4, 6);
  return `${yyyy}/${mm}/${dd}`;
}
