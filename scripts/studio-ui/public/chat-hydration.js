// chat-hydration.js (#3617) — lógica PURA de hidratação do chat drawer,
// separada de chat-drawer.js de propósito: chat-drawer.js toca `document`
// no top-level (constrói o DOM do painel assim que é importado), o que o
// torna impossível de importar num teste Node puro sem um DOM real. Este
// módulo não tem NENHUM side-effect de top-level (sem `document`, sem
// `fetch`, sem `localStorage`) — só funções puras, testáveis com fixtures,
// mesmo padrão de `sdkMessageToChatEvents`/`parseChatRequestBody` em
// `studio-chat.ts` (server-side). `chat-drawer.js` importa e chama estas
// funções; a parte de DOM (montar o card, de fato) continua reusando
// `onPermissionRequest`, o MESMO renderer que o fluxo ao vivo (evento SSE
// `chat-permission-request`) já usa — sem duplicar a lógica de render.

/**
 * Valida + normaliza o corpo JSON de `GET /api/chat/pending` (#3617) num
 * array de payloads prontos pra alimentar o renderer de card
 * (`onPermissionRequest` em chat-drawer.js), no mesmo shape de
 * `data` do evento `chat-permission-request` (`{toolUseId, questions,
 * askedAt}`). Nunca lança — qualquer entrada malformada é descartada
 * silenciosamente em vez de quebrar a hidratação inteira (fail-soft, mesmo
 * princípio de `parseAskUserQuestionInput` em studio-chat.ts).
 */
export function parsePendingChatResponse(json) {
  if (!json || typeof json !== "object" || !Array.isArray(json.pending)) return [];
  const out = [];
  for (const p of json.pending) {
    if (!p || typeof p !== "object") continue;
    if (typeof p.toolUseId !== "string" || p.toolUseId.trim() === "") continue;
    if (!Array.isArray(p.questions) || p.questions.length === 0) continue;
    out.push({
      toolUseId: p.toolUseId,
      toolName: typeof p.toolName === "string" ? p.toolName : "AskUserQuestion",
      askedAt: typeof p.askedAt === "number" ? p.askedAt : Date.now(),
      questions: p.questions,
    });
  }
  return out;
}

/**
 * Filtra os pendentes que ainda não têm card renderizado no DOM — evita
 * duplicar quando a hidratação roda mais de uma vez (ex: `hydrate()` chamada
 * de novo depois de uma reconexão). Pura: recebe o conjunto de ids já
 * renderizados (iterável — normalmente as chaves do Map de cards do
 * chat-drawer.js) e devolve só os novos, na mesma ordem recebida.
 */
export function planHydrationCards(pending, renderedIds) {
  const rendered = renderedIds instanceof Set ? renderedIds : new Set(renderedIds);
  return pending.filter((p) => !rendered.has(p.toolUseId));
}
