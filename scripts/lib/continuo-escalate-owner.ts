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
 * @see scripts/check-continuo-escalate-label.ts (I/O: `gh pr view` + REST, #7704)
 * @see hermes/scripts/continuo-pr-review.sh (ramo `1)` de `try_merge_gate()`)
 */

export const CONTINUO_ESCALATED_LABEL = "continuo-escalado";

/** `true` quando a PR JÁ tem o label de escalação — o chamador deve pular a
 * notificação "primeira vez" (só contar, não repetir o aviso). */
export function isAlreadyEscalated(labels: string[]): boolean {
  return labels.includes(CONTINUO_ESCALATED_LABEL);
}

/**
 * #9184: marcador durável do SHA do head escalado. O watcher
 * (`hermes/scripts/watch-continuo-health.sh` §9) só exclui a PR escalada do
 * alarme de fila parada enquanto `headRefOid` for IGUAL ao último SHA
 * marcado — push depois da escalada volta a contar, e re-escalada do head
 * novo grava um marcador novo (o evento `labeled` não se repete quando a
 * label já está na PR, por isso comparar datas não servia).
 */
export const ESCALATE_HEAD_MARKER_RE = /<!-- continuo-escalate: head=([0-9a-f]{7,40}) -->/g;

export function formatEscalateHeadMarker(headSha: string): string {
  return `<!-- continuo-escalate: head=${headSha} -->`;
}

/** Último SHA marcado nos corpos de comentário (em ordem cronológica), ou `null`. */
export function lastEscalatedHead(commentBodies: string[]): string | null {
  let last: string | null = null;
  for (const body of commentBodies) {
    for (const m of body.matchAll(ESCALATE_HEAD_MARKER_RE)) last = m[1];
  }
  return last;
}

/** `true` quando é preciso gravar um marcador novo pra este head. */
export function needsEscalateHeadMarker(commentBodies: string[], headSha: string): boolean {
  return lastEscalatedHead(commentBodies) !== headSha;
}
