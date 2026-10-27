/**
 * Manchete em Title Case (padrão de veículo em inglês: "AI Breaches Are
 * Exploding"): ≥60% das palavras de 3+ letras com inicial maiúscula. Nesse caso
 * a maiúscula não indica nome próprio.
 *
 * Fonte única desde #11218 — antes vivia privada em `fact-recurrence.ts`.
 * Não serve pra título CURTO cheio de nomes próprios (os nomes sozinhos passam
 * dos 60%): por isso o `HOW_NAMED_ENTITY_USED_RE` de `launch-heuristics.ts`
 * usa a caixa do verbo como sinal de Title Case, não esta função.
 */
export function isTitleCase(title: string): boolean {
  const words = title.match(/\p{L}{3,}/gu) ?? [];
  if (words.length < 3) return false;
  return words.filter(w => /^\p{Lu}/u.test(w)).length / words.length >= 0.6;
}
