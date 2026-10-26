/**
 * drive-download.ts (#11082) — download de um arquivo do Drive por id, com as
 * proteções que nasceram no `fetch-drive-video.ts` (#10659/#11074):
 *
 *   - streaming em `{dest}.part`, renomeado no fim (nunca um arquivo pela metade
 *     no caminho final);
 *   - teto do download inteiro (`downloadMs`, 20 min) e watchdog de ociosidade
 *     (`idleMs`, 60 s sem bytes → aborta);
 *   - conferência de tamanho contra o `size` do metadado do Drive, e corpo vazio
 *     recusado;
 *   - `content-type` conferido (`isAcceptableDownloadContentType`: `video/mp4`,
 *     ou `application/octet-stream` com nome `.mp4`).
 *
 * Falha nunca deixa `.part` (se não der pra apagar, vai pro `log`).
 *
 * Consumidores: `fetch-drive-video.ts` (horizontal) e `publish-shorts.ts
 * --from-drive` (vertical). Antes do #11082 o `publish-shorts.ts` tinha a
 * própria cópia, que lia o arquivo inteiro na memória sem timeout nem
 * conferência de tamanho.
 */

import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { DRIVE_API } from "./drive-constants.ts";
import { isAcceptableDownloadContentType } from "./diaria/drive-video-source.ts";

export interface DriveDownloadTimeouts {
  /** Metadado (`GET files/{id}`). */
  metadataMs: number;
  /** Teto do download inteiro. */
  downloadMs: number;
  /** Sem nenhum byte por este tempo → aborta o download. */
  idleMs: number;
}

export const DEFAULT_DRIVE_DOWNLOAD_TIMEOUTS: DriveDownloadTimeouts = {
  metadataMs: 30_000,
  downloadMs: 20 * 60_000,
  idleMs: 60_000,
};

export interface DriveDownloadDeps {
  /** GET autenticado na Drive API (em produção, `gFetchRetry`, com refresh do token). */
  driveFetch(url: string, init?: { signal?: AbortSignal }): Promise<Response>;
}

/** O mínimo do metadado do Drive que o download usa. */
export interface DriveDownloadFile {
  id: string;
  name: string;
  /** Tamanho em bytes, como a Drive API devolve (string). Ausente = não confere. */
  size?: string;
}

/**
 * Lê `id,name,size,mimeType` do arquivo (o `publish-shorts.ts --from-drive` só
 * tem o id). 403/404 dizem que a conta OAuth do projeto não enxerga o arquivo.
 */
export async function fetchDriveFileMeta(
  deps: DriveDownloadDeps,
  fileId: string,
  timeoutMs: number = DEFAULT_DRIVE_DOWNLOAD_TIMEOUTS.metadataMs,
): Promise<DriveDownloadFile & { mimeType: string | null }> {
  const params = new URLSearchParams({ fields: "id,name,size,mimeType", supportsAllDrives: "true" });
  const res = await deps.driveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 403 || res.status === 404) {
    throw new Error(`arquivo ${fileId} inacessível pela conta OAuth do projeto (data/.credentials.json): HTTP ${res.status} — compartilhe o arquivo com essa conta ou corrija o id`);
  }
  if (!res.ok) throw new Error(`metadado do arquivo do Drive falhou (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const meta = (await res.json()) as { id?: string; name?: string; size?: string; mimeType?: string };
  return {
    id: meta.id || fileId,
    name: meta.name ?? "",
    ...(meta.size !== undefined ? { size: String(meta.size) } : {}),
    mimeType: meta.mimeType ?? null,
  };
}

/**
 * Baixa `alt=media` em `{dest}.part` (streaming) e renomeia no fim. Devolve os
 * bytes gravados. Lança em falha, sem deixar `.part`.
 */
export async function downloadDriveFile(
  deps: DriveDownloadDeps,
  file: DriveDownloadFile,
  dest: string,
  timeouts: Pick<DriveDownloadTimeouts, "downloadMs" | "idleMs"> = DEFAULT_DRIVE_DOWNLOAD_TIMEOUTS,
  log: (line: string) => void = () => {},
): Promise<number> {
  const idle = new AbortController();
  const signal = AbortSignal.any([AbortSignal.timeout(timeouts.downloadMs), idle.signal]);
  let idleTimer: NodeJS.Timeout | undefined;
  let idleFired = false;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleFired = true;
      idle.abort(new Error(`download ocioso: ${timeouts.idleMs / 1000}s sem receber bytes`));
    }, timeouts.idleMs);
  };
  const tmp = `${dest}.part`;
  try {
    armIdle();
    const res = await deps.driveFetch(
      `${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`,
      { signal },
    );
    if (!res.ok) throw new Error(`download do Drive falhou (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const type = res.headers.get("content-type") ?? "";
    if (!isAcceptableDownloadContentType(type, file.name)) {
      throw new Error(`o arquivo ${file.id} do Drive não é .mp4 (content-type "${type}") — nada gravado`);
    }
    if (!res.body) throw new Error(`download do Drive sem corpo (${file.id}) — nada gravado`);
    mkdirSync(dirname(dest), { recursive: true });
    const watchdog = new Transform({
      transform(chunk, _enc, cb) {
        armIdle();
        cb(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as unknown as NodeWebReadableStream<Uint8Array>),
      watchdog,
      createWriteStream(tmp),
      { signal },
    );
    const bytes = statSync(tmp).size;
    const expected = file.size !== undefined ? Number(file.size) : null;
    if (bytes === 0) throw new Error(`download do Drive veio vazio (${file.id}) — nada gravado`);
    if (expected !== null && Number.isFinite(expected) && expected !== bytes) {
      throw new Error(`download incompleto (${bytes} de ${expected} bytes, ${file.id}) — nada gravado`);
    }
    renameSync(tmp, dest);
    return bytes;
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch (unlinkErr) {
      log(`[aviso] não consegui apagar ${tmp}: ${(unlinkErr as Error).message} — apague à mão antes de rodar de novo`);
    }
    if (idleFired) throw new Error(`download do Drive ocioso por ${timeouts.idleMs / 1000}s (${file.id}) — nada gravado`);
    if (signal.aborted) throw new Error(`download do Drive passou de ${timeouts.downloadMs / 1000}s (${file.id}) — nada gravado`);
    throw e;
  } finally {
    clearTimeout(idleTimer);
  }
}

/**
 * `--from-drive FILE_ID` do `publish-shorts.ts`: metadado (nome/tamanho) e
 * download protegido. Devolve os bytes e o nome do arquivo no Drive.
 */
export async function downloadDriveFileById(
  deps: DriveDownloadDeps,
  fileId: string,
  dest: string,
  timeouts: DriveDownloadTimeouts = DEFAULT_DRIVE_DOWNLOAD_TIMEOUTS,
  log: (line: string) => void = () => {},
): Promise<{ bytes: number; name: string }> {
  const meta = await fetchDriveFileMeta(deps, fileId, timeouts.metadataMs);
  const bytes = await downloadDriveFile(deps, meta, dest, timeouts, log);
  return { bytes, name: meta.name };
}
