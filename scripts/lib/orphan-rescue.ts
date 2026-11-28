/**
 * scripts/lib/orphan-rescue.ts (#14335)
 *
 * Resgate de uma pasta de worktree que o `git worktree remove` deixou pela
 * metade, ANTES de apagá-la. A pasta já não tem `.git`, então não dá para
 * perguntar ao git o que é rastreado (o resgate de `triage-preserved-
 * worktrees.ts`, #12374, parte do `git ls-files`/`git diff`). O critério aqui
 * é o conteúdo: arquivo cujo blob é ALCANÇÁVEL por alguma ref do repositório
 * (`git rev-list --objects --all` no checkout principal) está salvo. Blob que
 * só existe no object DB (índice ou reflog do worktree removido, que somem
 * com `.git/worktrees/<nome>` e caem no `gc`) não conta. Arquivo vazio é
 * sempre copiado. O resto (não rastreado como `_internal/`, rastreado editado
 * sem commit) é copiado para
 * `data/worktree-rescue/{AAAA-MM-DD}/{nome}/files/`, com tamanho e sha256
 * conferidos contra a origem, na mesma convenção de diretório do #12374
 * (`rescueSubdirFor`, `nextFreeRescueDir`, mesmo teto `DEFAULT_RESCUE_LIMITS`).
 *
 * `node_modules/` (em qualquer nível) fica fora: é reinstalável. Symlink e
 * junction fora dele nunca são seguidos; o alvo vai para o campo `symlinks`
 * do `meta.json`. Resgate já feito da mesma pasta com o mesmo conjunto de
 * arquivos (caminho + sha256) e links é reaproveitado, sem cópia nova: a
 * pasta preservada por processo vivo volta toda rodada e não deve acumular
 * cópias.
 *
 * Qualquer falha lança: sem resgate íntegro, o chamador não apaga.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DEFAULT_RESCUE_LIMITS, nextFreeRescueDir, rescueSubdirFor, untrackedOverLimit, type RescueLimits } from "./worktree-triage.ts";

export interface OrphanEntry {
  /** Caminho relativo à pasta órfã, com `/`. */
  rel: string;
  kind: "file" | "symlink";
  size: number;
}

/** Arquivos e links da pasta, fora de qualquer `node_modules/`. Nunca desce em link. Lança em entrada que não sabe tratar. */
export function listOrphanEntries(root: string): OrphanEntry[] {
  const out: OrphanEntry[] = [];
  const walk = (dir: string, relDir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        if (e.name !== "node_modules") out.push({ rel, kind: "symlink", size: 0 });
        continue;
      }
      if (st.isDirectory()) {
        if (e.name === "node_modules") continue;
        walk(full, rel);
        continue;
      }
      if (st.isFile()) {
        out.push({ rel, kind: "file", size: st.size });
        continue;
      }
      throw new Error(`entrada que o resgate não sabe copiar: ${rel}`);
    }
  };
  walk(root, "");
  return out;
}

/** sha1 do objeto blob do git para este conteúdo (`git hash-object`). */
export function gitBlobSha1(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}

/**
 * Hashes candidatos do conteúdo: o cru e, se houver CRLF, o normalizado para
 * LF (com `core.autocrlf=true` o arquivo no disco tem CRLF e o blob, LF).
 */
