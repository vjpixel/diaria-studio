/**
 * scripts/lib/diaria/video-gpu-lock.ts (#13741) — um subcomando do
 * `video-montagem.ts` por vez na GPU da máquina.
 *
 * Na montagem da 261119 (Neo), `preview`, `review` e `gaze` rodados ao mesmo
 * tempo travaram os três: o ffmpeg com decode/encode na GPU (`-hwaccel cuda`,
 * `h264_nvenc`, #13507/#13508) e o faster-whisper em CUDA disputam a mesma
 * placa, e foi preciso matar os processos por PID. Agora o subcomando que usa
 * a GPU pega um lock de arquivo da máquina antes de começar; o segundo espera,
 * com `[aviso]` dizendo quem segura e desde quando, e segue sozinho quando o
 * primeiro termina.
 *
 * - O lock é da MÁQUINA (a GPU é uma só), não da edição: duas edições na mesma
 *   máquina também esperam uma pela outra.
 * - Dono morto (Ctrl-C, processo derrubado) não trava ninguém: o `.lock` grava
 *   `{pid, host, ts, token}` como o `file-lock.ts` e o órfão é removido pela
 *   mesma regra (`tryStealOrphan`, #9185).
 * - Fica de fora quem não toca a GPU (`GPU_FREE_COMMANDS`): `blocks`,
 *   `fact-check-merge`, `fact-check-input` e `upload` leem e gravam JSON ou
 *   sobem arquivo; e, com a flag que desliga o Whisper, `decupagem`, `roteiro`
 *   e `verify-xml` (`GPU_FREE_WITH_FLAG`, #13806).
 * - O lock cobre só o trecho com GPU (#13806): quem baixa do Drive pega o lock
 *   depois do download (`GPU_AFTER_DOWNLOAD_COMMANDS`, `gpuLockAfterDownload`)
 *   e todos soltam antes do upload das saídas (`releaseGpuLockEarly`).
 * - `DIARIA_VIDEO_GPU_LOCK=0` desliga (escape para quem sabe que a máquina
 *   aguenta, ou para depurar); a espera tem teto (`GPU_LOCK.maxWaitS`) e, nele,
 *   o subcomando falha com a mensagem de quem segura, em vez de esperar para
 *   sempre num agente em segundo plano.
 *
 * O acquire é assíncrono (o `acquireLock` genérico dorme com `Atomics.wait` e
 * tem teto de 10 s, pensado para seção crítica curta; aqui a espera é de
 * minutos). Puro nas dependências: relógio, sono, `open(wx)` e saída entram
 * por parâmetro para o teste.
 */

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockHostId, tryStealOrphan } from "../file-lock.ts";

/** Subcomandos que não usam a GPU: rodam sem esperar pelo lock. `fact-check-input` só lê e grava JSON (#13806). */
export const GPU_FREE_COMMANDS: readonly string[] = ["blocks", "fact-check-merge", "upload", "fact-check-input"];

/**
 * #13806: subcomandos que só tocam a GPU num passo que a flag desliga (o
 * Whisper da retranscrição ou da conferência). Com a flag, rodam sem o lock;
 * sem ela seguem pegando, porque o passo roda por padrão.
 */
export const GPU_FREE_WITH_FLAG: Readonly<Record<string, string>> = {
  decupagem: "no-retranscribe",
  roteiro: "no-short-word-check",
  "verify-xml": "no-transcribe",
};

/**
 * #13806: subcomandos que, no modo API, baixam o bruto (ou o export) do Drive
 * antes de usar a GPU. Para eles o lock só é pego em `gpuLockAfterDownload`,
 * chamado depois do download: com Drive lento (0,3 MB/s no Neo, bruto de
 * 9,57 GB na 261119) o download segurava o lock por horas com a GPU parada.
 * O `runCommand` do `video-montagem.ts` chama o gate em cada um (guard de
 * fiação no teste); sem download (modo local), o gate pega o lock na hora.
 */
export const GPU_AFTER_DOWNLOAD_COMMANDS: readonly string[] = ["transcribe", "preview", "review-final", "build", "srt", "face", "face-compare", "gaze", "frame"];

