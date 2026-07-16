// chat-drawer.js (#3556, fatia 2 do epic "Studio UI" #3554) — painel lateral
// com uma sessão Claude real (Agent SDK, server-side em studio-chat.ts).
// Vanilla JS, sem build step, sem lib nova (mesmo princípio de app.js/#3555).
//
// Injetado em toda página do studio (index/edicao/triagem) via
// `<script src="/chat-drawer.js" type="module"></script>` — constrói o
// próprio DOM (toggle + drawer) em vez de exigir markup duplicado em cada
// HTML, então uma única tag basta pra ligar o chat em qualquer página.
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
// "esperando há Xmin" client-side. Qualquer OUTRA tool call negada continua
// aparecendo como chip "negado" (`onToolDenied`, inalterado).
// Badge global (contador no `chat-toggle`): assina `/api/events` (SSE já
// existente de `/api/state`) só pelo campo `chatPermissionsPending` — assim
// o contador funciona mesmo em páginas sem o drawer aberto, e mesmo antes de
// qualquer mensagem ter sido enviada nesta aba.
// TODO(#3561/#3562): briefings e ações-por-botão (que "injetam prompt" nesta
// mesma sessão, com o texto visível/editável antes de enviar) são outras
// fatias — este módulo só expõe `window.diariaStudioChat.sendMessage(text)`
// como ponto de extensão simples pra esse uso futuro.

const STORAGE_KEY = "diaria-studio-chat-session-id";

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

// ─── DOM ────────────────────────────────────────────────────────────────

const toggle = document.createElement("button");
toggle.className = "chat-toggle";
toggle.type = "button";
toggle.innerHTML =
  '<span class="chat-toggle-dot" id="chat-toggle-dot"></span>Chat' +
  '<span class="chat-toggle-badge" id="chat-toggle-badge" style="display:none"></span>';

const drawer = document.createElement("aside");
drawer.className = "chat-drawer";
drawer.innerHTML = `
  <div class="chat-drawer-header">
    <h2>Chat — sessão Claude</h2>
    <button type="button" id="chat-reset" title="Nova conversa">nova conversa</button>
    <button type="button" id="chat-close" title="Fechar">&times;</button>
  </div>
  <div class="chat-messages" id="chat-messages"></div>
  <div class="chat-drawer-footer">
    <textarea id="chat-input" placeholder="Mensagem para a sessão Claude..." rows="2"></textarea>
    <button type="button" id="chat-send">Enviar</button>
  </div>
  <div class="chat-hint">
    Sessão real (Claude Agent SDK) rodando no studio-server local — mesmas
    skills/MCPs/CLAUDE.md do terminal. Perguntas da sessão (AskUserQuestion)
    aparecem como formulário abaixo, sem prazo pra responder; qualquer outra
    ação que pediria confirmação interativa aparece negada.
  </div>
`;

document.body.appendChild(toggle);
document.body.appendChild(drawer);

const el = {
  toggleDot: toggle.querySelector("#chat-toggle-dot"),
  toggleBadge: toggle.querySelector("#chat-toggle-badge"),
  messages: drawer.querySelector("#chat-messages"),
  input: drawer.querySelector("#chat-input"),
  send: drawer.querySelector("#chat-send"),
  reset: drawer.querySelector("#chat-reset"),
  close: drawer.querySelector("#chat-close"),
};

function setToggleStatus(status) {
  // "ok" | "down" | "" (idle) — mesmo vocabulário do dot de /api/events.
  el.toggleDot.className = "chat-toggle-dot " + status;
}

// #3557: badge global de gates pendentes (AskUserQuestion aguardando
// resposta), visível mesmo com o drawer fechado/em outra aba deste mesmo
// browser — fonte é `state.chatPermissionsPending` (studio-state.ts),
// atualizado por assinatura própria de `/api/events` (independente de
// app.js, que só existe em index.html — chat-drawer.js é injetado em várias
// páginas e precisa funcionar sozinho em todas).
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

function openDrawer() {
  drawer.classList.add("open");
}
function closeDrawer() {
  drawer.classList.remove("open");
}

toggle.addEventListener("click", () => {
  drawer.classList.contains("open") ? closeDrawer() : openDrawer();
});
el.close.addEventListener("click", closeDrawer);

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

// ─── AskUserQuestion como form (#3557) ─────────────────────────────────────

function formatWaited(askedAtMs) {
  const mins = Math.floor((Date.now() - askedAtMs) / 60000);
  return mins > 0 ? `esperando há ${mins}min` : "esperando…";
}

/** Renderiza `data.questions` (1-4 perguntas, 2-4 opções cada, single ou
 * multi-select + "Other" livre) como um card no fluxo de mensagens, e
 * resolve via `POST /api/chat/answer` quando o editor clica "Responder". Sem
 * timeout — o card fica ali indefinidamente até ser respondido (mesma
 * semântica bloqueante do terminal); só o texto "esperando há Xmin" muda
 * sozinho (client-side, a partir de `data.askedAt`). */
function onPermissionRequest(data) {
  const card = document.createElement("div");
  card.className = "chat-permission-card";

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
    otherInput.type = "text";
    otherInput.className = "chat-permission-other";
    otherInput.placeholder = "Other (resposta livre)";
    otherInput.addEventListener("input", () => {
      state[qi].freeform = otherInput.value;
    });
    qEl.appendChild(otherInput);

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
}

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
    { message: text, sessionId: sessionId ?? undefined, reset },
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

// Ponto de extensão pras fatias seguintes (#3557 gates-como-forms, #3561
// briefings, #3562 ações "injetar prompt") — um botão de outra tela chama
// isto pra rodar uma mensagem nesta MESMA sessão sem duplicar a mecânica de
// streaming/parsing acima.
window.diariaStudioChat = { sendMessage, openDrawer };
