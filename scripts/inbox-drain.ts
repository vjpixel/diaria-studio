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
 *   inbox.gmailQuery    (default: "label:Diaria.Editor")
 *
 * Cursor: data/inbox-cursor.json  — { last_drain_iso: "2026-04-17T14:22:00Z" | null }
 * Credenciais: data/.credentials.json (gerado por scripts/oauth-setup.ts)
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gFetch } from "./google-auth.ts";
import { parseGmailThread, parseGmailThreadsList } from "./lib/schemas/gmail.ts";
import { logEvent } from "./lib/run-log.ts";

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
  /** #667: número de threads que falharam ao carregar (Zod error, rede, etc.).
   * Ausente ou 0 indica drain sem erros parciais. Positivo = drain parcial —
   * algumas threads foram puladas. Útil pra detectar outage Gmail ou schema
   * change sem sacrificar o drain inteiro. */
  errors?: number;
  /** Primeiras mensagens de erro (max 3, slice 200 chars cada). */
  error_samples?: string[];
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

export interface GmailThread {
  id: string;
  /** Snippet pode estar ausente em threads sem conteúdo visível (#649 review). */
  snippet?: string;
}

async function searchThreads(query: string): Promise<GmailThread[]> {
  const params = new URLSearchParams({ q: query, maxResults: "50" });
  const raw = await gmailRequest<unknown>(`threads?${params}`);
  // #649: validar shape no boundary HTTP — fail-loud em vez de propagar undefined
  const data = parseGmailThreadsList(raw);
  return (data.threads ?? []) as GmailThread[];
}

export interface GmailMessagePart {
  mimeType: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
  headers?: Array<{ name: string; value: string }>;
}

export interface GmailMessage {
  id: string;
  internalDate: string; // epoch ms as string
  payload: GmailMessagePart & { headers: Array<{ name: string; value: string }> };
}

export interface GmailThread2 {
  id: string;
  messages: GmailMessage[];
}

