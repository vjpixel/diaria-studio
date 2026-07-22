// chat-drawer.js (#3556, fatia 2 do epic "Studio UI" #3554; redesenhado no
// #3617) — painel FIXO à ESQUERDA com uma sessão Claude real (Agent SDK,
// server-side em studio-chat.ts). Vanilla JS, sem build step, sem lib nova
// (mesmo princípio de app.js/#3555).
//
// Injetado em toda página do studio (index/edicao/triagem/apoios/revisao)
// via `<script src="/chat-drawer.js" type="module"></script>` — constrói o
// próprio DOM (painel único) em vez de exigir markup duplicado em cada HTML,
// então uma única tag basta pra ligar o chat em qualquer página.
//
// Transporte: POST /api/chat com um corpo JSON, resposta é
// text/event-stream — só que `EventSource` não suporta POST, então este
// módulo lê `response.body` manualmente e faz o parsing SSE (linhas
// "event: X" / "data: Y" separadas por linha em branco) por conta própria.
// Formato dos eventos: ver `sdkMessageToChatEvents` em `studio-chat.ts`.
//
// Sessão: o `sessionId` retornado em `chat-init`/`chat-done` é persistido em
// localStorage — reabrir a página (ou reconectar de outro tab) resume a
// MESMA sessão Claude via `resume` do SDK (#3556 critério de aceite
// "reconexão de browser preserva a sessão"; best-effort: funciona no mesmo
// browser/perfil, não entre browsers diferentes — histórico multi-cliente é
// escopo maior, fora desta fundação).
//
// #3557: quando a sessão chama `AskUserQuestion`, o server NÃO nega mais —
// emite `chat-permission-request` (ver `makeInteractiveCanUseTool` em
// studio-chat.ts) e este módulo renderiza um card/form (header + opções
// clicáveis + campo livre "Other" + botão "Responder"). O clique faz
// `POST /api/chat/answer` com `{toolUseId, answers, response?}` — a stream
// SSE já aberta desta MESMA sendMessage() retoma sozinha assim que o server
// resolve a Promise pendente (o `chat-tool` "end" da própria AskUserQuestion
// chega depois, pela mesma stream). Sem timeout por design — só mostramos
// "esperando há Xmin" client-side.
//
// #3804: qualquer OUTRA tool não-allowlistada (Bash/Edit/etc.) também deixou
// de ser negada de cara — emite `chat-tool-permission-request` e este módulo
// renderiza um card aprovar/negar (`onToolPermissionRequest`) com o preview
// do input + 3 botões (Aprovar / Sempre nesta sessão / Negar), resolvido via
// `POST /api/chat/tool-decision`. É o que destrava rodar o pipeline
// (`/diaria-edicao`, cheio de Bash) pelo drawer. O chip "negado"
// (`onToolDenied`) segue só pro caso de uma deny vinda do próprio SDK.
//
// #3617 — BUG que este redesenho corrige por construção: o card de
// AskUserQuestion só era renderizado como parte do stream AO VIVO da chamada
// `POST /api/chat` que originou a pergunta. Sem hidratação, fechar o
// painel/recarregar a página/navegar pra outra página do Studio (MPA — cada
// página injeta este script do zero, não é SPA) perdia qualquer jeito de
// re-exibir a pergunta pendente, mesmo com o servidor ainda esperando (sem
// timeout, por design do #3557) — a sessão do Agent SDK travava PRA SEMPRE
// sem jeito de responder pela UI. Fix: (1) painel FIXO à esquerda, SEMPRE
// presente (nunca `display:none`/escondido por padrão — só colapsa de
// LARGURA, ver chat-drawer.css); (2) ao montar em QUALQUER página, busca
// `GET /api/chat/pending` (payload completo, `questions[]` inteiro — não só
// `firstQuestion`) e reidrata o(s) card(s) pendente(s) com o MESMO renderer
// (`onPermissionRequest`) do fluxo ao vivo, expandindo o painel
// automaticamente pra garantir que o card fique visível sem depender de
// clique nenhum. A lógica pura de parse/dedupe fica em `chat-hydration.js`
// (testável sem DOM — este arquivo toca `document` no top-level e não pode
// ser importado num teste Node puro).
// #3803: o TODO acima (histórico completo de mensagens de turnos anteriores)
// foi fechado — não via `resume` do SDK (que de fato não expõe isso), e sim
// com um buffer de histórico em memória por `rootDir` do lado do servidor
// (`studio-chat.ts` `appendChatHistoryUserMessage`/`appendChatHistoryEvent`,
// alimentado dentro do MESMO `handleApiChat` que já emite os eventos SSE).
// `GET /api/chat/history` serve esse buffer; `hydrateChatHistory` abaixo o
// busca ao montar em QUALQUER página e reproduz cada entry (mensagem do
// editor, texto final do assistente, chip de tool start/end/denied) usando
// os MESMOS renderers do fluxo ao vivo (`appendUserMessage`,
// `currentAssistantBody`/`finalizeAssistantMessage`, `onToolStart`/
// `onToolEnd`/`onToolDenied`) — nenhuma lógica de render duplicada. A lógica
// pura de "quais entries ainda faltam desenhar" (por `seq` monotônico, dedup
// contra re-hidratação) fica em `chat-hydration.js` `planHistoryReplay`,
// testável sem DOM, mesmo padrão de `planHydrationCards`.
//
// #3687: a sessão de chat não sabia qual edição/arquivo/aba estavam abertos
// no painel ao lado — referências implícitas do editor ("passe a Clarice
// nesse texto") não resolviam sozinhas. `setContext(ctx)` (exposto em
// `window.diariaStudioChat`, mesmo padrão de `prefillMessage`) guarda o
// estado mais recente informado pela página host; `sendMessage` reenvia esse
// estado em CADA turno (campo `context` do corpo de `POST /api/chat` — ver
// `ChatPanelContext`/`buildChatPrompt` em `studio-chat.ts`), então ele
// acompanha o editor trocando de edição/arquivo/aba entre mensagens, não só
// no momento em que o drawer foi montado. Páginas sem esse conceito
// (triagem/apoios/rodada) simplesmente nunca chamam `setContext` — o campo
// fica `null` e nenhum bloco de contexto é enviado, comportamento idêntico
// ao pré-#3687.

