/**
 * apex-cutover-verify.ts (#5125)
 *
 * Miolo PURO da checagem mecânica e re-executável de que a decisão do
 * editor de 28/08/2026 ("sim — construir superfície própria, com a
 * canônica apontando para ela") está de fato no ar — não presumida a
 * partir de memória/histórico da issue.
 *
 * **Achado desta unidade, antes de escrever qualquer HTML novo**: a
 * decisão já está implementada e em produção via #467 (`workers/site`,
 * cutover do apex `diar.ia.br` executado em 26/08/2026 — ver
 * `docs/apex-cutover-rollback.md`), 2 dias antes deste dispatch pedir "sim,
 * construir". Mesmo padrão de correção já registrado 3× nos comentários
 * desta issue (15/08, 17/08, 25/08): a leitura de estado feita em prosa
 * ficou atrás da realidade do repo, e cada vez a correção foi uma checagem
 * MECÂNICA, não implementar de novo o que já existe (#573, generalizado
 * pra "estado do repo" por `corpus-index-coverage.ts`).
 *
 * Este módulo dá à alegação "o cutover está no ar e correto" a mesma
 * disciplina: HTTP real contra `https://diar.ia.br` (sem precisar do
 * junction `data/`, diferente de `corpus-index-coverage.ts`), com a LÓGICA
 * de parsing/checagem isolada e testável via fixture (sem rede) —
 * `test/apex-cutover-verify-5125.test.ts` cobre só as funções puras deste
 * arquivo, nunca faz fetch real.
 *
 * Checagens (derivadas direto do texto da decisão de 28/08 + dos "ganhos
 * que justificam" listados no comentário):
 *   1. `<html lang="pt-BR">` na home e numa página de post amostrada.
 *   2. `<link rel="canonical">` autorreferente (aponta pra si mesma, não
 *      pro host legado da Beehiiv) na página de post amostrada.
 *   3. Meta description não-genérica (presente e != vazio) na página de
 *      post amostrada.
 *   4. `sitemap.xml` lista URLs `/p/{slug}` (paginação/profundidade rasa —
 *      o problema estrutural original do corpo da issue).
 *   5. `robots.txt` libera crawlers de IA (`Content-Signal`) e declara o
 *      sitemap — mesma política já registrada no CLAUDE.md.
 *   6. Host legado Beehiiv (`diaria.beehiiv.com`) redireciona (3xx) pro
 *      host novo — risco de "duplicidade durante a transição" citado pelo
 *      editor no comentário de 28/08, checado como resolvido ou pendente.
 */

export interface HtmlPageCheck {
  langPtBr: boolean;
  selfCanonical: boolean;
  canonicalUrl: string | null;
  hasMetaDescription: boolean;
  metaDescription: string | null;
}

/** Extrai `<html lang="...">` — regex simples, HTML gerado por nós é
 * previsível (sempre a mesma tag no início do documento, sem atributos
 * fora de ordem). Não é um parser HTML genérico de propósito. */
export function extractHtmlLang(html: string): string | null {
  const match = html.match(/<html[^>]*\blang="([^"]*)"/i);
  return match ? match[1] : null;
}

export function extractCanonicalHref(html: string): string | null {
  const match = html.match(/<link[^>]*rel="canonical"[^>]*href="([^"]*)"/i);
  return match ? match[1] : null;
}

export function extractMetaDescription(html: string): string | null {
  const match = html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/i);
  return match ? match[1] : null;
}

/**
 * Checa uma página de post do acervo (`/p/{slug}`) contra os 3 critérios
 * on-page da decisão de 28/08: lang pt-BR, canonical autorreferente, meta
 * description não-genérica (presente e não-vazia — a checagem de "não
 * descreve outras matérias" já é coberta por `ownEditionDescription` em
 * `site-archive-pages.ts` e seu teste próprio, não duplicada aqui).
 */
