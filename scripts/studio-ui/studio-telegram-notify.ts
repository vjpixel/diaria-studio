/**
 * studio-telegram-notify.ts (#3564, fatia 10 do epic "Studio UI" #3554)
 *
 * Fecha o loop mobile: quando algo espera o editor — gate 4/6 pendente
 * (`studio-state.ts` `gatesPending`) ou `AskUserQuestion` pendente no chat
 * drawer (`studio-chat.ts` `chatPermissionsPending`) — dispara uma
 * notificação Telegram com deep-link pra tela certa do Studio, via o client
 * genérico de `scripts/lib/telegram-notify.ts` (fail-soft TOTAL: sem
 * credenciais configuradas, ou qualquer falha de rede, o Studio segue
 * funcionando normalmente — isso é só observabilidade extra).
 *
 * Deep-link (#3560 nota): o Studio ainda roda só local
 * (`http://127.0.0.1:4174`) — não existe deploy público (`studio.diar.ia.br`
 * NÃO existe ainda). `STUDIO_PUBLIC_BASE_URL` é configurável via env pra não
 * hardcodar esse domínio inexistente; o default aponta pro loopback local,
 * que só abre a partir da MESMA máquina/rede até o #3560 (acesso remoto)
 * existir — documentado em `resolveStudioPublicBaseUrl`.
 *
 * Desenho (mesmo padrão de `run-log-tail.ts`/`plan-watch.ts`): um polling
 * de baixa frequência sobre `buildStudioState` (a mesma função que já
 * alimenta `GET /api/state`) — NÃO depende de nenhum cliente SSE conectado,
 * porque o cenário-alvo é justamente o editor longe do computador (nenhuma
 * aba do Studio aberta). `runTelegramNotifyTick` faz UMA rodada de
 * diff+notify e é pura o bastante (I/O só via `buildStateFn`/`notifyFn`
 * injetáveis) pra testar sem `setInterval` real; `startTelegramNotifyWatcher`
 * só embrulha isso num `setInterval`.
 *
 * Dedup: `NotifiedStore` em memória (1 por watcher — o processo do
 * studio-server já é de longa duração, não precisa persistir em disco). Uma
 * chave só é removida do store quando o evento de origem deixa de estar
 * pendente (gate respondido/aprovado) — se o MESMO gate reaparecer depois
 * (nova edição atingindo o stage 4, por ex.), notifica de novo. Uma chave só
 * é ADICIONADA ao store quando `notifyFn` retorna `ok:true` — um envio
 * `skipped` (sem credenciais) ou falho (rede/HTTP) NÃO marca dedup, então o
 * gate ainda pendente é retentado no próximo tick em vez de ficar
 * silenciosamente "esquecido" até resolver/reaparecer.
 *
 * Halt banner (#737/#738): NÃO tratado por este watcher — halt é emitido
 * por `render-halt-banner.ts`, um script CLI efêmero (1 processo por
 * chamada), não algo observável por polling de estado contínuo. A
 * formatação (`formatHaltNotifyMessage`) e o dedup entre invocações vivem em
 * `scripts/lib/telegram-notify.ts` + a própria `render-halt-banner.ts` — ver
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
 */

import {
  sendTelegramNotification,
  createInMemoryNotifiedStore,
  type NotifiedStore,
  type SendTelegramNotificationOptions,
} from "../lib/telegram-notify.ts";
import { buildStudioState, type StudioState } from "./studio-state.ts";

// Re-exportado por conveniência — `formatHaltNotifyMessage` mora em
// `scripts/lib/telegram-notify.ts` (não é Studio-específico, ver doc-comment
// lá), mas quem já importa deste módulo pra outras mensagens do Studio pode
// querer as 3 juntas sem um 2º import.
export { formatHaltNotifyMessage } from "../lib/telegram-notify.ts";

const DEFAULT_STUDIO_PUBLIC_BASE_URL = "http://127.0.0.1:4174";

/**
 * Base URL pública do Studio pra montar deep-links. Configurável via
 * `STUDIO_PUBLIC_BASE_URL` (#3564) — o default é o loopback local
 * (`http://127.0.0.1:4174`, mesma porta default de `server.ts`), que só é
 * alcançável a partir da MESMA máquina/rede até o acesso remoto (#3560)
 * existir. Nunca hardcodar `studio.diar.ia.br` — esse domínio não existe.
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
): string {
  const url = `${baseUrl}/edicao/${edition}`;
  return [
    `*[Diar.ia Studio] Gate pendente*`,
    `Edição \`${edition}\` aguardando aprovação — ${STAGE_GATE_LABEL[stage]}.`,
    url,
  ].join("\n");
}

/** Mensagem + deep-link pro chat drawer (o badge global de
 * `chatPermissionsPending` aparece em qualquer página do Studio — não há
 * ainda uma tela dedicada por gate, só o drawer embutido no shell, então o
 * deep-link é a home). `question` é o preview (`firstQuestion` de
 * `PendingPermissionSummary`) — omitido se indisponível. */
