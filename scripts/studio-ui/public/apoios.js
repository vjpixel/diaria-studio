// apoios.js (#3602) — CRM simples de apoios apoia.se: base de contatos +
// status cruzado (apoiando/não apoia/apoiou e parou, via checkBacker) +
// visão de campanha. Vanilla JS, sem build step (mesmo princípio de
// triagem.js/app.js — #3555/#3562).
//
// A mutação de edição (editar contato) chama PUT /api/apoios/contacts/:id
// (studio-apoios.ts) e depois refaz o fetch completo de /api/apoios — sem
// estado otimista client-side, mais simples e sempre consistente com o
// servidor (fonte única de verdade é o contacts.jsonl).
//
// #3862 (decisão do editor 260722): o form manual "Adicionar contato" foi
// removido — contatos passam a vir do e-mail/apoia.se (#3859), não digitados à
// mão. O endpoint POST /api/apoios/contacts CONTINUA existindo (será o ponto de
// entrada da importação automática, #3859 metade 1); só a UI de cadastro
// manual saiu. `parseEmailsInput` segue em uso pelo form de EDIÇÃO.
//
// #3844 (decisão do editor 260721): os recursos de follow-up/outreach
// (tracking de contato, dialog de registro, tiles de contactados/follow-ups
// pendentes) foram removidos — a área refoca em visão por grupo/nível de
// recompensa.
//
// #3844 parte 2 (decisão do editor 260722): visão por grupo — `rewardGroups`
// já vem PRONTO no payload de /api/apoios (studio-apoios.ts::computeRewardGroups),
// client só renderiza; nenhuma agregação acontece aqui.
//
// #3859 (metade 2): botão "Atualizar status" — POST /api/apoios/refresh
// força re-consulta do mês corrente na apoia.se pra contatos ainda não
// confirmados como "apoiando" (o refresh comum, botão "Atualizar" acima,
// só refaz o GET — nunca bate na API de novo dentro do mesmo mês, porque
// checkBacker cacheia por mês-competência). A metade 1 da issue (importar
// apoios novos varrendo o Gmail pessoal) NÃO está implementada aqui — seguirá
// bloqueada em arquitetura até existir uma ponte Studio↔sessão-com-MCP.

const el = {
  fetchDot: document.getElementById("fetch-dot"),
  fetchLabel: document.getElementById("fetch-label"),
  error: document.getElementById("apoios-error"),
  tileTotal: document.getElementById("tile-total"),
  tileConverted: document.getElementById("tile-converted"),
  tileValue: document.getElementById("tile-value"),
  rewardGroups: document.getElementById("reward-groups"),
  contactsCount: document.getElementById("contacts-count"),
  filterStatus: document.getElementById("filter-status"),
  refreshBtn: document.getElementById("refresh-btn"),
  refreshStatusBtn: document.getElementById("refresh-status-btn"),
  lastUpdated: document.getElementById("last-updated"),
  contactsList: document.getElementById("contacts-list"),
  contactsEmpty: document.getElementById("contacts-empty"),
  editDialog: document.getElementById("edit-dialog"),
  editForm: document.getElementById("edit-contact-form"),
  editId: document.getElementById("edit-id"),
  editName: document.getElementById("edit-name"),
  editEmails: document.getElementById("edit-emails"),
  editNotes: document.getElementById("edit-notes"),
  editError: document.getElementById("edit-contact-error"),
  editCancelBtn: document.getElementById("edit-cancel-btn"),
};

/** Snapshot bruto da última resposta de /api/apoios. */
let data = { contacts: [], campaign: null, rewardGroups: null, error: null, generatedAt: null };

const filters = { status: "" };

const STATUS_LABEL = {
  apoiando: "apoiando",
  nao_apoia: "não apoia",
  apoiou_e_parou: "apoiou e parou",
  sem_dados: "sem dados",
};

