// caixas.js (#3924) — seção "Caixas": lista dinâmica de
// `context/snippets/*.md` + editor de conteúdo. Vanilla JS, sem build step
// (mesmo princípio de apoios.js/triagem.js — #3555/#3562/#3602).
//
// Fluxo: GET /api/boxes traz a lista (slug/título/mtime/slot/dirtyVsGit).
// Clicar "Editar" numa caixa faz GET /api/boxes/:slug (conteúdo + mtime) e
// abre o painel de edição abaixo da lista — só 1 caixa editada por vez.
// "Salvar" é PUT do mesmo endpoint com o mtime visto no load
// (`expectedModifiedAt`, #3729); 409 = outra aba/sessão salvou a mesma caixa
// nesse meio tempo — confirm() com o risco real (`BOX_SAVE_CONFLICT_CONFIRM_MESSAGE`),
// nunca sobrescrita silenciosa (R5 de docs/studio-ui-ux-guidelines.md).
//
// #3937: a seção "Slots de divulgação" (topo da página) gerencia a
// atribuição dos 4 slots (slot0/1/2/3, slot0 desde #4290) pela própria UI —
// GET/PUT /api/boxes/slots, MESMO mecanismo de guard de mtime
// (`SLOTS_SAVE_CONFLICT_CONFIRM_MESSAGE`) e ZERO UI otimista (refetcha slots +
// lista após salvar, pra o badge "slot N" dos cards refletir o disco).
//
// #4275: a seção ganhou um toggle "Padrão"/"Patronos" — MESMA maquinaria
// (GET/PUT /api/boxes/slots), só que com `?variant=patronos` no GET e
// `variant: "patronos"` no corpo do PUT quando a aba Patronos está ativa.
// `currentSlotsVariant` guarda qual variante está carregada agora; trocar de
// aba refetcha do zero (mesmo padrão zero-otimista do resto do painel).
//
// #4274: a seção "PARA ENCERRAR" gerencia os slots A/B de TEXTO DIRETO
// (sempre presentes, sem pool de candidatos — diferente dos slots 0-3 acima)
// — GET/PUT /api/boxes/para-encerrar, mesmo mecanismo de guard de mtime
// (`PARA_ENCERRAR_SAVE_CONFLICT_CONFIRM_MESSAGE`) sobre a mesma chave de
// `platform.config.json`.

import {
  BOX_SAVE_CONFLICT_CONFIRM_MESSAGE,
  boxArchiveConfirmMessage,
  validateNewBoxSlug,
  findDuplicateSlotAssignment,
  SLOTS_SAVE_CONFLICT_CONFIRM_MESSAGE,
  PARA_ENCERRAR_SAVE_CONFLICT_CONFIRM_MESSAGE, // #4274
} from "./caixas-guards.js";

const el = {
  fetchDot: document.getElementById("fetch-dot"),
  fetchLabel: document.getElementById("fetch-label"),
  error: document.getElementById("boxes-error"),
  errorText: document.getElementById("boxes-error-text"),
  retryBtn: document.getElementById("boxes-retry-btn"),
  refreshBtn: document.getElementById("refresh-btn"),
  lastUpdated: document.getElementById("last-updated"),
  loading: document.getElementById("boxes-loading"),
  empty: document.getElementById("boxes-empty"),
  list: document.getElementById("boxes-list"),
  count: document.getElementById("boxes-count"),
  editorPanel: document.getElementById("editor-panel"),
  editorTitle: document.getElementById("editor-title"),
  editorFile: document.getElementById("editor-file"),
  editorNome: document.getElementById("editor-nome"),
  editorCategoria: document.getElementById("editor-categoria"), // #3981
  editorTitulo: document.getElementById("editor-titulo"), // #4079
  editorConteudo: document.getElementById("editor-conteudo"), // #3979 (era "editor")
  editorNotas: document.getElementById("editor-notas"), // #3979
  editorLoadError: document.getElementById("editor-load-error"),
  saveBtn: document.getElementById("save-btn"),
  closeEditorBtn: document.getElementById("close-editor-btn"),
  saveStatus: document.getElementById("save-status"),
  // #3928: criar caixa nova
  newBoxBtn: document.getElementById("new-box-btn"),
  createPanel: document.getElementById("create-panel"),
  createSlug: document.getElementById("create-slug"),
  createNome: document.getElementById("create-nome"),
  createCategoria: document.getElementById("create-categoria"), // #3981
  createContent: document.getElementById("create-content"),
  createSubmitBtn: document.getElementById("create-submit-btn"),
  createCancelBtn: document.getElementById("create-cancel-btn"),
  createStatus: document.getElementById("create-status"),
  // #3928: caixas arquivadas
  archivedToggle: document.getElementById("archived-toggle"),
  archivedCount: document.getElementById("archived-count"),
  archivedHint: document.getElementById("archived-hint"),
  archivedEmpty: document.getElementById("archived-empty"),
  archivedList: document.getElementById("archived-list"),
  // #3937: gestão de slots de divulgação (slot0 desde #4290)
  slot0Select: document.getElementById("slot0-select"),
  slot1Select: document.getElementById("slot1-select"),
  slot2Select: document.getElementById("slot2-select"),
  slot3Select: document.getElementById("slot3-select"),
  slotsSaveBtn: document.getElementById("slots-save-btn"),
  slotsStatus: document.getElementById("slots-status"),
  // #4275: toggle "Padrão"/"Patronos"
  variantDefaultBtn: document.getElementById("variant-default-btn"),
  variantPatronosBtn: document.getElementById("variant-patronos-btn"),
  // #4274: slots A/B de texto direto do PARA ENCERRAR
  paraEncerrarSlotA: document.getElementById("para-encerrar-slot-a"),
  paraEncerrarSlotB: document.getElementById("para-encerrar-slot-b"),
  paraEncerrarSaveBtn: document.getElementById("para-encerrar-save-btn"),
  paraEncerrarStatus: document.getElementById("para-encerrar-status"),
};

