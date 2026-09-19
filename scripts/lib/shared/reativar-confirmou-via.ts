/**
 * scripts/lib/shared/reativar-confirmou-via.ts (#8438)
 *
 * Medição dedicada do clique no botão "Confirmar" da reativação Brevo
 * diária — um custom field Kit ORTEGONAL à origem de aquisição, escrito pelo
 * worker `reativar` no instante do clique com token válido (#8194).
 *
 * ## Por que um field separado (e não só o `reativado` existente)?
 *
 * A UTM de reativação (`BREVO_DIARIA_REATIVAR_CLIQUE_UTM`, utm-registry.ts)
 * só é gravada pelo worker quando o campo de origem já está VAZIO (#8235,
 * `filterKitOrigemFields`): quem entrou por `google-ads`/`clarice`/
 * `diaria-apex` já tem `utm_source` preenchido, então o clique NUNCA
 * carimba esses campos — e aí o próprio fato de "clicou no botão" é
 * indistinguível de "quem era esse contato antes". A issue #8438 mediu isso:
 * na janela de 7 dias, 2 contatos saíram como `self_confirmed_kit`, e só um
 * deles era de fato botão (utm_source=brevo-diaria); o outro tinha
 * utm_source=google-ads pré-preenchido, então o clique não deixa rastro.
 *
 * A solução é um field que o worker escreve SEMPRE que o clique chegar com
 * token válido — independente de origem — e que `evaluate-brevo-diaria.ts`
 * lê no Passo 1 pra refinamento do `resolution_reason`:
 *
 *   `confirmou_via = "brevo-reativar"`  →  `resolution_reason = "self_confirmed_kit_botao"`
 *
 * Sem o field (ou com o field vazio), o comportamento de hoje é preservado:
 * `self_confirmed_kit` (ou `self_confirmed_beehiiv` p/ origem Beehiiv).
 *
 * ## Fronteira `lib/shared/` (#2747)
 *
 * Puro — só constantes, zero I/O, zero dependência de Node: pode ser
 * importado direto no bundle do Worker `reativar` (como `reativar-token.ts`
 * e `kit-signup-origin.ts`) e em scripts Node (`evaluate-brevo-diaria.ts`)
 * sem quebrar a regra de fronteira.
 */

/** Nome canônico do custom field Kit — único, não varia por worker/account. */
export const REATIVAR_CONFIRMOU_VIA_FIELD_NAME = "confirmou_via";

/** Valor gravado no field quando o clique chegou com token assinado válido (#8194). */
export const REATIVAR_CONFIRMOU_VIA_VALUE = "brevo-reativar";