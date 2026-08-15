/**
 * studio-push-notify.ts (#3564, fatia 10 do epic "Studio UI" #3554; canal
 * e-mail #5341 — renomeado do módulo do canal anterior)
 *
 * Fecha o loop mobile: quando algo espera o editor — gate 4/6 pendente
 * (`studio-state.ts` `gatesPending`) ou `AskUserQuestion` pendente no chat
 * drawer (`studio-chat.ts` `chatPermissionsPending`) — dispara uma
 * notificação push por e-mail com deep-link pra tela certa do Studio, via o
 * client genérico de `scripts/lib/push-notify.ts` (fail-soft TOTAL:
 * qualquer falha de auth/rede, o Studio segue funcionando normalmente —
 * isso é só observabilidade extra). #5341 (15/08/2026, decisão do editor):
 * canal padronizado em Gmail (`sendGmailMessage`) — o editor decidiu não
 * exigir a instalação de um app de mensagens novo; o canal anterior era um
 * no-op silencioso sem credenciais configuradas.
 *
 * Deep-link (#3560 nota): o Studio ainda roda só local
 * (`http://127.0.0.1:4174`) — não existe deploy público (`studio.diar.ia.br`
 * NÃO existe ainda). `STUDIO_PUBLIC_BASE_URL` é configurável via env pra não
 * hardcodar esse domínio inexistente; o default aponta pro loopback local,
 * que só abre a partir da MESMA máquina/rede até o #3560 (acesso remoto)
 * existir — documentado em `resolveStudioPublicBaseUrl`. Este env var
 * SOBREVIVE à mudança de canal (#5341) — passou a servir o deep-link do
 * e-mail.
 *
 * Desenho (mesmo padrão de `run-log-tail.ts`/`plan-watch.ts`): um polling
 * de baixa frequência sobre `buildStudioState` (a mesma função que já
 * alimenta `GET /api/state`) — NÃO depende de nenhum cliente SSE conectado,
 * porque o cenário-alvo é justamente o editor longe do computador (nenhuma
 * aba do Studio aberta). `runPushNotifyTick` faz UMA rodada de diff+notify e
 * é pura o bastante (I/O só via `buildStateFn`/`notifyFn` injetáveis) pra
 * testar sem `setInterval` real; `startPushNotifyWatcher` só embrulha isso
 * num `setInterval`.
 *
 * Dedup: `NotifiedStore` em memória (1 por watcher — o processo do
 * studio-server já é de longa duração, não precisa persistir em disco). Uma
 * chave só é removida do store quando o evento de origem deixa de estar
 * pendente (gate respondido/aprovado) — se o MESMO gate reaparecer depois
 * (nova edição atingindo o stage 4, por ex.), notifica de novo. Uma chave só
 * é ADICIONADA ao store quando `notifyFn` retorna `ok:true` — um envio
 * falho (rede/HTTP/auth) NÃO marca dedup, então o gate ainda pendente é
 * retentado no próximo tick em vez de ficar silenciosamente "esquecido" até
 * resolver/reaparecer.
 *
 * Halt banner (#737/#738): NÃO tratado por este watcher — halt é emitido
 * por `render-halt-banner.ts`, um script CLI efêmero (1 processo por
 * chamada), não algo observável por polling de estado contínuo. A
 * formatação (`formatHaltNotifyMessage`) e o dedup entre invocações vivem em
 * `scripts/lib/push-notify.ts` + a própria `render-halt-banner.ts` — ver
 * os dois pro mecanismo completo.
 *
 * CI vermelho persistente (aceite #4 da issue): não há hoje um sinal
 * agregado e claro disso no Studio (a fatia mais próxima, `studio-issues.ts`/
 * `/api/issues`, expõe status de CI por PR, mas "persistente" exigiria
 * tracking de janela de tempo que não existe ainda) — tratado como TODO
 * anotado aqui, não implementado nesta fatia (a própria issue trata isso
 * como o critério menos crítico).
 * TODO(#3564-ci-watch): quando `studio-issues.ts` ganhar histórico de CI por
 * PR, adicionar um 3º ramo de polling aqui (draft criado por subagente +
 * CI vermelho há mais de N minutos) reusando o mesmo `notifyOnceKey`+dedup.
 *
 * ── Notificação de turno de chat concluído (#3822) ─────────────────────────
 *
 * Diferente dos dois casos acima ("está esperando você" — gate 4/6 ou
 * `AskUserQuestion` pendente), este é o caso "acabei de terminar, e não
 * preciso de nada de você agora": o editor manda uma tarefa pelo chat
 * drawer, sai da tela, e quer saber quando terminou sem ficar checando o
 * painel. NÃO é coberto por `runPushNotifyTick`/`buildStudioState` (polling)
 * porque o turno pode terminar entre ticks e a mensagem perderia o timing de
 * ser útil — em vez disso, `maybeNotifyChatDone` é chamada DIRETO pelo
 * handler HTTP de `POST /api/chat` (`server.ts`, `handleApiChat`) no exato
 * momento em que o evento `ChatDoneEvent` (`studio-chat.ts`) é emitido, no
 * mesmo `onEvent` callback que já traduz eventos pro SSE do browser — sem
 * loop de polling próprio.
 *
 * Threshold de duração (`CHAT_DONE_NOTIFY_THRESHOLD_MS`, default 30s):
 * decisão conservadora tomada na implementação (#3822 deixou em aberto entre
 * threshold-por-duração e flag explícito de opt-in) — um threshold evita
 * notificar em toda troca curta ("ok", "obrigado") sem exigir que o editor
 * lembre de ligar/desligar um flag toda vez que for sair da tela. Ajustável
 * via `STUDIO_CHAT_DONE_NOTIFY_THRESHOLD_MS` (ms) sem precisar editar código,
 * caso o editor ache 30s muito/pouco sensível na prática.
 *
 * Dedup: propositalmente NÃO tem (#3822 "fora de escopo" — múltiplas tarefas
 * encadeadas rápidas no mesmo turno cada uma notifica separadamente se cada
 * uma sozinha já passar do threshold). O próprio threshold já mitiga o caso
 * degenerado de spam (trocas curtas ficam abaixo dele e nunca notificam) —
 * revisar só se aparecer como problema real de verdade.
 */

