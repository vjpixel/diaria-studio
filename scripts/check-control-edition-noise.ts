/**
 * check-control-edition-noise.ts (#5547 item 3)
 *
 * CLI standalone do guard de ruído concorrente
 * (`scripts/lib/control-edition-guard.ts`). Dois modos de uso:
 *
 *   # Preflight — ANTES de começar a rodar uma edição de controle (baseline
 *   # ou tratamento), confirma que não há overnight/develop ativo
 *   # na máquina agora:
 *   npx tsx scripts/check-control-edition-noise.ts
 *
 *   # Pós-hoc — depois de uma edição já capturada, combina o preflight com
 *   # o sinal de contaminação por transcript (#5413) já persistido em
 *   # stage-status.json:
 *   npx tsx scripts/check-control-edition-noise.ts --edition AAMMDD
 *
 * `measure-control-edition.ts` já roda este guard internamente e embute o
 * resultado em `contamination` — este CLI existe para poder rodar o
 * preflight ISOLADO, antes de a edição sequer começar (quando ainda não há
 * `stage-status.json` para ler).
 *
 * Exit code: 0 sempre (guard é informativo, nunca bloqueia — a decisão de
 * prosseguir é do editor). `clean`/`contaminated` no JSON de saída é o sinal.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseArgsLib, isMainModule } from "./lib/cli-args.ts";
import { loadDoc } from "./update-stage-status.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { editionsRoot } from "./lib/edition-paths.ts";
import { makeInitialDoc } from "./update-stage-status.ts";
import { assessConcurrentNoise } from "./lib/control-edition-guard.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function main(): void {
  const { values } = parseArgsLib(process.argv.slice(2));
  const repoRoot = resolve(ROOT, values["repo-root"] ?? ".");
  const edition = values["edition"];

  let doc;
  let mode: "preflight_only" | "preflight_and_transcript";
  if (edition) {
    const editionsDirsMap = enumerateEditionDirs(resolve(repoRoot, editionsRoot()));
    const editionDirPath = editionsDirsMap.get(edition);
    if (!editionDirPath) {
      console.log(JSON.stringify({ error: "edition_not_found", edition }));
      process.exit(1);
      return;
    }
    doc = loadDoc(editionDirPath, edition);
    mode = "preflight_and_transcript";
  } else {
    // Sem edição: só o check de registro (preflight puro, antes de a edição
    // existir). `makeInitialDoc` com rows vazias equivalente daria stages
    // "without_capture" pra todos — não é o que queremos comunicar aqui, então
    // reportamos só o registry_check nesse modo.
    doc = makeInitialDoc("preflight");
    mode = "preflight_only";
  }

  const verdict = assessConcurrentNoise(doc, repoRoot, { excludeSessionId: values["session-id"] });

  const output =
    mode === "preflight_only"
      ? {
          mode,
          contaminated: !verdict.registry_check.clean,
          registry_check: verdict.registry_check,
          reasons: verdict.reasons,
        }
      : { mode, ...verdict };

  console.log(JSON.stringify(output, null, 2));
}

if (isMainModule(import.meta.url)) {
  main();
}