export function checkArchivePostPage(html: string, expectedUrl: string): HtmlPageCheck {
  const lang = extractHtmlLang(html);
  const canonicalUrl = extractCanonicalHref(html);
  const metaDescription = extractMetaDescription(html);
  return {
    langPtBr: lang?.toLowerCase() === "pt-br",
    selfCanonical: canonicalUrl === expectedUrl,
    canonicalUrl,
    hasMetaDescription: !!metaDescription && metaDescription.trim().length > 0,
    metaDescription,
  };
}

/** Conta `<loc>` dentro de `<url>` — sitemap.xml gerado por
 * `scripts/lib/site-archive-pages.ts`, sem namespace prefixado. */
export function countSitemapUrls(sitemapXml: string): number {
  const matches = sitemapXml.match(/<url>/gi);
  return matches ? matches.length : 0;
}

export function sitemapHasArchivePost(sitemapXml: string, slug: string): boolean {
  return sitemapXml.includes(`/p/${slug}`);
}

export interface RobotsCheck {
  allowsAiCrawlers: boolean;
  declaresSitemap: boolean;
}

/**
 * `allowsAiCrawlers`: procura o grupo `User-agent: *` com `Content-Signal`
 * incluindo `ai-train=yes` — mesma política de "Crawlers de IA ficam
 * liberados" do CLAUDE.md. Não valida bloqueios específicos (Amazonbot,
 * CloudflareBrowserRenderingCrawler) — fora do escopo desta checagem.
 */
export function checkRobotsTxt(robotsTxt: string): RobotsCheck {
  return {
    allowsAiCrawlers:
      /content-signal:[^\n]*ai-train=yes/i.test(robotsTxt) &&
      /user-agent:\s*\*/i.test(robotsTxt),
    declaresSitemap: /^sitemap:\s*https?:\/\//im.test(robotsTxt),
  };
}

export interface LegacyRedirectCheck {
  /** true = o host legado redireciona (3xx) pro host novo; false = ainda
   * responde 200 (risco de duplicidade real); null = checagem não rodou
   * (fetch falhou por rede — não é um "não" mecânico, ver caller). */
  redirectsToNewHost: boolean | null;
  status: number | null;
  locationHeader: string | null;
}

export function evaluateLegacyRedirect(
  status: number | null,
  locationHeader: string | null,
  expectedHostSubstring: string,
): LegacyRedirectCheck {
  if (status === null) {
    return { redirectsToNewHost: null, status: null, locationHeader };
  }
  const isRedirect = status >= 300 && status < 400;
  const pointsToNewHost = !!locationHeader && locationHeader.includes(expectedHostSubstring);
  return {
    redirectsToNewHost: isRedirect && pointsToNewHost,
    status,
    locationHeader,
  };
}

export interface ApexCutoverReportInput {
  generatedAtIso: string;
  homeLang: string | null;
  postCheck: HtmlPageCheck | null;
  postUrl: string | null;
  sitemapUrlCount: number;
  sitemapHasSampledPost: boolean;
  robots: RobotsCheck | null;
  legacyRedirect: LegacyRedirectCheck | null;
}

function statusIcon(ok: boolean | null): string {
  if (ok === null) return "⚠️ não verificado";
  return ok ? "✅" : "❌";
}

/**
 * Renderiza o relatório em markdown, mesmo espírito de
 * `renderCorpusIndexStatusMarkdown` — fotografia do dia, não mantida em
 * sync contínuo por CI (o script CLI reescreve o arquivo a cada rodada
 * manual).
 */