import {
  parsePendingChatResponse,
  planHydrationCards,
  isSensitiveQuestion,
  parseChatHistoryResponse,
  planHistoryReplay,
} from "./chat-hydration.js";

const STORAGE_KEY = "diaria-studio-chat-session-id";
const COLLAPSE_STORAGE_KEY = "diaria-studio-chat-collapsed";

let sessionId = null;
try {
  sessionId = localStorage.getItem(STORAGE_KEY);
} catch {
  // localStorage pode estar indisponível (modo privado restritivo) — degrada
  // pra sessão nova a cada reload, sem quebrar o drawer.
}

function persistSessionId(id) {
  sessionId = id;
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // best-effort — ver comentário acima.
  }
}

// ─── contexto do painel (#3687) ────────────────────────────────────────────

// Estado mais recente informado pela página host via `setContext` — `null`
// enquanto nenhuma página chamou (ou numa página sem esse conceito, ex:
// triagem/apoios/rodada). Não persiste em localStorage de propósito: é
// estado de NAVEGAÇÃO da aba atual, não de sessão — recarregar/trocar de
// página deve refletir o painel que está de fato aberto agora, nunca um
// valor obsoleto de uma visita anterior.
let panelContext = null;

/** Substitui o contexto do painel (edição/arquivo/aba) por inteiro — a
 * página host chama de novo a cada mudança relevante (ex: `revisao.js` em
 * `renderTabs()`), não só uma vez ao montar. `ctx` nulo/não-objeto limpa o
 * contexto (mensagem seguinte não leva bloco nenhum) em vez de lançar —
 * mesma disciplina fail-soft do resto do drawer. */
function setContext(ctx) {
  panelContext = ctx && typeof ctx === "object" ? { ...ctx } : null;
}

// ─── DOM ────────────────────────────────────────────────────────────────
// #3617: painel único, FIXO à esquerda (ver chat-drawer.css) — sem toggle
// flutuante separado que esconde o conteúdo. O botão de expandir/recolher
// mora dentro do próprio header do painel; recolher só reduz a LARGURA
// (rail fino com dot + badge sempre visíveis), nunca esconde o painel
// inteiro.

let startCollapsed = true;
try {
  startCollapsed = localStorage.getItem(COLLAPSE_STORAGE_KEY) !== "0";
} catch {
  // best-effort — default colapsado.
}

const drawer = document.createElement("aside");
drawer.className = "chat-drawer" + (startCollapsed ? " collapsed" : "");
drawer.innerHTML = `
  <div class="chat-drawer-header">
    <button type="button" class="chat-expand-toggle" id="chat-expand-toggle" title="Expandir/recolher chat" aria-expanded="${String(!startCollapsed)}" aria-controls="chat-messages">
      <span class="chat-toggle-dot" id="chat-toggle-dot"></span>
      <span class="chat-drawer-title">Chat — sessão Claude</span>
      <span class="chat-toggle-badge" id="chat-toggle-badge" style="display:none"></span>
    </button>
    <button type="button" id="chat-mobile-close" class="chat-mobile-close" title="Fechar chat" aria-label="Fechar chat">✕</button>
    <button type="button" id="chat-reset" title="Nova conversa">nova conversa</button>
  </div>
  <div class="chat-messages" id="chat-messages" aria-live="polite"></div>
  <div class="chat-drawer-footer">
    <textarea id="chat-input" placeholder="Mensagem para a sessão Claude..." rows="2"></textarea>
    <button type="button" id="chat-send">Enviar</button>
  </div>
  <div class="chat-hint">
    Sessão real (Claude Agent SDK) rodando no studio-server local — mesmas
    skills/MCPs/CLAUDE.md do terminal. Perguntas da sessão (AskUserQuestion)
    aparecem como formulário abaixo, sem prazo pra responder, e ficam
    acessíveis mesmo recarregando ou navegando pra outra página; qualquer
    outra ação que pediria confirmação interativa aparece negada.
  </div>
`;

