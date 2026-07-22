// revisao.js (#3559) — painel de revisão de conteúdo rica: editor + diff +
// lints inline + preview do e-mail. Vanilla JS, sem build step (mesmo
// princípio de app.js/edicao.js — zero-custo, sem lib nova). #3828: a seção
// "Ações rápidas" (swap de destaque + prompts de reescrever título/regenerar
// imagem) foi removida — os 2 ganchos de chat só pré-preenchiam o que o
// editor já consegue digitar direto no chat drawer, e o swap tinha um
// caminho de backend próprio pra replicar o que já existe como CLI
// (`scripts/swap-destaque.ts`, que continua disponível via terminal).
//
// Fluxo: GET /api/editions/:aammdd/review/:slug traz {content, baseline,
// exists, pull}. O editor edita LOCALMENTE no textarea (nada é enviado até
// clicar "Salvar" — PUT do mesmo endpoint). Diff/lint/preview são sob
// demanda (botões), lendo sempre o que está SALVO no disco — não o
// conteúdo ainda-não-salvo do textarea (documentado no hint da UI).

import {
  shouldConfirmDivergenceGuard,
  DIVERGENCE_CONFIRM_MESSAGE,
  SAVE_CONFLICT_CONFIRM_MESSAGE,
  activeSidePaneAfterSave,
} from "./revisao-guards.js";
import {
  DESTAQUE_HEADLINE_SELECTOR,
  MAX_EDITABLE_DESTAQUES,
  sanitizeInlineTitleText,
  shouldSaveInlineTitle,
  buildDestaqueTitleSavePayload,
  buildInlineTitleConflictMessage,
} from "./revisao-inline-edit.js";
import { nextTabIndex, syncTabAria } from "./tablist-core.js";

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
// #3729: mtime (ISO) do arquivo ATUALMENTE aberto tal como visto no último
// GET bem-sucedido (`loadFile()`) — `null` quando o arquivo ainda não existia
// naquele momento. Enviado de volta como `expectedModifiedAt` no PUT de
// `saveCurrent()`; o server (saveReviewFile em studio-review.ts) compara
// contra o mtime ATUAL em disco e responde 409 se divergir (o pipeline
// reescreveu o arquivo por baixo entre o load e o save). Atualizado só
// quando `loadFile()`/save bem-sucedido se referem ao slug ainda ativo — o
// mesmo cuidado de "snapshot" já documentado em saveCurrent() abaixo.
let loadedModifiedAt = null;

const el = {
  backLink: document.getElementById("back-link"),
  titulo: document.getElementById("rv-titulo"),
  arquivo: document.getElementById("rv-arquivo"),
  connDot: document.getElementById("conn-dot"),
  connLabel: document.getElementById("conn-label"),
  notFound: document.getElementById("rv-not-found"),
  tabs: document.getElementById("rv-tabs"),
  fileStatus: document.getElementById("rv-file-status"),
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
  inlineEditStatus: document.getElementById("rv-inline-edit-status"),
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
  // #3806 (Opção B spike): só a aba "reviewed" tem os títulos de destaque
  // editáveis diretamente no preview (clique no título, edite, Enter ou
  // clique fora salva) — o MD por trás continua a fonte da verdade, a edição
  // reescreve só a região do título (ver setupInlineTitleEditing() abaixo).
  reviewed:
    "Renderizado a partir de <code>02-reviewed.md</code> salvo no disco (mesmo caminho " +
    "do Stage 4) — salve antes de atualizar o preview. <strong>Títulos de destaque são " +
    "editáveis aqui</strong>: clique no título, edite, e saia do campo (ou Enter) pra " +
    "salvar direto no Markdown, sem abrir a aba de texto cru.",
  default:
    "Renderizado a partir de <code>02-reviewed.md</code> salvo no disco (mesmo caminho " +
    "do Stage 4) — salve antes de atualizar o preview. Exceção: com a aba " +
    "<strong>HTML final</strong> ativa, mostra o <code>_internal/newsletter-final.html</code> " +
    "salvo diretamente (sem passar pelo Markdown).",
};

