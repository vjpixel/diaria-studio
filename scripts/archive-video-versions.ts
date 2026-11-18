#!/usr/bin/env node
/**
 * scripts/archive-video-versions.ts (#13610) — migração one-shot das pastas
 * de edição da pasta de vídeo (`diaria-studio-video`, conta diaria.editor):
 * em cada `AAMMDD/` (ou `AAMMDD-DD/`) deixa na raiz só a última versão de
 * cada arquivo e move as anteriores para `{pasta}/arquivo/`. Absorve o
 * `_superadas/` feito à mão (261110, 261111). Política pura em
 * `scripts/lib/diaria/video-version-archive.ts`; daqui pra frente o
 * `video-montagem.ts` faz o mesmo sozinho depois de `build`/`srt`/`preview`/`upload`.
 *
 * **Dry-run é o DEFAULT**: sem `--apply` só lista, por pasta, o que vai para
 * `arquivo/` e o que fica (lê a listagem e os XMLs vigentes, não move nada).
 *
 * Uso:
 *   npx tsx scripts/archive-video-versions.ts [--edition AAMMDD[,AAMMDD]] [--apply] [--json]
 *       [--folder-id ID] [--local-root "I:/Meu Drive/diaria-studio-video"] [--verbose]
 *
 *   --edition     só estas pastas (nome exato: `261118`, `261109-10`).
 *   --apply       move de verdade (Drive: `files.update` com addParents/removeParents,
 *                 o id se preserva; disco: rename).
 *   --json        relatório inteiro em JSON no stdout (o resumo vai para o stderr).
 *   --folder-id   a pasta de vídeo no Drive (default: `publishing.youtube.drive_folder_id`).
 *   --local-root  modo disco (o Neo, Drive for desktop): opera na pasta local, sem API.
 *   --verbose     no texto, lista também o que fica e o motivo.
 *
 * Auth do Drive: OAuth do projeto (`data/.credentials.json`, `scripts/google-auth.ts`).
 * Exit: 0 ok; 1 alguma pasta falhou (as outras seguem); 2 uso inválido.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, hasFlag, isMainModule, findUnknownFlags } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { gFetchRetry } from "./lib/drive-helpers.ts";
import { FOLDER_MIME, listChildren, youtubeFolderIdFrom, type MontageDriveDeps } from "./lib/diaria/video-montage-drive.ts";
import { archiveEditionDrive, archiveEditionLocal, type EditionArchiveResult } from "./lib/diaria/video-version-archive-io.ts";
import { ARCHIVE_DIR_NAME, isEditionFolderName } from "./lib/diaria/video-version-archive.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const KNOWN = ["edition", "apply", "json", "folder-id", "local-root", "verbose", "help"];

const USAGE = `uso: npx tsx scripts/archive-video-versions.ts [--edition AAMMDD[,AAMMDD]] [--apply] [--json] [--folder-id ID] [--local-root PASTA] [--verbose]
Dry-run por padrão: lista o que iria para {AAMMDD}/${ARCHIVE_DIR_NAME}/ sem mover nada (#13610).`;

export interface FolderReport {
  folder: string;
  ok: boolean;
  error?: string;
  result?: EditionArchiveResult;
}

/** Pura — o resumo de texto de uma pasta. */
export function renderFolderReport(r: FolderReport, verbose: boolean): string {
  if (!r.ok || !r.result) return `${r.folder}: ERRO ${r.error}`;
  const res = r.result;
  const keepFiles = res.plan.keep.length;
  const lines = [
    `${r.folder}: ${res.moves.length} para ${ARCHIVE_DIR_NAME}/ · ${keepFiles} versionado(s) ficam · ${res.plan.untouched.length} fora da regra${res.plan.absorb.length ? ` · absorve ${res.plan.absorb.map((a) => `${a.name}/`).join(", ")}` : ""}${res.applied ? " (APLICADO)" : ""}`,
  ];
  if (res.plan.vigenteXmls.length) lines.push(`  XML vigente: ${res.plan.vigenteXmls.join(" | ")}`);
  for (const m of res.moves) lines.push(`  → ${m.from}${m.to !== m.name ? `  (como ${m.to})` : ""}  [${m.reason}]`);
  if (verbose) for (const k of res.plan.keep) lines.push(`  = ${k.name}  [${k.reason}]`);
  for (const w of res.warnings) lines.push(`  [aviso] ${w}`);
  return lines.join("\n");
}