document.body.appendChild(drawer);
document.body.classList.add("chat-drawer-present");
document.body.classList.toggle("chat-drawer-collapsed", startCollapsed);

const el = {
  expandToggle: drawer.querySelector("#chat-expand-toggle"),
  toggleDot: drawer.querySelector("#chat-toggle-dot"),
  toggleBadge: drawer.querySelector("#chat-toggle-badge"),
  mobileClose: drawer.querySelector("#chat-mobile-close"),
  messages: drawer.querySelector("#chat-messages"),
  input: drawer.querySelector("#chat-input"),
  send: drawer.querySelector("#chat-send"),
  reset: drawer.querySelector("#chat-reset"),
};

// #3851: mantém `--chat-viewport-height` (lida por chat-drawer.css só no
// media query mobile) sincronizada com `visualViewport.height` — o teclado
// virtual encolhe o viewport VISUAL sem necessariamente disparar um resize
// do viewport de LAYOUT em toda engine/versão (é o clássico "footer sobe
// atrás do teclado"). Onde `visualViewport` existe, o CSS passa a dimensionar
// o painel pela altura REAL disponível em vez de um 100dvh estático que não
// necessariamente reflete o teclado aberto. Fail-soft: sem a API (browser
// antigo, ambiente de teste sem viewport real), a var nunca é setada e o
// fallback `var(--chat-viewport-height, 100dvh)` do CSS assume sozinho.
function syncViewportHeight() {
  if (!window.visualViewport) return;
  document.documentElement.style.setProperty("--chat-viewport-height", `${window.visualViewport.height}px`);
}
if (window.visualViewport) {
  syncViewportHeight();
  window.visualViewport.addEventListener("resize", syncViewportHeight);
  window.visualViewport.addEventListener("scroll", syncViewportHeight);
}

function setToggleStatus(status) {
  // "ok" | "down" | "" (idle) — mesmo vocabulário do dot de /api/events.
  el.toggleDot.className = "chat-toggle-dot " + status;
}

// #3557/#3617: badge de gates pendentes (AskUserQuestion aguardando
// resposta), visível mesmo com o painel colapsado (rail fino) — fonte é
// `state.chatPermissionsPending` (studio-state.ts), atualizado por
// assinatura própria de `/api/events` (independente de app.js, que só
// existe em index.html — chat-drawer.js é injetado em várias páginas e
// precisa funcionar sozinho em todas).
function setPendingBadge(count) {
  if (count > 0) {
    el.toggleBadge.textContent = String(count);
    el.toggleBadge.style.display = "";
  } else {
    el.toggleBadge.style.display = "none";
  }
}

try {
  const statusEvents = new EventSource("/api/events");
  statusEvents.addEventListener("state", (ev) => {
    try {
      const state = JSON.parse(ev.data);
      setPendingBadge(Array.isArray(state.chatPermissionsPending) ? state.chatPermissionsPending.length : 0);
    } catch {
      // payload malformado — o badge simplesmente não atualiza neste tick.
    }
  });
} catch {
  // EventSource indisponível (ambiente de teste/sem browser real) — badge
  // fica em 0, sem quebrar o resto do drawer.
}

function persistCollapsed(collapsed) {
  try {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    // best-effort
  }
}

function setCollapsed(collapsed) {
  drawer.classList.toggle("collapsed", collapsed);
  document.body.classList.toggle("chat-drawer-collapsed", collapsed);
  // #3874: `aria-expanded` reflete o estado real do painel (mesmo padrão de
  // `nav.js`/`app-nav-toggle`) — atualizado aqui, no ÚNICO ponto que já
  // centraliza toda mudança de collapsed/expanded (clique no toggle, botão
  // "fechar" mobile, e o auto-expand de `expandDrawer()` quando chega um gate
  // novo — todos os 3 caminhos passam por esta função).
  el.expandToggle.setAttribute("aria-expanded", String(!collapsed));
  persistCollapsed(collapsed);
}

function expandDrawer() {
  setCollapsed(false);
}

// #3870: ponte visível gate 4/6 (cockpit, edicao.js) → card pendente deste
// drawer. Expande o painel (mesma `expandDrawer()` de sempre) e rola até o
// card AINDA NÃO resolvido mais antigo (`.resolved` é removido de nenhum
// card — só adicionado quando o editor responde — então "não tem a classe"
// == "ainda esperando"). Sem card nenhum (raro: o gate ficou pendente mas o
// card já foi respondido/expirou por outro caminho), degrada pra só abrir o
// painel e rolar pro fim, igual ao comportamento pré-#3870 de `openDrawer`.
function scrollToPendingCard() {
  expandDrawer();
  const pendingCard = [...permissionCards.values()].find((c) => !c.classList.contains("resolved"));
  if (!pendingCard) {
    scrollToBottom();
    return;
  }
  pendingCard.scrollIntoView({ behavior: "smooth", block: "center" });
  pendingCard.classList.add("chat-permission-card-highlight");
  setTimeout(() => pendingCard.classList.remove("chat-permission-card-highlight"), 2000);
}

el.expandToggle.addEventListener("click", () => {
  setCollapsed(!drawer.classList.contains("collapsed"));
});

