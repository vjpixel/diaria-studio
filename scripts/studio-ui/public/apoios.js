// apoios.js (#3602) — CRM simples de apoios apoia.se: base de contatos +
// status cruzado (apoiando/não apoia/apoiou e parou, via checkBacker) +
// tracking de outreach + visão de campanha. Vanilla JS, sem build step
// (mesmo princípio de triagem.js/app.js — #3555/#3562).
//
// Toda mutação (adicionar contato, editar, registrar outreach) chama
// POST/PUT /api/apoios/contacts[...] (studio-apoios.ts) e depois refaz o
// fetch completo de /api/apoios — sem estado otimista client-side, mais
// simples e sempre consistente com o servidor (fonte única de verdade é o
// contacts.jsonl).

const el = {
  fetchDot: document.getElementById("fetch-dot"),
  fetchLabel: document.getElementById("fetch-label"),
  error: document.getElementById("apoios-error"),
  tileTotal: document.getElementById("tile-total"),
  tileContacted: document.getElementById("tile-contacted"),
  tileConverted: document.getElementById("tile-converted"),
  tileValue: document.getElementById("tile-value"),
  tileFollowups: document.getElementById("tile-followups"),
  followupsCount: document.getElementById("followups-count"),
  followupsList: document.getElementById("followups-list"),
  addForm: document.getElementById("add-contact-form"),
  newName: document.getElementById("new-name"),
  newEmails: document.getElementById("new-emails"),
  newCircle: document.getElementById("new-circle"),
  newNotes: document.getElementById("new-notes"),
  addError: document.getElementById("add-contact-error"),
  contactsCount: document.getElementById("contacts-count"),
  filterStatus: document.getElementById("filter-status"),
  refreshBtn: document.getElementById("refresh-btn"),
  lastUpdated: document.getElementById("last-updated"),
  contactsList: document.getElementById("contacts-list"),
  editDialog: document.getElementById("edit-dialog"),
  editForm: document.getElementById("edit-contact-form"),
  editId: document.getElementById("edit-id"),
  editName: document.getElementById("edit-name"),
  editEmails: document.getElementById("edit-emails"),
  editCircle: document.getElementById("edit-circle"),
  editNotes: document.getElementById("edit-notes"),
  editError: document.getElementById("edit-contact-error"),
  editCancelBtn: document.getElementById("edit-cancel-btn"),
  outreachDialog: document.getElementById("outreach-dialog"),
  outreachForm: document.getElementById("outreach-form"),
  outreachId: document.getElementById("outreach-id"),
  outreachDate: document.getElementById("outreach-date"),
  outreachChannel: document.getElementById("outreach-channel"),
  outreachResponded: document.getElementById("outreach-responded"),
  outreachFollowup: document.getElementById("outreach-followup"),
  outreachNote: document.getElementById("outreach-note"),
  outreachError: document.getElementById("outreach-error"),
  outreachCancelBtn: document.getElementById("outreach-cancel-btn"),
};

/** Snapshot bruto da última resposta de /api/apoios. */
let data = { contacts: [], campaign: null, pendingFollowups: [], error: null, generatedAt: null };

const filters = { status: "" };

