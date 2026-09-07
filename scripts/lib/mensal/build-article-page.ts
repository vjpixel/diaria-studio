/**
 * build-article-page.ts (#3940)
 *
 * Constrói o HTML público do artigo mensal — servido pelo worker
 * `artigo-mensal` atrás do paywall de apoiador R$10+/mês (ver
 * `workers/artigo-mensal/`) — a partir do `draft.md` do ciclo.
 *
 * PURO: reusa o MESMO pipeline de render já testado do envio Brevo mensal
 * (`draftToEmail`, `monthly-render.ts`) — o artigo público e o e-mail
 * mensal compartilham a MESMA renderização de seções (DESTAQUE, INTRO,
 * PARA ENCERRAR etc.), sem duplicar lógica de parsing de markdown.
 * `draftToEmail` já devolve o documento HTML COMPLETO (`wrapEmail` é
 * chamado internamente) — nenhum wrap adicional é feito aqui.
 *
 * Sem imagens geradas (destaqueImageUrls/eiaImageUrl*) nesta 1ª versão —
 * `renderDestaque`/`renderEia` toleram `undefined` (renderizam sem `<img>`).
 * Plugar as imagens reais do ciclo é fast-follow explícito (ver PR #3940) —
 * o dado (URLs já hospedadas no KV do worker `poll`/`draft` por
 * `monthly-image-upload.ts`) existe, só não foi plugado nesta unidade por
 * escopo.
 */
import { cycleToYymm, isValidMonthlyCycle } from "./monthly-paths.ts";
import { draftToEmail } from "./monthly-render.ts";

export interface ArticlePage {
  subject: string;
  previewText: string;
  /** Documento HTML completo (`<!DOCTYPE...` a `</html>`), pronto pra servir. */
  html: string;
}

/**
 * #7580: versão do TEASER do artigo — a capa do artigo (até o fim do 1º
 * destaque temático) envelopada num shell WEB (og:* + canonical + CTA de
 * apoio), pra servir aos não-apoiadores sem vazar o conteúdo completo.
 * O corte é em bloco de markdown (ver `draftToEmail` opts.teaser), nunca em
 * byte-offset. O artigo completo NUNCA entra nessa resposta — fail-closed no
 * Worker (`workers/artigo-mensal/src/index.ts`): se o key `:teaser` estiver
 * ausente, o não-apoiador recebe o paywall seco de hoje.
 *
 * @param draftMd conteúdo de `data/monthly/{cycle}/draft.md`
 * @param cycle ciclo no formato `{conteúdo}-{envio}` (ex: `2607-08`)
 * @throws se `cycle` não é um ciclo válido (`{conteúdo}-{envio}`).
 */
export function buildArticleTeaser(draftMd: string, cycle: string): ArticlePage {
  if (!isValidMonthlyCycle(cycle)) {
    throw new Error(
      `build-article-teaser: ciclo inválido "${cycle}" (esperado {conteúdo}-{envio}, ex: 2607-08)`,
    );
  }
  const yymm = cycleToYymm(cycle);
  const { subject, previewText, html } = draftToEmail(draftMd, null, yymm, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { teaser: { cycle } });
  return { subject, previewText, html };
}

/**
 * Pure: converte o markdown do draft mensal no HTML completo do artigo
 * público.
 *
 * @param draftMd conteúdo de `data/monthly/{cycle}/draft.md`
 * @param cycle ciclo no formato `{conteúdo}-{envio}` (ex: `2607-08`) — usado
 *   só pra derivar `yymm` (mês do conteúdo), que `draftToEmail` precisa pro
 *   UTM da seção É IA?/links Beehiiv e pro cálculo interno de edição É IA?.
 * @throws se `cycle` não é um ciclo válido (`{conteúdo}-{envio}`).
 */
export function buildArticleHtml(draftMd: string, cycle: string): ArticlePage {
  if (!isValidMonthlyCycle(cycle)) {
    throw new Error(
      `build-article-page: ciclo inválido "${cycle}" (esperado {conteúdo}-{envio}, ex: 2607-08)`,
    );
  }
  const yymm = cycleToYymm(cycle);
  const { subject, previewText, html } = draftToEmail(draftMd, null, yymm);
  return { subject, previewText, html };
}