// #3851: "fechar explícito" do overlay mobile — visível só abaixo do
// breakpoint de 720px e só quando o painel está aberto (ver chat-drawer.css,
// `.chat-drawer:not(.collapsed) .chat-mobile-close`). Reusa exatamente o
// mesmo `setCollapsed(true)` que `el.expandToggle` já chama quando expandido
// — nenhuma lógica de collapse nova, só um segundo alvo com rótulo
// inequívoco de "fechar" (o header inteiro já fecha ao re-clicar, mas sem
// essa affordance visual).
el.mobileClose.addEventListener("click", () => {
  setCollapsed(true);
});

// #3556 self-review: limpar só o estado do CLIENTE (sessionId local +
// localStorage) não bastava — a próxima mensagem, sem `sessionId`, caía no
// fallback `getSessionId(rootDir)` do SERVER (ver handleApiChat em
// server.ts) e resumia a MESMA sessão antiga. `pendingReset` é consumido
// pelo próximo `sendMessage` pra mandar `reset: true` explicitamente, que
// limpa também o estado em memória do server (`clearSession`).
let pendingReset = false;

el.reset.addEventListener("click", () => {
  sessionId = null;
  pendingReset = true;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // best-effort
  }
  el.messages.innerHTML = "";
  permissionCards.clear();
  appendSystemNote("nova conversa — sessão anterior desvinculada (o histórico continua no disco do Claude Code, só não é mais retomado por padrão).");
});

// ─── render ─────────────────────────────────────────────────────────────

function scrollToBottom() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

function appendUserMessage(text) {
  const row = document.createElement("div");
  row.className = "chat-msg user";
  row.innerHTML = '<div class="chat-msg-role">você</div><div class="chat-msg-body"></div>';
  row.querySelector(".chat-msg-body").textContent = text;
  el.messages.appendChild(row);
  scrollToBottom();
}

/** Cria (ou retorna, se já existir) o bloco de resposta do assistente pro
 * turno corrente — os deltas de texto vão se acumulando nele. */
function currentAssistantBody() {
  let row = el.messages.querySelector(".chat-msg.assistant.current");
  if (!row) {
    row = document.createElement("div");
    row.className = "chat-msg assistant current";
    row.innerHTML = '<div class="chat-msg-role">claude</div><div class="chat-msg-body"></div>';
    el.messages.appendChild(row);
  }
  return row.querySelector(".chat-msg-body");
}

function finalizeAssistantMessage() {
  const row = el.messages.querySelector(".chat-msg.assistant.current");
  if (row) row.classList.remove("current");
}

function appendSystemNote(text) {
  const row = document.createElement("div");
  row.className = "chat-msg system";
  row.innerHTML = '<div class="chat-msg-body"></div>';
  row.querySelector(".chat-msg-body").textContent = text;
  el.messages.appendChild(row);
  scrollToBottom();
}

function appendErrorNote(text) {
  const row = document.createElement("div");
  row.className = "chat-msg error";
  row.innerHTML = '<div class="chat-msg-body"></div>';
  row.querySelector(".chat-msg-body").textContent = text;
  el.messages.appendChild(row);
  scrollToBottom();
}

const toolChips = new Map(); // toolUseId -> chip element

function onToolStart(data) {
  const chip = document.createElement("div");
  chip.className = "chat-tool-chip start";
  chip.textContent = `▸ ${data.name}`;
  toolChips.set(data.toolUseId, chip);
  el.messages.appendChild(chip);
  scrollToBottom();
}

function onToolEnd(data) {
  const chip = toolChips.get(data.toolUseId);
  if (!chip) return;
  chip.classList.remove("start");
  chip.classList.add(data.isError ? "error" : "end");
  chip.textContent = chip.textContent.replace("▸", data.isError ? "✕" : "✓");
}

function onToolDenied(data) {
  const chip = document.createElement("div");
  chip.className = "chat-tool-chip denied";
  chip.title = data.reason;
  chip.textContent = `✕ ${data.name} (negado)`;
  el.messages.appendChild(chip);
  scrollToBottom();
}

// ─── AskUserQuestion como form (#3557), com hidratação (#3617) ────────────

// toolUseId -> card element, pro card do fluxo ao vivo (evento SSE) E o
// hidratado (GET /api/chat/pending) nunca duplicarem o mesmo gate — também
// alimenta `planHydrationCards` (chat-hydration.js) como o conjunto de ids
// já renderizados.
const permissionCards = new Map();

function formatWaited(askedAtMs) {
  const mins = Math.floor((Date.now() - askedAtMs) / 60000);
  return mins > 0 ? `esperando há ${mins}min` : "esperando…";
}

/** Renderiza `data.questions` (1-4 perguntas, 2-4 opções cada, single ou
 * multi-select + "Other" livre) como um card no fluxo de mensagens, e
 * resolve via `POST /api/chat/answer` quando o editor clica "Responder". Sem
 * timeout — o card fica ali indefinidamente até ser respondido (mesma
 * semântica bloqueante do terminal); só o texto "esperando há Xmin" muda
 * sozinho (client-side, a partir de `data.askedAt`). Usado tanto pelo evento
 * SSE `chat-permission-request` (fluxo ao vivo) quanto pela hidratação
 * (#3617, `hydratePendingPermissions` abaixo) — MESMO renderer, sem
 * duplicar a lógica de montagem do card; idempotente por `toolUseId` via
 * `permissionCards`. */