/** Chaves de slot na ordem canônica — usado pra iterar os 4 `<select>` juntos
 * (#3937, estendido ao slot0 em #4290). Espelha `SLOT_KEYS` de
 * `studio-boxes.ts` (server, autoridade). */
const SLOT_KEYS = ["slot0", "slot1", "slot2", "slot3"];
const SLOT_SELECTS = {
  slot0: el.slot0Select,
  slot1: el.slot1Select,
  slot2: el.slot2Select,
  slot3: el.slot3Select,
};

/** Snapshot da última lista bem-sucedida — `null` até o 1º fetch resolver. */
let boxes = null;
/** Snapshot da última lista de ARQUIVADas (#3928) — `null` até o 1º fetch. */
let archived = null;
/** A seção "Arquivadas" começa colapsada; o toggle controla isto. */
let archivedExpanded = false;
/** Timestamp (ISO, client-side) do último fetch de lista BEM-SUCEDIDO — R1 de
 * docs/studio-ui-ux-guidelines.md: nunca avança em falha (o server não emite
 * `generatedAt` pra esta lista, então o relógio é local ao painel). */
let lastFetchedAt = null;

let currentSlug = null;
let loadedModifiedAt = null;
let dirty = false;

/** Snapshot da atribuição de slots (#3937) — `{slot0, slot1, slot2, slot3,
 * modifiedAt}` (slot0 desde #4290), `null` até o 1º GET /api/boxes/slots
 * resolver. `modifiedAt` é reenviado como `expectedModifiedAt` no PUT (guard
 * de mtime #3729, mesmo mecanismo do editor de 1 caixa acima). */
let slotsState = null;

/** Variante atualmente exibida na seção "Slots de divulgação" (#4275) —
 * `"default"` (boxes_divulgacao) ou `"patronos"` (boxes_divulgacao_patronos).
 * Trocar de aba refetcha `slotsState` do zero pra essa variante (zero UI
 * otimista, mesmo padrão do resto do painel). */
let currentSlotsVariant = "default";

/** Snapshot do conteúdo dos slots A/B do PARA ENCERRAR (#4274) — `{slotA,
 * slotB, modifiedAt}`, `null` até o 1º GET /api/boxes/para-encerrar resolver.
 * `modifiedAt` é reenviado como `expectedModifiedAt` no PUT (mesmo guard de
 * mtime #3729 dos slots 0-3). Ao contrário de `slotsState`, o dirty-check é
 * simples (compara o valor atual do textarea contra o snapshot) — não há UI
 * otimista a proteger, só o guard de conflito de mtime. */
let paraEncerrarState = null;

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

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* corpo não-JSON — ok pra alguns erros */
  }
  return { ok: res.ok, status: res.status, body };
}

