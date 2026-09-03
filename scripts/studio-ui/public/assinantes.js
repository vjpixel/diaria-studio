// assinantes.js (#6590) — busca por e-mail -> timeline unificada + coorte
// por migração. Vanilla JS, sem build step (mesmo padrão de ads.js/
// tarefas.js). READ-ONLY: nenhuma chamada de escrita nesta página, de
// propósito (decisão do editor, corpo da issue #6590).

const el = {
  fetchDot: document.getElementById("fetch-dot"),
  fetchLabel: document.getElementById("fetch-label"),
  dbStatusValue: document.getElementById("db-status-value"),
  nodataBanner: document.getElementById("nodata-banner"),

  searchForm: document.getElementById("search-form"),
  searchEmail: document.getElementById("search-email"),
  searchEmpty: document.getElementById("search-empty"),
  searchResults: document.getElementById("search-results"),

  refreshCohortBtn: document.getElementById("refresh-cohort-btn"),
  floorNote: document.getElementById("floor-note"),
  byPlatform: document.getElementById("cohort-by-platform"),
  migrationsTbody: document.getElementById("migrations-tbody"),
  migrationsEmpty: document.getElementById("migrations-empty"),
  reactivationStat: document.getElementById("reactivation-stat"),
  unmatchedSummary: document.getElementById("unmatched-summary"),
  attributeCoverageTbody: document.getElementById("attribute-coverage-tbody"),
  attributeCoverageEmpty: document.getElementById("attribute-coverage-empty"),
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setFetchStatus(status, label) {
  el.fetchDot.className = "dot " + status; // "ok" | "down" | ""
  el.fetchLabel.textContent = label;
}

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function tile(label, value) {
  return `<div class="assinantes-tile"><div class="assinantes-tile-label">${escapeHtml(label)}</div><div class="assinantes-tile-value">${escapeHtml(String(value))}</div></div>`;
}

function platformBadge(platform) {
  return `<span class="assinantes-platform-badge">${escapeHtml(platform)}</span>`;
}

// ─── busca por e-mail ────────────────────────────────────────────────────

function subscriberCardHtml(sub) {
  const platforms = [...new Set(sub.aliases.map((a) => a.platform))];
  const leitorLabel = sub.leitor.isLeitor
    ? `<span class="assinantes-leitor-yes">✔ leitor-v1</span>`
    : `não é leitor-v1 (recebidas=${sub.leitor.input.totalReceived}, cliques únicos=${sub.leitor.input.totalUniqueClicked}, status=${escapeHtml(sub.leitor.input.status)})`;

  const timelineRows = sub.timeline
    .map(
      (ev) => `
      <tr>
        <td>${fmtTime(ev.ts)}</td>
        <td>${platformBadge(ev.platform)}</td>
        <td>${escapeHtml(ev.type)}</td>
        <td>${ev.edicao ? escapeHtml(ev.edicao) : "—"}</td>
        <td class="reachable-subtext">${ev.url ? escapeHtml(ev.url) : "—"}</td>
      </tr>`,
    )
    .join("");

  const subsRows = sub.subscriptions
    .map(
      (s) => `
      <tr>
        <td>${platformBadge(s.platform)}</td>
        <td>${escapeHtml(s.status ?? "—")}</td>
        <td>${fmtTime(s.entered_at)}</td>
        <td>${fmtTime(s.exited_at)}</td>
        <td class="reachable-subtext">${escapeHtml(s.source ?? "—")}</td>
      </tr>`,
    )
    .join("");

  // #7202 — apoio_nivel, survey, poll_sig, etc. Atributo ausente não aparece
  // como linha (ver getAttributesForSubscriber) — "sem atributos" é a lista
  // vazia mesmo, nunca uma linha fabricada.
  const attrRows = (sub.attributes ?? [])
    .map(
      (a) => `
      <tr>
        <td>${platformBadge(a.platform)}</td>
        <td>${escapeHtml(a.key)}</td>
        <td>${escapeHtml(a.value)}</td>
      </tr>`,
    )
    .join("");

  return `
    <div class="assinantes-subscriber-card">
      <div class="assinantes-subscriber-header">
        <h3>subscriber #${sub.subscriberId}</h3>
        ${platforms.map(platformBadge).join(" ")}
        <span>${leitorLabel}</span>
      </div>
      <div class="table-scroll">
        <table class="triage-table">
          <thead><tr><th>Plataforma</th><th>Status</th><th>Entrou</th><th>Saiu</th><th>Origem</th></tr></thead>
          <tbody>${subsRows}</tbody>
        </table>
      </div>
      <h4>Timeline (${sub.timeline.length} evento(s))</h4>
      <div class="table-scroll">
        <table class="triage-table">
          <thead><tr><th>Quando</th><th>Plataforma</th><th>Tipo</th><th>Edição</th><th>URL</th></tr></thead>
          <tbody>${timelineRows || `<tr><td colspan="5" class="hint">sem eventos</td></tr>`}</tbody>
        </table>
      </div>
      <h4>Atributos (${(sub.attributes ?? []).length})</h4>
      <div class="table-scroll">
        <table class="triage-table">
          <thead><tr><th>Plataforma</th><th>Chave</th><th>Valor</th></tr></thead>
          <tbody>${attrRows || `<tr><td colspan="3" class="hint">sem atributos declarados</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
}

async function runSearch(email) {
  el.searchResults.innerHTML = "";
  el.searchEmpty.hidden = true;
  if (!email) return;

  try {
    const res = await fetch(`/api/subscribers/search?email=${encodeURIComponent(email)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (!data.db.available) {
      el.nodataBanner.hidden = false;
      return;
    }
    el.nodataBanner.hidden = true;

    if (data.subscribers.length === 0) {
      el.searchEmpty.hidden = false;
      return;
    }

    let html = "";
    if (data.subscribers.length > 1) {
      html += `<p class="assinantes-multi-warning">⚠ ${data.subscribers.length} registros distintos pra este e-mail — identidade ainda não resolvida cross-plataforma (#6589), ou são pessoas genuinamente diferentes. Nunca fundidos automaticamente.</p>`;
    }
    html += data.subscribers.map(subscriberCardHtml).join("");
    el.searchResults.innerHTML = html;
  } catch (e) {
    el.searchResults.innerHTML = `<div class="panel alert-banner" role="alert">Falha ao buscar: ${escapeHtml(e.message)}</div>`;
  }
}

el.searchForm.addEventListener("submit", (evt) => {
  evt.preventDefault();
  runSearch(el.searchEmail.value.trim());
});

// ─── coorte por migração ─────────────────────────────────────────────────

function renderByPlatform(byPlatform) {
  el.byPlatform.innerHTML = byPlatform.map((p) => tile(p.platform, p.total)).join("");
}

function renderMigrations(migrations) {
  el.migrationsTbody.innerHTML = "";
  if (migrations.length === 0) {
    el.migrationsEmpty.hidden = false;
    return;
  }
  el.migrationsEmpty.hidden = true;
  el.migrationsTbody.innerHTML = migrations
    .map(
      (m) => `<tr><td>${platformBadge(m.a)}</td><td>${platformBadge(m.b)}</td><td class="mono">${m.count}</td></tr>`,
    )
    .join("");
}

function renderUnmatched(unmatched) {
  if (!unmatched) {
    el.unmatchedSummary.innerHTML = `<p class="hint">sem dados</p>`;
    return;
  }
  const rows = unmatched.by_platform
    .map(
      (p) =>
        `<tr><td>${platformBadge(p.platform)}</td><td class="mono">${p.total_subscribers}</td><td class="mono">${p.unmatched_subscribers}</td></tr>`,
    )
    .join("");
  el.unmatchedSummary.innerHTML = `
    <p class="hint">${unmatched.matched_subscribers} casados (2+ plataformas) · ${unmatched.unmatched_subscribers} não-casados (1 só plataforma), de ${unmatched.total_subscribers} subscribers no total.</p>
    <div class="table-scroll">
      <table class="triage-table">
        <thead><tr><th>Plataforma</th><th>Total</th><th>Não-casados</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderAttributeCoverage(attributeCoverage) {
  el.attributeCoverageTbody.innerHTML = "";
  if (!attributeCoverage || attributeCoverage.length === 0) {
    el.attributeCoverageEmpty.hidden = false;
    return;
  }
  el.attributeCoverageEmpty.hidden = true;
  el.attributeCoverageTbody.innerHTML = attributeCoverage
    .map((c) => {
      const pct = c.subscribersOnPlatform > 0 ? (100 * c.withAttribute) / c.subscribersOnPlatform : 0;
      return `<tr><td>${platformBadge(c.platform)}</td><td>${escapeHtml(c.key)}</td><td class="mono">${c.withAttribute}</td><td class="mono">${c.subscribersOnPlatform}</td><td class="mono">${pct.toFixed(1)}%</td></tr>`;
    })
    .join("");
}

async function refreshCohort() {
  setFetchStatus("", "carregando…");
  try {
    const res = await fetch("/api/subscribers/cohort");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    el.dbStatusValue.textContent = data.db.available ? "store disponível" : "sem store";

    if (!data.db.available) {
      el.nodataBanner.hidden = false;
      setFetchStatus("down", "sem dados");
      return;
    }
    el.nodataBanner.hidden = true;

    // Critério de pronto explícito da #6590: a margem de não-casados
    // aparece NA TELA, não só em texto de ajuda — banner sempre visível
    // (nunca condicional a haver dado ou não).
    el.floorNote.hidden = false;
    el.floorNote.textContent = "⚠ " + data.note;

    renderByPlatform(data.byPlatform);
    renderMigrations(data.migrations);
    el.reactivationStat.textContent = `${data.reactivation.count} assinante(s) — ${data.reactivation.note}`;
    renderUnmatched(data.unmatched);
    renderAttributeCoverage(data.attributeCoverage);

    setFetchStatus("ok", `${data.totalSubscribers} subscriber(s) no store`);
  } catch (e) {
    setFetchStatus("down", "erro");
    el.floorNote.hidden = true;
    el.byPlatform.innerHTML = `<div class="panel alert-banner" role="alert">Falha ao carregar coorte: ${escapeHtml(e.message)}</div>`;
  }
}

el.refreshCohortBtn.addEventListener("click", refreshCohort);

refreshCohort();