/** `pollS`: intervalo entre tentativas; `noticeEveryS`: de quanto em quanto tempo o `[aviso]` de espera se repete; `maxWaitS`: teto da espera (3 h). */
export const GPU_LOCK = { pollS: 2, noticeEveryS: 300, maxWaitS: 3 * 3600 } as const;

/** O arquivo do lock da máquina (no diretório temporário do sistema, fora de qualquer edição). */
export function defaultGpuLockPath(dir: string = tmpdir()): string {
  return join(dir, "diaria-video-montagem-gpu.lock");
}

/** O subcomando precisa do lock da GPU? `DIARIA_VIDEO_GPU_LOCK=0` desliga para todos; `flags` = as da linha de comando (`GPU_FREE_WITH_FLAG`). */
export function needsGpuLock(cmd: string | undefined, env: Readonly<Record<string, string | undefined>> = process.env, flags: ReadonlySet<string> = new Set()): boolean {
  if (!cmd) return false;
  if ((env.DIARIA_VIDEO_GPU_LOCK ?? "").trim() === "0") return false;
  if (GPU_FREE_COMMANDS.includes(cmd)) return false;
  const off = Object.hasOwn(GPU_FREE_WITH_FLAG, cmd) ? GPU_FREE_WITH_FLAG[cmd] : undefined;
  return !(off && flags.has(off));
}

export interface GpuLockHolder {
  pid?: number;
  cmd?: string;
  edition?: string;
  ts?: number;
}

/** Quem segura o lock, lido do arquivo (conteúdo ilegível = `{}`). */
export function readGpuLockHolder(raw: string): GpuLockHolder {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return {
      ...(Number.isInteger(o.pid) ? { pid: o.pid as number } : {}),
      ...(typeof o.cmd === "string" ? { cmd: o.cmd } : {}),
      ...(typeof o.edition === "string" ? { edition: o.edition } : {}),
      ...(typeof o.ts === "number" ? { ts: o.ts } : {}),
    };
  } catch {
    return {};
  }
}

/** "preview 261119 (pid 1234, desde 21:03:10)", ou "outro processo" sem dado legível. */
export function describeGpuHolder(h: GpuLockHolder): string {
  const what = [h.cmd, h.edition].filter(Boolean).join(" ") || "outro subcomando";
  const extra = [h.pid !== undefined ? `pid ${h.pid}` : null, h.ts !== undefined ? `desde ${new Date(h.ts).toISOString().slice(11, 19)} UTC` : null].filter(Boolean).join(", ");
  return extra ? `${what} (${extra})` : what;
}

export interface GpuLockDeps {
  path?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** `open(path, "wx")`; lança `EEXIST` quando o lock existe. */
  openWx?: (path: string) => number;
  readHolder?: (path: string) => GpuLockHolder;
  stealOrphan?: (path: string) => boolean;
  log?: (line: string) => void;
  pollS?: number;
  noticeEveryS?: number;
  maxWaitS?: number;
}

/** O lock pego: `release()` apaga o arquivo só se ainda for o nosso (token). */
export interface GpuLockHandle {
  path: string;
  waitedS: number;
  release(): void;
}

