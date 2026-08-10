#!/usr/bin/env npx tsx
/**
 * snapshot-audience-profile.ts (#4842)
 *
 * Copia `context/audience-profile.md` para `_internal/audience-profile-snapshot.md`
 * dentro da edição — chamado no Stage 0 (0i), logo depois de `update-audience.ts`
 * regenerar o profile vigente.
 *
 * Por quê: `context/audience-profile.md` é regerado TODA edição a partir de CTR
 * comportamental + survey — e pode mudar rápido (medido: derivou 9 de 17
 * posições em 5 dias, #4842). Sem um snapshot POR EDIÇÃO, não há como saber
 * retroativamente qual tabela de CTR/audiência o `scorer`/`scorer-chunk` de uma
 * edição PASSADA de fato leu ao pontuar — nenhuma análise retrospectiva do
 * rubrico de scoring (ex: a auditoria de cliques 260810 que originou esta
 * issue) é reproduzível sem isso.
 *
 * Fail-soft por design (mesmo padrão de update-audience.ts, #372): se o
 * profile fonte não existir (não deveria acontecer pós-0i, mas defensivo),
 * loga warning no stderr e sai 0 — nunca aborta o Stage 0.
 *
 * Uso:
 *   npx tsx scripts/snapshot-audience-profile.ts --edition-dir data/editions/2604/260423
 */

import { existsSync, copyFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SOURCE = resolve(ROOT, "context/audience-profile.md");
export const SNAPSHOT_FILENAME = "audience-profile-snapshot.md";

export type SnapshotResult =
  | { ok: true; dest: string }
  | { ok: false; reason: string };

export interface SnapshotDeps {
  exists?: (p: string) => boolean;
  copy?: (src: string, dest: string) => void;
  mkdir?: (p: string) => void;
}

/**
 * Copia `sourcePath` (default `context/audience-profile.md`) para
 * `{editionDir}/_internal/audience-profile-snapshot.md`. Deps injetáveis pra
 * teste (sem tocar filesystem real).
 */
export function snapshotAudienceProfile(
  editionDir: string,
  sourcePath: string = DEFAULT_SOURCE,
  deps: SnapshotDeps = {},
): SnapshotResult {
  const exists = deps.exists ?? existsSync;
  const copy = deps.copy ?? copyFileSync;
  const mkdir = deps.mkdir ?? ((p: string) => mkdirSync(p, { recursive: true }));

  if (!exists(sourcePath)) {
    return { ok: false, reason: `profile fonte ausente: ${sourcePath}` };
  }

  const internalDir = resolve(editionDir, "_internal");
  mkdir(internalDir);
  const dest = resolve(internalDir, SNAPSHOT_FILENAME);
  copy(sourcePath, dest);
  return { ok: true, dest };
}

export function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const editionDirArg = args["edition-dir"];
  if (!editionDirArg) {
    console.error("Uso: snapshot-audience-profile.ts --edition-dir <path> [--source <path>]");
    process.exit(1);
  }
  const editionDir = resolve(ROOT, editionDirArg);
  const sourcePath = args["source"] ? resolve(ROOT, args["source"]) : DEFAULT_SOURCE;

  const result = snapshotAudienceProfile(editionDir, sourcePath);
  if (!result.ok) {
    process.stderr.write(
      `WARN [snapshot-audience-profile]: ${result.reason} — snapshot pulado, pipeline segue.\n`,
    );
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ ok: true, dest: result.dest }) + "\n");
}

if (isMainModule(import.meta.url)) {
  main();
}
