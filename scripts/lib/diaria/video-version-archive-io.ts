/**
 * scripts/lib/diaria/video-version-archive-io.ts (#13610)
 *
 * Quem executa a política de `video-version-archive.ts` (pura): a pasta
 * `{AAMMDD}/` da pasta de vídeo, pela API do Drive (o 300, ou o modo local com
 * raiz explícita que sobe pela API, #13334) ou pelo disco (o Neo, com o Drive
 * for desktop em `I:`). Move para `{AAMMDD}/arquivo/`, nunca apaga:
 * - Drive: `files.update` com `addParents`/`removeParents` (o id do arquivo
 *   se preserva: o upload por id do #11639 e os links do `drive-uploads.json`
 *   continuam valendo). Nome repetido no `arquivo/` ganha ` (arquivado …)`.
 * - Disco: `rename` dentro da mesma pasta da edição (no Drive for desktop vira
 *   o mesmo move do Drive).
 *
 * Fail-soft é de quem chama (`video-montagem.ts`): aqui um erro sobe.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DRIVE_API } from "../drive-constants.ts";
import { ensureChildFolder, FOLDER_MIME, listChildren, type DriveEntry, type MontageDriveDeps } from "./video-montage-drive.ts";
import {
  ARCHIVE_DIR_NAME,
  archiveStamp,
  archiveTargetName,
  planEditionArchive,
  vigenteXmlNames,
  xmlReferencedNames,
  type ArchiveEntry,
  type EditionArchivePlan,
} from "./video-version-archive.ts";

export interface ArchiveMove {
  name: string;
  /** `_superadas/x` quando vem da pasta absorvida. */
  from: string;
  /** Nome no `arquivo/` (o mesmo, ou com ` (arquivado …)` na colisão). */
  to: string;
  reason: string;
}

export interface EditionArchiveResult {
  edition: string;
  plan: EditionArchivePlan;
  /** Moves planejados (dry-run) ou feitos (apply). */
  moves: ArchiveMove[];
  /** Pastas `_superadas/` absorvidas e deixadas vazias (apply). */
  absorbedFolders: string[];
  /** Avisos (XML vigente ilegível, pasta legada não esvaziada). */
  warnings: string[];
  applied: boolean;
}

export interface ArchiveOptions {
  apply: boolean;
  now?: Date;
  log?: (line: string) => void;
  /**
   * Arquivos que o comando acabou de gravar (#13610): entram na listagem
   * mesmo que a busca do Drive ainda não os mostre (a listagem por pasta pode
   * atrasar segundos) e nunca são movidos.
   */
  fresh?: ArchiveEntry[];
}

