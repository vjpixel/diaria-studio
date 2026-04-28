/**
 * inbox-drain.ts
 *
 * Drena novos e-mails de `diariaeditor@gmail.com` (via Gmail REST API)
 * desde o último cursor e anexa entradas estruturadas em `data/inbox.md`.
 *
 * Substitui o subagente `inbox-drainer` (Haiku via Task).
 *
 * Uso:
 *   npx tsx scripts/inbox-drain.ts
 *
 * Output (stdout): JSON com { new_entries, urls[], topics[], most_recent_iso, skipped }
 *
 * Configuração em platform.config.json:
 *   inbox.enabled       (default: true)
 *   inbox.gmailQuery    (default: "label:Diaria")
 *
 * Cursor: data/inbox-cursor.json  — { last_drain_iso: "2026-04-17T14:22:00Z" | null }
 * Credenciais: data/.credentials.json (gerado por scripts/oauth-setup.ts)
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gFetch } from "./google-auth.ts";

const ROOT = resolve(import.meta.dirname, "..");
const GMAIL_API = "https://www.googleapis.com/gmail/v1/users/me";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

interface PlatformConfig {
  inbox?: {
    enabled?: boolean;
    gmailQuery?: string;
    address?: string;
  };
}

interface InboxCursor {
  last_drain_iso: string | null;
  consecutive_empty_drains?: number;
}

interface DrainResult {
  new_entries: number;
  urls: Array<{ url: string; from: string; subject: string }>;
  topics: Array<{ text: string; from: string; subject: string }>;
  most_recent_iso: string | null;
  skipped: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Gmail API helpers
// ---------------------------------------------------------------------------

async function gmailRequest<T>(path: string): Promise<T> {
  const res = await gFetch(`${GMAIL_API}/${path}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail API error (${res.status}) at ${path}: ${body}`);
  }
  return res.json() as Promise<T>;
}

interface GmailThread {
  id: string;
  snippet: string;
}

async function searchThreads(query: string): Promise<GmailThread[]> {
  const params = new URLSearchParams({ q: query, maxResults: "50" });
  const data = await gmailRequest<{ threads?: GmailThread[] }>(`threads?${params}`);
  return data.threads ?? [];
}

interface GmailMessagePart {
  mimeType: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
  headers?: Array<{ name: string; value: string }>;
}

interface GmailMessage {
  id: string;
  internalDate: string; // epoch ms as string
  payload: GmailMessagePart & { headers: Array<{ name: string; value: string }> };
}

interface GmailThread2 {
  id: string;
  messages: GmailMessage[];
}

async function getThread(threadId: string): Promise<GmailThread2> {
  return gmailRequest<GmailThread2>(`threads/${threadId}?format=full`);
}

interface GmailLabel {
  id: string;
  name: string;
}

async function listLabels(): Promise<GmailLabel[]> {
  const data = await gmailRequest<{ labels?: GmailLabel[] }>("labels");
  return data.labels ?? [];
}

async function createLabel(displayName: string): Promise<GmailLabel> {
  const res = await gFetch(`${GMAIL_API}/labels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: displayName }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail createLabel error (${res.status}): ${body}`);
  }
  return res.json() as Promise<GmailLabel>;
}

// ---------------------------------------------------------------------------
// Helpers de extração
// ---------------------------------------------------------------------------

function decodeBase64Url(str: string): string {
  // Gmail usa base64url (- em vez de +, _ em vez de /)
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

function extractTextBody(part: GmailMessagePart): string {
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

export const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;
export const TRAILING_PUNCT = /[.,;:!?)]+$/;
const EMAIL_SIGNATURE_MARKERS = [
  "enviado do meu iphone",
  "enviado do meu android",
  "sent from my iphone",
  "sent from my android",
  "sent from outlook",
  "--\n",
  "________________________________",
];

function cleanBody(body: string): string {
  // Remove assinatura de e-mail
  let cleaned = body;
  for (const marker of EMAIL_SIGNATURE_MARKERS) {
    const idx = cleaned.toLowerCase().indexOf(marker);
    if (idx > 50) {
      cleaned = cleaned.slice(0, idx);
    }
  }
  return cleaned.trim();
}

export function extractUrls(text: string): string[] {
  const raw = text.match(URL_REGEX) ?? [];
  return raw
    .map((u) => u.replace(TRAILING_PUNCT, ""))
    .filter((u) => u.length > 10);
}

function getHeader(msg: GmailMessage, name: string): string {
  return msg.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

// ---------------------------------------------------------------------------
// Inbox cache
// ---------------------------------------------------------------------------

function loadCursor(): InboxCursor {
  const cursorPath = resolve(ROOT, "data", "inbox-cursor.json");
  if (!existsSync(cursorPath)) return { last_drain_iso: null };
  try {
    return JSON.parse(readFileSync(cursorPath, "utf8")) as InboxCursor;
  } catch {
    return { last_drain_iso: null };
  }
}

function saveCursor(cursor: InboxCursor): void {
  const cursorPath = resolve(ROOT, "data", "inbox-cursor.json");
  mkdirSync(dirname(cursorPath), { recursive: true });
  writeFileSync(cursorPath, JSON.stringify(cursor, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Pure helpers — extraídos para testar isoladamente
// ---------------------------------------------------------------------------

export const EMPTY_DRAIN_WARN_THRESHOLD = 3;

export function isLabelQuery(query: string): boolean {
  return /^\s*label:/i.test(query);
}

export function extractLabelName(query: string): string {
  const m = query.match(/label:([^\s]+)/i);
  return m ? m[1] : "";
}

export function labelExistsInList(
  labels: Array<{ name: string }>,
  target: string,
): boolean {
  if (!target) return true; // sem label name → não validar
  const norm = target.toLowerCase();
  return labels.some((l) => l.name.toLowerCase() === norm);
}

export function incrementEmptyDrain(cursor: InboxCursor): InboxCursor {
  return {
    ...cursor,
    consecutive_empty_drains: (cursor.consecutive_empty_drains ?? 0) + 1,
  };
}

export function resetEmptyDrain(cursor: InboxCursor): InboxCursor {
  return { ...cursor, consecutive_empty_drains: 0 };
}

export function shouldWarnEmptyDrains(cursor: InboxCursor): boolean {
  return (cursor.consecutive_empty_drains ?? 0) >= EMPTY_DRAIN_WARN_THRESHOLD;
}

/**
 * Strip do prefixo `label:NomeDoLabel` da query do Gmail (#274). Usado quando
 * detectamos múltiplos drains consecutivos vazios pra rodar uma checagem
 * alternativa sem o filtro de label — distingue inbox genuinamente vazio
 * (editor não mandou nada) de label quebrado (e-mails chegando mas sem label
 * aplicada).
 */
