// rv-gate.js (#6447 Fatia 1) — painel "Gate" no topo da Revisão: checklist de
// conclusão + resumo consolidado (títulos original/final, WhatsApp, meta
// description, fact-check, boxes de divulgação, violations) lido de
// GET /api/editions/:aammdd/gate (scripts/studio-ui/studio-gate.ts). Render
// puro de JSON já computado no servidor — nenhuma chamada de LLM aqui.
//
// Módulo independente de revisao.js (import isolado, mesma convenção do
// #3559 pros arquivos próprios de cada fatia) — só depende do DOM estático
// declarado em revisao.html e do próprio AAMMDD da URL. Toda formatação
// SEM DOM mora em rv-gate-format.js (testável direto, ver
// test/rv-gate-format.test.ts) — este arquivo só monta os nós.

import {
  formatMetaDescription,
  formatWhatsappUrl,
  formatFactCheckSummary,
  formatAutofixSummary,
  formatBoxSlotLine,
  lintFailureRows,
  formatRenderWarningRow,
  formatGateDecision,
} from "./rv-gate-format.js";

// #6447 Fatia 4 (achado 7): mesmo padrão de SAVE_CONFLICT_CONFIRM_MESSAGE
// (revisao-guards.js) — confirmação explícita antes de sobrescrever uma
// decisão "aprovado" já gravada, nunca um duplo-approve silencioso.
const GATE_APPROVE_CONFLICT_CONFIRM_MESSAGE =
  "Este gate já foi aprovado pelo painel antes. Aprovar de novo grava um novo timestamp " +
  "por cima da decisão anterior — confirma?";

