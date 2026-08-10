/**
 * ctr-utils.ts — helpers puros compartilhados entre analyze-h4.ts e
 * update-audience.ts. Extraído para quebrar o ciclo de importação ESM
 * entre os dois módulos (#1619).
 */

/**
 * Strip Aprofunde rows (#1564): destaques pré-mar/2026 usavam anchor "Aprofunde"
 * (link secundário com CTR estruturalmente mais alto ~1.5×). Pós-mar/2026 todos
 * usam título como anchor. Misturar os 2 regimes infla CTR de categorias com
 * muitos rows antigos.
 *
 * Pure: retorna true se anchor começa com "Aprofunde" (case-insensitive).
 */
export function isAprofundeAnchor(anchor: string): boolean {
  return /^aprofunde\b/i.test((anchor || "").trim());
}

/**
 * Hosts não-editoriais (#4839): links que aparecem no CTR table mas nunca
 * passam pelo pipeline editorial — rodapé social, crédito de imagem do "É IA?",
 * afiliado, link de casa, apoio. Medido na auditoria retrospectiva 260810:
 * 18-22% das linhas do CSV (7-12% dos cliques) eram esse ruído, inflando o
 * denominador de categorias como Curiosidade (crédito de foto sob a imagem
 * da enquete) e mascarando o CTR real.
 *
 * Comparado contra `domain` (já normalizado sem "www." por build-link-ctr.ts),
 * não contra `base_url`/anchor — mais barato e já é a granularidade que o CSV
 * grava. Família "diar.ia.br" casa qualquer subdomínio (livros., cursos.,
 * arquivo., ...) — decisão deliberada: são todos "links de casa" (issue),
 * não hosts editoriais de terceiros. As demais famílias são exatas de
 * propósito (ex: "commons.wikimedia.org", não "wikimedia.org" inteiro) —
 * cobertura de imprensa sobre Wikipédia/Wikimedia (ex: diff.wikimedia.org,
 * enterprise.wikimedia.com) é conteúdo editorial legítimo, só o crédito de
 * imagem em commons é ruído.
 *
 * "O que invalidaria" da issue: Wikipédia como fonte de matéria (não crédito
 * de imagem) capturada por engano — não acontece aqui porque a família é
 * host exato, não domain suffix genérico "wikipedia.org".
 */
export const NON_EDITORIAL_HOST_FAMILIES = [
  "linkedin.com",
  "commons.wikimedia.org",
  "pt.wikipedia.org",
  "en.wikipedia.org",
  "wikidata.org",
  "link.amazon", // literal — domínio de afiliado sem TLD no CTR table real (#4839)
  "diar.ia.br", // + subdomínios: livros.diar.ia.br, cursos.diar.ia.br, ...
  "apoia.se",
] as const;

/**
 * Pure: retorna true se `domain` é um host não-editorial (#4839) — deve ser
 * excluído do cálculo de CTR. Compara exato ou como subdomínio de uma das
 * famílias em NON_EDITORIAL_HOST_FAMILIES (host === family ||
 * host.endsWith("." + family)).
 */
export function isNonEditorialHost(domain: string): boolean {
  const host = (domain || "").trim().toLowerCase().replace(/^www\./, "");
  if (!host) return false;
  return NON_EDITORIAL_HOST_FAMILIES.some(
    (family) => host === family || host.endsWith(`.${family}`),
  );
}
