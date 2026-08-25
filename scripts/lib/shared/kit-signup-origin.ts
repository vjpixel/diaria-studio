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
 * quebrar o cadastro). Custom field `origem_cadastro` já criado na conta
 * Kit de produção (25/08/2026, via MCP `create_custom_field`, id 1348066)
 * — falta só `wrangler secret put KIT_ORIGEM_CADASTRO_FIELD` (valor
 * `origem_cadastro`) nos 3 workers pra ligar. Ação de credencial Cloudflare
 * ao vivo, fora do alcance de um worktree isolado — ver #6048.
 *
 * Fronteira `lib/shared/` (#2747): zero I/O, zero dependência de Node — só
 * a constante, pra poder ser importada direto no bundle do Worker (mesmo
 * padrão de `utm-registry.ts`).
 */

/** Valor gravado no campo — constante fixa, não varia por worker (o desenho
 *  não distingue QUAL dos 3 funis, só "entrou pelo funil, não foi copiado
 *  de um bulk import/sync"). */
export const KIT_NATIVE_SIGNUP_MARKER = "kit-nativo";
