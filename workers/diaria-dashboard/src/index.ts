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
import type { DashboardData, SourceHealthEntry, OvernightRun, CtrByCategoryRow, StubSection, UseMelhorSummary, PollEiaSummary } from "./types.ts";

const DS = DS_COLORS;

export interface Env {
  DASHBOARD_DATA: KVNamespace;
}

// ─── Re-export types para testes ─────────────────────────────────────────────

export type { DashboardData, SourceHealthEntry, OvernightRun, CtrByCategoryRow, StubSection, UseMelhorSummary, PollEiaSummary };

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

function fmtDuration(ms: number | null): string {
  if (ms === null || ms < 0) return "—";
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h${String(m).padStart(2, "0")}m`;
}

function statusBadge(status: "verde" | "amarelo" | "vermelho"): string {
  if (status === "verde") return `<span style="color:#2d8a4e">●</span>`;
  if (status === "amarelo") return `<span style="color:#c07800">●</span>`;
  return `<span style="color:#C00000">●</span>`;
}

/**
 * #2511 self-review (Angle Reuse): href escapado só se for http(s) — bloqueia
 * javascript:/data: URIs. Consolidado das 3 cópias do mesmo regex+ternário
 * (renderCtrSection + renderUseMelhorSection top/edition rows).
 */
function safeHttpHref(url: string): string {
  return /^https?:\/\//i.test(url) ? escHtml(url) : "";
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
        <td>${fmtTimeBRT(e.last_success_iso)}</td>
        <td>${fmtTimeBRT(e.last_failure_iso)}</td>
      </tr>`;
    })
    .join("\n");

  const pctVerde = sh.total > 0 ? ((sh.verde / sh.total) * 100).toFixed(0) : "0";

  return `<section class="dash-section" id="source-health">
  <h2 class="section-title">Saúde das fontes</h2>
  <p class="section-note">${sh.total} fontes — <span style="color:#2d8a4e">${sh.verde} verde</span> · <span style="color:#c07800">${sh.amarelo} amarelo</span> · <span style="color:#C00000">${sh.vermelho} vermelho</span> · ${pctVerde}% OK</p>
  <div class="table-wrap">
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
    return `<tr>
    <td>${escHtml(r.date)}</td>
    <td><small>${escHtml(r.category)}</small></td>
    <td>${escHtml(r.anchor)}</td>
    <td class="metric">${r.ctr_pct.toFixed(2)}%</td>
    <td><small>${r.unique_verified_clicks}</small></td>
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
        <th>Categoria</th>
        <th>Âncora</th>
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
      const progress = r.total_issues > 0
        ? `${r.merged}✓ ${r.draft > 0 ? r.draft + "↩ " : ""}${r.pulada > 0 ? r.pulada + "⊘ " : ""}${r.in_progress > 0 ? r.in_progress + "⏳" : ""}`.trim()
        : "—";
      const slowest = r.slowest_unit
        ? `${r.slowest_unit.label} (${fmtDuration(r.slowest_unit.duration_ms)})`
        : "—";
      return `<tr>
        <td>${escHtml(r.edition)}</td>
        <td>${fmtTimeBRT(r.started_at)}</td>
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
        <th title="✓ mergeado · ↩ draft · ⊘ pulada · ⏳ em andamento">Resultado</th>
        <th title="Duração total da rodada">Duração</th>
        <th title="Unidade mais lenta (label + duração)">Mais lenta</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  </div>
</section>`;
}

