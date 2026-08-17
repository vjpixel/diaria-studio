/**
 * measure-control-edition.ts (#5547)
 *
 * CLI do extrator de 4 métricas por stage para o instrumento de medição da
 * edição de controle (#5419). Lê `_internal/stage-status.json` de uma edição
 * já rodada (via `scripts/lib/control-edition-metrics.ts`) e emite um JSON
 * `ControlEditionMeasurement` com, POR STAGE: tokens de entrada, turnos,
 * contexto médio por turno e `subagent_tokens` (`null` explícito quando
 * indisponível — nunca omitido, nunca zerado).
 *
 * Roda o guard de ruído concorrente (#5547 item 3,
 * `scripts/lib/control-edition-guard.ts`) e embute o veredito
 * (`contamination`) no output — nunca aceita/descarta uma medição em
 * silêncio; quem consumir o JSON decide o que fazer com
 * `contamination.contaminated`.
 *
 * Uso:
 *   npx tsx scripts/measure-control-edition.ts --edition AAMMDD [--out path]
 *   npx tsx scripts/measure-control-edition.ts --edition AAMMDD --session-id <uuid>
 *   npx tsx scripts/measure-control-edition.ts --edition AAMMDD --all-sessions
 *
 * Sem `--session-id`, usa `CLAUDE_CODE_SESSION_ID` do ambiente (mesmo
 * default de `capture-stage-usage.ts`, #5413) — rodar este script via Bash
 * tool DE DENTRO da mesma sessão que executou (ou está executando) a edição
 * é o caso recomendado: dá o cross-check mais preciso entre `tokens_in`
 * persistido e `turns` re-derivado (mesma sessão, mesma janela).
 *
 * Requer sessão LOCAL (`~/.claude/projects/`) — ver
 * `scripts/lib/session-transcript.ts`. Sem isso, `turns`/`avg_context_per_turn`
 * saem `null` com motivo explícito; `tokens_in`/`subagent_tokens_*` ainda
 * saem preenchidos se já estavam em `stage-status.json` de uma captura
 * anterior.
 */

import { existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseArgsLib, isMainModule } from "./lib/cli-args.ts";
import { loadDoc } from "./update-stage-status.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { editionsRoot } from "./lib/edition-paths.ts";
import { currentSessionId, resolveTranscriptsDir } from "./lib/session-transcript.ts";
import {
  buildControlEditionMeasurement,
  type ControlEditionMeasurementWithContamination,
} from "./lib/control-edition-metrics.ts";
import { assessConcurrentNoise } from "./lib/control-edition-guard.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type MeasureResult = ControlEditionMeasurementWithContamination;

async function main(): Promise<void> {
  const { values, flags } = parseArgsLib(process.argv.slice(2));
  const edition = values["edition"];
  if (!edition) {
    console.error(
      "Uso: npx tsx scripts/measure-control-edition.ts --edition AAMMDD [--out <path>] " +
        "[--session-id <id>] [--all-sessions] [--transcripts-dir <path>] [--repo-root <path>]",
    );
    process.exit(2);
  }

  const repoRoot = resolve(ROOT, values["repo-root"] ?? ".");
  const editionsDirsMap = enumerateEditionDirs(resolve(repoRoot, editionsRoot()));
  const editionDirPath = editionsDirsMap.get(edition);
  if (!editionDirPath) {
    console.log(
      JSON.stringify({ error: "edition_not_found", edition, editions_root: editionsRoot() }),
    );
    process.exit(1);
    return;
  }

  const doc = loadDoc(editionDirPath, edition);
  const transcriptsDir = values["transcripts-dir"] ?? resolveTranscriptsDir(repoRoot);
  const transcriptsDirExists = existsSync(transcriptsDir);
  const sessionId = flags.has("all-sessions") ? null : (values["session-id"] ?? currentSessionId());

  const measurement = buildControlEditionMeasurement(doc, transcriptsDir, transcriptsDirExists, sessionId);
  const contamination = assessConcurrentNoise(doc, repoRoot, { excludeSessionId: sessionId ?? undefined });

  const result: MeasureResult = { ...measurement, contamination };

  const json = JSON.stringify(result, null, 2);
  if (values["out"]) {
    const outPath = resolve(ROOT, values["out"]);
    writeFileSync(outPath, json, "utf8");
    console.log(JSON.stringify({ written: outPath, edition, contaminated: contamination.contaminated }));
  } else {
    console.log(json);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