function defaultReadHolder(path: string): GpuLockHolder {
  try {
    return readGpuLockHolder(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Pega o lock da GPU para `cmd`/`edition`. Livre: pega na hora, sem log.
 * Ocupado: `[aviso]` com quem segura, tenta de novo a cada `pollS` e repete o
 * aviso a cada `noticeEveryS`; dono morto é removido (`tryStealOrphan`). No
 * teto `maxWaitS`, lança. Erro de disco que não é `EEXIST` propaga na hora
 * (#6952: nunca girar até o teto escondendo a causa).
 */
export async function acquireGpuLock(cmd: string, edition: string, deps: GpuLockDeps = {}): Promise<GpuLockHandle> {
  const path = deps.path ?? defaultGpuLockPath();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const openWx = deps.openWx ?? ((p: string) => openSync(p, "wx"));
  const readHolder = deps.readHolder ?? defaultReadHolder;
  const steal = deps.stealOrphan ?? ((p: string) => tryStealOrphan(p));
  const log = deps.log ?? ((l: string) => console.error(l));
  const pollS = deps.pollS ?? GPU_LOCK.pollS;
  const noticeEveryS = deps.noticeEveryS ?? GPU_LOCK.noticeEveryS;
  const maxWaitS = deps.maxWaitS ?? GPU_LOCK.maxWaitS;
  const t0 = now();
  let lastNotice: number | null = null;
  const token = randomBytes(8).toString("hex");
  for (;;) {
    let fd: number | null = null;
    try {
      fd = openWx(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
    }
    if (fd !== null) {
      let written = false;
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, host: lockHostId(), ts: now(), token, cmd, edition }));
        written = true;
      } finally {
        closeSync(fd);
        if (!written) {
          try { unlinkSync(path); } catch { /* ignore */ }
        }
      }
      const waitedS = (now() - t0) / 1000;
      if (lastNotice !== null) log(`[video-montagem] GPU livre depois de ${Math.round(waitedS)} s: ${cmd} segue (#13741)`);
      return {
        path,
        waitedS,
        release: () => {
          try {
            const cur = JSON.parse(readFileSync(path, "utf8")) as { token?: string };
            if (cur.token === token) unlinkSync(path);
          } catch { /* já sumiu ou ilegível: nada a soltar */ }
        },
      };
    }
    if (steal(path)) continue;
    const waitedS = (now() - t0) / 1000;
    const holder = describeGpuHolder(readHolder(path));
    if (waitedS >= maxWaitS) {
      throw new Error(`GPU ocupada por ${holder} há ${Math.round(waitedS)} s (teto de ${maxWaitS} s): rode ${cmd} depois que ele terminar, ou DIARIA_VIDEO_GPU_LOCK=0 se a máquina aguenta os dois juntos (lock em ${path}, #13741)`);
    }
    if (lastNotice === null || now() - lastNotice >= noticeEveryS * 1000) {
      log(`[aviso] GPU ocupada por ${holder}: ${cmd} ${edition} espera ele terminar (subcomandos que usam a GPU rodam um por vez nesta máquina; lock em ${path}, #13741)`);
      lastNotice = now();
    }
    await sleep(pollS * 1000);
  }
}

/** O lock do subcomando em curso (`withGpuLock`): o acquire adiado (#13806) e o release. */
interface ActiveGpuLock {
  acquire: (() => Promise<void>) | null;
  release: () => void;
}
let active: ActiveGpuLock | null = null;

/**
 * #13806: pega o lock adiado do subcomando em `GPU_AFTER_DOWNLOAD_COMMANDS`,
 * depois do download do Drive e antes do 1º uso da GPU. Idempotente; no-op
 * fora do `withGpuLock` (os testes chamam `main` direto), em subcomando que já
 * pegou o lock no começo e em subcomando fora do lock.
 */
export async function gpuLockAfterDownload(): Promise<void> {
  const cur = active;
  const go = cur?.acquire;
  if (!cur || !go) return;
  cur.acquire = null;
  await go();
}

/** #13806: solta o lock antes do upload das saídas para o Drive (o upload não usa a GPU). Idempotente. */
export function releaseGpuLockEarly(): void {
  active?.release();
}

/**
 * Roda `fn` com o lock da GPU quando `cmd` precisa dele (`needsGpuLock`),
 * soltando no fim (também no erro). Em `GPU_AFTER_DOWNLOAD_COMMANDS` o lock
 * só é pego quando `fn` chama `gpuLockAfterDownload` (#13806).
 */
export async function withGpuLock<T>(
  cmd: string | undefined,
  edition: string | undefined,
  fn: () => Promise<T>,
  deps: GpuLockDeps & { env?: Readonly<Record<string, string | undefined>>; flags?: ReadonlySet<string> } = {},
): Promise<T> {
  if (!cmd || !needsGpuLock(cmd, deps.env ?? process.env, deps.flags)) return fn();
  const held: { lock?: GpuLockHandle; released?: boolean } = {};
  const release = () => {
    if (!held.lock || held.released) return;
    held.released = true;
    held.lock.release();
  };
  const acquire = async () => {
    if (held.lock || held.released) return;
    held.lock = await acquireGpuLock(cmd, edition ?? "", deps);
  };
  const prev = active;
  const mine: ActiveGpuLock = { acquire: GPU_AFTER_DOWNLOAD_COMMANDS.includes(cmd) ? acquire : null, release };
  if (!mine.acquire) await acquire();
  active = mine;
  try {
    return await fn();
  } finally {
    release();
    active = prev;
  }
}