export function renderUseMelhorSection(data: DashboardData): string {
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
  const coverageNote = cov.total_items > 0
    ? `Cobertura do join CTR: <strong>${cov.matched}/${cov.total_items} itens (${coveragePct}%)</strong>` +
      (cov.unmatched > 0
        ? ` — <span class="alert-text">${cov.unmatched} sem match</span> (URL de pesquisa ≠ URL publicada — join lossy esperado, ver #CTR)`
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
    return `<tr>
      <td>${escHtml(r.edition)}</td>
      <td>${escHtml(r.title || "—")}</td>
      <td class="metric">${ctrCell}</td>
      <td><small>${r.unique_verified_clicks ?? "—"}</small></td>
      <td>${linkCell}</td>
    </tr>`;
  }).join("\n");

  // Per-edition rows (most recent first, up to 20)
  const editionRows = (um.editions ?? []).slice(0, 20).map((ed) => {
    const itemList = (ed.items ?? []).map((it) => {
      const ctrCell = it.ctr_pct !== null
        ? `<span class="metric">${it.ctr_pct.toFixed(1)}%</span>`
        : `<span class="muted">—</span>`;
      const safeHref = safeHttpHref(it.url);
      const linkCell = safeHref
        ? `<a href="${safeHref}" target="_blank" rel="noopener" style="color:var(--brand)">${escHtml(it.title || it.url)}</a>`
        : escHtml(it.title || it.url);
      return `<li>${linkCell} ${ctrCell}</li>`;
    }).join("");
    const matchNote = ed.ctr_unmatched > 0
      ? ` <small class="alert-text">(${ed.ctr_unmatched} sem CTR)</small>`
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
  <p class="section-note muted">Dados de <code>data/editions/*/  _internal/01-approved.json</code> + <code>data/link-ctr-table.csv</code>. Join por URL pode ser lossy (~22% gap esperado — #CTR).</p>
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

  return `<section class="dash-section" id="poll-eia">
  <h2 class="section-title">É IA? (poll)</h2>
  <p class="section-note">${editions.length} edições com dados de poll · Atualizado: ${updatedAt} · Fonte: <code>${escHtml(poll.source)}</code></p>
  <p class="section-note muted">Votos de teste do editor excluídos (pixel@memelab.com.br + vjpixel@gmail.com).</p>

  <h3 class="subsection-title">Por edição</h3>
  <div class="table-wrap">
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
  </div>

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
  .muted { color: var(--ink); opacity: 0.55; }
  .alert-text { color: #C00000; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th, td { padding: 8px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }
  th { background: var(--paper-alt); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; color: var(--ink); position: sticky; top: 0; cursor: help; border-bottom: 2px solid rgba(23,20,17,0.18); }
  td.metric { font-weight: 600; color: var(--brand); }
  .nav { display: flex; gap: 16px; flex-wrap: wrap; margin: 0 0 24px 0; font-size: 0.85rem; }
  .nav a { color: var(--brand); text-decoration: none; padding: 4px 10px; border: 1px solid var(--rule); border-radius: 4px; }
  .nav a:hover { background: var(--paper-alt); }
  ul { padding-left: 20px; }
  li { margin: 6px 0; font-size: 0.9rem; }
  code { background: var(--paper-alt); padding: 1px 5px; border-radius: 3px; font-size: 0.9em; }
  .footer { color: var(--ink); opacity: 0.6; font-size: 0.75rem; margin-top: 32px; text-align: center; padding-top: 16px; border-top: 1px solid var(--rule); }
  small { color: var(--ink); opacity: 0.6; font-size: 0.8em; }
  @media (max-width: 700px) {
    body { margin: 16px auto; padding: 0 12px; }
    table { font-size: 0.8rem; }
    th, td { padding: 6px 4px; }
  }
</style>
</head>
<body>
<h1>Diar.ia — Dashboard Operacional</h1>
<p class="sub">Dados locais (last push: ${escHtml(generatedAt)}). Carregado às ${escHtml(now)} BRT.</p>

<nav class="nav">
  <a href="#ctr">CTR por categoria</a>
  <a href="#use-melhor">Use Melhor</a>
  <a href="#poll-eia">É IA?</a>
  <a href="#overnight">Overnight</a>
  <a href="#source-health">Saúde das fontes</a>
  ${data.stubs?.length ? '<a href="#stubs">Em breve</a>' : ""}
</nav>

${ctrSection}
${useMelhorSection}
${pollEiaSection}
${overnightSection}
${sourceSection}
${stubsSection}

<p class="footer">
  Dashboard Operacional Diar.ia — dados locais via KV push (<code>build-diaria-dashboard-data.ts --push</code>).<br>
  Dados brutos em <a href="/api/data" style="color:var(--brand)">/api/data</a>. Schema v${data.schema_version ?? 1}.
</p>
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
