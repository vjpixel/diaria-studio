/**
 * apoia-se-gmail-drain.ts (#3859 metade 1; promessas #3912)
 *
 * Drena notificações de "novo apoio" da apoia.se direto do Gmail pessoal
 * (mesmo mecanismo REST não-MCP de `scripts/inbox-drain.ts` — `gFetch` +
 * `data/.credentials.json`, ver `scripts/google-auth.ts`). Desbloqueia a
 * metade 1 da issue #3859: o bloqueio original ("studio-server headless sem
 * acesso a Gmail") era falso — o projeto já tem esse caminho REST funcionando
 * pro inbox editorial, e ele independe de qualquer MCP.
 *
 * Query Gmail confirmada ao vivo (260722): `from:noreply@apoia.se subject:"novo
 * apoio"` — deliberadamente NÃO `from:apoia.se` sozinho, que também casaria
 * e-mails de marketing/suporte de `comunidade@apoia.se` (ruído, não
 * notificação de pagamento).
 *
 * Corpo (text/plain) da notificação tem a linha:
 *   {NOME} <{email}> acabou de apoiar sua campanha diar.ia.br com o valor de *R${valor}* !
 * (os asteriscos são markdown do template da apoia.se/Brevo — `*R$25*` — não
 * fazem parte do valor).
 *
 * **Promessas (#3912):** a apoia.se também manda um e-mail distinto quando um
 * apoiador PROMETE (mas ainda não pagou) — subject "Você tem uma nova
 * promessa de apoiador! :D", corpo com a linha:
 *   {NOME} <{email}> recém prometeu um apoio de R${valor}
 * A query abaixo casa AMBOS os templates (`OR` de subject) numa única busca —
 * cada mensagem é tentada primeiro contra `parseApoioNotificationEmail`
 * (confirmado) e, se não bater, contra `parsePromessaEmail` (promessa).
 * Promessa vira contato PENDENTE (não "apoiando" — quem decide isso é sempre
 * `checkBacker`, ver `scripts/studio-ui/studio-apoios.ts::importPendingApoiadoresFromGmail`)
 * pra que o próximo force-refresh tenha a chance de confirmar a conversão
 * mesmo quando a apoia.se NÃO reenvia um e-mail de "novo apoio" (caso
 * comprovado: Ivan, 260722 — promessa converteu em pagamento sem 2º e-mail).
 *
 * Cursor: `data/apoia-se/gmail-drain-cursor.json` — MESMO formato de
 * `data/inbox-cursor.json`: `{ last_drain_iso: string | null }`. Cursor
 * separado do inbox editorial — são drains independentes, de queries e
 * propósitos diferentes. Único cursor pras 2 famílias de notificação (mesma
 * busca cobre ambas).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gFetch } from "../google-auth.ts";
import { parseGmailThread, parseGmailThreadsList } from "./schemas/gmail.ts";
import { isAuthExpiredError } from "../inbox-drain.ts";

const GMAIL_API = "https://www.googleapis.com/gmail/v1/users/me";

/** Query Gmail default — ver rationale no cabeçalho do módulo. Casa AMBOS os
 * templates (confirmado + promessa, #3912) numa única busca. */
export const APOIA_SE_GMAIL_QUERY =
  'from:noreply@apoia.se (subject:"novo apoio" OR subject:"nova promessa")';

// ---------------------------------------------------------------------------
// Parse (pure) — testável sem I/O
// ---------------------------------------------------------------------------

export interface ApoioNotification {
  name: string;
  email: string;
  value: number;
}

/**
 * `{NOME} <{email}> acabou de apoiar sua campanha diar.ia.br com o valor de
 * *R${valor}* !` — não-ganancioso no nome ([^\n<>]+?) pra não engolir o `<`
 * do email; asteriscos/pontuação em volta do valor são opcionais (o template
 * pode variar). Vírgula decimal (`R$25,50`) é aceita e normalizada pra ponto.
 */
const APOIO_LINE_RE =
  /([^\n<>]+?)\s*<\s*([^\s<>]+@[^\s<>]+)\s*>\s*acabou de apoiar sua campanha diar\.ia\.br com o valor de\s*\*?\s*R\$\s*(\d+(?:[.,]\d+)?)\s*\*?\s*!?/i;

