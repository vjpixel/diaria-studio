/**
 * pr-retido-para-editor.ts (#10278)
 *
 * Sinal MECÂNICO de "PR retida para o editor" — lógica pura, sem I/O.
 *
 * ## Por que existe
 *
 * Incidente #10278 (14/10/2026): o review do `/diaria-overnight` 261014b
 * comentou na PR #10221 "NÃO mergeado pela rodada" (gasto recorrente acima
 * de ~US$ 50/ano exige decisão do editor), e mesmo assim o
 * `continuo-pr-review.sh` mergeou a PR horas depois. O "retido" vivia só em
 * PROSA de comentário — nenhum gate de merge lê prosa. Este módulo dá ao
 * "retido" uma forma que os gates leem:
 *
 * - **label `retido-para-editor`** na PR (forma canônica — o editor libera
 *   removendo a label, sem editar texto nenhum); OU
 * - **marcador `<!-- retido-para-editor -->` no CORPO da PR** (para quem só
 *   consegue editar o corpo; o editor libera apagando o marcador).
 *
 * Comentários NÃO contam, de propósito: um comentário não se "desfaz" sem
 * apagar histórico, então um marcador em comentário prenderia a PR para
 * sempre ou exigiria um segundo marcador de liberação com regra de
 * precedência — complexidade sem ganho, já que label e corpo são ambos
 * editáveis por quem retém.
 *
 * ## Fail-closed
 *
 * `labels` ilegível (payload sem o campo, ou não-array) → `retido: null`.
 * Os consumidores tratam `null` como "não mergear sozinho" (escalate), nunca
 * como "não retido" — a mesma direção segura do `sensitive: null` do
 * `continuo-merge-gate.ts`. Corpo ausente/não-string só significa "sem
 * marcador no corpo" (PR sem corpo é legítima), não ilegibilidade.
 *
 * Consumidores:
 * - `scripts/lib/continuo-merge-gate.ts` (portão de merge do
 *   `continuo-pr-review.sh`, via `scripts/check-continuo-merge-gate.ts`);
 * - `scripts/check-pr-retido-gate.ts` (condição 3 do gate determinístico de
 *   merge do `/diaria-overnight`, Fase 0 passo 2b e Fase 1 passo 3; também
 *   do Gate 2 do `/diaria-develop` e do `/diaria-continuo`, #10294);
 * - `scripts/lib/merge-train-live.ts` (`partitionRetidoCandidates` exclui a
 *   PR do trem na descoberta; `revalidateGate2` relê no instante do merge e
 *   tira só ela do lote — `scripts/run-merge-train.ts`, #10294).
 */

export const RETIDO_PARA_EDITOR_LABEL = "retido-para-editor";
export const RETIDO_PARA_EDITOR_MARKER = "<!-- retido-para-editor -->";
/**
 * Casa o marcador tolerando espaço e caixa (#10349): `<!--retido-para-editor-->`
 * e `<!-- Retido-Para-Editor -->` também retêm — mesma normalização que a label
 * recebe (trim + lowercase). Sem isso, uma retenção manual fora da forma exata
 * passava pelo gate e a PR era mergeada.
 */
export const RETIDO_PARA_EDITOR_MARKER_RE = /<!--\s*retido-para-editor\s*-->/i;

export interface PrRetidoInput {
  /** `labels` cru do `gh pr view --json labels` — array de `{name}`. */
  labels: unknown;
  /** `body` cru do `gh pr view --json body`. */
  body: unknown;
}

export interface PrRetidoResult {
  /** `true` = retida; `false` = livre; `null` = não foi possível ler as
   *  labels (fail-closed: tratar como retida pelos consumidores). */
  retido: boolean | null;
  reason: string;
}

function labelNames(labels: unknown): string[] | null {
  if (!Array.isArray(labels)) return null;
  const names: string[] = [];
  for (const l of labels) {
    if (typeof l === "string") names.push(l);
    else if (l && typeof l === "object" && typeof (l as { name?: unknown }).name === "string") {
      names.push((l as { name: string }).name);
    } else {
      return null;
    }
  }
  return names;
}

export function evaluatePrRetido(input: PrRetidoInput): PrRetidoResult {
  const names = labelNames(input.labels);
  if (names === null) {
    return {
      retido: null,
      reason: "labels da PR ilegíveis — fail-closed, tratar como retida",
    };
  }
  if (names.some((n) => n.trim().toLowerCase() === RETIDO_PARA_EDITOR_LABEL)) {
    return {
      retido: true,
      reason: `label '${RETIDO_PARA_EDITOR_LABEL}' presente — retida para o editor (#10278)`,
    };
  }
  if (typeof input.body === "string" && RETIDO_PARA_EDITOR_MARKER_RE.test(input.body)) {
    return {
      retido: true,
      reason: `marcador ${RETIDO_PARA_EDITOR_MARKER} no corpo da PR — retida para o editor (#10278)`,
    };
  }
  return { retido: false, reason: "sem sinal de retenção" };
}
