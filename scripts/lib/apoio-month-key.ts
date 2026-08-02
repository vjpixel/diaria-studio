/**
 * apoio-month-key.ts (#4437 — extraído de sync-apoio-nivel-beehiiv.ts, #4436)
 *
 * `previousMonthKey` nasceu em `scripts/sync-apoio-nivel-beehiiv.ts` (#4436,
 * carência de 1 mês pro sync de nível de recompensa pra Beehiiv). O painel
 * Apoios (`scripts/studio-ui/studio-apoios.ts`) precisa da MESMA função pra
 * decidir quem entra no grupo "ainda não pagou esse mês" (#4437, Entrega 1) —
 * mesma carência de 1 mês, mesmo raciocínio de virada de ano.
 *
 * Mas `sync-apoio-nivel-beehiiv.ts` já importa DE `studio-apoios.ts`
 * (`buildApoiosData`, `computeRewardGroup`, `readPastMonthSnapshots`) — se
 * `previousMonthKey` continuasse lá, importar de volta em `studio-apoios.ts`
 * criaria um ciclo de módulos ES (`studio-apoios.ts` → `sync-apoio-nivel-
 * beehiiv.ts` → `studio-apoios.ts`). Extraído pra este módulo PRÓPRIO (zero
 * dependências) resolve o ciclo sem duplicar a lógica — `sync-apoio-nivel-
 * beehiiv.ts` reexporta o símbolo, então nenhum import existente (inclusive
 * `test/sync-apoio-nivel-beehiiv.test.ts`) precisa mudar de path.
 */

/**
 * Pure: mês anterior a `monthKey` (formato `YYYY-MM`), com virada de ano
 * (`2026-01` → `2025-12`). Lança em formato inesperado — nunca produz um mês
 * inválido silenciosamente (o resultado alimenta uma busca de carência que,
 * se errada, pode reviver ou matar recompensa/visibilidade indevidamente).
 */
export function previousMonthKey(monthKey: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) throw new Error(`previousMonthKey: formato inesperado '${monthKey}' (esperado YYYY-MM)`);
  let year = Number(m[1]);
  let month = Number(m[2]) - 1;
  if (month < 1) {
    month = 12;
    year -= 1;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}