/**
 * Parseia o corpo text/plain de uma notificação "novo apoio" da apoia.se.
 * Retorna `null` se o corpo não bate com o padrão esperado (email de
 * marketing/suporte de comunidade@apoia.se que escapou da query, corpo vazio,
 * template mudou, etc.) — nunca lança.
 */
export function parseApoioNotificationEmail(bodyText: string): ApoioNotification | null {
  if (!bodyText) return null;
  const m = APOIO_LINE_RE.exec(bodyText);
  if (!m) return null;
  const name = m[1].trim();
  const email = m[2].trim().toLowerCase();
  const value = Number(m[3].replace(",", "."));
  if (!name || !email || !Number.isFinite(value)) return null;
  return { name, email, value };
}

/** Mesmo shape de `ApoioNotification` (name/email/value) — promessa NUNCA
 * afirma pagamento, só quem prometeu e quanto (#3912). */
export type PromessaNotification = ApoioNotification;

/**
 * `{NOME} <{email}> recém prometeu um apoio de R${valor}` — mesma tolerância
 * de template do parser de apoio confirmado (asteriscos/pontuação opcionais,
 * vírgula decimal normalizada). "recém"/"recem" (sem acento) ambos casam.
 */
const PROMESSA_LINE_RE =
  /([^\n<>]+?)\s*<\s*([^\s<>]+@[^\s<>]+)\s*>\s*rec[eé]m prometeu um apoio de\s*\*?\s*R\$\s*(\d+(?:[.,]\d+)?)\s*\*?\s*!?/i;

/**
 * Parseia o corpo text/plain de uma notificação "nova promessa" da apoia.se
 * (#3912). Retorna `null` se o corpo não bate com o padrão esperado — nunca
 * lança. Promessa é intencionalmente NÃO tratada como pagamento confirmado:
 * ver `importPendingApoiadoresFromGmail` em `studio-apoios.ts`.
 */
export function parsePromessaEmail(bodyText: string): PromessaNotification | null {
  if (!bodyText) return null;
  const m = PROMESSA_LINE_RE.exec(bodyText);
  if (!m) return null;
  const name = m[1].trim();
  const email = m[2].trim().toLowerCase();
  const value = Number(m[3].replace(",", "."));
  if (!name || !email || !Number.isFinite(value)) return null;
  return { name, email, value };
}

// ---------------------------------------------------------------------------
// Cursor I/O — mesmo formato/tratamento de clock-drift de inbox-drain.ts
// ---------------------------------------------------------------------------

export interface GmailDrainCursor {
  last_drain_iso: string | null;
}

export function gmailDrainCursorPath(rootDir: string): string {
  return resolve(rootDir, "data", "apoia-se", "gmail-drain-cursor.json");
}

export function loadGmailDrainCursor(rootDir: string): GmailDrainCursor {
  const path = gmailDrainCursorPath(rootDir);
  if (!existsSync(path)) return { last_drain_iso: null };
  try {
    const cursor = JSON.parse(readFileSync(path, "utf-8")) as GmailDrainCursor;
    // Mesmo guard de clock-drift de inbox-drain.ts::loadCursor (#441): cursor
    // no futuro travaria o drain silenciosamente.
    if (cursor.last_drain_iso && cursor.last_drain_iso > new Date().toISOString()) {
      return { last_drain_iso: null };
    }
    return cursor;
  } catch {
    return { last_drain_iso: null };
  }
}

