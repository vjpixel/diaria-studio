/**
 * continuo-reject-comment.ts (#7446 item 1)
 *
 * Lógica PURA/testável de dedupe do comentário de rejeição do
 * `continuo-pr-review.sh` (ramo `gate=reject` de `try_merge_gate()`).
 *
 * ## Por que existe
 *
 * Medido ao vivo na PR #7404 (04-05/09/2026): o gate de merge rejeitou
 * corretamente (script órfão inexecutável, achado de um tick interrompido do
 * contínuo) e o bash postou "Gate de merge automático (#6926): rejeitado —
 * {motivo}" a CADA execução do cron (a cada ~120min) — 9 comentários
 * IDÊNTICOS em 18h, porque `reject` nunca vira estado terminal: a PR segue
 * aberta, o gate roda de novo no próximo tick, chega na mesma decisão, e o
 * bash comenta de novo sem checar se já disse exatamente isso.
 *
 * O fix NÃO fecha a PR nem aplica label — ambos mudariam o estado observável
 * da PR além do necessário para parar o spam, e "reject" pode deixar de ser
 * verdadeiro no próximo tick (ex: um push novo muda o veredito da revisão, ou
 * o CI que antes falhava agora passa — nesses casos o motivo muda e o
 * comentário novo É informação nova). A regra mínima que resolve o problema
 * medido: se o ÚLTIMO comentário da PR for byte-a-byte igual ao que este tick
 * ia postar, não duplicar — qualquer motivo novo (CI mudou, veredito mudou,
 * issue relacionada fechou) produz um corpo diferente e passa normalmente.
 *
 * @see hermes/scripts/continuo-pr-review.sh (ramo `2)` de `try_merge_gate()`)
 * @see scripts/lib/continuo-merge-gate.ts (decide a ação `reject`, não o texto)
 */

/**
 * `true` quando o comentário de rejeição que este tick está prestes a postar
 * é idêntico ao último comentário já presente na PR — nesse caso o chamador
 * deve pular o `gh pr comment` (a decisão de rejeitar continua valendo, só
 * não duplica a comunicação).
 *
 * `lastCommentBody`: `null`/`undefined` cobre "PR sem comentários ainda" —
 * nunca conta como duplicata (não há o que deduplicar).
 */
export function shouldSkipDuplicateRejectComment(
  lastCommentBody: string | null | undefined,
  candidateBody: string,
): boolean {
  if (lastCommentBody == null) return false;
  return lastCommentBody === candidateBody;
}
