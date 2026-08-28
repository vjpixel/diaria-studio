// rv-gate-format.js (#6449 review — extraído de rv-gate.js) — formatação
// PURA (sem DOM) consumida pelo painel Gate. Mesma convenção já usada por
// revisao-guards.js/revisao-inline-edit.js: lógica sem `document`/`el.*`
// mora aqui pra ser testável direto (test/rv-gate-format.test.ts), a
// renderização em si (rv-gate.js) fica fina e sem lógica própria.

/** `metaDescriptionSuggestion` tem 3 estados distintos (ver
 * `scripts/lib/stage4-capture-state.ts`): `null` = "ainda não computada
 * nesta edição", `''` = "computada, mas o corpo do D1 não tinha prosa
 * aproveitável", string não-vazia = sugestão real. Um `if (value)` simples
 * conflaria os 2 primeiros estados sob a mesma mensagem — bug real corrigido
 * aqui (#6449 review, achado do self-review): checar `!== null` em vez de
 * truthiness. */
export function formatMetaDescription(value) {
  if (value === null) {
    return { available: false, text: "⚠️ ainda não computada nesta edição." };
  }
  if (value === "") {
    return { available: false, text: "⚠️ sugestão indisponível (corpo do D1 sem prosa aproveitável)." };
  }
  return { available: true, text: value };
}

/** `whatsappUrl` só tem 2 estados (`null` = ainda não computada, string =
 * valor real — sem o `''` legítimo que `metaDescriptionSuggestion` tem). */
export function formatWhatsappUrl(value) {
  if (!value) {
    return { available: false, text: "⚠️ indisponível — ainda não computada nesta edição." };
  }
  return { available: true, text: value };
}

/** Linha de resumo do fact-check — `state` é o `GateFactCheckState` (union
 * discriminada por `available`). Nunca acessa `.summary` sem checar
 * `available` primeiro. */
export function formatFactCheckSummary(state) {
  if (!state || !state.available) {
    return (state && state.note) || "fact-check indisponível.";
  }
  const s = state.summary || {};
  const total = s.total ?? 0;
  const sustained = s.sustained ?? 0;
  const divergent = s.divergent ?? 0;
  const notFound = s.not_found_in_source ?? 0;
  const attention = s.attention_items ?? 0;
  return `${total} claim(s) verificado(s) — ${sustained} confirmado(s), ${divergent} divergente(s), ` +
    `${notFound} não encontrado(s) na fonte, ${attention} pedindo atenção.`;
}

/** Linha de resumo do autofix — `state` é o `GateFactCheckAutofixState`. */
export function formatAutofixSummary(state) {
  if (!state || !state.available) return null;
  const applied = state.summary?.applied ?? 0;
  return `Autofix: ${applied} correção(ões) aplicada(s) automaticamente` +
    (state.socialModified ? " (inclui 03-social.md)." : ".");
}

/** Linha por slot de box de divulgação — `slot` é um `SlotSelectionRecord`. */
export function formatBoxSlotLine(slot) {
  if (!slot) return "";
  return slot.file
    ? `Slot ${slot.slot}: ${slot.nome || slot.file} (${slot.mode})`
    : `Slot ${slot.slot}: vazio (${slot.mode})`;
}

/** Linhas de falha (bloqueante ou warn) extraídas de um `LintReport`,
 * prefixadas com `sourceLabel` ("newsletter"/"social") pra distinguir a
 * origem no painel consolidado. */
export function lintFailureRows(report, sourceLabel) {
  if (!report || !Array.isArray(report.checks)) return [];
  return report.checks
    .filter((c) => !c.ok || c.crashed)
    .map((c) => ({
      severity: c.blocking ? "fail" : "warn",
      text: `[${sourceLabel}] ${c.blocking ? "❌" : "⚠️"} ${c.label}${c.crashed ? ` (erro: ${c.error})` : ""}`,
    }));
}

/** Linha de aviso de render — `ev` é um `RenderWarningEvent`. */
export function formatRenderWarningRow(ev) {
  if (!ev) return "";
  return `[render] ⚠️ ${ev.event}${ev.slot !== undefined ? ` (slot ${ev.slot})` : ""}`;
}
