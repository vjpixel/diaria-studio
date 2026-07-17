/**
 * telegram-notify.ts (#3564)
 *
 * Client genérico de notificação via Telegram Bot API (`sendMessage`),
 * extraído do padrão que `scripts/overnight-watchdog.ts` (#2688/#2958) já
 * usava só para alertas de stall — ver `buildTelegramAlertRequest`/
 * `sendTelegramAlert` lá, que agora delegam pra este módulo (import +
 * re-export, sem duplicar a implementação; os nomes antigos ficam de pé pra
 * não quebrar `test/overnight-watchdog.test.ts`).
 *
 * Generaliza pra qualquer notificador do Studio (#3564 — gate 4/6 pendente,
 * `AskUserQuestion` pendente no chat, halt banner) sem duplicar boilerplate
 * de request/timeout/env var.
 *
 * Por que fetch cru na Bot API, não o plugin `telegram@claude-plugins-official`
 * (`docs/telegram-setup.md`): o plugin é um *channel* atrelado a uma sessão
 * INTERATIVA do Claude Code (MCP over stdio via Bun) — não existe fora dela.
 * `studio-server.ts` é um processo Node standalone (sem sessão Claude
 * anexada) e `render-halt-banner.ts`/`overnight-watchdog.ts` rodam como
 * scripts CLI efêmeros — nenhum dos três tem acesso ao channel. A Bot API
 * (`https://api.telegram.org/bot{token}/sendMessage`) é a única superfície
 * alcançável de fora de uma sessão, e é o MESMO bot (`TELEGRAM_BOT_TOKEN`,
 * criado via BotFather no setup do plugin) — reaproveita a credencial já
 * configurada, só troca o transporte.
 *
 * Fail-soft TOTAL (CLAUDE.md invariável "MCP indisponível = fail-fast" NÃO
 * se aplica aqui — o inverso: notificação é observabilidade extra, nunca
 * crítica): token/chat id ausentes = no-op silencioso; falha de rede/HTTP =
 * mesma coisa. `sendTelegramNotification` NUNCA lança.
 */

export const TELEGRAM_IO_TIMEOUT_MS = 10_000;

export interface TelegramCredentials {
  token: string;
  chatId: string;
}

/**
 * Resolve credenciais dos env vars (fail-soft: retorna `null` se qualquer
 * uma faltar — caller decide se isso vira um "skip" silencioso).
 *
 * `TELEGRAM_CHAT_ID` é o nome genérico (#3564, novos notificadores do
 * Studio). `TELEGRAM_WATCHDOG_CHAT_ID` é o nome legado do #2688 — mesmo bot,
 * mesmo DM do editor — mantido como fallback pra quem já tinha só o
 * watchdog armado não precisar reconfigurar nada.
 */
export function resolveTelegramCredentials(
  env: NodeJS.ProcessEnv = process.env,
): TelegramCredentials | null {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID || env.TELEGRAM_WATCHDOG_CHAT_ID;
  if (!token || !chatId) return null;
  return { token, chatId };
}

/**
 * Pure: monta a requisição de `sendMessage` (url + options), incluindo o
 * `signal` de timeout (#2958 — nenhuma chamada de rede deste projeto pode
 * ficar sem timeout). Extraído pra ser testável sem mockar rede.
 */
export function buildTelegramSendMessageRequest(
  token: string,
  chatId: string,
  text: string,
): { url: string; options: RequestInit } {
  return {
    url: `https://api.telegram.org/bot${token}/sendMessage`,
    options: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
      signal: AbortSignal.timeout(TELEGRAM_IO_TIMEOUT_MS),
    },
  };
}

export interface TelegramNotifyResult {
  ok: boolean;
  /** `true` quando nenhuma credencial estava configurada — não é uma
   * falha, é o modo "Telegram não configurado nesta máquina" (CLAUDE.md
   * fail-soft: ferramenta opcional, nunca bloqueia o resto). */
  skipped?: boolean;
  error?: string;
}

export interface SendTelegramNotificationOptions {
  /** Override de credenciais (testes). `null` explícito força o caminho
   * "sem credenciais" mesmo que o env tenha algo — default é resolver do
   * `process.env` via `resolveTelegramCredentials`. */
  credentials?: TelegramCredentials | null;
  /** `fetch` injetável (testes) — default é o `fetch` global do runtime. */
  fetchFn?: typeof fetch;
}

/**
 * Envia uma notificação via Telegram Bot API. Fail-soft TOTAL: nunca lança,
 * qualquer que seja a causa (sem credenciais, erro de rede, timeout, HTTP
 * não-2xx). O caller pode inspecionar `ok`/`skipped`/`error` pra logar, mas
 * não precisa de try/catch — o objetivo desta função é justamente absorver
 * essa responsabilidade pros ~4 pontos de chamada do projeto (watchdog,
 * halt banner, gate watcher do Studio) não reimplementarem o mesmo
 * try/catch cada um.
 */
export async function sendTelegramNotification(
  text: string,
  opts: SendTelegramNotificationOptions = {},
): Promise<TelegramNotifyResult> {
  const creds =
    opts.credentials !== undefined ? opts.credentials : resolveTelegramCredentials();
  if (!creds) return { ok: false, skipped: true };

  const fetchFn = opts.fetchFn ?? fetch;
  try {
    const { url, options } = buildTelegramSendMessageRequest(creds.token, creds.chatId, text);
    const resp = await fetchFn(url, options);
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return { ok: false, error: `Telegram ${resp.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ─── formatação de mensagens genéricas (pura) ──────────────────────────────

/**
 * Mensagem do halt banner (#737/#738) formatada pro Telegram — usada por
 * `render-halt-banner.ts`. Mora aqui (não em `studio-ui/`) porque
 * `render-halt-banner.ts` é um script CLI de uso geral (chamado pelo
 * orchestrator via Bash, independente do studio-server estar rodando) — não
 * deveria depender de um módulo do subsistema Studio UI só por causa de uma
 * função de formatação.
 */
export function formatHaltNotifyMessage(stage: string, reason: string, action: string): string {
  return [
    `*[Diar.ia] 🛑 PIPELINE PAROU*`,
    `STAGE: ${stage}`,
    `MOTIVO: ${reason}`,
    `AÇÃO: ${action}`,
  ].join("\n");
}

// ─── dedup (#3564 — "não re-notificar o MESMO gate/evento repetidamente") ──
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
