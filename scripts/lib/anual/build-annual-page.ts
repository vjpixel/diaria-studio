/**
 * build-annual-page.ts (#7581)
 *
 * `draft.md` da edição anual → HTML público (trecho + completo) servido pelo
 * worker `anual` (`workers/anual/`) atrás do gate de CADASTRO (Kit) — mesmo
 * papel de `scripts/lib/mensal/build-article-page.ts` (#7580) para o artigo
 * mensal, adaptado a duas diferenças estruturais:
 *
 *   1. o render vem de `renderAnnualEmail` (`annual-render.ts`), escrito do
 *      zero pra anual (#7569) — não do e-mail de e-mail-marketing como o
 *      mensal, então NÃO há merge tag de descadastro nem `utm_medium=email`
 *      pra corrigir: `renderAnnualEmail` já produz HTML limpo, sem
 *      dependência de provedor. As três correções pós-render de
 *      `build-article-page.ts` (`stripEmailOnlyFooter`,
 *      `stripReplyByEmailSentence`, `retagWebUtmMedium`) não têm equivalente
 *      aqui — inspecionado e confirmado ausente do template (#7569).
 *
 *   2. o corte do trecho é no fim do **TEMA 1** (N variável de temas,
 *      3–7), não no fim do "DESTAQUE 1" (mensal, sempre 3 destaques fixos).
 *      Decisão do editor (07/09/2026, comentário na #7581): mesmo critério
 *      já usado no mensal (#7580) — "fim do 1º tema" — mas "proporcionalmente
 *      mais generoso" porque a base é maior (3–7 temas em vez de 3
 *      destaques fixos).
 *
 * PURO: sem I/O. `parseAnnualDraft` nunca lança (seção ausente vira string
 * vazia + warning) e `renderAnnualEmail` não valida nada — a validade do
 * draft é responsabilidade do lint da Etapa 4 (`lint-annual-draft.ts`), que
 * roda ANTES do gate humano e, portanto, antes deste módulo nunca ver um
 * draft inválido em produção. Aqui o único guard é estrutural: existe um
 * `**TEMA 1 ...**` no markdown? Sem ele não há onde cortar.
 */
import { parseAnnualDraft } from "./annual-parse.ts";
import { renderAnnualEmail, type AnnualRenderOptions } from "./annual-render.ts";
import { assertNoLegacyBrand, checkLegacyBrand } from "../shared/legacy-brand-guard.ts";

/**
 * Erro do corte do trecho: o draft não tem a estrutura que o corte pressupõe.
 *
 * Mesma disciplina de `TeaserCutError` (build-article-page.ts, #7580): falhar
 * ALTO em vez de publicar um trecho vazio ou o artigo inteiro por engano — um
 * trecho vazio não converte nada, e o artigo inteiro vazando de graça é o
 * pior dos dois mundos (entrega o conteúdo pago sem pedir cadastro).
 */
export class AnnualTeaserCutError extends Error {
  readonly slug: string;

  constructor(slug: string, motivo: string) {
    super(`não foi possível cortar o trecho público da edição anual "${slug}": ${motivo}`);
    this.name = "AnnualTeaserCutError";
    this.slug = slug;
  }
}

/** Marcador de seção do draft anual: `**TEMA 1 | ENERGIA**`, `**O QUE MUDOU**`, … */
const SECTION_MARKER = /^\*\*[^*]+\*\*$/;
const THEME_1_RE = /^\*\*TEMA\s+1\b/i;

/**
 * Corta o markdown do draft no fim do TEMA 1 (decisão do editor, mesmo
 * critério do mensal #7580 — ver docstring do módulo).
 *
 * Corta no PRÓXIMO marcador de seção depois do TEMA 1, seja ele qual for
 * (`TEMA 2`, `O QUE MUDOU`, …) — sobrevive a reordenação sem saber o que vem
 * depois, e deixa o trecho terminando no "fio condutor" do tema, que é
 * gancho melhor do que um corte no meio da prosa.
 */
export function cutDraftAfterFirstTheme(draftMd: string, slug: string): string {
  const linhas = draftMd.split(/\r?\n/);
  const iTema1 = linhas.findIndex((l) => THEME_1_RE.test(l.trim()));
  if (iTema1 < 0) {
    throw new AnnualTeaserCutError(slug, "não há marcador `**TEMA 1 ...**` no draft");
  }
  const iCorte = linhas.findIndex((l, i) => i > iTema1 && SECTION_MARKER.test(l.trim()));
  if (iCorte < 0) {
    throw new AnnualTeaserCutError(slug, "não há seção depois do TEMA 1 — o trecho seria o draft inteiro");
  }
  const trecho = linhas.slice(0, iCorte).join("\n").trimEnd();
  if (trecho.length < 500) {
    throw new AnnualTeaserCutError(slug, `trecho ficou com ${trecho.length} caracteres — estrutura inesperada`);
  }
  return trecho;
}

export interface AnnualPage {
  html: string;
  imageCount: number;
  missingImages: number[];
  warnings: string[];
}

/**
 * HTML COMPLETO da edição anual — o que quem passa no gate de cadastro
 * recebe. `opts` é o mesmo `AnnualRenderOptions` de `renderAnnualEmail`
 * (janela/tipo/imagens) — este módulo não decide nada sobre eles, só
 * encadeia parse → render.
 */
export function buildAnnualHtml(draftMd: string, opts: AnnualRenderOptions): AnnualPage {
  const draft = parseAnnualDraft(draftMd);
  const page = renderAnnualEmail(draft, opts);
  // Guard de marca legada (#7719) — mesmo raciocínio do irmão mensal
  // (`buildArticleHtml`, `scripts/lib/mensal/build-article-page.ts`): o
  // conteúdo vem de `data/annual/{slug}/draft.md`, fora do repo, sem
  // cobertura do guard estático em
  // `test/reader-facing-no-legacy-brand-4424.test.ts`. Checa o HTML final,
  // depois do render.
  // A fonte entra na checagem junto do HTML: o render aplica o wordmark do DS
  // (`applyBrandWordmark`), que normaliza "Diar.ia" para a marca certa no
  // corpo — sem olhar o markdown, a grafia legada sumiria do HTML e o guard
  // deixaria de acusá-la na fonte, que é onde ela precisa ser corrigida.
  assertNoLegacyBrand(checkLegacyBrand(`${draftMd}\n${page.html}`), `retrospectiva anual "${opts.windowLabel}"`);
  return page;
}

/**
 * HTML do TRECHO público — o que quem NÃO passou no gate recebe. Mesmo
 * pipeline de `buildAnnualHtml`, com o markdown já cortado no fim do TEMA 1 —
 * herda a mesma tipografia/layout por construção, sem duplicar renderização.
 *
 * O bloco de conversão (fade + CTA de cadastro) NÃO entra aqui: é montado
 * pelo Worker (`workers/anual/src/render.ts`), onde o CTA já vive — mudar o
 * texto do convite não exige reconstruir e republicar todas as edições.
 */
export function buildAnnualTeaserHtml(draftMd: string, slug: string, opts: AnnualRenderOptions): AnnualPage {
  return buildAnnualHtml(cutDraftAfterFirstTheme(draftMd, slug), opts);
}
