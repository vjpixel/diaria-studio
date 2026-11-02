/**
 * apoio-month-key.ts (#4437, carência de 1 mês do #4436)
 *
 * `previousMonthKey`, módulo próprio e sem dependências. Consumido pela lógica
 * de nível (`lib/apoio-nivel-sync.ts`) e pelo painel Apoios
 * (`scripts/studio-ui/studio-apoios.ts`), que decide quem entra no grupo "ainda
 * não pagou esse mês" (#4437, Entrega 1) com o mesmo raciocínio de virada de ano.
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