import {
  sendPushNotification,
  createInMemoryNotifiedStore,
  type NotifiedStore,
  type PushMessage,
  type SendPushNotificationOptions,
  type PushNotifyResult,
} from "../lib/push-notify.ts";
import { buildStudioState, type StudioState } from "./studio-state.ts";
import type { ChatDoneEvent } from "./studio-chat.ts";

// Re-exportado por conveniência — `formatHaltNotifyMessage` mora em
// `scripts/lib/push-notify.ts` (não é Studio-específico, ver doc-comment
// lá), mas quem já importa deste módulo pra outras mensagens do Studio pode
// querer as 3 juntas sem um 2º import.
export { formatHaltNotifyMessage } from "../lib/push-notify.ts";

const DEFAULT_STUDIO_PUBLIC_BASE_URL = "http://127.0.0.1:4174";

/**
 * Base URL pública do Studio pra montar deep-links. Configurável via
 * `STUDIO_PUBLIC_BASE_URL` (#3564, sobrevive à mudança de canal em
 * #5341) — o default é o loopback local (`http://127.0.0.1:4174`, mesma
 * porta default de `server.ts`), que só é alcançável a partir da MESMA
 * máquina/rede até o acesso remoto (#3560) existir. Nunca hardcodar
 * `studio.diar.ia.br` — esse domínio não existe.
 */
export function resolveStudioPublicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.STUDIO_PUBLIC_BASE_URL || DEFAULT_STUDIO_PUBLIC_BASE_URL;
  return raw.replace(/\/+$/, "");
}

// ─── formatação de mensagens (pura) ────────────────────────────────────────

const STAGE_GATE_LABEL: Record<4 | 6, string> = {
  4: "revisão editorial (Etapa 4)",
  6: "agendamento final (Etapa 6)",
};