function renderList() {
  const list = boxes ?? [];
  el.count.textContent = String(list.length);
  el.loading.hidden = true;

  if (list.length === 0) {
    // #3874/R4: vazio explica onde e o que fazer — nunca uma lista que só
    // desaparece sem contexto.
    el.empty.hidden = false;
    el.empty.textContent = "Nenhuma caixa em context/snippets/.";
    el.list.innerHTML = "";
    return;
  }
  el.empty.hidden = true;

  el.list.innerHTML = "";
  for (const box of list) {
    const card = document.createElement("div");
    card.className = "box-card";
    // #4290: guard EXPLÍCITO contra null/undefined, não truthy check — `box.slot`
    // pode ser `0` (slot0, introdução), que é falsy em JS; `box.slot ? … : …`
    // esconderia o badge/desabilitação pra caixas no slot0.
    const hasSlot = box.slot !== null && box.slot !== undefined;
    const slotBadge = hasSlot ? `<span class="box-slot-badge">slot ${escapeHtml(String(box.slot))}</span>` : "";
    // #4275: badge SEPARADO da variante Patronos — mesmo guard explícito
    // contra null/undefined (slotPatronos pode ser 0, falsy em JS).
    const hasSlotPatronos = box.slotPatronos !== null && box.slotPatronos !== undefined;
    const slotPatronosBadge = hasSlotPatronos
      ? `<span class="box-slot-badge box-slot-badge-patronos">Patronos slot ${escapeHtml(String(box.slotPatronos))}</span>`
      : "";
    // #3981: rótulo exibido acima da caixa na newsletter (quando ocupa um slot ativo).
    const categoriaBadge = box.categoria ? `<span class="box-categoria-badge">${escapeHtml(box.categoria)}</span>` : "";
    const dirtyBadge = box.dirtyVsGit
      ? `<span class="box-dirty-badge" title="alteração local — entra no repo no próximo commit">modificado vs git</span>`
      : "";
    // #3928: arquivar (não deletar). Caixa em slot ativo (Padrão OU Patronos,
    // #4275) é auto-injetada em alguma edição — arquivá-la quebraria essa
    // montagem, então o botão fica desabilitado (o server também bloqueia
    // as duas variantes, defense-in-depth — ver `archiveBox`).
    const archiveBtn = hasSlot
      ? `<button type="button" class="cx-archive-btn" disabled title="Em uso no slot ${escapeHtml(String(box.slot))} — libere o slot na seção &quot;Slots de divulgação&quot; acima antes de arquivar">Arquivar</button>`
      : hasSlotPatronos
        ? `<button type="button" class="cx-archive-btn" disabled title="Em uso no slot ${escapeHtml(String(box.slotPatronos))} da variante Patronos — libere o slot na seção &quot;Slots de divulgação&quot; (aba Patronos) antes de arquivar">Arquivar</button>`
        : `<button type="button" class="cx-archive-btn" data-action="archive" data-slug="${escapeHtml(box.slug)}">Arquivar</button>`;
    // #3933: quando a caixa tem um nome interno explícito que difere do título
    // que renderiza na edição, mostra os dois — o nome (título do card) pra
    // identificar, e "na edição: …" pra saber o que o leitor vê.
    const contentTitleLine =
      box.nome && box.contentTitle && box.contentTitle !== box.title
        ? `<div class="box-content-title">na edição: ${escapeHtml(box.contentTitle)}</div>`
        : "";
    card.innerHTML = `
      <div class="box-card-head">
        <span class="box-title">${escapeHtml(box.title)}</span>
        ${slotBadge}
        ${slotPatronosBadge}
        ${categoriaBadge}
        ${dirtyBadge}
      </div>
      ${contentTitleLine}
      <div class="box-meta">
        <code>${escapeHtml(box.slug)}</code> · modificado ${fmtTime(box.mtimeIso)}
      </div>
      <div class="box-actions">
        <button type="button" data-action="edit" data-slug="${escapeHtml(box.slug)}">Editar</button>
        ${archiveBtn}
      </div>
    `;
    el.list.appendChild(card);
  }
}

function renderError(message) {
  if (message) {
    el.error.hidden = false;
    el.errorText.textContent = message;
  } else {
    el.error.hidden = true;
  }
}

// Chamada só no caminho de SUCESSO de fetchBoxes() — o caminho de falha
// chama renderError()/atualiza o statusbar diretamente (ver comentário lá:
// R3, "falha de rede ≠ dado ausente", não colapsar os dois caminhos aqui).
function renderAll() {
  renderError(null);
  renderList();
  renderSlotsSection(); // #3937: opções dos <select> dependem da lista de caixas
  el.lastUpdated.textContent = lastFetchedAt ? `atualizado ${fmtTime(lastFetchedAt)}` : "";
}

async function fetchBoxes() {
  setFetchStatus("", "carregando…");
  el.loading.hidden = boxes !== null; // só mostra "Carregando…" no 1º fetch — refresh reusa a lista já visível
  try {
    const { ok, status, body } = await fetchJson("/api/boxes");
    if (!ok) throw new Error(`HTTP ${status}`);
    boxes = body.boxes ?? [];
    lastFetchedAt = new Date().toISOString();
    setFetchStatus("ok", "ok");
  } catch (e) {
    setFetchStatus("down", "falha ao buscar /api/boxes");
    // #3874/R1/R3: `lastFetchedAt` NUNCA avança em falha — o timestamp
    // continua refletindo o último sucesso real, nunca a tentativa que
    // acabou de falhar. `boxes` também não é zerado (mantém a última lista
    // boa visível, com o erro sobreposto).
    renderError(`falha ao buscar /api/boxes: ${e.message ?? e}`);
    el.loading.hidden = true;
    el.lastUpdated.textContent = lastFetchedAt ? `atualizado ${fmtTime(lastFetchedAt)}` : "";
    return;
  }
  renderAll();
}