// #3844 parte 2: rótulo + ordem de exibição (do nível mais alto pro mais
// baixo — mais fácil bater o olho em quem tem mais recompensa a cumprir).
// Faixas espelham exatamente scripts/studio-ui/studio-apoios.ts::computeRewardGroup.
const REWARD_GROUP_ORDER = ["patrono", "mantenedor", "apoiador", "amigo"];
const REWARD_GROUP_LABEL = {
  patrono: "Patrono (R$50+)",
  mantenedor: "Mantenedor (R$25–49)",
  apoiador: "Apoiador (R$10–24)",
  amigo: "Amigo (R$5–9)",
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

// #3612: taxa de abertura Beehiiv — sinal independente do status de apoio,
// vem de um cache separado (data/apoia-se/beehiiv-open-rate.json) populado
// manualmente. `openRate` é `null` quando o cache está ausente/sem match
// pro contato — mostra "sem dados" (nunca quebra a UI, mesmo padrão do
// status-badge "sem_dados").
function openRateBadge(openRate) {
  if (!openRate || typeof openRate.openRatePct !== "number") {
    return '<span class="open-rate-badge open-rate-sem-dados">abertura: sem dados</span>';
  }
  const pct = Math.round(openRate.openRatePct);
  return `<span class="open-rate-badge open-rate-ok" title="${escapeHtml(String(openRate.totalUniqueOpened))}/${escapeHtml(String(openRate.totalDelivered))} aberturas · click ${escapeHtml(String(Math.round(openRate.clickRatePct)))}%">abertura: ${pct}%</span>`;
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
  const c = data.campaign ?? { totalContacts: 0, totalConverted: 0, monthlyValueSum: 0 };
  el.tileTotal.textContent = String(c.totalContacts);
  el.tileConverted.textContent = String(c.totalConverted);
  el.tileValue.textContent = fmtBRL(c.monthlyValueSum ?? 0);
}

// #3844 parte 2: renderiza a visão por grupo/nível de recompensa do mês
// corrente — `rewardGroups` já vem agregado do servidor (nenhum cálculo
// aqui). Grupo vazio ainda aparece (com "0" no contador e uma linha "ninguém
// neste grupo este mês") — nunca desaparece silenciosamente, mesmo padrão do
// estado vazio de `renderContacts`.
function renderRewardGroups() {
  const groups = data.rewardGroups ?? { amigo: [], apoiador: [], mantenedor: [], patrono: [] };
  el.rewardGroups.innerHTML = "";
  for (const key of REWARD_GROUP_ORDER) {
    const contacts = groups[key] ?? [];
    const group = document.createElement("div");
    group.className = "reward-group";
    const itemsHtml = contacts.length
      ? contacts
          .map((c) => {
            const email = c.status?.matchedEmail ?? c.emails[0] ?? "";
            const value = typeof c.status?.monthlyValue === "number" ? c.status.monthlyValue : 0;
            return `<li class="reward-contact">
              <span class="reward-contact-name">${escapeHtml(c.name)}</span>
              <span class="reward-contact-email">${escapeHtml(email)}</span>
              <span class="reward-contact-value">R$${fmtBRL(value)}</span>
            </li>`;
          })
          .join("")
      : `<li class="reward-group-empty">Ninguém neste grupo este mês.</li>`;
    group.innerHTML = `
      <h3 class="reward-group-title">
        ${escapeHtml(REWARD_GROUP_LABEL[key] ?? key)}
        <span class="reward-group-count">${contacts.length}</span>
      </h3>
      <ul class="reward-group-list">${itemsHtml}</ul>
    `;
    el.rewardGroups.appendChild(group);
  }
}

function matchesFilter(contact) {
  if (!filters.status) return true;
  return contact.status.label === filters.status;
}

function renderContacts() {
  const filtered = data.contacts.filter(matchesFilter);
  el.contactsCount.textContent = String(filtered.length);
  // #3874: "0 resultados para este filtro" vs "nenhum contato ainda" (padrão
  // relatorios.js, R4 de docs/studio-ui-ux-guidelines.md) — nunca a lista só
  // desaparece sem explicação quando o filtro de status zera o resultado.
  if (filtered.length === 0) {
    el.contactsEmpty.hidden = false;
    el.contactsEmpty.textContent =
      data.contacts.length > 0 && filters.status ? "0 resultados para este filtro." : "Nenhum contato ainda.";
  } else {
    el.contactsEmpty.hidden = true;
  }
  el.contactsList.innerHTML = "";
  for (const c of filtered) {
    const card = document.createElement("div");
    card.className = "contact-card";
    card.innerHTML = `
      <div class="contact-card-head">
        <span class="contact-name">${escapeHtml(c.name)}</span>
        ${statusBadge(c.status)}
        ${openRateBadge(c.openRate)}
      </div>
      <div class="contact-emails">${c.emails.map(escapeHtml).join(", ")}</div>
      ${c.notes ? `<div class="contact-notes">${escapeHtml(c.notes)}</div>` : ""}
      <div class="contact-actions">
        <button type="button" data-action="edit" data-id="${escapeHtml(c.id)}">Editar</button>
      </div>
    `;
    el.contactsList.appendChild(card);
  }
}

function renderAll() {
  renderError();
  renderTiles();
  renderRewardGroups();
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

// #3859: POST /api/apoios/refresh — (1) importa apoiadores novos via e-mail
// apoia.se e (2) força re-consulta na apoia.se só pra contatos ainda não
// confirmados como "apoiando" (o servidor decide quem — ver refreshApoiosData
// em studio-apoios.ts). Resposta tem o MESMO formato de GET /api/apoios,
// então só substitui `data` e renderiza de novo (mesma disciplina "sem
// estado otimista" do resto do arquivo).
async function refreshApoiosStatus() {
  el.refreshStatusBtn.disabled = true;
  const originalLabel = el.refreshStatusBtn.textContent;
  el.refreshStatusBtn.textContent = "Atualizando status…";
  setFetchStatus("", "atualizando status…");
  try {
    const res = await fetch("/api/apoios/refresh", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    setFetchStatus(data.error ? "down" : "ok", data.error ? "erro apoia.se" : "ok");
  } catch (e) {
    setFetchStatus("down", "falha ao atualizar status");
    data = { ...data, error: String(e) };
  }
  renderAll();
  el.refreshStatusBtn.disabled = false;
  el.refreshStatusBtn.textContent = originalLabel;
}

function parseEmailsInput(raw) {
  return raw
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

el.refreshBtn.addEventListener("click", () => fetchApoios());
el.refreshStatusBtn.addEventListener("click", () => refreshApoiosStatus());
el.filterStatus.addEventListener("change", () => {
  filters.status = el.filterStatus.value;
  renderContacts();
});

el.contactsList.addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.dataset.id;
  const contact = data.contacts.find((c) => c.id === id);
  if (!contact) return;
  if (btn.dataset.action === "edit") openEditDialog(contact);
});

function openEditDialog(contact) {
  el.editError.hidden = true;
  el.editId.value = contact.id;
  el.editName.value = contact.name;
  el.editEmails.value = contact.emails.join(", ");
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

fetchApoios();
