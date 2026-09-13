/**
 * amazon-affiliate.ts (#8059)
 *
 * Um ID de rastreamento Amazon Associates POR AUDIÊNCIA:
 *   - `diaria-20` — tudo que vai aos assinantes da diar.ia.br (diária
 *     Beehiiv/Kit/Brevo, mensal, site, livros.diar.ia.br).
 *   - `claricenews-20` — tudo que vai aos assinantes da Clarice (envios
 *     Brevo Clarice).
 * A vitrine `/shop/vjpixel` (storefront) continua no ID PRINCIPAL
 * (`vjpixel-20`) — ver `AMAZON_STOREFRONT_PATH` abaixo pro porquê.
 *
 * A mesma caixa/link de divulgação pode sair TANTO na diária/mensal
 * diar.ia.br QUANTO num envio Clarice (ex: `data/snippets/{box}.md`
 * reaproveitado verbatim no `cloudflare-preview.html` da edição mensal, que
 * é o MESMO HTML disparado pra Clarice via `clarice-schedule-group.ts` —
 * ver `clarice-novos-html-state.ts`). A tag correta depende de QUEM recebe
 * o e-mail, não de onde o conteúdo foi escrito — por isso a tag é
 * REESCRITA na renderização, por canal, nunca fixa no snippet/seed (item 2
 * da issue). `rewriteAmazonAffiliateTagsInText` é o ponto de injeção: o
 * conteúdo é sempre autorado/gerado com `diaria-20` (a audiência "de casa"),
 * e o caminho de envio Clarice reescreve pra `claricenews-20` como último
 * passo antes do disparo — mesmo padrão de `tagHourCellUtm`
 * (`scripts/lib/shared/utm-registry.ts`), que já faz pós-processamento de
 * string sobre o MESMO `cloudflare-preview.html` reusado por múltiplos
 * envios.
 *
 * **Pré-requisito (item 3 da issue): só link LONGO de produto é
 * rescrevível.** `amzn.to`/`link.amazon` (encurtadores do SiteStripe)
 * embutem o ID de afiliado DENTRO do próprio encurtador — a query string
 * `tag=` na URL curta não tem efeito nenhum no destino final (o servidor do
 * encurtador ignora qualquer parâmetro que não reconheça e resolve a tag a
 * partir do link que foi encurtado, não da URL que o usuário clicou).
 * Por isso `rewriteAmazonAffiliateTag` é NO-OP pra encurtador — ver
 * `isAmazonShortenerUrl` — e `findAmazonAffiliateTagIssues` sinaliza
 * qualquer encurtador como `shortener_untaggable`, nunca tenta reescrever.
 * A correção é sempre no CONTEÚDO (trocar o link curto por
 * `amazon.com.br/dp/{ASIN}?tag=...`), não no código.
 */

export type AmazonAudience = "diaria" | "clarice";

/** Tag da audiência diar.ia.br — diária Beehiiv/Kit/Brevo, mensal, site, livros.diar.ia.br. */
export const DIARIA_AMAZON_TAG = "diaria-20";

/** Tag da audiência Clarice — envios Brevo Clarice (ramp, novos, engajados, reativação). */
export const CLARICE_AMAZON_TAG = "claricenews-20";

/**
 * Tag PRINCIPAL da conta Associates — usada hoje só pela vitrine
 * `amazon.com.br/shop/vjpixel` (`DIARIA_AMAZON_LOJA_URL`,
 * `scripts/lib/canonical-urls.ts`). Item 5 da issue: não há confirmação
 * (documentação pública da Amazon nem teste manual) de que o storefront
 * aceita override de `tag=` via query string — páginas de storefront são
 * servidas por um caminho diferente do de produto (`/dp/{ASIN}`) e a
 * Amazon Associates historicamente resolve a tag do storefront pelo ID com
 * o qual a vitrine foi CRIADA, não pelo parâmetro da URL de acesso. Decisão
 * registrada (não é bug): a loja continua em `vjpixel-20` até alguém
 * confirmar o contrário ao vivo — `rewriteAmazonAffiliateTag`/
 * `findAmazonAffiliateTagIssues` tratam qualquer URL sob este path como
 * EXCEÇÃO (nunca reescrevem, nunca reportam `wrong_tag`/`missing_tag`).
 */
export const PRIMARY_AMAZON_TAG = "vjpixel-20";

/** Path (sem protocolo/host) da vitrine — mesmo valor de `DIARIA_AMAZON_LOJA_URL`
 * em `scripts/lib/canonical-urls.ts` (não importado daqui pra evitar ciclo —
 * `canonical-urls.ts` não depende deste arquivo; o valor é replicado como
 * string literal). `test/amazon-affiliate.test.ts` compara este valor
 * diretamente contra `new URL(DIARIA_AMAZON_LOJA_URL).pathname` — drift
 * real entre os dois arquivos quebra o teste, não só a suposição. */
export const AMAZON_STOREFRONT_PATH = "/shop/vjpixel";

export const AMAZON_TAG_BY_AUDIENCE: Record<AmazonAudience, string> = {
  diaria: DIARIA_AMAZON_TAG,
  clarice: CLARICE_AMAZON_TAG,
};

