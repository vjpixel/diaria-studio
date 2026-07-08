import type { BrevoCampaign, BrevoLinksStats } from "./types.ts";
import { DS_COLORS, DS_FONTS as DSF } from "./ds-tokens.generated.ts";
// NOTE (#2832): import circular com sections-core.ts (esHtml/parseClariceCampaignKey/
// monthKeyBRT são usados aqui mas definidos lá). Seguro — todos os usos abaixo são
// dentro de corpos de função chamados em request-time, nunca em top-level do módulo,
// então a ordem de inicialização ESM não importa (mesmo padrão que já existia
// implicitamente dentro do monólito index.ts antes da quebra em módulos).
import { escHtml, parseClariceCampaignKey, monthKeyBRT } from "./sections-core.ts";

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


export function pct(n: number, total: number): string {
  if (!total) return "0.0%";
  return ((n / total) * 100).toFixed(1) + "%";
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
 * Estrutura de um link processado para exibição no dashboard.
 */
export interface LinkStatRow {
  url: string;
  /** URL truncada para exibição (max 70 chars) */
  displayUrl: string;
  clicks: number;
  /** Participação percentual em relação ao total de clicks editoriais da campanha (links de sistema excluídos) */
  pctOfTotal: string;
}

/**
 * Parseia `linksStats` (mapa url→clicks) da Brevo, filtra links de sistema,
 * ordena por clicks DESC e retorna array de LinkStatRow com participação %.
 *
 * Nota sobre unique-clicks: a API Brevo v3 (`GET /v3/emailCampaigns/{id}?statistics=linksStats`)
 * expõe apenas clicks totais por URL — sem unique-clicks por link. Unique-clicks
 * só existem agregados no nível da campanha (`globalStats.uniqueClicks`).
 * Portanto, a tabela exibe apenas "Clicks" (total) e omite coluna unique graciosamente.
 *
 * @param linksStats - mapa url→clicks da Brevo (pode ser undefined/null)
 * @returns array de LinkStatRow ordenado por clicks DESC, vazio se sem dados
 */
export function parseLinksStats(linksStats: BrevoLinksStats | undefined | null): LinkStatRow[] {
  if (!linksStats) return [];

  const entries = Object.entries(linksStats)
    .filter(([url]) => !isSystemLink(url))
    // #2216 finding #3: Number.isFinite guard — `clicks > 0` is NaN-transparent
    // (NaN > 0 is false, but NaN can still propagate if checked differently elsewhere).
    // isFinite covers NaN, Infinity, and -Infinity. Consistent with #2207 NaN class.
    .filter(([, clicks]) => Number.isFinite(clicks) && clicks > 0)
    .sort(([, a], [, b]) => b - a);

  if (entries.length === 0) return [];

  const totalClicks = entries.reduce((sum, [, clicks]) => sum + clicks, 0);

  return entries.map(([url, clicks]) => ({
    url,
    displayUrl: truncateUrl(url), // #2216 finding #2: extraído helper truncateUrl
    clicks,
    pctOfTotal: pct(clicks, totalClicks), // reusa helper pct() (#2183)
  }));
}

/**
 * Renderiza a tabela de distribuição de cliques por link como HTML colapsável (<details>/<summary>).
 * Graceful quando linksStats ausente ou sem links editoriais: retorna stub vazio.
 *
 * @param campaignId - usado no id do <details> para unicidade
 * @param linksStats - mapa url→clicks (pode ser undefined)
 * @param totalClicks - uniqueClicks da campanha (pra contexto no summary)
 */
export function renderLinksSection(
  campaignId: number,
  linksStats: BrevoLinksStats | undefined | null,
  totalClicks?: number,
): string {
  const rows = parseLinksStats(linksStats);

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
    const linkContent = safeHref
      ? `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" title="${escHtml(r.url)}">${escHtml(r.displayUrl)}</a>`
      : escHtml(r.displayUrl);
    return `<tr>
      <td class="link-url">${linkContent}</td>
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
        <th class="link-url-th" title="URL do link clicado (links de sistema e descadastramento excluídos)">Link</th>
        <th title="Total de cliques neste link (unique-clicks por link não disponível na API Brevo v3)">Clicks</th>
        <th title="Participação deste link no total de clicks editoriais (links de sistema excluídos). Denominador = soma dos clicks editoriais desta seção — difere do total da campanha exibido no summary acima.">% do total</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
  <p class="links-note">Clicks totais por link — unique-clicks por link não disponível na API Brevo v3 (apenas agregado em Clicks 🖱️ acima).</p>
</details>`;
}

// ─── #2212: seção de links agregados do período ──────────────────────────────

/**
 * Linha de link agregado (across campanhas).
 */
export interface AggregatedLinkRow {
  url: string;
  /** URL truncada para exibição (max 70 chars) */
  displayUrl: string;
  /** Soma de clicks deste link entre todas as campanhas do período */
  totalClicks: number;
  /** Número de campanhas onde este link apareceu */
  campaignCount: number;
}

/**
 * Agrega links de TODAS as campanhas do período, somando o mesmo URL entre campanhas.
 * Filtra links de sistema usando `isSystemLink` (reutilizado — sem duplicação).
 * Retorna array ordenado por totalClicks DESC.
 * Graceful: sem dados de links → retorna [].
 *
 * @param campaigns - lista de campanhas (todas, com statistics.linksStats populado)
 * @returns array de AggregatedLinkRow ordenado por totalClicks DESC
 */
/**
 * #2263: extrai o ORIGIN (`scheme://host`, i.e. domínio+subdomínio) de uma URL,
 * descartando path/query/UTM. Ex: `https://clarice.ai/?via=diaria&utm_...` →
 * `https://clarice.ai`; `poll.diaria.workers.dev/vote?email={{ contact.EMAIL }}`
 * → `https://poll.diaria.workers.dev`. Fallback (URL não-parseável) → a string
 * original, pra não perder o link nem quebrar o render.
 */
export function urlOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export function aggregateLinksAcrossCampaigns(
  campaigns: Array<BrevoCampaign & { listName?: string; listSize?: number; linksStats?: BrevoLinksStats }>,
): AggregatedLinkRow[] {
  // #2263: agrupado por ORIGIN (domínio+subdomínio), não URL completa. Detalhe
  // por página fica no drill-down por campanha (#2177).
  const originMap = new Map<string, { totalClicks: number; campaignCount: number }>();

  for (const c of campaigns) {
    // #2216 finding #4: getCampaignLinksStats helper elimina dual-source duplicado
    const linksStats = getCampaignLinksStats(c);
    if (!linksStats) continue;

    // Soma por origin DENTRO desta campanha primeiro, pra contar a campanha UMA
    // vez por origin (mesmo que ela tenha vários links do mesmo domínio).
    const perOrigin = new Map<string, number>();
    for (const [url, clicks] of Object.entries(linksStats)) {
      // Filtro de sistema sobre a URL COMPLETA (antes de reduzir a origin).
      if (isSystemLink(url)) continue;
      // #2216 finding #3: Number.isFinite guard — `clicks <= 0` é NaN-transparente
      // (NaN <= 0 é false, então NaN passaria o guard e acumularia em totalClicks).
      if (!Number.isFinite(clicks) || clicks <= 0) continue;
      const origin = urlOrigin(url);
      perOrigin.set(origin, (perOrigin.get(origin) ?? 0) + clicks);
    }

    for (const [origin, clicks] of perOrigin) {
      const existing = originMap.get(origin);
      if (existing) {
        existing.totalClicks += clicks;
        existing.campaignCount += 1;
      } else {
        originMap.set(origin, { totalClicks: clicks, campaignCount: 1 });
      }
    }
  }

  if (originMap.size === 0) return [];

  return Array.from(originMap.entries())
    .map(([origin, { totalClicks, campaignCount }]) => ({
      url: origin,
      displayUrl: origin, // #2263: origin já é curto — sem truncateUrl
      totalClicks,
      campaignCount,
    }))
    .sort((a, b) => b.totalClicks - a.totalClicks);
}

/**
 * #2421: Deriva o label da edição para o título da seção de links.
 * Formato: `${cycle}-${sendMonthBRT}` (ex: "2605-06").
 * - cycle: de parseClariceCampaignKey(nome) da campanha enviada mais recente.
 * - sendMonthBRT: mês de sentDate em BRT (zero-padded), via monthKeyBRT.
 * Retorna null quando: lista vazia, nenhuma campanha enviada, ou nome não parseável.
 * Exportado pra teste unitário.
 */
export function deriveLinksSectionTitle(
  campaigns: Array<Pick<BrevoCampaign, "name" | "sentDate">>,
): string | null {
  // Filtrar campanhas enviadas (sentDate não-nulo) e ordenar desc por sentDate.
  const sent = campaigns
    .filter(
      (c): c is typeof c & { sentDate: string } =>
        Boolean(c.sentDate) && parseClariceCampaignKey(c.name) !== null,
    )
    .sort((a, b) => Date.parse(b.sentDate) - Date.parse(a.sentDate));
  if (sent.length === 0) return null;

  const latest = sent[0];
  const parsed = parseClariceCampaignKey(latest.name);
  if (!parsed || !parsed.cycle) return null;

  const sendMonthKey = monthKeyBRT(latest.sentDate); // "YYYY-MM" em BRT
  if (!sendMonthKey) return null;

  const sendMonthBRT = sendMonthKey.slice(5); // "MM" (últimos 2 chars de "YYYY-MM")
  return `${parsed.cycle}-${sendMonthBRT}`; // ex: "2605-06"
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
  { label: "Link", tooltip: "URL do link (links de sistema e descadastramento excluídos)" },
  { label: "Clicks", tooltip: "Total de cliques somados entre todos os envios do período" },
  { label: "%", tooltip: "Participação percentual no total de clicks editoriais do período" },
  { label: "Envios", tooltip: "Número de envios onde este link apareceu" },
];

export function renderAggregatedLinksSection(rows: AggregatedLinkRow[], edicaoLabel?: string | null): string {
  const sectionTitle = edicaoLabel
    ? `Links mais clicados da edição ${edicaoLabel}`
    : "Links mais clicados do período";

  if (rows.length === 0) {
    return `
<section class="phase2-section" id="links-agregados">
  <h2 class="section-title">${sectionTitle}</h2>
  <p class="section-note">Sem dados de links disponíveis para o período.</p>
</section>`;
  }

  const totalClicks = rows.reduce((sum, r) => sum + r.totalClicks, 0);

  const tableRows = rows.map((r) => {
    const safeHref = /^https?:\/\//i.test(r.url) ? escHtml(r.url) : "";
    const linkContent = safeHref
      ? `<a href="${safeHref}" target="_blank" rel="noopener noreferrer" title="${escHtml(r.url)}">${escHtml(r.displayUrl)}</a>`
      : escHtml(r.displayUrl);
    const pctShare = pct(r.totalClicks, totalClicks);
    return `<tr>
      <td class="link-url">${linkContent}</td>
      <td class="link-clicks metric">${r.totalClicks}</td>
      <td class="link-pct">${pctShare}</td>
      <td>${r.campaignCount}</td>
    </tr>`;
  }).join("\n");

  return `
<section class="phase2-section" id="links-agregados">
  <h2 class="section-title">${sectionTitle}</h2>
  <p class="section-note">${rows.length} links editoriais · ${totalClicks} clicks totais (soma across envios). Links de sistema excluídos.</p>
  ${renderColumnGlossary("links-agregados", AGGREGATED_LINKS_COLUMNS)}
  <div class="table-wrap">
  <table class="links-table">
    <thead>
      <tr>
        ${AGGREGATED_LINKS_COLUMNS.map(
          (c, i) => `<th${i === 0 ? ' class="link-url-th"' : ""} title="${escHtml(c.tooltip)}">${c.label}</th>`,
        ).join("\n")}
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>
  <p class="links-note">Clicks totais por link — unique-clicks por link não disponível na API Brevo v3.</p>
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
