/**
 * scripts/lib/orphan-rescue.ts (#14335)
 *
 * Resgate de uma pasta de worktree que o `git worktree remove` deixou pela
 * metade, ANTES de apagá-la. A pasta já não tem `.git`, então não dá para
 * perguntar ao git o que é rastreado (o resgate de `triage-preserved-
 * worktrees.ts`, #12374, parte do `git ls-files`/`git diff`). O critério aqui
 * é o conteúdo: arquivo cujo blob já existe no repositório (`git cat-file
 * --batch-check` no checkout principal) está salvo; o resto (não rastreado
 * como `_internal/`, rastreado editado sem commit) é copiado para
 * `data/worktree-rescue/{AAAA-MM-DD}/{nome}/files/`, com tamanho e sha256
 * conferidos contra a origem, na mesma convenção de diretório do #12374
 * (`rescueSubdirFor`, `nextFreeRescueDir`, mesmo teto `DEFAULT_RESCUE_LIMITS`).
 *
 * `node_modules/` (em qualquer nível) fica fora: é reinstalável. Symlink e
 * junction fora dele nunca são seguidos; o alvo vai para `symlinks.json`.
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

/** Recebe hashes, devolve o subconjunto que existe no repositório. Lança se não conseguir perguntar. */
export type BlobsPresentFn = (shas: string[]) => Set<string>;

/** `git cat-file --batch-check` no `repoRoot`, numa chamada só. */
export function gitBlobsPresent(repoRoot: string): BlobsPresentFn {
  return (shas) => {
    if (shas.length === 0) return new Set();
    const r = spawnSync("git", ["cat-file", "--batch-check"], {
      cwd: repoRoot,
      input: shas.join("\n") + "\n",
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (r.status !== 0 || r.error) {
      throw new Error(`git cat-file --batch-check falhou: ${(r.stderr || r.error?.message || "").trim()}`);
    }
    const present = new Set<string>();
    for (const line of r.stdout.split("\n")) {
      const m = line.match(/^([0-9a-f]{40}) blob /);
      if (m) present.add(m[1]);
    }
    return present;
  };
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export interface OrphanRescueResult {
  /** Diretório do resgate, ou `null` quando não havia nada a copiar. */
  rescueDir: string | null;
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
  const toCopy = files.filter((f) => !candidates.get(f.rel)!.some((sha) => present.has(sha)));

  if (toCopy.length === 0 && links.length === 0) {
    return { rescueDir: null, copied: 0, alreadyInRepo: files.length, symlinks: 0 };
  }
  const over = untrackedOverLimit({ files: toCopy.length, bytes: toCopy.reduce((s, f) => s + f.size, 0) }, limits);
  if (over !== null) throw new Error(over.replace("untracked", "arquivos fora do repositório"));
  if (!existsSync(dirname(resolve(opts.rescueRoot)))) {
    throw new Error(`${dirname(resolve(opts.rescueRoot))} não existe para guardar o resgate`);
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
    if (statSync(src).size !== statSync(dest).size || sha256File(src) !== sha256File(dest)) {
      throw new Error(`cópia de ${f.rel} não confere com a origem`);
    }
  }
  const symlinks: Record<string, string> = {};
  for (const l of links) symlinks[l.rel] = readlinkSync(join(dir, l.rel));
  const meta = {
    issue: 14335,
    saved_at: new Date(nowMs).toISOString(),
    source: dir,
    copied: toCopy.map((f) => f.rel),
    already_in_repo: files.length - toCopy.length,
    symlinks,
  };
  const metaText = JSON.stringify(meta, null, 2) + "\n";
  writeFileSync(join(rescueDir, "meta.json"), metaText);
  if (statSync(join(rescueDir, "meta.json")).size !== Buffer.byteLength(metaText)) {
    throw new Error("meta.json do resgate gravado incompleto");
  }
  return { rescueDir, copied: toCopy.length, alreadyInRepo: files.length - toCopy.length, symlinks: links.length };
}

export type OrphanRescueFn = (dir: string) => { ok: true; rescueDir: string | null } | { ok: false; error: string };

/** Resgate pronto para os chamadores: `data/worktree-rescue/` e o object DB do `repoRoot`. Nunca lança. */
export function makeOrphanRescuer(repoRoot: string, nowMs?: () => number): OrphanRescueFn {
  return (dir) => {
    try {
      const r = rescueOrphanDir(dir, {
        rescueRoot: join(repoRoot, "data", "worktree-rescue"),
        blobsPresent: gitBlobsPresent(repoRoot),
        nowMs: nowMs?.(),
      });
      return { ok: true, rescueDir: r.rescueDir };
    } catch (e) {
      return { ok: false, error: `resgate falhou (${(e as Error).message}), pasta preservada` };
    }
  };
}