export function blobCandidates(content: Buffer): string[] {
  const raw = gitBlobSha1(content);
  if (!content.includes("\r\n")) return [raw];
  const lf = Buffer.from(content.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  return [raw, gitBlobSha1(lf)];
}

/** Recebe hashes, devolve o subconjunto salvo no repositório. Lança se não conseguir perguntar. */
export type BlobsPresentFn = (shas: string[]) => Set<string>;

/**
 * Objetos alcançáveis por alguma ref (`git rev-list --objects --all
 * --no-object-names` no `repoRoot`), lidos uma vez e reaproveitados pelas
 * chamadas seguintes do mesmo verificador. Lança se o git falhar.
 */
export function gitReachableBlobs(repoRoot: string): BlobsPresentFn {
  let reachable: Set<string> | null = null;
  return (shas) => {
    if (reachable === null) {
      const r = spawnSync("git", ["rev-list", "--objects", "--all", "--no-object-names"], {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 512 * 1024 * 1024,
        windowsHide: true,
        timeout: 120_000,
      });
      if (r.status !== 0 || r.error) {
        throw new Error(`git rev-list --objects --all falhou: ${(r.stderr || r.error?.message || "").trim()}`);
      }
      reachable = new Set(
        r.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /^[0-9a-f]{40}$/.test(l)),
      );
    }
    const set = reachable;
    return new Set(shas.filter((sha) => set.has(sha)));
  };
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export interface OrphanRescueResult {
  /** Diretório do resgate, ou `null` quando não havia nada a copiar. */
  rescueDir: string | null;
  /** `true` quando `rescueDir` é um resgate anterior equivalente, reaproveitado sem cópia nova. */
  reused: boolean;
  copied: number;
  alreadyInRepo: number;
  symlinks: number;
}

/**
 * Copia para `rescueRoot` o que da pasta órfã `dir` não existe no
 * repositório. Exige que o PAI de `rescueRoot` (o `data/` do checkout) exista:
 * nunca cria um `data/` de verdade no lugar da junction. Lança em qualquer
 * falha ou acima do teto.
 */
export function rescueOrphanDir(
  dir: string,
  opts: { rescueRoot: string; blobsPresent: BlobsPresentFn; nowMs?: number; limits?: RescueLimits },
): OrphanRescueResult {
  const nowMs = opts.nowMs ?? Date.now();
  const limits = opts.limits ?? DEFAULT_RESCUE_LIMITS;
  const entries = listOrphanEntries(dir);
  const files = entries.filter((e) => e.kind === "file");
  const links = entries.filter((e) => e.kind === "symlink");

  const candidates = new Map<string, string[]>();
  for (const f of files) candidates.set(f.rel, blobCandidates(readFileSync(join(dir, f.rel))));
  const present = opts.blobsPresent([...new Set([...candidates.values()].flat())]);
  // Arquivo vazio sempre vai: o blob vazio existe em qualquer repo e não diz nada sobre este arquivo.
  const toCopy = files.filter((f) => f.size === 0 || !candidates.get(f.rel)!.some((sha) => present.has(sha)));
  // Os que ficaram: blob alcançável com que cada um casou, para o meta.json
  // permitir reconstruir a pasta (`git cat-file blob <sha>`).
  const inRepo: Record<string, string> = {};
  for (const f of files) {
    if (toCopy.includes(f)) continue;
    inRepo[f.rel] = candidates.get(f.rel)!.find((sha) => present.has(sha))!;
  }

  if (toCopy.length === 0 && links.length === 0) {
    return { rescueDir: null, copied: 0, alreadyInRepo: files.length, symlinks: 0, reused: false };
  }
  const over = untrackedOverLimit({ files: toCopy.length, bytes: toCopy.reduce((s, f) => s + f.size, 0) }, limits);
  if (over !== null) throw new Error(over.replace("untracked", "arquivos fora do repositório"));
  if (!existsSync(dirname(resolve(opts.rescueRoot)))) {
    throw new Error(`${dirname(resolve(opts.rescueRoot))} não existe para guardar o resgate`);
  }

  const fileHashes: Record<string, string> = {};
  for (const f of toCopy) fileHashes[f.rel] = sha256File(join(dir, f.rel));
  const symlinks: Record<string, string> = {};
  for (const l of links) symlinks[l.rel] = readlinkSync(join(dir, l.rel));
  const previous = findEquivalentRescue(opts.rescueRoot, dir, fileHashes, symlinks, inRepo);
  if (previous !== null) {
    return { rescueDir: previous, copied: 0, alreadyInRepo: files.length - toCopy.length, symlinks: links.length, reused: true };
  }

  const rescueDir = nextFreeRescueDir(join(opts.rescueRoot, rescueSubdirFor(basename(dir), nowMs)), existsSync);
  const filesRoot = resolve(rescueDir, "files");
  mkdirSync(filesRoot, { recursive: true });
  for (const f of toCopy) {
    const src = join(dir, f.rel);
    const dest = resolve(filesRoot, f.rel);
    const rel = relative(filesRoot, dest);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`caminho fora do resgate: ${f.rel}`);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    if (statSync(src).size !== statSync(dest).size || fileHashes[f.rel] !== sha256File(dest)) {
      throw new Error(`cópia de ${f.rel} não confere com a origem`);
    }
  }
  const meta = {
    issue: 14335,
    saved_at: new Date(nowMs).toISOString(),
    source: dir,
    files: fileHashes,
    already_in_repo: files.length - toCopy.length,
    in_repo: inRepo,
    symlinks,
  };
  const metaText = JSON.stringify(meta, null, 2) + "\n";
  writeFileSync(join(rescueDir, "meta.json"), metaText);
  if (statSync(join(rescueDir, "meta.json")).size !== Buffer.byteLength(metaText)) {
    throw new Error("meta.json do resgate gravado incompleto");
  }
  return { rescueDir, copied: toCopy.length, alreadyInRepo: files.length - toCopy.length, symlinks: links.length, reused: false };
}

