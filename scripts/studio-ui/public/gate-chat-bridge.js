// gate-chat-bridge.js (#3870) — lógica PURA da ponte visível entre o card
// "Gate 4"/"Gate 6" do cockpit (`edicao.js`, #3558) e o card de
// AskUserQuestion/tool-decision do chat drawer (#3557/#3617/#3804).
//
// Achado original (#3866 dimensão 4 / #3870): os cards de gate do cockpit
// mostram status mas não têm NENHUMA ação — o texto manda "aprovar no
// terminal", mesmo quando a aprovação real já está disponível como card no
// chat drawer da própria página. Este módulo decide, a partir do estado já
// exposto pelas APIs existentes (nenhuma rota nova), se o cockpit deve
// mostrar um botão "Responder no chat" ou o texto de sessão-terminal.
//
// Extraído como módulo próprio SEM tocar `document` — mesmo motivo de
// `chat-hydration.js` (#3617): permite cobertura via node:test puro, sem
// harness de DOM (este projeto não tem jsdom/happy-dom, ver
// test/studio-edicao-page.test.ts). `edicao.js` importa estas funções e
// cuida do DOM; nenhuma lógica de decisão mora lá.
//
// Fonte dos dados: `detail.gatesPending` (`GET /api/editions/:aammdd`, já
// consumido por `renderGate4`/`renderGate6`) + `chatPermissionsPending`
// (`GET /api/state`, também empurrado a cada evento SSE `state` — ver
// `studio-state.ts`/`buildStudioState`).
//
// Simplificação deliberada: esta ponte NÃO tenta casar um `toolUseId`
// específico com a edição/gate certos (não existe esse vínculo no wire hoje
// — `PendingPermissionSummary` não carrega AAMMDD nem número de stage). O
// Studio roda UMA sessão de chat por rootDir (`pendingByRoot` em
// studio-chat.ts é um único Map), e só uma pipeline roda por vez na prática
// — "há gate pendente NESTA edição" + "há card pendente no chat" já é, na
// prática, o mesmo evento. Dois gates pendentes ao mesmo tempo (4 E 6) é um
// cenário que não deveria ocorrer no fluxo normal (Stage 6 só fica pendente
// depois do Stage 5, que só roda depois do Stage 4 aprovado) — tratado aqui
// só pra não quebrar o banner se acontecer (ver `pickBannerGate`).

/**
 * Resolve o estado da ponte pro gate `gateNumber` (4 ou 6): se está
 * pendente (`gatesPending.includes(gateNumber)`), e se há pelo menos 1 card
 * de chat aguardando resposta (`chatPermissionsPending`, qualquer `kind` —
 * "question" do AskUserQuestion do próprio gate OU "tool" de um passo
 * intermediário #3804; o botão "Responder no chat" serve pros dois, o
 * drawer já sabe renderizar ambos). Pura, defensiva — nunca lança com input
 * malformado (fail-soft, mesma disciplina de `chat-hydration.js`).
 */
export function resolveGateChatBridge(gateNumber, gatesPending, chatPermissionsPending) {
  const pending = Array.isArray(gatesPending) && gatesPending.includes(gateNumber);
  if (!pending) return { pending: false, hasCard: false, oldestAskedAt: null };

  const list = Array.isArray(chatPermissionsPending) ? chatPermissionsPending : [];
  const askedTimes = list
    .map((p) => (p && typeof p.askedAt === "number" && !Number.isNaN(p.askedAt) ? p.askedAt : null))
    .filter((n) => n !== null);
  const hasCard = askedTimes.length > 0;
  const oldestAskedAt = hasCard ? Math.min(...askedTimes) : null;
  return { pending: true, hasCard, oldestAskedAt };
}

/**
 * "esperando há Xmin" / "esperando…" — mesma regra/texto de `formatWaited`
 * em chat-drawer.js (não importado de lá de propósito: chat-drawer.js tem
 * side-effect de DOM no top-level — constrói o painel ao ser importado — e
 * não pode entrar num teste Node puro; duplicar ~3 linhas é mais barato que
 * quebrar esse isolamento). `now` é injetável só pra determinismo em teste.
 */
export function formatWaitingSince(askedAtMs, now = Date.now()) {
  if (typeof askedAtMs !== "number" || Number.isNaN(askedAtMs)) return "";
  const mins = Math.floor((now - askedAtMs) / 60000);
  return mins > 0 ? `esperando há ${mins}min` : "esperando…";
}

/**
 * Pro banner do TOPO do cockpit (proposta item 3, #3870): dado o resultado
 * de `resolveGateChatBridge` pro gate 4 e pro gate 6, devolve qual deles (se
 * algum) deve aparecer no banner — o gate 4 tem prioridade em empate (ordem
 * natural do pipeline), e entre dois pendentes com card, o que está
 * esperando há mais tempo vence. `null` quando nenhum dos dois está
 * pendente.
 */
export function pickBannerGate(gate4Bridge, gate6Bridge) {
  const candidates = [];
  if (gate4Bridge && gate4Bridge.pending) candidates.push({ gate: 4, ...gate4Bridge });
  if (gate6Bridge && gate6Bridge.pending) candidates.push({ gate: 6, ...gate6Bridge });
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  candidates.sort((a, b) => (a.oldestAskedAt ?? Infinity) - (b.oldestAskedAt ?? Infinity));
  return candidates[0];
}