/** Mensagem + deep-link pro cockpit da edição (`/edicao/:aammdd`, já servido
 * por `server.ts`) — mesma tela onde o editor vê o stage corrente e os gates
 * pendentes daquela edição. */
export function formatEditionGateMessage(
  edition: string,
  stage: 4 | 6,
  baseUrl: string,
): PushMessage {
  const url = `${baseUrl}/edicao/${edition}`;
  return {
    subject: `[diar.ia.br Studio] Gate pendente — edição ${edition}`,
    body: [
      `Edição ${edition} aguardando aprovação — ${STAGE_GATE_LABEL[stage]}.`,
      url,
    ].join("\n"),
  };
}

/** Mensagem + deep-link pro chat drawer (o badge global de
 * `chatPermissionsPending` aparece em qualquer página do Studio — não há
 * ainda uma tela dedicada por gate, só o drawer embutido no shell, então o
 * deep-link é a home). `question` é o preview (`firstQuestion` de
 * `PendingPermissionSummary`) — omitido se indisponível. */
export function formatChatGateMessage(
  question: string | null,
  baseUrl: string,
): PushMessage {
  const url = `${baseUrl}/`;
  const preview = question ? `\n"${question}"` : "";
  return {
    subject: "[diar.ia.br Studio] Pergunta pendente no chat",
    body: [`A sessão está esperando uma resposta do editor.${preview}`, url].join("\n"),
  };
}

// ─── diff puro: quais chaves notificar / esquecer nesta rodada ────────────

export interface GateNotificationPlan {
  toNotify: string[];
  toClear: string[];
}

/** Pura: dado o conjunto de chaves ATUALMENTE pendentes e o conjunto já
 * notificado (dedup store), decide o que notificar agora (chaves novas) e o
 * que esquecer (chaves que deixaram de estar pendentes — permite renotificar
 * se o mesmo gate voltar a aparecer depois). */
export function computeGateNotifications(
  currentKeys: string[],
  notifiedKeys: string[],
): GateNotificationPlan {
  const current = new Set(currentKeys);
  const notified = new Set(notifiedKeys);
  return {
    toNotify: currentKeys.filter((k) => !notified.has(k)),
    toClear: notifiedKeys.filter((k) => !current.has(k)),
  };
}

// ─── chaves de dedup (pura) ─────────────────────────────────────────────

function editionGateKey(edition: string, stage: number): string {
  return `edition-gate:${edition}:${stage}`;
}

function chatGateKey(toolUseId: string): string {
  return `chat-gate:${toolUseId}`;
}

// ─── tick de polling (I/O injetável, testável sem setInterval real) ───────

export interface PushNotifyTickOptions {
  /** Constrói o snapshot de estado — default `buildStudioState`, injetável
   * em testes pra não depender de `data/` real no disco. */
  buildStateFn?: (rootDir: string) => StudioState;
  /** Envia a notificação — default `sendPushNotification`, injetável em
   * testes pra não bater na rede/Gmail real. O `result.ok` do retorno é o
   * que decide se a chave entra no dedup store (ver `runPushNotifyTick`
   * abaixo) — um mock de teste que só quer registrar a mensagem enviada
   * ainda precisa retornar `{ok:true}` pra exercitar o caminho de dedup. */
  notifyFn?: (msg: PushMessage, opts?: SendPushNotificationOptions) => Promise<PushNotifyResult>;
  baseUrl?: string;
}

/**
 * Roda UMA rodada de diff+notify sobre o `rootDir` dado, usando `store` como
 * registro de dedup (mutado in-place — mesmo padrão de `Map`/`Set` já usado
 * por `studio-chat.ts`). Retorna as chaves notificadas nesta rodada (só pra
 * inspeção/teste — o caller normalmente ignora o retorno).
 */