/** Cada `files/<rel>` do resgate existe e tem o sha256 esperado. */
function rescueCopiesIntact(rescueDir: string, files: Record<string, string>): boolean {
  for (const [rel, sha] of Object.entries(files)) {
    const copy = join(rescueDir, "files", rel);
    try {
      if (!statSync(copy).isFile() || sha256File(copy) !== sha) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function sameRecord(a: Record<string, string>, b: unknown): boolean {
  if (!b || typeof b !== "object") return false;
  const bb = b as Record<string, unknown>;
  const ka = Object.keys(a);
  return ka.length === Object.keys(bb).length && ka.every((k) => bb[k] === a[k]);
}

/**
 * Resgate anterior (`{rescueRoot}/{dia}/{nome}[-N]/meta.json`, #14335) da
 * mesma pasta `source` com os mesmos arquivos (caminho + sha256), links e
 * `in_repo`, ou `null`. Só reaproveita se cada `files/<rel>` do resgate ainda
 * existir com o sha256 do meta.json: cópia apagada ou alterada depois faz
 * copiar de novo. `meta.json` ilegível é ignorado (copia de novo).
 */
export function findEquivalentRescue(
  rescueRoot: string,
  source: string,
  files: Record<string, string>,
  symlinks: Record<string, string>,
  inRepo: Record<string, string> = {},
): string | null {
  const safe = rescueSubdirFor(basename(source), 0).split("/")[1];
  let days: string[];
  try {
    days = readdirSync(rescueRoot);
  } catch {
    return null;
  }
  for (const day of days.sort().reverse()) {
    let names: string[];
    try {
      names = readdirSync(join(rescueRoot, day));
    } catch {
      continue;
    }
    for (const name of names) {
      if (name !== safe && !name.startsWith(`${safe}-`)) continue;
      try {
        const meta = JSON.parse(readFileSync(join(rescueRoot, day, name, "meta.json"), "utf8")) as Record<string, unknown>;
        if (
          meta.issue === 14335 &&
          meta.source === source &&
          sameRecord(files, meta.files) &&
          sameRecord(symlinks, meta.symlinks) &&
          sameRecord(inRepo, meta.in_repo) &&
          rescueCopiesIntact(join(rescueRoot, day, name), files)
        ) {
          return join(rescueRoot, day, name);
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

export type OrphanRescueFn = (dir: string) => { ok: true; rescueDir: string | null } | { ok: false; error: string };

/** Resgate pronto para os chamadores: `data/worktree-rescue/` e os blobs alcançáveis do `repoRoot`. Nunca lança. */
export function makeOrphanRescuer(repoRoot: string, nowMs?: () => number): OrphanRescueFn {
  const reachable = gitReachableBlobs(repoRoot); // lido uma vez por rescuer
  return (dir) => {
    try {
      const r = rescueOrphanDir(dir, {
        rescueRoot: join(repoRoot, "data", "worktree-rescue"),
        blobsPresent: reachable,
        nowMs: nowMs?.(),
      });
      return { ok: true, rescueDir: r.rescueDir };
    } catch (e) {
      return { ok: false, error: `resgate falhou (${(e as Error).message}), pasta preservada` };
    }
  };
}
