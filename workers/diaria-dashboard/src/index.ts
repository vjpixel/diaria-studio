/**
 * diaria-dashboard (#2132)
 *
 * Worker que serve o dashboard de dados operacionais da Diar.ia.
 * Lê o JSON agregado do KV (populado offline pelo editor via
 * `build-diaria-dashboard-data.ts --push`) e renderiza HTML.
 *
 * Arquitetura: push-KV (padrão (a) do #2132).
 * - O Worker NÃO lê data/ (OneDrive local) — só o KV.
 * - O script local agrega e faz push pro KV quando o editor roda --push.
 * - Cache de borda 5min (mesmo padrão do brevo-dashboard #2144).
 *
 * Endpoints:
 *   GET  /              → HTML dashboard
 *   GET  /api/data      → JSON raw do KV
 *   GET  /healthz       → liveness probe
 *
 * KV bindings:
 *   DASHBOARD_DATA      → namespace criado via `wrangler kv:namespace create DASHBOARD_DATA`
 *                         Key: "dashboard" → DashboardData JSON
 */

import { DS_COLORS, DS_FONTS as DSF } from "./ds-tokens.generated.ts";
import type { DashboardData, SourceHealthEntry, OvernightRun, CtrByCategoryRow, StubSection, UseMelhorSummary, PollEiaSummary, TopClickedRecentSummary, AudienceSummary } from "./types.ts";

// ─── Helpers inline (espelham scripts/lib/ctr-utils.ts) ──────────────────────
// Duplicar em vez de importar — o Worker não tem acesso a scripts/lib/ no bundle.
// isAprofundeAnchor: retorna true quando anchor começa com "Aprofunde" (#2556)
function isAprofundeAnchor(anchor: string): boolean {
  return /^aprofunde\b/i.test((anchor || "").trim());
}

// MIN_AGE_DAYS_FOR_CLICKS: espelha scripts/lib/shared/ctr-config.ts (#3146) —
// mesmo motivo de isAprofundeAnchor acima (Worker não importa scripts/lib/ no
// bundle). Drift entre as duas cópias é coberto por teste em
// test/diaria-dashboard-use-melhor-age.test.ts.
const MIN_AGE_DAYS_FOR_CLICKS = 7;

/**
 * #3146: idade (em dias) de uma edição AAMMDD relativa a `now`. Espelha a
 * mesma lógica de parse calendário-aware de scripts/archive-editions.ts
 * (parseEditionDate/ageDays) — duplicada aqui pelo mesmo motivo acima (Worker
 * sem acesso a scripts/lib/ no bundle). Retorna null para AAMMDD malformado
 * ou calendário-inválido (ex: dia 31 num mês de 30) — o caller trata null
 * como "idade desconhecida" e cai no `—` cru em vez de arriscar uma
 * mensagem de estabilização enganosa.
 */