export function stripLabelFromQuery(query: string): string {
  return query.replace(/(^|\s)label:[^\s]+/gi, "").trim();
}

// ---------------------------------------------------------------------------
// Run log — registra exceções para /diaria-log ver (stderr é invisível)
// ---------------------------------------------------------------------------

function getRunLogPath(): string {
  const cfgPath = resolve(ROOT, "platform.config.json");
  if (!existsSync(cfgPath)) return resolve(ROOT, "data/run-log.jsonl");
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    return resolve(ROOT, cfg?.logging?.path ?? "data/run-log.jsonl");
  } catch {
    return resolve(ROOT, "data/run-log.jsonl");
  }
}

function logDrainError(err: Error): void {
  try {
    const event = {
      timestamp: new Date().toISOString(),
      edition: null,
      stage: 1,
      agent: "inbox-drainer",
      level: "error",
      message: err.message,
      details: { stack: err.stack ?? null },
    };
    const logPath = getRunLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // swallow — logging must never mask the original error
  }
}

function logDrainWarn(message: string, details?: Record<string, unknown>): void {
  try {
    const event = {
      timestamp: new Date().toISOString(),
      edition: null,
      stage: 1,
      agent: "inbox-drainer",
      level: "warn",
      message,
      details: details ?? null,
    };
    const logPath = getRunLogPath();
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify(event) + "\n", "utf8");
  } catch {
    // swallow
  }
}

// ---------------------------------------------------------------------------
// Inbox.md append
// ---------------------------------------------------------------------------

