/**
 * atomic-write.ts (#1132 P2.3)
 *
 * Helper pra writes atômicos de outputs críticos do pipeline. Padrão:
 *   1. Escreve em temp file (`{target}.tmp-{rand}`)
 *   2. fsync pra garantir flush no disco
 *   3. rename atômico pra `{target}` (atômico em POSIX + NTFS)
 *
 * Razão: kill mid-write (Ctrl-C, crash, OOM) deixa output parcial que
 * confunde resume detector + downstream parsers. Atomic write garante que
 * `target` é ou (a) versão anterior ou (b) versão completa nova — nunca
 * partial.
 *
 * Trade-offs:
 * - Custo: ~2× syscalls vs `writeFileSync` direto. Insignificante pros
 *   outputs do pipeline (~KB-MB cada, baixa frequência).
 * - Não cobre directório (não cria dirs faltantes). Caller garante parent.
 *
 * Aplicado em outputs críticos: `01-categorized.json/.md`, `01-approved.json`,
 * `02-reviewed.md`, `03-social.md`, `05-published.json`, `06-social-published.json`,
 * `06-public-images.json`.
 */

import {
  writeFileSync,
  closeSync,
  openSync,
  fsyncSync,
  renameSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Gera um suffix tmp único — combina pid + epoch + random pra evitar colisão
 * entre processos concorrentes (raros mas possíveis em test runs paralelos).
 */
function tmpSuffix(): string {
  return `tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface AtomicWriteOptions {
  /** Encoding (default "utf8"). Pra binário, passar string mais explícita ou usar Buffer. */
  encoding?: BufferEncoding;
  /**
   * Se `true` (default), executa fsync no temp antes do rename. Garante
   * que bytes estão no disco antes do swap atômico. Pode desabilitar pra
   * outputs onde performance importa mais que durability (raro).
   */
  fsync?: boolean;
}

/**
 * Escreve `content` em `targetPath` atomicamente.
 *
 * Implementação: `writeFileSync(tmpPath, content)` → `fsync(fd)` → `rename(tmpPath, targetPath)`.
 * Se qualquer passo falhar, tenta limpar `tmpPath` antes de re-lançar.
 *
 * @param targetPath caminho final do arquivo (absoluto recomendado)
 * @param content conteúdo a escrever (string ou Buffer)
 * @param opts encoding + fsync flag
 * @throws Error propagado de qualquer syscall que falhar; tmp file é cleanupped
 */
export function writeFileAtomic(
  targetPath: string,
  content: string | Buffer,
  opts: AtomicWriteOptions = {},
): void {
  const encoding = opts.encoding ?? "utf8";
  const wantFsync = opts.fsync ?? true;

  const absTarget = resolve(targetPath);
  const dir = dirname(absTarget);
  const tmpPath = resolve(dir, `.${absTarget.split(/[\\/]/).pop()}.${tmpSuffix()}`);

  try {
    if (typeof content === "string") {
      writeFileSync(tmpPath, content, { encoding });
    } else {
      writeFileSync(tmpPath, content);
    }

    if (wantFsync) {
      // Open com 'r+' (read-write) pra suportar fsync em Windows.
      // 'r' readonly retorna EPERM em fsync no NTFS.
      const fd = openSync(tmpPath, "r+");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }

    // #1269: retry rename em EPERM (Windows + OneDrive race). OneDrive sync
    // segura o target file por ~100-500ms durante operações de sync; rename
    // atômico falha com EPERM nesse window. 3 tentativas com exponential
    // backoff (100/500/2000ms) cobrem a maioria dos casos sem afetar perf
    // no caminho feliz (1ª tentativa quase sempre passa).
    renameWithRetry(tmpPath, absTarget);
  } catch (err) {
    // Cleanup temp file em caso de falha
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Não-bloqueante — tmp lixo é menos pior que crash
      }
    }
    throw err;
  }
}

/**
 * Rename com retry em EPERM (#1269). Outros erros propagam imediato — só
 * EPERM/EBUSY/EACCES têm evidência empírica de serem transientes
 * (OneDrive sync race).
 *
 * `renameFn` é injetável pra testabilidade — default é `renameSync` de
 * node:fs. Tests passam mocks que falham N vezes antes de passar.
 */
export function renameWithRetry(
  src: string,
  dst: string,
  attempts: number[] = [0, 100, 500, 2000],
  renameFn: (s: string, d: string) => void = renameSync,
): void {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts.length; i++) {
    if (attempts[i] > 0) {
      // Busy-wait sync (Atomics.wait não disponível em main thread).
      const deadline = Date.now() + attempts[i];
      while (Date.now() < deadline) { /* spin */ }
    }
    try {
      renameFn(src, dst);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") {
        // Não é race transiente — propaga imediato
        throw err;
      }
      // Última tentativa? propaga
      if (i === attempts.length - 1) throw err;
    }
  }
  throw lastErr; // unreachable mas TS feliz
}

/**
 * Variante async (não bloqueante) usando fs/promises. Mesma semântica que
 * `writeFileAtomic` mas em promise chain.
 *
 * Não é estritamente necessário pra outputs pequenos do pipeline (sync é OK
 * dado tamanho ~KB-MB), mas exportado pra consumidores que precisam.
 */
export async function writeFileAtomicAsync(
  targetPath: string,
  content: string | Buffer,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  // Implementação simples: delega pra sync wrapped em Promise (pode evoluir
  // pra fs.promises real se profile indicar gargalo).
  return new Promise<void>((resolveP, rejectP) => {
    try {
      writeFileAtomic(targetPath, content, opts);
      resolveP();
    } catch (err) {
      rejectP(err);
    }
  });
}
