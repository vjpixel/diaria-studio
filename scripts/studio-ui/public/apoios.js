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
// mão. A rota POST /api/apoios/contacts que o form chamava também saiu do
// server (server.ts/studio-apoios.ts) — a importação automática (#3859
// metade 1) chama `createContact` direto, in-process, nunca via HTTP.
// `parseEmailsInput` segue em uso pelo form de EDIÇÃO.
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
// Botão "Atualizar" (unificado — decisão do editor 260723): faz o fluxo
// COMPLETO via POST /api/apoios/refresh — drain de e-mails novos da apoia.se
// no Gmail (#3859 metade 1, inclui promessas #3912) + re-consulta do mês
// corrente na apoia.se pra contatos ainda não confirmados como "apoiando"
// (#3859 metade 2; seletiva, protege a cota de 5.000 req/mês). O botão fica
// desabilitado com rótulo "Atualizando…" enquanto o servidor trabalha.
// O GET /api/apoios puro continua usado só no load inicial e pós-edição de
// contato — não tem mais botão próprio (era o "Atualizar" antigo, que
// confundia: parecia buscar e-mails novos mas só relia o snapshot).

const el = {
  fetchDot: document.getElementById("fetch-dot"),
  fetchLabel: document.getElementById("fetch-label"),
  error: document.getElementById("apoios-error"),
  tileTotal: document.getElementById("tile-total"),
  tileConverted: document.getElementById("tile-converted"),
  tileValue: document.getElementById("tile-value"),
  vinculoSummary: document.getElementById("vinculo-summary"),
  rewardGroups: document.getElementById("reward-groups"),
  contactsCount: document.getElementById("contacts-count"),
  filterStatus: document.getElementById("filter-status"),
  refreshBtn: document.getElementById("refresh-btn"),
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

/** #4437: forma vazia de rewardGroups usada como default client-side —
 * espelha scripts/studio-ui/studio-apoios.ts::emptyRewardGroupsView. */
const EMPTY_REWARD_GROUPS = { amigo: [], apoiador: [], mantenedor: [], patrono: [], nao_pagou_ainda: [] };

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
// #4437 Entrega 1: "nao_pagou_ainda" vai por ÚLTIMO — não é uma faixa de
// valor, é um estado de cobrança (carência de 1 mês), visualmente distinto
// dos 4 níveis (ver .reward-group-pending em apoios.css).
const REWARD_GROUP_ORDER = ["patrono", "mantenedor", "apoiador", "amigo", "nao_pagou_ainda"];
const REWARD_GROUP_LABEL = {
  patrono: "Patrono (R$50+)",
  mantenedor: "Mantenedor (R$25–49)",
  apoiador: "Apoiador (R$10–24)",
  amigo: "Amigo (R$5–9)",
  nao_pagou_ainda: "Ainda não pagou esse mês",
};

// Nome de exibição sem a faixa de valor — usado no badge de nível de
// recompensa do card de Contatos (#4437 Entrega 2) e na lista do grupo "ainda
// não pagou esse mês" (mostra o nível que a pessoa TINHA, não uma faixa nova).
const LEVEL_NAME = { patrono: "Patrono", mantenedor: "Mantenedor", apoiador: "Apoiador", amigo: "Amigo" };

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

// #4273 parte 3: confirmação de vínculo Beehiiv — sinal independente do
// status de apoio, vem de um cache separado (data/apoia-se/beehiiv-vinculo.json)
// populado manualmente. `vinculo === null` significa "nenhum email do contato
// foi consultado ainda" (cache pode estar desatualizado) — diferente de
// `hasVinculo: false` (consultado, sem vínculo confirmado). Os 3 estados têm
// badges visualmente distintos, nenhum deles é silencioso.
function vinculoBadge(vinculo) {
  if (!vinculo) {
    return '<span class="vinculo-badge vinculo-sem-dados" title="nenhum email deste contato foi consultado ainda">vínculo Beehiiv: —</span>';
  }
  if (vinculo.hasVinculo) {
    return '<span class="vinculo-badge vinculo-ok" title="assinante Beehiiv confirmado">✅ assinante Beehiiv</span>';
  }
  return '<span class="vinculo-badge vinculo-falta" title="não encontrado como assinante Beehiiv">❌ não é assinante Beehiiv</span>';
}

// #4437 Entrega 2: valor de apoio explícito no card, campo PRÓPRIO (além do
// badge de status, que já embute o valor pra "apoiando" — #3844). Pra
// "apoiando" mostra o valor do mês corrente; pra "apoiou_e_parou" com
// lastPaidValue mostra o ÚLTIMO pagamento conhecido, rotulado com o mês (nunca
// confundido com o mês corrente). Sem valor aplicável (nao_apoia/sem_dados/
// apoiou_e_parou sem histórico de valor) -> "" (nada inventado).
function apoioValueField(status) {
  if (status.label === "apoiando" && typeof status.monthlyValue === "number") {
    return `<span class="apoio-value apoio-value-current">R$${fmtBRL(status.monthlyValue)}/mês</span>`;
  }
  if (status.label === "apoiou_e_parou" && typeof status.lastPaidValue === "number") {
    const month = status.lastPaidMonth ? escapeHtml(status.lastPaidMonth) : "—";
    return `<span class="apoio-value apoio-value-past" title="último pagamento conhecido, não o mês corrente">R$${fmtBRL(status.lastPaidValue)} (último pagamento: ${month})</span>`;
  }
  return "";
}

// #4437 Entrega 2: badge de nível de recompensa — `rewardLevel` já vem
// AGREGADO do servidor (computeContactRewardLevel), zero cálculo novo aqui.
// `null` (nao_apoia/sem_dados/apoiou_e_parou fora da carência) -> "" (nunca
// um badge inventado).
function rewardLevelBadge(rewardLevel) {
  if (!rewardLevel) return "";
  const name = LEVEL_NAME[rewardLevel] ?? rewardLevel;
  return `<span class="reward-level-badge reward-level-${escapeHtml(rewardLevel)}">${escapeHtml(name)}</span>`;
}

// #4437 Entrega 2: segmentos Beehiiv em que o contato está. `segments ===
// null` significa "nunca consultado" (cache ausente ou nenhum email do
// contato no cache — pode ser porque scripts/sync-apoio-segments-beehiiv.ts
// nunca rodou, NÃO que o contato está fora da base) — visualmente distinto de
// `{ segments: [], ... }` = "consultado, nenhum segmento encontrado".
function segmentsBadge(segments) {
  if (!segments) {
    return '<span class="segments-badge segments-sem-dados" title="nenhum email deste contato foi consultado ainda (sync scripts/sync-apoio-segments-beehiiv.ts pode não ter rodado)">segmentos Beehiiv: não consultado</span>';
  }
  if (segments.segments.length === 0) {
    return '<span class="segments-badge segments-vazio" title="consultado — nenhum segmento Apoio — * encontrado">segmentos Beehiiv: nenhum</span>';
  }
  const title = `apoio_nivel na Beehiiv: ${escapeHtml(segments.apoioNivel || "(vazio)")}`;
  return `<span class="segments-badge segments-ok" title="${title}">${escapeHtml(segments.segments.join(", "))}</span>`;
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
  renderVinculoSummary();
}

// #4273 parte 3: contador agregado "N de M apoiadores sem vínculo Beehiiv" —
// calculado client-side sobre o snapshot já carregado (nenhuma agregação nova
// do servidor). M = apoiadores confirmados este mês ("apoiando"); N = os que
// NÃO têm vínculo Beehiiv confirmado (vinculo === null, ainda não consultado,
// OU hasVinculo === false, consultado e sem vínculo — os dois contam como
// "não confirmado" pro propósito de checar se a recompensa está sendo
// entregue). M === 0 não mostra nada (nada pra reportar ainda).
function renderVinculoSummary() {
  const apoiadores = data.contacts.filter((c) => c.status?.label === "apoiando");
  const semVinculo = apoiadores.filter((c) => !c.vinculo?.hasVinculo);
  if (apoiadores.length === 0) {
    el.vinculoSummary.textContent = "";
    return;
  }
  el.vinculoSummary.textContent = `${semVinculo.length} de ${apoiadores.length} apoiadores sem vínculo Beehiiv confirmado.`;
}

// #3844 parte 2: renderiza a visão por grupo/nível de recompensa do mês
// corrente — `rewardGroups` já vem agregado do servidor (nenhum cálculo
// aqui). Grupo vazio ainda aparece (com "0" no contador e uma linha "ninguém
// neste grupo este mês") — nunca desaparece silenciosamente, mesmo padrão do
// estado vazio de `renderContacts`.
// #4437 Entrega 1: item de lista do grupo "ainda não pagou esse mês" — mostra
// o valor/mês do ÚLTIMO pagamento (lastPaidValue/lastPaidMonth, não
// monthlyValue — esse contato não pagou o mês corrente) + o nível que a
// pessoa tinha (c.rewardLevel, já computado no servidor via
// computeContactRewardLevel — zero cálculo novo aqui).
function pendingRewardContactItem(c) {
  const email = c.status?.matchedEmail ?? c.emails[0] ?? "";
  const value = typeof c.status?.lastPaidValue === "number" ? c.status.lastPaidValue : 0;
  const levelName = c.rewardLevel ? LEVEL_NAME[c.rewardLevel] ?? c.rewardLevel : null;
  const monthNote = c.status?.lastPaidMonth ? ` — pagou em ${escapeHtml(c.status.lastPaidMonth)}` : "";
  const levelNote = levelName ? ` (${escapeHtml(levelName)})` : "";
  return `<li class="reward-contact">
    <span class="reward-contact-name">${escapeHtml(c.name)}</span>
    <span class="reward-contact-email">${escapeHtml(email)}</span>
    <span class="reward-contact-value">R$${fmtBRL(value)}${levelNote}${monthNote}</span>
  </li>`;
}

function rewardContactItem(c) {
  const email = c.status?.matchedEmail ?? c.emails[0] ?? "";
  const value = typeof c.status?.monthlyValue === "number" ? c.status.monthlyValue : 0;
  return `<li class="reward-contact">
    <span class="reward-contact-name">${escapeHtml(c.name)}</span>
    <span class="reward-contact-email">${escapeHtml(email)}</span>
    <span class="reward-contact-value">R$${fmtBRL(value)}</span>
  </li>`;
}

function renderRewardGroups() {
  const groups = data.rewardGroups ?? EMPTY_REWARD_GROUPS;
  el.rewardGroups.innerHTML = "";
  for (const key of REWARD_GROUP_ORDER) {
    const contacts = groups[key] ?? [];
    const isPending = key === "nao_pagou_ainda";
    const group = document.createElement("div");
    // #4437: classe extra pra distinguir visualmente o estado de cobrança
    // (nao_pagou_ainda) dos 4 níveis de recompensa de verdade.
    group.className = "reward-group" + (isPending ? " reward-group-pending" : "");
    // Mesma linha "ninguém neste grupo" dos demais grupos — grupo vazio nunca
    // desaparece silenciosamente, nem o novo.
    const itemsHtml = contacts.length
      ? contacts.map(isPending ? pendingRewardContactItem : rewardContactItem).join("")
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
    // #4437 Entrega 2: valor explícito + badge de nível de recompensa +
    // segmentos Beehiiv, além do status/abertura/vínculo já existentes.
    const valueField = apoioValueField(c.status);
    card.innerHTML = `
      <div class="contact-card-head">
        <span class="contact-name">${escapeHtml(c.name)}</span>
        ${statusBadge(c.status)}
        ${rewardLevelBadge(c.rewardLevel)}
        ${openRateBadge(c.openRate)}
        ${vinculoBadge(c.vinculo)}
        ${segmentsBadge(c.segments)}
      </div>
      ${valueField ? `<div class="contact-value">${valueField}</div>` : ""}
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
// apoia.se (inclui promessas, #3912) e (2) força re-consulta na apoia.se só
// pra contatos ainda não confirmados como "apoiando" (o servidor decide quem
// — ver refreshApoiosData em studio-apoios.ts). Resposta tem o MESMO formato
// de GET /api/apoios, então só substitui `data` e renderiza de novo (mesma
// disciplina "sem estado otimista" do resto do arquivo). Enquanto roda, o
// botão fica desabilitado com rótulo de progresso — a operação leva alguns
// segundos (Gmail + apoia.se) e sem esse estado o clique parece não fazer nada.
async function refreshApoios() {
  el.refreshBtn.disabled = true;
  const originalLabel = el.refreshBtn.textContent;
  el.refreshBtn.textContent = "Atualizando…";
  el.refreshBtn.setAttribute("aria-busy", "true");
  setFetchStatus("", "buscando e-mails novos e status na apoia.se…");
  try {
    const res = await fetch("/api/apoios/refresh", { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    setFetchStatus(data.error ? "down" : "ok", data.error ? "erro apoia.se" : "ok");
  } catch (e) {
    setFetchStatus("down", "falha ao atualizar");
    data = { ...data, error: String(e) };
  }
  renderAll();
  el.refreshBtn.disabled = false;
  el.refreshBtn.textContent = originalLabel;
  el.refreshBtn.removeAttribute("aria-busy");
}

function parseEmailsInput(raw) {
  return raw
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

el.refreshBtn.addEventListener("click", () => refreshApoios());
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
