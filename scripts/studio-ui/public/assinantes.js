// assinantes.js (#6590) — busca por e-mail -> timeline unificada + coorte
// por migração. Vanilla JS, sem build step (mesmo padrão de ads.js/
// tarefas.js). READ-ONLY: nenhuma escrita em assinante ou em ESP, de
// propósito (decisão do editor, corpo da issue #6590). O único POST
// (`/api/onboarding/funnel/refresh-brevo`) só faz GET de campanhas na Brevo
// e devolve o snapshot; não cria, agenda nem cancela nada.
//
// #10606 (revisão do editor, 20/10/2026): o topo da página mostra o que pede
// ação, com a ação ao lado (assinantes-actions.js, lógica pura e testada); o
// contexto sem ação vive no <details> "Detalhes".

import { escapeHtml, actionItemsHtml, panelState, stageBreakdownRows } from "./assinantes-actions.js";

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

  cohortOrigemFilterForm: document.getElementById("cohort-origem-filter-form"),
  cohortOrigemFrom: document.getElementById("cohort-origem-from"),
  cohortOrigemTo: document.getElementById("cohort-origem-to"),
  cohortOrigemConfirmationNote: document.getElementById("cohort-origem-confirmation-note"),
  cohortOrigemGap: document.getElementById("cohort-origem-gap"),
  cohortOrigemTbody: document.getElementById("cohort-origem-tbody"),
  cohortOrigemEmpty: document.getElementById("cohort-origem-empty"),

  refreshOnboardingBtn: document.getElementById("refresh-onboarding-btn"),
  onboardingNodata: document.getElementById("onboarding-nodata"),
  acoesList: document.getElementById("acoes-list"),
  acoesEmpty: document.getElementById("acoes-empty"),
  onboardingLoadError: document.getElementById("onboarding-load-error"),
  staleBlock: document.getElementById("stale-block"),
  onboardingNote: document.getElementById("onboarding-note"),
  onboardingStageTbody: document.getElementById("onboarding-stage-tbody"),
  refreshOnboardingDetailsBtn: document.getElementById("refresh-onboarding-details-btn"),
  onboardingCohortSummary: document.getElementById("onboarding-cohort-summary"),
  onboardingStaleTbody: document.getElementById("onboarding-stale-tbody"),
  onboardingKitRun: document.getElementById("onboarding-kit-run"),
  onboardingKitLotsTbody: document.getElementById("onboarding-kit-lots-tbody"),
  onboardingKitLotsEmpty: document.getElementById("onboarding-kit-lots-empty"),
  onboardingKitPilot: document.getElementById("onboarding-kit-pilot"),
  onboardingFollowupBlocked: document.getElementById("onboarding-followup-blocked"),
  onboardingStepsTbody: document.getElementById("onboarding-steps-tbody"),
  onboardingPeopleNaoApoia: document.getElementById("onboarding-people-nao-apoia"),
  onboardingPeopleSort: document.getElementById("onboarding-people-sort"),
  onboardingPeopleCount: document.getElementById("onboarding-people-count"),
  onboardingPeopleTbody: document.getElementById("onboarding-people-tbody"),
};

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

// ---------------------------------------------------------------------------
// Coorte de aquisição por origem (#7916, fatia 2/N)
// ---------------------------------------------------------------------------

function renderCohortOrigem(rows) {
  if (rows.length === 0) {
    el.cohortOrigemEmpty.hidden = false;
    el.cohortOrigemTbody.innerHTML = "";
    return;
  }
  el.cohortOrigemEmpty.hidden = true;
  el.cohortOrigemTbody.innerHTML = rows
    .map((r) => {
      const confirmed = r.confirmedKit == null ? "—" : String(r.confirmedKit);
      const unconfirmed = r.unconfirmedKit == null ? "—" : String(r.unconfirmedKit);
      return `<tr><td class="mono">${escapeHtml(r.day)}</td><td>${escapeHtml(r.utmSource ?? "(nenhum)")}</td><td>${escapeHtml(r.acquisitionClass)}</td><td class="mono">${r.total}</td><td class="mono">${confirmed}</td><td class="mono">${unconfirmed}</td></tr>`;
    })
    .join("");
}

