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
// TODO(#3557): permission prompts hoje são negados automaticamente pelo
// server (ver `makeDenyAllCanUseTool` em studio-chat.ts) — este módulo só
// exibe o chip "negado" quando isso acontece. A troca por um card
// aprovar/negar entra quando o server emitir `chat-permission-request`.
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
toggle.innerHTML = '<span class="chat-toggle-dot" id="chat-toggle-dot"></span>Chat';

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
    skills/MCPs/CLAUDE.md do terminal. Permission prompts ainda não têm UI
    própria (ver #3557): ações que pediriam confirmação aparecem negadas.
  </div>
`;

document.body.appendChild(toggle);
document.body.appendChild(drawer);

const el = {
  toggleDot: toggle.querySelector("#chat-toggle-dot"),
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
el.reset.addEventListener("click", () => {
  sessionId = null;
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

  let sawDelta = false;
  await streamChat(
    { message: text, sessionId: sessionId ?? undefined },
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

el.send.addEventListener("click", () => {
  const text = el.input.value;
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