// ── #3937: gestão de slots de divulgação ──────────────────────────────────

/** Monta as `<option>` de um `<select>` de slot: "(vazio)" + 1 opção por
 * caixa VIVA (de `boxes`, já carregado por fetchBoxes()). Se a caixa
 * atualmente atribuída não estiver mais na lista viva (arquivada/removida
 * fora desta tela), ela ainda aparece como opção rotulada — pra o `<select>`
 * nunca silenciosamente cair pra "(vazio)" e mascarar um estado real do
 * disco que a UI ainda não resolveu. */
function buildSlotOptionsHtml(assignedSlug) {
  const list = boxes ?? [];
  const opts = ['<option value="">(vazio)</option>'];
  const seen = new Set();
  for (const box of list) {
    seen.add(box.slug);
    opts.push(`<option value="${escapeHtml(box.slug)}">${escapeHtml(box.title)}</option>`);
  }
  if (assignedSlug && !seen.has(assignedSlug)) {
    opts.push(`<option value="${escapeHtml(assignedSlug)}">${escapeHtml(assignedSlug)} (não encontrada em context/snippets/)</option>`);
  }
  return opts.join("");
}

/** Repopula os 4 `<select>` a partir de `slotsState` (atribuição atual) +
 * `boxes` (opções disponíveis). No-op antes do 1º GET /api/boxes/slots
 * resolver (`slotsState` ainda `null`) — chamado tanto por `renderAll()`
 * (toda vez que a lista de caixas atualiza) quanto por `fetchSlots()`
 * (quando a atribuição em si é recarregada), então os dois lados
 * (opções disponíveis e valor selecionado) ficam sempre em sincronia. */
function renderSlotsSection() {
  if (!slotsState) return;
  for (const key of SLOT_KEYS) {
    const select = SLOT_SELECTS[key];
    const assigned = slotsState[key] ?? "";
    select.innerHTML = buildSlotOptionsHtml(assigned);
    select.value = assigned;
  }
}

async function fetchSlots() {
  try {
    // #4275: `?variant=patronos` só quando a aba Patronos está ativa —
    // omitido (aba Padrão) cai no comportamento de sempre no server.
    const qs = currentSlotsVariant === "patronos" ? "?variant=patronos" : "";
    const { ok, status, body } = await fetchJson(`/api/boxes/slots${qs}`);
    if (!ok) throw new Error(`HTTP ${status}`);
    slotsState = body;
  } catch (e) {
    // Mesmo padrão de fetchArchived(): falha só dos slots não deve poluir o
    // painel inteiro — mantém o último snapshot bom (se houver) e segue.
    if (!slotsState) {
      el.slotsStatus.textContent = `Falha ao buscar atribuição de slots: ${e.message ?? e}`;
      el.slotsStatus.className = "cx-save-status err";
    }
    return;
  }
  renderSlotsSection();
}

/** Alterna a variante exibida (#4275) e refetcha do zero — zero UI
 * otimista, mesmo padrão do resto do painel. Descarta silenciosamente
 * qualquer seleção não salva no `<select>` (mesma disciplina do resto da
 * seção "Slots de divulgação", que não tem confirm() de dirty-check próprio
 * — é sempre "o que está salvo no disco"). */
function switchSlotsVariant(variant) {
  if (variant === currentSlotsVariant) return;
  currentSlotsVariant = variant;
  el.variantDefaultBtn.classList.toggle("active", variant === "default");
  el.variantDefaultBtn.setAttribute("aria-selected", String(variant === "default"));
  el.variantPatronosBtn.classList.toggle("active", variant === "patronos");
  el.variantPatronosBtn.setAttribute("aria-selected", String(variant === "patronos"));
  el.slotsStatus.textContent = "";
  el.slotsStatus.className = "cx-save-status";
  slotsState = null;
  fetchSlots();
}