function onPermissionRequest(data) {
  if (permissionCards.has(data.toolUseId)) return; // já renderizado — evita duplicar em race hidratação/SSE.

  const card = document.createElement("div");
  card.className = "chat-permission-card";
  permissionCards.set(data.toolUseId, card);

  // 1 entrada de estado por pergunta: seleção (array de labels — só 1 item
  // quando não multiSelect) + texto livre digitado em "Other".
  const state = data.questions.map(() => ({ selected: [], freeform: "" }));

  const waitedEl = document.createElement("div");
  waitedEl.className = "chat-permission-waited";
  waitedEl.textContent = formatWaited(data.askedAt);
  card.appendChild(waitedEl);
  const waitedTimer = setInterval(() => {
    waitedEl.textContent = formatWaited(data.askedAt);
  }, 15_000);

  // #3561: campo(s) "Other" que pedem um secret (token/credencial/senha —
  // ver `isSensitiveQuestion`, cat. A do develop) NUNCA devem ecoar o valor
  // digitado em texto plano em nenhum lugar visível. `otherInputs` guarda a
  // referência de cada input pra (a) mascarar visualmente (type="password")
  // já na montagem do card, e (b) apagar o valor da tela assim que a
  // resposta é enviada — mesmo em caso de falha de rede, o valor não fica
  // sentado em texto plano num input desabilitado indefinidamente.
  const otherInputs = [];
  const sensitiveFlags = data.questions.map(isSensitiveQuestion);

  data.questions.forEach((q, qi) => {
    const qEl = document.createElement("div");
    qEl.className = "chat-permission-question";

    const header = document.createElement("span");
    header.className = "chat-permission-header-chip";
    header.textContent = q.header;
    qEl.appendChild(header);

    const questionText = document.createElement("div");
    questionText.className = "chat-permission-question-text";
    questionText.textContent = q.question;
    qEl.appendChild(questionText);

    const optsWrap = document.createElement("div");
    optsWrap.className = "chat-permission-options";
    for (const opt of q.options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chat-permission-option";
      btn.textContent = opt.label;
      if (opt.description) btn.title = opt.description;
      btn.addEventListener("click", () => {
        if (q.multiSelect) {
          const idx = state[qi].selected.indexOf(opt.label);
          if (idx === -1) state[qi].selected.push(opt.label);
          else state[qi].selected.splice(idx, 1);
        } else {
          state[qi].selected = [opt.label];
        }
        for (const b of optsWrap.querySelectorAll(".chat-permission-option")) {
          b.classList.toggle("selected", state[qi].selected.includes(b.textContent));
        }
      });
      optsWrap.appendChild(btn);
    }
    qEl.appendChild(optsWrap);

    const otherInput = document.createElement("input");
    // #3561: type="password" pra qualquer pergunta que parece pedir um
    // secret (token/credencial/senha) — mascara o valor na tela enquanto o
    // editor digita, igual a qualquer campo de senha de browser.
    otherInput.type = sensitiveFlags[qi] ? "password" : "text";
    otherInput.autocomplete = "off";
    otherInput.className = "chat-permission-other" + (sensitiveFlags[qi] ? " chat-permission-other-sensitive" : "");
    otherInput.placeholder = sensitiveFlags[qi] ? "cole o valor (nunca fica visível)" : "Other (resposta livre)";
    otherInput.addEventListener("input", () => {
      state[qi].freeform = otherInput.value;
    });
    qEl.appendChild(otherInput);
    otherInputs[qi] = otherInput;

    card.appendChild(qEl);
  });

  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "chat-permission-submit";
  submit.textContent = "Responder";
  submit.addEventListener("click", async () => {
    submit.disabled = true;
    const answers = {};
    let response;
    data.questions.forEach((q, qi) => {
      const st = state[qi];
      if (st.freeform.trim()) {
        answers[q.question] = st.freeform.trim();
        if (data.questions.length === 1) response = st.freeform.trim();
      } else {
        answers[q.question] = st.selected.join(", ");
      }
    });
    // #3561: apaga o valor da TELA de qualquer campo sensível assim que a
    // resposta foi capturada em `answers` — antes do round-trip de rede, não
    // depois (uma falha no fetch abaixo não deve deixar o secret visível
    // esperando retry). O texto digitado nunca é logado nem persistido em
    // plan.json em texto plano (ver studio-round-queue.ts/SKILL.md) — isto
    // cobre o lado do DOM (a única superfície onde ele ficaria visível).
    data.questions.forEach((_q, qi) => {
      if (sensitiveFlags[qi] && otherInputs[qi]) {
        state[qi].freeform = "";
        otherInputs[qi].value = "";
        otherInputs[qi].placeholder = "•••••••• (enviado)";
      }
    });
    try {
      const res = await fetch("/api/chat/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolUseId: data.toolUseId, answers, response }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      clearInterval(waitedTimer);
      card.classList.add("resolved");
      for (const elx of card.querySelectorAll("button, input")) elx.disabled = true;
    } catch (e) {
      submit.disabled = false;
      appendErrorNote(`falha ao enviar resposta: ${e.message}`);
    }
  });
  card.appendChild(submit);

  el.messages.appendChild(card);
  scrollToBottom();
  // #3617: um gate pendente NUNCA fica escondido atrás de um clique que
  // pode falhar — expande o painel automaticamente (colapsado só esconde
  // LARGURA/texto, nunca o acesso à pergunta, mas expandir de cara garante
  // que o card apareça sem exigir nenhuma ação do editor).
  expandDrawer();
}

// ─── gate de TOOL (Bash/etc.) como card aprovar/negar (#3804) ─────────────

/** Resumo legível do input de uma tool pro card de aprovação — o que o editor
 * precisa ver pra decidir. Casos comuns primeiro (o comando de um Bash, o
 * arquivo de um Edit/Write/Read), fallback genérico é o JSON compacto
 * truncado. Pura, defensiva (input pode vir com qualquer shape). */
function toolInputSummary(toolName, input) {
  if (!input || typeof input !== "object") return "";
  if (typeof input.command === "string") return input.command; // Bash
  if (typeof input.file_path === "string") return input.file_path; // Edit/Write/Read/NotebookEdit
  if (typeof input.path === "string") return input.path;
  if (typeof input.pattern === "string") return input.pattern; // Grep/Glob
  if (typeof input.url === "string") return input.url; // WebFetch
  try {
    const json = JSON.stringify(input);
    return json.length > 400 ? json.slice(0, 400) + "…" : json;
  } catch {
    return "";
  }
}

/** Renderiza um gate de tool não-`AskUserQuestion` (#3804) como card com o
 * nome da tool + preview do input + três botões: "Aprovar" (rodar uma vez),
 * "Sempre nesta sessão" (rodar + não perguntar de novo por esta tool) e
 * "Negar". Resolve via `POST /api/chat/tool-decision`. Mesmo `permissionCards`
 * do gate de pergunta (dedup live/hidratação por `toolUseId`), mesmo relógio
 * "esperando há Xmin", mesma expansão automática do drawer. */
function onToolPermissionRequest(data) {
  if (permissionCards.has(data.toolUseId)) return; // já renderizado — evita duplicar em race hidratação/SSE.

  const card = document.createElement("div");
  card.className = "chat-permission-card chat-tool-permission-card";
  permissionCards.set(data.toolUseId, card);

  const waitedEl = document.createElement("div");
  waitedEl.className = "chat-permission-waited";
  waitedEl.textContent = formatWaited(data.askedAt);
  card.appendChild(waitedEl);
  const waitedTimer = setInterval(() => {
    waitedEl.textContent = formatWaited(data.askedAt);
  }, 15_000);

  const header = document.createElement("span");
  header.className = "chat-permission-header-chip";
  header.textContent = `▸ ${data.toolName}`;
  card.appendChild(header);

  const summary = toolInputSummary(data.toolName, data.input);
  if (summary) {
    const pre = document.createElement("pre");
    pre.className = "chat-tool-permission-input";
    pre.textContent = summary;
    card.appendChild(pre);
  }

  const btnRow = document.createElement("div");
  btnRow.className = "chat-tool-permission-actions";

  // 3 decisões, mesma semântica do prompt de 3 vias do terminal. `label` só
  // pra UI; `decision` é o que viaja pro servidor.
  const decisions = [
    { decision: "allow", label: "Aprovar", cls: "allow" },
    { decision: "always", label: "Sempre nesta sessão", cls: "always" },
    { decision: "deny", label: "Negar", cls: "deny" },
  ];

  async function decide(decision) {
    for (const b of btnRow.querySelectorAll("button")) b.disabled = true;
    try {
      const res = await fetch("/api/chat/tool-decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolUseId: data.toolUseId, decision }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
      clearInterval(waitedTimer);
      card.classList.add("resolved");
      card.classList.add(`decision-${decision}`);
    } catch (e) {
      for (const b of btnRow.querySelectorAll("button")) b.disabled = false;
      appendErrorNote(`falha ao enviar decisão: ${e.message}`);
    }
  }

  for (const d of decisions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `chat-tool-permission-btn ${d.cls}`;
    btn.textContent = d.label;
    btn.addEventListener("click", () => decide(d.decision));
    btnRow.appendChild(btn);
  }
  card.appendChild(btnRow);

  el.messages.appendChild(card);
  scrollToBottom();
  // #3617: mesma razão do gate de pergunta — um gate pendente nunca fica
  // escondido atrás de um drawer colapsado.
  expandDrawer();
}

// #3617: hidratação — busca os gates pendentes REAIS da sessão do servidor
// (não só o contador global de `/api/events`) e reidrata o(s) card(s)
// completo(s) com o MESMO `onPermissionRequest` do fluxo ao vivo. Roda uma
// vez ao montar o script em QUALQUER página — é isto que resolve o bug
// #3617 por construção: fechar/recarregar/navegar não perde mais o acesso
// ao gate, porque a hidratação sempre reconstrói o card a partir do estado
// do servidor, independente de estar "no meio" do stream SSE que o
// originou.
async function hydratePendingPermissions() {
  try {
    const res = await fetch("/api/chat/pending");
    if (!res.ok) return;
    const json = await res.json();
    const pending = parsePendingChatResponse(json);
    const toRender = planHydrationCards(pending, permissionCards.keys());
    for (const p of toRender) {
      if (p.kind === "tool") onToolPermissionRequest(p);
      else onPermissionRequest(p);
    }
  } catch {
    // best-effort — studio-server offline/erro de rede no momento da
    // hidratação; o badge global (via /api/events) ainda vai sinalizar o
    // gate pendente assim que a conexão SSE abrir, e a próxima navegação
    // tenta hidratar de novo.
  }
}

// ─── histórico de transcript (#3803) ───────────────────────────────────────

// Maior `seq` já reproduzido nesta página — module-scoped (não localStorage:
// é estado de MONTAGEM desta página, mesmo princípio de `panelContext`
// acima). `planHistoryReplay` (chat-hydration.js) usa isto pra nunca
// re-renderizar a mesma entry 2x, mesmo se `hydrateChatHistory` rodar mais
// de uma vez na vida desta página (não acontece hoje — só chamada 1x no
// mount, mas o guard é de graça e deixa a função seguramente reentrante).
let lastHistorySeq = 0;

/** Reproduz UMA entry de histórico (`ChatHistoryEntry`, ver studio-chat.ts)
 * usando o MESMO renderer que o fluxo ao vivo já usa pro tipo equivalente —
 * nenhuma lógica de render duplicada. Entry de tipo desconhecido é ignorada
 * (fail-soft, mesma disciplina do resto do drawer). */
function replayHistoryEntry(entry) {
  if (entry.kind === "user") {
    appendUserMessage(entry.text);
  } else if (entry.kind === "assistant") {
    // Reproduz o texto FINAL de uma vez (sem re-simular o streaming
    // token-a-token) — `currentAssistantBody()` cria uma bolha nova (nenhuma
    // `.current` existe ainda neste ponto do replay) e `finalizeAssistantMessage()`
    // a fecha imediatamente, igual ao fluxo ao vivo no fim de um turno.
    currentAssistantBody().textContent = entry.text;
    finalizeAssistantMessage();
  } else if (entry.kind === "tool") {
    if (entry.status === "start") onToolStart({ toolUseId: entry.toolUseId, name: entry.name, input: entry.input });
    else if (entry.status === "end") onToolEnd({ toolUseId: entry.toolUseId, isError: entry.isError === true });
    else if (entry.status === "denied") {
      onToolDenied({ toolUseId: entry.toolUseId, name: entry.name, reason: entry.reason ?? "" });
    }
  } else if (entry.kind === "error") {
    appendErrorNote(entry.text);
  }
}

/** Busca `GET /api/chat/history` e reproduz o transcript de turnos
 * ANTERIORES ao montar o drawer em qualquer página — fecha o gap #3803
 * (navegar entre páginas do Studio esvaziava a tela do chat mesmo com a
 * sessão do Agent SDK viva no servidor, TODO órfão desde #3561/#3562). Roda
 * ANTES de `hydratePendingPermissions()` (chamada abaixo) pra manter a ordem
 * cronológica certa: transcript passado primeiro, gate pendente (a
 * interação mais recente/em aberto) por último. */
async function hydrateChatHistory() {
  try {
    const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
    const res = await fetch(`/api/chat/history${qs}`);
    if (!res.ok) return;
    const json = await res.json();
    const history = parseChatHistoryResponse(json);
    const { toRender, nextSeq } = planHistoryReplay(history, lastHistorySeq);
    for (const entry of toRender) replayHistoryEntry(entry);
    lastHistorySeq = nextSeq;
  } catch {
    // best-effort — mesma disciplina de `hydratePendingPermissions`: sem
    // transcript nesta hidratação, o chat segue funcional pra mensagens
    // novas, só sem o histórico visual desta sessão.
  }
}

(async () => {
  await hydrateChatHistory();
  await hydratePendingPermissions();
})();

// ─── parsing SSE manual (fetch não dá EventSource pra POST) ────────────

/** Faz o parsing incremental de um stream SSE lido via `fetch` (sem
 * `EventSource`, que não suporta POST). Buffer acumula bytes decodificados
 * até achar uma linha em branco dupla (fim de um evento); pura o bastante
 * pra ser exercida sem rede real, mas não é exportada/testada isoladamente
 * nesta fatia — a lógica de streaming real fica coberta pelo contrato de
 * eventos testado server-side (`sdkMessageToChatEvents`). */
async function streamChat(body, handlers) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    let message = `chat indisponível (HTTP ${res.status})`;
    try {
      const errJson = await res.json();
      if (errJson && errJson.error) message = errJson.error;
    } catch {
      // corpo não era JSON — mantém a mensagem genérica acima.
    }
    handlers.onError(message);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIndex;
    while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      if (!rawEvent || rawEvent.startsWith(":")) continue; // comentário/heartbeat

      let eventName = "message";
      let dataLine = "";
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
        else if (line.startsWith("data:")) dataLine += line.slice("data:".length).trim();
      }
      if (!dataLine) continue;
      let data;
      try {
        data = JSON.parse(dataLine);
      } catch {
        continue; // linha malformada — ignora em vez de quebrar o parsing inteiro
      }
      handlers.onEvent(eventName, data);
    }
  }
}

