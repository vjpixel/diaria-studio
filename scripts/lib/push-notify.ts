/**
 * push-notify.ts (#5341)
 *
 * Client genérico de notificação push — canal E-MAIL via Gmail
 * (`scripts/lib/gmail-send.ts`, `sendGmailMessage`), substituindo o client
 * genérico anterior (removido no Passo 2 desta issue). Decisão do editor
 * (15/08/2026): padronizar em e-mail em vez de exigir um app de mensagens
 * novo — toda a maquinaria de notificação push do projeto era, na prática,
 * um no-op silencioso (sem as credenciais do canal anterior configuradas).
 * O canal novo reusa a MESMA credencial OAuth já usada por 17 alarmes
 * agendados (`docs/*-setup.md`) — ver `google-auth.ts`.
 *
 * Espelha a API do módulo antigo pros 4 call sites (watchdog, halt banner,
 * Studio gate/AskUserQuestion pendente, hook `/diaria-continuo`) não
 * reimplementarem boilerplate: mesmo shape de resultado (`ok`/`skipped`/
 * `error`), mesmo dedup puro (`shouldNotify`/`markNotified`/`DedupRecord`),
 * mesmo store em memória (`createInMemoryNotifiedStore`).
 *
 * Fail-soft TOTAL (CLAUDE.md invariável "MCP indisponível = fail-fast" NÃO
 * se aplica aqui — o inverso: notificação é observabilidade extra, nunca
 * crítica): `sendGmailMessage` LANÇA em qualquer falha (auth, rede, 4xx/5xx)
 * — `sendPushNotification` captura tudo, nunca propaga.
 *
 * Timeout explícito (#2958 — nenhuma chamada de rede deste projeto fica sem
 * timeout): `PUSH_IO_TIMEOUT_MS` (10s, mesmo valor do timeout do canal
 * anterior) envolve a chamada inteira (refresh OAuth +
 * envio) via `withTimeout` (`scripts/lib/mcp-guard.ts`) — `sendGmailMessage`
 * em si não aceita `AbortSignal` (usa `gFetch`, que já teria que mudar a
 * assinatura de `google-auth.ts` compartilhada por Drive/inbox-drain/imagens
 * sociais só por causa deste caller; o wrapper por fora é suficiente pro
 * requisito "nunca fica pendurado indefinidamente" sem essa mudança maior).
 *
 * Mensagens agora carregam `subject` + `body` (e-mail, ao contrário do
 * canal anterior, não tem um único campo de texto livre com preview) — os
 * formatadores (`formatHaltNotifyMessage` e os do Studio em
 * `studio-push-notify.ts`) retornam `PushMessage`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sendGmailMessage } from "./gmail-send.ts";
import { resolveEditorEmail } from "./inbox-stats.ts";
import { withTimeout } from "./mcp-guard.ts";

export const PUSH_IO_TIMEOUT_MS = 10_000;

const PLATFORM_CONFIG_PATH_DEFAULT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "platform.config.json",
);

/** Assunto + corpo de uma notificação push — e-mail não tem um único campo
 * de texto livre como o canal anterior tinha. */
export interface PushMessage {
  subject: string;
  body: string;
}

export interface PushNotifyResult {
  ok: boolean;
  /** `true` quando a notificação foi deliberadamente pulada (hoje: nunca
   * setado por `sendPushNotification` em si — mantido no shape só pra
   * compatibilidade com o formato antigo e os callers que já checam esse
   * campo antes de decidir se persistem dedup). */
  skipped?: boolean;
  error?: string;
}

export interface SendPushNotificationOptions {
  /** Destinatário — default `resolveEditorEmail(platform.config.json)`
   * (mesmo helper usado pelos 17 alarmes existentes; hoje resolve pra
   * `vjpixel@gmail.com`). */
  to?: string;
  /** `sendGmailMessage` injetável (testes) — evita bater na rede/Gmail
   * real. */
  sendFn?: typeof sendGmailMessage;
  /** Timeout em ms — default `PUSH_IO_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Path de `platform.config.json` — default o do repo real; testes podem
   * apontar pra um fixture. */
  platformConfigPath?: string;
}

/**
 * Envia uma notificação push via e-mail (Gmail). Fail-soft TOTAL: nunca
 * lança, qualquer que seja a causa (credenciais ausentes/expiradas, erro de
 * rede, timeout, HTTP não-2xx). O caller pode inspecionar `ok`/`error` pra
 * logar, mas não precisa de try/catch — mesmo contrato do módulo do canal
 * anterior.
 */
