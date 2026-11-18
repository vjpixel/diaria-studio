/**
 * scripts/lib/diaria/video-version-archive-io.ts (#13610)
 *
 * Quem executa a política de `video-version-archive.ts` (pura): a pasta
 * `{AAMMDD}/` da pasta de vídeo, pela API do Drive (o 300, ou o modo local com
 * raiz explícita que sobe pela API, #13334) ou pelo disco (o Neo, com o Drive
 * for desktop em `I:`). Move para `{AAMMDD}/arquivo/`, nunca apaga:
 * - Drive: `files.update` com `addParents`/`removeParents` (o id do arquivo
 *   se preserva: o upload por id do #11639 e os links do `drive-uploads.json`
 *   continuam valendo). Antes de cada move os `parents` são relidos (já está
 *   no `arquivo/` = pula), e a resposta é conferida: 2xx não é prova (#6582).
 *   Nome repetido no `arquivo/` ganha ` (arquivado …)`.
 * - Disco: `rename` dentro da mesma pasta da edição (no Drive for desktop vira
 *   o mesmo move do Drive), com colisão de nome sem diferenciar maiúsculas (NTFS).
 *
 * Falha no meio do `apply` devolve o resultado PARCIAL (`moves[].done`) com
 * `error`; fail-soft é de quem chama (`video-montagem.ts`).
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DRIVE_API } from "../drive-constants.ts";
import { FOLDER_MIME, listChildren, type DriveEntry, type MontageDriveDeps } from "./video-montage-drive.ts";
import {
  ARCHIVE_DIR_NAME,
  archiveStamp,
  archiveTargetName,
  planEditionArchive,
  referencedFromXmlTexts,
  stripArchivedSuffix,
  xmlsThatStay,
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
  /** Com `apply`: o move foi feito (ou já estava feito). */
  done?: boolean;
}

export interface EditionArchiveResult {
  edition: string;
  plan: EditionArchivePlan;
  /** Moves planejados (dry-run) ou tentados (apply; `done` diz quais foram). */
  moves: ArchiveMove[];
  /** Pastas `_superadas/` absorvidas e deixadas vazias (apply). */
  absorbedFolders: string[];
  /** Avisos (XML não lido, pasta legada não esvaziada, item sem id, `arquivo/` repetida). */
  warnings: string[];
  applied: boolean;
  /** Falha no meio do `apply`: o que está em `moves` com `done` foi movido, o resto não. */
  error?: string;
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
  /** #13610 B: os XMLs que o `plan.json` diz vigentes; algum fora da listagem = nenhum asset sai. */
  expectedXmls?: readonly string[];
  /** Espera antes de reconferir se `arquivo/` existe (#13610 D); injetável nos testes. */
  sleep?: (ms: number) => Promise<void>;
  /** A `arquivo/` já resolvida nesta execução, por pasta de edição (#13617): ver `ArchiveFolderCache`. */
  archiveFolders?: ArchiveFolderCache;
}

/**
 * `arquivo/` resolvida ou criada nesta execução, por id da pasta da edição
 * (#13617). A 1ª chamada (`archiveDriveIds`, no upload) pode criar a pasta e a
 * 2ª (`archiveEditionDrive`, logo depois) não achá-la na busca do Drive, que
 * atrasa mesmo depois da espera de 2 s, e criar outra. Com o cache a 2ª
 * reaproveita a da 1ª sem depender da busca.
 */
export type ArchiveFolderCache = Map<string, DriveEntry>;

