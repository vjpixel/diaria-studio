/**
 * sync-read-error.ts (#13740) — leitura que falha no I/O enquanto o Drive
 * sincroniza vira erro acionável, não aviso.
 *
 * Na 261119, com o Drive for desktop baixando um bruto de 9,57 GB numa rede
 * lenta, leituras de JSON em `data/` também travaram e voltaram
 * `UNKNOWN: unknown error, read`. Os leitores fail-soft do roteiro tratavam
 * isso como JSON ilegível: `[aviso]` e exit 0, com a montagem seguindo sem o
 * roteiro. Erro de I/O (código do sistema, não `SyntaxError`) não diz nada
 * sobre o conteúdo do arquivo: aqui ele para o comando dizendo o que fazer.
 */

import { readFileSync } from "node:fs";

/**
 * Códigos de erro de leitura que vêm do disco ou do sync (o arquivo existe;
 * ler falhou), nunca do conteúdo. ENOENT/EACCES/EISDIR ficam fora: dizem outra
 * coisa e cada leitor já trata.
 */
export const SYNC_IO_ERROR_CODES: ReadonlySet<string> = new Set(["UNKNOWN", "EIO", "EBUSY", "ETIMEDOUT", "EAGAIN", "ECANCELED", "EDEADLK"]);

/** O erro é de I/O do disco/sync (não de conteúdo)? */
export function isSyncIoError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && SYNC_IO_ERROR_CODES.has(code);
}

/** Falha de I/O ao ler um arquivo de trabalho: o comando para com a correção (#13740). */
export class SyncReadError extends Error {
  constructor(readonly path: string, readonly code: string, cause: string) {
    super(syncReadErrorMessage(path, code, cause));
    this.name = "SyncReadError";
  }
}

export function syncReadErrorMessage(path: string, code: string, cause: string): string {
  return `não consegui ler ${path} (${code}: ${cause}): o arquivo existe, mas a leitura falhou no disco, típico do Drive for desktop sincronizando (ou travado baixando outro arquivo grande). Espere o sync terminar, ou reinicie o Google Drive for desktop, e rode de novo; nada foi gravado a partir dele (#13740)`;
}

/** Converte o erro de leitura em `SyncReadError` quando é de I/O; os demais voltam como estão. */
export function asSyncReadError(path: string, e: unknown): unknown {
  if (!isSyncIoError(e)) return e;
  return new SyncReadError(path, String((e as { code: string }).code), (e as Error).message);
}

/** `readFileSync(path, "utf8")` que lança `SyncReadError` no erro de I/O do sync. */
export function readTextOrSyncError(path: string, read: (p: string) => string = (p) => readFileSync(p, "utf8")): string {
  try {
    return read(path);
  } catch (e) {
    throw asSyncReadError(path, e);
  }
}
