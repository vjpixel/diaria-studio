/**
 * continuo-reject-owner.ts (#7567)
 *
 * Lógica PURA/testável de "reject ganha um dono" — mesmo mecanismo do
 * #7446 item 2 (`continuo-escalate-owner.ts`), aplicado ao ramo `gate=reject`
 * de `try_merge_gate()` em `hermes/scripts/continuo-pr-review.sh`.
 *
 * Até aqui, `gate=reject` só postava um comentário (deduplicado desde o
 * #7446 item 1 — `check-continuo-reject-comment-dedupe.ts`) e incrementava
 * um contador local (`REJECTED` no bash) — a PR ficava sem NENHUM sinal
 * externo persistente: nenhum label, nenhuma notificação, nada que um
 * humano ou o `hermes-diaria-continuo` consiga filtrar/buscar depois do 1º
 * tick (o comentário deduplicado para de aparecer de novo justamente para
 * não poluir, mas isso também apaga o único rastro visível). Medido ao vivo
 * na issue #7567: PR #7593 recebeu `verdict=reject` (23:40 UTC, 07/09) e
 * seguiu aberta, sem label nem menção em nenhum resumo de tick seguinte,
 * até virar achado manual desta investigação — mesma classe do #7446 item 2
 * (que resolveu o problema irmão do lado `escalate`), nunca fechada do lado
 * `reject`.
 *
 * A correção: labelar a PR na primeira vez que ela é rejeitada (dono
 * declarado — decidir entre consertar, no caso de branch `continuo/*` com
 * CI vermelho ver #7446 item 3, ou fechar como superseded/lixo, ver
 * `hermes-diaria-continuo/SKILL.md` §3 passo 1) e notificar (via stdout, que
 * o cron do Hermes entrega ao Telegram) só nessa primeira vez — ticks
 * seguintes continuam contando `REJECTED` no resumo, sem repetir o aviso.
 *
 * @see scripts/check-continuo-reject-label.ts (I/O: `gh pr view`/`gh pr edit`)
 * @see scripts/lib/continuo-escalate-owner.ts (mesmo padrão, lado `escalate`)
 * @see hermes/scripts/continuo-pr-review.sh (ramo `2)` de `try_merge_gate()`)
 */

export const CONTINUO_REJECTED_LABEL = "continuo-rejeitado";

/** `true` quando a PR JÁ tem o label de rejeição — o chamador deve pular a
 * notificação "primeira vez" (só contar, não repetir o aviso). */
export function isAlreadyRejectLabeled(labels: string[]): boolean {
  return labels.includes(CONTINUO_REJECTED_LABEL);
}
