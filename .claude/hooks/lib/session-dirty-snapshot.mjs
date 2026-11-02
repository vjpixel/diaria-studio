// Foto do checkout sujo no início da sessão (#11785).
//
// `/diaria-encerra` (via `scripts/session-close-check.ts`) precisa responder
// "esta sessão deixou algo para trás?", não "este checkout está limpo?". Em
// checkout compartilhado as duas respostas divergem: a sujeira de outras
// sessões já estava no `git status` antes desta sessão começar. Esta foto
// guarda, no SessionStart, caminho + código de status + hash de conteúdo de
// cada entrada suja; no encerramento, só bloqueia o que apareceu ou mudou de
// hash depois dela.
//
// Self-contained (só `node:*`), mesma razão dos outros módulos de
// `.claude/hooks/lib/`: o hook `session-start-dirty-snapshot.mjs` importa isto
// direto, sem type-stripping, e o lado TS (`session-close-check.ts`) importa o
// mesmo arquivo — uma única implementação de captura, hash e comparação.
//
// A foto mora em `os.tmpdir()`, nunca em `data/`: é estado por máquina e por
// sessão, não deve sincronizar via OneDrive, e `data/sessions/` só aceita os
// registros e o `.merge-lock.json` (#6168). Foto ausente (tmp limpo, sessão
// anterior a este hook, hook que falhou) = atribuição impossível: o chamador
// cai no comportamento antigo e diz isso no relatório.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const SNAPSHOT_VERSION = 1;
/** Acima disso o conteúdo não é lido: o hash vira `big:{tamanho}:{mtime}` (SessionStart tem timeout de 10s). */
export const MAX_HASH_BYTES = 64 * 1024 * 1024;
/** Teto de entradas: acima disso a foto não é gravada (melhor sem foto que foto parcial). */
export const MAX_SNAPSHOT_ENTRIES = 5000;

/** Diretório padrão das fotos (por usuário e máquina). */
export function defaultSnapshotDir() {
  return join(tmpdir(), "diaria-session-dirty-snapshots");
}

/** Normaliza o caminho de um checkout para servir de chave (barra única, drive em minúsculo no Windows). */
export function normalizeCheckoutPath(path) {
  const abs = resolve(path).replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:/.test(abs) ? abs[0].toLowerCase() + abs.slice(1) : abs;
}

/** Caminho da foto de uma sessão num checkout. `null` para sessionId com caractere fora de [A-Za-z0-9_-]. */
export function snapshotFilePath(sessionId, checkout, baseDir = defaultSnapshotDir()) {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return null;
  const key = createHash("sha1").update(normalizeCheckoutPath(checkout)).digest("hex").slice(0, 12);
  return join(baseDir, `${sessionId}-${key}.json`);
}

/**
 * Parse de `git status --porcelain=v1 -z`: entradas separadas por NUL, sem
 * aspas. Rename/cópia (`R`/`C` na coluna do índice) traz o caminho de origem
 * como token seguinte, descartado (fica o destino, como no parser não-`-z`).
 */
export function parsePorcelainZ(out) {
  const tokens = String(out ?? "").split("\0");
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length < 4) continue;
    const code = token.slice(0, 2);
    entries.push({ code, path: token.slice(3) });
    if (code[0] === "R" || code[0] === "C") i++;
  }
  return entries;
}

/**
 * Hash do conteúdo atual de um caminho: sha256 do arquivo regular, alvo do
 * symlink, `big:` para arquivo enorme; `null` para ausente, diretório ou erro.
 * `null` só casa com `null` (entrada apagada que continua apagada).
 */
export function hashPath(abs) {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return `link:${readlinkSync(abs)}`;
    if (!st.isFile()) return null;
    if (st.size > MAX_HASH_BYTES) return `big:${st.size}:${Math.max(st.mtimeMs, st.ctimeMs)}`;
    return createHash("sha256").update(readFileSync(abs)).digest("hex");
  } catch { return null; }
}

const gitRun = (args, cwd) => execFileSync("git", args, {
  cwd, encoding: "utf8", timeout: 8_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});

/**
 * Foto do estado sujo do checkout que contém `cwd`. Lança se o git falhar;
 * devolve `null` acima de `MAX_SNAPSHOT_ENTRIES`.
 */
export function captureDirtySnapshot(cwd, { run = gitRun, hash = hashPath, now = () => new Date() } = {}) {
  const checkout = run(["rev-parse", "--show-toplevel"], cwd).trim();
  if (!checkout) throw new Error("rev-parse --show-toplevel vazio");
  const status = run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], checkout);
  const parsed = parsePorcelainZ(status);
  if (parsed.length > MAX_SNAPSHOT_ENTRIES) return null;
  const entries = {};
  for (const { code, path } of parsed) entries[path] = { code, hash: hash(resolve(checkout, path)) };
  return { version: SNAPSHOT_VERSION, capturedAt: now().toISOString(), checkout: normalizeCheckoutPath(checkout), entries };
}

/** Grava a foto só se ainda não existe (`wx`): a 1ª foto da sessão vence. `true` se gravou. */
export function writeSnapshotOnce(path, snapshot) {
  mkdirSync(join(path, ".."), { recursive: true });
  try {
    writeFileSync(path, JSON.stringify(snapshot), { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (error && error.code === "EEXIST") return false;
    throw error;
  }
}

/** Lê e valida a foto; `null` se ausente, ilegível ou de outra versão (nunca lança). */
export function readSnapshot(path) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || raw.version !== SNAPSHOT_VERSION || typeof raw.capturedAt !== "string") return null;
    if (!raw.entries || typeof raw.entries !== "object" || Array.isArray(raw.entries)) return null;
    return raw;
  } catch { return null; }
}

/**
 * A entrada suja de agora já estava na foto, com o MESMO código de status e o
 * MESMO hash de conteúdo? Só então é sujeira pré-existente. Arquivo novo,
 * conteúdo alterado (inclusive num arquivo que já estava sujo) ou mudança de
 * código (ex.: a sessão deu `git add`) = da sessão, bloqueia.
 */
export function isUnchangedSinceSnapshot(snapshot, checkout, entry, hash = hashPath) {
  const before = snapshot?.entries?.[entry.path];
  if (!before || before.code !== entry.code) return false;
  return before.hash === hash(resolve(checkout, entry.path));
}
