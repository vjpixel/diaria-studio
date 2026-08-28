// triagem.js (#3562) — cockpit de triagem VISUAL: issues abertas + PRs
// abertos do GitHub, filtráveis por prioridade (P0-P3), label e trilha
// (overnight/develop/other, derivada do prefixo de branch do PR). Vanilla
// JS, sem build step (mesmo princípio de app.js/edicao.js — #3555/#3558).
//
// Escopo desta fatia (#3562): READ-ONLY. Nenhum botão aqui fecha, comenta ou
// mergeia — só lista + linka pro GitHub. Este módulo lê GET /api/issues
// (studio-issues.ts, server-side cache+throttle de `gh`); todo filtro de
// issues/PRs é 100% client-side sobre o snapshot já buscado — trocar filtro
// NUNCA dispara um novo fetch.
//
// #4004: a seção de composição de onda em preview foi removida — o
// mecanismo real de disparo já tinha sido descontinuado no #3985/#3720 (2
// tentativas de validação ao vivo sem sucesso; job-to-be-done coberto pelo
// chat drawer + `/diaria-develop` digitado direto), e o preview ficou órfão
// sem a execução real por trás.

import {
  issuesFilterActive,
  prsFilterActive,
  applyDispatchTrackFilterValue,
  LOADING_MESSAGE,
  countLabel,
  classificationFilterScope,
  classificationScopeNotice,
  activeFilterSummary,
  emptyStateMessage,
} from "./triagem-filters.js";

const el = {
  fetchDot: document.getElementById("fetch-dot"),
  fetchLabel: document.getElementById("fetch-label"),
  error: document.getElementById("triage-error"),
  filterPriority: document.getElementById("filter-priority"),
  filterDispatchTrack: document.getElementById("filter-dispatch-track"),
  filterLabels: document.getElementById("filter-labels"),
  refreshBtn: document.getElementById("refresh-btn"),
  lastUpdated: document.getElementById("last-updated"),
  issuesCount: document.getElementById("issues-count"),
  issuesBody: document.getElementById("issues-tbody"),
  issuesEmpty: document.getElementById("issues-empty"),
  issuesFilterChip: document.getElementById("issues-filter-chip"),
  issuesScopeNotice: document.getElementById("issues-scope-notice"),
  prsCount: document.getElementById("prs-count"),
  prsBody: document.getElementById("prs-tbody"),
  prsEmpty: document.getElementById("prs-empty"),
  prsFilterChip: document.getElementById("prs-filter-chip"),
  prsScopeNotice: document.getElementById("prs-scope-notice"),
  dispatchTrackLegend: document.getElementById("dispatch-track-legend"),
};

/** `true` enquanto um fetch de /api/issues está em voo (#5472). Começa em
 * `true`: a página monta antes do 1º fetch voltar, e nesse intervalo os
 * contadores/tabelas não sabem de nada — mostrar `0` ali afirmaria "não há
 * nada" quando o certo é "ainda não sei". */
let loading = true;

/** Snapshot bruto da última resposta de /api/issues — filtros nunca refetcham. */
let data = { issues: [], prs: [], error: null, cached: false, generatedAt: null };

/** Estado dos filtros — 100% client-side. */
const filters = {
  priority: "",
  track: "",
  dispatch: "",
  labels: new Set(),
};

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function setFetchStatus(status, label) {
  el.fetchDot.className = "dot " + status; // "ok" | "down" | ""
  el.fetchLabel.textContent = label;
}