// #3687: mantém a sessão de chat (chat-drawer.js, painel fixo à esquerda)
// sincronizada com o que está aberto AQUI — edição + arquivo + aba ativa,
// os mesmos 3 valores que o header já mostra (el.titulo/el.arquivo/aba
// ativa em rv-tabs). Chamada de dentro de `renderTabs()` (chamada toda vez
// que `currentSlug` muda, ver `loadFile()`) em vez de só uma vez ao montar —
// é isso que garante que o contexto ACOMPANHA o editor trocando de aba, não
// fica preso no estado de quando a página abriu (critério de aceite do
// #3687: "deve atualizar quando o editor troca de edição, de arquivo ou de
// aba"). Fail-soft: se `window.diariaStudioChat` ainda não montou (ordem de
// script) ou não expõe `setContext`, não faz nada — mesmo guard já usado por
// `fillChatWithPrompt` abaixo.
function syncChatContext() {
  if (!window.diariaStudioChat || typeof window.diariaStudioChat.setContext !== "function") return;
  const activeTabBtn = el.tabs.querySelector(`.rv-tab[data-slug="${currentSlug}"]`);
  window.diariaStudioChat.setContext({
    edition: aammdd,
    file: FILE_LABELS[currentSlug],
    tab: activeTabBtn ? activeTabBtn.textContent.trim() : currentSlug,
  });
}

function renderTabs() {
  el.tabs.querySelectorAll(".rv-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.slug === currentSlug);
  });
  // #3874: WAI-ARIA APG completo (R13 de docs/studio-ui-ux-guidelines.md) —
  // `role="tab"` já vem do HTML; `aria-selected`/tabindex roving geridos
  // aqui, junto da classe `.active` (mesmo predicado, single source).
  syncTabAria(el.tabs.querySelectorAll(".rv-tab"), (btn) => btn.dataset.slug === currentSlug);
  el.arquivo.textContent = FILE_LABELS[currentSlug];
  el.htmlFinalNote.hidden = currentSlug !== "html-final";
  const previewTabBtn = el.sideTabs.querySelector('[data-pane="preview"]');
  if (previewTabBtn) previewTabBtn.textContent = PREVIEW_TAB_LABELS[currentSlug] || PREVIEW_TAB_LABELS.reviewed;
  if (el.previewHint) el.previewHint.innerHTML = PREVIEW_HINTS[currentSlug] || PREVIEW_HINTS.default;
  syncChatContext();
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
  dirty = false;
  // #3729: reseta o baseline temporal ANTES do fetch — se o load falhar (ou o
  // arquivo não existir ainda), não deve sobrar um `loadedModifiedAt` de um
  // slug/estado anterior associado à aba agora ativa.
  loadedModifiedAt = null;

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
  loadedModifiedAt = body.modifiedAt ?? null;
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

