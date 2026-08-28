/**
 * scripts/lib/beehiiv-home-meta-check.ts (#4557)
 *
 * Lógica PURA (sem I/O) do drift-check da home pública (`https://diar.ia.br/`)
 * contra o `og:title` esperado + rótulos residuais em inglês do tema Beehiiv.
 * Mesmo molde de `scripts/lib/hub-drift-check.ts`/`scripts/lib/worker-drift-check.ts`:
 * uma função de decisão testável (`evaluateHomeMetaDrift`) que recebe o HTML
 * já buscado (nunca faz a chamada de rede em si), mais fingerprint/estado de
 * idempotência pro alarme por e-mail. O script `scripts/beehiiv-home-meta-check.ts`
 * é quem faz o `fetch` (GET simples, sem auth, sem API/MCP Beehiiv — é a home
 * pública, qualquer visitante vê o mesmo HTML) e usa este módulo pra decidir
 * SE/O-QUE alarmar.
 *
 * ─── Contexto (#4557) ───────────────────────────────────────────────────────
 *
 * A issue original pede 3 mudanças de PAINEL Beehiiv:
 *   1. `og:title` errado — mostra a grafia legada "Diar.ia" em vez da marca
 *      oficial "diar.ia.br" (ver `test/reader-facing-no-legacy-brand-4424.test.ts`
 *      pra convenção de marca do repo — sempre minúsculo, nunca "Diar.ia").
 *   2. Self-links internos em `http://diar.ia.br` (deveria ser `https://`).
 *   3. Rótulos residuais em inglês ("Sign Up", "Login", "N min read") na UI
 *      do tema Beehiiv, que deveria estar em português.
 *
 * A issue diz explicitamente que essas 3 mudanças são ação manual do editor
 * no painel Beehiiv — "não é código". O único pedaço em código que ela
 * autoriza é "um teste/guard que detecte regressão de og:title" — este
 * módulo (generalizado pros 3 eixos, já que os 3 são igualmente checáveis a
 * partir do HTML público) + o script irmão são esse guard.
 *
 * ─── Escopo: só og:title participa da checagem de MARCA ───────────────────
 *
 * `og:description`/`<meta name="description">` são extraídos e retornados em
 * `HomeMetaExtract` (dão contexto completo no corpo do e-mail de alarme), mas
 * só `og:title` entra em `evaluateHomeMetaDrift` como checagem de marca — é o
 * campo que a issue nomeia explicitamente (o que aparece em preview de
 * link/compartilhamento social).
 *
 * ─── 4º eixo: links legados `*.diaria.workers.dev` / `diaria.beehiiv.com` (#5099) ──
 *
 * A auditoria do #5099 (12/08/2026) achou o único ponto vivo de vazamento
 * reader-facing: a home da publicação (`https://diar.ia.br/`) linkava
 * `livros.diaria.workers.dev`, `cursos.diaria.workers.dev` e
 * `diaria.beehiiv.com/archive` em vez dos hosts de marca (`*.diar.ia.br`).
 * A troca em si (item 1 do #5099) é ação manual do editor na UI da Beehiiv —
 * este 4º eixo (`legacy-host-link`, item 2 do #5099) é só o GUARD: qualquer
 * `href` pra `*.diaria.workers.dev` ou `diaria.beehiiv.com` na home vira
 * drift, com exceção explícita pro badge `www.beehiiv.com/?utm_source=...`
 * do rodapé (plataforma, não host legado nosso) e pro CDN `media.beehiiv.com`
 * (imagens, nunca link de leitor) — ambos citados como fora de escopo no
 * corpo da issue.
 *
 * ─── 5º eixo: porta explícita numa URL reader-facing (#5106) ──────────────
 *
 * Achado adjacente à mesma auditoria (12/08/2026): toda página de edição
 * (`https://diar.ia.br/p/*`) termina com o bloco "Keep Reading" e um botão
 * "View more" apontando pra `https://diar.ia.br:3002/archive` — porta 3002,
 * sobra de ambiente de dev que ficou gravada no template do post no
 * Website Builder da Beehiiv, link morto nas 236 edições publicadas. A
 * troca do botão em si é ação manual do editor no template de post da
 * Beehiiv (fora de escopo aqui) — este 5º eixo (`port-in-url`) é o GUARD:
 * qualquer `href` com porta explícita numa superfície pública vira drift.
 * Diferente dos outros 4 eixos, o achado real está numa página `/p/*`, não
 * na home — por isso `evaluatePostPageDrift` é uma função SEPARADA de
 * `evaluateHomeMetaDrift`, avaliada pelo script chamador contra o HTML de
 * uma página de post (a mais recente, descoberta via `findLatestPostUrl`
 * sobre a própria home já buscada — sem depender de nenhuma fonte nova).
 *
 * ─── 6º eixo: hub temático publicado sem link na home (#5257) ─────────────
 *
 * A auditoria "Raio-X de /temas/" (14/08/2026) achou que 4 dos 5 hubs então
 * publicados nunca foram rastreados pelo Google — nenhuma página com
 * autoridade linkava pra eles. Este 6º eixo (`hub-link-missing`) é o GUARD
 * que já existe pros outros 5: cruza os slugs de `HUB_META` (fonte única de
 * verdade dos hubs publicados, ver `workers/arquivo/src/hubs/meta.ts`)
 * contra os `href="…/temas/{slug}"` efetivamente presentes no HTML da home,
 * e alarma qualquer hub sem link.
 *
 * **O que este eixo significa mudou em 28/08/2026 (#6411).** O item C do
 * #5097/#5257 (o bloco "Temas" em si) era ação manual do editor no Website
 * Builder da Beehiiv, então o alarme nasceu ACESO de propósito e ficou aceso
 * ~2 semanas, recriando a mesma issue todo dia sem que nenhuma sessão
 * pudesse agir (a issue caía em `fora-de-rodada` por carregar `alarm`, e o
 * corpo dizia "não é código deste repo"). Duas coisas mudaram: o apex saiu
 * da Beehiiv (hoje é `workers/site`, código deste repo — apesar do nome
 * deste arquivo, a home que ele audita não é mais um tema Beehiiv) e o
 * bloco passou a ser DERIVADO de `HUB_META` (`renderTopicLinks` em
 * `scripts/lib/site-home-page.ts`), travado por
 * `test/site-home-hub-links-6411.test.ts`. O eixo deixou de cobrar um passo
 * manual e virou guard de regressão do gerador: dispara se a home for ao ar
 * sem regenerar depois de um hub novo entrar em `HUB_META`.
 *
 * Nota de escopo pros outros eixos: `english-labels` (rótulos residuais do
 * tema Beehiiv) perdeu a razão de ser NA HOME pelo mesmo motivo, mas segue
 * válido — `port-in-url` avalia a página da edição mais recente, e o
 * conteúdo de `/p/{slug}` ainda vem do render Beehiiv em cache.
 */

