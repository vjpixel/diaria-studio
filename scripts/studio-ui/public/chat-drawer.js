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
// "esperando há Xmin" client-side. Qualquer OUTRA tool call negada continua
// aparecendo como chip "negado" (`onToolDenied`, inalterado).
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
// TODO(#3561/#3562): histórico completo de mensagens de turnos anteriores
// (não só o gate pendente) não é reidratado nesta fatia — o SDK não expõe
// isso de forma trivial via `resume`; o card pendente (critério de aceite
// obrigatório do #3617) é reidratado, o histórico de texto cru fica pendente
// de investigação futura.

import { parsePendingChatResponse, planHydrationCards, isSensitiveQuestion } from "./chat-hydration.js";

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
    <button type="button" class="chat-expand-toggle" id="chat-expand-toggle" title="Expandir/recolher chat">
      <span class="chat-toggle-dot" id="chat-toggle-dot"></span>
      <span class="chat-drawer-title">Chat — sessão Claude</span>
      <span class="chat-toggle-badge" id="chat-toggle-badge" style="display:none"></span>
    </button>
    <button type="button" id="chat-reset" title="Nova conversa">nova conversa</button>
  </div>
  <div class="chat-messages" id="chat-messages"></div>
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
  messages: drawer.querySelector("#chat-messages"),
  input: drawer.querySelector("#chat-input"),
  send: drawer.querySelector("#chat-send"),
  reset: drawer.querySelector("#chat-reset"),
};

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
  persistCollapsed(collapsed);
}

function expandDrawer() {
  setCollapsed(false);
}

el.expandToggle.addEventListener("click", () => {
  setCollapsed(!drawer.classList.contains("collapsed"));
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
    for (const p of toRender) onPermissionRequest(p);
  } catch {
    // best-effort — studio-server offline/erro de rede no momento da
    // hidratação; o badge global (via /api/events) ainda vai sinalizar o
    // gate pendente assim que a conexão SSE abrir, e a próxima navegação
    // tenta hidratar de novo.
  }
}
hydratePendingPermissions();

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
// duplicar a mecânica de streaming/parsing acima.
window.diariaStudioChat = { sendMessage, openDrawer: expandDrawer, prefillMessage };
