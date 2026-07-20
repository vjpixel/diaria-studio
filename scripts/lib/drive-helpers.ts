/**
 * drive-helpers.ts — helpers compartilhados da Google Drive API v3.
 *
 * Usado por `drive-sync.ts` (#1308 itens 2, 4) — evita reimplementar
 * gFetchRetry + helpers de listagem + builder de multipart body.
 *
 * Histórico: `drive-sync.ts` tinha versões privadas com retry exponencial pra
 * erros transientes (429/5xx); a extração aqui deu retry resiliente. Também
 * era compartilhado por `sync-report.ts`/`upload-report-to-drive.ts`
 * (removidos em #3713 — mecanismo de relatórios no Drive descontinuado).
 */

import { gFetch } from "../google-auth.ts";
import { DRIVE_API } from "./drive-constants.ts";

// ---------------------------------------------------------------------------
// Retry com backoff exponencial — Drive API sob carga rejeita com 429/5xx.
// gFetch base trata 401 (refresh token). Aqui adicionamos retry pra transients
// que de outra forma bagunçam o sync (#121).
// ---------------------------------------------------------------------------

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const DEFAULT_MAX_RETRIES = 3;

/** Pure: decide se um status code merece retry. Exportado pra tests. */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/** Pure: backoff em ms baseado na tentativa (0-indexed). 1s, 2s, 4s + jitter. */
export function backoffMs(attempt: number, randomSource: () => number = Math.random): number {
  const base = 1000 * Math.pow(2, attempt);
  const jitter = randomSource() * 250;
  return base + jitter;
}

export async function gFetchRetry(
  url: string,
  options: RequestInit = {},
  attempts = DEFAULT_MAX_RETRIES,
): Promise<Response> {
  let lastError: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await gFetch(url, options);
      if (!isRetryableStatus(res.status)) return res;
      lastError = new Error(`Drive transient ${res.status}: ${await res.text().catch(() => "(body unread)")}`);
    } catch (err) {
      // Network failures: ECONNRESET, ETIMEDOUT, etc.
      lastError = err;
    }
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, backoffMs(i)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ---------------------------------------------------------------------------
// Drive query escaping + helpers de listagem
// ---------------------------------------------------------------------------

/**
 * Escapa aspas simples + backslashes em nomes pra uso em queries Drive API (#282).
 * Drive usa SQL-like syntax: `\` vira `\\` primeiro, depois `'` vira `\'`.
 */
export function escapeDriveQueryString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export interface DriveFileEntry {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  parents?: string[];
}

const DEFAULT_LIST_FIELDS = "files(id,name,mimeType,modifiedTime,parents)";

/** Lista arquivos do Drive com query SQL-like. Usa gFetchRetry. */
export async function driveList(
  q: string,
  fields = DEFAULT_LIST_FIELDS,
  pageSize = 20,
): Promise<DriveFileEntry[]> {
  const params = new URLSearchParams({ q, fields, pageSize: String(pageSize) });
  const res = await gFetchRetry(`${DRIVE_API}/files?${params}`);
  if (!res.ok) throw new Error(`Drive list error (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { files?: DriveFileEntry[] };
  return data.files ?? [];
}

/** Acha pasta por nome no root do My Drive (ancorado em 'root', não Shared Drives). */
export async function driveFindFolderInRoot(name: string): Promise<string | null> {
  const safe = escapeDriveQueryString(name);
  const files = await driveList(
    `name = '${safe}' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false`
  );
  return files[0]?.id ?? null;
}

/** Acha pasta por nome dentro de um parent específico. */
export async function driveFindFolderInParent(name: string, parentId: string): Promise<string | null> {
  const safe = escapeDriveQueryString(name);
  const files = await driveList(
    `name = '${safe}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`
  );
  return files[0]?.id ?? null;
}

/**
 * Acha pasta por nome dentro de um parent, tentando múltiplos nomes em
 * ordem — o primeiro que existir vence (#3573: tolerância a rename/rollback
 * de pastas do Drive, ex: nome atual primeiro, nomes legados como fallback).
 * Retorna `null` só se NENHUM dos nomes existir.
 */
export async function driveFindFolderByNames(
  names: string[],
  parentId: string
): Promise<{ id: string; matchedName: string } | null> {
  for (const name of names) {
    const id = await driveFindFolderInParent(name, parentId);
    if (id) return { id, matchedName: name };
  }
  return null;
}

/** Cria pasta vazia em parent. Retorna ID da pasta criada. */
export async function driveCreateFolder(name: string, parentId: string): Promise<string> {
  const res = await gFetchRetry(`${DRIVE_API}/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  if (!res.ok) throw new Error(`Drive createFolder error (${res.status}): ${await res.text()}`);
  const data = (await res.json()) as { id: string };
  return data.id;
}

// ---------------------------------------------------------------------------
// Multipart body builder (#1308 item 4)
// ---------------------------------------------------------------------------

let _boundaryCounter = 0;

export interface MultipartArgs {
  /** Metadata JSON parte do multipart (1ª parte). */
  metadata: Record<string, unknown>;
  /** Content-Type da 2ª parte (ex: "text/markdown; charset=UTF-8", "image/jpeg"). */
  contentType: string;
  /** Body da 2ª parte. String é encoded como utf8; Buffer é incluído raw (binary-safe). */
  content: string | Buffer;
}

export interface MultipartResult {
  /**
   * Body completo pronto pra mandar como `body:` no fetch.
   * Typed como `BodyInit` (não `Buffer`/`Uint8Array`) porque o tipo genérico
   * `Buffer<ArrayBufferLike>` retornado por `Buffer.concat` não é
   * estruturalmente assignável a `BodyInit` quando atravessa boundary de
   * função (apesar de ser compatível em runtime). Cast feito no produtor.
   */
  body: BodyInit;
  /** Valor do header Content-Type. Inclui o boundary. */
  contentType: string;
}

/**
 * Builda um multipart/related body pra Drive API upload (POST) ou update (PATCH).
 *
 * Layout (per Drive multipart upload spec):
 *   --boundary
 *   Content-Type: application/json; charset=UTF-8
 *
 *   {metadata-json}
 *   --boundary
 *   Content-Type: {contentType}
 *
 *   {content}
 *   --boundary--
 */
export function buildMultipartBody(args: MultipartArgs): MultipartResult {
  const boundary = `diaria_mp_${Date.now()}_${++_boundaryCounter}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify(args.metadata) + `\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${args.contentType}\r\n\r\n`,
    "utf8",
  );
  const contentBuf = Buffer.isBuffer(args.content)
    ? args.content
    : Buffer.from(args.content, "utf8");
  const tail = Buffer.from(`\r\n--${boundary}--`, "utf8");
  const body = Buffer.concat([head, contentBuf, tail]);
  // Buffer.concat retorna Buffer<ArrayBufferLike> que não satisfaz BodyInit
  // estruturalmente em TS strict, mas é compatível em runtime (fetch aceita
  // Uint8Array). Cast intencional.
  return { body: body as unknown as BodyInit, contentType: `multipart/related; boundary=${boundary}` };
}