async function saveSlots() {
  if (!slotsState) return;
  const input = {
    slot0: el.slot0Select.value,
    slot1: el.slot1Select.value,
    slot2: el.slot2Select.value,
    slot3: el.slot3Select.value,
    variant: currentSlotsVariant, // #4275
  };
  // Feedback client imediato (guard 2 espelhado — server é a autoridade final
  // e revalida de qualquer forma).
  const dupe = findDuplicateSlotAssignment(input);
  if (dupe) {
    el.slotsStatus.textContent = `A caixa "${dupe}" está atribuída a mais de um slot — cada caixa só pode ocupar 1 slot por vez.`;
    el.slotsStatus.className = "cx-save-status err";
    return;
  }

  const expectedModifiedAtAtSaveStart = slotsState.modifiedAt;
  el.slotsSaveBtn.disabled = true;
  el.slotsStatus.textContent = "Salvando…";
  el.slotsStatus.className = "cx-save-status";
  try {
    let { ok, status, body } = await fetchJson("/api/boxes/slots", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, expectedModifiedAt: expectedModifiedAtAtSaveStart }),
    });

    // #3729/#3937: 409 = platform.config.json mudou em disco desde o load —
    // outra aba/sessão salvou, ou edição manual do arquivo. OK sobrescreve
    // (retry com force:true); Cancelar recarrega o estado do disco.
    if (!ok && status === 409) {
      const overwrite = window.confirm(SLOTS_SAVE_CONFLICT_CONFIRM_MESSAGE);
      if (overwrite) {
        ({ ok, status, body } = await fetchJson("/api/boxes/slots", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...input, force: true }),
        }));
      } else {
        el.slotsStatus.textContent = "Não salvo — recarregando o estado mais recente do disco…";
        await fetchSlots();
        el.slotsStatus.textContent = "Recarregado — suas mudanças não salvas foram descartadas.";
        el.slotsSaveBtn.disabled = false;
        return;
      }
    }

    if (ok && body && body.ok) {
      el.slotsStatus.textContent = "Slots atualizados.";
      el.slotsStatus.className = "cx-save-status ok";
      // #3874/R5: zero UI otimista — refetcha slots + lista do servidor (o
      // badge "slot N" nos cards e as opções dos <select> vêm sempre do
      // disco, nunca de um cálculo local otimista).
      await Promise.all([fetchSlots(), fetchBoxes()]);
    } else {
      el.slotsStatus.textContent = `Erro ao salvar: ${(body && body.error) || "falha desconhecida"}`;
      el.slotsStatus.className = "cx-save-status err";
    }
  } catch (e) {
    el.slotsStatus.textContent = `Erro ao salvar: ${e.message ?? e}`;
    el.slotsStatus.className = "cx-save-status err";
  } finally {
    el.slotsSaveBtn.disabled = false;
  }
}

/** Repopula os 2 textareas a partir de `paraEncerrarState` (#4274). No-op
 * antes do 1º GET /api/boxes/para-encerrar resolver (`paraEncerrarState`
 * ainda `null`). */
function renderParaEncerrarSection() {
  if (!paraEncerrarState) return;
  el.paraEncerrarSlotA.value = paraEncerrarState.slotA ?? "";
  el.paraEncerrarSlotB.value = paraEncerrarState.slotB ?? "";
}

async function fetchParaEncerrar() {
  try {
    const { ok, status, body } = await fetchJson("/api/boxes/para-encerrar");
    if (!ok) throw new Error(`HTTP ${status}`);
    paraEncerrarState = body;
  } catch (e) {
    if (!paraEncerrarState) {
      el.paraEncerrarStatus.textContent = `Falha ao buscar PARA ENCERRAR: ${e.message ?? e}`;
      el.paraEncerrarStatus.className = "cx-save-status err";
    }
    return;
  }
  renderParaEncerrarSection();
}

async function saveParaEncerrarSlots() {
  if (!paraEncerrarState) return;
  const input = {
    slotA: el.paraEncerrarSlotA.value,
    slotB: el.paraEncerrarSlotB.value,
  };
  const expectedModifiedAtAtSaveStart = paraEncerrarState.modifiedAt;
  el.paraEncerrarSaveBtn.disabled = true;
  el.paraEncerrarStatus.textContent = "Salvando…";
  el.paraEncerrarStatus.className = "cx-save-status";
  try {
    let { ok, status, body } = await fetchJson("/api/boxes/para-encerrar", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, expectedModifiedAt: expectedModifiedAtAtSaveStart }),
    });

    // #3729/#4274: mesmo guard de mtime dos slots 0-3 — 409 = platform.config.json
    // mudou em disco desde o load.
    if (!ok && status === 409) {
      const overwrite = window.confirm(PARA_ENCERRAR_SAVE_CONFLICT_CONFIRM_MESSAGE);
      if (overwrite) {
        ({ ok, status, body } = await fetchJson("/api/boxes/para-encerrar", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...input, force: true }),
        }));
      } else {
        el.paraEncerrarStatus.textContent = "Não salvo — recarregando o estado mais recente do disco…";
        await fetchParaEncerrar();
        el.paraEncerrarStatus.textContent = "Recarregado — suas mudanças não salvas foram descartadas.";
        el.paraEncerrarSaveBtn.disabled = false;
        return;
      }
    }

    if (ok && body && body.ok) {
      el.paraEncerrarStatus.textContent = "PARA ENCERRAR atualizado.";
      el.paraEncerrarStatus.className = "cx-save-status ok";
      await fetchParaEncerrar();
    } else {
      el.paraEncerrarStatus.textContent = `Erro ao salvar: ${(body && body.error) || "falha desconhecida"}`;
      el.paraEncerrarStatus.className = "cx-save-status err";
    }
  } catch (e) {
    el.paraEncerrarStatus.textContent = `Erro ao salvar: ${e.message ?? e}`;
    el.paraEncerrarStatus.className = "cx-save-status err";
  } finally {
    el.paraEncerrarSaveBtn.disabled = false;
  }
}

