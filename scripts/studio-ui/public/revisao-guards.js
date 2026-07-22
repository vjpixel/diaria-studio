// revisao-guards.js (#3668) — lógica PURA do guard de divergência do painel
// de revisão (`revisao.html`/`revisao.js`). Separado de propósito de
// `revisao.js`: nenhuma das duas exportações abaixo toca `document`/`fetch`
// — são testáveis com fixtures puras, sem DOM real (#633).
//
// Contexto (#3635, PR #3664): o guard avisa antes de salvar um dos slugs de
// Markdown (`01-categorized`/`02-reviewed`/`03-social`) quando
// `_internal/newsletter-final.html` já diverge do baseline capturado pela
// Etapa 4 — o risco é um re-render futuro do HTML a partir do Markdown
// descartar silenciosamente uma edição manual do HTML.
//
// #3668 identificou 3 gaps no guard original:
//   1. Falso-positivo em re-render legítimo do agente (ensureBaseline só
//      captura o baseline na 1ª leitura — um re-render agent-driven do
//      Stage 4, sem edição manual nenhuma, também "diverge"). Mudar o
//      comportamento do orchestrator/Stage 4 pra resolver isso de raiz está
//      fora do escopo de um fix client-side isolado — a mitigação aqui é
//      NÃO afirmar categoricamente "editado manualmente" na mensagem
//      (DIVERGENCE_CONFIRM_MESSAGE abaixo), já que autoria não é decidível
//      só do lado client.
//   2. O guard disparava pra QUALQUER slug salvo (`01-categorized`,
//      `02-reviewed`, `03-social`), mas só `02-reviewed.md` de fato
//      alimenta o render do `newsletter-final.html` — os outros 2 não têm
//      vínculo causal com o risco (`shouldConfirmDivergenceGuard` abaixo
//      restringe a `reviewed`).
//   3. A flag `htmlFinalDiverged` em memória podia ficar stale (TOCTOU) —
//      resolvido no chamador (`saveCurrent()` em revisao.js), que re-busca o
//      estado fresco do servidor antes de consultar o resultado desta
//      função, não é lógica pura então fica fora deste módulo.

/** Só o slug `reviewed` (02-reviewed.md) alimenta o render do HTML final —
 * `categorized`/`social` não têm vínculo causal com o risco de divergência,
 * então não devem disparar o guard (#3668 gap 2). `html-final` também nunca
 * deveria disparar (salvar o próprio HTML não avisa sobre ele mesmo), mas
 * isso já era garantido antes por outro caminho — aqui a checagem é
 * positiva (allowlist de 1 slug), não negativa. */
export function shouldConfirmDivergenceGuard(slug) {
  return slug === "reviewed";
}

/** Mensagem do `confirm()` disparado por `saveCurrent()` quando
 * `shouldConfirmDivergenceGuard(currentSlug)` é true e o servidor confirma
 * divergência fresca. Redigida pra NÃO afirmar autoria ("editado
 * manualmente") — só descreve o fato observável (o arquivo mudou desde a
 * última leitura) e o risco real (#3668 gap 1). */
export const DIVERGENCE_CONFIRM_MESSAGE =
  "HTML final (_internal/newsletter-final.html) foi modificado desde a última vez que você abriu este " +
  "painel (pode ser edição sua ou re-render do agente). Salvar 02-reviewed.md agora não altera o HTML — " +
  "mas um re-render futuro a partir dele (rodar a Etapa 4 de novo) vai descartar essas mudanças sem " +
  "aviso automático da pipeline. Salvar mesmo assim?";

// #3729 — warn-before-save: o EDITOR (Studio) e o PIPELINE (title-picker,
// Clarice, humanizador, todos via Edit/Write do agente) escrevem DIRETO no
// mesmo `02-reviewed.md`/`03-social.md` compartilhado, sem lock nem CAS. Se o
// pipeline reescrever o arquivo entre o momento em que o editor abriu o
// painel e o momento em que clica "Salvar", o PUT normal sobrescreveria essa
// escrita do pipeline silenciosamente. O server detecta isso comparando o
// mtime que o client viu no GET (`expectedModifiedAt`) contra o mtime ATUAL
// em disco (`saveReviewFile` em studio-review.ts) e responde 409 em vez de
// escrever — este módulo só hospeda a mensagem PURA mostrada nesse caso
// (mesmo padrão de DIVERGENCE_CONFIRM_MESSAGE acima: nenhuma lógica de
// DOM/fetch aqui, só texto testável sem harness).
//
// Escopo explícito (decisão do coordenador, comentário #3729 260720): isto
// protege o save do EDITOR de sobrescrever uma escrita do PIPELINE — não o
// inverso (pipeline sobrescrevendo uma edição do editor ainda não salva).
// Risco residual documentado em CLAUDE.md.
export const SAVE_CONFLICT_CONFIRM_MESSAGE =
  "O arquivo mudou desde que você abriu este painel — provavelmente o pipeline salvou uma versão nova " +
  "(ex: title-picker, correção Clarice, humanizador) enquanto você editava. Clique OK para SOBRESCREVER " +
  "com a sua versão mesmo assim, ou Cancelar para RECARREGAR a versão mais recente do disco (suas " +
  "edições não salvas nesta aba serão perdidas).";

// #3872 (achado #3866 dimensão 2): depois de um save bem-sucedido, o painel
// lateral que estava aberto (Diff/Lints/Preview) continuava mostrando o
// resultado do estado ANTERIOR ao save até o editor re-clicar manualmente em
// "Ver diff"/"Rodar lints" — risco real de aprovar o gate de revisão em cima
// de um lint "ok" que já não reflete o conteúdo salvo.
// `activeSidePaneAfterSave` decide qual painel re-rodar dado o estado
// `hidden` dos 3 painéis (lidos pelo caller em revisao.js via
// `el.paneDiff.hidden`/`el.paneLint.hidden`/`el.panePreview.hidden`) — lógica
// PURA, sem tocar DOM/fetch, mesmo padrão dos guards acima (#633: testável
// sem harness). Prioridade diff > lint > preview é só ordem de checagem —
// irrelevante na prática, já que `activateSidePane()` em revisao.js garante
// que só 1 dos 3 fica visível por vez. Retorna `null` quando nenhum painel
// lateral está aberto (nada a re-sincronizar).
export function activeSidePaneAfterSave({ diffHidden, lintHidden, previewHidden }) {
  if (!diffHidden) return "diff";
  if (!lintHidden) return "lint";
  if (!previewHidden) return "preview";
  return null;
}
