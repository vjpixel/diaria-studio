// rv-highlights.js (#6447 Fatia 2) — painel "Editor por destaque": 1 card por
// DESTAQUE com título por opção (clique único), URL, parágrafos do corpo e
// "por que isso importa" — alternativa estruturada ao textarea de Markdown
// cru que a aba "02 — Newsletter" já oferece (não a substitui).
//
// Fonte de dados: GET /api/editions/:aammdd/review/reviewed/highlights
// (scripts/studio-ui/studio-review.ts::readHighlightsSummary — parse puro
// via scripts/lib/lint-checks/highlight-block-edit.ts, sem LLM). Save: PUT
// .../review/reviewed/highlights/:n, que reusa o MESMO guard de conflito
// mtime (#3729) que o editor de MD cru e a edição inline de título (#3806)
// já usam — SAVE_CONFLICT_CONFIRM_MESSAGE (revisao-guards.js) é reusado tal
// qual, sem um segundo mecanismo de conflito.
//
// Depois de um save bem-sucedido, dispara `rv:reviewed-saved` no `window` —
// rv-gate.js e revisao.js escutam esse evento (hook mínimo adicionado em
// cada um) pra recarregar o que mostram, já que os 3 painéis (Gate, texto
// cru, Editor por destaque) refletem a MESMA fonte de verdade
// (`02-reviewed.md`) e não podem ficar dessincronizados após um save.
//
// Módulo independente (mesma convenção de import isolado do #3559/#6447
// Fatia 1) — só depende do DOM estático declarado em revisao.html.

import { SAVE_CONFLICT_CONFIRM_MESSAGE } from "./revisao-guards.js";
import {
  isTitleTooLong,
  formatTitleCharCount,
  resolveFinalTitle,
  buildHighlightSavePayload,
  mergeIncomingHighlights,
} from "./rv-highlights-format.js";