export async function runPushNotifyTick(
  rootDir: string,
  store: NotifiedStore,
  opts: PushNotifyTickOptions = {},
): Promise<string[]> {
  const buildStateFn = opts.buildStateFn ?? buildStudioState;
  const notifyFn = opts.notifyFn ?? sendPushNotification;
  const baseUrl = opts.baseUrl ?? resolveStudioPublicBaseUrl();

  const state = buildStateFn(rootDir);

  const editionKeys = state.gatesPending.map((g) => editionGateKey(g.edition, g.stage));
  const chatKeys = state.chatPermissionsPending.map((p) => chatGateKey(p.toolUseId));
  const currentKeys = [...editionKeys, ...chatKeys];

  const plan = computeGateNotifications(currentKeys, store.keys());

  for (const key of plan.toClear) store.delete(key);

  // #3564 self-review: só marca `key` como notificada no dedup store quando
  // `notifyFn` de fato reporta `ok:true`. Sem essa checagem, um envio falho
  // (rede/HTTP/auth) ainda entrava no store — o gate ficava "notificado"
  // mesmo sem NENHUMA mensagem ter saído, e só seria retentado se resolvido
  // e reaberto depois. Com a checagem, um gate ainda pendente é retentado a
  // cada tick até um envio realmente bem sucedido (mesma semântica de
  // `notifyHaltViaPush` em render-halt-banner.ts, que também só persiste
  // dedup em `result.ok`).
  const notified: string[] = [];
  for (const key of plan.toNotify) {
    const editionGate = state.gatesPending.find(
      (g) => editionGateKey(g.edition, g.stage) === key,
    );
    if (editionGate) {
      const result = await notifyFn(
        formatEditionGateMessage(editionGate.edition, editionGate.stage as 4 | 6, baseUrl),
      );
      if (result.ok) {
        store.add(key);
        notified.push(key);
      }
      continue;
    }
    const chatGate = state.chatPermissionsPending.find((p) => chatGateKey(p.toolUseId) === key);
    if (chatGate) {
      const result = await notifyFn(formatChatGateMessage(chatGate.firstQuestion, baseUrl));
      if (result.ok) {
        store.add(key);
        notified.push(key);
      }
    }
  }

  return notified;
}

export interface PushNotifyWatchHandle {
  close: () => void;
}

/**
 * Sobe o polling contínuo — chamado uma vez por `startStudioServer`
 * (`server.ts`). `pollIntervalMs` default 15s: bem dentro do requisito de
 * aceite "<30s" da issue original (#3564), com margem pro próprio tempo de
 * request HTTP do envio.
 */
export function startPushNotifyWatcher(
  rootDir: string,
  opts: PushNotifyTickOptions & { pollIntervalMs?: number; store?: NotifiedStore } = {},
): PushNotifyWatchHandle {
  const store = opts.store ?? createInMemoryNotifiedStore();
  const interval = setInterval(() => {
    runPushNotifyTick(rootDir, store, opts).catch((e) => {
      // Fail-soft TOTAL (CLAUDE.md): erro aqui nunca deve derrubar o
      // studio-server — só logar e seguir pro próximo tick.
      console.warn(`[studio-push-notify] tick falhou: ${(e as Error).message}`);
    });
  }, opts.pollIntervalMs ?? 15_000);

  return { close: () => clearInterval(interval) };
}

// ─── notificação de turno de chat concluído (#3822) ────────────────────────

/** Default do threshold de duração — só notifica turnos que levaram pelo
 * menos isso (ver doc-comment do módulo pra motivação da escolha de 30s). */
export const CHAT_DONE_NOTIFY_THRESHOLD_MS = 30_000;

/** Resolve o threshold via `STUDIO_CHAT_DONE_NOTIFY_THRESHOLD_MS` (ms) —
 * fallback pro default acima se ausente, vazio ou não-numérico/negativo
 * (nunca lança; um valor malformado no env não deve derrubar o Studio). */
export function resolveChatDoneNotifyThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.STUDIO_CHAT_DONE_NOTIFY_THRESHOLD_MS;
  if (!raw) return CHAT_DONE_NOTIFY_THRESHOLD_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : CHAT_DONE_NOTIFY_THRESHOLD_MS;
}

