// revisao.js (#3559) — painel de revisão de conteúdo rica: editor + diff +
// lints inline + preview do e-mail + ações rápidas. Vanilla JS, sem build
// step (mesmo princípio de app.js/edicao.js — zero-custo, sem lib nova).
//
// Fluxo: GET /api/editions/:aammdd/review/:slug traz {content, baseline,
// exists, pull}. O editor edita LOCALMENTE no textarea (nada é enviado até
// clicar "Salvar" — PUT do mesmo endpoint). Diff/lint/preview são sob
// demanda (botões), lendo sempre o que está SALVO no disco — não o
// conteúdo ainda-não-salvo do textarea (documentado no hint da UI).

import { buildRewriteTitlePrompt, buildRegenerateImagePrompt } from "./revisao-prompts.js";

const SLUGS = ["categorized", "reviewed", "social"];
const FILE_LABELS = {
  categorized: "01-categorized.md",
  reviewed: "02-reviewed.md",
  social: "03-social.md",
};

function getAammddFromPath() {
  const m = location.pathname.match(/^\/revisao\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

const aammdd = getAammddFromPath();
let currentSlug = "reviewed";
let dirty = false;

const el = {
  backLink: document.getElementById("back-link"),
  titulo: document.getElementById("rv-titulo"),
  arquivo: document.getElementById("rv-arquivo"),
  connDot: document.getElementById("conn-dot"),
  connLabel: document.getElementById("conn-label"),
  notFound: document.getElementById("rv-not-found"),
  tabs: document.getElementById("rv-tabs"),
  fileStatus: document.getElementById("rv-file-status"),
  pullStatus: document.getElementById("rv-pull-status"),
  editor: document.getElementById("rv-editor"),
  saveBtn: document.getElementById("rv-save-btn"),
  diffBtn: document.getElementById("rv-diff-btn"),
  lintBtn: document.getElementById("rv-lint-btn"),
  resetBaselineBtn: document.getElementById("rv-reset-baseline-btn"),
  saveStatus: document.getElementById("rv-save-status"),
  sideTabs: document.getElementById("rv-side-tabs"),
  paneLint: document.getElementById("rv-pane-lint"),
  paneDiff: document.getElementById("rv-pane-diff"),
  panePreview: document.getElementById("rv-pane-preview"),
  lintResults: document.getElementById("rv-lint-results"),
  diffView: document.getElementById("rv-diff-view"),
  previewFrame: document.getElementById("rv-preview-frame"),
  previewRefreshBtn: document.getElementById("rv-preview-refresh-btn"),
  swapPromote: document.getElementById("rv-swap-promote"),
  swapDemote: document.getElementById("rv-swap-demote"),
  swapDrop: document.getElementById("rv-swap-drop"),
  swapPreviewBtn: document.getElementById("rv-swap-preview-btn"),
  swapApplyBtn: document.getElementById("rv-swap-apply-btn"),
  swapResult: document.getElementById("rv-swap-result"),
  titleDestaque: document.getElementById("rv-title-destaque"),
  titleInstrucao: document.getElementById("rv-title-instrucao"),
  titleFillBtn: document.getElementById("rv-title-fill-btn"),
  titleWarn: document.getElementById("rv-title-warn"),
  imageDestaque: document.getElementById("rv-image-destaque"),
  imageInstrucao: document.getElementById("rv-image-instrucao"),
  imageFillBtn: document.getElementById("rv-image-fill-btn"),
  imageWarn: document.getElementById("rv-image-warn"),
};

function setConn(status) {
  el.connDot.className = "dot " + status;
  el.connLabel.textContent = status === "ok" ? "conectado" : status === "down" ? "desconectado" : "conectando…";
}

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch { /* corpo não-JSON — ok pra alguns erros */ }
  return { ok: res.ok, status: res.status, body };
}

function renderTabs() {
  el.tabs.querySelectorAll(".rv-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.slug === currentSlug);
  });
  el.arquivo.textContent = FILE_LABELS[currentSlug];
}