import { HUB_META, type HubMeta } from "../../workers/arquivo/src/hubs/meta.ts";

// ─── Extração (pura) ────────────────────────────────────────────────────────

export interface HomeMetaExtract {
  ogTitle: string | null;
  ogDescription: string | null;
  metaDescription: string | null;
}

/**
 * Pura — casa `<meta property="{key}" content="...">` (ou a ordem inversa de
 * atributos) e retorna o `content` decodificado, ou `null` se ausente. Nunca
 * lança (regex simples sobre string, sem parser DOM).
 */
function matchMetaContent(html: string, key: string, attr: "property" | "name"): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+${attr}=["']${escapedKey}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+${attr}=["']${escapedKey}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeEntities(m[1].trim());
  }
  return null;
}

/** Pura — decode HTML entities comuns em meta content. Mesma lista de
 * `scripts/lib/extract-og.ts` (fonte já validada pra esse propósito). */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

/**
 * Pura — extrai `og:title`, `og:description` e `<meta name="description">`
 * do HTML da home. Diferente de `extractOgFromBody` (`scripts/lib/extract-og.ts`,
 * que serve outro propósito — enriquecer snippet de busca com fallback em
 * cadeia title→og:title, description→og:description→meta description), os 3
 * campos aqui são extraídos de forma INDEPENDENTE, sem fallback cruzado —
 * este módulo audita os 3 separadamente, então conflacionar esconderia
 * exatamente o tipo de drift que ele existe para detectar. Nunca lança;
 * campo ausente vira `null`.
 */