function closeEditor() {
  if (dirty) {
    const proceed = window.confirm("Há edições não salvas nesta caixa. Descartar e fechar?");
    if (!proceed) return;
  }
  currentSlug = null;
  loadedModifiedAt = null;
  dirty = false;
  el.editorPanel.hidden = true;
  el.editorConteudo.value = "";
  el.editorNotas.value = "";
  el.editorNome.value = "";
  el.editorCategoria.value = "";
  el.editorTitulo.value = ""; // #4079
}

async function openEditor(slug) {
  if (currentSlug && currentSlug !== slug && dirty) {
    const proceed = window.confirm("Há edições não salvas na caixa atual. Descartar e trocar de caixa?");
    if (!proceed) return;
  }
  currentSlug = slug;
  dirty = false;
  loadedModifiedAt = null;
  el.editorPanel.hidden = false;
  el.editorTitle.textContent = "Editando…";
  el.editorFile.textContent = `context/snippets/${slug}`;
  el.editorConteudo.value = "";
  el.editorNotas.value = "";
  el.editorConteudo.disabled = true;
  el.editorNotas.disabled = true;
  el.editorLoadError.hidden = true;
  el.saveStatus.textContent = "";
  el.saveStatus.className = "cx-save-status";
  el.editorPanel.scrollIntoView({ behavior: "smooth", block: "start" });

  const { ok, body } = await fetchJson(`/api/boxes/${encodeURIComponent(slug)}`);
  el.editorConteudo.disabled = false;
  el.editorNotas.disabled = false;
  if (!ok || !body || !body.ok) {
    el.editorTitle.textContent = `context/snippets/${slug}`;
    el.editorLoadError.hidden = false;
    el.editorLoadError.textContent = `Erro ao carregar: ${(body && body.error) || "falha desconhecida"}`;
    return;
  }
  el.editorTitle.textContent = `context/snippets/${slug}`;
  // #3979: 2 painéis — "Conteúdo" (o que renderiza) e "Notas" (resto do
  // header de comentário, sem nome:/categoria:). Fallback pro `body` legado
  // (#3933, header inteiro menos nome:) se o server for antigo demais pra
  // devolver `conteudo`/`notas` separados.
  el.editorConteudo.value = body.conteudo ?? body.body ?? body.content;
  el.editorNotas.value = body.notas ?? "";
  el.editorNome.value = body.nome ?? "";
  el.editorCategoria.value = body.categoria ?? ""; // #3981
  el.editorTitulo.value = body.titulo ?? ""; // #4079
  loadedModifiedAt = body.modifiedAt ?? null;
}

