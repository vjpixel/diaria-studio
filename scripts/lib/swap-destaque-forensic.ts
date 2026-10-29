/**
 * Backup e restauração dos artefatos do destaque que sai num swap (#11529).
 *
 * `swap-destaque.ts --demote dN` apagava `02-dN-{draft,prompt}.md`, as imagens
 * `04-dN-*` (2:1, 1:1, 4:5, carrossel), os sidecars `04-dN-{sd-prompt,generator}.json`
 * e as chaves da posição em `06-public-images.json`. Na edição 261029 o D3
 * saiu e voltou meia hora depois: o texto só voltou por causa de um snapshot
 * de outro fluxo, e o prompt, as 3 imagens e o carrossel foram refeitos.
 *
 * Agora o swap MOVE esses arquivos para
 * `_internal/_forensic/swap-{aammdd-hhmm}-dN/` (mesma árvore relativa à pasta
 * da edição) com um `manifest.json` (URL, título, bucket de origem, chaves de
 * `06-public-images.json` removidas). `swap-destaque.ts --restore dN` acha o
 * backup cuja URL é a do destaque que está hoje em dN e devolve tudo.
 *
 * `_forensic/` de edição fechada é limpo pelo `gc-data-dir.ts`, então o
 * backup não cresce sem limite.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { urlsMatch } from "./url-utils.ts";
import { publicImageKeysForPosition } from "./public-images-invalidate.ts";
import { writeFilesVerified } from "./write-files-verified.ts";

export const SWAP_BACKUP_MANIFEST = "manifest.json";

export interface SwapBackupManifest {
  version: 1;
  position: 1 | 2 | 3;
  url: string;
  title: string;
  /** Bucket de origem do destaque (`bucket` do wrapper de highlight), quando conhecido. */
  source_bucket: string | null;
  /** Bucket que recebeu o rebaixado; `null` = `--drop`. */
  demoted_to: string | null;
  created_at: string;
  /** Arquivos movidos, relativos à pasta da edição (ex.: `04-d3-2x1.jpg`, `_internal/02-d3-prompt.md`). */
  files: string[];
  /** Entradas de `06-public-images.json.images` removidas pelo swap. */
  public_images: Record<string, unknown>;
  /** Restaurações já feitas a partir deste backup (ISO). */
  restored_at?: string[];
}

/** Raiz dos backups de swap de uma edição. */
export function swapBackupRoot(editionDir: string): string {
  return resolve(editionDir, "_internal", "_forensic");
}

/**
 * `aammdd-hhmm` no horário de Brasília (`America/Sao_Paulo`).
 *
 * @pure
 */
