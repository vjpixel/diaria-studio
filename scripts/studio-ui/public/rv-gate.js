// rv-gate.js (#6447 Fatia 1) — painel "Gate" no topo da Revisão: checklist de
// conclusão + resumo consolidado (títulos original/final, WhatsApp, meta
// description, fact-check, boxes de divulgação, violations) lido de
// GET /api/editions/:aammdd/gate (scripts/studio-ui/studio-gate.ts). Render
// puro de JSON já computado no servidor — nenhuma chamada de LLM aqui.
//
// Módulo independente de revisao.js (import isolado, mesma convenção do
// #3559 pros arquivos próprios de cada fatia) — só depende do DOM estático
// declarado em revisao.html e do próprio AAMMDD da URL.

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
  if (summary.whatsappUrl) {
    const code = el_("code", { text: summary.whatsappUrl });
    whatsapp.appendChild(code);
  } else {
    whatsapp.appendChild(el_("span", { text: "⚠️ indisponível — ainda não computada nesta edição." }));
  }
  el.meta.appendChild(whatsapp);

  const metaDesc = el_("p", { className: "rv-gate-kv" });
  metaDesc.appendChild(document.createTextNode("Meta description sugerida (D1): "));
  if (summary.metaDescriptionSuggestion) {
    metaDesc.appendChild(document.createTextNode(summary.metaDescriptionSuggestion));
  } else {
    metaDesc.appendChild(el_("span", { text: "⚠️ sugestão indisponível." }));
  }
  el.meta.appendChild(metaDesc);
}

function renderFactCheck(summary) {
  clear(el.factcheck);
  const fc = summary.factCheck;
  if (!fc.available) {
    el.factcheck.appendChild(el_("p", { className: "rv-gate-empty", text: fc.note || "fact-check indisponível." }));
  } else {
    const s = fc.summary;
    el.factcheck.appendChild(el_("p", {
      className: "rv-gate-kv",
      text: `${s.total} claim(s) verificado(s) — ${s.sustained} confirmado(s), ${s.divergent} divergente(s), ` +
        `${s.not_found_in_source} não encontrado(s) na fonte, ${s.attention_items} pedindo atenção.`,
    }));
  }
  const autofix = summary.factCheckAutofix;
  if (autofix.available) {
    el.factcheck.appendChild(el_("p", {
      className: "rv-gate-kv",
      text: `Autofix: ${autofix.summary.applied} correção(ões) aplicada(s) automaticamente` +
        (autofix.socialModified ? " (inclui 03-social.md)." : "."),
    }));
  } else if (autofix.note) {
    el.factcheck.appendChild(el_("p", { className: "rv-gate-empty", text: autofix.note }));
  }
}

function renderBoxes(summary) {
  clear(el.boxes);
  const boxes = summary.boxSelection;
  if (!boxes.available || !boxes.slots || boxes.slots.length === 0) {
    el.boxes.appendChild(el_("p", { className: "rv-gate-empty", text: boxes.note || "nenhuma seleção registrada." }));
    return;
  }
  for (const slot of boxes.slots) {
    const line = slot.file
      ? `Slot ${slot.slot}: ${slot.nome || slot.file} (${slot.mode})`
      : `Slot ${slot.slot}: vazio (${slot.mode})`;
    el.boxes.appendChild(el_("p", { className: "rv-gate-kv", text: line }));
  }
}

function lintFailureRows(report, sourceLabel) {
  if (!report) return [];
  return report.checks
    .filter((c) => !c.ok || c.crashed)
    .map((c) => ({
      severity: c.blocking ? "fail" : "warn",
      text: `[${sourceLabel}] ${c.blocking ? "❌" : "⚠️"} ${c.label}${c.crashed ? ` (erro: ${c.error})` : ""}`,
    }));
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
      rows.push({ severity: "warn", text: `[render] ⚠️ ${ev.event}${ev.slot !== undefined ? ` (slot ${ev.slot})` : ""}` });
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
    renderGate(summary);
  } catch (err) {
    console.error("rv-gate: falha ao carregar resumo do gate:", err);
    el.status.className = "gate-fail";
    el.status.textContent = "Falha ao carregar o painel Gate — verifique a conexão.";
  }
}

if (el.refreshBtn) {
  el.refreshBtn.addEventListener("click", () => { loadGate(); });
}

loadGate();

// Exportado só para eventuais testes de integração client-side futuros —
// nenhum outro módulo desta fatia importa isto (rv-gate.js é standalone).
export { loadGate, renderGate };