async function saveCurrentBox() {
  if (!currentSlug) return;
  const slugAtSaveStart = currentSlug;
  // #3979/#3981/#4079: envia os 3 campos dedicados (nome, categoria, titulo) +
  // os 2 painéis (conteudo, notas) — o server reconstrói o header inteiro e
  // reescreve a 1ª linha do conteúdo a partir de `titulo` antes disso.
  const conteudoAtSaveStart = el.editorConteudo.value;
  const notasAtSaveStart = el.editorNotas.value;
  const nomeAtSaveStart = el.editorNome.value;
  const categoriaAtSaveStart = el.editorCategoria.value;
  const tituloAtSaveStart = el.editorTitulo.value;
  const expectedModifiedAtAtSaveStart = loadedModifiedAt;

  el.saveBtn.disabled = true;
  el.saveStatus.textContent = "Salvando…";
  el.saveStatus.className = "cx-save-status";
  const putUrl = `/api/boxes/${encodeURIComponent(slugAtSaveStart)}`;
  const putBody = () => ({
    nome: nomeAtSaveStart,
    categoria: categoriaAtSaveStart,
    notas: notasAtSaveStart,
    conteudo: conteudoAtSaveStart,
    titulo: tituloAtSaveStart,
    expectedModifiedAt: expectedModifiedAtAtSaveStart,
  });
  try {
    let { ok, status, body } = await fetchJson(putUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(putBody()),
    });

    // #3729 (reusado, ver caixas-guards.js): 409 = o mtime em disco mudou
    // desde o load — outra aba/sessão salvou por baixo. OK sobrescreve
    // (retry com force:true, sem expectedModifiedAt — já confirmado);
    // Cancelar recarrega a versão do disco, descartando a edição local.
    if (!ok && status === 409) {
      const overwrite = window.confirm(BOX_SAVE_CONFLICT_CONFIRM_MESSAGE);
      if (overwrite) {
        ({ ok, status, body } = await fetchJson(putUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nome: nomeAtSaveStart,
            categoria: categoriaAtSaveStart,
            notas: notasAtSaveStart,
            conteudo: conteudoAtSaveStart,
            titulo: tituloAtSaveStart,
            force: true,
          }),
        }));
      } else {
        el.saveStatus.textContent = "Não salvo — recarregando a versão mais recente do disco…";
        if (currentSlug === slugAtSaveStart) {
          dirty = false;
          await openEditor(slugAtSaveStart);
          el.saveStatus.textContent = "Recarregado — suas edições não salvas foram descartadas.";
        }
        el.saveBtn.disabled = false;
        return;
      }
    }

    if (ok && body && body.ok) {
      el.saveStatus.textContent = `Salvo ${fmtTime(body.modifiedAt)}`;
      el.saveStatus.className = "cx-save-status ok";
      if (currentSlug === slugAtSaveStart) {
        dirty = false;
        loadedModifiedAt = body.modifiedAt;
        // #4079: o campo Título pode ter feito o server reescrever a 1ª
        // linha de "Conteúdo" — resincroniza os 2 painéis com o disco pra o
        // textarea nunca ficar mostrando a 1ª linha ANTIGA até o próximo load.
        const synced = await fetchJson(`/api/boxes/${encodeURIComponent(slugAtSaveStart)}`);
        if (synced.ok && synced.body && synced.body.ok && currentSlug === slugAtSaveStart) {
          el.editorConteudo.value = synced.body.conteudo ?? synced.body.body ?? synced.body.content;
          el.editorTitulo.value = synced.body.titulo ?? "";
        }
      }
      // #3874/R5: zero UI otimista — refetcha a lista do servidor em vez de
      // atualizar o card localmente (mtime/dirtyVsGit vêm sempre do disco).
      await fetchBoxes();
    } else {
      el.saveStatus.textContent = `Erro ao salvar: ${(body && body.error) || "falha desconhecida"}`;
      el.saveStatus.className = "cx-save-status err";
    }
  } catch (e) {
    el.saveStatus.textContent = `Erro ao salvar: ${e.message ?? e}`;
    el.saveStatus.className = "cx-save-status err";
  } finally {
    el.saveBtn.disabled = false;
  }
}

// ── #3928: arquivar (não deletar) ─────────────────────────────────────────

/** Arquiva uma caixa (move pra `_arquivo/`, some da lista, conteúdo
 * preservado). Confirma antes; 409 = bloqueada por slot (defense-in-depth do
 * server — não deveria acontecer porque o botão já vem desabilitado, mas se
 * acontecer mostramos o motivo). Refetcha as duas listas ao final. */
async function archiveBoxAction(slug) {
  if (!window.confirm(boxArchiveConfirmMessage(slug))) return;
  const { ok, status, body } = await fetchJson(`/api/boxes/${encodeURIComponent(slug)}/archive`, { method: "POST" });
  if (!ok) {
    const reason = (body && body.error) || `HTTP ${status}`;
    renderError(`Não foi possível arquivar "${slug}": ${reason}`);
    return;
  }
  renderError(null);
  archivedExpanded = true; // mostra a arquivada recém-criada
  await Promise.all([fetchBoxes(), fetchArchived()]);
}

/** Restaura uma caixa arquivada (move de volta pra `context/snippets/`). 409 =
 * já existe caixa viva com o mesmo slug. */
async function restoreBoxAction(slug) {
  const { ok, status, body } = await fetchJson(`/api/boxes/${encodeURIComponent(slug)}/unarchive`, { method: "POST" });
  if (!ok) {
    const reason = (body && body.error) || `HTTP ${status}`;
    renderError(`Não foi possível restaurar "${slug}": ${reason}`);
    return;
  }
  renderError(null);
  await Promise.all([fetchBoxes(), fetchArchived()]);
}

function renderArchivedList() {
  const list = archived ?? [];
  el.archivedCount.textContent = String(list.length);
  el.archivedToggle.setAttribute("aria-expanded", String(archivedExpanded));
  el.archivedToggle.classList.toggle("expanded", archivedExpanded);
  el.archivedHint.hidden = !archivedExpanded;

  if (!archivedExpanded) {
    el.archivedList.hidden = true;
    el.archivedEmpty.hidden = true;
    return;
  }
  if (list.length === 0) {
    el.archivedList.hidden = true;
    el.archivedEmpty.hidden = false;
    return;
  }
  el.archivedEmpty.hidden = true;
  el.archivedList.hidden = false;
  el.archivedList.innerHTML = "";
  for (const box of list) {
    const card = document.createElement("div");
    card.className = "box-card box-card-archived";
    card.innerHTML = `
      <div class="box-card-head">
        <span class="box-title">${escapeHtml(box.title)}</span>
        <span class="box-archived-badge">arquivada</span>
      </div>
      <div class="box-meta">
        <code>${escapeHtml(box.slug)}</code> · arquivada ${fmtTime(box.mtimeIso)}
      </div>
      <div class="box-actions">
        <button type="button" data-action="restore" data-slug="${escapeHtml(box.slug)}">Restaurar</button>
      </div>
    `;
    el.archivedList.appendChild(card);
  }
}

