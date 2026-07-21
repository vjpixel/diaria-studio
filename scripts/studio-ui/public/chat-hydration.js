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
 * Valida + normaliza o corpo JSON de `GET /api/chat/pending` (#3617/#3804) num
 * array de payloads prontos pra alimentar os renderers de card em
 * chat-drawer.js. Cada entrada carrega `kind`:
 *   - `"question"` → `{kind, toolUseId, toolName, askedAt, questions}`, shape
 *     de `data` do evento `chat-permission-request` (renderer
 *     `onPermissionRequest`);
 *   - `"tool"` (#3804) → `{kind, toolUseId, toolName, askedAt, input}`, shape
 *     de `data` do evento `chat-tool-permission-request` (renderer
 *     `onToolPermissionRequest`).
 * Entradas sem `kind` são tratadas como `"question"` (retrocompat com o
 * payload pré-#3804, que só tinha gates de pergunta). Nunca lança — qualquer
 * entrada malformada é descartada silenciosamente em vez de quebrar a
 * hidratação inteira (fail-soft, mesmo princípio de `parseAskUserQuestionInput`
 * em studio-chat.ts).
 */
export function parsePendingChatResponse(json) {
  if (!json || typeof json !== "object" || !Array.isArray(json.pending)) return [];
  const out = [];
  for (const p of json.pending) {
    if (!p || typeof p !== "object") continue;
    if (typeof p.toolUseId !== "string" || p.toolUseId.trim() === "") continue;
    const askedAt = typeof p.askedAt === "number" ? p.askedAt : Date.now();
    if (p.kind === "tool") {
      if (typeof p.toolName !== "string" || p.toolName.trim() === "") continue;
      out.push({ kind: "tool", toolUseId: p.toolUseId, toolName: p.toolName, askedAt, input: p.input });
    } else {
      if (!Array.isArray(p.questions) || p.questions.length === 0) continue;
      out.push({
        kind: "question",
        toolUseId: p.toolUseId,
        toolName: typeof p.toolName === "string" ? p.toolName : "AskUserQuestion",
        askedAt,
        questions: p.questions,
      });
    }
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

// ─── histórico de transcript (#3803) ───────────────────────────────────────
//
// `chat-drawer.js` reidrata o TRANSCRIPT completo (mensagens do editor +
// texto final do assistente + chips de tool call de turnos ANTERIORES) ao
// montar em qualquer página, ao lado de `hydratePendingPermissions()` — fecha
// o TODO(#3561/#3562) órfão citado no topo daquele arquivo. `parseChatHistoryResponse`
// normaliza o payload cru de `GET /api/chat/history`; `planHistoryReplay` é a
// lógica PURA de "o que ainda falta renderizar", testável sem DOM, mesmo
// papel de `planHydrationCards` acima só que indexada por `seq` monotônico
// (entries de usuário/assistente não têm `toolUseId` como as de tool, então
// dedup por Set de ids não serve aqui).

/**
 * Valida + normaliza o corpo JSON de `GET /api/chat/history` (#3803) num
 * array de entries prontas pro planner/renderer consumirem. Cada entry
 * precisa minimamente de `seq` (number) + `kind` (string) — o resto do shape
 * varia por `kind` (`user`/`assistant`/`tool`/`error`, ver `ChatHistoryEntry`
 * em studio-chat.ts) e é repassado como está pro dispatcher de render em
 * chat-drawer.js. Nunca lança — entrada malformada é descartada em vez de
 * quebrar a hidratação inteira (mesmo princípio de `parsePendingChatResponse`).
 */
export function parseChatHistoryResponse(json) {
  if (!json || typeof json !== "object" || !Array.isArray(json.history)) return [];
  const out = [];
  for (const e of json.history) {
    if (!e || typeof e !== "object") continue;
    if (typeof e.seq !== "number" || typeof e.kind !== "string") continue;
    out.push(e);
  }
  return out;
}

/**
 * Lógica PURA de replay: dado o histórico completo já normalizado (ordenado
 * por `seq` crescente, como o servidor emite) e o maior `seq` já renderizado
 * nesta página (`lastSeq`, `0` = nada renderizado ainda), devolve só as
 * entries novas (`seq > lastSeq`, na mesma ordem) e o novo high-water mark a
 * guardar. Cobre tanto o replay inicial do mount (`lastSeq=0` -> tudo é
 * "novo") quanto uma 2ª chamada de hidratação na mesma vida da página (ex:
 * um futuro caminho de retry/reconexão) sem duplicar entries já desenhadas —
 * o risco apontado no self-review desta issue (#3803).
 */
export function planHistoryReplay(entries, lastSeq = 0) {
  const toRender = entries.filter((e) => e.seq > lastSeq);
  const nextSeq = toRender.reduce((max, e) => Math.max(max, e.seq), lastSeq);
  return { toRender, nextSeq };
}

// ─── detecção de pergunta sensível (#3561, gate cat. A do develop) ────────
//
// `.claude/skills/diaria-develop/SKILL.md` §Fase 0.5 pede o editor colar
// tokens/credenciais (cat. A) — quando essa pergunta chega via
// `AskUserQuestion` (ex: sessão de chat rodando /diaria-develop), o campo
// livre "Other" do card (chat-drawer.js) precisa NUNCA ecoar o valor digitado
// em nenhum lugar visível (#3561 critério de aceite). `plan.json` já garante
// isso do lado do servidor (SKILL.md: "o plan.json nunca armazena o valor de
// um token") — esta função é o sinal client-side pra mascarar o INPUT
// (type="password" em vez de "text") e limpar o valor da tela assim que a
// resposta é enviada. Heurística textual (best-effort, sem contrato
// dedicado do SDK pra "esta pergunta pede um secret") — cobre os termos que
// o próprio SKILL.md usa pra cat. A: token, credencial, senha, API key,
// secret, chave de API.

const SENSITIVE_RE = /\b(token|credencial|secret|senha|password|api[\s-]?key|chave\s+de\s+api)\b/i;

/**
 * Detecta se UMA pergunta (`{header, question}`, mesmo shape de
 * `ChatPermissionQuestion`) provavelmente pede um valor sensível (token/
 * credencial/senha) — o texto de `header` OU `question` bate no padrão.
 * Pura, sem I/O; sempre retorna boolean, nunca lança mesmo com input
 * malformado (fail-closed pro lado seguro: input inesperado -> `false`, o
 * campo continua padrão "text" em vez de quebrar a renderização do card).
 */
export function isSensitiveQuestion(q) {
  if (!q || typeof q !== "object") return false;
  const header = typeof q.header === "string" ? q.header : "";
  const question = typeof q.question === "string" ? q.question : "";
  return SENSITIVE_RE.test(header) || SENSITIVE_RE.test(question);
}