/**
 * Sufixos de país da Amazon reconhecidos como link de PRODUTO (#8059 achado
 * do review, PR #8076 — 2ª rodada). Escopo INTENCIONALMENTE LIMITADO aos
 * marketplaces reais da Amazon (não é uma PSL genérica) — cobre `.com.br`
 * (audiência atual, único domínio usado hoje no seed/snippets) e `.com`
 * (referenciado em `AMAZON_STOREFRONT_PATH`/testes), mais os demais
 * marketplaces internacionais estáveis da Amazon, pra não deixar passar em
 * silêncio um link `amazon.de`/`amazon.co.uk`/`amazon.ca` etc. que algum dia
 * apareça num box/seed. **Limitação conhecida, não escondida**: um domínio
 * de país da Amazon que não exista nesta lista (a Amazon adiciona
 * marketplaces raramente, mas adiciona) passa INTOCADO por todo predicado
 * deste módulo — nem reescrito, nem reportado como issue — até alguém
 * adicionar o sufixo aqui. Se isso acontecer, o guard
 * `assertNoAmazonAffiliateTagIssues` não pega (o link nem é reconhecido como
 * Amazon), e o link segue com a tag que tinha originalmente — sinal de que
 * está acontecendo: um link amazon.{tld} aparecendo no relatório
 * `findMismatchedUrls`/lint de domínio sem nunca aparecer nos issues deste
 * módulo.
 */
const AMAZON_RETAIL_TLDS = [
  "com.br",
  "com",
  "co.uk",
  "de",
  "ca",
  "fr",
  "it",
  "es",
  "co.jp",
  "in",
  "com.mx",
  "com.au",
  "nl",
  "se",
  "pl",
  "eg",
  "sa",
  "ae",
  "sg",
  "com.tr",
  "cn",
] as const;

const AMAZON_PRODUCT_HOST_RE = new RegExp(
  `^(www\\.)?amazon\\.(${AMAZON_RETAIL_TLDS.map((t) => t.replace(/\./g, "\\.")).join("|")})$`,
);

const AMAZON_SHORTENER_HOSTS = new Set([
  "amzn.to",
  "www.amzn.to",
  "link.amazon",
  "www.link.amazon",
  "amzlinks.in",
  "www.amzlinks.in",
]);

function safeParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** True se `url` é um link de PRODUTO Amazon (host de marketplace reconhecido —
 * ver `AMAZON_RETAIL_TLDS` — protocolo http/https). @pure */
export function isAmazonProductUrl(url: string): boolean {
  const u = safeParseUrl(url);
  if (!u || !/^https?:$/.test(u.protocol)) return false;
  return AMAZON_PRODUCT_HOST_RE.test(u.hostname.toLowerCase());
}

/** True se `url` é um encurtador Amazon (amzn.to/link.amazon/amzlinks.in) — tag
 * embutida no encurtador, não reescrevível via query string. @pure */
export function isAmazonShortenerUrl(url: string): boolean {
  const u = safeParseUrl(url);
  if (!u || !/^https?:$/.test(u.protocol)) return false;
  return AMAZON_SHORTENER_HOSTS.has(u.hostname.toLowerCase());
}

/** True se `url` é a vitrine `/shop/vjpixel` — exceção documentada, nunca
 * reescrita/reportada por este módulo (ver `PRIMARY_AMAZON_TAG` acima). @pure */
export function isAmazonStorefrontUrl(url: string): boolean {
  const u = safeParseUrl(url);
  if (!u || !isAmazonProductUrl(url)) return false;
  // Match exato do segmento de path, não prefixo de string — sem isso
  // `/shop/vjpixel-outra-coisa` (hipotético, mas possível) casaria como
  // vitrine por engano. `/shop/vjpixel` ou `/shop/vjpixel/...` casam;
  // `/shop/vjpixel-x` não.
  const path = u.pathname.toLowerCase();
  return path === AMAZON_STOREFRONT_PATH || path.startsWith(`${AMAZON_STOREFRONT_PATH}/`);
}

/**
 * Reescreve (ou define) o parâmetro `tag=` de um link de produto Amazon pra
 * corresponder à audiência de destino. NO-OP para: URL não-Amazon,
 * encurtador (`isAmazonShortenerUrl`), ou vitrine (`isAmazonStorefrontUrl`)
 * — os três casos são intencionais, ver docstring do módulo. @pure
 */
export function rewriteAmazonAffiliateTag(url: string, audience: AmazonAudience): string {
  if (!isAmazonProductUrl(url)) return url;
  if (isAmazonShortenerUrl(url)) return url;
  if (isAmazonStorefrontUrl(url)) return url;
  const u = safeParseUrl(url);
  if (!u) return url;
  u.searchParams.set("tag", AMAZON_TAG_BY_AUDIENCE[audience]);
  return u.toString();
}

// URLs "nuas" em texto/markdown/HTML (mesmo char-class de exclusão de
// `findClariceLinksMissingVia` em canonical-urls.ts — delimitadores de
// wrapping não entram no match).
const RAW_URL_RE = /https?:\/\/[^\s)\]}"'<>]+/g;