const modifiedMsOf = (t: string | undefined) => {
  const ms = t ? Date.parse(t) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

const toEntry = (c: DriveEntry): ArchiveEntry => ({ name: c.name, id: c.id, isFolder: c.mimeType === FOLDER_MIME, modifiedMs: modifiedMsOf(c.modifiedTime) });

/** Junta a listagem com os recém-gravados (por id, senão por nome); recém-gravado vence. */
export function mergeFresh(listed: readonly ArchiveEntry[], fresh: readonly ArchiveEntry[] = []): ArchiveEntry[] {
  const out = [...listed];
  for (const f of fresh) {
    const i = out.findIndex((e) => (f.id && e.id === f.id) || (!f.id && !e.isFolder && e.name === f.name));
    if (i >= 0) out[i] = { ...out[i], ...f };
    else out.push(f);
  }
  return out;
}

/** Plano + a parte que não depende de IO: tira do `move` o que acabou de ser gravado. */
function finalizePlan(root: ArchiveEntry[], referenced: Set<string> | null, fresh: readonly ArchiveEntry[]): EditionArchivePlan {
  const plan = planEditionArchive(root, referenced);
  if (!fresh.length) return plan;
  const freshIds = new Set(fresh.flatMap((f) => (f.id ? [f.id] : [])));
  const freshNames = new Set(fresh.filter((f) => !f.id).map((f) => f.name));
  const isFresh = (m: { id?: string; name: string }) => (m.id ? freshIds.has(m.id) : freshNames.has(m.name));
  const protectedMoves = plan.move.filter(isFresh);
  return {
    ...plan,
    move: plan.move.filter((m) => !isFresh(m)),
    keep: [...plan.keep, ...protectedMoves.map((m) => ({ ...m, reason: "recém-gravado por este comando" }))],
  };
}

// ── Drive ────────────────────────────────────────────────────────────────

async function okJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`${what} falhou (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** Texto de um arquivo pequeno do Drive (o XML vigente, para ler os `pathurl`). */
export async function downloadDriveText(deps: MontageDriveDeps, id: string): Promise<string> {
  const res = await deps.driveFetch(`${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`download do XML ${id} falhou (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.text();
}

/** Move (e renomeia, se `newName`) pela API, preservando o id (#13610, restrição 6). */
export async function moveDriveFile(deps: MontageDriveDeps, id: string, fromParent: string, toParent: string, newName?: string): Promise<void> {
  const params = new URLSearchParams({ addParents: toParent, removeParents: fromParent, supportsAllDrives: "true", fields: "id,name,parents" });
  await okJson(
    await deps.driveFetch(`${DRIVE_API}/files/${encodeURIComponent(id)}?${params}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(newName ? { name: newName } : {}),
      signal: AbortSignal.timeout(60_000),
    }),
    `move de ${id} para arquivo/ no Drive`,
  );
}