function appendToInbox(entries: string[]): void {
  const inboxPath = resolve(ROOT, "data", "inbox.md");
  if (!existsSync(inboxPath)) {
    writeFileSync(
      inboxPath,
      "# Inbox Editorial — Diar.ia\n\n<!-- entries abaixo -->\n",
      "utf8"
    );
  }

  const current = readFileSync(inboxPath, "utf8");
  const markerIdx = current.indexOf("<!-- entries abaixo -->");
  if (markerIdx === -1) {
    // Fallback: append ao final
    writeFileSync(inboxPath, current + "\n" + entries.join("\n"), "utf8");
    return;
  }

  const before = current.slice(0, markerIdx + "<!-- entries abaixo -->".length);
  const after = current.slice(markerIdx + "<!-- entries abaixo -->".length);
  writeFileSync(inboxPath, before + "\n" + entries.join("\n") + after, "utf8");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Ler config
  const configPath = resolve(ROOT, "platform.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as PlatformConfig;
  const inboxEnabled = config.inbox?.enabled !== false;
  const gmailQuery = config.inbox?.gmailQuery ?? "label:Diaria";

  if (!inboxEnabled) {
    const result: DrainResult = {
      new_entries: 0,
      urls: [],
      topics: [],
      most_recent_iso: null,
      skipped: true,
      reason: "inbox_disabled",
    };
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const cursor = loadCursor();
  let afterDate: string;
  if (!cursor.last_drain_iso) {
    // Primeira execução: 3 dias atrás
    const d = new Date();
    d.setDate(d.getDate() - 3);
    afterDate = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  } else {
    const d = new Date(cursor.last_drain_iso);
    afterDate = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  }

  const query = `${gmailQuery} after:${afterDate}`;

  // Validação proativa: se a query usa label:, confirmar que o label existe
  // antes de buscar. Gmail's q=label:X não erra se o label não existe — só
  // retorna vazio. Sem essa checagem, drain falha silenciosamente para sempre.
  if (isLabelQuery(gmailQuery)) {
    const labelName = extractLabelName(gmailQuery);
    try {
      const labels = await listLabels();
      if (!labelExistsInList(labels, labelName)) {
        try {
          await createLabel(labelName);
        } catch {
          // best-effort — se não conseguir criar, segue com warning
        }
        const reason = `label_missing: '${labelName}' não existe na conta. Crie o filtro automático em ${config.inbox?.address ?? "Gmail"} (ver docs/gmail-inbox-setup.md).`;
        console.error(`⚠️  ${reason}`);
        logDrainWarn(reason, { label: labelName });
        const result: DrainResult = {
          new_entries: 0,
          urls: [],
          topics: [],
          most_recent_iso: null,
          skipped: true,
          reason,
        };
        console.log(JSON.stringify(result, null, 2));
        return;
      }
    } catch (err) {
      // listLabels falhou — não bloquear, mas registrar pra audit
      logDrainWarn(`label validation skipped (listLabels failed): ${String(err)}`);
    }
  }

  const threads: GmailThread[] = await searchThreads(query);

  const lastDrain = cursor.last_drain_iso;
  const inboxEntries: string[] = [];
  const resultUrls: DrainResult["urls"] = [];
  const resultTopics: DrainResult["topics"] = [];
  let mostRecentIso: string | null = null;

  for (const thread of threads) {
    let fullThread: GmailThread2;
    try {
      fullThread = await getThread(thread.id);
    } catch {
      continue; // pular threads com erro
    }

    for (const msg of fullThread.messages) {
      const dateMs = parseInt(msg.internalDate, 10);
      const iso = new Date(dateMs).toISOString();

      // Filtrar client-side: só e-mails mais recentes que o cursor
      if (lastDrain && iso <= lastDrain) continue;

      const from = getHeader(msg, "From");
      const subject = getHeader(msg, "Subject") || "(sem assunto)";
      const body = cleanBody(extractTextBody(msg.payload));
      const urls = extractUrls(body);
      const rawPreview = body.slice(0, 300).replace(/\n+/g, " ");

      if (!mostRecentIso || iso > mostRecentIso) mostRecentIso = iso;

      // Montar entrada markdown
      const lines: string[] = [`## ${iso}`, `- **from:** ${from}`, `- **subject:** ${subject}`];

      if (urls.length > 0) {
        lines.push("- **urls:**");
        for (const u of urls) lines.push(`  - ${u}`);
        for (const u of urls) resultUrls.push({ url: u, from, subject });
      } else if (body.length > 20) {
        const topic = body.slice(0, 200).trim();
        lines.push(`- **topic:** ${topic}`);
        resultTopics.push({ text: topic, from, subject });
      } else {
        // E-mail sem conteúdo útil — pular
        continue;
      }

      lines.push(`- **raw:** > ${rawPreview}`, "");
      inboxEntries.push(lines.join("\n"));
    }
  }

  let updatedCursor: InboxCursor;
  let warnReason: string | undefined;
  if (inboxEntries.length > 0) {
    appendToInbox(inboxEntries);
    updatedCursor = resetEmptyDrain({
      ...cursor,
      last_drain_iso: mostRecentIso ?? cursor.last_drain_iso,
    });
  } else {
    updatedCursor = incrementEmptyDrain(cursor);
    if (shouldWarnEmptyDrains(updatedCursor)) {
      // #274: distinguir inbox genuinamente vazio de label quebrada.
      // Roda 1 query alternativa sem `label:` na mesma janela. Se também
      // voltar 0 → genuinamente vazio, reset silencioso pra não acumular
      // ruído eterno. Se voltar >0 → label quebrada, escala pra error.
      let labelBroken = false;
      let altThreadCount = 0;
      if (isLabelQuery(gmailQuery)) {
        const altQuery = `${stripLabelFromQuery(gmailQuery)} after:${afterDate}`.trim();
        try {
          const altThreads = await searchThreads(altQuery);
          altThreadCount = altThreads.length;
          labelBroken = altThreadCount > 0;
        } catch (err) {
          // Falha na query alternativa não bloqueia — mantém comportamento
          // anterior (warn padrão). Apenas registra pra audit.
          logDrainWarn(
            `auto-reset alt query falhou: ${(err as Error).message}`,
          );
        }
      }

      if (labelBroken) {
        warnReason = `label_broken: ${altThreadCount} thread(s) na janela após:${afterDate} sem label '${extractLabelName(gmailQuery)}' aplicada. Verifique o filtro do Gmail (docs/gmail-inbox-setup.md).`;
        console.error(`❌ ${warnReason}`);
        logDrainError(new Error(warnReason));
      } else if (isLabelQuery(gmailQuery)) {
        // Genuinamente vazio: reset silencioso, sem warning. Próximo
        // drain re-verifica do zero.
        updatedCursor = resetEmptyDrain(updatedCursor);
        logDrainWarn(
          `auto-reset: inbox genuinamente vazio (alt query também 0 threads). Silenciando warnings até voltar a aparecer e-mail.`,
          { previous_consecutive_empty_drains: cursor.consecutive_empty_drains ?? 0 },
        );
      } else {
        // Query custom sem label: mantém warning padrão (sem como diferenciar).
        warnReason = `inbox vazio em ${updatedCursor.consecutive_empty_drains} drains consecutivos com query custom '${gmailQuery}' — verificar se filtro está correto.`;
        console.error(`⚠️  ${warnReason}`);
        logDrainWarn(warnReason, {
          consecutive_empty_drains: updatedCursor.consecutive_empty_drains,
        });
      }
    }
  }
  saveCursor(updatedCursor);

  const result: DrainResult = {
    new_entries: inboxEntries.length,
    urls: resultUrls,
    topics: resultTopics,
    most_recent_iso: mostRecentIso,
    skipped: false,
    ...(warnReason ? { reason: warnReason } : {}),
  };
  console.log(JSON.stringify(result, null, 2));
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) main().catch((err) => {
  const result: DrainResult = {
    new_entries: 0,
    urls: [],
    topics: [],
    most_recent_iso: null,
    skipped: true,
    reason: "gmail_mcp_error",
  };
  console.error("inbox-drain error:", err.message);
  logDrainError(err);
  // Output de fallback para o orchestrator não quebrar
  console.log(JSON.stringify({ ...result, error: err.message }, null, 2));
  process.exit(0); // exit 0 para não abortar a pipeline
});