export function extractHomeMeta(html: string): HomeMetaExtract {
  return {
    ogTitle: matchMetaContent(html, "og:title", "property"),
    ogDescription: matchMetaContent(html, "og:description", "property"),
    metaDescription: matchMetaContent(html, "description", "name"),
  };
}

// ─── Detecção de drift (pura) ───────────────────────────────────────────────

/** Marca oficial (minúscula, sempre) — ver `test/reader-facing-no-legacy-brand-4424.test.ts`. */
const OFFICIAL_BRAND = "diar.ia.br";

/** Grafia legada — nunca deveria aparecer em superfície reader-facing. */
const LEGACY_BRAND_RE = /Diar\.ia\b/;

/** Conta ocorrências de `href="http://diar.ia.br` (self-link inseguro) no HTML. */
export function countHttpSelfLinks(html: string): number {
  const re = /href=["']http:\/\/diar\.ia\.br/gi;
  return (html.match(re) ?? []).length;
}

/**
 * Pura — extrai só o texto RENDERIZADO de `html` (#5137): remove
 * `<script>`/`<style>` inteiros (cobre o JSON de config do builder Beehiiv
 * quando embutido num bloco de script) e substitui toda tag restante —
 * ABERTURA COM SEUS ATRIBUTOS incluídos — por um espaço, o que também
 * descarta qualquer JSON/config guardado como valor de atributo (`data-*`,
 * etc.) sem precisar tratar isso como caso especial: a tag inteira
 * `<algo attr="…JSON…">` vira um espaço, sobrando só o texto ENTRE tags.
 * Não é um parser DOM (regex sobre string, mesmo padrão do resto deste
 * módulo) — suficiente pra separar "dado de configuração" (nunca visto pelo
 * leitor) de "texto que o leitor de fato vê", que é o que os rótulos em
 * inglês deveriam casar contra.
 */
export function extractVisibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ");
}

/** Rótulos em inglês residuais que a UI do tema Beehiiv não deveria mais
 * mostrar (issue #4557, item 3). Casados contra `extractVisibleText` (#5137),
 * não contra o HTML cru — por isso não precisam mais dos delimitadores
 * `>…<` (o texto já vem sem tags). "N min read" cobre qualquer inteiro
 * ("5 min read", "12 min read", etc.), case-insensitive. */
const ENGLISH_LABEL_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: '"Sign Up"', re: /\bSign Up\b/ },
  { label: '"Login"', re: /\bLogin\b/ },
  { label: '"N min read"', re: /\b\d+\s*min read\b/i },
];

/**
 * Pura — retorna a lista de rótulos em inglês encontrados no HTML (vazio se
 * nenhum). #5137: casa contra `extractVisibleText(html)`, não contra o HTML
 * cru — uma página Beehiiv embute o JSON de configuração do builder inteiro
 * (ex: `"label":"Sign Up"` no payload da navbar), e qualquer string em
 * inglês que exista só como DADO de configuração casava igual a texto
 * visível antes desta correção. "Sign Up" em botão de ação padrão
 * (`action:"sign_up"`) é ignorado pela Beehiiv e renderizado traduzido
 * ("Assinar") pelo locale da publicação — o leitor nunca vê a string EN.
 */
export function detectEnglishLabels(html: string): string[] {
  const text = extractVisibleText(html);
  const found: string[] = [];
  for (const { label, re } of ENGLISH_LABEL_PATTERNS) {
    if (re.test(text)) found.push(label);
  }
  return found;
}

