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
 *   inbox.gmailQuery    (default: "in:sent {to:diariaeditor@gmail.com to:diaria.editor@gmail.com}")
 *
 * #3217: a query busca DIRETO na pasta Enviados da própria conta autenticada
 * (vjpixel@gmail.com) por e-mails endereçados a diariaeditor@gmail.com — o
 * editor sempre tem uma cópia do que mandou em Sent, independente de forward
 * ou label configurados do lado de diariaeditor@gmail.com. Substitui o
 * mecanismo anterior (label:Diaria.Editor + fallback to:/in:inbox, #1700),
 * que dependia de um forward diariaeditor@ → vjpixel@ que se mostrou frágil
 * e quebrou silenciosamente (#3199, #3215). Decisão do editor (260710): sem
 * fallback de label — a busca em Sent é o único caminho.
 *
 * #3362: Gmail IGNORA pontos na entrega (diariaeditor@ e diaria.editor@
 * caem na mesma caixa), mas o operador `to:` de busca faz correspondência
 * LITERAL no header — não normaliza pontos. Descoberto que o editor mandava
 * pra ambos os formatos e só um era capturado (>2 meses de submissões pro
 * formato com ponto nunca entraram em data/inbox.md). A query default usa
 * `{ }` (OR do Gmail search) pra cobrir os 2 formatos.
 *
 * Cursor: data/inbox-cursor.json  — { last_drain_iso: "2026-04-17T14:22:00Z" | null }
 * Credenciais: data/.credentials.json (gerado por scripts/oauth-setup.ts)
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
import { isMainModule } from "./lib/cli-args.ts";
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
 * Normaliza o corpo text/plain de uma mensagem pra dedup intra-thread (#1716):
 * colapsa runs de whitespace (incl. CRLF vs LF entre cópia Sent e recebida) e
 * trim. Duas cópias do MESMO email — a cópia em Sent (de vjpixel@) + a cópia
 * recebida quando o editor compõe direto pra diariaeditor@ (sem prefixo Fwd:) —
 * produzem o mesmo normalizado. NÃO faz lowercase: preservar o case evita
 * colapsar mensagens distintas cujo único delta seria caixa (ex: paths de URL
 * case-sensitive).
 */
function normalizeBodyForDedup(msg: GmailMessage): string {
  return extractTextBody(msg.payload).replace(/\s+/g, " ").trim();
}

/**
 * Dedup forwards within a thread (#656 + #1716). Quando o editor traz uma
 * submissão pra inbox editorial, o Gmail pode agrupar múltiplas cópias no mesmo
 * thread. Dois casos:
 *
 * 1. **Encaminhamento (#656)**: original + `Fwd:`/`Fw:` no mesmo thread. Se há
 *    ao menos uma mensagem não-Fwd: (o original), preferir essas; caso contrário
 *    (thread só com Fwd:), retornar todas.
 * 2. **Compose-direto (#1716)**: o editor escreve direto pra diariaeditor@ → o
 *    Gmail agrupa a cópia em Sent + a cópia recebida (forward de volta pra
 *    inbox), AMBAS sem prefixo Fwd:. A dedup por subject (caso 1) não as pegava,
 *    então a mesma URL era ingerida 2×. Colapsamos essas cópias ANTES do filtro
 *    de subject, por DUAS keys complementares:
 *    - **Message-ID** (identidade RFC822): robusta a re-encoding/footer entre
 *      as cópias, quando o auto-forward preserva o header. Nunca colapsa
 *      mensagens distintas (Message-IDs são únicos por mensagem por RFC).
 *    - **Corpo normalizado**: pega o caso em que o auto-forward REGENERA o
 *      Message-ID mas o corpo é idêntico (cenário canônico do #1716).
 *    Colapsa se QUALQUER uma das keys bater. Keys vazias (sem Message-ID, ou
 *    corpo vazio) NÃO dedupam — downstream já pula mensagens sem conteúdo, e
 *    uma key vazia comum colapsaria mensagens legitimamente distintas.
 */
export function dedupForwards(messages: GmailMessage[]): GmailMessage[] {
  // #1716: passo 1 — colapsa cópias do mesmo email (sent + received) por
  // Message-ID OU corpo, preservando a 1ª ocorrência (ordem cronológica do
  // Gmail → Sent).
  const seenIds = new Set<string>();
  const seenBodies = new Set<string>();
  const contentDeduped: GmailMessage[] = [];
  for (const m of messages) {
    const msgId = getHeader(m, "Message-ID").trim();
    const bodyKey = normalizeBodyForDedup(m);
    if (
      (msgId !== "" && seenIds.has(msgId)) ||
      (bodyKey !== "" && seenBodies.has(bodyKey))
    ) {
      continue;
    }
    if (msgId !== "") seenIds.add(msgId);
    if (bodyKey !== "") seenBodies.add(bodyKey);
    contentDeduped.push(m);
  }

  // #656: passo 2 — preferir original sobre Fwd: quando ambos coexistem.
  const isForwardSubject = (m: GmailMessage) =>
    /^\s*(Fwd:|Fw:)/i.test(getHeader(m, "Subject"));
  const hasNonForward = contentDeduped.some((m) => !isForwardSubject(m));
  return hasNonForward
    ? contentDeduped.filter((m) => !isForwardSubject(m))
    : contentDeduped;
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
 * #1973: `true` se o erro de pesquisa é expiração/revogação do OAuth Google
 * (`invalid_grant` etc.) — distinto de um erro transiente de rede. Pure.
 */
export function isAuthExpiredError(errorMsg: string): boolean {
  // Cobre o legado (`invalid_grant`, `Invalid Credentials`) E o 401 moderno do
  // Google (`Request had invalid authentication credentials`, `UNAUTHENTICATED`)
  // — code-review #1973: sem a forma moderna, um token morto que surge como 401
  // UNAUTHENTICATED viraria `search_failed` genérico (false-negative).
  return /invalid_grant|token has been expired or revoked|invalid[_ ]?(authentication )?credentials|unauthenticated|unauthorized|invalid_token/i.test(
    errorMsg,
  );
}

/**
 * #1973: warn LOUD pro caso de OAuth expirado — explicita que SUBMISSÕES DO
 * EDITOR podem ter sido perdidas nesta edição (impacto silencioso do #1973),
 * não um genérico "search failed". Pure (testável).
 */
export function authExpiredWarn(): string {
  return [
    "🔐 [inbox-drain] OAuth Google EXPIRADO (invalid_grant) — inbox NÃO foi drenado.",
    "⚠️  SUBMISSÕES DO EDITOR para o inbox editorial PODEM TER SIDO PERDIDAS nesta edição.",
    "Ação: npx tsx scripts/oauth-setup.ts  e depois  /diaria-inbox  pra recuperar as submissões.",
  ].join("\n");
}

/**
 * Constrói um DrainResult de falha de pesquisa (#665).
 * Exportado para permitir testes unitários sem precisar de credenciais Gmail.
 * #1973: marca `auth_expired` quando o erro é OAuth expirado.
 */
export function buildSearchFailedResult(errorMsg: string): DrainResult & { auth_expired?: boolean } {
  const auth_expired = isAuthExpiredError(errorMsg);
  return {
    new_entries: 0,
    urls: [],
    topics: [],
    most_recent_iso: null,
    skipped: true,
    reason: auth_expired ? "auth_expired" : "search_failed",
    errors: 1,
    error_samples: [errorMsg.slice(0, 200)],
    ...(auth_expired ? { auth_expired: true } : {}),
  };
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
 * Decisão pura sobre o que fazer quando o drain volta vazio.
 *
 * Branches atuais (apenas 2):
 * - **none** — abaixo do threshold, sem ação.
 * - **silent_reset** — acima do threshold, reset silencioso. Inbox vazio é
 *   estado válido (editor pode passar dias sem submissões).
 *
 * Histórico (#274/#286/#304/#900): a versão anterior tinha 4 branches
 * (`none`, `label_broken`, `silent_reset`, `warn`) e rodava uma alt query
 * sem `label:` pra detectar filtro Gmail quebrado. As branches `label_broken`
 * e `warn` foram removidas em #900 — a alt query gerava falso positivo
 * crônico porque vjpixel@ recebe legitimamente outros emails que NÃO precisam
 * passar por diariaeditor@ (newsletters pessoais subscritas direto, GitHub,
 * system mails). Esses sempre vão estar presentes em vjpixel@ sem o label,
 * fazendo a heurística reportar filtro quebrado constantemente. Editor
 * descobre filtro quebrado por outras vias (ausência prolongada de
 * submissões + revisar Gmail UI direto).
 */
export type EmptyDrainAction =
  | { kind: "none" }
  | { kind: "silent_reset" };

export function decideEmptyDrainAction(cursor: InboxCursor): EmptyDrainAction {
  if (!shouldWarnEmptyDrains(cursor)) {
    return { kind: "none" };
  }
  return { kind: "silent_reset" };
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
//
// #3311: `rootDir` default ROOT (script location, cwd-independente — mesmo
// comportamento de antes). main() sempre repassa o `rootDir` que recebeu
// (default ROOT em produção), permitindo que testes que chamam `main()`
// diretamente in-process (test/inbox-drain.test.ts) isolem o destino do
// log de auditoria sem tocar em data/run-log.jsonl REAL do worktree.
// ---------------------------------------------------------------------------

function logDrainError(err: Error, rootDir: string = ROOT): void {
  logEvent({
    edition: null,
    stage: 1,
    agent: "inbox-drainer",
    level: "error",
    message: err.message,
    details: { stack: err.stack ?? null },
  }, rootDir);
}

function logDrainInfo(message: string, details?: Record<string, unknown>, rootDir: string = ROOT): void {
  logEvent({
    edition: null,
    stage: 1,
    agent: "inbox-drainer",
    level: "info",
    message,
    details: details ?? null,
  }, rootDir);
}

function logDrainWarn(message: string, details?: Record<string, unknown>, rootDir: string = ROOT): void {
  logEvent({
    edition: null,
    stage: 1,
    agent: "inbox-drainer",
    level: "warn",
    message,
    details: details ?? null,
  }, rootDir);
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

// #3311: `rootDir` opcional — repassado a logDrainWarn/logDrainInfo abaixo.
// Default ROOT (produção, cwd-independente, comportamento inalterado).
// Testes que chamam main() diretamente in-process (test/inbox-drain.test.ts)
// passam um tmpdir isolado pra não gravar entries fabricadas em
// data/run-log.jsonl REAL do worktree.
async function main(rootDir: string = ROOT): Promise<void> {
  // Ler config
  const configPath = resolve(ROOT, "platform.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as PlatformConfig;
  const inboxEnabled = config.inbox?.enabled !== false;
  // #3217: default troca de label:Diaria.Editor (dependia de forward+filtro
  // frágil em diariaeditor@gmail.com) pra busca direta em Sent na própria
  // conta autenticada — o editor sempre tem uma cópia do que mandou lá.
  // #3362: `{ }` = OR no Gmail search — cobre os 2 formatos (com/sem ponto),
  // já que `to:` não normaliza pontos como a entrega normaliza (ver docstring).
  const gmailQuery = config.inbox?.gmailQuery ?? "in:sent {to:diariaeditor@gmail.com to:diaria.editor@gmail.com}";

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

  // #3217: busca única, direto em Sent — sem label, sem forward, sem query de
  // fallback. searchThreads early return: falha de listagem é explicitamente
  // sinalizada como skipped, não tratada como inbox vazio. Cursor NÃO avança
  // (#668) pra reprocessar na próxima tentativa.
  let threads: GmailThread[] = [];
  try {
    threads = await searchThreads(query);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // #1973: OAuth expirado é distinto de falha transiente — warn LOUD sobre
    // submissões perdidas (impacto silencioso), não um genérico "search failed".
    if (isAuthExpiredError(msg)) {
      console.error("\n" + authExpiredWarn() + "\n");
      logDrainWarn(`auth_expired: ${msg.slice(0, 200)}`, undefined, rootDir);
    } else {
      console.error(
        `[inbox-drain] WARN: searchThreads falhou (${query}) — ${msg.slice(0, 200)}. Abortando drain.`,
      );
    }
    console.log(JSON.stringify(buildSearchFailedResult(msg), null, 2));
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
    // #900: removida alt query / heurística label_broken. Inbox vazio é estado
    // válido — editor pode passar dias sem submissões. Filtro quebrado é
    // detectado por outras vias (Gmail UI, ausência prolongada).
    const action = decideEmptyDrainAction(updatedCursor);

    switch (action.kind) {
      case "silent_reset":
        updatedCursor = resetEmptyDrain(updatedCursor);
        logDrainInfo(
          `auto-reset: inbox vazio em ${cursor.consecutive_empty_drains ?? 0} drains consecutivos. Estado válido — editor pode estar sem submissões.`,
          {
            previous_consecutive_empty_drains:
              cursor.consecutive_empty_drains ?? 0,
          },
          rootDir,
        );
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

const isMain = isMainModule(import.meta.url);

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
