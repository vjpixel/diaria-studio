import type { BrevoCampaign, BrevoLinksStats } from "./types.ts";
import { DS_COLORS, DS_FONTS as DSF } from "./ds-tokens.generated.ts";
import { classifyLinkContent } from "./link-content.ts";
// #4184: coluna "Seção" (Destaques/Use Melhor/Radar) — resolução/formatação
// pura, ver link-section.ts. Re-exportado via `export *` abaixo (mesmo
// padrão de billing-cycle.ts/staleness.ts — index.ts agrega tudo).
import {
  type LinkSectionMap,
  type LinkSectionCell,
  lookupLinkSectionCell,
  formatLinkSectionCell,
  LINK_SECTION_COLUMN_LABEL,
  LINK_SECTION_COLUMN_TOOLTIP,
  LINK_SECTION_LABELS,
  LINK_SECTION_FALLBACK_LABEL,
} from "./link-section.ts";
export * from "./link-section.ts";
// NOTE (#2832): import circular com sections-core.ts (esHtml/parseClariceCampaignKey/
// monthKeyBRT são usados aqui mas definidos lá). Seguro — todos os usos abaixo são
// dentro de corpos de função chamados em request-time, nunca em top-level do módulo,
// então a ordem de inicialização ESM não importa (mesmo padrão que já existia
// implicitamente dentro do monólito index.ts antes da quebra em módulos).
import { escHtml, parseClariceCampaignKey, monthKeyBRT, extractMonthlyCycleCandidate, resolveCampaignCycle } from "./sections-core.ts"; // #4405: extractMonthlyCycleCandidate/resolveCampaignCycle

/**
 * `DS.alert` permanece local — é uma cor semântica de ferramenta interna
 * (circuit breaker threshold), sem token canônico no DS de marca.
 */
export const DS = {
  ...DS_COLORS,
  // Alerta de circuit breaker: sem cor canônica no DS — red semântico de
  // ferramenta interna. Não é uma cor de marca, portanto não entra no DS.
  // Valor mantido como constante local explícita para evitar magic string.
  alert:    "#C00000",  // vermelho de alerta (circuit breaker threshold)
} as const;

/** Exportado para o teste de drift (test/brevo-dashboard-ds-drift.test.ts). */
export const DS_TOKENS = DS_COLORS;
export const DS_FONTS = DSF;

/**
 * #3087: cores semânticas de status (verde/amarelo/vermelho), consolidadas
 * NUM ÚNICO lugar ao lado de `DS.alert` — antes `weekly-plan.ts` declarava seu
 * próprio `STATUS_COLOR` com um vermelho (#c0392b) que divergia do vermelho de
 * alerta usado no resto do dashboard (`DS.alert`, #C00000), e um amarelo
 * (#b07a00) abaixo do mínimo AA (~3.7:1 sobre --card). Correção (não é
 * proposta de paleta nova — consolidação):
 *   - red: reusa `DS.alert` direto (mesmo vermelho do resto da dashboard).
 *   - yellow/green: escurecidos até cruzar 4.5:1 (WCAG AA, texto normal) sobre
 *     `--card` (#FFFFFF, o fundo mais claro onde estas cores aparecem —
 *     `.table-wrap`/`table` usam `--card`). Luminância relativa calculada via
 *     fórmula WCAG (sRGB linearizado): amarelo `#8A6100` ≈ 5.5:1 sobre --card
 *     (era ~3.7:1); verde `#0E6B39` ≈ 6.6:1 sobre --card (era ~4.4:1, já
 *     passava mas sem folga). Detalhe do cálculo no corpo do PR #3087.
 */
export const STATUS_COLOR: Record<"green" | "yellow" | "red", string> = {
  green: "#0E6B39",
  yellow: "#8A6100",
  red: DS.alert,
};


/**
 * #3081 (formatação/UX): denominador 0 retorna "—" (não "0.0%") — "0.0%"
 * afirma um dado real (taxa medida e igual a zero), enquanto "—" comunica
 * "sem dado" (nenhum evento pra calcular a taxa). Consistente com o
 * `pctOrDash`/`numOrDash` já usados em `sections-kv.ts` para o mesmo caso.
 *
 * `decimals` (default 1, preserva o comportamento de todos os callers
 * existentes) — os call sites de Spam usam 3 casas explicitamente
 * (`pct(n, total, 3)`), pois o circuit breaker dispara em ≥0.1% e 1 casa
 * arredondaria 0.049%→"0.0%", mascarando o cruzamento do limiar.
 */
export function pct(n: number, total: number, decimals = 1): string {
  if (!total) return "—";
  return ((n / total) * 100).toFixed(decimals) + "%";
}

/**
 * Gera o atributo `class="..."` a partir de N classes. Strings vazias /
 * null / false são filtradas. Retorna string vazia (sem atributo) se
 * sobrar zero classes. Uso: `<td${cellClass("metric", maybeAlert)}>...`.
 */
export function cellClass(...names: Array<string | false | null | undefined>): string {
  const valid = names.filter((n): n is string => Boolean(n));
  return valid.length === 0 ? "" : ` class="${valid.join(" ")}"`;
}

// ─── #2177: distribuição de cliques por link (não é CTR/CTOR — Brevo v3 não dá opens/unique-clicks por link) ───

/**
 * URLs de tracking/sistema a filtrar do linksStats: unsubscribe, preferências,
 * links de tracking Brevo e Mailgun. Filtro conservador — só remove o que é
 * claramente sistema, não editorial.
 *
 * NOTA: UTMs (utm_source, utm_campaign, etc.) NÃO são filtrados — são parâmetros
 * de tracking editorial legítimos que devem aparecer no relatório de links.
 */
const SYSTEM_URL_PATTERNS = [
  /unsubscribe/i,        // também cobre r.brevo.com/links/unsubscribe — regex específico removido (#2183)
  /optout/i,
  /opt-out/i,
  /preferences/i,
  /preferencias/i,
  /manage.*subscription/i,
  /email\.mg\./i,        // Mailgun tracking
];

/**
 * Retorna true se a URL deve ser filtrada do report de links (sistema/rodapé).
 */
export function isSystemLink(url: string): boolean {
  return SYSTEM_URL_PATTERNS.some((p) => p.test(url));
}