function readFolderId(flag: string | undefined): string {
  if (flag) return flag;
  const id = youtubeFolderIdFrom(JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")));
  if (!id) throw new Error("sem publishing.youtube.drive_folder_id no platform.config.json: passe --folder-id");
  return id;
}

export async function runArchiveVersions(argv: string[], deps?: MontageDriveDeps, now: Date = new Date()): Promise<{ code: number; reports: FolderReport[] }> {
  const apply = hasFlag(argv, "apply");
  const only = getStringArg(argv, "edition", { example: "261118" })?.split(",").map((s) => s.trim()).filter(Boolean);
  const localRoot = getStringArg(argv, "local-root", { example: '"I:/Meu Drive/diaria-studio-video"' });
  const log = (l: string) => console.error(l);
  const reports: FolderReport[] = [];
  const wanted = (name: string) => isEditionFolderName(name) && (!only || only.includes(name));
  if (localRoot) {
    if (!existsSync(localRoot)) throw new Error(`--local-root não existe: ${localRoot}`);
    const folders = readdirSync(localRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && wanted(d.name)).map((d) => d.name).sort();
    for (const folder of folders) {
      try {
        reports.push({ folder, ok: true, result: archiveEditionLocal(join(localRoot, folder), folder, { apply, now, log }) });
      } catch (e) {
        reports.push({ folder, ok: false, error: (e as Error).message });
      }
    }
  } else {
    const d: MontageDriveDeps = deps ?? { driveFetch: (url, init) => gFetchRetry(url, init ?? {}) };
    const rootId = readFolderId(getStringArg(argv, "folder-id", { example: "10caFTgy…" }));
    const children = await listChildren(d, rootId, { foldersOnly: true });
    const folders = children.filter((c) => c.mimeType === FOLDER_MIME && wanted(c.name)).sort((a, b) => a.name.localeCompare(b.name));
    const dupNames = new Set(folders.map((f) => f.name).filter((n, i, all) => all.indexOf(n) !== i));
    for (const folder of folders) {
      if (dupNames.has(folder.name)) {
        reports.push({ folder: folder.name, ok: false, error: `pasta ${folder.name}/ repetida no Drive: junte à mão, nada movido` });
        continue;
      }
      try {
        reports.push({ folder: folder.name, ok: true, result: await archiveEditionDrive(d, folder, { apply, now, log }) });
      } catch (e) {
        reports.push({ folder: folder.name, ok: false, error: (e as Error).message });
      }
    }
  }
  if (only) for (const name of only) if (!reports.some((r) => r.folder === name)) reports.push({ folder: name, ok: false, error: "pasta não encontrada" });
  return { code: reports.some((r) => !r.ok) ? 1 : 0, reports };
}

export async function main(argv = process.argv.slice(2), deps?: MontageDriveDeps): Promise<number> {
  if (hasFlag(argv, "help")) {
    console.error(USAGE);
    return 0;
  }
  const unknown = findUnknownFlags(argv, KNOWN);
  if (unknown.length) {
    console.error(`flag desconhecida: ${unknown.join(", ")}\n${USAGE}`);
    return 2;
  }
  let out: Awaited<ReturnType<typeof runArchiveVersions>>;
  try {
    out = await runArchiveVersions(argv, deps);
  } catch (e) {
    console.error(`archive-video-versions: ${(e as Error).message}`);
    return 2;
  }
  const verbose = hasFlag(argv, "verbose");
  const text = out.reports.map((r) => renderFolderReport(r, verbose)).join("\n\n");
  const total = out.reports.reduce((n, r) => n + (r.result?.moves.length ?? 0), 0);
  const footer = `\n${hasFlag(argv, "apply") ? "movidos" : "iriam para arquivo/ (dry-run; --apply para mover)"}: ${total} arquivo(s) em ${out.reports.length} pasta(s)`;
  if (hasFlag(argv, "json")) {
    console.error(text + footer);
    console.log(JSON.stringify({ applied: hasFlag(argv, "apply"), reports: out.reports }, null, 2));
  } else console.log(text + footer);
  return out.code;
}

if (isMainModule(import.meta.url)) {
  runCli(() => main(), { onError: (e) => console.error("archive-video-versions:", e instanceof Error ? e.message : e) });
}
