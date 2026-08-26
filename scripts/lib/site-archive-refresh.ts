/**
 * scripts/lib/site-archive-refresh.ts (#6202, fatia do #467)
 *
 * Decide **se** o acervo do site precisa ser regenerado, comparando o que o
 * cache da Beehiiv tem com o que já existe em `workers/site/public/p/`.
 *
 * ## Como esta issue chegou aqui
 *
 * A 1ª tentativa (PR #6209) publicava a página no Stage 6, a partir de
 * `_internal/newsletter-final.html`. O fleet review derrubou por três
 * desalinhamentos, e o editor decidiu (26/08) pela saída que os resolve de
 * uma vez: **esperar o render web chegar ao cache**.
 *
 * O que isso elimina:
 *
 * - **insumo errado** — `newsletter-final.html` é HTML de E-MAIL (tabelas,
 *   hacks de Outlook); as 253 páginas vêm do render WEB da Beehiiv
 *   (`rendered-post`, tema próprio). Esperar o cache faz a página nova usar
 *   exatamente o mesmo insumo das outras.
 * - **campo inexistente** — `post_url` só é carimbado por
 *   `refresh-dedup.ts::autoStampPublishedJson`, e só depois do post ser
 *   ENVIADO. No novo gatilho ele existe de verdade.
 * - **conflito com o gerador** — `generateArchivePages` apaga a árvore e
 *   reescreve do cache. Uma página escrita fora do cache seria apagada por
 *   ele; vinda do cache, é reproduzida.
 *
 * Custo aceito na decisão: a página aparece ~1 dia depois da edição sair.
 *
 * ## O que este módulo NÃO faz
 *
 * Não gera nem publica. Só responde "precisa regenerar?" — a geração é o
 * `gen-archive-pages.ts` que já existe, e a publicação é `git push` →
 * `.github/workflows/deploy-site.yml`. Manter isto puro deixa a decisão
 * testável sem tocar disco de produção nem chamar wrangler.
 */

export interface RefreshDecisionInput {
  /** Slugs de posts publicados presentes no cache da Beehiiv. */
  slugsNoCache: readonly string[];
  /** Slugs que já têm página em `workers/site/public/p/`. */
  slugsComPagina: readonly string[];
}

export interface RefreshDecision {
  precisa: boolean;
  /** No cache e sem página — o caso normal: edição nova entrou. */
  faltando: string[];
  /**
   * Com página e fora do cache — post despublicado, ou slug alterado.
   * Também exige regenerar: o gerador apaga a árvore, então a página órfã
   * some junto. Sem isso, uma edição removida continuaria servida.
   */
  orfas: string[];
  motivo: string;
}

/**
 * Puro. Comparação de conjuntos — deliberadamente NÃO compara conteúdo.
 *
 * Comparar HTML byte a byte pegaria também mudança de template (útil), mas
 * tornaria toda alteração no gerador um "precisa regenerar" — o que é
 * verdade, e é exatamente por isso que a regeneração completa deve continuar
 * sendo rodável à mão. Este gatilho responde à pergunta mais estreita: **o
 * conjunto de edições mudou?**
 */
export function decideArchiveRefresh(input: RefreshDecisionInput): RefreshDecision {
  const comPagina = new Set(input.slugsComPagina);
  const noCache = new Set(input.slugsNoCache);

  const faltando = input.slugsNoCache.filter((s) => !comPagina.has(s)).sort();
  const orfas = input.slugsComPagina.filter((s) => !noCache.has(s)).sort();

  if (faltando.length === 0 && orfas.length === 0) {
    return { precisa: false, faltando, orfas, motivo: "acervo em dia — nenhuma edição entrou nem saiu" };
  }

  const partes: string[] = [];
  if (faltando.length > 0) partes.push(`${faltando.length} edição(ões) no cache sem página`);
  if (orfas.length > 0) partes.push(`${orfas.length} página(s) órfã(s) fora do cache`);
  return { precisa: true, faltando, orfas, motivo: partes.join(" · ") };
}

/** Render legível — o que aparece no log do Stage 0/1. */
export function renderRefreshDecision(d: RefreshDecision): string {
  const linhas = [`[site-archive] ${d.motivo}`];
  if (d.faltando.length > 0) {
    linhas.push(`  entrando: ${d.faltando.slice(0, 5).join(", ")}${d.faltando.length > 5 ? ` (+${d.faltando.length - 5})` : ""}`);
  }
  if (d.orfas.length > 0) {
    linhas.push(`  saindo:   ${d.orfas.slice(0, 5).join(", ")}${d.orfas.length > 5 ? ` (+${d.orfas.length - 5})` : ""}`);
  }
  if (d.precisa) {
    linhas.push("  → rodar `npx tsx scripts/gen-archive-pages.ts`, commitar e dar push.");
    linhas.push("     O deploy é por `.github/workflows/deploy-site.yml` (push em workers/site/public/),");
    linhas.push("     NÃO por `wrangler deploy` direto — achado do review do #6209.");
  }
  return linhas.join("\n");
}