/**
 * Trunca uma URL para exibição (max 70 chars).
 * Helper compartilhado entre parseLinksStats e aggregateLinksAcrossCampaigns
 * para evitar duplicação (#2216 cleanup, finding #2).
 */
export function truncateUrl(url: string): string {
  return url.length > 70 ? url.slice(0, 67) + "…" : url;
}

/**
 * Retorna linksStats de uma campanha — fonte canônica: statistics.linksStats,
 * com fallback pra top-level linksStats (backward compat com fixtures/testes legados).
 * Helper compartilhado (#2216 cleanup, finding #4 — elimina dual-source duplicado).
 */
export function getCampaignLinksStats(
  c: BrevoCampaign & { listName?: string; listSize?: number; linksStats?: BrevoLinksStats },
): BrevoLinksStats | undefined {
  return c.statistics?.linksStats ?? c.linksStats;
}

/**
 * Detalhe de uma variante de URL colapsada dentro do mesmo conteúdo — ex: o
 * split A/B da enquete "É IA?" (#4053). Não entra na ordenação/chave, é só
 * sinal editorial secundário.
 */
export interface LinkVariantDetail {
  /** Rótulo da variante (ex: choice "A"/"B" da enquete) */
  label: string;
  clicks: number;
}

/**
 * Estrutura de um link processado para exibição no dashboard.
 *
 * #4053: a linha agora é indexada por CONTEÚDO (`content`), não por URL —
 * várias URLs que apontam pro mesmo conteúdo editorial (ex: os 2 links da
 * enquete "É IA?", ou a mesma página com UTMs diferentes) colapsam numa
 * única linha com os cliques somados. `url`/`displayUrl` seguem existindo
 * como a URL REPRESENTATIVA (a de maior clique dentro do grupo) — útil como
 * link clicável — e `variantCount` denuncia quando há mais de 1 URL por trás
 * do conteúdo.
 */
export interface LinkStatRow {
  /** Rótulo de conteúdo (chave de agrupamento, #4053) */
  content: string;
  /** URL representativa (maior clique dentro do grupo de conteúdo) */
  url: string;
  /** URL representativa truncada para exibição (max 70 chars) */
  displayUrl: string;
  /** Quantas URLs distintas foram colapsadas neste conteúdo */
  variantCount: number;
  clicks: number;
  /** Participação percentual em relação ao total de clicks editoriais da campanha (links de sistema excluídos) */
  pctOfTotal: string;
  /** Split por variante (ex: A/B da enquete) — presente só quando o classificador emite `variant` */
  variants?: LinkVariantDetail[];
  /**
   * #4184: seção editorial (Destaques/Use Melhor/Radar) de origem deste
   * conteúdo, já resolvida/formatada (fallback "—" quando desconhecida).
   * Opcional só pra retrocompat com construções manuais em teste — toda linha
   * produzida por `parseLinksStats` sempre a popula (nunca fica `undefined`
   * organicamente).
   */
  section?: LinkSectionCell;
}

/**
 * Parseia `linksStats` (mapa url→clicks) da Brevo, filtra links de sistema,
 * agrupa por CONTEÚDO (#4053, via `classifyLinkContent` — não mais por URL
 * completa) e retorna array de LinkStatRow ordenado por clicks DESC com
 * participação %.
 *
 * Nota sobre unique-clicks: a API Brevo v3 (`GET /v3/emailCampaigns/{id}?statistics=linksStats`)
 * expõe apenas clicks totais por URL — sem unique-clicks por link. Unique-clicks
 * só existem agregados no nível da campanha (`globalStats.uniqueClicks`).
 * Portanto, a tabela exibe apenas "Clicks" (total) e omite coluna unique graciosamente.
 *
 * @param linksStats - mapa url→clicks da Brevo (pode ser undefined/null)
 * @param sectionMap - #4184: mapa CONTEÚDO→seções (Destaques/Use Melhor/Radar)
 *   do ciclo mensal desta campanha, ou `null`/ausente (fallback "—" em toda linha)
 * @param titleMap - #4198: mapa CONTEÚDO BASE→título editorial (`scripts/lib/mensal/monthly-link-sections.ts::buildLinkTitleMap`),
 *   ou `null`/ausente (comportamento anterior ao #4198 preservado — rótulo
 *   sempre derivado da URL). Quando o conteúdo tem título conhecido, ele
 *   SUBSTITUI o rótulo exibido na coluna "Conteúdo" — não afeta a chave de
 *   agrupamento (`content`, ainda calculada por `classifyLinkContent(url)`
 *   sem título) nem a resolução de `section` acima, que continuam chaveadas
 *   pelo CONTEÚDO BASE (evita dessincronizar do mapa de seção, que é
 *   resolvido independentemente sobre as mesmas URLs de clique).
 * @returns array de LinkStatRow ordenado por clicks DESC, vazio se sem dados
 */
export function parseLinksStats(
  linksStats: BrevoLinksStats | undefined | null,
  sectionMap?: LinkSectionMap | null,
  titleMap?: Record<string, string> | null,
): LinkStatRow[] {
  if (!linksStats) return [];

  const entries = Object.entries(linksStats)
    .filter(([url]) => !isSystemLink(url))
    // #2216 finding #3: Number.isFinite guard — `clicks > 0` is NaN-transparent
    // (NaN > 0 is false, but NaN can still propagate if checked differently elsewhere).
    // isFinite covers NaN, Infinity, and -Infinity. Consistent with #2207 NaN class.
    .filter(([, clicks]) => Number.isFinite(clicks) && clicks > 0);

  if (entries.length === 0) return [];

  const totalClicks = entries.reduce((sum, [, clicks]) => sum + clicks, 0);

  // #4053: agrupa por content — cada bucket acumula as URLs (pra achar a
  // representativa) e, quando o classificador emite `variant`, o split por
  // variante (ex: A/B).
  const buckets = new Map<
    string,
    { urlClicks: Map<string, number>; variantClicks: Map<string, number> }
  >();

  for (const [url, clicks] of entries) {
    const { content, variant } = classifyLinkContent(url);
    let bucket = buckets.get(content);
    if (!bucket) {
      bucket = { urlClicks: new Map(), variantClicks: new Map() };
      buckets.set(content, bucket);
    }
    bucket.urlClicks.set(url, (bucket.urlClicks.get(url) ?? 0) + clicks);
    if (variant) {
      bucket.variantClicks.set(variant, (bucket.variantClicks.get(variant) ?? 0) + clicks);
    }
  }

  const rows: LinkStatRow[] = Array.from(buckets.entries()).map(([content, bucket]) => {
    const urlEntries = Array.from(bucket.urlClicks.entries()).sort(([, a], [, b]) => b - a);
    const representativeUrl = urlEntries[0][0];
    const clicks = urlEntries.reduce((sum, [, c]) => sum + c, 0);
    const variants: LinkVariantDetail[] | undefined =
      bucket.variantClicks.size > 0
        ? Array.from(bucket.variantClicks.entries())
            .map(([label, vClicks]) => ({ label, clicks: vClicks }))
            .sort((a, b) => b.clicks - a.clicks)
        : undefined;

    return {
      // #4198: título editorial substitui o rótulo derivado da URL quando
      // conhecido — chave de agrupamento/seção (acima/abaixo) permanece o
      // conteúdo BASE, só o valor EXIBIDO muda.
      content: titleMap?.[content] ?? content,
      url: representativeUrl,
      displayUrl: truncateUrl(representativeUrl), // #2216 finding #2: extraído helper truncateUrl
      variantCount: urlEntries.length,
      clicks,
      pctOfTotal: pct(clicks, totalClicks), // reusa helper pct() (#2183)
      variants,
      section: lookupLinkSectionCell(content, sectionMap, representativeUrl), // #4184/#4405
    };
  });

  return rows.sort((a, b) => b.clicks - a.clicks);
}