async function getThread(threadId: string): Promise<GmailThread2> {
  const raw = await gmailRequest<unknown>(`threads/${threadId}?format=full`);
  // #649: validar shape no boundary HTTP — garante payload.headers presente,
  // evitando TypeError em getHeader() para mensagens com config não-padrão.
  return parseGmailThread(raw) as unknown as GmailThread2;
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

// #626: URL_REGEX e extractUrls foram movidos pra scripts/lib/url-utils.ts
// pra centralizar lógica e arrumar bug de `)` em URLs Wikipedia balanceadas.
// Re-exports mantidos pra compat retroativa com test/inbox-drain.test.ts.
import { URL_REGEX_RAW, extractUrls } from "./lib/url-utils.ts";
export { URL_REGEX_RAW as URL_REGEX, extractUrls };

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

function getHeader(msg: GmailMessage, name: string): string {
  return msg.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/**
 * Dedup forwards within a thread (#656). Quando o editor encaminha uma
 * newsletter pra inbox editorial, o Gmail agrupa o original + Fwd no mesmo
 * thread. Ingerir os dois duplica os links no pool de submissões. Se o thread
 * tem ao menos uma mensagem com subject não-Fwd: (o original), preferir essas;
 * caso contrário (thread degenerate só com Fwd:), retornar todas.
 */
export function dedupForwards(messages: GmailMessage[]): GmailMessage[] {
  const isForwardSubject = (m: GmailMessage) =>
    /^\s*(Fwd:|Fw:)/i.test(getHeader(m, "Subject"));
  const hasNonForward = messages.some((m) => !isForwardSubject(m));
  return hasNonForward ? messages.filter((m) => !isForwardSubject(m)) : messages;
}

// ---------------------------------------------------------------------------
// Inbox cache
// ---------------------------------------------------------------------------

export function loadCursor(): InboxCursor {
  const cursorPath = resolve(ROOT, "data", "inbox-cursor.json");
  if (!existsSync(cursorPath)) return { last_drain_iso: null };
  try {
    const cursor = JSON.parse(readFileSync(cursorPath, "utf8")) as InboxCursor;
    // #441: cursor no futuro (clock drift, restore de backup, edição manual) trava
    // drain silenciosamente — todos os emails ficam com iso < last_drain_iso.
    // Se detectado: resetar para null com warn.
    if (cursor.last_drain_iso && cursor.last_drain_iso > new Date().toISOString()) {
      console.warn(
        `[inbox-drain] WARN: cursor no futuro (${cursor.last_drain_iso}) — resetando para null. ` +
        `Possível clock drift ou restore de backup. Drain vai buscar e-mails dos últimos 3 dias.`
      );
      return { last_drain_iso: null };
    }
    return cursor;
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

/**
 * Constrói um DrainResult de falha de pesquisa (#665).
 * Exportado para permitir testes unitários sem precisar de credenciais Gmail.
 */
export function buildSearchFailedResult(errorMsg: string): DrainResult {
  return {
    new_entries: 0,
    urls: [],
    topics: [],
    most_recent_iso: null,
    skipped: true,
    reason: "search_failed",
    errors: 1,
    error_samples: [errorMsg.slice(0, 200)],
  };
}

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

/**
 * Resultado da query alternativa (sem `label:`) usada pra distinguir inbox
 * genuinamente vazio de label quebrada (#274). A flag `failed` separa "alt
 * query rodou e voltou 0" (silent reset OK) de "alt query lançou exceção"
 * (não dá pra distinguir, deve cair no warn padrão — #286).
 */
export interface AltQueryResult {
  /** True se a alt query foi tentada (gmailQuery usa `label:`). False = não-aplicável. */
  ran: boolean;
  /** Threads retornadas pela alt query. Só significativo se `ran && !failed`. */
  thread_count: number;
  /** True se a alt query lançou exceção. Distingue "0 threads achadas" (decidiu) de "não dá pra decidir". */
  failed: boolean;
  /** Mensagem de erro da exceção (se failed). Incorporado no warn consolidado (#304). */
  failReason?: string;
}

/**
 * Decisão pura sobre o que fazer quando o drain volta vazio (#274 + #286).
 * Extraída de `main()` pra ser testável sem mockar Gmail. Recebe o cursor
 * pós-incremento, a query original, e o resultado da alt query (já rodada
 * pelo caller). Retorna a ação a tomar.
 *
 * Branches:
 * - **none** — abaixo do threshold, ainda não warna.
 * - **label_broken** — alt query achou threads sem o filtro `label:` →
 *   label não está sendo aplicada pelos novos e-mails. Escala pra error.
 * - **silent_reset** — alt query confirmou 0 threads na janela → inbox
 *   genuinamente vazio. Reset silencioso, sem warn.
 * - **warn** — alt query falhou (não dá pra decidir) OU query custom sem
 *   `label:` (sem como diferenciar). Warn padrão pro editor investigar.
 */
export type EmptyDrainAction =
  | { kind: "none" }
  | { kind: "label_broken"; thread_count: number }
  | { kind: "silent_reset" }
  | { kind: "warn"; reason: string };

export function decideEmptyDrainAction(
  cursor: InboxCursor,
  gmailQuery: string,
  altQuery: AltQueryResult,
): EmptyDrainAction {
  if (!shouldWarnEmptyDrains(cursor)) {
    return { kind: "none" };
  }
  const consecutive = cursor.consecutive_empty_drains ?? 0;
  const labelName = extractLabelName(gmailQuery) || gmailQuery;

  // Alt query rodou com sucesso E achou threads → label quebrada.
  if (altQuery.ran && !altQuery.failed && altQuery.thread_count > 0) {
    return { kind: "label_broken", thread_count: altQuery.thread_count };
  }

  // Alt query rodou com sucesso E achou 0 threads → inbox genuinamente vazio.
  if (altQuery.ran && !altQuery.failed && altQuery.thread_count === 0) {
    return { kind: "silent_reset" };
  }

  // #286 fix: alt query falhou — não dá pra distinguir vazio de label quebrada.
  // Warn consolidado aqui (sem double-log no catch do caller — #304).
  if (altQuery.ran && altQuery.failed) {
    const failDetail = altQuery.failReason ? ` (erro: ${altQuery.failReason})` : "";
    return {
      kind: "warn",
      reason: `inbox vazio em ${consecutive} drains consecutivos; alt query (sem label '${labelName}') falhou${failDetail} — não dá pra distinguir inbox vazio de label quebrada. Verifique acesso ao Gmail (docs/gmail-inbox-setup.md) e tente de novo.`,
    };
  }

  // Query custom sem `label:` → não tem como rodar alt query. Mantém warn padrão.
  return {
    kind: "warn",
    reason: `inbox vazio em ${consecutive} drains consecutivos com query custom '${gmailQuery}' — verificar se filtro está correto.`,
  };
}

/**
 * Resultado da iteração de threads. Acumula entradas markdown, URLs/topics
 * coletados, ISO mais recente, e contagem de erros parciais (#667).
 */
export interface IterateThreadsResult {
  inboxEntries: string[];
  resultUrls: DrainResult["urls"];
  resultTopics: DrainResult["topics"];
  mostRecentIso: string | null;
  threadErrors: number;
  threadErrorSamples: string[];
}

/**
 * Loop de threads → entradas (#669). Extraído de `main()` pra ser testável
 * sem credenciais Gmail. `fetchThread` é injetado pra permitir stubs em test.
 *
 * Cada thread que falha em `fetchThread` é contada em `threadErrors` (#667)
 * e o sample da mensagem (truncado em 200 chars) entra em `threadErrorSamples`
 * (até 3 amostras). Threads bem-sucedidas têm suas mensagens dedup'd e
 * filtradas por `lastDrain` (cursor) antes de virarem entradas markdown.
 */
export async function iterateThreads(
  threads: GmailThread[],
  fetchThread: (id: string) => Promise<GmailThread2>,
  lastDrain: string | null,
): Promise<IterateThreadsResult> {
  const inboxEntries: string[] = [];
  const resultUrls: DrainResult["urls"] = [];
  const resultTopics: DrainResult["topics"] = [];
  let mostRecentIso: string | null = null;
  let threadErrors = 0;
  const threadErrorSamples: string[] = [];

  for (const thread of threads) {
    let fullThread: GmailThread2;
    try {
      fullThread = await fetchThread(thread.id);
    } catch (err) {
      // #649 review: incluindo ZodError quando shape da response sai do esperado
      // (ex: thread só com draft, conta com config não-padrão). Logar e seguir
      // pra não quebrar o drain inteiro por causa de uma thread atípica.
      threadErrors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      if (threadErrorSamples.length < 3) threadErrorSamples.push(msg.slice(0, 200));
      console.error(
        `[inbox-drain] WARN: pulando thread ${thread.id} — ${msg.slice(0, 200)}`,
      );
      continue;
    }

    for (const msg of dedupForwards(fullThread.messages)) {
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

  return { inboxEntries, resultUrls, resultTopics, mostRecentIso, threadErrors, threadErrorSamples };
}

// ---------------------------------------------------------------------------
// Run log — wrappers em volta de scripts/lib/run-log.ts (#612).
// Mantidos como helpers locais pra preservar a API de chamada (logDrainError(err))
// — caller passa só o error, helper preenche stage/agent.
// ---------------------------------------------------------------------------

function logDrainError(err: Error): void {
  logEvent({
    edition: null,
    stage: 1,
    agent: "inbox-drainer",
    level: "error",
    message: err.message,
    details: { stack: err.stack ?? null },
  }, ROOT);
}

function logDrainInfo(message: string, details?: Record<string, unknown>): void {
  logEvent({
    edition: null,
    stage: 1,
    agent: "inbox-drainer",
    level: "info",
    message,
    details: details ?? null,
  }, ROOT);
}

function logDrainWarn(message: string, details?: Record<string, unknown>): void {
  logEvent({
    edition: null,
    stage: 1,
    agent: "inbox-drainer",
    level: "warn",
    message,
    details: details ?? null,
  }, ROOT);
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
  const MARKER = "<!-- entries abaixo -->";
  const markerIdx = current.indexOf(MARKER);

  let newContent: string;
  if (markerIdx === -1) {
    newContent = current + "\n" + entries.join("\n");
  } else {
    const before = current.slice(0, markerIdx + MARKER.length);
    const after = current.slice(markerIdx + MARKER.length);
    newContent = before + "\n" + entries.join("\n") + after;
  }

  // #444: write atômico via tmpfile + rename — evita corrupção em escrita parcial
  // (disco cheio, arquivo locked por editor, antivirus interceptando).
  const tmpPath = inboxPath + ".tmp";
  writeFileSync(tmpPath, newContent, "utf8");
  renameSync(tmpPath, inboxPath);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Ler config
  const configPath = resolve(ROOT, "platform.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as PlatformConfig;
  const inboxEnabled = config.inbox?.enabled !== false;
  const gmailQuery = config.inbox?.gmailQuery ?? "label:Diaria.Editor";

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
    // #442: usar UTC para calcular a data — getDate/getMonth/getFullYear usam
    // timezone local e perdem e-mails em máquinas fora do Brasil (CI, UTC).
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 3);
    afterDate = d.toISOString().slice(0, 10).replace(/-/g, "/");
  } else {
    // #442: cursor já é ISO string — fatiar diretamente sem conversão de timezone.
    afterDate = cursor.last_drain_iso.slice(0, 10).replace(/-/g, "/");
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

  // #665: searchThreads early return — falha de listagem é explicitamente
  // sinalizada como skipped, não tratada como inbox vazio.
  let threads: GmailThread[] = [];
  try {
    threads = await searchThreads(query);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[inbox-drain] WARN: searchThreads falhou (${query}) — ${msg.slice(0, 200)}. Abortando drain.`,
    );
    console.log(JSON.stringify(buildSearchFailedResult(msg), null, 2));
    // saveCursor NÃO é chamado intencionalmente (#668 review #2):
    // drain não ocorreu, cursor deve permanecer inalterado pra próxima
    // tentativa reprocessar os mesmos emails sem perder entradas.
    return;
  }

  const lastDrain = cursor.last_drain_iso;
  const {
    inboxEntries,
    resultUrls,
    resultTopics,
    mostRecentIso,
    threadErrors,
    threadErrorSamples,
  } = await iterateThreads(threads, getThread, lastDrain);

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
    // #274: rodar alt query (sem `label:`) na janela pra distinguir inbox
    // genuinamente vazio de label quebrada. #286: separar failure de "0
    // threads achadas" — failure cai pro warn padrão (não silent reset).
    const altQueryResult: AltQueryResult = {
      ran: false,
      thread_count: 0,
      failed: false,
    };
    if (shouldWarnEmptyDrains(updatedCursor) && isLabelQuery(gmailQuery)) {
      altQueryResult.ran = true;
      const altQueryStr =
        `${stripLabelFromQuery(gmailQuery)} after:${afterDate}`.trim();
      try {
        const altThreads = await searchThreads(altQueryStr);
        altQueryResult.thread_count = altThreads.length;
      } catch (err) {
        altQueryResult.failed = true;
        // Não logar aqui — decideEmptyDrainAction emite o warn consolidado (#304)
        altQueryResult.failReason = (err as Error).message;
      }
    }

    const action = decideEmptyDrainAction(
      updatedCursor,
      gmailQuery,
      altQueryResult,
    );

    switch (action.kind) {
      case "label_broken":
        warnReason = `label_broken: ${action.thread_count} thread(s) na janela após:${afterDate} sem label '${extractLabelName(gmailQuery)}' aplicada. Verifique o filtro do Gmail (docs/gmail-inbox-setup.md).`;
        console.error(`❌ ${warnReason}`);
        logDrainError(new Error(warnReason));
        break;
      case "silent_reset":
        updatedCursor = resetEmptyDrain(updatedCursor);
        logDrainInfo(  // INFO — não é problema, é confirmação que inbox está vazio (#287)
          `auto-reset: inbox genuinamente vazio (alt query também 0 threads). Silenciando warnings até voltar a aparecer e-mail.`,
          {
            previous_consecutive_empty_drains:
              cursor.consecutive_empty_drains ?? 0,
          },
        );
        break;
      case "warn":
        warnReason = action.reason;
        console.error(`⚠️  ${warnReason}`);
        logDrainWarn(warnReason, {
          consecutive_empty_drains: updatedCursor.consecutive_empty_drains,
        });
        break;
      case "none":
        // abaixo do threshold — sem ação
        break;
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
    // #667: expor erros de thread pra visibilidade no orchestrator.
    ...(threadErrors > 0 ? { errors: threadErrors, error_samples: threadErrorSamples } : {}),
  };
  console.log(JSON.stringify(result, null, 2));
}

export { main };

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