function labelsBadges(labels) {
  if (!labels || labels.length === 0) return "";
  return labels.map((l) => `<span class="label-chip">${escapeHtml(l)}</span>`).join(" ");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function priorityBadge(priority) {
  if (!priority) return '<span class="priority-badge priority-none">—</span>';
  return `<span class="priority-badge priority-${priority.toLowerCase()}">${priority}</span>`;
}

function trackBadge(track) {
  return `<span class="track-badge track-${track}">${track}</span>`;
}

// #3715/#5462 — vocabulário de Classificação (execTrack): rótulo + explicação
// por valor, exibidos como tooltip no badge e como legenda visível.
//
// NÃO redeclarar os valores aqui (5 desde o #5682, era 4 no #5462). Eles vêm
// do servidor em `data.execTrackUi` (montado por
// scripts/lib/issue-exec-track.ts a partir de `Record<ExecTrack, string>`,
// que quebra o build se um valor novo entrar sem rótulo). Redeclarar criava
// exatamente a 2ª fonte de verdade que o #5462 existe pra eliminar: um valor
// novo quebraria o build do servidor e passaria SILENCIOSAMENTE aqui, caindo
// no fallback sem tradução nem tooltip (achado no review do PR #5463).
//
// A ordem vem do servidor e é a de LEITURA (anda sozinho hoje → não anda
// nunca), não alfabética — ver a docstring de `EXEC_TRACK_UI` em
// issue-exec-track.ts pra por que, desde o #5682, isso não é mais o exato
// inverso da ordem de precedência do classificador.
function execTrackEntry(track) {
  return (data.execTrackUi ?? []).find((e) => e.track === track);
}

// #6200: `matched` distingue um `overnight` VERIFICADO (alguma label/marcador
// decidiu positivamente) de um `overnight` POR OMISSÃO (`matched === "default"`
// — nenhuma label disse o contrário, ninguém olhou). Os dois eram, antes
// desta issue, o MESMO badge — "fila com 2 itens" e "fila com 2 itens que
// ninguém conferiu" liam como a mesma tela. `matched` é opcional (chamadas
// sem o argumento, como a legenda em `renderDispatchTrackLegend`, nunca
// acionam o sufixo — não faz sentido marcar "sem sinal" numa entrada de
// vocabulário genérica, só numa issue real).
// Exportada (#6200) só pra ser testável diretamente — `test/triagem-badge.test.ts`
// cobre o sufixo "·sem sinal"/classe `dispatch-default` sem precisar simular
// o DOM inteiro (o guard de carga em `test/triagem-module-loads.test.ts` cobre
// só "o módulo não explode", não o conteúdo de cada célula — ver docstring
// de lá). `data`/`execTrackEntry` continuam módulo-privados: o caller de
// teste passa `execTrackUiOverride` explicitamente em vez de mutar o estado
// do módulo por fora.
export function dispatchBadge(track, matched, execTrackUiOverride) {
  const entry = execTrackUiOverride
    ? execTrackUiOverride.find((e) => e.track === track)
    : execTrackEntry(track);
  // Fallback pro valor cru só cobre a janela em que o payload ainda não
  // chegou (1º render antes do fetch); depois disso, toda variante servida
  // pelo servidor tem entrada garantida pelo Record do lib.
  const labelPt = entry?.label ?? track;
  const title = entry?.explain ?? "";
  const isDefault = matched === "default";
  const label = isDefault ? `${labelPt} ·sem sinal` : labelPt;
  const fullTitle = isDefault
    ? `${title} Nenhum sinal positivo (label/marcador) classificou esta issue — default por omissão, ninguém verificou.`
    : title;
  const cls = isDefault ? `dispatch-badge dispatch-${track} dispatch-default` : `dispatch-badge dispatch-${track}`;
  return `<span class="${cls}" title="${escapeHtml(fullTitle)}">${label}</span>`;
}

// #6436 — issue reivindicada por uma sessão coordenadora ATIVA (`data/sessions/`,
// via `claim` no payload) mostra "em andamento — {kind} {machine}" em vez de
// ficar indistinguível de uma issue genuinamente livre. Mais crítico pra
// claim da sessão `continuo` (cron de 60min, nunca fica stale por si só) —
// era exatamente essa combinação que fazia a issue parecer "Overnight sem
// sinal" pra sempre no painel, mesmo já tendo dono. `claim` ausente/null →
// string vazia (nenhum badge extra), nunca lança.
export function claimBadge(claim) {
  if (!claim) return "";
  const who = `${claim.kind}-${claim.machineTag}`;
  const title = claim.claimedAt
    ? `Reivindicada por ${who} (sessão ${claim.sessionId}) desde ${claim.claimedAt}`
    : `Reivindicada por ${who} (sessão ${claim.sessionId})`;
  // Classe por kind (28/08, pedido do editor): o trabalho do CONTINUO era
  // invisível — a issue classifica `overnight` (taxonomia certa: continuo
  // drena a fila overnight) e o kind real só existia neste badge, neutro
  // demais pra ser notado. `claim-kind-*` dá cor própria por kind; kind
  // desconhecido cai na classe base (nunca quebra).
  const kindCls = /^[a-z-]+$/.test(claim.kind) ? ` claim-kind-${claim.kind}` : "";
  return `<span class="claim-badge${kindCls}" title="${escapeHtml(title)}">em andamento — ${escapeHtml(who)}</span>`;
}

// #3874: o significado de cada valor de Classificação só existia como
// `title=` (tooltip) em cada badge da tabela — tooltip não existe em touch
// (R7 de docs/studio-ui-ux-guidelines.md). Renderiza o MESMO vocabulário
// como legenda em texto visível, 1x por página (não repetida por linha —
// poluiria a tabela), logo acima da tabela de issues. `title=` continua nos
// badges individuais, como reforço pro hover no desktop.
//
// #5462: deixou de ser estático. O vocabulário vem de `data.execTrackUi`
// (servido por /api/issues), então esta função só tem o que renderizar DEPOIS
// do fetch — por isso é chamada de `renderAll()`, não no load do módulo.
function renderDispatchTrackLegend() {
  if (!el.dispatchTrackLegend) return;
  el.dispatchTrackLegend.innerHTML = (data.execTrackUi ?? [])
    .map(({ track, explain }) => `<li><strong>${dispatchBadge(track)}</strong> — ${escapeHtml(explain)}</li>`)
    .join("");
}

function ciBadge(ciState) {
  const labelPt = { green: "verde", red: "vermelho", pending: "pendente", none: "sem checks" }[ciState] ?? ciState;
  return `<span class="ci-badge ci-${ciState}">${labelPt}</span>`;
}

function ageDays(iso, nowMs = Date.now()) {
  if (!iso) return null;
  const created = new Date(iso).getTime();
  if (Number.isNaN(created)) return null;
  return Math.max(0, Math.floor((nowMs - created) / 86_400_000));
}

function ageLabel(iso) {
  const days = ageDays(iso);
  if (days === null) return "—";
  if (days === 0) return "hoje";
  return `${days}d`;
}

/** Recalcula o conjunto de labels presentes em issues+PRs e desenha os
 * checkboxes de filtro — chamado só quando um NOVO snapshot chega (não a
 * cada mudança de filtro, pra não reconstruir/perder o estado dos checkboxes
 * marcados). */
function renderLabelFilters() {
  const allLabels = new Set();
  for (const i of data.issues) for (const l of i.labels) allLabels.add(l);
  for (const p of data.prs) for (const l of p.labels) allLabels.add(l);

  const sorted = [...allLabels].sort();
  el.filterLabels.innerHTML = "";
  for (const label of sorted) {
    const id = `label-filter-${label}`;
    const wrap = document.createElement("label");
    wrap.className = "label-filter-item";
    wrap.innerHTML = `<input type="checkbox" id="${id}" value="${escapeHtml(label)}" /> ${escapeHtml(label)}`;
    const input = wrap.querySelector("input");
    input.checked = filters.labels.has(label);
    input.addEventListener("change", () => {
      if (input.checked) filters.labels.add(label);
      else filters.labels.delete(label);
      renderTables();
    });
    el.filterLabels.appendChild(wrap);
  }
}

function matchesPriorityFilter(priority) {
  if (!filters.priority) return true;
  if (filters.priority === "none") return !priority;
  return priority === filters.priority;
}

function matchesLabelFilter(labels) {
  if (filters.labels.size === 0) return true;
  for (const wanted of filters.labels) {
    if (!labels.includes(wanted)) return false;
  }
  return true;
}

// #3874: "0 resultados para este filtro" (tabela zerou por causa de um
// filtro ativo, com dados de verdade escondidos atrás dele) é uma mensagem
// diferente de "nenhum registro ainda" (não há dado nenhum pra mostrar) —
// tabela só com cabeçalho e nada embaixo lê como bug em qualquer um dos 2
// casos (R4 de docs/studio-ui-ux-guidelines.md), então sempre existe 1 dos 2
// textos quando a lista filtrada zera. Mesmo padrão em toda tabela filtrável
// do Studio (relatorios.js é a referência original, só que sem filtro).
// #5212: a lógica dos 3 casos (sem filtro / "0 resultados" / "sem efeito"
// porque o total já era 0) mora em `emptyStateMessage` (triagem-filters.js,
// pura) — aqui só aplica o resultado ao DOM.
function updateEmptyState(emptyEl, filteredCount, totalCount, hasActiveFilter, emptyLabel, filterSummary) {
  if (!emptyEl) return;
  const message = emptyStateMessage({ filteredCount, totalCount, filterActive: hasActiveFilter, filterSummary, emptyLabel, loading });
  emptyEl.hidden = message === null;
  if (message !== null) emptyEl.textContent = message;
}

function renderIssuesTable() {
  const filtered = data.issues.filter(
    (i) =>
      matchesPriorityFilter(i.priority) &&
      matchesLabelFilter(i.labels) &&
      (!filters.dispatch || i.execTrack === filters.dispatch),
  );
  el.issuesCount.textContent = countLabel({ filteredCount: filtered.length, loading });
  updateEmptyState(
    el.issuesEmpty,
    filtered.length,
    data.issues.length,
    issuesFilterActive(filters),
    "Nenhuma issue aberta.",
    activeFilterSummary(filters, "issues"),
  );
  el.issuesBody.innerHTML = "";
  for (const i of filtered) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><a href="${i.url}" target="_blank" rel="noopener">#${i.number}</a></td>
      <td>${escapeHtml(i.title)}</td>
      <td>${dispatchBadge(i.execTrack, i.execTrackMatched)}${claimBadge(i.claim)}</td>
      <td>${priorityBadge(i.priority)}</td>
      <td>${labelsBadges(i.labels)}</td>
      <td class="mono">${ageLabel(i.createdAt)}</td>
      <td class="mono">${fmtTime(i.updatedAt)}</td>
    `;
    el.issuesBody.appendChild(tr);
  }
}

function renderPrsTable() {
  const filtered = data.prs.filter(
    (p) =>
      matchesPriorityFilter(p.priority) &&
      matchesLabelFilter(p.labels) &&
      (!filters.track || p.track === filters.track),
  );
  el.prsCount.textContent = countLabel({ filteredCount: filtered.length, loading });
  updateEmptyState(
    el.prsEmpty,
    filtered.length,
    data.prs.length,
    prsFilterActive(filters),
    "Nenhum PR aberto.",
    activeFilterSummary(filters, "prs"),
  );
  el.prsBody.innerHTML = "";
  for (const p of filtered) {
    const tr = document.createElement("tr");
    const draftTag = p.isDraft ? ' <span class="draft-tag">draft</span>' : "";
    tr.innerHTML = `
      <td><a href="${p.url}" target="_blank" rel="noopener">#${p.number}</a></td>
      <td>${escapeHtml(p.title)}${draftTag}</td>
      <td>${trackBadge(p.track)}</td>
      <td>${priorityBadge(p.priority)}</td>
      <td>${ciBadge(p.ciState)}</td>
      <td class="mono">${escapeHtml(p.reviewDecision ?? "—")}</td>
      <td>${labelsBadges(p.labels)}</td>
      <td class="mono">${fmtTime(p.updatedAt)}</td>
    `;
    el.prsBody.appendChild(tr);
  }
}

// #5212: o chip no <h2> ("Classificação: overnight") só existe na tabela
// afetada pelo filtro de Classificação atual; a tabela oposta ganha uma
// linha de aviso em texto ("Classificação (PRs) ativa — não afeta esta
// lista") — as duas leituras vêm dos MESMOS predicados puros
// (triagem-filters.js), nada duplicado aqui além de aplicar ao DOM.
function renderClassificationScopeUI() {
  const scope = classificationFilterScope(filters);
  const chipValue = scope === "issues" ? filters.dispatch : scope === "prs" ? filters.track : null;

  if (el.issuesFilterChip) {
    el.issuesFilterChip.hidden = scope !== "issues";
    el.issuesFilterChip.textContent = scope === "issues" ? `Classificação: ${chipValue}` : "";
  }
  if (el.prsFilterChip) {
    el.prsFilterChip.hidden = scope !== "prs";
    el.prsFilterChip.textContent = scope === "prs" ? `Classificação: ${chipValue}` : "";
  }
  if (el.issuesScopeNotice) {
    const notice = classificationScopeNotice(filters, "issues");
    el.issuesScopeNotice.hidden = !notice;
    el.issuesScopeNotice.textContent = notice ?? "";
  }
  if (el.prsScopeNotice) {
    const notice = classificationScopeNotice(filters, "prs");
    el.prsScopeNotice.hidden = !notice;
    el.prsScopeNotice.textContent = notice ?? "";
  }
}

function renderTables() {
  renderClassificationScopeUI();
  renderIssuesTable();
  renderPrsTable();
}

function renderError() {
  if (data.error) {
    el.error.hidden = false;
    el.error.textContent = data.cached
      ? `gh falhou nesta tentativa (mostrando o último snapshot bom): ${data.error}`
      : `gh falhou e não há cache anterior: ${data.error}`;
  } else {
    el.error.hidden = true;
  }
}

function renderAll() {
  renderLabelFilters();
  renderDispatchTrackLegend();
  renderTables();
  renderError();
  el.lastUpdated.textContent = data.generatedAt
    ? `atualizado ${fmtTime(data.generatedAt)}${data.cached ? " (cache)" : ""}`
    : "";
}

/** Teto de espera do fetch. Sem isso, um servidor que aceita a conexão e nunca
 * responde deixa a página em "carregando…" indefinidamente — trocar "parece
 * vazio" por "gira pra sempre" não seria progresso. */
const FETCH_TIMEOUT_MS = 20000;

/** Sequência monotônica de requisições. Dois fetches podem estar em voo ao
 * mesmo tempo (duplo clique em "Atualizar", ou clicar durante a carga
 * inicial), e nada garante que respondam na ordem em que saíram. Sem este
 * guard, a resposta ANTIGA que chega por último sobrescreve a nova — a tela
 * passa a mostrar dado velho como se fosse fresco, silenciosamente. */
let fetchSeq = 0;

async function fetchIssues() {
  const seq = ++fetchSeq;
  loading = true;
  setFetchStatus("", LOADING_MESSAGE);
  // Re-render ANTES do await: sem isso o estado de carregamento só apareceria
  // depois da resposta, ou seja, nunca — que é justamente o buraco relatado.
  renderAll();

  let payload = null;
  let failure = null;
  try {
    const res = await fetch("/api/issues", { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
  } catch (e) {
    failure = e;
  }

  // Resposta obsoleta: um fetch mais novo já começou. Descarta por completo —
  // não escreve `data` (sobrescreveria o mais recente) nem mexe em `loading`,
  // que agora pertence à requisição em voo, não a esta.
  if (seq !== fetchSeq) return;

  loading = false;
  if (failure) {
    setFetchStatus("down", "falha ao buscar /api/issues");
    // Preserva `execTrackUi` no caminho de falha — é vocabulário estático, e
    // perdê-lo aqui deixaria os badges sem rótulo/tooltip justamente quando a
    // página já está degradada (#5462).
    data = {
      issues: data.issues,
      prs: data.prs,
      execTrackUi: data.execTrackUi,
      error: String(failure),
      cached: true,
      generatedAt: data.generatedAt,
    };
  } else {
    data = payload;
    setFetchStatus(data.error ? "down" : "ok", data.error ? "erro no gh" : "ok");
  }
  renderAll();
}

el.filterPriority.addEventListener("change", () => {
  filters.priority = el.filterPriority.value;
  renderTables();
});
// #5175: lógica de mapeamento é pura (applyDispatchTrackFilterValue,
// triagem-filters.js) — testável sem harness de DOM; aqui só aplica o
// resultado ao objeto `filters` compartilhado e re-renderiza.
el.filterDispatchTrack.addEventListener("change", () => {
  Object.assign(filters, applyDispatchTrackFilterValue(filters, el.filterDispatchTrack.value));
  renderTables();
});
el.refreshBtn.addEventListener("click", () => fetchIssues());

fetchIssues();
