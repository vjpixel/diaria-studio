/**
 * Lógica pura: deve reivindicar issue nova do contínuo?
 * @param openPrBranches lista de nomes de branches `continuo/*` abertas (já filtrado)
 * @param cap teto (padrão 3)
 * @returns {mayClaim: boolean, open: number, cap: number, counted: string[]}
 *
 * Regras (#7746):
 * - Conta TODAS as abertas (não só sem veredito).
 * - Exclui drafts de resgate (`continuo/rescue-*`).
 * - Se >= cap → false (trabalha própria fila).
 * - Fail-soft: a função nunca lança; quem chama trata gh-falha.
 */
export function shouldClaimNewIssue(
  openPrBranches: string[],
  cap = 3
): { mayClaim: boolean; open: number; cap: number; counted: string[] } {
  // Excluir resgate (draft de recuperação, #7130 / #7742)
  const counted = openPrBranches.filter(
    (b) => !b.startsWith("continuo/rescue-")
  );
  const open = counted.length;
  return {
    mayClaim: open < cap,
    open,
    cap,
    counted,
  };
}
