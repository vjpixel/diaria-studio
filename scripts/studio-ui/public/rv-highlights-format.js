// rv-highlights-format.js (#6447 Fatia 2) — formatação/lógica PURA (sem DOM)
// consumida pelo painel "Editor por destaque" (rv-highlights.js). Mesma
// convenção de rv-gate-format.js/revisao-guards.js: nada aqui toca
// `document`/`fetch` — testável direto (test/rv-highlights-format.test.ts).

/** Conta grafemas visíveis (não code units UTF-16) — mesmo critério de
 * `graphemeLength` em `scripts/lib/lint-checks/title-length.ts` (o servidor
 * já usa `Intl.Segmenter` pra não penalizar emojis de bandeira, ex: 🇧🇷 = 1
 * grafema mas 4 code units). Duplicado aqui de propósito: é 3 linhas puras
 * sem estado, e o cliente não tem como importar um módulo `.ts` do servidor
 * — o NÚMERO do limite (52) em si vem da API (`maxTitleLength`, ver
 * `readHighlightsSummary` em studio-review.ts), nunca hardcodado aqui. */
export function graphemeLength(str) {
  return [...new Intl.Segmenter().segment(str)].length;
}

/** `true` quando `title` estoura `maxTitleLength` — vermelho no contador de
 * caracteres da opção (mesmo limite do lint bloqueante `title-length`). */
export function isTitleTooLong(title, maxTitleLength) {
  return graphemeLength(title || "") > maxTitleLength;
}

/** Texto do contador de caracteres exibido ao lado de cada opção de título. */
export function formatTitleCharCount(title, maxTitleLength) {
  return `${graphemeLength(title || "")}/${maxTitleLength}`;
}

/**
 * Resolve o texto do título final a enviar no PUT — o editor pode ter
 * escolhido uma das opções (radio) OU reescrito o texto num campo livre. Se
 * o campo livre está vazio ou é idêntico a alguma opção, usa a opção
 * selecionada; senão, o texto livre vence (reescrita manual).
 */
export function resolveFinalTitle(selectedOptionText, freeformText) {
  const trimmedFreeform = (freeformText || "").trim();
  if (trimmedFreeform === "") return selectedOptionText || "";
  return trimmedFreeform;
}

/** Monta o payload do `PUT .../review/reviewed/highlights/:n` a partir do
 * estado do formulário — trim nos campos de texto, mantém `body` como
 * array (1 entrada por textarea/parágrafo), filtra parágrafos vazios. */
export function buildHighlightSavePayload({ title, url, bodyParagraphs, whyMatters, expectedModifiedAt }) {
  return {
    title: (title || "").trim(),
    url: (url || "").trim(),
    body: (bodyParagraphs || []).map((p) => (p || "").trim()).filter((p) => p.length > 0),
    whyMatters: (whyMatters || "").trim(),
    expectedModifiedAt: expectedModifiedAt ?? null,
  };
}