export function brtStamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}${get("month")}${get("day")}-${get("hour")}${get("minute")}`;
}

/** Nome do diretório do backup (`swap-{aammdd-hhmm}-dN`). @pure */
export function swapBackupDirName(date: Date, position: 1 | 2 | 3): string {
  return `swap-${brtStamp(date)}-d${position}`;
}

/** Imagens `04-dN-*` na raiz da edição (mesmo padrão do swap, #9755). */
export function listDestaqueImageFiles(editionDir: string, position: 1 | 2 | 3): string[] {
  if (!existsSync(editionDir)) return [];
  const re = new RegExp(`^04-d${position}-[a-z0-9-]+\\.(?:jpg|png|jpeg|json)$`, "i");
  return readdirSync(editionDir).filter((f) => re.test(f)).sort();
}

/** Prompts/rascunho/sidecars da posição em `_internal/` (mesmo padrão do swap, #9755). */
export function listDestaquePromptFiles(internalDir: string, position: 1 | 2 | 3): string[] {
  if (!existsSync(internalDir)) return [];
  const re = new RegExp(
    `^(?:02-d${position}-(?:prompt\\.md|sd-prompt\\.json|draft\\.md)|04-d${position}-(?:sd-prompt|generator)\\.json)$`,
  );
  return readdirSync(internalDir).filter((f) => re.test(f)).sort();
}

/**
 * Entradas de `06-public-images.json` da posição (as que o swap vai remover).
 * Arquivo ausente ou ilegível → `{}` (o swap já avisa do ilegível).
 */
export function readPublicImagesForPosition(
  editionDir: string,
  position: 1 | 2 | 3,
): Record<string, unknown> {
  const path = resolve(editionDir, "06-public-images.json");
  if (!existsSync(path)) return {};
  let images: unknown;
  try {
    images = (JSON.parse(readFileSync(path, "utf8")) as { images?: unknown }).images;
  } catch {
    return {};
  }
  if (!images || typeof images !== "object" || Array.isArray(images)) return {};
  const out: Record<string, unknown> = {};
  for (const key of publicImageKeysForPosition(position)) {
    if (key in (images as Record<string, unknown>)) out[key] = (images as Record<string, unknown>)[key];
  }
  return out;
}

function moveFile(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

export interface BackupInput {
  editionDir: string;
  position: 1 | 2 | 3;
  url: string;
  title: string;
  sourceBucket: string | null;
  demotedTo: string | null;
  /** Lidas ANTES de o swap gravar o `06-public-images.json` invalidado. */
  publicImages: Record<string, unknown>;
  now?: Date;
}

export interface BackupResult {
  /** Diretório do backup; `null` quando não havia nada a guardar. */
  dir: string | null;
  files: string[];
  public_image_keys: string[];
}

/**
 * Move os artefatos da posição para `_internal/_forensic/swap-.../` e grava o
 * manifest. Nada a guardar (sem arquivos e sem chaves públicas) → não cria
 * diretório. Dois swaps no mesmo minuto ganham sufixo `-2`, `-3`...
 */
export function backupDemotedDestaque(input: BackupInput): BackupResult {
  const { editionDir, position } = input;
  const internalDir = resolve(editionDir, "_internal");
  const files = [
    ...listDestaqueImageFiles(editionDir, position),
    ...listDestaquePromptFiles(internalDir, position).map((f) => `_internal/${f}`),
  ];
  const keys = Object.keys(input.publicImages);
  if (files.length === 0 && keys.length === 0) return { dir: null, files: [], public_image_keys: [] };

  const now = input.now ?? new Date();
  const base = swapBackupDirName(now, position);
  const root = swapBackupRoot(editionDir);
  let dir = join(root, base);
  for (let n = 2; existsSync(dir); n++) dir = join(root, `${base}-${n}`);
  mkdirSync(dir, { recursive: true });

  const manifest: SwapBackupManifest = {
    version: 1,
    position,
    url: input.url,
    title: input.title,
    source_bucket: input.sourceBucket,
    demoted_to: input.demotedTo,
    created_at: now.toISOString(),
    files,
    public_images: input.publicImages,
  };
  // Manifest antes dos arquivos: se um move falhar no meio, o diretório já diz
  // o que deveria conter e de onde veio.
  writeFilesVerified(
    [{ path: join(dir, SWAP_BACKUP_MANIFEST), content: JSON.stringify(manifest, null, 2) + "\n" }],
    "swap-destaque backup",
  );
  for (const rel of files) moveFile(resolve(editionDir, rel), join(dir, rel));
  return { dir, files, public_image_keys: keys };
}

export interface FoundBackup {
  dir: string;
  manifest: SwapBackupManifest;
}

/** Backups de swap da posição, do mais recente ao mais antigo. Manifest ilegível é ignorado. */
export function listSwapBackups(editionDir: string, position: 1 | 2 | 3): FoundBackup[] {
  const root = swapBackupRoot(editionDir);
  if (!existsSync(root)) return [];
  const out: FoundBackup[] = [];
  for (const name of readdirSync(root)) {
    if (!/^swap-\d{6}-\d{4}-d[123](?:-\d+)?$/.test(name)) continue;
    const mpath = join(root, name, SWAP_BACKUP_MANIFEST);
    if (!existsSync(mpath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(mpath, "utf8")) as SwapBackupManifest;
      if (manifest.position !== position || !Array.isArray(manifest.files)) continue;
      out.push({ dir: join(root, name), manifest });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => b.manifest.created_at.localeCompare(a.manifest.created_at));
}

/** Backup mais recente da posição cuja URL é `url`. @see listSwapBackups */
export function findSwapBackupForUrl(
  editionDir: string,
  position: 1 | 2 | 3,
  url: string,
): FoundBackup | null {
  return listSwapBackups(editionDir, position).find((b) => urlsMatch(b.manifest.url, url)) ?? null;
}

export interface RestoreResult {
  files_restored: string[];
  /** Arquivos que já existiam no destino (só preenchido quando `force`; sem `force` a restauração recusa). */
  files_overwritten: string[];
  public_images_restored: string[];
  /** Chaves que já existiam em `06-public-images.json` e ficaram como estavam. */
  public_images_kept: string[];
}

/** Arquivos do backup que já existem no destino. */
export function restoreConflicts(editionDir: string, backup: FoundBackup): string[] {
  return backup.manifest.files.filter((rel) => existsSync(resolve(editionDir, rel)));
}

/**
 * Copia os arquivos do backup de volta (o backup fica, com `restored_at`
 * anotado) e devolve as chaves públicas que faltam em `06-public-images.json`.
 * Chave já presente não é sobrescrita: foi gravada por um upload posterior.
 * Arquivo do manifest ausente no backup lança — backup incompleto não se
 * restaura pela metade sem aviso.
 */
export function restoreSwapBackup(
  editionDir: string,
  backup: FoundBackup,
  opts: { force?: boolean; now?: Date } = {},
): RestoreResult {
  const conflicts = restoreConflicts(editionDir, backup);
  if (conflicts.length > 0 && !opts.force) {
    throw new Error(
      `arquivo(s) já existem no destino: ${conflicts.join(", ")} — use --force para sobrescrever`,
    );
  }
  const missing = backup.manifest.files.filter((rel) => !existsSync(join(backup.dir, rel)));
  if (missing.length > 0) {
    throw new Error(`backup ${backup.dir} incompleto, faltam: ${missing.join(", ")}`);
  }

  const writes: Array<{ path: string; content: string }> = [];
  const restoredKeys: string[] = [];
  const keptKeys: string[] = [];
  const pub = backup.manifest.public_images ?? {};
  if (Object.keys(pub).length > 0) {
    const path = resolve(editionDir, "06-public-images.json");
    let data: Record<string, unknown> = { images: {} };
    if (existsSync(path)) {
      // Ilegível lança: sobrescrever apagaria o cache das outras posições.
      data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    }
    const raw = data.images;
    const images: Record<string, unknown> =
      raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
    for (const [k, v] of Object.entries(pub)) {
      if (k in images) {
        keptKeys.push(k);
      } else {
        images[k] = v;
        restoredKeys.push(k);
      }
    }
    if (restoredKeys.length > 0) {
      writes.push({ path, content: JSON.stringify({ ...data, images }, null, 2) + "\n" });
    }
  }

  for (const rel of backup.manifest.files) {
    const to = resolve(editionDir, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(backup.dir, rel), to);
  }
  const manifest: SwapBackupManifest = {
    ...backup.manifest,
    restored_at: [...(backup.manifest.restored_at ?? []), (opts.now ?? new Date()).toISOString()],
  };
  writes.push({ path: join(backup.dir, SWAP_BACKUP_MANIFEST), content: JSON.stringify(manifest, null, 2) + "\n" });
  writeFilesVerified(writes, "swap-destaque --restore");

  return {
    files_restored: [...backup.manifest.files],
    files_overwritten: conflicts,
    public_images_restored: restoredKeys,
    public_images_kept: keptKeys,
  };
}