export function saveGmailDrainCursor(rootDir: string, cursor: GmailDrainCursor): void {
  const path = gmailDrainCursorPath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cursor, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Gmail REST helpers (subconjunto de inbox-drain.ts — corpo text/plain só)
// ---------------------------------------------------------------------------

function decodeBase64Url(str: string): string {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

interface TextBodyPart {
  mimeType: string;
  body?: { data?: string };
  parts?: TextBodyPart[];
}

function extractTextBody(part: TextBodyPart): string {
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  if (part.parts) {
    for (const child of part.parts) {
      const text = extractTextBody(child);
      if (text) return text;
    }
  }
  return "";
}

async function gmailRequest<T>(path: string, gmailFetch: typeof gFetch): Promise<T> {
  const res = await gmailFetch(`${GMAIL_API}/${path}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail API error (${res.status}) at ${path}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------

export interface DrainApoiaSeOptions {
  /** Injetável pra testes — evita chamada de rede real (mesmo formato de
   * `gFetch`: `(url, options?) => Promise<Response>`). Default: `gFetch`. */
  gmailFetch?: typeof gFetch;
  query?: string;
}

/** Promessa drenada + o timestamp (ISO) da mensagem — o timestamp vem do
 * envelope Gmail (`internalDate`), não do corpo, por isso é anexado aqui e
 * não faz parte de `PromessaNotification` (que só cobre o parse puro do
 * corpo). #3912. */
export interface DrainedPromessa extends PromessaNotification {
  receivedAtIso: string;
}

export interface DrainApoiaSeResult {
  notifications: ApoioNotification[];
  /** Promessas de apoio (ainda não pagas) drenadas na mesma busca (#3912) —
   * opcional pra manter compat com mocks/fixtures existentes que só conhecem
   * `notifications`; ausente é tratado como `[]` pelo caller. */
  promessas?: DrainedPromessa[];
  most_recent_iso: string | null;
  /** `true` quando a busca de threads falhou — cursor NÃO avança (mesma
   * disciplina de inbox-drain.ts #668, reprocessa na próxima tentativa). */
  skipped: boolean;
  reason?: string;
  /** #1973: distingue OAuth expirado (reconhecível, ação clara) de falha
   * transiente — mesmo `isAuthExpiredError` de inbox-drain.ts. */
  auth_expired?: boolean;
  /** Threads que falharam ao carregar (parse/rede) — fail-soft por thread,
   * não derruba o drain inteiro. */
  errors?: number;
}

/**
 * Busca + parseia notificações de "novo apoio" novas desde o cursor. Nunca
 * lança — falha de busca (rede, auth) vira `skipped: true` com `reason`;
 * falha de thread individual é contada em `errors` e pulada (mesmo padrão de
 * `iterateThreads` em inbox-drain.ts).
 */
export async function drainApoiaSeNotifications(
  rootDir: string,
  opts: DrainApoiaSeOptions = {},
): Promise<DrainApoiaSeResult> {
  const gmailFetch = opts.gmailFetch ?? gFetch;
  const query = opts.query ?? APOIA_SE_GMAIL_QUERY;
  const cursor = loadGmailDrainCursor(rootDir);
  const lastDrain = cursor.last_drain_iso;

  let threads: Array<{ id: string }>;
  try {
    const params = new URLSearchParams({ q: query, maxResults: "50" });
    const raw = await gmailRequest<unknown>(`threads?${params}`, gmailFetch);
    threads = parseGmailThreadsList(raw).threads ?? [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const authExpired = isAuthExpiredError(msg);
    return {
      notifications: [],
      most_recent_iso: null,
      skipped: true,
      reason: authExpired ? "auth_expired" : "search_failed",
      ...(authExpired ? { auth_expired: true } : {}),
    };
  }

  const notifications: ApoioNotification[] = [];
  const promessas: DrainedPromessa[] = [];
  let mostRecentIso: string | null = null;
  let errors = 0;

  for (const thread of threads) {
    let full;
    try {
      const raw = await gmailRequest<unknown>(`threads/${thread.id}?format=full`, gmailFetch);
      full = parseGmailThread(raw);
    } catch {
      errors += 1;
      continue;
    }

    for (const msg of full.messages) {
      const dateMs = parseInt(msg.internalDate, 10);
      const iso = new Date(dateMs).toISOString();
      if (lastDrain && iso <= lastDrain) continue;
      if (!mostRecentIso || iso > mostRecentIso) mostRecentIso = iso;

      const body = extractTextBody(msg.payload);
      const parsed = parseApoioNotificationEmail(body);
      if (parsed) {
        notifications.push(parsed);
        continue;
      }
      // Não bateu com "novo apoio" confirmado — tenta promessa (#3912) antes
      // de descartar a mensagem.
      const promessa = parsePromessaEmail(body);
      if (promessa) promessas.push({ ...promessa, receivedAtIso: iso });
    }
  }

  saveGmailDrainCursor(rootDir, { last_drain_iso: mostRecentIso ?? lastDrain });

  return {
    notifications,
    ...(promessas.length > 0 ? { promessas } : {}),
    most_recent_iso: mostRecentIso,
    skipped: false,
    ...(errors > 0 ? { errors } : {}),
  };
}