async function loadFile(slug, { force } = {}) {
  if (dirty && !force) {
    const proceed = window.confirm("Há edições não salvas neste arquivo. Descartar e trocar de aba?");
    if (!proceed) return;
  }
  currentSlug = slug;
  renderTabs();
  el.editor.value = "";
  el.editor.disabled = true;
  el.fileStatus.textContent = "Carregando…";
  el.pullStatus.textContent = "";
  dirty = false;

  const { ok, body } = await fetchJson(`/api/editions/${encodeURIComponent(aammdd)}/review/${slug}`);
  el.editor.disabled = false;
  if (!ok || !body || !body.ok) {
    el.fileStatus.textContent = `Erro ao carregar: ${(body && body.error) || "falha desconhecida"}`;
    return;
  }
  if (!body.exists) {
    el.fileStatus.textContent = `${FILE_LABELS[slug]} ainda não existe nesta edição.`;
    el.editor.placeholder = "Arquivo ainda não gerado pelo pipeline.";
    return;
  }
  el.editor.value = body.content;
  el.fileStatus.textContent = `Modificado ${fmtTime(body.modifiedAt)}`;
  if (body.pull && body.pull.attempted) {
    el.pullStatus.textContent = body.pull.ok
      ? "Pull do Drive (#494) ok antes de abrir."
      : `Pull do Drive não concluiu (fail-soft, ignorado): ${body.pull.error || "motivo desconhecido"}`;
  } else {
    el.pullStatus.textContent = "";
  }
}

