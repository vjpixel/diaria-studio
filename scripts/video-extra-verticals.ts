#!/usr/bin/env node
/**
 * scripts/video-extra-verticals.ts (#11900)
 *
 * Plano de publicação das verticais EXTRAS da edição: as sequências de corte
 * do `blocks.json` da montagem (`_internal/video-montagem/blocks.json`,
 * #11898). Para cada uma, o dia (k-ésimo dia útil depois da edição), o
 * horário (o seguinte ao da vertical principal daquele dia em
 * `publishing.shorts.schedule.rotation_times`), título (`screenTitle` da
 * sequência), gancho (`hook`, ou o `resumo_curto` dela) e o comando do modo
 * corte do `publish-shorts.ts`. Regras e premissas:
 * `scripts/lib/diaria/extra-verticals.ts`.
 *
 * Só planeja: não publica, não grava nada. O comando impresso é o DRY-RUN do
 * modo corte (que registra `data/cortes/{slug}/corte.json`); a publicação é
 * esse comando com `--publish --confirm-publish {data}`, depois do "pode
 * publicar" do editor (`/diaria-publica-video`). Com
 * `publishing.shorts.corte_via_timer`, Instagram, perfil do LinkedIn e
 * Threads do corte saem pelo timer do 300 (`Diaria-Shorts-Cortes`), só
 * depois desse `--publish` confirmado e só nos destinos do `--only` dele
 * (#11912): o dry-run nunca autoriza o timer.
 *
 * Uso: npx tsx scripts/video-extra-verticals.ts AAMMDD [--blocks PATH] [--drive-ids corte=ID,...] [--video-dir DIR]
 *   --blocks:    default `{edição}/_internal/video-montagem/blocks.json`
 *   --drive-ids: id no Drive do export de cada corte (`…_V{n}-{corte}.mp4`
 *                de `Final/`). PREFERIDO: o comando sai com `--from-drive`,
 *                que baixa para `data/cortes/{slug}/` e acompanha o timer do
 *                300 (#11906). Vence o `--video-dir` para o mesmo corte.
 *   --video-dir: pasta local com os exports (a `Final/` da edição no Drive
 *                for desktop); acha `…_V{n}-{corte}.mp4` de cada corte. Fora
 *                de `data/` (ex.: `G:/` no Neo), o comando sai com `--video`
 *                e um `[aviso]`: o 300 não acha esse caminho e Instagram,
 *                perfil do LinkedIn e Threads do corte caem em `missing-video`.
 *
 * Saída: JSON no stdout (`{ edition, extras: ExtraVerticalPlan[] }`).
 * Exit: 0 = plano pronto (inclusive sem extras); 1 = algum extra com
 * `problems` (o comando dele sai null); 2 = uso, blocks.json ausente/inválido.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { loadShortScheduleConfig } from "./lib/diaria/short-video.ts";
import { parseBlocksFile } from "./lib/diaria/video-montage.ts";
import { extraVerticalSpecs, matchCorteExports, parseDriveIds, planExtraVerticals } from "./lib/diaria/extra-verticals.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "uso: video-extra-verticals.ts AAMMDD [--blocks PATH] [--drive-ids corte=ID,...] [--video-dir DIR]";

export function blocksPathFor(edition: string): string {
  return join(editionDirFor(edition), "_internal", "video-montagem", "blocks.json");
}

export function main(argv: string[] = process.argv.slice(2), opts: { root?: string; dataDir?: string } = {}): number {
  const root = opts.root ?? ROOT;
  const dataDir = opts.dataDir ?? join(root, "data");
  const { values, positional } = parseArgs(argv);
  const edition = positional[0];
  if (!edition || !/^\d{6}$/.test(edition)) {
    console.error(USAGE);
    return 2;
  }
  const blocksPath = resolve(values["blocks"] ?? blocksPathFor(edition));
  if (!existsSync(blocksPath)) {
    console.error(`blocks.json ausente: ${blocksPath} (rode a /diaria-video-montagem antes, ou passe --blocks)`);
    return 2;
  }
  const parsed = parseBlocksFile(JSON.parse(readFileSync(blocksPath, "utf8")));
  if (!parsed.ok) {
    console.error(`blocks.json inválido:\n  - ${parsed.errors.join("\n  - ")}`);
    return 2;
  }
  if (parsed.file.edition !== edition) {
    console.error(`blocks.json é da edição ${parsed.file.edition}, não ${edition}`);
    return 2;
  }
  const sched = loadShortScheduleConfig(JSON.parse(readFileSync(join(root, "platform.config.json"), "utf8")));
  const cortes = extraVerticalSpecs(parsed.file).map((s) => s.corte as string);
  let videos: Record<string, string> = {};
  let driveIds: Record<string, string> = {};
  const extraWarnings: string[] = [];
  if (values["drive-ids"] !== undefined) {
    const d = parseDriveIds(values["drive-ids"]);
    if (!d.ok) {
      console.error(d.error);
      return 2;
    }
    driveIds = d.ids;
    for (const c of Object.keys(driveIds)) if (!cortes.includes(c)) extraWarnings.push(`--drive-ids: corte "${c}" não está no blocks.json (cortes: ${cortes.join(", ") || "nenhum"}); ignorado`);
  }
  const dir = values["video-dir"];
  if (dir !== undefined && cortes.length) {
    const abs = resolve(dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      console.error(`--video-dir não é uma pasta: ${abs}`);
      return 2;
    }
    const files = readdirSync(abs).map((name) => ({ name, path: join(abs, name) }));
    const m = matchCorteExports(cortes, files);
    videos = m.videos;
    for (const [corte, names] of Object.entries(m.ambiguous)) extraWarnings.push(`corte "${corte}": ${names.length} exports em ${abs} (${names.join(", ")}); escolha um e passe --video no comando`);
  }
  const extras = planExtraVerticals({ edition, file: parsed.file, sched, videos, driveIds, dataDir });
  for (const w of extraWarnings) console.error(`[aviso] ${w}`);
  for (const x of extras) {
    for (const p of x.premises) console.error(`[premissa] ${x.corte}: ${p}`);
    for (const w of x.warnings) console.error(`[aviso] ${x.corte}: ${w}`);
    for (const p of x.problems) console.error(`[erro] ${x.corte}: ${p}`);
  }
  if (!extras.length) console.error(`[ok] edição ${edition} sem vertical extra (nenhuma sequência com "corte" no blocks.json)`);
  console.log(JSON.stringify({ edition, extras }, null, 2));
  return extras.some((x) => x.problems.length) ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  runCli(() => main(), { onError: (e) => console.error("video-extra-verticals:", e instanceof Error ? e.message : e) });
}