/**
 * Renderiza a tabela de distribuição de cliques por link como HTML colapsável (<details>/<summary>).
 * Graceful quando linksStats ausente ou sem links editoriais: retorna stub vazio.
 *
 * @param campaignId - usado no id do <details> para unicidade
 * @param linksStats - mapa url→clicks (pode ser undefined)
 * @param totalClicks - uniqueClicks da campanha (pra contexto no summary)
 * @param sectionMap - #4184: mapa CONTEÚDO→seções do ciclo mensal EXATO desta
 *   campanha (não um merge cross-ciclo — ver `renderAggregatedLinksSection`
 *   pra esse caso), ou `null`/ausente (fallback "—" em toda linha)
 * @param titleMap - #4198: mapa CONTEÚDO BASE→título editorial do ciclo
 *   mensal EXATO desta campanha, ou `null`/ausente (rótulo derivado da URL,
 *   comportamento anterior ao #4198 preservado). Ver `parseLinksStats`.
 */
export function renderLinksSection(
  campaignId: number,
  linksStats: BrevoLinksStats | undefined | null,
  totalClicks?: number,
  sectionMap?: LinkSectionMap | null,
  titleMap?: Record<string, string> | null,
): string {
  const rows = parseLinksStats(linksStats, sectionMap, titleMap);

  // Stub graceful: sem linksStats ou sem links editoriais → seção oculta mas presente
  if (rows.length === 0) {
    let reason: string;
    if (linksStats == null) {
      reason = "dados de links não disponíveis";
    } else if (Object.keys(linksStats).length === 0) {
      reason = "nenhum link rastreado";
    } else {
      // Distingue "editorial com 0 clicks" de "só links de sistema" (#2183):
      // filtra só sistema; se sobrar algo → havia links editoriais, mas todos com 0 clicks.
      const editorialEntries = Object.entries(linksStats).filter(([url]) => !isSystemLink(url));
      reason = editorialEntries.length > 0
        ? "links editoriais presentes, mas com 0 cliques registrados"
        : "nenhum link editorial (apenas links de sistema)";
    }
    return `<details class="links-ctr" id="links-${campaignId}">
  <summary class="links-summary">Links clicados <span class="links-count-badge">—</span></summary>
  <p class="links-empty">${escHtml(reason)}</p>
</details>`;
  }

  // Nota: totalClicks é o uniqueClicks agregado da campanha (inclui links de sistema),
  // enquanto a coluna "% do total" usa como denominador apenas os clicks editoriais.
  // Os dois denominadores diferem intencionalmente — totalClicks é contexto global,
  // % do total é participação relativa dentro dos links editoriais.
  const clicksSuffix = totalClicks !== undefined ? ` de ${totalClicks} únicos (campanha)` : "";
  const tableRows = rows.map((r) => {
    // Defensive XSS guard: neutralize javascript: and other dangerous schemes (#2183).
    // Only allow http:// and https:// as href values.
    const safeHref = /^https?:\/\//i.test(r.url) ? escHtml(r.url) : "";
    // #4053: tooltip do link representativo mostra também o split por variante
    // (ex: A/B da enquete) quando presente — detalhe secundário, não afeta a chave.
    const variantSuffix = r.variants
      ? ` (${r.variants.map((v) => `${v.label}: ${v.clicks}`).join(", ")})`
      : "";
    const linkTitle = escHtml(`${r.url}${variantSuffix}`);
    const linkContent = safeHref
      ? `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" title="${linkTitle}">${escHtml(r.displayUrl)}</a>`
      : escHtml(r.displayUrl);
    // #4053: quando >1 URL colapsou no mesmo conteúdo, sinaliza a contagem
    // ao lado do link representativo (o detalhe completo fica no title=).
    const variantBadge = r.variantCount > 1
      ? ` <span class="link-variant-count" title="${linkTitle}">(${r.variantCount} variantes)</span>`
      : "";
    // #4184: seção editorial (fallback "—" quando o construtor não populou —
    // ex: fixture de teste manual que não passa por parseLinksStats).
    const sectionCell = r.section ?? formatLinkSectionCell(null);
    return `<tr>
      <td class="link-content">${escHtml(r.content)}</td>
      <td class="link-section" title="${escHtml(sectionCell.tooltip)}">${escHtml(sectionCell.label)}</td>
      <td class="link-url">${linkContent}${variantBadge}</td>
      <td class="link-clicks metric">${r.clicks}</td>
      <td class="link-pct">${r.pctOfTotal}</td>
    </tr>`;
  }).join("\n");

  return `<details class="links-ctr" id="links-${campaignId}">
  <summary class="links-summary">Links clicados <span class="links-count-badge">${rows.length}</span>${clicksSuffix}</summary>
  <div class="links-table-wrap">
  <table class="links-table">
    <thead>
      <tr>
        <th scope="col" class="link-content-th" title="Rótulo de conteúdo editorial — URLs que apontam pro mesmo conteúdo (ex: variantes A/B da enquete É IA?, ou a mesma página com UTMs diferentes) são somadas numa única linha (#4053)">Conteúdo</th>
        <th scope="col" class="link-section-th" title="${escHtml(LINK_SECTION_COLUMN_TOOLTIP)}">${LINK_SECTION_COLUMN_LABEL}</th>
        <th scope="col" class="link-url-th" title="URL representativa deste conteúdo (links de sistema e descadastramento excluídos)">Link</th>
        <th scope="col" title="Total de cliques somados neste conteúdo (unique-clicks por link não disponível na API Brevo v3)">Clicks</th>
        <th scope="col" title="Participação deste conteúdo no total de clicks editoriais (links de sistema excluídos). Denominador = soma dos clicks editoriais desta seção — difere do total da campanha exibido no summary acima.">% do total</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
  <p class="links-note">Clicks totais por conteúdo — unique-clicks por link não disponível na API Brevo v3 (apenas agregado em Clicks 🖱️ acima).</p>
</details>`;
}

