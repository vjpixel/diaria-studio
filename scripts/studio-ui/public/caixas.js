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
// Criação de caixa nova está fora de escopo desta issue.

import {
  BOX_SAVE_CONFLICT_CONFIRM_MESSAGE,
  boxArchiveConfirmMessage,
  validateNewBoxSlug,
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
  editor: document.getElementById("editor"),
  editorLoadError: document.getElementById("editor-load-error"),
  saveBtn: document.getElementById("save-btn"),
  closeEditorBtn: document.getElementById("close-editor-btn"),
  saveStatus: document.getElementById("save-status"),
  // #3928: criar caixa nova
  newBoxBtn: document.getElementById("new-box-btn"),
  createPanel: document.getElementById("create-panel"),
  createSlug: document.getElementById("create-slug"),
  createNome: document.getElementById("create-nome"),
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
    const slotBadge = box.slot ? `<span class="box-slot-badge">slot ${escapeHtml(String(box.slot))}</span>` : "";
    const dirtyBadge = box.dirtyVsGit
      ? `<span class="box-dirty-badge" title="alteração local — entra no repo no próximo commit">modificado vs git</span>`
      : "";
    // #3928: arquivar (não deletar). Caixa em slot ativo é auto-injetada em
    // toda newsletter — arquivá-la quebraria o pipeline, então o botão fica
    // desabilitado (o server também bloqueia, defense-in-depth).
    const archiveBtn = box.slot
      ? `<button type="button" class="cx-archive-btn" disabled title="Em uso no slot ${escapeHtml(String(box.slot))} — remova a atribuição em platform.config.json antes de arquivar">Arquivar</button>`
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

function closeEditor() {
  if (dirty) {
    const proceed = window.confirm("Há edições não salvas nesta caixa. Descartar e fechar?");
    if (!proceed) return;
  }
  currentSlug = null;
  loadedModifiedAt = null;
  dirty = false;
  el.editorPanel.hidden = true;
  el.editor.value = "";
  el.editorNome.value = "";
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
  el.editor.value = "";
  el.editor.disabled = true;
  el.editorLoadError.hidden = true;
  el.saveStatus.textContent = "";
  el.saveStatus.className = "cx-save-status";
  el.editorPanel.scrollIntoView({ behavior: "smooth", block: "start" });

  const { ok, body } = await fetchJson(`/api/boxes/${encodeURIComponent(slug)}`);
  el.editor.disabled = false;
  if (!ok || !body || !body.ok) {
    el.editorTitle.textContent = `context/snippets/${slug}`;
    el.editorLoadError.hidden = false;
    el.editorLoadError.textContent = `Erro ao carregar: ${(body && body.error) || "falha desconhecida"}`;
    return;
  }
  el.editorTitle.textContent = `context/snippets/${slug}`;
  // #3933: o textarea mostra o BODY (sem a linha `nome:`); o nome interno vai
  // no campo dedicado. Fallback pra `content` bruto se o server for antigo.
  el.editor.value = body.body ?? body.content;
  el.editorNome.value = body.nome ?? "";
  loadedModifiedAt = body.modifiedAt ?? null;
}

async function saveCurrentBox() {
  if (!currentSlug) return;
  const slugAtSaveStart = currentSlug;
  // #3933: envia `nome` (campo dedicado) + `body` (textarea) — o server
  // reconstrói o conteúdo (upsert do `nome:` no header).
  const bodyAtSaveStart = el.editor.value;
  const nomeAtSaveStart = el.editorNome.value;
  const expectedModifiedAtAtSaveStart = loadedModifiedAt;

  el.saveBtn.disabled = true;
  el.saveStatus.textContent = "Salvando…";
  el.saveStatus.className = "cx-save-status";
  const putUrl = `/api/boxes/${encodeURIComponent(slugAtSaveStart)}`;
  try {
    let { ok, status, body } = await fetchJson(putUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome: nomeAtSaveStart, body: bodyAtSaveStart, expectedModifiedAt: expectedModifiedAtAtSaveStart }),
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
          body: JSON.stringify({ nome: nomeAtSaveStart, body: bodyAtSaveStart, force: true }),
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
      body: JSON.stringify({ slug: check.slug, nome: el.createNome.value, content: el.createContent.value }),
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
});
el.retryBtn.addEventListener("click", () => fetchBoxes());
el.closeEditorBtn.addEventListener("click", () => closeEditor());
el.saveBtn.addEventListener("click", () => saveCurrentBox());
el.editor.addEventListener("input", () => {
  dirty = true;
});
el.editorNome.addEventListener("input", () => {
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