async function saveCurrent() {
  el.saveStatus.textContent = "Salvando…";
  el.saveStatus.className = "rv-save-status";
  const { ok, body } = await fetchJson(`/api/editions/${encodeURIComponent(aammdd)}/review/${currentSlug}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: el.editor.value }),
  });
  if (ok && body && body.ok) {
    dirty = false;
    el.saveStatus.textContent = `Salvo ${fmtTime(body.modifiedAt)}`;
    el.saveStatus.className = "rv-save-status ok";
    el.fileStatus.textContent = `Modificado ${fmtTime(body.modifiedAt)}`;
  } else {
    el.saveStatus.textContent = `Erro ao salvar: ${(body && body.error) || "falha desconhecida"}`;
    el.saveStatus.className = "rv-save-status err";
  }
}

function renderDiff(diffBody) {
  el.diffView.innerHTML = "";
  if (!diffBody || !diffBody.ok) {
    el.diffView.innerHTML = `<p class="hint">Erro ao computar diff: ${(diffBody && diffBody.error) || "falha desconhecida"}</p>`;
    return;
  }
  if (diffBody.isEmpty) {
    el.diffView.innerHTML = '<p class="hint">Sem diferenças em relação ao baseline (versão gerada pelo agente).</p>';
    return;
  }
  for (const line of diffBody.lines) {
    if (line.type === "equal") continue; // #3559: só mostra add/del — equal em excesso não ajuda revisão
    const row = document.createElement("div");
    row.className = `rv-diff-line ${line.type}`;
    const gutter = document.createElement("span");
    gutter.className = "rv-diff-gutter";
    gutter.textContent = line.type === "add" ? "+" : "-";
    const text = document.createElement("span");
    text.textContent = line.text;
    row.appendChild(gutter);
    row.appendChild(text);
    el.diffView.appendChild(row);
  }
  if (!el.diffView.children.length) {
    el.diffView.innerHTML = '<p class="hint">Sem diferenças em relação ao baseline.</p>';
  }
}

async function runDiff() {
  el.diffView.innerHTML = '<p class="hint">Calculando…</p>';
  const { body } = await fetchJson(`/api/editions/${encodeURIComponent(aammdd)}/review/${currentSlug}/diff`);
  renderDiff(body);
  activateSidePane("diff");
}

function renderLints(report) {
  el.lintResults.innerHTML = "";
  if (!report) {
    el.lintResults.innerHTML = '<p class="hint">Erro ao rodar lints.</p>';
    return;
  }
  if (report.note) {
    el.lintResults.innerHTML = `<p class="hint">${report.note}</p>`;
    return;
  }
  if (!report.checks || report.checks.length === 0) {
    el.lintResults.innerHTML = '<p class="hint">Nenhum lint aplicável a este arquivo.</p>';
    return;
  }
  for (const check of report.checks) {
    const row = document.createElement("div");
    const state = check.crashed ? "warn" : check.ok ? "ok" : check.blocking ? "fail" : "warn";
    row.className = `rv-lint-row ${state}`;
    const badge = document.createElement("span");
    badge.className = "rv-lint-badge";
    badge.textContent = check.crashed ? "erro" : check.ok ? "ok" : check.blocking ? "falha" : "aviso";
    const label = document.createElement("span");
    label.className = "rv-lint-label";
    label.textContent = check.label;
    row.appendChild(badge);
    row.appendChild(label);
    if (!check.ok) {
      const detail = document.createElement("div");
      detail.className = "rv-lint-detail";
      detail.textContent = check.crashed
        ? `Check falhou ao rodar: ${check.error}`
        : JSON.stringify(check.detail, null, 2).slice(0, 2000);
      row.appendChild(detail);
    }
    el.lintResults.appendChild(row);
  }
  if (report.skipped && report.skipped.length) {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = `Checks pulados (pré-requisito ausente): ${report.skipped.join(", ")}`;
    el.lintResults.appendChild(note);
  }
}

async function runLints() {
  el.lintResults.innerHTML = '<p class="hint">Rodando…</p>';
  const { body } = await fetchJson(`/api/editions/${encodeURIComponent(aammdd)}/review/${currentSlug}/lint`);
  renderLints(body);
  activateSidePane("lint");
}

async function resetBaselineCurrent() {
  const proceed = window.confirm("Isso torna o conteúdo ATUAL em disco o novo baseline de comparação. Continuar?");
  if (!proceed) return;
  const { ok, body } = await fetchJson(`/api/editions/${encodeURIComponent(aammdd)}/review/${currentSlug}/reset-baseline`, { method: "POST" });
  if (ok && body && body.ok) {
    el.saveStatus.textContent = "Baseline resetado — diff agora compara contra o conteúdo atual.";
    el.saveStatus.className = "rv-save-status ok";
  } else {
    el.saveStatus.textContent = `Erro ao resetar baseline: ${(body && body.error) || "falha desconhecida"}`;
    el.saveStatus.className = "rv-save-status err";
  }
}

function refreshPreview() {
  // Cache-bust: o iframe não deve mostrar preview obsoleto depois de um save.
  el.previewFrame.src = `/api/editions/${encodeURIComponent(aammdd)}/preview.html?t=${Date.now()}`;
}

function activateSidePane(pane) {
  el.sideTabs.querySelectorAll(".rv-tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.pane === pane));
  el.paneLint.hidden = pane !== "lint";
  el.paneDiff.hidden = pane !== "diff";
  el.panePreview.hidden = pane !== "preview";
  if (pane === "preview") refreshPreview();
}

async function runSwap(dryRun) {
  const promote = el.swapPromote.value.trim();
  const demote = el.swapDemote.value;
  const drop = el.swapDrop.checked;
  if (!promote) {
    el.swapResult.textContent = "Preencha 'Promover (bucket:índice)' antes.";
    return;
  }
  if (!dryRun) {
    const proceed = window.confirm(
      `Aplicar swap de verdade — promove "${promote}" e substitui ${demote.toUpperCase()}${drop ? " (descartando-o)" : ""}. Confirma?`,
    );
    if (!proceed) return;
  }
  el.swapResult.textContent = dryRun ? "Pré-visualizando…" : "Aplicando…";
  const { body } = await fetchJson(`/api/editions/${encodeURIComponent(aammdd)}/actions/swap-destaque`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ promote, demote, drop, dryRun }),
  });
  el.swapResult.textContent = JSON.stringify(body, null, 2);
  if (body && body.ok && !dryRun) {
    // #3559: o swap real reescreve 02-reviewed.md no disco — recarrega o
    // arquivo aberto (se for o afetado) pra refletir a mudança.
    if (currentSlug === "reviewed") await loadFile("reviewed", { force: true });
  }
}

// #3629: os dois ganchos "Reescrever título"/"Regenerar imagem" NÃO chamam
// script/API diretamente — montam um prompt (função pura, ver
// revisao-prompts.js) e pré-preenchem o textarea do chat drawer
// (`window.diariaStudioChat.prefillMessage`, ver chat-drawer.js), sem
// enviar. O editor revisa/edita o prompt e manda manualmente. Fail-soft: se
// chat-drawer.js não carregou por algum motivo (ordem de script, erro de
// rede), mostra um aviso na própria card em vez de lançar erro no console.
function fillChatOrWarn(prompt, warnEl) {
  warnEl.hidden = true;
  if (!window.diariaStudioChat || typeof window.diariaStudioChat.prefillMessage !== "function") {
    warnEl.textContent = "Chat indisponível nesta página (chat-drawer.js não carregou) — copie o prompt manualmente.";
    warnEl.hidden = false;
    return;
  }
  window.diariaStudioChat.prefillMessage(prompt);
}

function fillRewriteTitlePrompt() {
  const prompt = buildRewriteTitlePrompt({
    aammdd,
    destaque: el.titleDestaque.value,
    instrucao: el.titleInstrucao.value,
  });
  fillChatOrWarn(prompt, el.titleWarn);
}

function fillRegenerateImagePrompt() {
  const prompt = buildRegenerateImagePrompt({
    aammdd,
    destaque: el.imageDestaque.value,
    instrucao: el.imageInstrucao.value,
  });
  fillChatOrWarn(prompt, el.imageWarn);
}

function bindEvents() {
  el.tabs.querySelectorAll(".rv-tab").forEach((btn) => {
    btn.addEventListener("click", () => loadFile(btn.dataset.slug));
  });
  el.sideTabs.querySelectorAll(".rv-tab").forEach((btn) => {
    btn.addEventListener("click", () => activateSidePane(btn.dataset.pane));
  });
  el.editor.addEventListener("input", () => {
    dirty = true;
    el.saveStatus.textContent = "Não salvo";
    el.saveStatus.className = "rv-save-status";
  });
  el.saveBtn.addEventListener("click", saveCurrent);
  el.diffBtn.addEventListener("click", runDiff);
  el.lintBtn.addEventListener("click", runLints);
  el.resetBaselineBtn.addEventListener("click", resetBaselineCurrent);
  el.previewRefreshBtn.addEventListener("click", refreshPreview);
  el.swapPreviewBtn.addEventListener("click", () => runSwap(true));
  el.swapApplyBtn.addEventListener("click", () => runSwap(false));
  el.titleFillBtn.addEventListener("click", fillRewriteTitlePrompt);
  el.imageFillBtn.addEventListener("click", fillRegenerateImagePrompt);
  window.addEventListener("beforeunload", (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  });
}

async function checkEditionExists() {
  const res = await fetch(`/api/editions/${encodeURIComponent(aammdd)}`);
  if (res.status === 404 || res.status === 400) return false;
  return res.ok;
}

async function init() {
  if (!aammdd) {
    el.titulo.textContent = "AAMMDD ausente na URL";
    el.notFound.hidden = false;
    el.notFound.textContent = "URL inválida — use /revisao/AAMMDD.";
    return;
  }
  el.titulo.textContent = aammdd;
  document.title = `Diar.ia Studio — Revisão ${aammdd}`;
  el.backLink.href = `/edicao/${aammdd}`;

  const exists = await checkEditionExists();
  el.notFound.hidden = exists;
  if (!exists) return;

  bindEvents();
  renderTabs();
  await loadFile(currentSlug);
  setConn("ok");
}

init();
