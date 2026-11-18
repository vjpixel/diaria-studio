/**
 * #13505 (Parte 2): a identidade do `audio.wav` do bruto nos caches de
 * retranscrição por janela (`edge-retranscribe.json` das bordas do build,
 * `short-words` do roteiro) e no `verify-xml`.
 *
 * Até aqui a chave era tamanho + mtime. Uma cópia do work dir (outra máquina,
 * restauração, `cp` sem `-p`) troca o mtime sem trocar um byte do áudio, e o
 * cache inteiro ia fora: na 261117 foram as 93 bordas do build (643 s na CPU do
 * Neo). A chave passa a ser o SHA-256 do conteúdo; as janelas já são chaveadas
 * pelo intervalo (`windowKey`), então intervalo + hash do áudio identificam a
 * retranscrição.
 *
 * Cache gravado antes desta mudança (só tamanho + mtime) segue valendo quando
 * os dois batem, e o chamador regrava com o hash (migração sem retranscrever).
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";

export interface AudioIdentity {
  size: number;
  mtimeMs: number;
  /** SHA-256 do conteúdo, em hex; ausente só em entrada antiga ou de teste. */
  sha256?: string;
}

/** O que um cache pode trazer gravado (campos de versões anteriores incluídos). */
export type CachedAudioIdentity = { size?: unknown; mtimeMs?: unknown; sha256?: unknown } | null | undefined;

/** SHA-256 de um arquivo lido em blocos (o `audio.wav` de 1 h tem ~115 MB). */
export function fileSha256(path: string): string {
  const h = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(n === buf.length ? buf : buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
}

const memo = new Map<string, AudioIdentity>();

/**
 * Tamanho, mtime e hash do arquivo. O hash é memorizado por caminho + tamanho +
 * mtime dentro da execução (build e verify-xml leem o mesmo áudio várias vezes).
 */
export function audioIdentity(path: string, deps: { stat?: (p: string) => { size: number; mtimeMs: number }; hash?: (p: string) => string } = {}): AudioIdentity {
  const st = (deps.stat ?? statSync)(path);
  const key = `${path}|${st.size}|${st.mtimeMs}`;
  const hit = deps.hash ? undefined : memo.get(key);
  if (hit) return hit;
  const id: AudioIdentity = { size: st.size, mtimeMs: st.mtimeMs, sha256: (deps.hash ?? fileSha256)(path) };
  if (!deps.hash) memo.set(key, id);
  return id;
}

/**
 * O cache é do MESMO áudio? Com o hash dos dois lados, só o hash conta (mtime
 * diferente depois de uma cópia não invalida). Sem hash em algum lado (cache
 * anterior ao #13505), vale tamanho + mtime como antes; `legacy` avisa o
 * chamador para regravar o cache com o hash.
 */
export function sameAudio(cached: CachedAudioIdentity, current: AudioIdentity): { same: boolean; legacy: boolean } {
  if (!cached || typeof cached !== "object") return { same: false, legacy: false };
  if (typeof cached.sha256 === "string" && cached.sha256 && current.sha256) return { same: cached.sha256 === current.sha256, legacy: false };
  const same = cached.size === current.size && cached.mtimeMs === current.mtimeMs;
  return { same, legacy: same };
}