// ─── #2212: seção de links agregados do período ──────────────────────────────

/**
 * Linha de link agregado (across campanhas).
 *
 * #4053: agrupado por CONTEÚDO (`content`), sucedendo o agrupamento por
 * ORIGIN do #2263 — origin ainda colapsava acidentalmente A/B da enquete
 * (mesmo domínio) mas OVER-colapsava tudo sob diar.ia.br numa linha só
 * (destaques distintos misturados). `url`/`displayUrl` seguem como a URL
 * representativa (maior clique) dentro do conteúdo.
 */
export interface AggregatedLinkRow {
  /** Rótulo de conteúdo (chave de agrupamento, #4053) */
  content: string;
  /** URL representativa (maior clique) deste conteúdo */
  url: string;
  /** URL representativa truncada para exibição (max 70 chars) */
  displayUrl: string;
  /** Quantas URLs distintas foram colapsadas neste conteúdo */
  variantCount: number;
  /** Soma de clicks deste conteúdo entre todas as campanhas do período */
  totalClicks: number;
  /** Número de campanhas onde este CONTEÚDO apareceu (1× por campanha, mesmo com múltiplas URLs/variantes na mesma campanha) */
  campaignCount: number;
  /** #4184: ver LinkStatRow.section — mesma semântica, mesmo fallback. */
  section?: LinkSectionCell;
}

/**
 * #2263: extrai o ORIGIN (`scheme://host`, i.e. domínio+subdomínio) de uma URL,
 * descartando path/query/UTM. Ex: `https://clarice.ai/?via=diaria&utm_...` →
 * `https://clarice.ai`; `eia.diar.ia.br/vote?email={{ contact.EMAIL }}` (#3904
 * — domínio de marca; era poll.diaria.workers.dev) → `https://eia.diar.ia.br`.
 * Fallback (URL não-parseável) → a string original, pra não perder o link nem
 * quebrar o render.
 *
 * Mantido exportado por retrocompat (não é mais usado pelo agrupamento
 * principal desde #4053, que usa `classifyLinkContent`).
 */