function getAammddFromPath() {
  const m = location.pathname.match(/^\/revisao\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

const aammdd = getAammddFromPath();

const el = {
  status: document.getElementById("rv-hl-status"),
  cards: document.getElementById("rv-hl-cards"),
  refreshBtn: document.getElementById("rv-hl-refresh-btn"),
};

// Estado por card, indexado por `n` (destaque) — vive só em memória, refeito
// a cada `loadHighlights()`. `dirty`/`saving`/`error` controlam o feedback
// visual; os demais campos espelham o formulário do card.
const cardState = new Map();

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function el_(tag, opts = {}) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  if (opts.type) node.type = opts.type;
  return node;
}

function markDirty(state, statusEl) {
  state.dirty = true;
  state.statusKind = "dirty";
  state.statusMessage = "Não salvo.";
  statusEl.className = "rv-hl-card-status dirty";
  statusEl.textContent = state.statusMessage;
}

function renderTitleOptions(state, maxTitleLength, onSelect) {
  const wrap = el_("div", { className: "rv-hl-title-options" });
  state.titleOptions.forEach((opt, idx) => {
    const label = el_("label", {
      className: `rv-hl-title-option${idx === state.selectedIndex ? " selected" : ""}`,
    });
    const radio = el_("input", { type: "radio" });
    radio.name = `rv-hl-title-${state.n}`;
    radio.checked = idx === state.selectedIndex;
    radio.addEventListener("change", () => {
      state.selectedIndex = idx;
      onSelect();
    });
    label.appendChild(radio);
    label.appendChild(el_("span", { className: "rv-hl-title-option-text", text: opt.text }));
    const tooLong = isTitleTooLong(opt.text, maxTitleLength);
    label.appendChild(
      el_("span", {
        className: `rv-hl-title-option-count${tooLong ? " over" : ""}`,
        text: formatTitleCharCount(opt.text, maxTitleLength),
      }),
    );
    wrap.appendChild(label);
  });
  return wrap;
}

function renderBodyParagraphs(state, onChange) {
  const wrap = el_("div", { className: "rv-hl-body-paragraphs" });
  state.body.forEach((paragraph, idx) => {
    const row = el_("div", { className: "rv-hl-body-paragraph-row" });
    const textarea = document.createElement("textarea");
    textarea.value = paragraph;
    textarea.rows = 2;
    textarea.addEventListener("input", () => {
      state.body[idx] = textarea.value;
      onChange();
    });
    row.appendChild(textarea);
    const removeBtn = el_("button", { className: "rv-hl-body-remove-btn", text: "Remover" });
    removeBtn.type = "button";
    removeBtn.disabled = state.body.length <= 1;
    removeBtn.addEventListener("click", () => {
      if (state.body.length <= 1) return;
      state.body.splice(idx, 1);
      onChange();
      renderCards(); // reconstrói a lista de parágrafos (índices mudaram)
    });
    row.appendChild(removeBtn);
    wrap.appendChild(row);
  });
  const addBtn = el_("button", { className: "rv-hl-body-add-btn", text: "+ Parágrafo" });
  addBtn.type = "button";
  addBtn.addEventListener("click", () => {
    state.body.push("");
    onChange();
    renderCards();
  });
  wrap.appendChild(addBtn);
  return wrap;
}

function buildCardNode(state, maxTitleLength) {
  const card = el_("div", { className: "rv-hl-card" });

  const header = el_("div", { className: "rv-hl-card-header" });
  header.appendChild(el_("strong", { text: `D${state.n} — ${state.category}` }));
  const statusEl = el_("span", { className: "rv-hl-card-status" });
  statusEl.textContent = state.statusMessage;
  if (state.statusKind) statusEl.classList.add(state.statusKind);
  header.appendChild(statusEl);
  card.appendChild(header);

  const onFieldChange = () => markDirty(state, statusEl);

  const titleField = el_("div", { className: "rv-hl-field" });
  titleField.appendChild(el_("label", { text: "Título (clique numa opção)" }));
  titleField.appendChild(renderTitleOptions(state, maxTitleLength, onFieldChange));
  const freeformLabel = el_("p", {
    className: "rv-hl-freeform-title",
    text: "Ou reescreva o título final (vence sobre a opção selecionada):",
  });
  titleField.appendChild(freeformLabel);
  const freeformInput = document.createElement("input");
  freeformInput.type = "text";
  freeformInput.value = state.freeformTitle;
  freeformInput.placeholder = "(deixe vazio para usar a opção selecionada)";
  freeformInput.addEventListener("input", () => {
    state.freeformTitle = freeformInput.value;
    onFieldChange();
  });
  titleField.appendChild(freeformInput);
  card.appendChild(titleField);

  const urlField = el_("div", { className: "rv-hl-field" });
  urlField.appendChild(el_("label", { text: "URL" }));
  const urlInput = document.createElement("input");
  urlInput.type = "url";
  urlInput.value = state.url;
  urlInput.addEventListener("input", () => {
    state.url = urlInput.value;
    onFieldChange();
  });
  urlField.appendChild(urlInput);
  card.appendChild(urlField);

  const bodyField = el_("div", { className: "rv-hl-field" });
  bodyField.appendChild(el_("label", { text: "Corpo (1 parágrafo por caixa)" }));
  bodyField.appendChild(renderBodyParagraphs(state, onFieldChange));
  card.appendChild(bodyField);

  const whyField = el_("div", { className: "rv-hl-field" });
  whyField.appendChild(el_("label", { text: "Por que isso importa" }));
  const whyTextarea = document.createElement("textarea");
  whyTextarea.rows = 2;
  whyTextarea.value = state.whyMatters;
  whyTextarea.addEventListener("input", () => {
    state.whyMatters = whyTextarea.value;
    onFieldChange();
  });
  whyField.appendChild(whyTextarea);
  card.appendChild(whyField);

  const actions = el_("div", { className: "rv-hl-card-actions" });
  const saveBtn = el_("button", { className: "rv-hl-save-btn", text: "Salvar este destaque" });
  saveBtn.type = "button";
  saveBtn.disabled = state.saving;
  saveBtn.addEventListener("click", () => { saveCard(state, statusEl, saveBtn); });
  actions.appendChild(saveBtn);
  actions.appendChild(buildRewriteButton(state));
  card.appendChild(actions);

  return card;
}

/** #6447 Fatia 4 (achado 6) — "Reescrever com IA": abre o chat drawer já
 * PRÉ-PREENCHIDO com um prompt sobre este destaque (título atual + regra do
 * limite de caracteres) e para aí — o editor decide se ajusta o texto antes
 * de enviar, nunca dispara o LLM sozinho (mesma decisão de escopo do corpo
 * da issue). Reusa `window.diariaStudioChat.prefillMessage` (#3629), que já
 * existia sem nenhum caller até agora. Fail-soft: se o chat-drawer ainda não
 * montou (ordem de <script> na página) ou o toggle #4078 está desativado,
 * `prefillMessage` simplesmente não existe — mesmo guard defensivo que
 * `openChatAtPendingCard` (edicao.js) já usa. */
function buildRewriteButton(state) {
  const btn = el_("button", { className: "rv-hl-rewrite-btn", text: "Reescrever com IA" });
  btn.type = "button";
  btn.addEventListener("click", () => {
    const currentTitle = state.titleOptions[state.selectedIndex]
      ? state.titleOptions[state.selectedIndex].text
      : state.freeformTitle;
    const prompt =
      `Reescreva o título do D${state.n} (categoria ${state.category}) pra ficar mais direto, ` +
      `mantendo até ${currentMaxTitleLength} caracteres. Título atual: "${currentTitle}".`;
    if (window.diariaStudioChat && typeof window.diariaStudioChat.prefillMessage === "function") {
      window.diariaStudioChat.prefillMessage(prompt);
    } else {
      console.warn("rv-highlights: chat drawer indisponível — não foi possível pré-preencher o prompt.");
    }
  });
  return btn;
}

async function saveCard(state, statusEl, saveBtn) {
  const finalTitle = resolveFinalTitle(
    state.titleOptions[state.selectedIndex] ? state.titleOptions[state.selectedIndex].text : "",
    state.freeformTitle,
  );
  const payload = buildHighlightSavePayload({
    title: finalTitle,
    url: state.url,
    bodyParagraphs: state.body,
    whyMatters: state.whyMatters,
    expectedModifiedAt: state.modifiedAt,
  });

  state.saving = true;
  saveBtn.disabled = true;
  statusEl.className = "rv-hl-card-status";
  statusEl.textContent = "Salvando…";

  let res;
  try {
    res = await fetch(`/api/editions/${encodeURIComponent(aammdd)}/review/reviewed/highlights/${state.n}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    state.saving = false;
    saveBtn.disabled = false;
    statusEl.className = "rv-hl-card-status error";
    statusEl.textContent = `Erro de rede ao salvar: ${(err && err.message) || err}`;
    return;
  }

  if (res.status === 409) {
    state.saving = false;
    saveBtn.disabled = false;
    const overwrite = window.confirm(SAVE_CONFLICT_CONFIRM_MESSAGE);
    if (overwrite) {
      await saveCardForce(state, statusEl, saveBtn, payload);
    } else {
      statusEl.className = "rv-hl-card-status error";
      statusEl.textContent = "Conflito — recarregando a versão do disco…";
      await loadHighlights();
    }
    return;
  }

  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  state.saving = false;
  saveBtn.disabled = false;

  if (res.ok && body && body.ok) {
    state.dirty = false;
    state.statusKind = "saved";
    statusEl.className = "rv-hl-card-status saved";
    statusEl.textContent = "Salvo.";
    // Dispara o evento compartilhado (rv-gate.js/revisao.js escutam) — o
    // listener DESTE MÓDULO (registrado mais abaixo) também reage e recarrega
    // via loadHighlights(), então não chamamos loadHighlights() de novo aqui
    // (evitaria uma corrida de 2 fetches concorrentes pro mesmo GET).
    window.dispatchEvent(new CustomEvent("rv:reviewed-saved"));
    return;
  }
  statusEl.className = "rv-hl-card-status error";
  statusEl.textContent = `Erro ao salvar: ${(body && body.error) || "falha desconhecida"}`;
}

async function saveCardForce(state, statusEl, saveBtn, payload) {
  state.saving = true;
  saveBtn.disabled = true;
  statusEl.className = "rv-hl-card-status";
  statusEl.textContent = "Sobrescrevendo…";
  let res;
  try {
    res = await fetch(`/api/editions/${encodeURIComponent(aammdd)}/review/reviewed/highlights/${state.n}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, force: true }),
    });
  } catch (err) {
    state.saving = false;
    saveBtn.disabled = false;
    statusEl.className = "rv-hl-card-status error";
    statusEl.textContent = `Erro de rede ao sobrescrever: ${(err && err.message) || err}`;
    return;
  }
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  state.saving = false;
  saveBtn.disabled = false;
  if (res.ok && body && body.ok) {
    statusEl.className = "rv-hl-card-status saved";
    statusEl.textContent = "Salvo (sobrescreveu a versão em disco).";
    // Ver comentário equivalente em saveCard() — o listener deste módulo
    // já recarrega, evitando fetch duplicado.
    window.dispatchEvent(new CustomEvent("rv:reviewed-saved"));
    return;
  }
  statusEl.className = "rv-hl-card-status error";
  statusEl.textContent = `Erro ao sobrescrever: ${(body && body.error) || "falha desconhecida"}`;
}