function editionAgeDays(edition: string, now: Date): number | null {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(edition);
  if (!m) return null;
  const year = 2000 + Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const editionDate = new Date(Date.UTC(year, month - 1, day));
  if (
    editionDate.getUTCFullYear() !== year ||
    editionDate.getUTCMonth() !== month - 1 ||
    editionDate.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor((now.getTime() - editionDate.getTime()) / (1000 * 60 * 60 * 24));
}

const DS = DS_COLORS;

export interface Env {
  DASHBOARD_DATA: KVNamespace;
}

// ─── Re-export types para testes ─────────────────────────────────────────────

export type { DashboardData, SourceHealthEntry, OvernightRun, CtrByCategoryRow, StubSection, UseMelhorSummary, PollEiaSummary, TopClickedRecentSummary, AudienceSummary };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTimeBRT(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  // Finding #2: invalid date must return "—" (not raw iso) to avoid unescaped output in <td>
  if (isNaN(d.getTime())) return "—";
  // Finding #8: toLocaleString with tz may throw in Workers without full ICU data
  try {
    return d.toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    // Fallback: manual offset -03:00
    const brt = new Date(d.getTime() - 3 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(brt.getUTCDate())}/${pad(brt.getUTCMonth() + 1)}/${String(brt.getUTCFullYear()).slice(-2)} ${pad(brt.getUTCHours())}:${pad(brt.getUTCMinutes())}`;
  }
}

/**
 * #3075 (achado Fable #2): versão curta de fmtTimeBRT sem ano — dd/mm hh:mm.
 * Usada nas colunas de maior densidade (Último ok/Última falha da Saúde das
 * Fontes, Início do Overnight); o ano some do texto mas não da informação —
 * o chamador deve colocar fmtTimeBRT (com ano) no atributo title= do <td>.
 */
function fmtTimeBRTShort(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  try {
    return d.toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    const brt = new Date(d.getTime() - 3 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(brt.getUTCDate())}/${pad(brt.getUTCMonth() + 1)} ${pad(brt.getUTCHours())}:${pad(brt.getUTCMinutes())}`;
  }
}

function fmtDuration(ms: number | null): string {
  if (ms === null || ms < 0) return "—";
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h${String(m).padStart(2, "0")}m`;
}

// #3098 (self-review follow-up): status codificado só por cor falha WCAG
// 1.4.1 (Use of Color). O glyph varia (● cheio / ◐ meio / ○ vazio) como
// sinal visual independente de cor, e role="img"+aria-label expõe o rótulo
// pra leitor de tela de forma confiável — title= sozinho (fix original)
// não é consistentemente anunciado por leitores de tela (funciona só como
// tooltip de hover, que não existe em touch); mantido como bônus pra mouse.
// Mesmo padrão já usado pro semáforo 🟢/🟡 do brevo-dashboard (#3092 parte
// 3/N, mesma sessão): `<span role="img" aria-label="verde">🟢</span>`.
function statusBadge(status: "verde" | "amarelo" | "vermelho"): string {
  if (status === "verde") return `<span style="color:#2d8a4e" title="verde" role="img" aria-label="verde">●</span>`;
  if (status === "amarelo") return `<span style="color:#c07800" title="amarelo" role="img" aria-label="amarelo">◐</span>`;
  return `<span style="color:#C00000" title="vermelho" role="img" aria-label="vermelho">○</span>`;
}

/**
 * #2511 self-review (Angle Reuse): href escapado só se for http(s) — bloqueia
 * javascript:/data: URIs. Consolidado das 3 cópias do mesmo regex+ternário
 * (renderCtrSection + renderUseMelhorSection top/edition rows).
 */
function safeHttpHref(url: string): string {
  return /^https?:\/\//i.test(url) ? escHtml(url) : "";
}

/**
 * #3098 (self-review follow-up, angle Reuse): consolida a célula de
 * cliques absolutos — as 3 abas que exibem esse dado (CTR Top 10, Top
 * links, Use Melhor) tinham cada uma sua própria variação (`td.metric` vs
 * `<small>`, com/sem fallback pra null). Convenção única: <small>, com "—"
 * pra schema drift do KV (mesmo padrão de safeHttpHref acima, cujo
 * comentário já registra a lição de consolidar cópias quase-idênticas).
 */
function clicksCell(n: number | null | undefined): string {
  const label = n === null || n === undefined ? "—" : String(n);
  return `<td><small>${label}</small></td>`;
}

// ─── Render sections ──────────────────────────────────────────────────────────

export function renderSourceHealthSection(data: DashboardData): string {
  const sh = data.source_health;
  // Finding #5: sh truthy but sh.entries absent causes TypeError — guard with optional chain
  if (!sh?.entries?.length) {
    return `<section class="dash-section" id="source-health">
  <h2 class="section-title">Saúde das fontes</h2>
  <p class="section-note muted">Nenhuma fonte encontrada. Rode <code>build-diaria-dashboard-data.ts --dry-run</code> e verifique data/source-health.json.</p>
</section>`;
  }

  const rows = [...sh.entries]
    .sort((a, b) => {
      const order = { vermelho: 0, amarelo: 1, verde: 2 };
      return (order[a.status] - order[b.status]) || b.consecutive_failures - a.consecutive_failures;
    })
    .map((e) => {
      const streak = e.consecutive_failures > 0
        ? ` <small class="alert-text">(${e.consecutive_failures} seguidas)</small>`
        : "";
      const dur = e.last_duration_ms !== null ? `${Math.round(e.last_duration_ms / 1000)}s` : "—";
      return `<tr>
        <td>${statusBadge(e.status)} ${escHtml(e.name)}</td>
        <td>${e.successes}/${e.attempts}${streak}</td>
        <td>${e.success_rate_pct.toFixed(0)}%</td>
        <td>${e.timeouts}</td>
        <td>${dur}</td>
        <td title="${escHtml(fmtTimeBRT(e.last_success_iso))}">${fmtTimeBRTShort(e.last_success_iso)}</td>
        <td title="${escHtml(fmtTimeBRT(e.last_failure_iso))}">${fmtTimeBRTShort(e.last_failure_iso)}</td>
      </tr>`;
    })
    .join("\n");

  const pctVerde = sh.total > 0 ? ((sh.verde / sh.total) * 100).toFixed(0) : "0";

  return `<section class="dash-section" id="source-health">
  <h2 class="section-title">Saúde das fontes</h2>
  <p class="section-note">${sh.total} fontes — <span style="color:#2d8a4e">${sh.verde} verde</span> · <span style="color:#c07800">${sh.amarelo} amarelo</span> · <span style="color:#C00000">${sh.vermelho} vermelho</span> · ${pctVerde}% OK</p>
  <div class="table-wrap table-wrap-scroll">
  <table>
    <thead>
      <tr>
        <th title="Nome da fonte cadastrada em seed/sources.csv">Fonte</th>
        <th title="Execuções bem-sucedidas / tentativas totais">Sucesso</th>
        <th title="Taxa de sucesso">Taxa</th>
        <th title="Número de timeouts">Timeouts</th>
        <th title="Duração da última execução">Última dur.</th>
        <th title="Data/hora do último sucesso (BRT)">Último ok</th>
        <th title="Data/hora da última falha (BRT)">Última falha</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  </div>
  <p class="section-note muted">Dados de <code>data/source-health.json</code> + <code>data/sources/*.jsonl</code>. Gerado em ${fmtTimeBRT(sh.generated_at)}.</p>
</section>`;
}

export function renderCtrSection(data: DashboardData): string {
  const ctr = data.ctr;
  if (!ctr) {
    return `<section class="dash-section" id="ctr">
  <h2 class="section-title">CTR por categoria de link</h2>
  <p class="section-note muted">Arquivo <code>data/link-ctr-table.csv</code> não encontrado ou vazio. Rode <code>npm run build-link-ctr</code> para gerar.</p>
</section>`;
  }

  // Finding #4: ctr may exist but top_categories/top_links absent (schema drift) — use nullish coalescing
  const catRows = (ctr.top_categories ?? []).map((r) => `<tr>
    <td>${escHtml(r.category)}</td>
    <td>${r.link_count}</td>
    <td>${r.total_clicks}</td>
    <td class="metric">${r.avg_ctr_pct.toFixed(2)}%</td>
    <td>${r.max_ctr_pct.toFixed(2)}%</td>
  </tr>`).join("\n");

  // Finding #1: validate URL scheme before embedding in href to prevent javascript: XSS
  const topRows = (ctr.top_links ?? []).slice(0, 10).map((r) => {
    const safeHref = /^https?:\/\//i.test(r.base_url) ? escHtml(r.base_url) : "";
    const linkCell = safeHref
      ? `<a href="${safeHref}" target="_blank" rel="noopener" style="color:var(--brand);font-size:0.8em">↗</a>`
      : `<span style="color:var(--ink);opacity:0.4;font-size:0.8em">—</span>`;
    // #2556: exibir tema do destaque em vez da âncora "Aprofunde".
    // Prioridade: highlight_title (join contra approved.json) → post_title (fallback seguro)
    // → anchor (links novos pós-mar/2026 já têm o título como âncora).
    const temaCell = isAprofundeAnchor(r.anchor)
      ? escHtml(r.highlight_title ?? r.post_title)
      : escHtml(r.anchor);
    // #3098: em mobile a coluna Categoria isolada (cat-col) some via media
    // query e o mesmo valor reaparece fundido sob o Tema (cat-inline,
    // display:none por padrão / display:block só em @media max-width:700px)
    // — evita que "Tema" quebre em até 6 linhas por falta de largura. Sem
    // <br>: cat-inline já é display:block na media query, e um bloco
    // sempre quebra linha antes de si mesmo — um <br> irmão solto
    // renderizaria incondicionalmente (inclusive em telas largas, onde
    // cat-inline é display:none), forçando uma linha em branco indesejada
    // em todo desktop/tablet (achado de self-review, angle A). "Categoria: "
    // como prefixo textual (não só posicional) preserva contexto pra
    // leitor de tela em mobile — a célula cat-col original tem <th>
    // associado; o texto fundido sob o Tema não tem esse vínculo de tabela.
    const categoryEsc = escHtml(r.category);
    return `<tr>
    <td>${escHtml(r.date)}</td>
    <td class="cat-col"><small>${categoryEsc}</small></td>
    <td>${temaCell}<small class="cat-inline muted">Categoria: ${categoryEsc}</small></td>
    <td class="metric">${r.ctr_pct.toFixed(2)}%</td>
    ${clicksCell(r.unique_verified_clicks)}
    <td>${linkCell}</td>
  </tr>`;
  }).join("\n");

  return `<section class="dash-section" id="ctr">
  <h2 class="section-title">CTR por categoria de link</h2>
  <p class="section-note">${ctr.total_editions} edições · ${ctr.total_links} links editoriais</p>

  <h3 class="subsection-title">Por categoria</h3>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Categoria do link (Destaque, Radar, Use Melhor, etc.)">Categoria</th>
        <th title="Total de links nesta categoria">Links</th>
        <th title="Total de cliques únicos verificados">Cliques</th>
        <th title="CTR médio da categoria (cliques ÷ opens)">CTR médio</th>
        <th title="CTR máximo registrado">CTR max</th>
      </tr>
    </thead>
    <tbody>${catRows}</tbody>
  </table>
  </div>

  <h3 class="subsection-title" style="margin-top:16px">Top 10 links por CTR</h3>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>Data</th>
        <th class="cat-col">Categoria</th>
        <th title="Título do destaque (links novos) ou âncora genérica resolvida para o destaque (links pré-mar/2026)">Tema</th>
        <th title="CTR: cliques ÷ opens">CTR</th>
        <th title="Cliques únicos verificados">Cliques</th>
        <th>Link</th>
      </tr>
    </thead>
    <tbody>${topRows}</tbody>
  </table>
  </div>
</section>`;
}

export function renderOvernightSection(data: DashboardData): string {
  const ov = data.overnight;
  if (!ov || ov.runs.length === 0) {
    return `<section class="dash-section" id="overnight">
  <h2 class="section-title">Timeline overnight</h2>
  <p class="section-note muted">Nenhuma rodada overnight encontrada em <code>data/overnight/</code>.</p>
</section>`;
  }

  const rows = [...ov.runs]
    .sort((a, b) => (b.edition > a.edition ? 1 : -1))
    .slice(0, 20)
    .map((r) => {
      // #2557: tooltips por grupo — só renderiza grupos com contagem > 0.
      // O número prefixo (N✓) indica contagem; cada grupo tem title= explicativo.
      let progress: string;
      if (r.total_issues === 0) {
        progress = "—";
      } else {
        const parts: string[] = [];
        // merged sempre renderizado (pode ser 0 se nenhuma mergeou ainda)
        parts.push(`<span title="${r.merged} mergeada${r.merged !== 1 ? "s" : ""}">${r.merged}✓</span>`);
        if (r.draft > 0) parts.push(`<span title="${r.draft} draft${r.draft !== 1 ? "s" : ""}">${r.draft}↩</span>`);
        if (r.pulada > 0) parts.push(`<span title="${r.pulada} pulada${r.pulada !== 1 ? "s" : ""}">${r.pulada}⊘</span>`);
        if (r.in_progress > 0) parts.push(`<span title="${r.in_progress} em andamento">${r.in_progress}⏳</span>`);
        progress = parts.join(" ");
      }
      const slowest = r.slowest_unit
        ? `${r.slowest_unit.label} (${fmtDuration(r.slowest_unit.duration_ms)})`
        : "—";
      return `<tr>
        <td>${escHtml(r.edition)}</td>
        <td title="${escHtml(fmtTimeBRT(r.started_at))}">${fmtTimeBRTShort(r.started_at)}</td>
        <td>${r.total_issues}</td>
        <td>${progress}</td>
        <td>${fmtDuration(r.duration_ms)}</td>
        <td><small>${escHtml(slowest)}</small></td>
      </tr>`;
    })
    .join("\n");

  return `<section class="dash-section" id="overnight">
  <h2 class="section-title">Timeline overnight</h2>
  <p class="section-note">${ov.total_runs} rodadas encontradas. Exibindo as 20 mais recentes.</p>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Data da rodada (AAMMDD)">Rodada</th>
        <th title="Início da rodada (BRT)">Início</th>
        <th title="Total de issues planejadas">Issues</th>
        <th title="N✓ mergeadas · N↩ drafts · N⊘ puladas · N⏳ em andamento (passe o mouse nos símbolos para a contagem)">Resultado</th>
        <th title="Duração total da rodada">Duração</th>
        <th title="Unidade mais lenta (label + duração)">Mais lenta</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  </div>
  <p class="section-note muted">✓ mergeada · ↩ draft · ⊘ pulada · ⏳ em andamento</p>
</section>`;
}

export function renderUseMelhorSection(data: DashboardData, now: Date = new Date()): string {
  const um = data.use_melhor;
  if (!um) {
    return `<section class="dash-section" id="use-melhor">
  <h2 class="section-title">Use Melhor</h2>
  <p class="section-note muted">Nenhuma edição com itens Use Melhor encontrada em <code>data/editions/*/  _internal/01-approved.json</code>. A seção Use Melhor foi introduzida em meados de 2026.</p>
</section>`;
  }

  // Coverage note
  const cov = um.coverage;
  const coveragePct = cov.coverage_pct;
  // #3098: link real pra aba CTR (antes texto solto "#CTR", não navegável)
  // — deep-link já suportado desde #2622. Definido uma vez e reusado nas 2
  // notas que citam a aba CTR (achado de self-review: estava duplicado
  // verbatim nas duas).
  // #3098 (2ª rodada de self-review — achado CONFIRMADO, corrige a 1ª):
  // a 1ª rodada tinha adicionado `opacity:1` aqui tentando contrariar a
  // opacity herdada do `<p class="... muted">` ao redor — mas opacity NÃO
  // é como color: um valor <1 no ancestral compõe TODO o subtree num
  // grupo semi-transparente antes de desenhar na página; opacity:1 num
  // descendente só afasta esse descendente ficar MAIS opaco que os
  // irmãos DENTRO do grupo, não o restaura à opacidade real da página. E
  // `.section-note` (a outra classe do `<p>`, sempre presente) já define
  // opacity:0.75 por si só, então nem removendo `.muted` do `<p>` isso se
  // resolveria sem tocar em ~15 outras notas que usam a mesma classe.
  // Consertar de verdade exigiria trocar `.muted`/`.section-note` de
  // opacity pra color (refactor maior, fora do escopo de um cleanup P3) —
  // então o link fica com o mesmo contraste reduzido do parágrafo ao
  // redor, igual ao link pré-existente do footer (`/api/data`, também
  // dentro de `.footer` com opacity:0.6). Não é regressão nova, é o
  // mesmo tradeoff que o resto do dashboard já aceita.
  const ctrTabLink = `<a href="#panel-ctr" style="color:var(--brand)">CTR</a>`;
  // #3098: "N sem match" descreve uma condição ESPERADA (join lossy por URL
  // de pesquisa ≠ URL publicada), não um alerta — não usar .alert-text aqui
  // (essa classe fica reservada a condições que pedem ação real, ex: streak
  // de falhas na Saúde das fontes).
  const coverageNote = cov.total_items > 0
    ? `Cobertura do join CTR: <strong>${cov.matched}/${cov.total_items} itens (${coveragePct}%)</strong>` +
      (cov.unmatched > 0
        ? ` — ${cov.unmatched} sem match (URL de pesquisa ≠ URL publicada — join lossy esperado, ver aba ${ctrTabLink})`
        : "")
    : "Sem dados de CTR disponíveis";

  // Top items table
  const hasTopItems = um.top_items.length > 0;
  const topRows = um.top_items.map((r) => {
    const safeHref = safeHttpHref(r.url);
    const linkCell = safeHref
      ? `<a href="${safeHref}" target="_blank" rel="noopener" style="color:var(--brand);font-size:0.8em">↗</a>`
      : `<span style="color:var(--ink);opacity:0.4;font-size:0.8em">—</span>`;
    // #2511 self-review (Angle A): ctr_pct é `number | null` no tipo — guarda contra
    // null (schema drift / JSON hand-crafted) p/ não crashar o render inteiro.
    const ctrCell = r.ctr_pct !== null ? `${r.ctr_pct.toFixed(2)}%` : "—";
    // #3098 (self-review follow-up): clicksCell() consolida a mesma
    // célula que CTR Top 10 e Top links (ver comentário na definição de
    // clicksCell) — comportamento idêntico ao `?? "—"` anterior.
    return `<tr>
      <td>${escHtml(r.edition)}</td>
      <td>${escHtml(r.title || "—")}</td>
      <td class="metric">${ctrCell}</td>
      ${clicksCell(r.unique_verified_clicks)}
      <td>${linkCell}</td>
    </tr>`;
  }).join("\n");

  // Per-edition rows (most recent first, up to 20)
  const editionRows = (um.editions ?? []).slice(0, 20).map((ed) => {
    // #3146: idade da edição calculada 1x por edição (mesma para todos os
    // itens dela) — distingue "ainda não estabilizou" (transitório, < 7d)
    // de "join por URL não bateu" (o gap de ~22% já documentado no rodapé).
    const ageDays = editionAgeDays(ed.edition, now);
    const itemList = (ed.items ?? []).map((it) => {
      // Narrowing inline (não via variável booleana separada) — TS só
      // estreita `ageDays` pra `number` dentro do próprio ramo do ternário.
      const ctrCell = it.ctr_pct !== null
        ? `<span class="metric">${it.ctr_pct.toFixed(1)}%</span>`
        : ageDays !== null && ageDays < MIN_AGE_DAYS_FOR_CLICKS
          ? `<span class="muted" title="CTR leva ${MIN_AGE_DAYS_FOR_CLICKS} dias pra estabilizar após a publicação">aguardando estabilização (${ageDays}d)</span>`
          : `<span class="muted">—</span>`;
      const safeHref = safeHttpHref(it.url);
      const linkCell = safeHref
        ? `<a href="${safeHref}" target="_blank" rel="noopener" style="color:var(--brand)">${escHtml(it.title || it.url)}</a>`
        : escHtml(it.title || it.url);
      return `<li>${linkCell} ${ctrCell}</li>`;
    }).join("");
    // #3098 (self-review follow-up): "N sem CTR" é a MESMA condição
    // esperada (join lossy) da nota de cobertura acima — usava
    // .alert-text (vermelho de ação), uma inconsistência dentro do mesmo
    // painel (a nota agregada já foi corrigida pra dizer "esperado", mas
    // cada linha de edição seguia piscando vermelho pra exatamente essa
    // mesma condição). .muted alinha com o resto do painel (dado de apoio).
    const matchNote = ed.ctr_unmatched > 0
      ? ` <small class="muted">(${ed.ctr_unmatched} sem CTR)</small>`
      : "";
    return `<tr>
      <td>${escHtml(ed.edition)}</td>
      <td>${ed.items.length} itens${matchNote}</td>
      <td><ul style="margin:0;padding-left:16px">${itemList}</ul></td>
    </tr>`;
  }).join("\n");

  return `<section class="dash-section" id="use-melhor">
  <h2 class="section-title">Use Melhor</h2>
  <p class="section-note">${um.total_editions_with_use_melhor} edições com Use Melhor (desde ${escHtml(um.first_edition ?? "—")})</p>
  <p class="section-note muted">${coverageNote}</p>

  ${hasTopItems ? `<h3 class="subsection-title">Top 10 itens por CTR (histórico)</h3>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Edição (AAMMDD)">Edição</th>
        <th title="Título do item">Título</th>
        <th title="CTR: cliques ÷ opens (URL publicada — join pode ser parcial)">CTR</th>
        <th title="Cliques únicos verificados">Cliques</th>
        <th>Link</th>
      </tr>
    </thead>
    <tbody>${topRows}</tbody>
  </table>
  </div>` : ""}

  <h3 class="subsection-title" style="margin-top:16px">Por edição (últimas 20)</h3>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="AAMMDD">Edição</th>
        <th title="Quantidade de itens">Itens</th>
        <th title="Itens publicados com CTR quando disponível">Conteúdo</th>
      </tr>
    </thead>
    <tbody>${editionRows}</tbody>
  </table>
  </div>
  <p class="section-note muted">Dados de <code>data/editions/*/  _internal/01-approved.json</code> + <code>data/link-ctr-table.csv</code>. Join por URL pode ser lossy (~22% gap esperado — ver aba ${ctrTabLink}).</p>
</section>`;
}

export function renderPollEiaSection(data: DashboardData): string {
  const poll = data.poll_eia;
  if (!poll) {
    return `<section class="dash-section" id="poll-eia">
  <h2 class="section-title">É IA? (poll)</h2>
  <p class="section-note muted">Dados não disponíveis. Requer push do <code>workers/poll</code>.</p>
  <p class="section-note muted">
    Para habilitar: o worker poll precisa escrever <code>data/poll-eia-summary.json</code>
    (via <code>npx tsx scripts/build-poll-eia-data.ts --push</code>) com o schema <code>PollEiaSummary</code>.
    <!-- TODO #2475: cross-worker KV read ou push do workers/poll — requer POLL KV namespace ID -->
  </p>
</section>`;
  }

  // #2511 self-review (Angles A+E): o Worker faz `JSON.parse(raw) as DashboardData`
  // sem revalidar — KV stale/corrompido pode trazer editions/leaderboard não-array.
  // Array.isArray defende o render contra crash no .map() (buildPollEiaSummary já
  // valida no lado do build, mas o Worker lê o KV direto).
  const editions = Array.isArray(poll.editions) ? poll.editions : [];
  const leaderboard = Array.isArray(poll.leaderboard) ? poll.leaderboard : [];

  // Edition rows
  const edRows = editions.slice(0, 20).map((ed) => {
    const pctCell = ed.pct_correct !== null
      ? `<span class="metric">${ed.pct_correct}%</span>`
      : `<span class="muted">—</span>`;
    const correctCell = ed.correct_choice ? escHtml(ed.correct_choice) : `<span class="muted">?</span>`;
    return `<tr>
      <td>${escHtml(ed.edition)}</td>
      <td>${ed.total_votes}</td>
      <td>${ed.voted_a} / ${ed.voted_b}</td>
      <td>${correctCell}</td>
      <td>${pctCell}</td>
    </tr>`;
  }).join("\n");

  // Leaderboard
  const lbRows = leaderboard.slice(0, 10).map((e, i) => `<tr>
    <td>${i + 1}º</td>
    <td>${escHtml(e.display_name)}</td>
    <td class="metric">${e.correct}</td>
    <td>${e.total}</td>
    <td>${e.streak > 0 ? `🔥${e.streak}` : "—"}</td>
  </tr>`).join("\n");

  const updatedAt = poll.updated_at ? fmtTimeBRT(poll.updated_at) : "—";

  // #2604: quando editions está vazio (script rodou mas nenhuma edição tem votos ainda)
  // mostrar mensagem em vez de tabela vazia silenciosa.
  const editionsSection = editions.length === 0
    ? `<p class="section-note muted">Sem dados de edições ainda. Rode <code>npx tsx scripts/build-poll-eia-data.ts --push</code> e depois <code>npx tsx scripts/build-diaria-dashboard-data.ts --push</code>.</p>`
    : `<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="AAMMDD">Edição</th>
        <th title="Total de votos (votos de teste excluídos)">Total</th>
        <th title="Votos A / Votos B">A / B</th>
        <th title="Opção correta">Correta</th>
        <th title="% que acertou">% acerto</th>
      </tr>
    </thead>
    <tbody>${edRows}</tbody>
  </table>
  </div>`;

  return `<section class="dash-section" id="poll-eia">
  <h2 class="section-title">É IA? (poll)</h2>
  <p class="section-note">${editions.length} edições com dados de poll · Atualizado: ${updatedAt} · Fonte: <code>${escHtml(poll.source)}</code></p>
  <p class="section-note muted">Votos de teste do editor excluídos (pixel@memelab.com.br + vjpixel@gmail.com).</p>

  <h3 class="subsection-title">Por edição</h3>
  ${editionsSection}

  <h3 class="subsection-title" style="margin-top:16px">Leaderboard (top 10)</h3>
  ${lbRows ? `<div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Participante</th>
        <th title="Total de acertos">Acertos</th>
        <th title="Total de participações">Participações</th>
        <th title="Streak atual">Streak</th>
      </tr>
    </thead>
    <tbody>${lbRows}</tbody>
  </table>
  </div>` : `<p class="section-note muted">Sem dados de leaderboard ainda.</p>`}
</section>`;
}

// ─── #2558: Top links por cliques absolutos — últimas 20 edições (#2601) ─────

export function renderTopClickedRecentSection(data: DashboardData): string {
  const tcr = data.top_clicked_recent;
  if (!tcr) {
    return `<section class="dash-section" id="top-clicked-recent">
  <h2 class="section-title">Top 10 links mais clicados (últimas 20 edições)</h2>
  <p class="section-note muted">Arquivo <code>data/link-ctr-table.csv</code> não encontrado ou vazio. Rode <code>npm run build-link-ctr</code> para gerar.</p>
</section>`;
  }

  // #3098 (self-review follow-up): janela reordenada aqui em vez de
  // confiar na ordem de produção do KV — mesmo padrão defensivo de
  // renderOvernightSection acima, que também reordena `ov.runs` antes de
  // exibir. Tooltip e rótulo agora usam a MESMA ordem ascendente (antes o
  // tooltip preservava a ordem crua do produtor enquanto o rótulo dizia
  // "oldest → newest" — divergência confusa entre os dois). String() por
  // elemento protege escHtml() de um elemento não-string por schema drift
  // (dado vem de `JSON.parse(raw) as DashboardData` sem validação de
  // schema); o .join() original (pré-#3098) tolerava isso implicitamente
  // via stringificação automática, mas escHtml() aplicado direto num
  // elemento não-string quebraria a página inteira.
  const windowEditions = (tcr.window_editions ?? [])
    .map((e) => String(e))
    .sort((a, b) => (a > b ? 1 : -1)); // ascendente: mais antiga primeiro
  const windowLabel = windowEditions.length > 1
    ? `<span title="${escHtml(windowEditions.join(", "))}">Janela: ${escHtml(windowEditions[0])} → ${escHtml(windowEditions[windowEditions.length - 1])} (${windowEditions.length} edições)</span>`
    : windowEditions.length === 1
      ? `Janela: ${escHtml(windowEditions[0])}`
      : "Janela: —";

  const rows = (tcr.top_items ?? []).map((r, i) => {
    const safeHref = safeHttpHref(r.base_url);
    const linkCell = safeHref
      ? `<a href="${safeHref}" target="_blank" rel="noopener" style="color:var(--brand);font-size:0.8em">↗</a>`
      : `<span style="color:var(--ink);opacity:0.4;font-size:0.8em">—</span>`;
    // #3098: clicksCell() (não td.metric) por consistência entre abas —
    // aqui cliques é a chave de ordenação da tabela, td.metric seria
    // defensável, mas a issue pediu convenção única entre CTR/Top links/
    // Use Melhor. Categoria→Âncora reusa cat-col/cat-inline (já definidos
    // globalmente pra aba CTR acima), mesmo risco de wrap em 6 colunas.
    const categoryEsc = escHtml(r.category);
    return `<tr>
    <td>${i + 1}</td>
    <td>${escHtml(r.edition)}</td>
    <td class="cat-col"><small>${categoryEsc}</small></td>
    <td>${escHtml(r.anchor)}<small class="cat-inline muted">Categoria: ${categoryEsc}</small></td>
    ${clicksCell(r.unique_verified_clicks)}
    <td>${linkCell}</td>
  </tr>`;
  }).join("\n");

  return `<section class="dash-section" id="top-clicked-recent">
  <h2 class="section-title">Top 10 links mais clicados (últimas 20 edições)</h2>
  <p class="section-note">${windowLabel} · por cliques absolutos (<code>unique_verified_clicks</code>)</p>
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Posição">#</th>
        <th title="Edição com mais cliques do link na janela de 20 edições">Edição</th>
        <th class="cat-col" title="Categoria do link">Categoria</th>
        <th title="Âncora do link (título ou label)">Âncora</th>
        <th title="Cliques únicos verificados (soma da janela de 20 edições)">Cliques</th>
        <th>Link</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  </div>
  <p class="section-note muted">Distinto do Top 10 por CTR (all-time). Esta seção usa cliques absolutos nas últimas 20 edições.</p>
</section>`;
}

// ─── #2560: Perfil de audiência ───────────────────────────────────────────────

export function renderAudienceSection(data: DashboardData): string {
  const audience = data.audience;
  if (!audience) {
    return `<section class="dash-section" id="audience">
  <h2 class="section-title">Perfil de audiência</h2>
  <p class="section-note muted">Arquivo <code>context/audience-profile.md</code> não encontrado. Rode <code>npx tsx scripts/update-audience.ts</code> para gerar.</p>
</section>`;
  }

  // Metadata strip
  const metaParts: string[] = [];
  if (audience.subscribers !== null) metaParts.push(`${audience.subscribers} assinantes ativos`);
  if (audience.survey_respondents !== null) metaParts.push(`${audience.survey_respondents} respondentes survey`);
  if (audience.links_analyzed !== null) metaParts.push(`${audience.links_analyzed} links analisados`);
  if (audience.updated_at) metaParts.push(`atualizado ${escHtml(audience.updated_at)}`);
  const metaLine = metaParts.join(" · ");

  // CTR por categoria
  const ctrRows = (audience.ctr_by_category ?? []).map((r) => `<tr>
    <td>${escHtml(r.category)}</td>
    <td class="metric">${r.ctr_pct.toFixed(2)}%</td>
    <td>${r.link_count}</td>
  </tr>`).join("\n");

  const avgCtrLine = audience.avg_ctr_pct !== null
    ? `<p class="section-note">CTR médio geral: <strong>${audience.avg_ctr_pct.toFixed(2)}%</strong></p>`
    : "";

  // Survey: content preferences
  const contentRows = (audience.content_preferences ?? []).slice(0, 8).map((r) => `<tr>
    <td>${escHtml(r.label)}</td>
    <td class="metric">${(r.weight * 100).toFixed(1)}%</td>
    <td><small>${r.count}</small></td>
  </tr>`).join("\n");

  // Survey: knowledge levels
  const knowledgeRows = (audience.knowledge_levels ?? []).map((r) => `<tr>
    <td>${escHtml(r.label)}</td>
    <td class="metric">${(r.weight * 100).toFixed(1)}%</td>
    <td><small>${r.count}</small></td>
  </tr>`).join("\n");

  // Survey: sectors (top 10)
  const sectorRows = (audience.sectors ?? []).slice(0, 10).map((r) => `<tr>
    <td>${escHtml(r.label)}</td>
    <td class="metric">${(r.weight * 100).toFixed(1)}%</td>
    <td><small>${r.count}</small></td>
  </tr>`).join("\n");

  const surveyHeader = `
    <thead>
      <tr>
        <th title="Opção de resposta">Opção</th>
        <th title="Peso relativo (% dos respondentes)">Peso</th>
        <th title="Respostas">N</th>
      </tr>
    </thead>`;

  return `<section class="dash-section" id="audience">
  <h2 class="section-title">Perfil de audiência</h2>
  ${metaLine ? `<p class="section-note">${metaLine}</p>` : ""}

  ${ctrRows ? `<h3 class="subsection-title">Engajamento por categoria (CTR)</h3>
  ${avgCtrLine}
  <div class="table-wrap">
  <table>
    <thead>
      <tr>
        <th title="Categoria do link">Categoria</th>
        <th title="CTR médio da categoria (com decaimento temporal)">CTR</th>
        <th title="Total de links analisados">Links</th>
      </tr>
    </thead>
    <tbody>${ctrRows}</tbody>
  </table>
  </div>` : ""}

  ${contentRows ? `<h3 class="subsection-title" style="margin-top:16px">Conteúdo preferido (survey)</h3>
  <div class="table-wrap">
  <table>${surveyHeader}
    <tbody>${contentRows}</tbody>
  </table>
  </div>` : ""}

  ${knowledgeRows ? `<h3 class="subsection-title" style="margin-top:16px">Nível de conhecimento em IA (survey)</h3>
  <div class="table-wrap">
  <table>${surveyHeader}
    <tbody>${knowledgeRows}</tbody>
  </table>
  </div>` : ""}

  ${sectorRows ? `<h3 class="subsection-title" style="margin-top:16px">Setores (survey, top 10)</h3>
  <div class="table-wrap">
  <table>${surveyHeader}
    <tbody>${sectorRows}</tbody>
  </table>
  </div>` : ""}

  <p class="section-note muted">Fonte primária: CTR comportamental (<code>data/link-ctr-table.csv</code>). Fonte secundária: survey declarativo (<code>data/audience-raw.json</code>). Dados de <code>context/audience-profile.md</code>.</p>
</section>`;
}

export function renderStubsSection(stubs: StubSection[]): string {
  if (stubs.length === 0) return "";

  const items = stubs.map((s) =>
    `<li><strong>${escHtml(s.id)}</strong> — ${escHtml(s.description)} <small class="muted">(${escHtml(s.tracking_issue)})</small></li>`
  ).join("\n");

  return `<section class="dash-section" id="stubs">
  <h2 class="section-title">Em breve</h2>
  <p class="section-note">Seções planejadas aguardando dados ou implementação:</p>
  <ul>${items}</ul>
</section>`;
}

// ─── Render completo ──────────────────────────────────────────────────────────

export function renderDashboardHtml(data: DashboardData): string {
  const now = new Date().toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const generatedAt = data.generated_at
    ? fmtTimeBRT(data.generated_at)
    : "—";

  const sourceSection = renderSourceHealthSection(data);
  const ctrSection = renderCtrSection(data);
  const overnightSection = renderOvernightSection(data);
  const useMelhorSection = renderUseMelhorSection(data);
  const pollEiaSection = renderPollEiaSection(data);
  const topClickedRecentSection = renderTopClickedRecentSection(data);
  const audienceSection = renderAudienceSection(data);
  const stubsSection = renderStubsSection(data.stubs ?? []);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Diar.ia Dashboard Operacional</title>
<style>
  :root {
    --brand: ${DS.brand};
    --ink: ${DS.ink};
    --paper: ${DS.paper};
    --paper-alt: ${DS.paperAlt};
    --rule: ${DS.rule};
  }
  body { font-family: ${DSF.sans}; max-width: 1200px; margin: 30px auto; padding: 0 20px; background: var(--paper); color: var(--ink); }
  h1 { font-size: 1.6rem; margin: 0 0 4px 0; color: var(--ink); }
  .sub { color: var(--ink); opacity: 0.6; font-size: 0.9rem; margin: 0 0 24px 0; }
  .dash-section { margin: 32px 0 8px 0; }
  .section-title { font-size: 1.1rem; font-weight: 700; margin: 0 0 6px 0; color: var(--ink); border-bottom: 2px solid var(--rule); padding-bottom: 6px; }
  .subsection-title { font-size: 0.95rem; font-weight: 700; margin: 12px 0 4px 0; color: var(--ink); }
  .section-note { font-size: 0.85rem; color: var(--ink); opacity: 0.75; margin: 0 0 12px 0; }
  /* #3098: 0.55 media ~4.03:1 sobre --paper em 0.85rem — abaixo de AA (4.5:1).
     0.65 dá margem (~4.7:1) sem escurecer demais o efeito "secundário". */
  .muted { color: var(--ink); opacity: 0.65; }
  /* #3097: opacity explícita (não herdada de small, que é 0.6, ~3.40:1) —
     alerta de ação (streak de falhas, "sem match") precisa ser MAIS legível
     que dados neutros, não menos. Sem cor nova: só reforça a mesma --alert. */
  .alert-text { color: #C00000; opacity: 1; font-weight: 600; }
  .table-wrap { overflow-x: auto; }
  /* #3075: Saúde das fontes é a tabela mais longa do dashboard — o th
     position:sticky (acima) só funciona com um scroll container vertical de
     verdade. table-wrap sozinho só rola no eixo X; esta variante dá um
     max-height + overflow-y:auto pra fazer o sticky funcionar de fato. */
  .table-wrap-scroll { max-height: 60vh; overflow-y: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { padding: 8px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }
  th { background: var(--paper-alt); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; color: var(--ink); position: sticky; top: 0; cursor: help; border-bottom: 2px solid rgba(23,20,17,0.18); }
  /* #3096: teal (--brand, #00A0A0) mede ~3.08:1 sobre --paper — abaixo de AA
     (4.5:1) para texto. td.metric é o dado central de todas as tabelas, então
     volta a --ink (peso 600 mantém a ênfase); teal fica reservado a
     links/estado ativo de aba (elementos gráficos, 3:1 é aceitável). */
  td.metric { font-weight: 600; color: var(--ink); }
  /* #3098: fusão Categoria→Tema em mobile (aba CTR, Top 10) — a coluna
     Categoria isolada (cat-col) só existe em telas largas; a versão inline
     (cat-inline) fica oculta por padrão e aparece só na media query abaixo,
     junto com o cat-col sumindo, pra Tema não quebrar em várias linhas. */
  .cat-inline { display: none; }
  ul { padding-left: 20px; }
  li { margin: 6px 0; font-size: 0.9rem; }
  code { background: var(--paper-alt); padding: 1px 5px; border-radius: 3px; font-size: 0.9em; }
  .footer { color: var(--ink); opacity: 0.6; font-size: 0.75rem; margin-top: 32px; text-align: center; padding-top: 16px; border-top: 1px solid var(--rule); }
  small { color: var(--ink); opacity: 0.6; font-size: 0.8em; }
  /* #2602: tab navigation — CSS-only via radio+label+:checked (mesmo padrão do brevo-dashboard #2542) */
  /* Radios visualmente ocultos mas FOCÁVEIS via teclado (não display:none, que os
     removeria da ordem de tabulação — Tab/setas precisam alcançar as abas). */
  .tab-radios { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; clip-path: inset(50%); pointer-events: none; }
  /* flex-wrap: nowrap + overflow-x: auto evita que a borda da aba ativa quebre ao mudar de linha em telas estreitas */
  /* #3093: overflow-y: hidden — .tab-label tem margin-bottom: -2px (sobrepõe a borda
     ativa) que estoura o container em 2px verticalmente; sem isso, overflow-x: auto
     computa overflow-y para auto também e renderiza uma scrollbar vertical fantasma
     (o conteúdo nunca precisa rolar verticalmente, só horizontalmente). */
  .tab-bar { display: flex; gap: 4px; margin: 16px 0 0 0; border-bottom: 2px solid var(--rule); padding-bottom: 0; flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; }
  /* #3094: wrapper só para ancorar o fade de overflow (::after) fora da área que
     rola — se o fade ficasse dentro de .tab-bar ele rolaria junto com as abas. */
  .tab-bar-wrap { position: relative; }
  .tab-bar-wrap::after {
    content: ""; position: absolute; top: 0; right: 0; bottom: 2px; width: 20px;
    background: linear-gradient(to right, transparent, var(--paper));
    pointer-events: none;
  }
  .tab-label {
    display: inline-block; padding: 8px 18px; font-size: 0.85rem; font-weight: 600;
    cursor: pointer; border: 1px solid transparent; border-bottom: 2px solid transparent;
    border-radius: 4px 4px 0 0; color: var(--ink); opacity: 0.65;
    margin-bottom: -2px; user-select: none; white-space: nowrap;
    transition: opacity 0.1s;
  }
  .tab-label:hover { opacity: 1; background: var(--paper-alt); }
  #tab-visaogeral:checked ~ .tab-bar label[for="tab-visaogeral"],
  #tab-saude:checked ~ .tab-bar label[for="tab-saude"],
  #tab-ctr:checked ~ .tab-bar label[for="tab-ctr"],
  #tab-toplinks:checked ~ .tab-bar label[for="tab-toplinks"],
  #tab-usemelhor:checked ~ .tab-bar label[for="tab-usemelhor"],
  #tab-eia:checked ~ .tab-bar label[for="tab-eia"],
  #tab-audiencia:checked ~ .tab-bar label[for="tab-audiencia"] {
    background: var(--paper); border-color: var(--rule); opacity: 1;
    color: var(--brand); border-bottom-color: var(--paper);
  }
  /* Foco de teclado: o radio focado projeta um contorno no seu label irmão. */
  #tab-visaogeral:focus-visible ~ .tab-bar label[for="tab-visaogeral"],
  #tab-saude:focus-visible ~ .tab-bar label[for="tab-saude"],
  #tab-ctr:focus-visible ~ .tab-bar label[for="tab-ctr"],
  #tab-toplinks:focus-visible ~ .tab-bar label[for="tab-toplinks"],
  #tab-usemelhor:focus-visible ~ .tab-bar label[for="tab-usemelhor"],
  #tab-eia:focus-visible ~ .tab-bar label[for="tab-eia"],
  #tab-audiencia:focus-visible ~ .tab-bar label[for="tab-audiencia"] {
    outline: 2px solid var(--brand); outline-offset: 2px; opacity: 1;
  }
  .tab-panel { display: none; padding-top: 8px; }
  #tab-visaogeral:checked ~ .tab-panels #panel-visaogeral,
  #tab-saude:checked ~ .tab-panels #panel-saude,
  #tab-ctr:checked ~ .tab-panels #panel-ctr,
  #tab-toplinks:checked ~ .tab-panels #panel-toplinks,
  #tab-usemelhor:checked ~ .tab-panels #panel-usemelhor,
  #tab-eia:checked ~ .tab-panels #panel-eia,
  #tab-audiencia:checked ~ .tab-panels #panel-audiencia { display: block; }
  @media (max-width: 700px) {
    body { margin: 16px auto; padding: 0 12px; }
    table { font-size: 0.8rem; }
    th, td { padding: 6px 4px; }
    /* #3094: em 390px as 6 abas não cabiam (scrollWidth 348 vs clientWidth 336,
       déficit ~12px) — gap 4px→2px e padding 6px 10px→6px 8px liberam ~34px. */
    .tab-bar { gap: 2px; }
    .tab-label { padding: 6px 8px; font-size: 0.8rem; }
    /* #3098: esconde a coluna Categoria isolada da aba CTR (Top 10) e mostra
       a versão fundida sob o Tema (cat-inline) — libera largura pro Tema. */
    .cat-col { display: none; }
    .cat-inline { display: block; margin-top: 2px; }
  }
</style>
</head>
<body>
<h1>Diar.ia — Dashboard Operacional</h1>
<p class="sub">Dados locais (último push: ${escHtml(generatedAt)}). Carregado às ${escHtml(now)} BRT.</p>

<!-- #2602: tab state inputs (hidden, CSS-only — mesmo padrão do brevo-dashboard #2542) -->
<input type="radio" class="tab-radios" name="dash-tab" id="tab-visaogeral" checked>
<input type="radio" class="tab-radios" name="dash-tab" id="tab-saude">
<input type="radio" class="tab-radios" name="dash-tab" id="tab-ctr">
<input type="radio" class="tab-radios" name="dash-tab" id="tab-toplinks">
<input type="radio" class="tab-radios" name="dash-tab" id="tab-usemelhor">
<input type="radio" class="tab-radios" name="dash-tab" id="tab-eia">
<input type="radio" class="tab-radios" name="dash-tab" id="tab-audiencia">

<!-- tab bar -->
<div class="tab-bar-wrap">
<div class="tab-bar" role="tablist" aria-label="Seções do dashboard">
  <label class="tab-label" id="tablabel-visaogeral" for="tab-visaogeral" role="tab" aria-controls="panel-visaogeral">Visão geral</label>
  <label class="tab-label" id="tablabel-saude" for="tab-saude" role="tab" aria-controls="panel-saude">Saúde das fontes</label>
  <label class="tab-label" id="tablabel-ctr" for="tab-ctr" role="tab" aria-controls="panel-ctr">CTR</label>
  <label class="tab-label" id="tablabel-toplinks" for="tab-toplinks" role="tab" aria-controls="panel-toplinks">Top links</label>
  <label class="tab-label" id="tablabel-usemelhor" for="tab-usemelhor" role="tab" aria-controls="panel-usemelhor">Use Melhor</label>
  <label class="tab-label" id="tablabel-eia" for="tab-eia" role="tab" aria-controls="panel-eia">É IA?</label>
  <label class="tab-label" id="tablabel-audiencia" for="tab-audiencia" role="tab" aria-controls="panel-audiencia">Audiência</label>
</div>
</div><!-- /tab-bar-wrap -->

<!-- tab panels -->
<div class="tab-panels">

  <!-- Aba 1: Visão geral — overnight + em breve -->
  <div class="tab-panel" id="panel-visaogeral" role="tabpanel" aria-labelledby="tablabel-visaogeral">
${overnightSection}
${stubsSection}
  </div><!-- /panel-visaogeral -->

  <!-- Aba 2: Saúde das fontes (#3075: era sub-seção de Visão geral, virou aba própria) -->
  <div class="tab-panel" id="panel-saude" role="tabpanel" aria-labelledby="tablabel-saude">
${sourceSection}
  </div><!-- /panel-saude -->

  <!-- Aba 3: CTR por categoria de link -->
  <div class="tab-panel" id="panel-ctr" role="tabpanel" aria-labelledby="tablabel-ctr">
${ctrSection}
  </div><!-- /panel-ctr -->

  <!-- Aba 4: Top links por cliques absolutos -->
  <div class="tab-panel" id="panel-toplinks" role="tabpanel" aria-labelledby="tablabel-toplinks">
${topClickedRecentSection}
  </div><!-- /panel-toplinks -->

  <!-- Aba 5: Use Melhor -->
  <div class="tab-panel" id="panel-usemelhor" role="tabpanel" aria-labelledby="tablabel-usemelhor">
${useMelhorSection}
  </div><!-- /panel-usemelhor -->

  <!-- Aba 6: É IA? (poll) -->
  <div class="tab-panel" id="panel-eia" role="tabpanel" aria-labelledby="tablabel-eia">
${pollEiaSection}
  </div><!-- /panel-eia -->

  <!-- Aba 7: Perfil de audiência -->
  <div class="tab-panel" id="panel-audiencia" role="tabpanel" aria-labelledby="tablabel-audiencia">
${audienceSection}
  </div><!-- /panel-audiencia -->

</div><!-- /tab-panels -->

<p class="footer">
  Dashboard Operacional Diar.ia — dados locais via KV push (<code>build-diaria-dashboard-data.ts --push</code>).<br>
  Dados brutos em <a href="/api/data" style="color:var(--brand)">/api/data</a>. Schema v${data.schema_version ?? 1}.
</p>
<script>
/* #2622: progressive enhancement — deep-link (hash<->aba) + aria-selected. Sem JS, o CSS-only puro segue funcionando. */
(function () {
  var radios = Array.prototype.slice.call(document.querySelectorAll('.tab-radios'));
  if (!radios.length) return;
  var labels = Array.prototype.slice.call(document.querySelectorAll('.tab-label'));
  function panelOf(radio) {
    var lbl = document.querySelector('.tab-label[for="' + radio.id + '"]');
    return lbl ? lbl.getAttribute('aria-controls') : null;
  }
  function syncAria() {
    labels.forEach(function (lbl) {
      var r = document.getElementById(lbl.getAttribute('for'));
      lbl.setAttribute('aria-selected', r && r.checked ? 'true' : 'false');
    });
  }
  function applyHash() {
    var h = (location.hash || '').replace(/^#/, '');
    if (!h) return;
    var matched = radios.filter(function (r) { return r.id === h || panelOf(r) === h; })[0];
    if (matched) matched.checked = true;
  }
  radios.forEach(function (r) {
    r.addEventListener('change', function () {
      if (!r.checked) return;
      var pid = panelOf(r);
      if (pid && history.replaceState) history.replaceState(null, '', '#' + pid);
      syncAria();
    });
  });
  window.addEventListener('hashchange', function () { applyHash(); syncAria(); });
  applyHash();
  syncAria();
})();
</script>
</body>
</html>`;
}

// ─── Fetch handler ────────────────────────────────────────────────────────────

const KV_KEY = "dashboard";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/healthz") {
      return new Response("ok", { headers: { "Content-Type": "text/plain" } });
    }

    // Cache de borda 5min (mesmo padrão do brevo-dashboard #2144)
    const isFresh = url.searchParams.get("fresh") === "1";
    const isCacheable = (path === "/" || path === "/index.html" || path === "/api/data");
    const cache = caches.default;

    if (isCacheable && !isFresh) {
      const cached = await cache.match(request);
      if (cached) return cached;
    }

    // Lê JSON do KV
    let data: DashboardData | null = null;
    try {
      const raw = await env.DASHBOARD_DATA.get(KV_KEY, "text");
      if (raw) {
        data = JSON.parse(raw) as DashboardData;
      }
    } catch {
      // KV indisponível ou JSON malformado — tratar como ausente
    }

    if (path === "/api/data") {
      if (!data) {
        return new Response(JSON.stringify({ error: "no_data", hint: "Run build-diaria-dashboard-data.ts --push to populate KV." }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      const response = new Response(JSON.stringify(data, null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": isFresh ? "no-store" : "private, max-age=300",
          ...(!isFresh ? { "CDN-Cache-Control": "public, max-age=300" } : {}),
        },
      });
      if (!isFresh) await cache.put(request, response.clone());
      return response;
    }

    if (path === "/" || path === "/index.html") {
      if (!data) {
        const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Diar.ia Dashboard</title></head><body>
<h1>Dashboard não inicializado</h1>
<p>Rode localmente: <code>npx tsx scripts/build-diaria-dashboard-data.ts --dry-run</code> para verificar, depois <code>--push</code> para publicar os dados.</p>
</body></html>`;
        return new Response(html, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }

      const html = renderDashboardHtml(data);
      const response = new Response(html, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": isFresh ? "no-store" : "private, max-age=300",
          ...(!isFresh ? { "CDN-Cache-Control": "public, max-age=300" } : {}),
        },
      });
      if (!isFresh) await cache.put(request, response.clone());
      return response;
    }

    return new Response("Not found", { status: 404 });
  },
};
