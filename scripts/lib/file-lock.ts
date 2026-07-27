/**
 * scripts/lib/file-lock.ts (#4125 item 7)
 *
 * Lock de arquivo genérico via criação exclusiva (`wx` — atômico nos
 * principais filesystems: cria o arquivo só se ele NÃO existir, falha se já
 * existir). Extraído de `scripts/lib/social-published-store.ts` (#758/#918,
 * a implementação original — usada por `publish-facebook.ts`/
 * `publish-linkedin.ts` gravando `06-social-published.json` em paralelo) pra
 * virar um helper reusável — não reinventar o mecanismo em cada novo caso de
 * read-modify-write concorrente sobre um arquivo JSON compartilhado.
 *
 * Uso típico (read-modify-write atômico):
 *
 *   const lockPath = filePath + ".lock";
 *   acquireLock(lockPath);
 *   try {
 *     const current = existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf8")) : fallback;
 *     // ...mutar `current`...
 *     const tmpPath = filePath + ".tmp";
 *     writeFileSync(tmpPath, JSON.stringify(current, null, 2) + "\n", "utf8");
 *     renameSync(tmpPath, filePath); // rename é atômico — nunca deixa o arquivo real pela metade
 *   } finally {
 *     releaseLock(lockPath);
 *   }
 */

import { openSync, closeSync, unlinkSync } from "node:fs";

/**
 * Adquire o lock — spin-wait com timeout. `wx` (O_WRONLY | O_CREAT | O_EXCL)
 * falha se o arquivo já existe, então só um caller por vez consegue criar o
 * `.lock` — os demais tentam de novo a cada 50ms até o dono liberar
 * (`releaseLock`) ou o timeout estourar.
 */
export function acquireLock(lockPath: string, timeoutMs = 10_000): void {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      return; // Lock adquirido
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`[file-lock] lock timeout after ${timeoutMs}ms: ${lockPath}`);
      }
      // Spin wait — intervalos de 50ms
      const end = Date.now() + 50;
      while (Date.now() < end) { /* busy wait */ }
    }
  }
}

/** Libera o lock. Fail-soft — se o arquivo já sumiu (ex: limpeza manual concorrente), ignora. */
export function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

/**
 * Executa `fn` sob o lock de `lockPath`, garantindo `releaseLock` mesmo se
 * `fn` lançar. Açúcar sintático pro padrão acquire→try→finally-release usado
 * em todo call site — reduz a chance de esquecer o `finally`.
 */
export function withFileLock<T>(lockPath: string, fn: () => T, timeoutMs = 10_000): T {
  acquireLock(lockPath, timeoutMs);
  try {
    return fn();
  } finally {
    releaseLock(lockPath);
  }
}