/**
 * Hosts de plataforma Beehiiv explicitamente FORA de escopo (#5099) — nunca
 * reportados como link legado mesmo que apareçam na home. `media.beehiiv.com`
 * é CDN de imagem (nunca link de leitor); `www.beehiiv.com`/`api.beehiiv.com`
 * são plataforma, não host legado NOSSO (o badge "powered by" do rodapé, por
 * exemplo). Set em vez de checagem inline pra deixar a exceção nomeada e
 * fácil de auditar isoladamente.
 */
const ALLOWED_BEEHIIV_PLATFORM_HOSTS = new Set(["media.beehiiv.com", "www.beehiiv.com", "api.beehiiv.com"]);

/** `true` se `host` casa o padrão de host legado (#5099): qualquer
 * `*.workers.dev` (cobre `cursos.diaria.workers.dev`, `livros.diaria.workers.dev`
 * etc. sem hardcodar o subdomínio de conta) ou `diaria.beehiiv.com` (host
 * legado da própria publicação, ANTES do cutover pra `diar.ia.br` — #4059).
 * `ALLOWED_BEEHIIV_PLATFORM_HOSTS` acima nunca casa aqui: são hosts
 * DIFERENTES (não substring de `diaria.beehiiv.com`/`.workers.dev`), a
 * checagem por host exato (não substring solta de "beehiiv.com") é o que
 * evita qualquer ambiguidade.
 *
 * O match `.workers.dev` é MAIS AMPLO que "nossos hosts legados": casa
 * QUALQUER `*.workers.dev`, inclusive um de conta de terceiro que nunca foi
 * nosso (mesmo padrão de `resolveWorkersDevRedirect` em
 * `workers-dev-redirect.ts`, #5104). Aqui isso é um gap REAL, não inofensivo
 * como no redirect: a home é conteúdo editorial, e um link legítimo pra um
 * `*.workers.dev` de terceiro citado numa edição (ex: um projeto open-source
 * hospedado lá) viraria falso positivo de `legacy-host-link`. Amplo de
 * propósito mesmo assim — aceita esse risco de falso positivo em troca de
 * nunca deixar passar uma variante nossa que ninguém pensou em nomear
 * explicitamente; falso positivo custa 1 linha ignorada no e-mail de alarme,
 * falso negativo custa um vazamento silencioso como o do #5099. */
function isLegacyHost(host: string): boolean {
  const h = host.toLowerCase();
  if (ALLOWED_BEEHIIV_PLATFORM_HOSTS.has(h)) return false;
  return h.endsWith(".workers.dev") || h === "diaria.beehiiv.com";
}

/**
 * Pura — extrai (deduplicado, ordenado) os hosts distintos de `href="http(s)://..."`
 * que casam `isLegacyHost` acima (#5099, item 2). Regex sobre string (mesmo
 * padrão dos outros extractors deste módulo — HTML público, sem parser DOM);
 * nunca lança.
 */
export function detectLegacyHostLinks(html: string): string[] {
  const found = new Set<string>();
  const re = /href=["']https?:\/\/([^"'/?#]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const host = m[1];
    if (isLegacyHost(host)) found.add(host.toLowerCase());
  }
  return [...found].sort();
}

/** Casa `/temas/{slug}` como o COMPONENTE INTEIRO do path — delimitado por
 * `"`/`'`/`/`/`?`/`#` ou fim de string do lado direito — pra um slug que é
 * prefixo de outro (ex: "openai" dentro de um slug hipotético
 * "openai-x") nunca dar falso positivo. */
function hubLinkPattern(slug: string): RegExp {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`/temas/${escaped}(?=["'/?#]|$)`);
}

/**
 * Pura — retorna (na ordem de `hubs`) os slugs de `hubs` cujo link
 * `/temas/{slug}` NÃO aparece em `html` — hub publicado (presente em
 * `HUB_META`) sem link de descoberta na home (#5257, 6º eixo). Casa o path
 * `/temas/{slug}` independente de host (a home linka pro subdomínio
 * `arquivo.diar.ia.br`, que serve os hubs — ver `workers/arquivo/src/hubs/`),
 * então tanto `href="/temas/{slug}"` (relativo) quanto
 * `href="https://arquivo.diar.ia.br/temas/{slug}"` (absoluto) contam como
 * presente. Regex sobre string (mesmo padrão do resto deste módulo); nunca
 * lança. `hubs` é injetável pra teste; produção sempre usa o default
 * (`HUB_META` real).
 */
