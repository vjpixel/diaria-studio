/**
 * scripts/lib/shared/subscriber-union.ts (#6048)
 *
 * Combina o veredicto de VÁRIAS fontes sobre "esta pessoa é assinante?".
 *
 * ## Por que união, e não "migrar de uma pra outra"
 *
 * Decisão do editor (26/08/2026). Durante a migração Beehiiv → Kit as duas
 * bases coexistem, e **as duas opções puras erram — em direções opostas**:
 *
 * | ler só de | quem é classificado errado |
 * |---|---|
 * | KV/Beehiiv | quem cadastrou pelo Kit vira "não-assinante" — fatia que só cresce |
 * | Kit | os 585 importados viram "não-assinante" — a base inteira de hoje |
 *
 * Sob o desenho de partição por origem de cadastro (Beehiiv = base legada
 * congelada, Kit = cadastros pós-cutover), os dois conjuntos são
 * **disjuntos** — então a união não corre risco de dupla contagem: ela é
 * literalmente a base completa.
 *
 * ## A regra que a decisão exige, e que não existia antes
 *
 * > "Falha de UMA das fontes não pode virar 'não-assinante'."
 *
 * Esse é o modo de falha ruim aqui: o votante perde o crédito de assinante
 * sem ninguém notar. Uma fonte fora do ar **não sabe** que a pessoa não é
 * assinante — ela não sabe nada. Colapsar isso em "não" é inventar uma
 * resposta que ninguém deu.
 *
 * Por isso `verification_failed` VENCE qualquer conclusão negativa: enquanto
 * uma fonte está quebrada, não dá pra afirmar o negativo. Só o positivo é
 * conclusivo sozinho — se QUALQUER fonte diz "active", a pessoa é assinante,
 * e o que as outras dizem (ou deixam de dizer) não muda isso.
 *
 * É o mesmo eixo do #4321, que separou `verification_failed` de `unknown`
 * exatamente para impedir que uma key rotacionada virasse "não é assinante".
 */
import type { SubscriberVerifyState } from "./subscriber-verify.ts";

export type { SubscriberVerifyState };

/**
 * Precedência, e o porquê de cada degrau:
 *
 * 1. `active` — positivo de UMA fonte basta; as demais não podem revogá-lo
 *    (sob partição por origem, cada pessoa vive em uma base só).
 * 2. `verification_failed` — alguma fonte não respondeu. **Nunca concluir
 *    negativo com uma fonte cega**: a quebrada podia ser justamente a que
 *    diria "active".
 * 3. `inactive` — alguém verificou e a pessoa saiu/bounceou. Resposta real.
 * 4. `unknown` — todas responderam "não conheço este e-mail".
 *
 * Lista vazia ⇒ `unknown`: nenhuma fonte consultada não é o mesmo que
 * "verificamos e não achamos".
 */
export function resolveSubscriberUnion(states: readonly SubscriberVerifyState[]): SubscriberVerifyState {
  if (states.includes("active")) return "active";
  if (states.includes("verification_failed")) return "verification_failed";
  if (states.includes("inactive")) return "inactive";
  return "unknown";
}

export interface SourceResult {
  /** Nome da fonte, pra diagnóstico — ex.: "kv", "beehiiv", "kit". */
  source: string;
  state: SubscriberVerifyState;
}

export interface UnionOutcome {
  state: SubscriberVerifyState;
  /** Fonte que produziu o `active`, quando houver — útil pra medir migração. */
  activeSource?: string;
  /** Fontes que falharam, pra logar sem esconder degradação. */
  failedSources: string[];
  /** Todas as respostas, na ordem consultada. */
  results: readonly SourceResult[];
}

/**
 * Igual a `resolveSubscriberUnion`, mas preservando de ONDE veio a resposta.
 *
 * O `activeSource` não é enfeite: durante a migração ele é a única forma de
 * medir quantos votantes já vêm do Kit sem instrumentar nada novo. E
 * `failedSources` existe pra que uma fonte quebrada apareça no log em vez de
 * sumir dentro de um veredicto agregado.
 */
export function resolveSubscriberUnionDetailed(results: readonly SourceResult[]): UnionOutcome {
  const state = resolveSubscriberUnion(results.map((r) => r.state));
  return {
    state,
    activeSource: results.find((r) => r.state === "active")?.source,
    failedSources: results.filter((r) => r.state === "verification_failed").map((r) => r.source),
    results,
  };
}