/** Tamanho máximo do resumo (1ª linha da resposta final) antes de truncar
 * com reticências — corpo de e-mail cabe bem mais que isso, o teto é só pra
 * manter a notificação como um PREVIEW, não a resposta inteira. */
export const CHAT_DONE_SUMMARY_MAX_CHARS = 200;

/** Extrai a 1ª linha não-vazia de `resultText` e trunca a
 * `CHAT_DONE_SUMMARY_MAX_CHARS`. Pura. Retorna a mensagem genérica quando
 * não há texto final (turno terminou só com tool calls, ou é um evento de
 * erro sem `result` — `sdkMessageToChatEvents` só popula `result` no
 * caminho de sucesso). Ao contrário da versão do canal anterior, não
 * precisa mais sanitizar caracteres de Markdown — o corpo do e-mail é texto
 * puro (ver `buildMimeMessage`, `scripts/lib/gmail-send.ts`). */
export function summarizeChatResult(resultText: string | null): string {
  const GENERIC = "Tarefa concluída no chat drawer.";
  if (!resultText) return GENERIC;
  const firstLine = resultText.split("\n").find((line) => line.trim().length > 0);
  if (!firstLine) return GENERIC;
  const trimmed = firstLine.trim();
  if (!trimmed) return GENERIC;
  if (trimmed.length <= CHAT_DONE_SUMMARY_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, CHAT_DONE_SUMMARY_MAX_CHARS - 1)}…`;
}

/** Mensagem + deep-link pra home (mesmo destino de `formatChatGateMessage` —
 * o chat drawer é injetado em toda página, não há tela dedicada por turno).
 * Assunto distingue turno concluído com erro (`isError`) do caminho feliz —
 * `summarizeChatResult` já cai no genérico nesse caso porque `result` vem
 * `null` em erro (`sdkMessageToChatEvents`), então o assunto é o único sinal
 * de que algo deu errado. */
export function formatChatDoneMessage(event: ChatDoneEvent, baseUrl: string): PushMessage {
  const url = `${baseUrl}/`;
  const subject = event.data.isError
    ? "[diar.ia.br Studio] Turno do chat terminou com erro"
    : "[diar.ia.br Studio] Tarefa concluída";
  const summary = summarizeChatResult(event.data.result);
  return { subject, body: [summary, url].join("\n") };
}

export interface ChatDoneNotifyOptions {
  /** Envia a notificação — default `sendPushNotification`, injetável em
   * testes (mesmo padrão de `PushNotifyTickOptions.notifyFn`). */
  notifyFn?: (msg: PushMessage, opts?: SendPushNotificationOptions) => Promise<PushNotifyResult>;
  baseUrl?: string;
  /** Override do threshold — default `resolveChatDoneNotifyThresholdMs()`. */
  thresholdMs?: number;
}

/**
 * Decide se `event` (um `ChatDoneEvent` recém-emitido) merece notificação —
 * só quando `durationMs` (medido pelo caller, ver `handleApiChat` em
 * `server.ts`) atinge o threshold — e, se sim, envia via `notifyFn`.
 * Chamada DIRETO do `onEvent` de `handleApiChat`, sem polling (ver
 * doc-comment do módulo). Fail-soft: nunca lança (delega a
 * `sendPushNotification`, que também não lança); um turno curto simplesmente
 * retorna `{ok:false, skipped:true, reason:"below-threshold"}` sem tentar
 * rede nenhuma.
 */
export async function maybeNotifyChatDone(
  event: ChatDoneEvent,
  durationMs: number,
  opts: ChatDoneNotifyOptions = {},
): Promise<PushNotifyResult & { reason?: string }> {
  const thresholdMs = opts.thresholdMs ?? resolveChatDoneNotifyThresholdMs();
  if (durationMs < thresholdMs) {
    return { ok: false, skipped: true, reason: "below-threshold" };
  }
  const notifyFn = opts.notifyFn ?? sendPushNotification;
  const baseUrl = opts.baseUrl ?? resolveStudioPublicBaseUrl();
  return notifyFn(formatChatDoneMessage(event, baseUrl));
}