// ─── envio ──────────────────────────────────────────────────────────────

let sending = false;

async function sendMessage(text) {
  if (sending || !text.trim()) return;
  sending = true;
  el.send.disabled = true;
  setToggleStatus("ok");

  appendUserMessage(text);

  // Consome o pedido de reset da última clicada em "nova conversa" (ver
  // listener acima) — precisa viajar explicitamente pro server porque
  // `sessionId` já está `null` aqui, o que sozinho NÃO limpa o estado em
  // memória do server (`handleApiChat` cairia em `getSessionId(rootDir)`).
  const reset = pendingReset;
  pendingReset = false;

  let sawDelta = false;
  await streamChat(
    { message: text, sessionId: sessionId ?? undefined, reset, context: panelContext ?? undefined },
    {
      onEvent(eventName, data) {
        if (eventName === "chat-init") {
          if (data.sessionId) persistSessionId(data.sessionId);
        } else if (eventName === "chat-delta") {
          sawDelta = true;
          currentAssistantBody().textContent += data.text;
          scrollToBottom();
        } else if (eventName === "chat-tool") {
          if (data.status === "start") onToolStart(data);
          else if (data.status === "end") onToolEnd(data);
          else if (data.status === "denied") onToolDenied(data);
        } else if (eventName === "chat-permission-request") {
          onPermissionRequest(data);
        } else if (eventName === "chat-tool-permission-request") {
          onToolPermissionRequest(data);
        } else if (eventName === "chat-done") {
          if (data.sessionId) persistSessionId(data.sessionId);
          finalizeAssistantMessage();
          if (!sawDelta && data.result) {
            // Sessão sem partial-message streaming habilitado no CLI
            // conectado (versões antigas) — ainda mostra a resposta final.
            currentAssistantBody().textContent = data.result;
            finalizeAssistantMessage();
          }
          if (data.isError) {
            appendErrorNote("a sessão terminou com erro — ver detalhes no terminal/run-log.");
            setToggleStatus("down");
          } else {
            setToggleStatus("ok");
          }
        } else if (eventName === "chat-error") {
          // runChatTurn (studio-chat.ts) é fail-soft por design: qualquer
          // exceção vira este evento em vez de propagar/derrubar a conexão.
          // Sem este handler, o evento chegava e era silenciosamente
          // ignorado (nenhum case do switch batia) — a tela ficava muda
          // ("não responde") até o stream fechar sozinho, sem explicação.
          // Reusa onError (mesmo objeto handlers) em vez de duplicar as 3
          // chamadas — this é o próprio objeto handlers aqui, já que este
          // método é invocado como handlers.onEvent(...).
          this.onError(data.message || "a sessão terminou com erro — ver detalhes no terminal/run-log.");
        }
      },
      onError(message) {
        finalizeAssistantMessage();
        appendErrorNote(message);
        setToggleStatus("down");
      },
    },
  );

  sending = false;
  el.send.disabled = false;
}