async function refreshCohortOrigem() {
  const params = new URLSearchParams();
  if (el.cohortOrigemFrom.value) params.set("from", el.cohortOrigemFrom.value);
  if (el.cohortOrigemTo.value) params.set("to", el.cohortOrigemTo.value);
  const qs = params.toString();
  try {
    const res = await fetch(`/api/subscribers/cohort-origem${qs ? `?${qs}` : ""}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    el.cohortOrigemConfirmationNote.textContent = data.confirmationNote;

    if (!data.db.available) {
      el.cohortOrigemGap.hidden = false;
      el.cohortOrigemGap.textContent = "Sem dados — store indisponível nesta sessão.";
      renderCohortOrigem([]);
      return;
    }

    const gapParts = [];
    if (data.subscribersWithoutEnteredAt > 0) {
      gapParts.push(`${data.subscribersWithoutEnteredAt} sem data de cadastro conhecida`);
    }
    if (data.subscribersWithInvalidEnteredAt > 0) {
      gapParts.push(`${data.subscribersWithInvalidEnteredAt} com data de cadastro corrompida`);
    }
    if (gapParts.length > 0) {
      el.cohortOrigemGap.hidden = false;
      el.cohortOrigemGap.textContent = `⚠ ${gapParts.join(" + ")} — não entram nesta tabela.`;
    } else {
      el.cohortOrigemGap.hidden = true;
    }

    renderCohortOrigem(data.rows);
  } catch (e) {
    el.cohortOrigemTbody.innerHTML = "";
    el.cohortOrigemGap.hidden = false;
    el.cohortOrigemGap.textContent = `Falha ao carregar coorte de origem: ${e.message}`;
  }
}

el.cohortOrigemFilterForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  refreshCohortOrigem();
});

// ---------------------------------------------------------------------------
// #7917 — funil de onboarding até o convite de apoio (D+10)
// ---------------------------------------------------------------------------

// #10606: os 13 cartões por estágio do e-mail 3 e os 4 cartões "e-mails 1/2
// por transporte" saíram da página. O detalhamento por estágio virou uma
// tabela só com os estágios > 0 em Detalhes > Convite de apoio; o que pede
// ação (falha de consulta, estado ambíguo) virou item do bloco do topo.

// Topo da página: decisão inteira em panelState (assinantes-actions.js, puro
// e testado) — aqui só aplica no DOM.
function applyPanelState(state) {
  el.acoesList.innerHTML = actionItemsHtml(state.items);
  el.acoesEmpty.hidden = state.emptyHidden;
  el.onboardingNodata.hidden = state.nodataHidden;
  el.onboardingLoadError.hidden = state.loadErrorText == null;
  el.onboardingLoadError.textContent = state.loadErrorText ?? "";
  el.staleBlock.hidden = state.staleRows.length === 0;
  el.onboardingStaleTbody.innerHTML = state.staleRows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.email)}</td><td>${escapeHtml(r.provider)}</td><td class="mono">${escapeHtml(r.idade)}</td><td class="mono">${escapeHtml(r.campanha)}</td><td>${escapeHtml(r.acao)}</td></tr>`,
    )
    .join("");
}

function renderStageBreakdown(byEmail3Stage) {
  el.onboardingStageTbody.innerHTML = stageBreakdownRows(byEmail3Stage)
    .map((r) => `<tr><td>${escapeHtml(r.label)}</td><td class="mono">${r.count}</td></tr>`)
    .join("");
}

function renderOnboardingCohortSummary(cohort) {
  if (!cohort) {
    el.onboardingCohortSummary.innerHTML = "";
    return;
  }
  const cliques = cohort.cliquesRastreados == null ? "não rastreado" : String(cohort.cliquesRastreados);
  const apoios = cohort.semIndiceApoiador ? "sem dado (apoia.se indisponível)" : String(cohort.primeirosApoiosConfirmados);
  el.onboardingCohortSummary.innerHTML = [
    tile("Elegíveis (D+10 vencido)", cohort.elegiveis),
    tile("Convites criados", cohort.convitesCriados),
    tile("Convites enviados", cohort.convitesEnviados),
    tile("Cliques no convite", cliques),
    tile("1º apoio confirmado", apoios),
  ].join("");
}

// #7922 — lotes Kit (produção e piloto separados), em Detalhes desde #10606.
const KIT_LOT_STATUS_LABELS = {
  pending: "Pendente (sem broadcast confirmado)",
  created: "Rascunho criado",
  scheduled: "Agendado",
  completed: "Enviado",
  cancelled: "Cancelado",
};

function kitLotRow(l) {
  const status = KIT_LOT_STATUS_LABELS[l.status] ?? l.status;
  const broadcast = l.broadcastId == null ? "—" : String(l.broadcastId);
  const erro = l.lastError ? escapeHtml(l.lastError) : "—";
  return `<tr><td class="mono">${escapeHtml(l.lotId)}</td><td>${escapeHtml(l.kind)}</td><td>${escapeHtml(status)}</td><td class="mono">${l.recipients}</td><td class="mono">${escapeHtml(broadcast)}</td><td class="mono">${escapeHtml(l.createdAt)}</td><td>${erro}</td></tr>`;
}

function renderOnboardingKitLots(kitLots) {
  if (!kitLots) {
    el.onboardingKitRun.textContent = "";
    el.onboardingKitLotsTbody.innerHTML = "";
    el.onboardingKitLotsEmpty.hidden = true;
    el.onboardingKitPilot.hidden = true;
    return;
  }
  const run = kitLots.lastSendRun;
  el.onboardingKitRun.textContent = run
    ? `Última rodada --send do executor Kit: ${run.at} — ${run.lots_created} lote(s) criado(s), ${run.lots_failed} com falha` +
      (run.refresh_failed ? `, refresh falhou (erro de transporte) em ${run.refresh_failed} de ${run.refresh_candidates ?? "?"} candidato(s)` : "") +
      (run.content_skipped ? `, ${run.content_skipped} barrado(s) por snippet ausente/pendente` : "") +
      (run.aborted ? ` — ABORTADA (${run.error ?? "sem motivo"})` : "") +
      (kitLots.consecutiveFailedSendRuns > 0 ? ` (${kitLots.consecutiveFailedSendRuns} rodada(s) seguida(s) com falha)` : "") + "."
    : "Executor Kit sem rodada --send registrada (kill switch desligado, ou só dry-run até agora).";
  if (kitLots.production.length === 0) {
    el.onboardingKitLotsTbody.innerHTML = "";
    el.onboardingKitLotsEmpty.hidden = false;
  } else {
    el.onboardingKitLotsEmpty.hidden = true;
    el.onboardingKitLotsTbody.innerHTML = kitLots.production.map(kitLotRow).join("");
  }
  if (kitLots.pilot.length > 0 || kitLots.pilotEntriesExcluded > 0) {
    el.onboardingKitPilot.hidden = false;
    el.onboardingKitPilot.textContent =
      `Piloto (fora do funil de produção): ${kitLots.pilot.length} lote(s) onboarding-pilot-*` +
      ` [${kitLots.pilot.map((l) => `${l.lotId}: ${KIT_LOT_STATUS_LABELS[l.status] ?? l.status}`).join("; ")}],` +
      ` ${kitLots.pilotEntriesExcluded} entrada(s) sintética(s) excluída(s).`;
  } else {
    el.onboardingKitPilot.hidden = true;
  }
}

// #10606 — contagem por e-mail e tabela por pessoa (e-mail já vem MASCARADO
// do servidor), ambas em Detalhes. A falha em destaque vai pro bloco de ação.
const FOLLOWUP_MOTIVO_LABELS = {
  aguardando_confirmacao: "aguardando confirmação",
  na_fila: "na fila",
  d3_nao_venceu_ou_na_fila: "D+3 não venceu / na fila",
  d10_nao_venceu_ou_na_fila: "D+10 não venceu / na fila",
  lote_kit_nao_confirmado: "lote Kit não confirmado",
  rascunho_brevo_sem_envio_confirmado: "rascunho Brevo (pré-#10603), envio não confirmado",
  vencida: "janela passou (base anterior ou envio travado)",
  espacamento: "adiado (espaçamento entre apoio e formulário)",
  apoia: "já apoia",
  nao_ativo: "não ativo",
  consulta_falhou: "consulta ao Kit falhou",
  acima_do_teto: "acima do teto do lote",
  adiado_teto: "adiado (teto do lote — sai nos próximos dias)",
  ja_em_lote: "já em lote confirmado",
};

function motivosHtml(rec) {
  const parts = Object.entries(rec ?? {}).map(([k, n]) => {
    const label = FOLLOWUP_MOTIVO_LABELS[k] ?? (k.startsWith("bloqueado_") ? `travado (${k.slice(10)})` : k);
    return `${escapeHtml(label)}: ${n}`;
  });
  return parts.length ? parts.join("<br>") : "—";
}

let onboardingPeople = [];

function renderOnboardingPeople() {
  let rows = onboardingPeople.slice();
  if (el.onboardingPeopleNaoApoia.checked) rows = rows.filter((r) => r.apoia !== true);
  const sort = el.onboardingPeopleSort.value;
  rows.sort((a, b) =>
    sort === "form" ? b.formRecebidos - a.formRecebidos : sort === "cadastro" ? (b.cadastroAt ?? "").localeCompare(a.cadastroAt ?? "") : b.apoioRecebidos - a.apoioRecebidos,
  );
  const shown = rows.slice(0, 500);
  el.onboardingPeopleCount.textContent = `${rows.length} pessoa(s)${rows.length > shown.length ? ` — mostrando as ${shown.length} primeiras` : ""}.`;
  const yesNo = (v) => (v == null ? "sem dado" : v ? "sim" : "não");
  el.onboardingPeopleTbody.innerHTML = shown
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.emailMasked)}</td><td>${fmtTime(r.cadastroAt)}</td><td class="mono">${r.apoioRecebidos}</td><td class="mono">${r.formRecebidos}</td><td>${r.preencheu ? "sim" : "não"}</td><td>${yesNo(r.apoia)}</td></tr>`,
    )
    .join("");
}

function renderOnboardingFollowup(followup) {
  if (!followup) {
    el.onboardingFollowupBlocked.hidden = true;
    el.onboardingStepsTbody.innerHTML = "";
    onboardingPeople = [];
    renderOnboardingPeople();
    return;
  }
  const blocked = [];
  if (followup.blocked.apoio) blocked.push(`Apoio D+30/90/180/360 travado: ${followup.blocked.apoio.detalhe}`);
  if (followup.blocked.form) blocked.push(`Formulário travado: ${followup.blocked.form.detalhe}`);
  el.onboardingFollowupBlocked.hidden = blocked.length === 0 && followup.lastRunAt != null;
  el.onboardingFollowupBlocked.textContent =
    followup.lastRunAt == null ? "Executor das sequências de apoio/formulário ainda sem rodada registrada." : blocked.join(" · ");
  el.onboardingStepsTbody.innerHTML = followup.steps
    .map(
      (s) =>
        `<tr><td>${escapeHtml(s.label)}</td><td class="mono">${s.recebidos}</td><td class="mono">${s.porTransporte.kit}</td><td class="mono">${s.porTransporte.brevo}</td><td>${motivosHtml(s.pendentes)}</td><td>${motivosHtml(s.pulados)}</td><td class="mono">${s.falhos}</td></tr>`,
    )
    .join("");
  onboardingPeople = followup.people;
  renderOnboardingPeople();
}

el.onboardingPeopleNaoApoia.addEventListener("change", renderOnboardingPeople);
el.onboardingPeopleSort.addEventListener("change", renderOnboardingPeople);

function renderOnboardingData(data) {
  // #7917 item 1 (fleet review PR #8955): `db.corrupted` é distinto de
  // "sem dados" — um store.json presente mas ilegível NUNCA deve renderizar
  // como onboarding vazio (`onboarding-nodata`), que o editor leria como
  // "nenhuma rodada rodou ainda".
  // Desde #10606 o store corrompido é um item do bloco de ação, com o que
  // fazer ao lado — continua nunca virando "nada pedindo ação" nem "sem
  // dados" (panelState).
  lastOnboardingData = data;
  applyPanelState(panelState({ data }));
  if (data.db.corrupted || !data.db.available) {
    renderOnboardingCohortSummary(null);
    renderStageBreakdown(null);
    renderOnboardingKitLots(null);
    renderOnboardingFollowup(null);
    return;
  }
  el.onboardingNote.textContent = data.note;
  renderOnboardingCohortSummary(data.summary.cohort);
  renderStageBreakdown(data.summary.byEmail3Stage);
  renderOnboardingKitLots(data.kitLots);
  renderOnboardingFollowup(data.followup);
}

// Último payload bom: numa falha de refresh, o topo segue mostrando a lista
// anterior (ainda válida) junto do erro.
let lastOnboardingData = null;

async function loadOnboarding() {
  try {
    const res = await fetch("/api/onboarding/funnel");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderOnboardingData(await res.json());
  } catch (e) {
    // Falha de carga fica no TOPO: sem o funil, o bloco de ação não sabe
    // dizer se há algo a fazer.
    applyPanelState(panelState({ loadError: e.message }));
  }
}

function refreshButtons() {
  return [el.refreshOnboardingBtn, el.refreshOnboardingDetailsBtn, ...el.acoesList.querySelectorAll('[data-action="refresh-brevo"]')];
}

// Três pontos de entrada pro mesmo POST (bloco de rascunhos parados, item
// "Consulta à Brevo falhou" e Detalhes > Convite de apoio). Só consulta
// campanhas BREVO do e-mail 3 ainda em rascunho local; lotes Kit não mudam.
async function refreshOnboardingViaBrevo() {
  for (const b of refreshButtons()) {
    b.disabled = true;
    b.textContent = "Consultando a Brevo…";
  }
  try {
    const res = await fetch("/api/onboarding/funnel/refresh-brevo", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderOnboardingData(await res.json());
  } catch (e) {
    applyPanelState(panelState({ data: lastOnboardingData, refreshError: e.message }));
  } finally {
    for (const b of refreshButtons()) {
      b.disabled = false;
      b.textContent = "Reconsultar a Brevo";
    }
  }
}

el.refreshOnboardingBtn.addEventListener("click", refreshOnboardingViaBrevo);
el.refreshOnboardingDetailsBtn.addEventListener("click", refreshOnboardingViaBrevo);
el.acoesList.addEventListener("click", (ev) => {
  const btn = ev.target instanceof Element ? ev.target.closest('[data-action="refresh-brevo"]') : null;
  if (btn) refreshOnboardingViaBrevo();
});

refreshCohort();
refreshCohortOrigem();
loadOnboarding();