export function urlOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Agrega links de TODAS as campanhas do período, somando o mesmo CONTEÚDO
 * entre campanhas (#4053, via `classifyLinkContent` — sucede o agrupamento
 * por origin do #2263). Filtra links de sistema usando `isSystemLink`
 * (reutilizado — sem duplicação). Retorna array ordenado por totalClicks DESC.
 * Graceful: sem dados de links → retorna [].
 *
 * @param campaigns - lista de campanhas (todas, com statistics.linksStats populado)
 * @param sectionMap - #4184: mapa CONTEÚDO→seções, tipicamente já MESCLADO
 *   (`mergeLinkSectionMaps`) entre todos os ciclos mensais presentes em
 *   `campaigns` — ou `null`/ausente (fallback "—" em toda linha)
 * @param titleMap - #4198: mapa CONTEÚDO BASE→título editorial, tipicamente
 *   já mesclado entre os ciclos presentes em `campaigns` (mesmo espírito de
 *   `sectionMap`/`mergeLinkSectionMaps` — títulos de ciclos diferentes pro
 *   mesmo conteúdo base são raros; quando colidem, o último merge vence, sem
 *   garantia de precedência) — ou `null`/ausente (rótulo derivado da URL,
 *   comportamento anterior ao #4198 preservado). Ver `parseLinksStats`.
 * @returns array de AggregatedLinkRow ordenado por totalClicks DESC
 */
export function aggregateLinksAcrossCampaigns(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number; linksStats?: BrevoLinksStats }>,
  sectionMap?: LinkSectionMap | null,
  titleMap?: Record<string, string> | null,
): AggregatedLinkRow[] {
  const contentMap = new Map<string, { urlClicks: Map<string, number>; campaignCount: number }>();

  for (const c of campaigns) {
    // #2216 finding #4: getCampaignLinksStats helper elimina dual-source duplicado
    const linksStats = getCampaignLinksStats(c);
    if (!linksStats) continue;

    // Soma por conteúdo DENTRO desta campanha primeiro, pra contar a campanha
    // UMA vez por conteúdo (mesmo que ela tenha várias URLs/variantes do
    // mesmo conteúdo — ex: os 2 links A/B da enquete na mesma edição).
    const perContent = new Map<string, Map<string, number>>();
    for (const [url, clicks] of Object.entries(linksStats)) {
      // Filtro de sistema sobre a URL COMPLETA (antes de classificar).
      if (isSystemLink(url)) continue;
      // #2216 finding #3: Number.isFinite guard — `clicks <= 0` é NaN-transparente
      // (NaN <= 0 é false, então NaN passaria o guard e acumularia em totalClicks).
      if (!Number.isFinite(clicks) || clicks <= 0) continue;
      const { content } = classifyLinkContent(url);
      let urlClicks = perContent.get(content);
      if (!urlClicks) {
        urlClicks = new Map();
        perContent.set(content, urlClicks);
      }
      urlClicks.set(url, (urlClicks.get(url) ?? 0) + clicks);
    }

    for (const [content, urlClicks] of perContent) {
      let bucket = contentMap.get(content);
      if (!bucket) {
        bucket = { urlClicks: new Map(), campaignCount: 0 };
        contentMap.set(content, bucket);
      }
      for (const [url, clicks] of urlClicks) {
        bucket.urlClicks.set(url, (bucket.urlClicks.get(url) ?? 0) + clicks);
      }
      bucket.campaignCount += 1; // 1× por campanha, mesmo com múltiplas URLs do mesmo conteúdo
    }
  }

  if (contentMap.size === 0) return [];

  return Array.from(contentMap.entries())
    .map(([content, { urlClicks, campaignCount }]) => {
      const urlEntries = Array.from(urlClicks.entries()).sort(([, a], [, b]) => b - a);
      const representativeUrl = urlEntries[0][0];
      const totalClicks = urlEntries.reduce((sum, [, c]) => sum + c, 0);
      return {
        // #4198: título editorial substitui o rótulo derivado da URL quando
        // conhecido — mesma ressalva de parseLinksStats: chave de
        // agrupamento/seção permanece o conteúdo BASE.
        content: titleMap?.[content] ?? content,
        url: representativeUrl,
        displayUrl: truncateUrl(representativeUrl),
        variantCount: urlEntries.length,
        totalClicks,
        campaignCount,
        section: lookupLinkSectionCell(content, sectionMap, representativeUrl), // #4184/#4405
      };
    })
    .sort((a, b) => b.totalClicks - a.totalClicks);
}

/**
 * #2421: Deriva o label da edição para o título da seção de links.
 * Formato: `${cycle}-${sendMonthBRT}` (ex: "2605-06").
 * - cycle: de parseClariceCampaignKey(nome) da campanha enviada mais recente.
 * - sendMonthBRT: mês de sentDate em BRT (zero-padded), via monthKeyBRT.
 * Retorna null quando: lista vazia, nenhuma campanha enviada, ou nome não parseável.
 * Exportado pra teste unitário.
 *
 * #4405: 2 correções sobre o comportamento original — (1) bug do
 * double-suffix: pra campanhas já nomeadas no formato mensal completo
 * (`Clarice News {AAMM-MM} — {cell}`), `parsed.cycle` JÁ vem `AAMM-MM` —
 * apendar `-${sendMonthBRT}` de novo produzia `"2606-07-07"` (achado ao
 * vivo, sem cobertura de teste até aqui — todos os testes existentes usavam
 * só o formato diário `AAMM d{NN}`, onde `cycle` é 4 dígitos e o append é
 * correto). (2) cobertura: campanhas `Diar.ia Mensal {AAMM}`/`Clarice {AAMM}
 * grupo:` (não reconhecidas por `parseClariceCampaignKey`) agora também
 * contam como "enviada" via `extractMonthlyCycleCandidate` — sem isso, uma
 * janela só com esses formatos (sem nenhuma `Clarice News`) retornava `null`
 * mesmo tendo campanhas mensais reais.
 */
export function deriveLinksSectionTitle(
  campaigns: Array<Pick<BrevoCampaign, "name" | "sentDate">>,
): string | null {
  // Filtrar campanhas enviadas (sentDate não-nulo) e reconhecidas por QUALQUER
  // um dos 2 classificadores, ordenar desc por sentDate.
  const sent = campaigns
    .filter(
      (c): c is typeof c & { sentDate: string } =>
        Boolean(c.sentDate) &&
        (parseClariceCampaignKey(c.name) !== null || extractMonthlyCycleCandidate(c.name ?? "") !== null),
    )
    .sort((a, b) => Date.parse(b.sentDate) - Date.parse(a.sentDate));
  if (sent.length === 0) return null;

  const latest = sent[0];
  const parsed = parseClariceCampaignKey(latest.name);
  if (parsed?.cycle) {
    if (/^\d{4}-\d{2}$/.test(parsed.cycle)) return parsed.cycle; // já é AAMM-MM (#4405)
    const sendMonthKey = monthKeyBRT(latest.sentDate); // "YYYY-MM" em BRT
    if (!sendMonthKey) return null;
    return `${parsed.cycle}-${sendMonthKey.slice(5)}`; // ex: "2605-06" (ramo diário)
  }
  // #4405: parseClariceCampaignKey não reconheceu — extractMonthlyCycleCandidate
  // já devolve AAMM-MM pronto (Diar.ia Mensal / Clarice grupo:).
  return extractMonthlyCycleCandidate(latest.name ?? "");
}

/**
 * #4405: seleciona a EDIÇÃO mais recente (ciclo de conteúdo mensal INTEIRO —
 * decisão do editor 260731: TODAS as ondas — ramp-warm, grupos nomeados,
 * células A/B/C — não só a campanha mais recente isolada) dentre
 * `campaigns`. Usa `resolveCampaignCycle` (sections-core.ts) por campanha —
 * desambigua pelo CONTEÚDO quando o nome é ambíguo (achado do `grupo:novos`,
 * #4405) — e agrupa TODAS as campanhas cujo ciclo resolvido bate o da
 * campanha de maior `sentDate`. `null` quando nenhuma campanha tem ciclo
 * mensal resolvido (nunca lança).
 *
 * @param linkSectionsByCycle - mesmo mapa usado pra popular a coluna Seção
 *   (`RenderDashboardOptions.linkSectionsByCycle`) — é o que alimenta o
 *   desempate por conteúdo de `resolveCampaignCycle`. `null`/ausente: cada
 *   campanha usa só o candidato do NOME (sem desambiguação).
 */
export function selectLatestEditionCampaigns<
  C extends BrevoCampaign & { listName?: string; listSize?: number; linksStats?: BrevoLinksStats },
>(
  campaigns: readonly C[],
  linkSectionsByCycle: Record<string, LinkSectionMap> | null | undefined,
): { cycle: string; campaigns: C[] } | null {
  const cycleOf = (c: C): string | null =>
    resolveCampaignCycle(c.name ?? "", getCampaignLinksStats(c), linkSectionsByCycle);

  let latestCycle: string | null = null;
  let latestSentMs = -Infinity;
  for (const c of campaigns) {
    if (!c.sentDate) continue;
    const ms = Date.parse(c.sentDate);
    if (!Number.isFinite(ms)) continue;
    const cycle = cycleOf(c);
    if (!cycle) continue;
    if (ms > latestSentMs) {
      latestSentMs = ms;
      latestCycle = cycle;
    }
  }
  if (latestCycle === null) return null;

  const editionCampaigns = campaigns.filter((c) => cycleOf(c) === latestCycle);
  return { cycle: latestCycle, campaigns: editionCampaigns };
}

// ─── #4405: "Seções mais clicadas" — agrupa a tabela de links acima por SEÇÃO ─

/** Linha da tabela "Seções mais clicadas" — 1 por rótulo de `LinkStatRow.section`/`AggregatedLinkRow.section`. */
export interface SectionClickRow {
  /** Rótulo da seção — editorial (Destaques/Use Melhor/Radar/...), categoria
   * de serviço (Enquete É IA?/Clarice/.../Redes sociais) ou "Outros". */
  label: string;
  /** true quando `label` é uma seção EDITORIAL do `prioritized.md` (marcada
   * em negrito na tabela) — as demais são categoria de serviço/CTA ou "Outros". */
  isEditorial: boolean;
  totalClicks: number;
  /** Participação percentual no total de cliques de TODAS as seções (mesma base da tabela de links). */
  pctOfTotal: string;
  /** Quantos conteúdos distintos (linhas da tabela de links) pertencem a esta seção. */
  contentCount: number;
  /** `totalClicks / contentCount`, 1 casa decimal — "—" se `contentCount` for 0 (nunca ocorre na prática, guard defensivo). */
  avgClicksPerContent: string;
}

/**
 * #4405: agrupa os cliques de `aggregateLinksAcrossCampaigns()` (ou de
 * `parseLinksStats()`, mesmo shape de `section`) POR SEÇÃO — pedido do
 * editor: "seções mais clicadas", não só "links mais clicados". Agrupa pelo
 * rótulo PRIMÁRIO já resolvido em `row.section.label` (a precedência de
 * `resolveLinkSection`/#4184 já decidiu qual seção "vence" quando o mesmo
 * conteúdo aparece em mais de uma) — por isso a soma aqui bate EXATAMENTE
 * com a soma da tabela de links, sem dupla contagem. `row.section` ausente
 * (fixture manual de teste que não passa por `lookupLinkSectionCell`) cai no
 * mesmo catch-all "Outros" da coluna Seção. Ordenado por cliques DESC.
 */
export function aggregateClicksBySection(
  rows: ReadonlyArray<Pick<AggregatedLinkRow, "totalClicks" | "section">>,
): SectionClickRow[] {
  const buckets = new Map<string, { totalClicks: number; contentCount: number }>();
  for (const r of rows) {
    const label = r.section?.label ?? LINK_SECTION_FALLBACK_LABEL;
    const bucket = buckets.get(label) ?? { totalClicks: 0, contentCount: 0 };
    bucket.totalClicks += r.totalClicks;
    bucket.contentCount += 1;
    buckets.set(label, bucket);
  }
  const grandTotal = rows.reduce((sum, r) => sum + r.totalClicks, 0);
  const editorialLabels = new Set<string>(Object.values(LINK_SECTION_LABELS));

  return Array.from(buckets.entries())
    .map(([label, { totalClicks, contentCount }]) => ({
      label,
      isEditorial: editorialLabels.has(label),
      totalClicks,
      pctOfTotal: pct(totalClicks, grandTotal),
      contentCount,
      avgClicksPerContent: contentCount > 0 ? (totalClicks / contentCount).toFixed(1) : "—",
    }))
    .sort((a, b) => b.totalClicks - a.totalClicks);
}

/** #4405: definição canônica das colunas de "Seções mais clicadas" — mesmo padrão de `AGGREGATED_LINKS_COLUMNS` (#3090). */
export const SECTION_CLICKS_COLUMNS: Array<{ label: string; tooltip: string }> = [
  { label: "Seção", tooltip: "Seção editorial (Destaques/Use Melhor/Radar/...) ou categoria de serviço (Enquete É IA?/Clarice/Produtos diar.ia.br/Apoio/Redes sociais) — 'Outros' quando nenhuma das duas se aplica (#4405)." },
  { label: "Cliques", tooltip: "Total de cliques somados de todos os conteúdos desta seção/categoria — mesma base da tabela 'Links mais clicados' abaixo." },
  { label: "%", tooltip: "Participação percentual desta seção no total de cliques do período." },
  { label: "Conteúdos", tooltip: "Quantos conteúdos distintos (linhas da tabela de links abaixo) pertencem a esta seção." },
  { label: "Média/conteúdo", tooltip: "Cliques totais ÷ número de conteúdos desta seção — quão bem, em média, cada item da seção performa." },
];

/**
 * Renderiza "Seções mais clicadas" — resumo por seção, ANTES do detalhe por
 * conteúdo (`renderAggregatedLinksSection`, logo abaixo). Sempre visível
 * (stub gracioso sem dados). Editoriais em negrito (`isEditorial`) — sinal
 * visual de que aquela linha veio do `prioritized.md` do ciclo, não de uma
 * categoria de serviço/CTA. Exportado pra teste unitário.
 */
export function renderSectionClicksSection(
  rows: SectionClickRow[],
  edicaoLabel?: string | null,
): string {
  const sectionTitle = edicaoLabel ? `Seções mais clicadas — edição ${edicaoLabel}` : "Seções mais clicadas";

  if (rows.length === 0) {
    return `
<section class="phase2-section" id="secoes-mais-clicadas">
  <h2 class="section-title">${sectionTitle}</h2>
  <p class="section-note">Sem dados de links disponíveis para o período.</p>
</section>`;
  }

  const tableRows = rows.map((r) => {
    const sectionLabelHtml = r.isEditorial ? `<strong>${escHtml(r.label)}</strong>` : escHtml(r.label);
    return `<tr>
      <td class="link-content">${sectionLabelHtml}</td>
      <td class="link-clicks metric">${r.totalClicks}</td>
      <td class="link-pct">${r.pctOfTotal}</td>
      <td>${r.contentCount}</td>
      <td>${r.avgClicksPerContent}</td>
    </tr>`;
  }).join("\n");

  return `
<section class="phase2-section" id="secoes-mais-clicadas">
  <h2 class="section-title">${sectionTitle}</h2>
  <p class="section-note">Seções editoriais em <strong>negrito</strong>; demais linhas são categoria de serviço/CTA ou "Outros". Mesma base de cliques da tabela "Links mais clicados" logo abaixo — os totais batem.</p>
  ${renderColumnGlossary("secoes-mais-clicadas", SECTION_CLICKS_COLUMNS)}
  <div class="table-wrap">
  <table class="links-table">
    <thead>
      <tr>
        ${SECTION_CLICKS_COLUMNS.map((c) => `<th scope="col" title="${escHtml(c.tooltip)}">${c.label}</th>`).join("\n")}
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
</section>`;
}

/**
 * Renderiza a seção "Links mais clicados do período/da edição" com links agregados de TODAS as campanhas.
 * Sempre visível (seção presente mesmo sem dados — graceful stub).
 * Exportado pra teste unitário.
 *
 * @param rows - resultado de aggregateLinksAcrossCampaigns()
 * @param edicaoLabel - label da edição ex: "2605-06"; se null, usa "do período"
 */
/**
 * #3090: definição canônica das colunas da tabela "Links mais clicados"
 * (label + tooltip) — fonte única usada tanto no `title=` de cada `<th>`
 * quanto no `<details>` "Glossário das colunas". Exportado pra teste unitário.
 */
export const AGGREGATED_LINKS_COLUMNS: Array<{ label: string; tooltip: string }> = [
  { label: "Conteúdo", tooltip: "Rótulo de conteúdo editorial — URLs que apontam pro mesmo conteúdo (ex: variantes A/B da enquete É IA?, ou a mesma página com UTMs diferentes) são somadas numa única linha (#4053)" },
  { label: LINK_SECTION_COLUMN_LABEL, tooltip: LINK_SECTION_COLUMN_TOOLTIP }, // #4184
  { label: "Link", tooltip: "URL representativa deste conteúdo (links de sistema e descadastramento excluídos)" },
  { label: "Clicks", tooltip: "Total de cliques somados entre todos os envios do período" },
  { label: "%", tooltip: "Participação percentual no total de clicks editoriais do período" },
  { label: "Envios", tooltip: "Número de envios onde este CONTEÚDO apareceu (1× por envio, mesmo com múltiplas variantes de URL no mesmo envio)" },
];

/**
 * #3081: `campaignCount` (opcional) é o tamanho da JANELA de campanhas
 * BUSCADAS que alimentou `rows` (via `aggregateLinksAcrossCampaigns`) —
 * normalmente `campaigns.length` no call site (`renderDashboardHtml`), até
 * `CAMPAIGNS_FETCH_LIMIT`. Quando presente, o título passa a refletir a
 * JANELA agregada ("janela de N campanhas") em vez de implicar
 * (incorretamente) que os dados são de UMA edição só — o bug relatado:
 * `deriveLinksSectionTitle` rotulava "Links mais clicados da edição X" com o
 * ciclo mais recente, mas a soma por trás cobre as ~150 campanhas da janela
 * (múltiplos ciclos). `edicaoLabel` (quando disponível) vira contexto
 * SECUNDÁRIO de recência, não mais a alegação principal do título. Sem
 * `campaignCount` (omitido — retrocompat com callers/testes existentes),
 * preserva o título antigo.
 *
 * Nota de precisão (achado no self-review): `campaignCount` é o tamanho da
 * janela BUSCADA, não uma contagem exata de quantas campanhas de fato
 * contribuíram um clique pra `rows` — algumas podem não ter `linksStats`
 * disponível (429/cache pendente da Brevo) e são puladas silenciosamente por
 * `aggregateLinksAcrossCampaigns`. O título é uma aproximação da janela, não
 * uma alegação de precisão perfeita.
 *
 * @param envioCount - #4405: número de ENVIOS (campanhas — ramp-warm, grupos
 *   nomeados, células A/B/C) da EDIÇÃO `edicaoLabel`. Só produz efeito quando
 *   `campaignCount` está ausente/null (os dois títulos — "janela de N
 *   campanhas" vs "edição X, N envios" — são mutuamente exclusivos, cada um
 *   descreve um escopo diferente): título vira "Links mais clicados da
 *   edição X (N envios)" em vez de só "da edição X". Omitido preserva o
 *   título antigo (retrocompat).
 * @param idSuffix - #4405: sufixo do `id` do `<section>`/glossário — a
 *   função agora é chamada 2× na mesma página (tabela da EDIÇÃO + tabela
 *   HISTÓRICA, Fase 3), então o id precisa ser único por chamada pra não
 *   duplicar `id=` no HTML. Default `"links-agregados"` preserva o id antigo
 *   pros callers/testes existentes (só 1 chamada por página).
 */
export function renderAggregatedLinksSection(
  rows: AggregatedLinkRow[],
  edicaoLabel?: string | null,
  campaignCount?: number | null,
  envioCount?: number | null,
  idSuffix = "links-agregados",
): string {
  // #3081 (review): pluralização — "1 campanha" no singular, evita "janela de
  // 1 campanhas" (gramaticalmente errado), mesmo padrão de
  // `renderUnclassifiedCampaignsNote` (sections-core.ts).
  const campaignWord = campaignCount === 1 ? "campanha" : "campanhas";
  const envioWord = envioCount === 1 ? "envio" : "envios";
  const sectionTitle = campaignCount != null
    ? `Links mais clicados (janela de ${campaignCount} ${campaignWord})${edicaoLabel ? ` — mais recente: edição ${edicaoLabel}` : ""}`
    : edicaoLabel && envioCount != null
    ? `Links mais clicados da edição ${edicaoLabel} (${envioCount} ${envioWord})`
    : edicaoLabel
    ? `Links mais clicados da edição ${edicaoLabel}`
    : "Links mais clicados do período";

  if (rows.length === 0) {
    return `
<section class="phase2-section" id="${escHtml(idSuffix)}">
  <h2 class="section-title">${sectionTitle}</h2>
  <p class="section-note">Sem dados de links disponíveis para o período.</p>
</section>`;
  }

  const totalClicks = rows.reduce((sum, r) => sum + r.totalClicks, 0);

  const tableRows = rows.map((r) => {
    const safeHref = /^https?:\/\//i.test(r.url) ? escHtml(r.url) : "";
    // #4053: tooltip do link representativo denuncia quantas URLs colapsaram no conteúdo.
    const variantSuffix = r.variantCount > 1 ? ` (${r.variantCount} variantes)` : "";
    const linkTitle = escHtml(`${r.url}${variantSuffix}`);
    const linkContent = safeHref
      ? `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" title="${linkTitle}">${escHtml(r.displayUrl)}</a>`
      : escHtml(r.displayUrl);
    const pctShare = pct(r.totalClicks, totalClicks);
    // #4184: fallback "—" quando o construtor não populou (fixture manual de teste).
    const sectionCell = r.section ?? formatLinkSectionCell(null);
    return `<tr>
      <td class="link-content">${escHtml(r.content)}</td>
      <td class="link-section" title="${escHtml(sectionCell.tooltip)}">${escHtml(sectionCell.label)}</td>
      <td class="link-url">${linkContent}</td>
      <td class="link-clicks metric">${r.totalClicks}</td>
      <td class="link-pct">${pctShare}</td>
      <td>${r.campaignCount}</td>
    </tr>`;
  }).join("\n");

  return `
<section class="phase2-section" id="${escHtml(idSuffix)}">
  <h2 class="section-title">${sectionTitle}</h2>
  <p class="section-note">${rows.length} conteúdos editoriais · ${totalClicks} clicks totais (soma across envios). Links de sistema excluídos.</p>
  ${renderColumnGlossary(idSuffix, AGGREGATED_LINKS_COLUMNS)}
  <div class="table-wrap">
  <table class="links-table">
    <thead>
      <tr>
        ${AGGREGATED_LINKS_COLUMNS.map(
          // #4184: por LABEL, não por índice posicional — inserir/remover uma
          // coluna no meio (ex: "Seção" antes de "Link") não deve deslocar
          // silenciosamente qual coluna ganha qual classe CSS.
          (c) => `<th scope="col"${c.label === "Conteúdo" ? ' class="link-content-th"' : c.label === "Link" ? ' class="link-url-th"' : ""} title="${escHtml(c.tooltip)}">${c.label}</th>`,
        ).join("\n")}
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
  <p class="links-note">Clicks totais por conteúdo — unique-clicks por link não disponível na API Brevo v3.</p>
</section>`;
}

// ─── #3090: glossário de colunas (sempre visível, não hover-only) ───────────

/**
 * #3090: a semântica de uma tabela vivia só em `title=` (hover-only,
 * inacessível em touch/mobile — o fluxo real do editor é celular). Renderiza
 * um `<details>` "Glossário das colunas" reusando as classes já usadas nos
 * outros colapsáveis do dashboard (`.links-ctr`/`.links-summary`), a partir
 * das MESMAS entradas `{label, tooltip}` já usadas nos `title=` de cada `<th>`
 * — sem duplicar texto. Os `title=` permanecem como conveniência extra
 * desktop (hover). Vazio (`""`) quando `columns` está vazio.
 *
 * @param id - sufixo do id do `<details>` (único por tabela/aba)
 * @param columns - mesmas entradas usadas nos `title=` dos `<th>` da tabela
 */
export function renderColumnGlossary(
  id: string,
  columns: ReadonlyArray<{ label: string; tooltip: string }>,
): string {
  if (columns.length === 0) return "";
  const items = columns
    .map((c) => `<dt>${escHtml(c.label)}</dt><dd>${escHtml(c.tooltip)}</dd>`)
    .join("\n");
  return `<details class="links-ctr" id="glossary-${escHtml(id)}">
  <summary class="links-summary">Glossário das colunas</summary>
  <div class="links-table-wrap">
  <dl class="glossary-list">
${items}
  </dl>
  </div>
</details>`;
}

/**
 * #3092: notas explicativas longas (6-10 linhas, jargão interno tipo
 * "#2864"/"#2908") apareciam ANTES do dado, obrigando o editor a rolar
 * passado um parágrafo de metodologia só pra chegar na tabela (Cohorts/
 * Coortes/Totais por mês). Padroniza o formato "1 frase de takeaway visível +
 * metodologia num `<details>` recolhível" — mesmo componente reusado de
 * `renderColumnGlossary` (`.links-ctr`/`.links-summary`), sem duplicar CSS
 * novo. `takeawayHtml`/`detailsHtml` já vêm prontos (escHtml aplicado pelo
 * caller quando interpolam dado dinâmico) — mesmo contrato de todo o resto
 * do módulo (nenhuma função aqui escapa texto sozinha).
 *
 * @param id - sufixo do id do `<details>` (único por tabela/aba)
 * @param takeawayHtml - 1 frase sempre visível (o que o editor precisa saber de cara)
 * @param detailsHtml - metodologia completa, recolhida (sem números de issue —
 *   convenção estabelecida por este PR, mesmo espírito do fix das notas de
 *   Cupons que removeu "#2750" do texto visível, ver test/brevo-dashboard-3092-consistency.test.ts)
 */
export function renderMethodologyNote(id: string, takeawayHtml: string, detailsHtml: string): string {
  return `<p class="section-note">${takeawayHtml}</p>
<details class="links-ctr" id="howto-${escHtml(id)}">
  <summary class="links-summary">Como ler esta tabela</summary>
  <div class="links-table-wrap">
  <p class="section-note" style="margin:0;">${detailsHtml}</p>
  </div>
</details>`;
}

/**
 * #3081 (formatação/UX): link pra abrir o relatório da campanha direto na
 * Brevo, a partir do ID exibido na coluna "ID" da tabela Envios. Antes o ID
 * era texto puro — sem valor acionável e context-free pra screen readers
 * (um número isolado não diz o que é). `aria-label` explícito cobre o
 * achado de acessibilidade do review.
 */
export function brevoReportLink(id: number): string {
  return `<a href="https://app.brevo.com/camp/report/${id}" target="_blank" rel="noopener noreferrer" aria-label="Ver relatório da campanha ${id} na Brevo">${id}</a>`;
}

export function hoursSince(iso: string | null): string {
  if (!iso) return "—";
  const elapsed = Date.now() - Date.parse(iso);
  if (isNaN(elapsed)) return "—";
  const hours = elapsed / 3600000;
  if (hours < 1) return `${Math.round(hours * 60)}min`;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export function fmtTimeBRT(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  // #2085: weekday:"short" acrescenta dia da semana (ex: "qua., 11/06 06:00")
  // pra facilitar leitura de padrões de engajamento por dia.
  return d.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// NOTE (#2207): `linksStats?` no shape abaixo é mantido SOMENTE para fixtures de teste
// (backward compat: testes que passam linksStats top-level diretamente). Em produção,
// `fetchRecentCampaigns` nunca produz top-level `linksStats` desde #2199.3 — a propriedade
// canônica é sempre `statistics.linksStats`. Produção não usa o campo top-level.
