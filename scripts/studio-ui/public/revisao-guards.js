// revisao-guards.js (#3668) — lógica PURA do guard de divergência do painel
// de revisão (`revisao.html`/`revisao.js`). Separado de propósito de
// `revisao.js` (mesmo padrão de `revisao-prompts.js` #3629): nenhuma das
// duas exportações abaixo toca `document`/`fetch` — são testáveis com
// fixtures puras, sem DOM real (#633).
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