// #3872: re-roda a MESMA ação que o painel lateral atualmente aberto (se
// houver) dispararia se o editor clicasse o botão de novo — reusa
// runDiff()/runLints()/refreshPreview(), que já leem sempre o conteúdo
// SALVO em disco (nunca o textarea), então chamar de novo logo após um save
// bem-sucedido já reflete o que acabou de ser gravado. Chamado só quando a
// aba ainda é a mesma que foi salva (ver call site em saveCurrent() — mesmo
// guard `currentSlug === slugAtSaveStart` já usado pro reset de `dirty`);
// nenhum painel lateral aberto → activeSidePaneAfterSave() retorna `null`,
// no-op.
async function refreshActiveSidePaneAfterSave() {
  const pane = activeSidePaneAfterSave({
    diffHidden: el.paneDiff.hidden,
    lintHidden: el.paneLint.hidden,
    previewHidden: el.panePreview.hidden,
  });
  if (pane === "diff") await runDiff();
  else if (pane === "lint") await runLints();
  else if (pane === "preview") await refreshPreview().catch(showPreviewError);
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
  // #3729: snapshot do mtime visto no último load bem-sucedido DESTE slug —
  // mesmo princípio do snapshot de slug/conteúdo acima (#3672): capturado
  // ANTES de qualquer await, nunca lido "ao vivo" depois (uma troca de aba
  // durante o guard reatribuiria `loadedModifiedAt` pro slug novo).
  const expectedModifiedAtAtSaveStart = loadedModifiedAt;
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
    const putUrl = `/api/editions/${encodeURIComponent(aammdd)}/review/${slugAtSaveStart}`;
    let { ok, status, body } = await fetchJson(putUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: contentAtSaveStart, expectedModifiedAt: expectedModifiedAtAtSaveStart }),
    });

    // #3729: 409 = o server detectou que o arquivo em disco mudou desde que
    // este painel o carregou (o pipeline reescreveu por baixo — title-picker,
    // Clarice, humanizador). Avisa antes de decidir: OK sobrescreve mesmo
    // assim (retry com `force: true`, SEM `expectedModifiedAt` — o editor já
    // confirmou), Cancelar recarrega a versão do disco e descarta a edição
    // local não salva desta aba.
    if (!ok && status === 409) {
      const overwrite = window.confirm(SAVE_CONFLICT_CONFIRM_MESSAGE);
      if (overwrite) {
        ({ ok, status, body } = await fetchJson(putUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: contentAtSaveStart, force: true }),
        }));
      } else {
        el.saveStatus.textContent = "Não salvo — recarregando a versão mais recente do disco…";
        el.saveStatus.className = "rv-save-status";
        if (currentSlug === slugAtSaveStart) {
          dirty = false; // evita o confirm() de "descartar edições" dentro de loadFile()
          await loadFile(slugAtSaveStart, { force: true });
          el.saveStatus.textContent = "Recarregado — suas edições não salvas foram descartadas.";
          el.saveStatus.className = "rv-save-status";
        }
        return;
      }
    }

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
        // #3729: atualiza o baseline temporal pro que acabou de ser gravado —
        // sem isso, o PRÓXIMO save deste mesmo slug compararia contra o mtime
        // pré-save (sempre divergente) e disparia um falso-positivo de
        // conflito a cada save consecutivo.
        loadedModifiedAt = body.modifiedAt;
        // #3872: painel lateral (diff/lints/preview) aberto agora reflete o
        // conteúdo recém-salvo, não o estado anterior ao save. Isolado num
        // try/catch próprio (mesmo padrão do refresh de html-final logo
        // abaixo): o save já teve sucesso ("Salvo" acima) — uma falha só
        // deste refresh não pode sobrescrever esse status com "Erro ao
        // salvar".
        try {
          await refreshActiveSidePaneAfterSave();
        } catch (err) {
          console.error("refreshActiveSidePaneAfterSave() pós-save falhou (não afeta o resultado do save):", err);
        }
      }
      if (slugAtSaveStart === "html-final") {
        // #3672 (self-review): refresh PÓS-save isolado num try/catch
        // próprio — o save já teve sucesso (mensagem "Salvo" acima); se só
        // este refresh falhar, não deveria sobrescrever esse status de
        // sucesso com "Erro ao salvar" (cairia no catch externo e mentiria
        // sobre o resultado do save). Loga no console em vez de reportar erro
        // visível de save.
        try {
          await refreshDivergenceBanner();
        } catch (err) {
          console.error("refreshDivergenceBanner() pós-save falhou (não afeta o resultado do save):", err);
        }
      }
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
// Nota (#3874): os hex abaixo NÃO usam var(--status-*) de propósito — este
// HTML vira `srcdoc` de um <iframe> (documento separado, sem acesso ao
// :root do Studio) — ver R17/comentário de .rv-preview-frame em revisao.css.
// Alinhado ao MESMO vermelho de --status-danger (#c0392b) por consistência
// visual, só que como literal.
function showPreviewError(err) {
  el.previewFrame.removeAttribute("src");
  el.previewFrame.srcdoc =
    '<p style="font-family:sans-serif;padding:1rem;color:#c0392b">Erro ao carregar preview: ' +
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

// #3806 (Opção B spike) — edição visual do título de destaque, direto no
// preview renderizado (iframe), sem expor o Markdown cru pro caso comum.
//
// Design (ver corpo do #3806 pro rationale completo):
//   - Só habilitado quando `currentSlug === "reviewed"` — a única aba cujo
//     conteúdo do preview (sempre derivado de 02-reviewed.md, ver
//     buildReviewPreviewHtml em studio-review.ts) corresponde exatamente ao
//     arquivo que a edição inline salva. Nas abas categorized/social/
//     html-final, a edição inline fica DESLIGADA (mesmo preview de e-mail
//     aparece pra categorized, mas editar ali salvaria em reviewed sob um
//     rótulo de aba diferente — confuso, evitado de propósito).
//   - ZERO mudança no render de produção (`newsletter-render-html.ts`): o
//     `<a class="headline">` já existe no HTML normal — este código só
//     pós-processa o DOM do iframe DEPOIS que ele carrega, adicionando
//     `contenteditable` + listeners. O e-mail de verdade nunca passa por
//     este arquivo.
//   - Salva via PUT .../review/reviewed/destaque-title (server.ts), que
//     reusa saveReviewFile por baixo — MESMO guard de conflito mtime
//     (#3729) do editor de MD completo. Em caso de 409, esta 1ª fatia
//     SEMPRE recarrega a versão do disco (sem oferecer "sobrescrever mesmo
//     assim") — simplificação deliberada do spike, ver
//     buildInlineTitleConflictMessage em revisao-inline-edit.js.
//   - Depois de salvar (sucesso OU conflito), resincroniza o textarea/
//     baseline via loadFile("reviewed", {force:true}) — reusa o caminho já
//     testado em vez de duplicar reconciliação de estado aqui.

/** Texto do título no momento em que o campo recebeu foco — usado por
 * `shouldSaveInlineTitle` pra não disparar um PUT quando o blur não mudou
 * nada de fato. `WeakMap` (não Map comum): entries somem sozinhas quando o
 * elemento é descartado (próxima navegação do iframe recria os `<a>` do
 * zero) — sem isso vazaria uma referência por refresh de preview. */
const inlineTitleOriginalTextByEl = new WeakMap();

async function saveInlineTitle(anchorEl, n) {
  const original = inlineTitleOriginalTextByEl.get(anchorEl) ?? "";
  const sanitized = sanitizeInlineTitleText(anchorEl.textContent);
  if (!shouldSaveInlineTitle(sanitized, original)) return;

  el.inlineEditStatus.textContent = `Salvando título D${n}…`;
  el.inlineEditStatus.className = "hint";
  const payload = buildDestaqueTitleSavePayload(n, sanitized, loadedModifiedAt);
  let response;
  try {
    response = await fetchJson(`/api/editions/${encodeURIComponent(aammdd)}/review/reviewed/destaque-title`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    el.inlineEditStatus.textContent = `Erro ao salvar título D${n}: ${(err && err.message) || err}`;
    el.inlineEditStatus.className = "hint rv-inline-edit-err";
    anchorEl.textContent = original; // reverte visualmente — DOM não pode divergir do disco
    return;
  }
  const { ok, status, body } = response;

  if (ok && body && body.ok) {
    el.inlineEditStatus.textContent = `Título D${n} salvo ${fmtTime(body.modifiedAt)}.`;
    el.inlineEditStatus.className = "hint rv-inline-edit-ok";
    // Resincroniza textarea/baseline/lints com o disco (fonte única de
    // verdade) — reusa loadFile() já testado em vez de duplicar
    // reconciliação de estado aqui. `dirty` forçado a false ANTES: esta
    // edição não tem relação com um estado "não salvo" do textarea do MD.
    if (currentSlug === "reviewed") {
      dirty = false;
      await loadFile("reviewed", { force: true });
    }
    return;
  }
  if (status === 409) {
    el.inlineEditStatus.textContent = buildInlineTitleConflictMessage(n);
    el.inlineEditStatus.className = "hint rv-inline-edit-err";
    dirty = false;
    if (currentSlug === "reviewed") await loadFile("reviewed", { force: true });
    return;
  }
  el.inlineEditStatus.textContent = `Erro ao salvar título D${n}: ${(body && body.error) || "falha desconhecida"}`;
  el.inlineEditStatus.className = "hint rv-inline-edit-err";
  anchorEl.textContent = original; // reverte visualmente — DOM não pode divergir do disco
}

/** Injeta um `<style>` mínimo no `iframe.contentDocument` marcando os
 * títulos como editáveis (outline tracejado + cursor de texto) — só
 * afeta o preview DENTRO do iframe do Studio, nunca o e-mail real (este CSS
 * não existe em nenhum lugar que a pipeline de publicação toque). */
function injectInlineEditAffordanceStyle(doc) {
  const style = doc.createElement("style");
  style.textContent =
    `${DESTAQUE_HEADLINE_SELECTOR}[contenteditable="true"]{outline:1px dashed #9a8a5a;` +
    `outline-offset:3px;cursor:text;border-radius:2px;}` +
    `${DESTAQUE_HEADLINE_SELECTOR}[contenteditable="true"]:focus{outline:2px solid #2a8f5c;}`;
  doc.head.appendChild(style);
}

/** Pós-processa o DOM do iframe (só quando `currentSlug === "reviewed"`),
 * tornando os primeiros `MAX_EDITABLE_DESTAQUES` títulos editáveis.
 * Fail-soft: chamado dentro de um try/catch pelo caller (listener de
 * 'load' do iframe) — qualquer exceção aqui (ex: iframe cross-origin por
 * algum motivo inesperado) não deveria quebrar o resto do painel. */
function setupInlineTitleEditing() {
  if (currentSlug !== "reviewed") return;
  const doc = el.previewFrame.contentDocument;
  if (!doc) return;
  injectInlineEditAffordanceStyle(doc);
  const anchors = doc.querySelectorAll(DESTAQUE_HEADLINE_SELECTOR);
  anchors.forEach((anchorEl, i) => {
    const n = i + 1;
    if (n > MAX_EDITABLE_DESTAQUES) return;
    anchorEl.setAttribute("contenteditable", "true");
    anchorEl.dataset.destaqueN = String(n);
    // Não navegar pro link real ao clicar pra editar (o próprio <a> aponta
    // pra URL da fonte — é o comportamento do e-mail publicado, indesejado
    // aqui dentro do preview editável).
    anchorEl.addEventListener("click", (ev) => ev.preventDefault());
    anchorEl.addEventListener("focus", () => {
      inlineTitleOriginalTextByEl.set(anchorEl, anchorEl.textContent);
    });
    anchorEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault(); // título é 1 linha só — Enter salva, não quebra linha
        anchorEl.blur();
      }
    });
    anchorEl.addEventListener("blur", () => {
      saveInlineTitle(anchorEl, n).catch((err) => {
        console.error(`saveInlineTitle(D${n}) falhou:`, err);
      });
    });
  });
}