export function detectMissingHubLinks(html: string, hubs: readonly HubMeta[] = HUB_META): string[] {
  return hubs.filter((h) => !hubLinkPattern(h.slug).test(html)).map((h) => h.slug);
}

export type HomeMetaDriftCheck =
  | "og-title-brand"
  | "http-self-link"
  | "english-labels"
  | "legacy-host-link"
  | "port-in-url"
  | "hub-link-missing";

export interface HomeMetaDriftFinding {
  readonly check: HomeMetaDriftCheck;
  readonly message: string;
}

/**
 * Pura — avalia os 3 eixos de drift da issue #4557 + o 4º eixo do #5099 +
 * o 6º eixo do #5257 a partir do HTML da home já buscado (nenhuma chamada
 * de rede aqui). Retorna a lista de achados — vazia quando os 5 eixos estão
 * limpos.
 *
 *   1. `og-title-brand`: og:title ausente, sem a marca oficial "diar.ia.br",
 *      ou contendo a grafia legada "Diar.ia".
 *   2. `http-self-link`: qualquer `href="http://diar.ia.br...` na página.
 *   3. `english-labels`: qualquer rótulo em `ENGLISH_LABEL_PATTERNS` presente.
 *   4. `legacy-host-link` (#5099): qualquer `href` pra `*.workers.dev` ou
 *      `diaria.beehiiv.com` — exceto os hosts de plataforma Beehiiv em
 *      `ALLOWED_BEEHIIV_PLATFORM_HOSTS`.
 *   5. `hub-link-missing` (#5257): qualquer hub de `HUB_META` sem link
 *      `/temas/{slug}` na home.
 */
export function evaluateHomeMetaDrift(
  html: string,
  extract: HomeMetaExtract = extractHomeMeta(html),
): HomeMetaDriftFinding[] {
  const findings: HomeMetaDriftFinding[] = [];

  const title = extract.ogTitle;
  const hasOfficialBrand = !!title && title.includes(OFFICIAL_BRAND);
  const hasLegacyBrand = !!title && LEGACY_BRAND_RE.test(title);
  if (!hasOfficialBrand || hasLegacyBrand) {
    findings.push({
      check: "og-title-brand",
      message: title
        ? `og:title não usa a marca oficial "diar.ia.br": "${title}"`
        : `og:title ausente na home — esperava conter "diar.ia.br"`,
    });
  }

  const selfLinkCount = countHttpSelfLinks(html);
  if (selfLinkCount > 0) {
    findings.push({
      check: "http-self-link",
      message: `${selfLinkCount} ocorrência(s) de href="http://diar.ia.br" (self-link inseguro — deveria ser https)`,
    });
  }

  const englishLabels = detectEnglishLabels(html);
  if (englishLabels.length > 0) {
    findings.push({
      check: "english-labels",
      message: `rótulo(s) em inglês residual(is) encontrado(s): ${englishLabels.join(", ")}`,
    });
  }

  const legacyHosts = detectLegacyHostLinks(html);
  if (legacyHosts.length > 0) {
    findings.push({
      check: "legacy-host-link",
      message: `link(s) reader-facing pra host legado encontrado(s): ${legacyHosts.join(", ")} — deveria ir pro host de marca *.diar.ia.br (#5099)`,
    });
  }

  const missingHubs = detectMissingHubLinks(html);
  if (missingHubs.length > 0) {
    findings.push({
      check: "hub-link-missing",
      message: `hub(s) publicado(s) sem link "/temas/{slug}" na home: ${missingHubs.join(", ")} — adicionar ao bloco "Temas" da home (#5257)`,
    });
  }

  return findings;
}

/** Pura — `true` se há qualquer achado de drift. */
export function hasHomeMetaDrift(findings: readonly HomeMetaDriftFinding[]): boolean {
  return findings.length > 0;
}