export function formatChatGateMessage(
  question: string | null,
  baseUrl: string,
): string {
  const url = `${baseUrl}/`;
  const preview = question ? `\n"${question}"` : "";
  return [
    `*[Diar.ia Studio] Pergunta pendente no chat*`,
    `A sessão está esperando uma resposta do editor.${preview}`,
    url,
  ].join("\n");
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

export interface TelegramNotifyTickOptions {
  /** Constrói o snapshot de estado — default `buildStudioState`, injetável
   * em testes pra não depender de `data/` real no disco. */
  buildStateFn?: (rootDir: string) => StudioState;
  /** Envia a notificação — default `sendTelegramNotification`, injetável em
   * testes pra não bater na rede/Telegram real. O `result.ok` do retorno é
   * o que decide se a chave entra no dedup store (ver `runTelegramNotifyTick`
   * abaixo) — um mock de teste que só quer registrar o texto enviado ainda
   * precisa retornar `{ok:true}` pra exercitar o caminho de dedup. */
  notifyFn?: (
    text: string,
    opts?: SendTelegramNotificationOptions,
  ) => Promise<{ ok: boolean; skipped?: boolean; error?: string }>;
  baseUrl?: string;
}

/**
 * Roda UMA rodada de diff+notify sobre o `rootDir` dado, usando `store` como
 * registro de dedup (mutado in-place — mesmo padrão de `Map`/`Set` já usado
 * por `studio-chat.ts`). Retorna as chaves notificadas nesta rodada (só pra
 * inspeção/teste — o caller normalmente ignora o retorno).
 */
export async function runTelegramNotifyTick(
  rootDir: string,
  store: NotifiedStore,
  opts: TelegramNotifyTickOptions = {},
): Promise<string[]> {
  const buildStateFn = opts.buildStateFn ?? buildStudioState;
  const notifyFn = opts.notifyFn ?? sendTelegramNotification;
  const baseUrl = opts.baseUrl ?? resolveStudioPublicBaseUrl();

  const state = buildStateFn(rootDir);

  const editionKeys = state.gatesPending.map((g) => editionGateKey(g.edition, g.stage));
  const chatKeys = state.chatPermissionsPending.map((p) => chatGateKey(p.toolUseId));
  const currentKeys = [...editionKeys, ...chatKeys];

  const plan = computeGateNotifications(currentKeys, store.keys());

  for (const key of plan.toClear) store.delete(key);

  // #3564 self-review: só marca `key` como notificada no dedup store quando
  // `notifyFn` de fato reporta `ok:true`. Sem essa checagem, um envio
  // `skipped` (sem credenciais) ou falho (rede/HTTP) ainda entrava no store
  // — o gate ficava "notificado" mesmo sem NENHUMA mensagem ter saído, e só
  // seria retentado se resolvido e reaberto depois. Com a checagem, um gate
  // ainda pendente é retentado a cada tick até um envio realmente bem
  // sucedido (mesma semântica de `notifyHaltViaTelegram` em
  // render-halt-banner.ts, que também só persiste dedup em `result.ok`).
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

export interface TelegramNotifyWatchHandle {
  close: () => void;
}

/**
 * Sobe o polling contínuo — chamado uma vez por `startStudioServer`
 * (`server.ts`). `pollIntervalMs` default 15s: bem dentro do requisito de
 * aceite "<30s" da issue, com margem pro próprio tempo de request HTTP do
 * Telegram.
 */
export function startTelegramNotifyWatcher(
  rootDir: string,
  opts: TelegramNotifyTickOptions & { pollIntervalMs?: number; store?: NotifiedStore } = {},
): TelegramNotifyWatchHandle {
  const store = opts.store ?? createInMemoryNotifiedStore();
  const interval = setInterval(() => {
    runTelegramNotifyTick(rootDir, store, opts).catch((e) => {
      // Fail-soft TOTAL (CLAUDE.md): erro aqui nunca deve derrubar o
      // studio-server — só logar e seguir pro próximo tick.
      console.warn(`[studio-telegram-notify] tick falhou: ${(e as Error).message}`);
    });
  }, opts.pollIntervalMs ?? 15_000);

  return { close: () => clearInterval(interval) };
}
