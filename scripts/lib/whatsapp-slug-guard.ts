/**
 * whatsapp-slug-guard.ts (#4570)
 *
 * O bloco encaminhável por WhatsApp (entre D1 e D2, ver
 * `newsletter-render-html.ts::buildWhatsappEditionUrl`) tem sua URL BAKED IN
 * no HTML final ANTES do Schedule — `https://diar.ia.br/p/{seoSlug(D1)}`,
 * previsto no Stage 4 sem nenhuma chamada à API Beehiiv (o post ainda nem
 * existe). Essa previsão só bate com a URL pública real do post SE o slug
 * setado na Beehiiv (`web_settings.slug`) for exatamente `seoSlug(D1)`.
 *
 * Duas formas conhecidas de isso divergir:
 *   1. O plano atual da Beehiiv não permite setar `web_settings.slug` via API
 *      (`403 SEND_API_NOT_ENTERPRISE_PLAN`, #3449) — só via UI manual.
 *   2. Mesmo setado manualmente no passo SEO (`beehiiv-playbook.md` §4a-bis),
 *      o wizard de Schedule RE-DERIVA o slug do título e mangla acentos PT-BR
 *      (#1989/#2011): "automação" → "automa-o", "pânico" → "p-nico".
 *
 * `fix-post-slug.ts` já detecta esse mangling e sabe formatar instruções de
 * correção manual (`formatManualSlugFixInstructions`, `scripts/lib/slug.ts`)
 * — mas nada até #4570 amarrava essa checagem especificamente ao contrato do
 * bloco WhatsApp (o link já enviado no CORPO do e-mail, que não pode ser
 * re-editado depois do envio). Este módulo fecha essa lacuna: comparação
 * pura, testável sem rede — o caller (CLI `check-whatsapp-slug-guard.ts`, ou
 * o orchestrator via `Agent`/`Bash`) é responsável por obter o slug REAL via
 * `mcp__claude_ai_Beehiiv__get_post` antes de chamar isso.
 */

import { seoSlug, formatManualSlugFixInstructions } from "./slug.ts";

/**
 * #4574 (achado type-design-analyzer, review consolidado): discriminated
 * union em vez de `message?: string` solto — torna `message` obrigatório
 * exatamente quando `ok: false` (checado pelo compilador, não só por
 * docstring). Os call sites existentes (`if (!result.ok) {...result.message...}`)
 * já narrowam corretamente sem mudança. Quando `ok: true`, `actualSlug` é
 * necessariamente igual a `expectedSlug` (não-nulo, não-vazio — ver o guard
 * de `expectedSlug.length === 0` em `checkWhatsappSlugMatch`), então o campo
 * é `string`, não `string | null`, nesse branch.
 */
export type WhatsappSlugCheckResult =
  | {
      /** `true` quando o slug real bate com o previsto pelo bloco WhatsApp. */
      readonly ok: true;
      /** `seoSlug(d1Title)` — o slug que a URL já embutida no e-mail prevê. */
      readonly expectedSlug: string;
      /** Slug real do post — igual a `expectedSlug` neste branch. */
      readonly actualSlug: string;
    }
  | {
      readonly ok: false;
      readonly expectedSlug: string;
      /** Slug real do post na Beehiiv no momento da checagem (`null` = ausente/não setado). */
      readonly actualSlug: string | null;
      /** Instruções de correção manual formatadas (reusa
       *  `formatManualSlugFixInstructions`, #3449) + contexto do bloco WhatsApp. */
      readonly message: string;
    };

/**
 * Compara o slug REAL de um post Beehiiv contra o slug que a URL do bloco
 * WhatsApp já prevê (`seoSlug(d1Title)`). Pure — nenhuma chamada de rede
 * aqui, `actualSlug` é fornecido pelo caller (já obtido via API/MCP).
 *
 * @param postId - ID do post Beehiiv (usado só pra formatar a URL de correção manual).
 * @param actualSlug - slug real do post (`web_settings.slug` de `get_post`), ou
 *   `null`/`undefined` quando ainda não setado — tratado como divergência
 *   (nunca bate com um slug esperado não-vazio).
 * @param d1Title - título do D1 da edição — mesma fonte usada por
 *   `buildWhatsappEditionUrl` pra derivar a URL já embutida no e-mail.
 */
export function checkWhatsappSlugMatch(
  postId: string,
  actualSlug: string | null | undefined,
  d1Title: string,
): WhatsappSlugCheckResult {
  const expectedSlug = seoSlug(d1Title);
  const normalizedActual = actualSlug ?? null;

  // #4574 (achado do review consolidado da PR #4574, silent-failure-hunter):
  // `expectedSlug === ""` acontece com um título D1 degenerado (só
  // emoji/pontuação — `seoSlug` não tem fallback e retorna string vazia).
  // Sem este guard, um `actualSlug` também vazio/ausente bateria
  // `"" === ""` e o guard reportaria `ok:true` num match vazio-com-vazio —
  // a URL do bloco WhatsApp ficaria `https://diar.ia.br/p/` (quebrada) e
  // passaria despercebida. Rejeitar incondicionalmente, independente de
  // `actualSlug`.
  if (expectedSlug.length === 0) {
    const message =
      `[check-whatsapp-slug-guard] (#4570) seoSlug(título do D1) retornou string ` +
      `vazia — título "${d1Title}" não produz um slug válido (só emoji/pontuação?). ` +
      `A URL do bloco WhatsApp ficaria "https://diar.ia.br/p/" (quebrada) e já está ` +
      `BAKED IN no corpo do e-mail. Corrigir o título do D1 antes do Schedule — ` +
      `este guard não valida contra um slug esperado vazio, mesmo que o post também ` +
      `esteja sem slug.`;
    return { ok: false, expectedSlug, actualSlug: normalizedActual, message };
  }

  if (normalizedActual === expectedSlug) {
    return { ok: true, expectedSlug, actualSlug: normalizedActual };
  }

  const message =
    `[check-whatsapp-slug-guard] (#4570) Slug do post diverge do previsto pelo ` +
    `bloco WhatsApp: esperado "${expectedSlug}" (seoSlug do título do D1), ` +
    `atual "${normalizedActual ?? "(ausente)"}". O link do bloco WhatsApp ` +
    `(entre D1 e D2) já está BAKED IN no corpo do e-mail apontando pra ` +
    `"${expectedSlug}" — se o post ficar com outro slug, esse link 404 pra ` +
    `todo mundo que abrir o e-mail. Corrigir o slug do post ANTES do envio:\n\n` +
    formatManualSlugFixInstructions(postId, expectedSlug);

  return { ok: false, expectedSlug, actualSlug: normalizedActual, message };
}
