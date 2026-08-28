/**
 * scripts/lib/shared/kit-signup-origin.ts (#6048)
 *
 * Marcador aplicado por todo cadastro que passa pelo caminho Kit-nativo
 * (`subscribeToKit`/`activateSubscriptionKit`, os 3 funis — poll/cursos/
 * reativar) — distingue quem entrou pelo FUNIL do que foi só copiado da
 * Beehiiv pelo sync unidirecional (`Diaria-Kit-Subscriber-Sync`, #6091/#6093).
 *
 * Sem esta distinção, segmentar o envio do Kit por "quem recebe pelo Kit"
 * não teria como excluir os já-copiados sem entrega duplicada com a Beehiiv
 * (desenho completo registrado no comentário de 25/08/2026 da issue #6048).
 *
 * `env.KIT_ORIGEM_CADASTRO_FIELD` (nome do custom field na Kit) segue o
 * MESMO padrão gate-por-ausência de `KIT_UTM_*_FIELD`/`KIT_NAME_FIELD`
 * (`workers/poll/src/subscribe.ts`) — sem ele configurado, o POST não manda
 * o campo, e o subscriber fica sem o marcador (mesmo degrade gracioso, sem
 * quebrar o cadastro). É um VAR, não secret — mesmo tratamento dos 5
 * `KIT_*_FIELD` irmãos em `workers/poll/SECRETS.md` (nome de custom field
 * não é sensível). Custom field `origem_cadastro` já criado na conta Kit de
 * produção (25/08/2026, via MCP `create_custom_field`, id 1348066) — falta
 * só setar a var (`wrangler.toml` `[vars]`/dashboard) nos 3 workers pra
 * ligar. Ação de credencial Cloudflare ao vivo, fora do alcance de um
 * worktree isolado — ver #6048.
 *
 * Fronteira `lib/shared/` (#2747): zero I/O, zero dependência de Node — só
 * a constante e um helper puro, pra poder ser importado direto no bundle do
 * Worker (mesmo padrão de `meta-capi.ts`/`rate-limit.ts`/
 * `beehiiv-origem-original.ts` — import relativo direto; diferente de
 * `utm-registry.ts`, que evita isso de propósito via cópia espelhada
 * sincronizada por CI, ver docstring lá).
 *
 * ## #6425 Parte B — dois marcadores novos, mesmo campo
 *
 * Os 3 Workers acima cobrem "entrou pelo funil". `origem_cadastro` também
 * precisa distinguir os OUTROS dois caminhos que criam subscriber no Kit
 * sem passar por eles — sem isso, a promoção por score e o sync em lote da
 * Beehiiv ficavam indistinguíveis de qualquer outro cadastro via API
 * (mesmo problema, escala menor, que motivou `applyKitSignupOriginField`
 * originalmente):
 *
 * - `promoteKitSubscription` (`scripts/evaluate-brevo-diaria.ts`) — promoção
 *   AUTOMÁTICA por score de engajamento do canal Brevo Pending.
 * - `sync-beehiiv-subscribers-kit.ts` — sync unidirecional em LOTE, sem UTM
 *   por assinante disponível no call site (a listagem da Beehiiv usada ali
 *   só devolve e-mail + status; recuperar o UTM real de quem entrou por
 *   este caminho é trabalho do backfill, #6318/`backfill-kit-attribution.ts`,
 *   não deste marcador).
 *
 * Estes 2 scripts rodam em Node (não em Worker) e conhecem o nome literal
 * do custom field — `KIT_ORIGEM_CADASTRO_FIELD_NAME` abaixo evita retypar
 * a string em cada call site, sem reintroduzir a indireção via `env` que só
 * faz sentido pro mundo Worker (`applyKitSignupOriginField`).
 */

/** Valor gravado no campo — constante fixa, não varia por worker (o desenho
 *  não distingue QUAL dos 3 funis, só "entrou pelo funil, não foi copiado
 *  de um bulk import/sync"). */
export const KIT_NATIVE_SIGNUP_MARKER = "kit-nativo";

/** #6425 Parte B — promoção automática por score (`promoteKitSubscription`,
 *  `scripts/evaluate-brevo-diaria.ts`). */
export const KIT_SCORE_PROMOTION_SIGNUP_MARKER = "brevo-diaria-score";

/** #6425 Parte B — sync unidirecional em lote da Beehiiv
 *  (`scripts/sync-beehiiv-subscribers-kit.ts`). */
export const KIT_BEEHIIV_SYNC_SIGNUP_MARKER = "beehiiv-sync";

/** Nome literal do custom field no Kit (mesmo valor de
 *  `KIT_ORIGEM_CADASTRO_FIELD` nos 3 `wrangler.toml`) — pros 2 scripts Node
 *  acima, que não têm `env` de Worker pra indireção. */
export const KIT_ORIGEM_CADASTRO_FIELD_NAME = "origem_cadastro";

/**
 * Aplica o gate-por-ausência num objeto `fields` já em construção — único
 * ponto que decide "se o campo está configurado, grava o marcador", pra não
 * triplicar (e arriscar divergir) o par field-name+marker-value nos 3
 * workers que chamam isto.
 */
export function applyKitSignupOriginField(
  fields: Record<string, string>,
  env: { KIT_ORIGEM_CADASTRO_FIELD?: string },
): void {
  if (env.KIT_ORIGEM_CADASTRO_FIELD) fields[env.KIT_ORIGEM_CADASTRO_FIELD] = KIT_NATIVE_SIGNUP_MARKER;
}