const STATUS_LABEL = {
  apoiando: "apoiando",
  nao_apoia: "não apoia",
  apoiou_e_parou: "apoiou e parou",
  sem_dados: "sem dados",
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
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function fmtBRL(value) {
  try {
    return value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    return String(value);
  }
}

function statusBadge(status) {
  const label = STATUS_LABEL[status.label] ?? status.label;
  let extra = "";
  if (status.label === "apoiando" && typeof status.monthlyValue === "number") {
    extra = ` (R$${fmtBRL(status.monthlyValue)}/mês)`;
  }
  if (status.label === "apoiou_e_parou" && status.lastPaidMonth) {
    extra = ` (até ${escapeHtml(status.lastPaidMonth)})`;
  }
  return `<span class="status-badge status-${status.label}">${escapeHtml(label)}${extra}</span>`;
}

function renderError() {
  if (data.error) {
    el.error.hidden = false;
    el.error.textContent = `apoia.se: ${data.error}`;
  } else {
    el.error.hidden = true;
  }
}

function renderTiles() {
  const c = data.campaign ?? { totalContacts: 0, totalContacted: 0, totalConverted: 0, monthlyValueSum: 0, pendingFollowupsCount: 0 };
  el.tileTotal.textContent = String(c.totalContacts);
  el.tileContacted.textContent = String(c.totalContacted);
  el.tileConverted.textContent = String(c.totalConverted);
  el.tileValue.textContent = fmtBRL(c.monthlyValueSum ?? 0);
  el.tileFollowups.textContent = String(c.pendingFollowupsCount);
}

function renderFollowups() {
  const list = data.pendingFollowups ?? [];
  el.followupsCount.textContent = String(list.length);
  el.followupsList.innerHTML = "";
  if (list.length === 0) {
    el.followupsList.innerHTML = '<li class="followups-empty">Nenhum follow-up pendente.</li>';
    return;
  }
  for (const f of list) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="fu-name">${escapeHtml(f.name)}</span>
      <span class="fu-meta">${escapeHtml(f.circle || "—")} · último contato ${escapeHtml(f.lastOutreachDate)} via ${escapeHtml(f.lastOutreachChannel)}</span>
    `;
    el.followupsList.appendChild(li);
  }
}

function matchesFilter(contact) {
  if (!filters.status) return true;
  return contact.status.label === filters.status;
}

function renderContacts() {
  const filtered = data.contacts.filter(matchesFilter);
  el.contactsCount.textContent = String(filtered.length);
  el.contactsList.innerHTML = "";
  for (const c of filtered) {
    const card = document.createElement("div");
    card.className = "contact-card";
    const lastOutreach = c.outreach.length > 0 ? c.outreach[c.outreach.length - 1] : null;
    const followupTag = lastOutreach && lastOutreach.followupPending ? '<span class="followup-tag">follow-up pendente</span>' : "";
    card.innerHTML = `
      <div class="contact-card-head">
        <span class="contact-name">${escapeHtml(c.name)}</span>
        ${statusBadge(c.status)}
        ${followupTag}
        <span class="contact-circle">${escapeHtml(c.circle || "—")}</span>
      </div>
      <div class="contact-emails">${c.emails.map(escapeHtml).join(", ")}</div>
      ${c.notes ? `<div class="contact-notes">${escapeHtml(c.notes)}</div>` : ""}
      <div class="contact-outreach">
        ${c.outreach.length === 0 ? "sem outreach registrado" : `${c.outreach.length} outreach(es) — último em ${escapeHtml(lastOutreach.date)} via ${escapeHtml(lastOutreach.channel)}${lastOutreach.responded ? " (respondeu)" : ""}`}
      </div>
      <div class="contact-actions">
        <button type="button" data-action="edit" data-id="${escapeHtml(c.id)}">Editar</button>
        <button type="button" data-action="outreach" data-id="${escapeHtml(c.id)}">Registrar outreach</button>
      </div>
    `;
    el.contactsList.appendChild(card);
  }
}

function renderAll() {
  renderError();
  renderTiles();
  renderFollowups();
  renderContacts();
  el.lastUpdated.textContent = data.generatedAt ? `atualizado ${fmtTime(data.generatedAt)}` : "";
}

async function fetchApoios() {
  setFetchStatus("", "carregando…");
  try {
    const res = await fetch("/api/apoios");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    setFetchStatus(data.error ? "down" : "ok", data.error ? "erro apoia.se" : "ok");
  } catch (e) {
    setFetchStatus("down", "falha ao buscar /api/apoios");
    data = { ...data, error: String(e) };
  }
  renderAll();
}

function parseEmailsInput(raw) {
  return raw
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

el.refreshBtn.addEventListener("click", () => fetchApoios());
el.filterStatus.addEventListener("change", () => {
  filters.status = el.filterStatus.value;
  renderContacts();
});

el.addForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  el.addError.hidden = true;
  const body = {
    name: el.newName.value,
    emails: parseEmailsInput(el.newEmails.value),
    circle: el.newCircle.value,
    notes: el.newNotes.value,
  };
  try {
    const res = await fetch("/api/apoios/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error(result.error ?? `HTTP ${res.status}`);
    el.addForm.reset();
    await fetchApoios();
  } catch (e) {
    el.addError.hidden = false;
    el.addError.textContent = String(e.message ?? e);
  }
});

el.contactsList.addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.dataset.id;
  const contact = data.contacts.find((c) => c.id === id);
  if (!contact) return;
  if (btn.dataset.action === "edit") openEditDialog(contact);
  if (btn.dataset.action === "outreach") openOutreachDialog(contact);
});

function openEditDialog(contact) {
  el.editError.hidden = true;
  el.editId.value = contact.id;
  el.editName.value = contact.name;
  el.editEmails.value = contact.emails.join(", ");
  el.editCircle.value = contact.circle;
  el.editNotes.value = contact.notes;
  el.editDialog.showModal();
}

el.editCancelBtn.addEventListener("click", () => el.editDialog.close());

el.editForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  el.editError.hidden = true;
  const id = el.editId.value;
  const body = {
    name: el.editName.value,
    emails: parseEmailsInput(el.editEmails.value),
    circle: el.editCircle.value,
    notes: el.editNotes.value,
  };
  try {
    const res = await fetch(`/api/apoios/contacts/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error(result.error ?? `HTTP ${res.status}`);
    el.editDialog.close();
    await fetchApoios();
  } catch (e) {
    el.editError.hidden = false;
    el.editError.textContent = String(e.message ?? e);
  }
});

function openOutreachDialog(contact) {
  el.outreachError.hidden = true;
  el.outreachId.value = contact.id;
  el.outreachDate.value = new Date().toISOString().slice(0, 10);
  el.outreachChannel.value = "";
  el.outreachResponded.checked = false;
  el.outreachFollowup.checked = false;
  el.outreachNote.value = "";
  el.outreachDialog.showModal();
}

el.outreachCancelBtn.addEventListener("click", () => el.outreachDialog.close());

el.outreachForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  el.outreachError.hidden = true;
  const id = el.outreachId.value;
  const body = {
    date: el.outreachDate.value,
    channel: el.outreachChannel.value,
    responded: el.outreachResponded.checked,
    followupPending: el.outreachFollowup.checked,
    note: el.outreachNote.value,
  };
  try {
    const res = await fetch(`/api/apoios/contacts/${encodeURIComponent(id)}/outreach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error(result.error ?? `HTTP ${res.status}`);
    el.outreachDialog.close();
    await fetchApoios();
  } catch (e) {
    el.outreachError.hidden = false;
    el.outreachError.textContent = String(e.message ?? e);
  }
});

fetchApoios();