export async function sendPushNotification(
  message: PushMessage,
  opts: SendPushNotificationOptions = {},
): Promise<PushNotifyResult> {
  const to = opts.to ?? resolveEditorEmail(opts.platformConfigPath ?? PLATFORM_CONFIG_PATH_DEFAULT);
  const sendFn = opts.sendFn ?? sendGmailMessage;
  const timeoutMs = opts.timeoutMs ?? PUSH_IO_TIMEOUT_MS;
  try {
    await withTimeout(() => sendFn(to, message.subject, message.body), timeoutMs);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

// ─── formatação de mensagens genéricas (pura) ──────────────────────────────

/**
 * Mensagem do halt banner (#737/#738) formatada pro e-mail — usada por
 * `render-halt-banner.ts`. Mora aqui (não em `studio-ui/`) pelo mesmo motivo
 * do módulo antigo: `render-halt-banner.ts` é um script CLI de uso geral
 * (chamado pelo orchestrator via Bash, independente do studio-server estar
 * rodando) — não deveria depender de um módulo do subsistema Studio UI só
 * por causa de uma função de formatação.
 */
export function formatHaltNotifyMessage(stage: string, reason: string, action: string): PushMessage {
  return {
    subject: `[diar.ia.br] Pipeline parou — ${stage}`,
    body: [`STAGE: ${stage}`, `MOTIVO: ${reason}`, `AÇÃO: ${action}`].join("\n"),
  };
}

// ─── dedup (mesma forma pura do módulo antigo) ─────────────────────────────
//
// Duas variantes, mesma forma pura por baixo:
//   - `DedupRecord` (map key -> timestamp da última notificação) + as funções
//     puras `shouldNotify`/`markNotified` — usadas por callers que persistem
//     o registro entre invocações de PROCESSO separadas (ex: `render-halt-banner.ts`,
//     que roda como CLI efêmero a cada chamada do orchestrator — sem estado
//     em memória sobrevivendo entre chamadas, o dedup só funciona se for
//     lido/gravado em disco pelo caller usando estas funções puras).
//   - `createInMemoryNotifiedStore` — Set em memória, para callers de
//     processo longa-duração (ex: o watcher do `studio-server.ts`, que roda
//     contínuo e só precisa lembrar "já notifiquei" enquanto o processo
//     estiver de pé).

export type DedupRecord = Record<string, number>;

/** `true` se `key` nunca foi notificada, ou se a última notificação já saiu
 * da janela de dedup (`windowMs`). Pura — não lê relógio nem disco. */
export function shouldNotify(
  record: DedupRecord,
  key: string,
  nowMs: number,
  windowMs: number,
): boolean {
  const last = record[key];
  return last === undefined || nowMs - last >= windowMs;
}

/** Retorna um NOVO `DedupRecord` com `key` marcada como notificada em
 * `nowMs` — pura, não muta `record` (o caller decide como persistir). */
export function markNotified(record: DedupRecord, key: string, nowMs: number): DedupRecord {
  return { ...record, [key]: nowMs };
}

export interface NotifiedStore {
  has(key: string): boolean;
  add(key: string): void;
  delete(key: string): void;
  keys(): string[];
}

/** Store de dedup em memória (Set) — 1 por processo de longa duração.
 * `delete` permite ao caller "esquecer" uma chave quando o evento de origem
 * deixa de estar ativo (ex: gate foi respondido) — se o MESMO evento voltar
 * a ficar pendente depois, ele notifica de novo em vez de ficar mudo pra
 * sempre. */
export function createInMemoryNotifiedStore(): NotifiedStore {
  const seen = new Set<string>();
  return {
    has: (key) => seen.has(key),
    add: (key) => {
      seen.add(key);
    },
    delete: (key) => {
      seen.delete(key);
    },
    keys: () => [...seen],
  };
}

// ─── Store de dedup PERSISTENTE em arquivo (#6125) ─────────────────────────
//
// O watcher de push-notify do Studio (`studio-push-notify.ts`) usava o store
// em memória acima — mas o processo do studio-server tem histórico documentado
// de restart (self-restart #5674, zumbi/crash-restart systemd #5737/#5759).
// Cada restart zerava o dedup e um gate AINDA pendente era re-notificado por
// e-mail (3 e-mails repetidos na madrugada de 25/08/2026, edição 260825).
//
// `createFileNotifiedStore` persiste as chaves (com timestamp) num JSON em
// disco, sobrevivendo a restarts. Fail-soft TOTAL: leitura corrompida/ausente,
// diretório inexistente ou falha de escrita NUNCA lançam — degradam pra
// comportamento em memória (mesmo princípio do resto do canal de push).

/** Entradas mais velhas que isso são podadas ao carregar/salvar — chaves de
 * gate são efêmeras (edição resolve em horas); 30 dias é folga enorme e
 * impede crescimento ilimitado do arquivo. */
export const FILE_NOTIFIED_STORE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Store de dedup persistido em `filePath` (JSON `{ key: timestampMs }`).
 * Escrita síncrona e atômica o bastante pra este uso (tmp + rename) a cada
 * mutação — o volume é ínfimo (1 write por notificação, não por tick).
 */
export function createFileNotifiedStore(
  filePath: string,
  opts: { now?: () => number; ttlMs?: number } = {},
): NotifiedStore {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? FILE_NOTIFIED_STORE_TTL_MS;

  let record: Record<string, number> = {};
  try {
    record = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, number>;
    if (typeof record !== "object" || record === null || Array.isArray(record)) record = {};
  } catch {
    record = {}; // ausente/corrompido → começa vazio (fail-soft)
  }

  // Podar entradas fora da TTL já no load.
  const cutoff = now() - ttlMs;
  for (const key of Object.keys(record)) {
    if (typeof record[key] !== "number" || record[key] < cutoff) delete record[key];
  }

  const flush = (): void => {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(record), "utf8");
      renameSync(tmp, filePath);
    } catch {
      // Falha de escrita nunca lança — dedup segue válido só em memória.
    }
  };

  return {
    has: (key) => record[key] !== undefined,
    add: (key) => {
      record[key] = now();
      flush();
    },
    delete: (key) => {
      if (record[key] !== undefined) {
        delete record[key];
        flush();
      }
    },
    keys: () => Object.keys(record),
  };
}