let currentMaxTitleLength = 52;

function renderCards() {
  clear(el.cards);
  const states = [...cardState.values()].sort((a, b) => a.n - b.n);
  if (states.length === 0) {
    el.cards.appendChild(
      el_("p", { className: "rv-hl-empty", text: "Nenhum destaque encontrado em 02-reviewed.md." }),
    );
    return;
  }
  for (const state of states) {
    el.cards.appendChild(buildCardNode(state, currentMaxTitleLength));
  }
}

export async function loadHighlights() {
  if (!aammdd || !el.cards) return;
  el.status.textContent = "Carregando…";
  try {
    const res = await fetch(`/api/editions/${encodeURIComponent(aammdd)}/review/reviewed/highlights`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const summary = await res.json();
    currentMaxTitleLength = summary.maxTitleLength || 52;
    if (!summary.available) {
      el.status.textContent = summary.note || "Editor por destaque indisponível.";
      cardState.clear();
      clear(el.cards);
      return;
    }
    el.status.textContent = "";
    // #6493 review (code-reviewer, P2): reload nunca descarta edição
    // dirty:true em progresso em OUTRO card — mergeIncomingHighlights
    // preserva esses cards tal como estão; só cards não-dirty são
    // refeitos a partir da resposta fresca do servidor. Ver docstring da
    // função pra por que isso é seguro mesmo quando o arquivo mudou de
    // verdade (o próximo save desse card recebe o 409 de sempre).
    const previousStates = [...cardState.values()];
    const merged = mergeIncomingHighlights(previousStates, summary.highlights, summary.modifiedAt);
    cardState.clear();
    for (const state of merged) cardState.set(state.n, state);
    renderCards();
  } catch (err) {
    console.error("rv-highlights: falha ao carregar destaques:", err);
    el.status.textContent = "Falha ao carregar o Editor por destaque — verifique a conexão.";
  }
}

if (el.refreshBtn) {
  el.refreshBtn.addEventListener("click", () => { loadHighlights(); });
}

// Recarrega quando OUTRO painel (edição inline de título no preview, save do
// textarea de MD cru) salvar `02-reviewed.md` — os 3 painéis mostram a MESMA
// fonte de verdade e não podem ficar dessincronizados (ver topo do arquivo).
window.addEventListener("rv:reviewed-saved", () => { loadHighlights(); });

if (aammdd) loadHighlights();

export { renderCards };
