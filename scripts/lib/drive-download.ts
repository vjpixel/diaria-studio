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
 * Falha nunca deixa `.part` (se não der pra apagar, vai pro `log`). O `.part`
 * é exclusivo (O_EXCL, #11432): um 2º download do mesmo arquivo em paralelo
 * recusa em vez de truncar o do 1º.
 *
 * Consumidores: `fetch-drive-video.ts` (horizontal) e `publish-shorts.ts
 * --from-drive` (vertical). Antes do #11082 o `publish-shorts.ts` tinha a
 * própria cópia, que lia o arquivo inteiro na memória sem timeout nem
 * conferência de tamanho.
 */

import { closeSync, createWriteStream, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
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

/** `.part` sem escrita há mais que isto é resto de um processo morto (#11432). */
export const PART_STALE_MIN_MS = 5 * 60_000;

/** Outro processo está baixando o mesmo arquivo (`{dest}.part` fresco, #11432). */
export class DriveDownloadInProgressError extends Error {
  constructor(public readonly partPath: string) {
    super(`outro processo está baixando este arquivo agora (${partPath} recente) — nada gravado; tente de novo depois`);
    this.name = "DriveDownloadInProgressError";
  }
}

/**
 * Tira do caminho um `.part` velho sem apagar o de outro processo (#11450,
 * follow-up do #11432). `stat → rm → open wx` não é atômico: dois processos
 * que leem o mesmo `.part` velho podiam fazer o 2º `rm` apagar o `.part` NOVO
 * que o 1º acabou de criar. Aqui o velho é renomeado para um nome único antes
 * de sair; se o inode renomeado não é o que o `stat` viu, o arquivo é de
 * outro processo: volta para o lugar e o download recusa
 * (`DriveDownloadInProgressError`).
 */
export function takeStalePart(tmp: string, staleIno: number): void {
  const aside = `${tmp}.stale-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    renameSync(tmp, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // outro já tirou
    throw e;
  }
  let movedIno: number | null = null;
  try {
    movedIno = statSync(aside).ino;
  } catch {
    movedIno = null;
  }
  if (movedIno !== staleIno) {
    // Pegamos o `.part` recém-criado por outro download: devolve sem sobrescrever.
    try {
      if (!existsSync(tmp)) renameSync(aside, tmp);
    } catch {
      // o outro processo segue com o fd dele; só o nome se perdeu
    }
    throw new DriveDownloadInProgressError(tmp);
  }
  rmSync(aside, { force: true });
}

/**
 * Cria `tmp` com O_EXCL e devolve o fd. `.part` já existente e escrito há menos
 * de `staleMs` é de um download vivo → `DriveDownloadInProgressError` (nunca
 * trunca nem apaga o arquivo do outro). Mais velho que isso → apaga e tenta
 * de novo uma vez (um download vivo escreve pelo menos a cada `idleMs`, senão
 * o watchdog dele aborta).
 */
export function claimPartFile(tmp: string, staleMs: number, now: number = Date.now()): number {
  const tryOpen = (): number | null => {
    try {
      return openSync(tmp, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw e;
    }
  };
  const fd = tryOpen();
  if (fd !== null) return fd;
  let age = 0;
  let staleIno: number | null = null;
  try {
    const st = statSync(tmp);
    age = now - st.mtimeMs;
    staleIno = st.ino;
  } catch {
    age = Infinity; // sumiu entre o open e o stat: o outro terminou ou desistiu
  }
  if (age <= staleMs) throw new DriveDownloadInProgressError(tmp);
  if (staleIno !== null) takeStalePart(tmp, staleIno);
  const retry = tryOpen();
  if (retry === null) throw new DriveDownloadInProgressError(tmp);
  return retry;
}

/**
 * Baixa `alt=media` em `{dest}.part` (streaming) e renomeia no fim. Devolve os
 * bytes gravados. `acceptsContentType` permite ao fetch de capas validar imagens
 * (#11542); por padrão continua restrito a MP4. Lança em falha, sem deixar `.part`. O `.part` é criado com
 * O_EXCL (#11432): se outro processo está baixando o mesmo arquivo, lança
 * `DriveDownloadInProgressError` sem tocar no `.part` dele.
 */
export async function downloadDriveFile(
  deps: DriveDownloadDeps,
  file: DriveDownloadFile,
  dest: string,
  timeouts: Pick<DriveDownloadTimeouts, "downloadMs" | "idleMs"> = DEFAULT_DRIVE_DOWNLOAD_TIMEOUTS,
  log: (line: string) => void = () => {},
  acceptsContentType = isAcceptableDownloadContentType,
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
  // #11432: o `.part` é do processo que o criou. Sem o O_EXCL, um 2º download do
  // mesmo arquivo (timers do LinkedIn e do Threads no mesmo vertical) truncava o
  // `.part` do 1º, que seguia escrevendo no próprio offset e renomeava um
  // arquivo com o começo zerado e o tamanho certo.
  mkdirSync(dirname(dest), { recursive: true });
  const fd = claimPartFile(tmp, Math.max(2 * timeouts.idleMs, PART_STALE_MIN_MS));
  let fdHandedOff = false;
  try {
    armIdle();
    const res = await deps.driveFetch(
      `${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`,
      { signal },
    );
    if (!res.ok) throw new Error(`download do Drive falhou (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const type = res.headers.get("content-type") ?? "";
    if (!acceptsContentType(type, file.name)) {
      throw new Error(`o arquivo ${file.id} do Drive ${acceptsContentType === isAcceptableDownloadContentType ? "não é .mp4" : "tem formato inesperado"} (content-type "${type}") — nada gravado`);
    }
    if (!res.body) throw new Error(`download do Drive sem corpo (${file.id}) — nada gravado`);
    const watchdog = new Transform({
      transform(chunk, _enc, cb) {
        armIdle();
        cb(null, chunk);
      },
    });
    // O stream assume o fd (autoClose): daqui em diante quem fecha é ele.
    const out = createWriteStream(tmp, { fd });
    fdHandedOff = true;
    await pipeline(
      Readable.fromWeb(res.body as unknown as NodeWebReadableStream<Uint8Array>),
      watchdog,
      out,
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
    if (!fdHandedOff) {
      try {
        closeSync(fd);
      } catch {
        // já fechado
      }
    }
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
