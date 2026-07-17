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
import { shouldConfirmDivergenceGuard, DIVERGENCE_CONFIRM_MESSAGE } from "./revisao-guards.js";

const SLUGS = ["categorized", "reviewed", "social", "html-final"];
const FILE_LABELS = {
  categorized: "01-categorized.md",
  reviewed: "02-reviewed.md",
  social: "03-social.md",
  "html-final": "_internal/newsletter-final.html",
};

function getAammddFromPath() {
  const m = location.pathname.match(/^\/revisao\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

const aammdd = getAammddFromPath();
let currentSlug = "reviewed";
let dirty = false;
// #3635: true quando o HTML final salvo em disco diverge do baseline
// (versão que a Etapa 4 gerou) — atualizado por refreshDivergenceBanner(),
// consultado por saveCurrent() antes de salvar o slug `reviewed` (#3668 gap
// 2: só 02-reviewed.md alimenta o render do HTML final — 01-categorized.md e
// 03-social.md não têm vínculo causal com o risco, ver
// shouldConfirmDivergenceGuard em revisao-guards.js). Esta flag em memória é
// só o valor usado pra pintar o banner — saveCurrent() sempre re-busca o
// estado fresco do servidor antes de decidir mostrar o confirm() (#3668 gap
// 3: evita TOCTOU de aba aberta há tempo ou edição concorrente).
let htmlFinalDiverged = false;

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
  htmlFinalNote: document.getElementById("rv-html-final-note"),
  divergenceBanner: document.getElementById("rv-divergence-banner"),
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
  previewHint: document.getElementById("rv-preview-hint"),
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

// #3663: rótulo + hint da aba lateral "Preview" mudam conforme o arquivo
// ativo — o preview de e-mail (02-reviewed.md) e o preview social
// (03-social.md) são endpoints distintos (ver refreshPreview()).
const PREVIEW_TAB_LABELS = {
  categorized: "Preview do e-mail",
  reviewed: "Preview do e-mail",
  social: "Preview social",
  "html-final": "Preview do e-mail",
};
// innerHTML (não textContent): conteúdo estático próprio (sem input do
// editor), preserva o <code>/<strong> do markup original em vez de virar
// texto corrido sem formatação.
const PREVIEW_HINTS = {
  social:
    "Renderizado a partir de <code>03-social.md</code> salvo no disco (mesmo renderer " +
    "da Etapa 4, #1800) — posts de LinkedIn/Facebook/Instagram lado a lado, com quebras " +
    "de linha e hashtags como aparecem publicados. Salve antes de atualizar o preview.",
  default:
    "Renderizado a partir de <code>02-reviewed.md</code> salvo no disco (mesmo caminho " +
    "do Stage 4) — salve antes de atualizar o preview. Exceção: com a aba " +
    "<strong>HTML final</strong> ativa, mostra o <code>_internal/newsletter-final.html</code> " +
    "salvo diretamente (sem passar pelo Markdown).",
};

function renderTabs() {
  el.tabs.querySelectorAll(".rv-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.slug === currentSlug);
  });
  el.arquivo.textContent = FILE_LABELS[currentSlug];
  el.htmlFinalNote.hidden = currentSlug !== "html-final";
  const previewTabBtn = el.sideTabs.querySelector('[data-pane="preview"]');
  if (previewTabBtn) previewTabBtn.textContent = PREVIEW_TAB_LABELS[currentSlug] || PREVIEW_TAB_LABELS.reviewed;
  if (el.previewHint) el.previewHint.innerHTML = PREVIEW_HINTS[currentSlug] || PREVIEW_HINTS.default;
}

// #3635: consulta a mesma rota genérica de diff (`.../review/html-final/diff`)
// já roteada por isReviewSlug/REVIEW_FILES — sem endpoint novo. `isEmpty`
// vem `true` tanto quando o arquivo ainda não existe quanto quando não há
// diferença vs. baseline (ambos os casos: nada a avisar). Chamado
// independente da aba atual, pra avisar mesmo quem está editando o
// Markdown (o risco real é justamente re-renderizar o MD por cima do HTML
// editado manualmente).
async function refreshDivergenceBanner() {
  const { body } = await fetchJson(`/api/editions/${encodeURIComponent(aammdd)}/review/html-final/diff`);
  htmlFinalDiverged = !!(body && body.ok && body.isEmpty === false);
  el.divergenceBanner.hidden = !htmlFinalDiverged;
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
    refreshPreviewIfOpen();
    return;
  }
  if (!body.exists) {
    el.fileStatus.textContent = `${FILE_LABELS[slug]} ainda não existe nesta edição.`;
    el.editor.placeholder = "Arquivo ainda não gerado pelo pipeline.";
    refreshPreviewIfOpen();
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
  refreshPreviewIfOpen();
}

// #3669 bug 1: trocar de aba de documento (categorized/reviewed/social/
// html-final) só atualizava `currentSlug`/`renderTabs()` — o iframe de
// preview ficava com o conteúdo da aba anterior até um clique explícito na
// aba lateral "Preview" ou no botão "Atualizar preview". Chamado ao final de
// loadFile() (todos os caminhos de saída) SE o painel lateral Preview já
// estiver aberto — reusa refreshPreview(), que já sabe o endpoint certo pro
// `currentSlug` atualizado.
function refreshPreviewIfOpen() {
  if (!el.panePreview.hidden) refreshPreview().catch(showPreviewError);
}

async function saveCurrent() {
  // #3672: SNAPSHOT de slug/conteúdo capturado ANTES de qualquer espera
  // assíncrona — fecha a condição de corrida introduzida pela nova chamada a
  // refreshDivergenceBanner() (que aguarda rede) adicionada no #3671 (gap 3).
  // Sem o snapshot, `currentSlug`/`el.editor.value` são lidos
  // AO VIVO no PUT final: se o editor clicar noutra aba durante o guard (
  // loadFile() reatribui ambos SINCRONAMENTE, incluindo `el.editor.value = ""`,
  // antes do próprio fetch do novo arquivo completar), o PUT podia gravar
  // string vazia no arquivo ERRADO (o da aba nova, não o que estava sendo
  // salvo). Usar os valores capturados aqui — nunca os `currentSlug`/
  // `el.editor.value` ao vivo — no guard e no PUT elimina a corrida de forma
  // robusta, independente de qualquer trava de UI.
  const slugAtSaveStart = currentSlug;
  const contentAtSaveStart = el.editor.value;
  el.saveBtn.disabled = true;
  try {
    // #3635/#3668: guard — salvar 02-reviewed.md enquanto o HTML final já
    // diverge do baseline é o risco: um re-render futuro do HTML a partir do
    // Markdown (rodar a Etapa 4 de novo) descarta essa divergência sem aviso
    // nenhum da pipeline. shouldConfirmDivergenceGuard restringe o disparo ao
    // único slug com vínculo causal real (#3668 gap 2 — 01-categorized.md e
    // 03-social.md não alimentam o render do HTML, não bloqueiam mais).
    if (shouldConfirmDivergenceGuard(slugAtSaveStart)) {
      // #3668 gap 3 (TOCTOU): a flag em memória só é atualizada em init() e
      // logo após salvar/resetar o próprio slug html-final — uma aba aberta
      // há tempo, ou html-final editado por outra aba/janela nesse meio
      // tempo, deixaria htmlFinalDiverged desatualizada aqui. Re-busca o
      // estado fresco do servidor (mesma rota que refreshDivergenceBanner()
      // usa) antes de decidir. #3672: esse é justamente o `await` que abre a
      // janela de corrida — protegido por try/catch (abaixo) e pelo snapshot
      // acima.
      await refreshDivergenceBanner();
      if (htmlFinalDiverged) {
        const proceed = window.confirm(DIVERGENCE_CONFIRM_MESSAGE);
        if (!proceed) return;
      }
    }
    el.saveStatus.textContent = "Salvando…";
    el.saveStatus.className = "rv-save-status";
    const { ok, body } = await fetchJson(`/api/editions/${encodeURIComponent(aammdd)}/review/${slugAtSaveStart}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: contentAtSaveStart }),
    });
    if (ok && body && body.ok) {
      el.saveStatus.textContent = `Salvo ${fmtTime(body.modifiedAt)}`;
      el.saveStatus.className = "rv-save-status ok";
      // #3672: só limpa `dirty`/`fileStatus` se a aba ativa AINDA for a que
      // acabou de ser salva — se o editor trocou de aba durante o await, o
      // `dirty` atual pertence ao arquivo aberto agora (possivelmente ainda
      // não salvo), não ao slug capturado no snapshot.
      if (currentSlug === slugAtSaveStart) {
        dirty = false;
        el.fileStatus.textContent = `Modificado ${fmtTime(body.modifiedAt)}`;
      }
      if (slugAtSaveStart === "html-final") await refreshDivergenceBanner();
    } else {
      el.saveStatus.textContent = `Erro ao salvar: ${(body && body.error) || "falha desconhecida"}`;
      el.saveStatus.className = "rv-save-status err";
    }
  } catch (err) {
    // #3672: fail-open sem aviso — `fetchJson()` só embrulha `res.json()` em
    // try/catch, o `await fetch(...)` em si (e `refreshDivergenceBanner()`,
    // sem try/catch próprio) ficavam desprotegidos. Uma falha de rede durante
    // o guard ou o PUT propagava como unhandled rejection a partir do
    // listener de clique — sem aviso visual nenhum ao editor. Agora cai no
    // mesmo branch de erro visível do PUT.
    el.saveStatus.textContent = `Erro ao salvar: ${(err && err.message) || err}`;
    el.saveStatus.className = "rv-save-status err";
  } finally {
    el.saveBtn.disabled = false;
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
    if (currentSlug === "html-final") await refreshDivergenceBanner();
  } else {
    el.saveStatus.textContent = `Erro ao resetar baseline: ${(body && body.error) || "falha desconhecida"}`;
    el.saveStatus.className = "rv-save-status err";
  }
}

// #3635: quando a aba ativa é `html-final`, a "Preview do e-mail" mostra o
// próprio HTML final SALVO em disco (via srcdoc) em vez do HTML derivado do
// Markdown (`preview.html`, que ignora edições de última milha por
// definição — é sempre re-derivado do 02-reviewed.md). Sempre lê do disco,
// nunca do textarea ainda-não-salvo (mesmo invariante documentado no topo
// do arquivo pros outros 3 slugs).
// #3669 bug 2b: erro de rede (fetch falha, ou o próprio fetchJson lança) não
// pode virar unhandled promise rejection nem deixar o iframe em branco sem
// explicação — mostra uma mensagem de erro visível no lugar do preview.
function showPreviewError(err) {
  el.previewFrame.removeAttribute("src");
  el.previewFrame.srcdoc =
    '<p style="font-family:sans-serif;padding:1rem;color:#b00020">Erro ao carregar preview: ' +
    String((err && err.message) || err) +
    "</p>";
}

async function refreshPreview() {
  try {
    if (currentSlug === "html-final") {
      el.previewFrame.removeAttribute("src");
      const { body } = await fetchJson(`/api/editions/${encodeURIComponent(aammdd)}/review/html-final`);
      el.previewFrame.srcdoc =
        body && body.ok && body.exists
          ? body.content
          : "<p style=\"font-family:sans-serif;padding:1rem;color:#444\">newsletter-final.html ainda não existe nesta edição (roda depois da Etapa 4).</p>";
      return;
    }
    el.previewFrame.removeAttribute("srcdoc");
    // #3663: aba "social" tem preview PRÓPRIO (posts LinkedIn/Facebook/
    // Instagram, endpoint distinto do e-mail) — todas as outras abas
    // (categorized/reviewed) continuam no preview de e-mail derivado do
    // 02-reviewed.md, mesmo comportamento de antes.
    const endpoint = currentSlug === "social" ? "social-preview.html" : "preview.html";
    // Cache-bust: o iframe não deve mostrar preview obsoleto depois de um save.
    el.previewFrame.src = `/api/editions/${encodeURIComponent(aammdd)}/${endpoint}?t=${Date.now()}`;
  } catch (err) {
    showPreviewError(err);
  }
}

function activateSidePane(pane) {
  el.sideTabs.querySelectorAll(".rv-tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.pane === pane));
  el.paneLint.hidden = pane !== "lint";
  el.paneDiff.hidden = pane !== "diff";
  el.panePreview.hidden = pane !== "preview";
  if (pane === "preview") refreshPreview().catch(showPreviewError);
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
  el.previewRefreshBtn.addEventListener("click", () => { refreshPreview().catch(showPreviewError); });
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
  // #3669 bug 2a / #3672 achado 3: sem try/catch, uma falha de rede em
  // QUALQUER um dos dois `await`s abaixo propagava e nunca chegava em
  // setConn("ok") — o indicador de conexão ficava preso em "conectando…" pra
  // sempre mesmo com o resto do painel funcional. O try/catch original só
  // envolvia refreshDivergenceBanner(); loadFile(currentSlug) — que também
  // faz fetch de rede — ficava desprotegido ANTES dele. Falha em qualquer um
  // vira setConn("down") (sinal real de que uma chamada de rede falhou), sem
  // travar a inicialização.
  try {
    await loadFile(currentSlug);
    await refreshDivergenceBanner();
    setConn("ok");
  } catch (err) {
    console.error("init() falhou ao carregar estado inicial:", err);
    setConn("down");
  }
}

init();