function getAammddFromPath() {
  const m = location.pathname.match(/^\/revisao\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

const aammdd = getAammddFromPath();

const el = {
  status: document.getElementById("rv-gate-status"),
  checklist: document.getElementById("rv-gate-checklist"),
  body: document.getElementById("rv-gate-body"),
  titles: document.getElementById("rv-gate-titles"),
  meta: document.getElementById("rv-gate-meta"),
  factcheck: document.getElementById("rv-gate-factcheck"),
  boxes: document.getElementById("rv-gate-boxes"),
  violations: document.getElementById("rv-gate-violations"),
  refreshBtn: document.getElementById("rv-gate-refresh-btn"),
  approveBtn: document.getElementById("rv-gate-approve-btn"),
  approveStatus: document.getElementById("rv-gate-approve-status"),
};

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function el_(tag, opts = {}) {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = opts.text;
  return node;
}

function renderChecklist(checklist) {
  clear(el.checklist);
  for (const item of checklist) {
    const row = el_("div", { className: `rv-gate-check-row ${item.ok ? "ok" : "fail"}` });
    row.appendChild(el_("span", { className: "rv-gate-check-badge", text: item.ok ? "OK" : "ATENÇÃO" }));
    row.appendChild(el_("span", { className: "rv-gate-check-label", text: item.label }));
    if (!item.ok && item.detail) {
      const detail = el_("div", { className: "rv-gate-check-detail", text: item.detail });
      row.appendChild(detail);
    }
    el.checklist.appendChild(row);
  }
}

function renderTitles(highlights) {
  clear(el.titles);
  if (highlights.length === 0) {
    el.titles.appendChild(el_("p", { className: "rv-gate-empty", text: "Nenhum destaque encontrado — 01-approved.json e/ou 02-reviewed.md ainda não existem." }));
    return;
  }
  for (const h of highlights) {
    const row = el_("div", { className: "rv-gate-highlight" });
    const heading = el_("strong", { text: `D${h.n}${h.category ? ` — ${h.category}` : ""}` });
    row.appendChild(heading);
    const line = el_("div", { className: "rv-gate-title-line" });
    if (h.originalTitle) {
      line.appendChild(el_("span", { className: "rv-gate-title-original", text: h.originalTitle }));
    }
    if (h.resolved && h.finalTitle) {
      line.appendChild(el_("span", { text: "→" }));
      line.appendChild(el_("span", { className: "rv-gate-title-final", text: h.finalTitle }));
    } else {
      line.appendChild(el_("span", {
        className: "rv-gate-title-pending",
        text: `→ ${h.titleCount ?? "?"} opção(ões) ainda não podadas para 1`,
      }));
    }
    row.appendChild(line);
    el.titles.appendChild(row);
  }
}

function renderMeta(summary) {
  clear(el.meta);
  const whatsapp = el_("p", { className: "rv-gate-kv" });
  whatsapp.appendChild(document.createTextNode("URL do WhatsApp (D1): "));
  const wa = formatWhatsappUrl(summary.whatsappUrl);
  if (wa.available) {
    whatsapp.appendChild(el_("code", { text: wa.text }));
  } else {
    whatsapp.appendChild(el_("span", { text: wa.text }));
  }
  el.meta.appendChild(whatsapp);

  const metaDesc = el_("p", { className: "rv-gate-kv" });
  metaDesc.appendChild(document.createTextNode("Meta description sugerida (D1): "));
  const md = formatMetaDescription(summary.metaDescriptionSuggestion);
  metaDesc.appendChild(md.available ? document.createTextNode(md.text) : el_("span", { text: md.text }));
  el.meta.appendChild(metaDesc);
}

function renderFactCheck(summary) {
  clear(el.factcheck);
  const fc = summary.factCheck;
  const className = fc.available ? "rv-gate-kv" : "rv-gate-empty";
  el.factcheck.appendChild(el_("p", { className, text: formatFactCheckSummary(fc) }));

  const autofixLine = formatAutofixSummary(summary.factCheckAutofix);
  if (autofixLine) {
    el.factcheck.appendChild(el_("p", { className: "rv-gate-kv", text: autofixLine }));
  } else if (!summary.factCheckAutofix.available && summary.factCheckAutofix.note) {
    el.factcheck.appendChild(el_("p", { className: "rv-gate-empty", text: summary.factCheckAutofix.note }));
  }
}

function renderBoxes(summary) {
  clear(el.boxes);
  const boxes = summary.boxSelection;
  if (!boxes.available || boxes.slots.length === 0) {
    el.boxes.appendChild(el_("p", { className: "rv-gate-empty", text: boxes.available ? "nenhuma seleção registrada." : boxes.note }));
    return;
  }
  for (const slot of boxes.slots) {
    el.boxes.appendChild(el_("p", { className: "rv-gate-kv", text: formatBoxSlotLine(slot) }));
  }
}

function renderViolations(summary) {
  clear(el.violations);
  const rows = [
    ...lintFailureRows(summary.lintReviewed, "newsletter"),
    ...lintFailureRows(summary.lintSocial, "social"),
  ];
  const rw = summary.renderWarnings;
  if (rw.available) {
    for (const ev of rw.events) {
      rows.push({ severity: "warn", text: formatRenderWarningRow(ev) });
    }
  }
  if (rows.length === 0) {
    el.violations.appendChild(el_("p", { className: "rv-gate-empty", text: "Nenhuma violation ou aviso pendente." }));
    return;
  }
  for (const row of rows) {
    el.violations.appendChild(el_("div", { className: `rv-gate-violation-row ${row.severity}`, text: row.text }));
  }
}

/** #6447 Fatia 4 (achado 7): reflete `summary.decision` no botão "Aprovar
 * gate" — nunca desabilita de fato (o editor pode legitimamente querer
 * re-aprovar depois de um ajuste pós-approve), mas troca o texto e exige
 * confirmação explícita (ver `approveGate`) quando já existe uma decisão. */
function renderApproveButton(summary) {
  if (!el.approveBtn) return;
  const decisionInfo = formatGateDecision(summary.decision);
  el.approveBtn.textContent = decisionInfo.approved ? "Aprovar gate de novo" : "Aprovar gate";
  el.approveStatus.textContent = decisionInfo.text;
  el.approveStatus.className = decisionInfo.approved ? "rv-gate-approve-status approved" : "rv-gate-approve-status";
}

function renderGate(summary) {
  el.body.hidden = false;
  renderChecklist(summary.checklist);
  el.status.className = summary.ok ? "gate-ok" : "gate-fail";
  el.status.textContent = summary.ok
    ? "Tudo resolvido — pronto para aprovar o gate."
    : "Pendências abaixo antes de aprovar o gate.";
  renderTitles(summary.highlights);
  renderMeta(summary);
  renderFactCheck(summary);
  renderBoxes(summary);
  renderViolations(summary);
  renderApproveButton(summary);
}

async function loadGate() {
  if (!aammdd) return;
  el.status.className = "";
  el.status.textContent = "Carregando…";
  try {
    const res = await fetch(`/api/editions/${encodeURIComponent(aammdd)}/gate`);
    if (res.status === 404) {
      el.status.textContent = "Edição não encontrada.";
      el.body.hidden = true;
      clear(el.checklist);
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const summary = await res.json();
    try {
      renderGate(summary);
    } catch (renderErr) {
      // Distingue "não deu pra buscar" (rede) de "buscou, mas não deu pra
      // desenhar" (resposta com shape inesperado) — a 1ª mensagem genérica
      // mandava o editor checar a conexão mesmo quando o problema era outro
      // (#6449 review).
      console.error("rv-gate: renderGate() falhou com a resposta recebida:", renderErr, summary);
      el.status.className = "gate-fail";
      el.status.textContent = "Painel Gate recebeu uma resposta que não conseguiu desenhar — veja o console.";
    }
  } catch (err) {
    console.error("rv-gate: falha ao carregar resumo do gate:", err);
    el.status.className = "gate-fail";
    el.status.textContent = "Falha ao carregar o painel Gate — verifique a conexão.";
  }
}

if (el.refreshBtn) {
  el.refreshBtn.addEventListener("click", () => { loadGate(); });
}

/** #6447 Fatia 4 (achado 7): `POST /api/editions/:aammdd/gate/approve`.
 * 409 (já aprovado antes, sem `force`) pede confirmação explícita — mesmo
 * padrão de conflito de save já usado em `rv-highlights.js`/`revisao.js`
 * (`SAVE_CONFLICT_CONFIRM_MESSAGE`), só que a AÇÃO já aconteceu no servidor
 * (decisão anterior existe) em vez de "conteúdo divergente em disco". */
async function approveGate(force) {
  if (!aammdd || !el.approveBtn) return;
  el.approveBtn.disabled = true;
  el.approveStatus.textContent = "Aprovando…";
  let res;
  try {
    res = await fetch(`/api/editions/${encodeURIComponent(aammdd)}/gate/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: !!force }),
    });
  } catch (err) {
    el.approveBtn.disabled = false;
    el.approveStatus.textContent = `Erro de rede ao aprovar: ${(err && err.message) || err}`;
    return;
  }
  if (res.status === 409) {
    el.approveBtn.disabled = false;
    if (window.confirm(GATE_APPROVE_CONFLICT_CONFIRM_MESSAGE)) {
      await approveGate(true);
    } else {
      await loadGate();
    }
    return;
  }
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  el.approveBtn.disabled = false;
  if (res.ok && body && body.ok) {
    await loadGate();
    return;
  }
  el.approveStatus.textContent = `Erro ao aprovar: ${(body && body.error) || "falha desconhecida"}`;
}

if (el.approveBtn) {
  el.approveBtn.addEventListener("click", () => { approveGate(false); });
}

// #6447 Fatia 2: o Editor por destaque (rv-highlights.js) dispara este
// evento após salvar `02-reviewed.md` — o resumo do Gate (títulos,
// checklist) precisa refletir a edição sem esperar o próximo clique manual
// em "Atualizar".
window.addEventListener("rv:reviewed-saved", () => { loadGate(); });

loadGate();

// Exportado pro suite de testes de contrato do server (ver
// test/studio-review-server.test.ts, mesmo padrão já usado por revisao.js —
// asserts sobre o SOURCE servido, não um harness de DOM).
export { loadGate, renderGate, approveGate };
