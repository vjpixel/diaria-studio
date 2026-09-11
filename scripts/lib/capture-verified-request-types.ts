/**
 * scripts/lib/capture-verified-request-types.ts (#7981, Camada 3 da #7972 — Fase 7)
 *
 * "capture-verified:true por tipo de pedido" (issue #7981) — quais
 * `RequestType` (`scripts/log-editor-request.ts`) `distill-prompt-
 * corrections.ts` pode usar como base pra destilar prompt de GERAÇÃO DE
 * TEXTO, decidido a partir de 2 critérios que precisam ser AMBOS
 * verdadeiros:
 *
 * 1. **Captura corrigida pelo Camada 0 (#7974)** — os 3 bugs de captura
 *    fixados por #7974 (`eia-choice` comparando chave errada,
 *    `social-rewrite` falso-positivo por URL não-resolvida,
 *    `REQUEST_TYPE_ARTIFACT_MAP` apontando pro artefato errado pra
 *    title-choice/title-length/lead-rewrite/length-cut/tone) — sem essas
 *    correções, o sinal capturado desses tipos era comprovadamente
 *    incorreto, então destilar prompt sobre dado incorreto seria pior que
 *    não destilar.
 * 2. **Mapeia pra um artefato de GERAÇÃO DE TEXTO** — exclui tipos cujo
 *    `REQUEST_TYPE_ARTIFACT_MAP` (`collect-edition-signals.ts`) aponta pra
 *    rubrico de score (`destaque-swap`/`destaque-promote`/`destaque-cut`/
 *    `bucket-move`/`pool-cut`/`pool-add` — território da Camada 2/#7990,
 *    não desta fase) ou pra config/template determinístico sem prompt
 *    (`link-swap`/`section-order`, #7974 body: "saem do escopo de
 *    prompt"). `image-redo`/`image-crop` também ficam de fora — os 4
 *    checks do backtest desta fase (`distillation-backtest.ts`) são todos
 *    de TEXTO, nenhum cobre prompt de imagem; distilar imagem é escopo
 *    natural de uma extensão futura, não desta 1ª rodada.
 *
 * Resultado: 8 tipos — `title-choice`, `title-length`, `lead-rewrite`,
 * `tone`, `length-cut`, `social-rewrite`, `factual-correction`,
 * `eia-choice`. Decisão registrada aqui, não re-derivada por heurística em
 * cada chamada (mesmo padrão de `issue-decisions.ts` citado no CLAUDE.md).
 */

import type { RequestType } from "../log-editor-request.ts";

export const CAPTURE_VERIFIED_REQUEST_TYPES: ReadonlyArray<RequestType> = [
  "title-choice",
  "title-length",
  "lead-rewrite",
  "tone",
  "length-cut",
  "social-rewrite",
  "factual-correction",
  "eia-choice",
];

const CAPTURE_VERIFIED_SET: ReadonlySet<RequestType> = new Set(CAPTURE_VERIFIED_REQUEST_TYPES);

export function isCaptureVerifiedRequestType(requestType: string): requestType is RequestType {
  return CAPTURE_VERIFIED_SET.has(requestType as RequestType);
}