async function trashDriveFolder(deps: MontageDriveDeps, id: string): Promise<void> {
  const params = new URLSearchParams({ supportsAllDrives: "true", fields: "id" });
  await okJson(
    await deps.driveFetch(`${DRIVE_API}/files/${encodeURIComponent(id)}?${params}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ trashed: true }),
      signal: AbortSignal.timeout(60_000),
    }),
    `lixeira da pasta vazia ${id}`,
  );
}

/**
 * Arquiva as versões anteriores de UMA pasta de edição no Drive. Com
 * `apply: false` só planeja (lê a listagem e os XMLs vigentes). `_superadas/`
 * é absorvido: os filhos vão para `arquivo/` e a pasta, vazia, para a lixeira
 * (premissa: pasta vazia não guarda nada; o Drive mantém a lixeira 30 dias).
 */
export async function archiveEditionDrive(deps: MontageDriveDeps, folder: Pick<DriveEntry, "id" | "name">, opts: ArchiveOptions): Promise<EditionArchiveResult> {
  const log = opts.log ?? (() => {});
  const fresh = opts.fresh ?? [];
  const warnings: string[] = [];
  const children = await listChildren(deps, folder.id);
  const root = mergeFresh(children.map(toEntry), fresh);
  const byName = new Map(root.filter((e) => !e.isFolder).map((e) => [e.name, e] as const));
  let referenced: Set<string> | null = new Set();
  for (const name of vigenteXmlNames(root)) {
    const e = byName.get(name);
    try {
      if (!e?.id) throw new Error("sem id");
      for (const r of xmlReferencedNames(await downloadDriveText(deps, e.id))) referenced.add(r);
    } catch (err) {
      warnings.push(`XML vigente ${name} não lido (${(err as Error).message}): nenhum asset sai desta pasta`);
      referenced = null;
      break;
    }
  }
  const plan = finalizePlan(root, referenced, fresh);
  const stamp = archiveStamp(opts.now ?? new Date());
  const existingArchive = children.filter((c) => c.mimeType === FOLDER_MIME && c.name === ARCHIVE_DIR_NAME);
  if (existingArchive.length > 1) throw new Error(`${existingArchive.length} pastas ${ARCHIVE_DIR_NAME}/ em ${folder.name}/ no Drive: junte à mão antes`);
  const taken = new Set(existingArchive.length ? (await listChildren(deps, existingArchive[0].id)).map((c) => c.name) : []);
  const moves: ArchiveMove[] = [];
  const pending: Array<{ id: string; parent: string; to: string; name: string }> = [];
  for (const m of plan.move) {
    if (!m.id) continue;
    const to = archiveTargetName(m.name, taken, stamp);
    taken.add(to);
    moves.push({ name: m.name, from: m.name, to, reason: m.reason });
    pending.push({ id: m.id, parent: folder.id, to, name: m.name });
  }
  const legacyFolders: DriveEntry[] = [];
  for (const legacy of plan.absorb) {
    const kids = await listChildren(deps, legacy.id!);
    legacyFolders.push({ id: legacy.id!, name: legacy.name, mimeType: FOLDER_MIME });
    for (const k of kids) {
      const to = archiveTargetName(k.name, taken, stamp);
      taken.add(to);
      moves.push({ name: k.name, from: `${legacy.name}/${k.name}`, to, reason: `absorvido de ${legacy.name}/` });
      pending.push({ id: k.id, parent: legacy.id!, to, name: k.name });
    }
  }
  const absorbedFolders: string[] = [];
  if (opts.apply && (pending.length || legacyFolders.length)) {
    const archive = existingArchive[0] ?? (await ensureChildFolder(deps, folder.id, ARCHIVE_DIR_NAME));
    for (const p of pending) {
      await moveDriveFile(deps, p.id, p.parent, archive.id, p.to !== p.name ? p.to : undefined);
      log(`[arquivo] ${folder.name}/${p.name} → ${ARCHIVE_DIR_NAME}/${p.to}`);
    }
    for (const lf of legacyFolders) {
      const left = await listChildren(deps, lf.id);
      if (left.length) {
        warnings.push(`${lf.name}/ ainda tem ${left.length} item(ns) depois de absorvido: ficou como está`);
        continue;
      }
      await trashDriveFolder(deps, lf.id);
      absorbedFolders.push(lf.name);
    }
  }
  return { edition: folder.name, plan, moves, absorbedFolders, warnings, applied: opts.apply };
}

/**
 * Antes de a nova ocupar o nome (prévia, `isOverwriteArchivedName`): o
 * arquivo de mesmo nome na RAIZ da pasta vai para `arquivo/`, em vez de ser
 * atualizado no lugar. Devolve quantos foram movidos.
 */
export async function archiveBeforeOverwriteDrive(deps: MontageDriveDeps, folderId: string, name: string, now: Date = new Date(), log: (line: string) => void = () => {}): Promise<number> {
  const all = (await listChildren(deps, folderId, { name })).filter((f) => f.mimeType !== FOLDER_MIME);
  if (!all.length) return 0;
  const archive = await ensureChildFolder(deps, folderId, ARCHIVE_DIR_NAME);
  const taken = new Set((await listChildren(deps, archive.id)).map((c) => c.name));
  const stamp = archiveStamp(now);
  for (const f of all) {
    const to = archiveTargetName(f.name, taken, stamp);
    taken.add(to);
    await moveDriveFile(deps, f.id, folderId, archive.id, to !== f.name ? to : undefined);
    log(`[arquivo] ${name} anterior → ${ARCHIVE_DIR_NAME}/${to}`);
  }
  return all.length;
}

// ── Disco (Neo) ──────────────────────────────────────────────────────────

/** A raiz de uma pasta de edição no disco, como `ArchiveEntry`. */
export function listLocalEdition(dir: string): ArchiveEntry[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (d.name.endsWith(".part")) return [];
    let modifiedMs: number | null = null;
    try {
      modifiedMs = statSync(join(dir, d.name)).mtimeMs;
    } catch {
      /* sumiu entre o readdir e o stat */
    }
    return [{ name: d.name, isFolder: d.isDirectory(), modifiedMs }];
  });
}

/** Mesma política no disco (`{AAMMDD}/arquivo/`). */
export function archiveEditionLocal(dir: string, edition: string, opts: ArchiveOptions): EditionArchiveResult {
  const log = opts.log ?? (() => {});
  const fresh = opts.fresh ?? [];
  const warnings: string[] = [];
  const root = mergeFresh(listLocalEdition(dir), fresh);
  let referenced: Set<string> | null = new Set();
  for (const name of vigenteXmlNames(root)) {
    try {
      for (const r of xmlReferencedNames(readFileSync(join(dir, name), "utf8"))) referenced.add(r);
    } catch (err) {
      warnings.push(`XML vigente ${name} não lido (${(err as Error).message}): nenhum asset sai desta pasta`);
      referenced = null;
      break;
    }
  }
  const plan = finalizePlan(root, referenced, fresh);
  const archiveDir = join(dir, ARCHIVE_DIR_NAME);
  const taken = new Set(existsSync(archiveDir) ? readdirSync(archiveDir) : []);
  const stamp = archiveStamp(opts.now ?? new Date());
  const moves: ArchiveMove[] = [];
  const pending: Array<{ src: string; to: string; name: string }> = [];
  for (const m of plan.move) {
    const to = archiveTargetName(m.name, taken, stamp);
    taken.add(to);
    moves.push({ name: m.name, from: m.name, to, reason: m.reason });
    pending.push({ src: join(dir, m.name), to, name: m.name });
  }
  for (const legacy of plan.absorb) {
    for (const k of readdirSync(join(dir, legacy.name))) {
      const to = archiveTargetName(k, taken, stamp);
      taken.add(to);
      moves.push({ name: k, from: `${legacy.name}/${k}`, to, reason: `absorvido de ${legacy.name}/` });
      pending.push({ src: join(dir, legacy.name, k), to, name: k });
    }
  }
  const absorbedFolders: string[] = [];
  if (opts.apply && (pending.length || plan.absorb.length)) {
    mkdirSync(archiveDir, { recursive: true });
    for (const p of pending) {
      renameSync(p.src, join(archiveDir, p.to));
      log(`[arquivo] ${edition}/${p.name} → ${ARCHIVE_DIR_NAME}/${p.to}`);
    }
    for (const legacy of plan.absorb) {
      try {
        rmdirSync(join(dir, legacy.name));
        absorbedFolders.push(legacy.name);
      } catch (err) {
        warnings.push(`${legacy.name}/ não removida depois de absorvida (${(err as Error).message}): ficou como está`);
      }
    }
  }
  return { edition, plan, moves, absorbedFolders, warnings, applied: opts.apply };
}

/** Disco: o arquivo de mesmo nome vai para `arquivo/` antes de a nova versão ocupar o nome (prévia). */
export function archiveBeforeOverwriteLocal(path: string, now: Date = new Date(), log: (line: string) => void = () => {}): string | null {
  if (!existsSync(path)) return null;
  const dir = join(path, "..");
  const name = path.replace(/\\/g, "/").split("/").pop()!;
  const archiveDir = join(dir, ARCHIVE_DIR_NAME);
  mkdirSync(archiveDir, { recursive: true });
  const to = archiveTargetName(name, new Set(readdirSync(archiveDir)), archiveStamp(now));
  renameSync(path, join(archiveDir, to));
  log(`[arquivo] ${name} anterior → ${ARCHIVE_DIR_NAME}/${to}`);
  return join(archiveDir, to);
}

/**
 * As `_V{n}` já usadas por um nome de XML, na raiz e no `arquivo/` de uma
 * pasta no disco (o out dir do `build` no Neo é a pasta da edição): a
 * numeração do build conta o arquivado (#13610, restrição 2).
 */
export function xmlNamesWithArchive(dir: string): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  for (const d of [dir, join(dir, ARCHIVE_DIR_NAME)]) {
    if (!existsSync(d)) continue;
    for (const n of readdirSync(d)) if (n.toLowerCase().endsWith(".xml")) out.push({ name: n, path: join(d, n) });
  }
  return out;
}
