// rv-split-preview-format.js (#6447 Fatia 3) — lógica PURA do split view
// (editor | preview) com re-render por debounce: quais slugs têm preview
// reativo, guard de sequência contra resposta fora de ordem, e o valor de
// debounce. Módulo sem DOM (mesmo padrão de rv-gate-format.js/
// rv-highlights-format.js) — testável sem servidor/jsdom; o DOM-touching
// mora em revisao.js, que importa daqui.

// #6447 Fatia 3: 700ms — dentro da faixa sugerida na issue (600-800ms).
// Rationale: curto o bastante pra parecer "ao vivo" (o editor não espera
// mais que ~1s depois de parar de digitar), longo o bastante pra não
// disparar uma request a cada tecla — um parágrafo digitado normalmente gera
// pausas de escrita >700ms entre frases/parágrafos, então a maioria das
// teclas nunca chega a agendar uma request própria (o timer é reiniciado a
// cada tecla, só a ÚLTIMA pausa >700ms dispara). Sem medição própria (ao
// contrário do DAILY_CAROUSEL_BODY_SIZE em CLAUDE.md) — é um valor
// razoável, não uma constante calibrada; ajustar livremente se o editor
// achar o preview lento/nervoso demais.
export const DRAFT_PREVIEW_DEBOUNCE_MS = 700;

// Mesmo conjunto de `isDraftPreviewSlug` em studio-review.ts — duplicado
// aqui de propósito (módulo client-side sem import cross-runtime do
// servidor): "reviewed"/"social" são os únicos slugs cujo Markdown em edição
// tem correspondência 1:1 com o que o preview mostra (ver docstring de
// `buildReviewPreviewDraftHtml` em studio-review.ts pro porquê de
// "categorized" ficar de fora). Mantidos em sincronia manualmente — os dois
// lados são pequenos e estáveis (a lista de slugs revisáveis é uma decisão
// de produto rara, não algo que muda por PR).
export function isDraftPreviewSlug(slug) {
  return slug === "reviewed" || slug === "social";
}

// `html-final`/`html-final-patronos` já SÃO o HTML final digitado — o
// preview deles é eco direto do texto do editor (srcdoc local, sem ida ao
// servidor: zero parsing envolvido, then zero motivo pra pagar uma request).
export function isRawEchoSlug(slug) {
  return slug === "html-final" || slug === "html-final-patronos";
}

/**
 * Guard de sequência (#6447 Fatia 3, item 4 do escopo): um debounce pode
 * dessincronizar 2 requisições em voo (rede lenta, 2ª digitação antes da 1ª
 * resposta voltar) — sem isto, a resposta da request MAIS ANTIGA podia
 * chegar DEPOIS da mais nova e sobrescrever um preview já atualizado com um
 * conteúdo obsoleto. `requestSeq` é o número da request cuja resposta acabou
 * de chegar; `latestSeq` é o número da ÚLTIMA request disparada (`counter`
 * mantido pelo caller, incrementado a cada disparo, nunca decrementado).
 * `true` só quando a resposta é da request mais recente — qualquer resposta
 * de uma request anterior é descartada em silêncio (a mais recente, quando
 * chegar, já vai refletir o estado atual).
 */
export function shouldApplyDraftPreviewResponse(requestSeq, latestSeq) {
  return requestSeq === latestSeq;
}

/** Próximo valor de sequência — incremento simples, extraído pra função pura
 * só por simetria/testabilidade com `shouldApplyDraftPreviewResponse` acima
 * (nenhuma lógica não-trivial aqui). */
export function nextDraftPreviewSeq(current) {
  return current + 1;
}

/** Toggle mobile Editor/Preview (#6447 Fatia 3, item 1) — alterna entre os 2
 * únicos valores válidos; qualquer entrada que não seja exatamente "preview"
 * cai em "editor" (fail-safe: nunca retorna um 3º estado). */
export function resolveMobileView(requestedView) {
  return requestedView === "preview" ? "preview" : "editor";
}