// #3556 self-review: só limpar o textarea quando a mensagem VAI ser
// realmente enviada — o guard aqui espelha o topo de `sendMessage`
// (`sending || !text.trim()`) de propósito: antes desta correção, o input
// era limpo incondicionalmente e um Enter/clique disparado enquanto
// `sending` já era `true` (turno anterior ainda em voo) descartava o texto
// digitado em silêncio, sem forma de restaurá-lo depois do early-return.
el.send.addEventListener("click", () => {
  const text = el.input.value;
  if (sending || !text.trim()) return;
  el.input.value = "";
  sendMessage(text);
});
el.input.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    el.send.click();
  }
});

// #3629: pré-preenche o textarea de input com `text` e EXPANDE o painel,
// SEM enviar — reusa o mesmo textarea/`expandDrawer()` que `sendMessage` já
// usa (nenhuma lógica de expandir duplicada). O editor revisa/edita o texto
// pré-preenchido e manda manualmente clicando "Enviar" (ou Enter), igual
// digitação normal — nenhum envio automático. Ponto de extensão previsto
// desde #3556 ("ações-por-botão 'injetar prompt'"), usado pelos ganchos
// "Reescrever título"/"Regenerar imagem" de `revisao.js`.
function prefillMessage(text) {
  el.input.value = text;
  expandDrawer();
  el.input.focus();
}

// Ponto de extensão pras fatias seguintes (#3561 briefings) — um botão de
// outra tela chama isto pra rodar uma mensagem nesta MESMA sessão sem
// duplicar a mecânica de streaming/parsing acima. `scrollToPendingCard`
// (#3870) é o ponto de extensão do cockpit (`edicao.js`) pro botão
// "Responder no chat" dos cards de Gate 4/6.
window.diariaStudioChat = { sendMessage, openDrawer: expandDrawer, prefillMessage, setContext, scrollToPendingCard };