/**
 * Varre um texto/HTML arbitrário e reescreve todo link de produto Amazon
 * (não-encurtador, não-storefront) pra `tag={audience}`. Idempotente — rodar
 * 2x sobre o mesmo texto com a mesma audiência produz o mesmo resultado.
 * @pure
 */
export function rewriteAmazonAffiliateTagsInText(text: string, audience: AmazonAudience): string {
  return text.replace(RAW_URL_RE, (raw) => {
    const trimmed = raw.replace(/[.,;:!?]+$/, "");
    const suffix = raw.slice(trimmed.length);
    if (!isAmazonProductUrl(trimmed) || isAmazonShortenerUrl(trimmed) || isAmazonStorefrontUrl(trimmed)) {
      return raw;
    }
    return rewriteAmazonAffiliateTag(trimmed, audience) + suffix;
  });
}

export type AmazonAffiliateTagIssueType = "missing_tag" | "wrong_tag" | "shortener_untaggable";

export interface AmazonAffiliateTagIssue {
  url: string;
  issue: AmazonAffiliateTagIssueType;
  /** Tag encontrada na URL (só presente quando `issue === "wrong_tag"`). */
  found_tag?: string;
  expected_tag: string;
}

/**
 * Lint puro (#8059 item 4): varre um texto/HTML arbitrário e reporta todo
 * link Amazon problemático para a `audience` de destino —
 *   - `shortener_untaggable`: encurtador (amzn.to/link.amazon/amzlinks.in) —
 *     a tag embutida não é verificável/reescrevível a partir da URL curta;
 *     a correção é trocar por link longo de produto no CONTEÚDO fonte.
 *   - `missing_tag`: link de produto sem `tag=` na query.
 *   - `wrong_tag`: link de produto com `tag=` de OUTRA audiência (ex: link
 *     `claricenews-20` aparecendo num render pra diar.ia.br, ou vice-versa).
 * A vitrine (`isAmazonStorefrontUrl`) é SEMPRE excluída — exceção
 * documentada (`PRIMARY_AMAZON_TAG`), nunca um issue. Dedup por URL exata.
 * @pure
 */
export function findAmazonAffiliateTagIssues(
  text: string,
  audience: AmazonAudience,
): AmazonAffiliateTagIssue[] {
  const expected = AMAZON_TAG_BY_AUDIENCE[audience];
  const issues: AmazonAffiliateTagIssue[] = [];
  const seen = new Set<string>();
  const matches = text.match(RAW_URL_RE) ?? [];
  for (const raw of matches) {
    const url = raw.replace(/[.,;:!?]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);

    if (isAmazonShortenerUrl(url)) {
      issues.push({ url, issue: "shortener_untaggable", expected_tag: expected });
      continue;
    }
    if (!isAmazonProductUrl(url)) continue;
    if (isAmazonStorefrontUrl(url)) continue;

    const u = safeParseUrl(url);
    const tag = u?.searchParams.get("tag") ?? null;
    if (!tag) {
      issues.push({ url, issue: "missing_tag", expected_tag: expected });
    } else if (tag !== expected) {
      issues.push({ url, issue: "wrong_tag", found_tag: tag, expected_tag: expected });
    }
  }
  return issues;
}

/**
 * Guard hard (#8059 achado do review, PR #8076): `rewriteAmazonAffiliateTagsInText`
 * cobre o caso comum (regex sobre URL "nua" em texto/HTML), mas nada garante
 * que TODO link Amazon do HTML caiu nesse regex — encoding diferente, host
 * não coberto por `AMAZON_RETAIL_TLDS`, ou um encurtador que passou batido
 * no conteúdo fonte. Antes deste guard, só `clarice-schedule-group.ts`
 * verificava o resultado da reescrita com `findAmazonAffiliateTagIssues`
 * antes de qualquer disparo — os outros 4 pontos que reusam o mesmo
 * `cloudflare-preview.html` (`clarice-schedule-sends.ts`,
 * `clarice-schedule-ramp.ts`, `clarice-reapply-scheduled-html.ts`,
 * `clarice-cta-ab-setup.ts`) só chamavam a reescrita, sem confirmar que ela
 * de fato converteu tudo — um link que escapasse da reescrita seguiria pro
 * disparo/agendamento Clarice com a tag errada ou ausente, em silêncio.
 *
 * Chamar logo após `rewriteAmazonAffiliateTagsInText(html, audience)`, antes
 * de qualquer create/test/schedule/sendNow/PUT. Lança `Error` (nunca
 * retorna) se sobrar qualquer issue — mensagem já lista URL + tipo de
 * problema, pronta pra aparecer no log/stderr do script chamador.
 */
export function assertNoAmazonAffiliateTagIssues(text: string, audience: AmazonAudience): void {
  const issues = findAmazonAffiliateTagIssues(text, audience);
  if (issues.length > 0) {
    throw new Error(
      `#8059: ${issues.length} link(s) Amazon com tag de afiliado inválida pra audiência "${audience}" ` +
        `após reescrita — ${issues.map((i) => `${i.issue}:${i.url}`).join(", ")}`,
    );
  }
}