// ─── 5º eixo: porta explícita numa URL reader-facing (#5106) ───────────────

/**
 * Pura — extrai (deduplicado, ordenado) os `href="http(s)://host:PORTA/…"`
 * de `html` — qualquer porta explícita numa superfície pública é sobra de
 * dev/config (#5106: o botão "View more" de toda página de edição apontava
 * pra `https://diar.ia.br:3002/archive`, porta 3002 — link morto nas 236
 * edições publicadas). Regex sobre string (mesmo padrão do resto deste
 * módulo); nunca lança.
 */
export function detectPortInUrlLinks(html: string): string[] {
  const found = new Set<string>();
  const re = /href=["'](https?:\/\/[^"'/?#\s]+:\d+[^"']*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    found.add(m[1]);
  }
  return [...found].sort();
}

/**
 * Pura — extrai a URL da edição mais recente a partir do HTML da home
 * (#5106): a home lista as edições mais recentes primeiro, então o PRIMEIRO
 * `href="{baseUrl}/p/{slug}"` em ordem de documento já é o post mais
 * recente — mesmo mecanismo que o check já usa pra obter o HTML da home,
 * sem depender de nenhuma fonte externa nova (Beehiiv API, cache local).
 * Retorna `null` se nenhum link `/p/` for encontrado (nunca lança).
 */
export function findLatestPostUrl(homeHtml: string, baseUrl: string): string | null {
  const escapedBase = baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`href=["'](${escapedBase}/p/[a-z0-9-]+)["']`, "i");
  const m = homeHtml.match(re);
  return m ? m[1] : null;
}

/**
 * Pura — avalia o 5º eixo (`port-in-url`, #5106) a partir do HTML de uma
 * página de POST já buscada (nenhuma chamada de rede aqui) — separado de
 * `evaluateHomeMetaDrift` porque o achado real mora numa página `/p/*`
 * ("Keep Reading" → "View more"), não na home; o script chamador busca a
 * página via `findLatestPostUrl` e passa o HTML aqui. Retorna a lista de
 * achados — vazia quando limpo.
 */
export function evaluatePostPageDrift(html: string): HomeMetaDriftFinding[] {
  const findings: HomeMetaDriftFinding[] = [];
  const portLinks = detectPortInUrlLinks(html);
  if (portLinks.length > 0) {
    findings.push({
      check: "port-in-url",
      message: `link(s) com porta explícita na URL: ${portLinks.join(", ")} — sobra de dev, nunca deveria estar em superfície pública (#5106)`,
    });
  }
  return findings;
}

// ─── Idempotência do alarme (fingerprint + estado) ─────────────────────────
// Mesmo padrão de scripts/lib/hub-drift-check.ts/worker-drift-check.ts.

export interface HomeMetaAlarmState {
  lastAlarmedFingerprint: string | null;
  lastCheckedAt: string | null;
}

export function emptyHomeMetaAlarmState(): HomeMetaAlarmState {
  return { lastAlarmedFingerprint: null, lastCheckedAt: null };
}

/** Pura — fingerprint estável (determinístico, independente de ordem) dos
 * achados pendentes — usado pra idempotência (mesmo drift não re-alarma). */
export function computeHomeMetaFingerprint(findings: readonly HomeMetaDriftFinding[]): string {
  return findings
    .map((f) => `${f.check}:${f.message}`)
    .sort()
    .join("|");
}

/** Pura — `true` quando há drift pendente E o fingerprint difere do último alarmado. */
export function shouldAlarmHomeMetaDrift(
  state: HomeMetaAlarmState,
  findings: readonly HomeMetaDriftFinding[],
): boolean {
  if (!hasHomeMetaDrift(findings)) return false;
  return computeHomeMetaFingerprint(findings) !== state.lastAlarmedFingerprint;
}

/** Pura — avança o cursor. `fingerprint: null` quando não há drift pendente
 * nesta checagem (re-arma pra próxima ocorrência). */
export function advanceHomeMetaAlarmState(fingerprint: string | null, now: Date): HomeMetaAlarmState {
  return { lastAlarmedFingerprint: fingerprint, lastCheckedAt: now.toISOString() };
}