const modifiedMsOf = (t: string | undefined) => {
  const ms = t ? Date.parse(t) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

const toEntry = (c: DriveEntry): ArchiveEntry => ({ name: c.name, id: c.id, isFolder: c.mimeType === FOLDER_MIME, modifiedMs: modifiedMsOf(c.modifiedTime) });

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
function finalizePlan(root: ArchiveEntry[], referenced: Set<string> | null, opts: ArchiveOptions): EditionArchivePlan {
  const fresh = opts.fresh ?? [];
  const plan = planEditionArchive(root, referenced, { expectedXmls: opts.expectedXmls });
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

/** Texto de um arquivo pequeno do Drive (o XML, para ler os `pathurl`). */
export async function downloadDriveText(deps: MontageDriveDeps, id: string): Promise<string> {
  const res = await deps.driveFetch(`${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`download do XML ${id} falhou (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.text();
}

async function fetchParents(deps: MontageDriveDeps, id: string): Promise<{ parents: string[]; name: string }> {
  const params = new URLSearchParams({ fields: "id,name,parents", supportsAllDrives: "true" });
  const meta = await okJson<{ parents?: string[]; name?: string }>(
    await deps.driveFetch(`${DRIVE_API}/files/${encodeURIComponent(id)}?${params}`, { signal: AbortSignal.timeout(30_000) }),
    `metadado de ${id} no Drive`,
  );
  return { parents: meta.parents ?? [], name: meta.name ?? "" };
}

/**
 * Move (e renomeia, se `newName`) pela API, preservando o id (#13610,
 * restrição 6). Relê os `parents` antes: já em `toParent` e fora de
 * `fromParent` = feito (`already`); fora de `fromParent` sem estar em
 * `toParent` = alguém mexeu, erro. Confere a resposta do PATCH (2xx não é
 * prova, #6582); PATCH que falhou ou veio sem `parents` é relido: aplicado =
 * sucesso (o retry de transiente pode ter aplicado o 1º).
 */
export async function moveDriveFile(deps: MontageDriveDeps, id: string, fromParent: string, toParent: string, newName?: string): Promise<"moved" | "already"> {
  const applied = (parents: string[]) => parents.includes(toParent) && !parents.includes(fromParent);
  const before = await fetchParents(deps, id);
  if (applied(before.parents)) return "already";
  if (!before.parents.includes(fromParent)) throw new Error(`${before.name || id} não está mais na pasta de origem (parents: ${before.parents.join(", ") || "nenhum"}): não movido`);
  const params = new URLSearchParams({ addParents: toParent, removeParents: fromParent, supportsAllDrives: "true", fields: "id,name,parents" });
  let patchError: Error | null = null;
  try {
    const res = await deps.driveFetch(`${DRIVE_API}/files/${encodeURIComponent(id)}?${params}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(newName ? { name: newName } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await okJson<{ parents?: string[] }>(res, `move de ${id} para arquivo/ no Drive`);
    if (body.parents && applied(body.parents)) return "moved";
  } catch (e) {
    patchError = e as Error;
  }
  let after: { parents: string[]; name: string };
  try {
    after = await fetchParents(deps, id);
  } catch (e) {
    // #13617: a releitura que falha não esconde o erro do PATCH, que é a causa.
    throw patchError ?? e;
  }
  if (applied(after.parents)) return "moved";
  throw patchError ?? new Error(`move de ${id} respondeu 2xx mas o arquivo segue com parents ${after.parents.join(", ")} (#6582)`);
}

async function trashDriveFolder(deps: MontageDriveDeps, id: string): Promise<void> {
  const params = new URLSearchParams({ supportsAllDrives: "true", fields: "id,trashed" });
  const r = await okJson<{ trashed?: boolean }>(
    await deps.driveFetch(`${DRIVE_API}/files/${encodeURIComponent(id)}?${params}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ trashed: true }),
      signal: AbortSignal.timeout(60_000),
    }),
    `lixeira da pasta vazia ${id}`,
  );
  if (r.trashed === false) throw new Error(`a pasta ${id} não foi para a lixeira (#6582)`);
}

/**
 * Pura — a lixeira recusada porque a conta do OAuth não é dona do item (#13619):
 * `403 insufficientFilePermissions` (editora não põe na lixeira o que é de
 * outra conta). Vale tanto para a resposta lida por `okJson` quanto para o
 * erro que o retry do `gFetchRetry` relança.
 */
export function isNotOwnerTrashError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b403\b/.test(msg) && /insufficientFilePermissions/i.test(msg);
}

/** A data que ordena as `arquivo/` repetidas: criação (#13617), senão a última mudança. */
const createdOrModified = (e: DriveEntry) => e.createdTime ?? e.modifiedTime ?? "";

/**
 * A pasta `arquivo/` da edição (#13610 D): uma só = ela; mais de uma (duas
 * execuções criaram ao mesmo tempo, a busca atrasou) = a mais antiga pela
 * criação (#13617), com aviso; nenhuma = espera e busca de novo antes de criar.
 * Com `cache` (#13617), a já resolvida nesta execução vale sem nova busca, e a
 * resolvida ou criada aqui entra nele.
 */
export async function resolveArchiveFolder(
  deps: MontageDriveDeps,
  parentId: string,
  opts: { create: boolean; sleep?: (ms: number) => Promise<void>; warn?: (m: string) => void; cache?: ArchiveFolderCache },
): Promise<DriveEntry | null> {
  const cached = opts.cache?.get(parentId);
  if (cached) return cached;
  const remember = (e: DriveEntry) => {
    opts.cache?.set(parentId, e);
    return e;
  };
  const find = () => listChildren(deps, parentId, { name: ARCHIVE_DIR_NAME, foldersOnly: true });
  let found = await find();
  if (!found.length && opts.create) {
    await (opts.sleep ?? defaultSleep)(2000);
    found = await find();
  }
  if (found.length > 1) {
    const sorted = [...found].sort((a, b) => createdOrModified(a).localeCompare(createdOrModified(b)) || a.id.localeCompare(b.id));
    opts.warn?.(`${found.length} pastas ${ARCHIVE_DIR_NAME}/ na edição (${found.map((f) => f.id).join(", ")}): usando a mais antiga (${sorted[0].id}); junte as outras à mão`);
    return remember(sorted[0]);
  }
  if (found.length === 1) return remember(found[0]);
  if (!opts.create) return null;
  const params = new URLSearchParams({ supportsAllDrives: "true", fields: "id,name,mimeType,modifiedTime,createdTime" });
  const created = await okJson<DriveEntry>(
    await deps.driveFetch(`${DRIVE_API}/files?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ name: ARCHIVE_DIR_NAME, mimeType: FOLDER_MIME, parents: [parentId] }),
      signal: AbortSignal.timeout(30_000),
    }),
    `criação da pasta ${ARCHIVE_DIR_NAME}/ no Drive`,
  );
  return remember(created);
}

/**
 * Arquiva as versões anteriores de UMA pasta de edição no Drive. Com
 * `apply: false` só planeja (lê a listagem e os XMLs que ficam). `_superadas/`
 * é absorvido: os filhos vão para `arquivo/` e a pasta, vazia, para a lixeira
 * (premissa: pasta vazia não guarda nada; o Drive mantém a lixeira 30 dias).
 * Lixeira recusada porque a pasta é de outra conta (`403
 * insufficientFilePermissions`, #13619) vira aviso: os moves já valeram e a
 * pasta vazia fica para remoção à mão.
 */
export async function archiveEditionDrive(deps: MontageDriveDeps, folder: Pick<DriveEntry, "id" | "name">, opts: ArchiveOptions): Promise<EditionArchiveResult> {
  const log = opts.log ?? (() => {});
  const warnings: string[] = [];
  const children = await listChildren(deps, folder.id);
  const root = mergeFresh(children.map(toEntry), opts.fresh ?? []);
  // #13610 A: todo XML que fica na raiz (inclusive fora de família e cópias de nome repetido) é lido.
  const texts: Array<string | null> = [];
  for (const x of xmlsThatStay(root)) {
    try {
      if (!x.id) throw new Error("sem id");
      texts.push(await downloadDriveText(deps, x.id));
    } catch (err) {
      warnings.push(`XML ${x.name} não lido (${(err as Error).message}): nenhum asset sai desta pasta`);
      texts.push(null);
    }
  }
  const referenced = referencedFromXmlTexts(texts);
  if (referenced === null && !texts.includes(null)) warnings.push("algum XML que fica na raiz não tem <pathurl>: nenhum asset sai desta pasta");
  const plan = finalizePlan(root, referenced, opts);
  const stamp = archiveStamp(opts.now ?? new Date());
  const archiveHint = await resolveArchiveFolder(deps, folder.id, { create: false, warn: (m) => warnings.push(m), cache: opts.archiveFolders });
  const taken = new Set(archiveHint ? (await listChildren(deps, archiveHint.id)).map((c) => c.name) : []);
  const moves: ArchiveMove[] = [];
  const pending: Array<{ id: string; parent: string; to: string; name: string; move: ArchiveMove }> = [];
  const queue = (id: string | undefined, parent: string, name: string, from: string, reason: string) => {
    if (!id) {
      warnings.push(`${from} sem id na listagem: não movido`);
      return;
    }
    const to = archiveTargetName(name, taken, stamp);
    taken.add(to);
    const move: ArchiveMove = { name, from, to, reason };
    moves.push(move);
    pending.push({ id, parent, to, name, move });
  };
  for (const m of plan.move) queue(m.id, folder.id, m.name, m.name, m.reason);
  const legacyFolders: DriveEntry[] = [];
  for (const legacy of plan.absorb) {
    if (!legacy.id) {
      warnings.push(`${legacy.name}/ sem id na listagem: não absorvida`);
      continue;
    }
    legacyFolders.push({ id: legacy.id, name: legacy.name, mimeType: FOLDER_MIME });
    for (const k of await listChildren(deps, legacy.id)) queue(k.id, legacy.id, k.name, `${legacy.name}/${k.name}`, `absorvido de ${legacy.name}/`);
  }
  const absorbedFolders: string[] = [];
  const result: EditionArchiveResult = { edition: folder.name, plan, moves, absorbedFolders, warnings, applied: opts.apply };
  if (!opts.apply || (!pending.length && !legacyFolders.length)) return result;
  try {
    const archive = archiveHint ?? (await resolveArchiveFolder(deps, folder.id, { create: true, sleep: opts.sleep, warn: (m) => warnings.push(m), cache: opts.archiveFolders }))!;
    for (const p of pending) {
      const r = await moveDriveFile(deps, p.id, p.parent, archive.id, p.to !== p.name ? p.to : undefined);
      p.move.done = true;
      log(`[arquivo] ${folder.name}/${p.move.from} → ${ARCHIVE_DIR_NAME}/${p.to}${r === "already" ? " (já estava)" : ""}`);
    }
    for (const lf of legacyFolders) {
      const left = await listChildren(deps, lf.id);
      if (left.length) {
        warnings.push(`${lf.name}/ ainda tem ${left.length} item(ns) depois de absorvida: ficou como está`);
        continue;
      }
      try {
        await trashDriveFolder(deps, lf.id);
      } catch (e) {
        if (!isNotOwnerTrashError(e)) throw e;
        warnings.push(`${lf.name}/ (id ${lf.id}) ficou vazia, mas não foi para a lixeira: a conta do OAuth não é dona dela (403 insufficientFilePermissions); remova à mão com a conta dona (#13619)`);
        continue;
      }
      absorbedFolders.push(lf.name);
    }
  } catch (e) {
    result.error = (e as Error).message;
  }
  return result;
}

/**
 * Prévia regravada no Drive (#13610 C): os ids de mesmo nome na RAIZ antes do
 * upload. O upload da nova cria um arquivo novo (sem reusar esses ids) e só
 * DEPOIS dele dar certo `archiveDriveIds` os move; falha no upload deixa a
 * anterior na raiz.
 */
export async function rootIdsNamed(deps: MontageDriveDeps, folderId: string, name: string): Promise<string[]> {
  return (await listChildren(deps, folderId, { name })).filter((f) => f.mimeType !== FOLDER_MIME).map((f) => f.id);
}

/** Move ids da raiz para `arquivo/` (a prévia anterior, depois de a nova subir). Devolve quantos foram. */
export async function archiveDriveIds(deps: MontageDriveDeps, folderId: string, name: string, ids: readonly string[], opts: { now?: Date; log?: (l: string) => void; sleep?: (ms: number) => Promise<void>; warn?: (m: string) => void; archiveFolders?: ArchiveFolderCache } = {}): Promise<number> {
  if (!ids.length) return 0;
  const archive = (await resolveArchiveFolder(deps, folderId, { create: true, sleep: opts.sleep, warn: opts.warn, cache: opts.archiveFolders }))!;
  const taken = new Set((await listChildren(deps, archive.id)).map((c) => c.name));
  const stamp = archiveStamp(opts.now ?? new Date());
  for (const id of ids) {
    const to = archiveTargetName(name, taken, stamp);
    taken.add(to);
    await moveDriveFile(deps, id, folderId, archive.id, to !== name ? to : undefined);
    opts.log?.(`[arquivo] ${name} anterior → ${ARCHIVE_DIR_NAME}/${to}`);
  }
  return ids.length;
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
  const warnings: string[] = [];
  const root = mergeFresh(listLocalEdition(dir), opts.fresh ?? []);
  const texts: Array<string | null> = [];
  for (const x of xmlsThatStay(root)) {
    try {
      texts.push(readFileSync(join(dir, x.name), "utf8"));
    } catch (err) {
      warnings.push(`XML ${x.name} não lido (${(err as Error).message}): nenhum asset sai desta pasta`);
      texts.push(null);
    }
  }
  const referenced = referencedFromXmlTexts(texts);
  if (referenced === null && !texts.includes(null)) warnings.push("algum XML que fica na raiz não tem <pathurl>: nenhum asset sai desta pasta");
  const plan = finalizePlan(root, referenced, opts);
  const archiveDir = join(dir, ARCHIVE_DIR_NAME);
  const taken = new Set(existsSync(archiveDir) ? readdirSync(archiveDir) : []);
  const stamp = archiveStamp(opts.now ?? new Date());
  const moves: ArchiveMove[] = [];
  const pending: Array<{ src: string; to: string; move: ArchiveMove }> = [];
  const queue = (src: string, name: string, from: string, reason: string) => {
    const to = archiveTargetName(name, taken, stamp, { caseInsensitive: true });
    taken.add(to);
    const move: ArchiveMove = { name, from, to, reason };
    moves.push(move);
    pending.push({ src, to, move });
  };
  for (const m of plan.move) queue(join(dir, m.name), m.name, m.name, m.reason);
  for (const legacy of plan.absorb) for (const k of readdirSync(join(dir, legacy.name))) queue(join(dir, legacy.name, k), k, `${legacy.name}/${k}`, `absorvido de ${legacy.name}/`);
  const absorbedFolders: string[] = [];
  const result: EditionArchiveResult = { edition, plan, moves, absorbedFolders, warnings, applied: opts.apply };
  if (!opts.apply || (!pending.length && !plan.absorb.length)) return result;
  try {
    mkdirSync(archiveDir, { recursive: true });
    for (const p of pending) {
      renameSync(p.src, join(archiveDir, p.to));
      p.move.done = true;
      log(`[arquivo] ${edition}/${p.move.from} → ${ARCHIVE_DIR_NAME}/${p.to}`);
    }
    for (const legacy of plan.absorb) {
      try {
        rmdirSync(join(dir, legacy.name));
        absorbedFolders.push(legacy.name);
      } catch (err) {
        warnings.push(`${legacy.name}/ não removida depois de absorvida (${(err as Error).message}): ficou como está`);
      }
    }
  } catch (e) {
    result.error = (e as Error).message;
  }
  return result;
}

/** Disco: o arquivo de mesmo nome vai para `arquivo/` (a prévia anterior). Sem arquivo = null. */
export function archiveBeforeOverwriteLocal(path: string, now: Date = new Date(), log: (line: string) => void = () => {}): string | null {
  if (!existsSync(path)) return null;
  const dir = dirname(path);
  const name = basename(path);
  const archiveDir = join(dir, ARCHIVE_DIR_NAME);
  mkdirSync(archiveDir, { recursive: true });
  const to = archiveTargetName(name, new Set(readdirSync(archiveDir)), archiveStamp(now), { caseInsensitive: true });
  renameSync(path, join(archiveDir, to));
  log(`[arquivo] ${name} anterior → ${ARCHIVE_DIR_NAME}/${to}`);
  return join(archiveDir, to);
}

/**
 * Prévia nova no disco (#13610 C): copia para `{out}.part` primeiro, só então
 * manda a anterior para `arquivo/` e renomeia a nova para o nome final. Falha
 * na cópia deixa a anterior na raiz; falha ao arquivar vira `warn` e a nova
 * substitui a anterior no lugar; falha no rename final apaga o `.part` e
 * relança (#13617).
 */
export function installPreviewFile(src: string, out: string, opts: { archive: boolean; now?: Date; log?: (l: string) => void; warn?: (m: string) => void }): void {
  if (!opts.archive) {
    copyFileSync(src, out);
    return;
  }
  const part = `${out}.part`;
  try {
    copyFileSync(src, part);
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
  try {
    archiveBeforeOverwriteLocal(out, opts.now ?? new Date(), opts.log);
  } catch (e) {
    opts.warn?.(`${basename(out)} anterior não foi para arquivo/ (${(e as Error).message}): a nova a substitui (#13610)`);
  }
  try {
    renameSync(part, out);
  } catch (e) {
    // #13617: o `.part` não fica órfão na pasta da edição.
    rmSync(part, { force: true });
    throw e;
  }
}

/**
 * Os XMLs de uma pasta no disco e do seu `arquivo/`, com o nome sem o
 * ` (arquivado …)` da colisão (#13610 F): a numeração do build conta o arquivado.
 */
export function xmlNamesWithArchive(dir: string): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  for (const d of [dir, join(dir, ARCHIVE_DIR_NAME)]) {
    if (!existsSync(d)) continue;
    for (const n of readdirSync(d)) if (n.toLowerCase().endsWith(".xml")) out.push({ name: stripArchivedSuffix(n), path: join(d, n) });
  }
  return out;
}