async function fetchArchived() {
  try {
    const { ok, status, body } = await fetchJson("/api/boxes/archived");
    if (!ok) throw new Error(`HTTP ${status}`);
    archived = body.boxes ?? [];
  } catch {
    // Falha só da lista de arquivadas não deve poluir o painel inteiro —
    // mantém o último snapshot bom (ou vazio) e segue.
    if (archived === null) archived = [];
  }
  renderArchivedList();
}

// ── #3928: criar caixa nova ───────────────────────────────────────────────

function openCreatePanel() {
  el.createSlug.value = "";
  el.createNome.value = "";
  el.createCategoria.value = "";
  el.createContent.value = "";
  el.createStatus.textContent = "";
  el.createStatus.className = "cx-save-status";
  el.createPanel.hidden = false;
  el.createPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  el.createSlug.focus();
}

function closeCreatePanel() {
  el.createPanel.hidden = true;
}

async function submitNewBox() {
  const check = validateNewBoxSlug(el.createSlug.value);
  if (!check.ok) {
    el.createStatus.textContent = check.error;
    el.createStatus.className = "cx-save-status err";
    el.createSlug.focus();
    return;
  }
  el.createSubmitBtn.disabled = true;
  el.createStatus.textContent = "Criando…";
  el.createStatus.className = "cx-save-status";
  try {
    const { ok, status, body } = await fetchJson("/api/boxes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: check.slug,
        nome: el.createNome.value,
        categoria: el.createCategoria.value, // #3981
        content: el.createContent.value,
      }),
    });
    if (ok && body && body.ok) {
      el.createStatus.textContent = `Criada ${fmtTime(body.modifiedAt)}`;
      el.createStatus.className = "cx-save-status ok";
      await fetchBoxes();
      closeCreatePanel();
      // Abre direto no editor pra continuar preenchendo.
      openEditor(check.slug);
    } else {
      el.createStatus.textContent = `Erro ao criar: ${(body && body.error) || `HTTP ${status}`}`;
      el.createStatus.className = "cx-save-status err";
    }
  } catch (e) {
    el.createStatus.textContent = `Erro ao criar: ${e.message ?? e}`;
    el.createStatus.className = "cx-save-status err";
  } finally {
    el.createSubmitBtn.disabled = false;
  }
}

el.refreshBtn.addEventListener("click", () => {
  fetchBoxes();
  fetchArchived();
  fetchSlots();
  fetchParaEncerrar();
});
el.slotsSaveBtn.addEventListener("click", () => saveSlots());
el.variantDefaultBtn.addEventListener("click", () => switchSlotsVariant("default"));
el.variantPatronosBtn.addEventListener("click", () => switchSlotsVariant("patronos"));
el.paraEncerrarSaveBtn.addEventListener("click", () => saveParaEncerrarSlots());
el.retryBtn.addEventListener("click", () => fetchBoxes());
el.closeEditorBtn.addEventListener("click", () => closeEditor());
el.saveBtn.addEventListener("click", () => saveCurrentBox());
el.editorConteudo.addEventListener("input", () => {
  dirty = true;
});
el.editorNotas.addEventListener("input", () => {
  dirty = true;
});
el.editorNome.addEventListener("input", () => {
  dirty = true;
});
el.editorCategoria.addEventListener("input", () => {
  dirty = true;
});
el.editorTitulo.addEventListener("input", () => {
  dirty = true;
});

el.newBoxBtn.addEventListener("click", () => openCreatePanel());
el.createCancelBtn.addEventListener("click", () => closeCreatePanel());
el.createSubmitBtn.addEventListener("click", () => submitNewBox());

el.archivedToggle.addEventListener("click", () => {
  archivedExpanded = !archivedExpanded;
  renderArchivedList();
});

el.list.addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-action]");
  if (!btn) return;
  if (btn.dataset.action === "edit") openEditor(btn.dataset.slug);
  else if (btn.dataset.action === "archive") archiveBoxAction(btn.dataset.slug);
});

el.archivedList.addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-action]");
  if (!btn) return;
  if (btn.dataset.action === "restore") restoreBoxAction(btn.dataset.slug);
});

fetchBoxes();
fetchArchived();
fetchSlots();
fetchParaEncerrar();