function activateSidePane(pane) {
  el.sideTabs.querySelectorAll(".rv-tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.pane === pane));
  syncTabAria(el.sideTabs.querySelectorAll(".rv-tab"), (btn) => btn.dataset.pane === pane);
  el.paneLint.hidden = pane !== "lint";
  el.paneDiff.hidden = pane !== "diff";
  el.panePreview.hidden = pane !== "preview";
  if (pane === "preview") refreshPreview().catch(showPreviewError);
}

// #3874: navegação por setas (WAI-ARIA APG) num `role="tablist"` — ativação
// automática (a seta já troca de aba, sem exigir Enter/Espaço extra depois).
// Genérico o bastante pra servir os 2 tablists desta página (`el.tabs`/
// `el.sideTabs`), cada um com sua própria função de "ativar por índice".
function bindTablistArrowKeys(tablistEl, activateByIndex) {
  tablistEl.addEventListener("keydown", (ev) => {
    const buttons = [...tablistEl.querySelectorAll(".rv-tab")];
    const currentIndex = buttons.findIndex((b) => b.classList.contains("active"));
    const nextIndex = nextTabIndex(ev.key, currentIndex, buttons.length);
    if (nextIndex === null) return;
    ev.preventDefault();
    buttons[nextIndex].focus();
    activateByIndex(buttons[nextIndex]);
  });
}

function bindEvents() {
  el.tabs.querySelectorAll(".rv-tab").forEach((btn) => {
    btn.addEventListener("click", () => loadFile(btn.dataset.slug));
  });
  el.sideTabs.querySelectorAll(".rv-tab").forEach((btn) => {
    btn.addEventListener("click", () => activateSidePane(btn.dataset.pane));
  });
  bindTablistArrowKeys(el.tabs, (btn) => loadFile(btn.dataset.slug));
  bindTablistArrowKeys(el.sideTabs, (btn) => activateSidePane(btn.dataset.pane));
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
  // #3806: cada navegação do iframe (`refreshPreview()` reatribui `src`)
  // dispara um 'load' novo — reanexar contenteditable/listeners no DOM
  // recém-criado do documento novo (o anterior, com seus listeners, já foi
  // descartado junto com o documento antigo).
  el.previewFrame.addEventListener("load", () => {
    try {
      setupInlineTitleEditing();
    } catch (err) {
      console.error("setupInlineTitleEditing() falhou:", err);
    }
  });
  window.addEventListener("beforeunload", (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  });

  // #3874: `#rv-side-tabs` já nasce com a aba "Lints" marcada `.active` no
  // HTML estático (padrão pré-existente), mas `activateSidePane()` só roda
  // no primeiro clique/ação (runDiff()/runLints()) — sem chamar aqui,
  // `aria-selected` ficaria ausente em TODOS os botões até essa 1ª
  // interação. `#rv-tabs` não precisa do mesmo tratamento: `renderTabs()`
  // (chamada logo abaixo, em `init()`) já cobre o estado inicial dele.
  syncTabAria(el.sideTabs.querySelectorAll(".rv-tab"), (btn) => btn.classList.contains("active"));
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
