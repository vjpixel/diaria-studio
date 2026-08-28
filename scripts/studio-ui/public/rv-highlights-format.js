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
 * escolhido uma das opções (radio) OU reescrito o texto num campo livre.
 * Campo livre vazio (após trim) usa a opção selecionada; qualquer texto no
 * campo livre vence (reescrita manual), mesmo que coincida com uma opção —
 * não há comparação de igualdade aqui (enviar de volta um texto idêntico à
 * opção já selecionada produz o mesmo resultado de qualquer forma, então a
 * ausência dessa checagem é inofensiva).
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

/** Estado inicial de 1 card a partir do `HighlightBlock` vindo da API —
 * função pura, sem DOM, extraída pra ser reusável por `mergeIncomingHighlights`
 * abaixo e testável direto (nenhum node/elemento é criado aqui). */
export function initCardState(h, modifiedAt) {
  return {
    n: h.n,
    category: h.category,
    titleOptions: h.titleOptions,
    url: h.url,
    body: [...h.body],
    whyMatters: h.whyMatters,
    modifiedAt,
    selectedIndex: 0,
    freeformTitle: "",
    dirty: false,
    saving: false,
    statusMessage: "",
    statusKind: "", // "dirty" | "saved" | "error" | ""
  };
}

/**
 * Reconcilia o estado dos cards já em tela com uma resposta NOVA do GET
 * `.../review/reviewed/highlights` — pura, sem DOM (rv-highlights.js só
 * chama e aplica o resultado ao `cardState`/DOM).
 *
 * Corrige um bug real (achado no review do #6493, code-reviewer): antes,
 * QUALQUER reload — inclusive o disparado pelo evento `rv:reviewed-saved`
 * quando OUTRO card acabou de salvar — limpava `cardState` inteiro e
 * reconstruía todos os cards a partir do disco, silenciosamente descartando
 * edição não-salva (`dirty:true`) que o editor tivesse em progresso em
 * QUALQUER OUTRO card. Um card marcado `dirty` é preservado tal como está
 * (nem o texto local nem o `modifiedAt` capturado são tocados) — se esse
 * card divergiu de verdade do disco (porque o card que motivou o reload
 * reescreveu o MESMO arquivo), a próxima tentativa de salvá-lo recebe o 409
 * de conflito de sempre (#3729), que é o resultado CORRETO, não um bug: o
 * arquivo genuinamente mudou desde que este card leu seu estado.
 */
export function mergeIncomingHighlights(previousStates, incomingHighlights, modifiedAt) {
  const prevByN = new Map((previousStates || []).map((s) => [s.n, s]));
  return (incomingHighlights || []).map((h) => {
    const prev = prevByN.get(h.n);
    if (prev && prev.dirty) return prev;
    return initCardState(h, modifiedAt);
  });
}
