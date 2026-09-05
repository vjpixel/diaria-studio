/**
 * continuo-escalate-owner.ts (#7446 item 2)
 *
 * Lógica PURA/testável de "escalate ganha um dono": até aqui, `gate=escalate`
 * (portões 3-9 de `continuo-merge-gate.ts`) só logava e incrementava um
 * contador — a PR ficava implicitamente esperando o pickup do
 * `/diaria-overnight` (sem agendador, só roda quando o editor inicia uma
 * rodada) sem NENHUM sinal externo. Medido ao vivo: PR #7432 (review
 * `approve`, escalada por CI vermelho) parada 15h, achada só por observação
 * humana casual, não por alarme.
 *
 * A correção: labelar a PR na primeira vez que ela escala (dono declarado —
 * revisão humana ou pickup do overnight) e notificar (via stdout, que o cron
 * do Hermes entrega ao Telegram) só NESSA primeira vez — ticks seguintes
 * continuam contando no resumo, sem repetir o aviso a cada ~120min.
 *
 * @see scripts/check-continuo-escalate-label.ts (I/O: `gh pr view`/`gh pr edit`)
 * @see hermes/scripts/continuo-pr-review.sh (ramo `1)` de `try_merge_gate()`)
 */

export const CONTINUO_ESCALATED_LABEL = "continuo-escalado";

/** `true` quando a PR JÁ tem o label de escalação — o chamador deve pular a
 * notificação "primeira vez" (só contar, não repetir o aviso). */
export function isAlreadyEscalated(labels: string[]): boolean {
  return labels.includes(CONTINUO_ESCALATED_LABEL);
}