// ─── Corpo do e-mail de alarme (puro) ──────────────────────────────────────

/** Referência de issue GitHub associada a um achado — mesmo shape de
 * `AlarmFindingOutcome` (`scripts/lib/alarm-issues.ts`, #5112), sem
 * importar o módulo aqui pra manter este arquivo sem dependência do
 * subsistema de issues (só o script chamador conecta os dois). */
export interface HomeMetaFindingIssueRef {
  issueNumber: number | null;
  url: string | null;
  // #5978 — "reopened" acompanha o mesmo valor novo de `AlarmIssueResult.action`.
  action: "created" | "reused" | "reopened" | "failed";
  error?: string;
}

/** Chave estável pra casar um `HomeMetaDriftFinding` com seu
 * `HomeMetaFindingIssueRef` — mesma fórmula usada por
 * `computeHomeMetaFingerprint` por item, então o caller pode montar o mapa
 * direto a partir do `fingerprint` já usado em `AlarmFinding` (#5112). */
export function homeMetaFindingIssueKey(f: Pick<HomeMetaDriftFinding, "check" | "message">): string {
  return `${f.check}:${f.message}`;
}

/** Pura — monta assunto + corpo do e-mail de alarme (texto puro, mesmo
 * padrão de `hub-drift-check.ts`/`worker-drift-check.ts`, sem HTML).
 * `issueRefs` é opcional (#5112) — quando presente, cada achado ganha uma
 * citação `→ #NNNN (criada)` / `→ #NNNN (existente)` / `→ issue não
 * criada: {erro}`, com a URL completa da issue (quando houver) pro editor
 * clicar direto do e-mail. Omitir `issueRefs` preserva o texto de antes
 * (back-compat com chamadas existentes, mesmo padrão do `guardWarnings`
 * opcional em `apoios-diff-alarm.ts`). */
export function buildHomeMetaDriftAlarmEmail(
  findings: readonly HomeMetaDriftFinding[],
  extract: HomeMetaExtract,
  homeUrl: string,
  issueRefs?: ReadonlyMap<string, HomeMetaFindingIssueRef>,
): { subject: string; body: string } {
  const subject = `[diar.ia.br] drift de metadata na home (${findings.length} achado(s))`;

  const lines: string[] = [
    `O smoke-test de metadata da home pública (${homeUrl}) encontrou drift`,
    "num dos eixos monitorados — ver o(s) achado(s) abaixo pro que exatamente",
    "está errado.",
    "",
    "Refs #4557/#5099/#5106 — as correções de eixo (og:title, http->https,",
    "rótulos EN, link pra host legado, porta na URL) são ação manual do",
    "editor no painel/template Beehiiv; este alarme só detecta REGRESSÃO",
    "depois de corrigido (ou aponta o que ainda falta corrigir, na 1ª",
    "execução).",
    "",
    `Achado(s) (${findings.length}):`,
  ];

  for (const f of findings) {
    let line = `  - [${f.check}] ${f.message}`;
    const ref = issueRefs?.get(homeMetaFindingIssueKey(f));
    if (ref) {
      if (ref.action === "created") line += ` → #${ref.issueNumber} (criada) — ${ref.url}`;
      else if (ref.action === "reused") line += ` → #${ref.issueNumber} (existente) — ${ref.url}`;
      // #5978 — issue localizada estava fechada; reaberta em vez de reusada silenciosamente.
      else if (ref.action === "reopened") line += ` → #${ref.issueNumber} (reaberta) — ${ref.url}`;
      else line += ` → issue não criada: ${ref.error ?? "erro desconhecido"}`;
    }
    lines.push(line);
  }

  lines.push("");
  lines.push("Metadata atual extraída da home:");
  lines.push(`  og:title: ${extract.ogTitle ?? "(ausente)"}`);
  lines.push(`  og:description: ${extract.ogDescription ?? "(ausente)"}`);
  lines.push(`  meta description: ${extract.metaDescription ?? "(ausente)"}`);

  return { subject, body: lines.join("\n") };
}
