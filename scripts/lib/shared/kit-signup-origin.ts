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
 */

/** Valor gravado no campo — constante fixa, não varia por worker (o desenho
 *  não distingue QUAL dos 3 funis, só "entrou pelo funil, não foi copiado
 *  de um bulk import/sync"). */
export const KIT_NATIVE_SIGNUP_MARKER = "kit-nativo";

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