export function renderApexCutoverReportMarkdown(input: ApexCutoverReportInput): string {
  const lines: string[] = [];
  lines.push("# Verificação do cutover do apex — #5125");
  lines.push("");
  lines.push(
    `Gerado em ${input.generatedAtIso} por \`npx tsx scripts/apex-cutover-verify-5125.ts\`. ` +
      "Fotografia do dia — re-rodar antes de citar os números (disciplina do #1172).",
  );
  lines.push("");
  lines.push(
    "Checa a decisão do editor de 28/08/2026 (\"sim — construir superfície " +
      "própria, com a canônica apontando para ela\") contra o estado real do " +
      "apex `diar.ia.br`, já cutovado via #467 em 26/08/2026.",
  );
  lines.push("");
  lines.push("## Home (`/`)");
  lines.push("");
  lines.push(
    `- ${statusIcon(input.homeLang?.toLowerCase() === "pt-br")} \`<html lang>\`: \`${
      input.homeLang ?? "(ausente)"
    }\``,
  );
  lines.push("");
  lines.push("## Página de post amostrada (`/p/{slug}`)");
  lines.push("");
  if (input.postCheck && input.postUrl) {
    const c = input.postCheck;
    lines.push(`- URL amostrada: \`${input.postUrl}\``);
    lines.push(`- ${statusIcon(c.langPtBr)} \`<html lang="pt-BR">\``);
    lines.push(
      `- ${statusIcon(c.selfCanonical)} canonical autorreferente: \`${c.canonicalUrl ?? "(ausente)"}\``,
    );
    lines.push(
      `- ${statusIcon(c.hasMetaDescription)} meta description própria (não-genérica): ` +
        (c.hasMetaDescription ? `"${c.metaDescription!.slice(0, 80)}…"` : "ausente"),
    );
  } else {
    lines.push("- ⚠️ nenhuma página de post amostrada (sitemap vazio ou fetch falhou)");
  }
  lines.push("");
  lines.push("## Sitemap (`/sitemap.xml`)");
  lines.push("");
  lines.push(`- URLs listadas: **${input.sitemapUrlCount}**`);
  lines.push(
    `- ${statusIcon(input.sitemapHasSampledPost)} inclui a página de post amostrada acima`,
  );
  lines.push("");
  lines.push("## Robots (`/robots.txt`)");
  lines.push("");
  if (input.robots) {
    lines.push(`- ${statusIcon(input.robots.allowsAiCrawlers)} libera crawlers de IA (Content-Signal)`);
    lines.push(`- ${statusIcon(input.robots.declaresSitemap)} declara \`Sitemap:\``);
  } else {
    lines.push("- ⚠️ não verificado");
  }
  lines.push("");
  lines.push("## Host legado (`diaria.beehiiv.com`) — risco de duplicidade");
  lines.push("");
  if (input.legacyRedirect) {
    lines.push(
      `- ${statusIcon(input.legacyRedirect.redirectsToNewHost)} redireciona pro host novo ` +
        `(status ${input.legacyRedirect.status ?? "?"}` +
        (input.legacyRedirect.locationHeader
          ? `, Location: \`${input.legacyRedirect.locationHeader}\``
          : "") +
        ")",
    );
  } else {
    lines.push("- ⚠️ não verificado");
  }
  lines.push("");
  return lines.join("\n");
}

/** `true` só se todas as checagens não-nulas passaram — checagens `null`
 * (fetch falhou, ex: rede indisponível) não reprovam o relatório sozinhas,
 * mas ficam marcadas ⚠️ no markdown pra nunca serem lidas como "ok". */
export function allChecksPassed(input: ApexCutoverReportInput): boolean {
  const checks: Array<boolean | null> = [
    input.homeLang?.toLowerCase() === "pt-br",
    input.postCheck ? input.postCheck.langPtBr : null,
    input.postCheck ? input.postCheck.selfCanonical : null,
    input.postCheck ? input.postCheck.hasMetaDescription : null,
    input.sitemapUrlCount > 0,
    input.sitemapHasSampledPost,
    input.robots?.allowsAiCrawlers ?? null,
    input.robots?.declaresSitemap ?? null,
    input.legacyRedirect?.redirectsToNewHost ?? null,
  ];
  return checks.every((c) => c !== false);
}
