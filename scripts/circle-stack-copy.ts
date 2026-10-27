#!/usr/bin/env tsx
/**
 * circle-stack-copy.ts (#11184)
 *
 * Passos determinísticos da skill `/diaria-stack` em volta do agente
 * `stack-writer` (lógica pura em `lib/circle-stack-copy.ts`). Não publica nada
 * nem chama a rede: só lê e grava arquivos do ciclo em `data/weekly/{cycle}/`.
 *
 *   --manifest  imprime no stdout o insumo do agente (itens da seleção gravada,
 *               ferramenta de curso da Stack de cada fonte oficial, onde gravar
 *               a resposta) e para.
 *   --check     valida `_internal/circle-stack-copy.json` contra a seleção.
 *   --apply     valida e grava `opening` + `stackNote` na seleção
 *               (`_internal/circle-stack-selection.json`). Qualquer problema
 *               recusa tudo (exit 1) e a seleção fica como estava.
 *
 * A seleção precisa existir: ela é montada pelo dry-run de
 * `publish-circle-stack.ts` (Passo 1 da skill).
 *
 * Uso:
 *   npx tsx scripts/circle-stack-copy.ts --publish-monday 261026 --manifest
 *   npx tsx scripts/circle-stack-copy.ts --publish-monday 261026 --apply
 *   (opcionais: --copy-file <path>, --data-root <dir>)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { resolveWeeklyLinkedinCycle, weeklyLinkedinRelDir, currentOrPreviousMondayAAMMDD } from "./lib/weekly-linkedin-cycle.ts";
import { parseStoredCircleStackSelection } from "./publish-circle-stack.ts";
import { applyStackCopy, buildStackWriterInput, parseStackCopy } from "./lib/circle-stack-copy.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface CircleStackCopyPaths {
  cycle: string;
  selectionPath: string;
  copyPath: string;
}

/** Pure: caminhos do ciclo a partir da segunda de publicação. */
export function circleStackCopyPaths(dataRoot: string, publishMonday: string): CircleStackCopyPaths {
  const r = resolveWeeklyLinkedinCycle(publishMonday);
  if (!r) throw new Error(`--publish-monday inválido: ${publishMonday} (esperado AAMMDD)`);
  const internal = join(dataRoot, weeklyLinkedinRelDir(r.cycle), "_internal");
  return {
    cycle: r.cycle,
    selectionPath: join(internal, "circle-stack-selection.json"),
    copyPath: join(internal, "circle-stack-copy.json"),
  };
}

export async function runCircleStackCopy(argv: string[], rootDir: string = ROOT): Promise<number> {
  let publishMonday = getStringArg(argv, "publish-monday", { example: "261026" });
  if (!publishMonday) {
    publishMonday = currentOrPreviousMondayAAMMDD(new Date());
    console.error(`--publish-monday não informado — assumindo ${publishMonday} (segunda de hoje ou a anterior).`);
  }
  const dataRoot = resolve(getStringArg(argv, "data-root") ?? rootDir);
  const paths = circleStackCopyPaths(dataRoot, publishMonday);
  const copyPath = resolve(getStringArg(argv, "copy-file") ?? paths.copyPath);

  if (!existsSync(paths.selectionPath)) {
    throw new Error(
      `Seleção do ciclo ${paths.cycle} ausente (${paths.selectionPath}). Rode antes o dry-run: ` +
        `npx tsx scripts/publish-circle-stack.ts --publish-monday ${publishMonday}`,
    );
  }
  const rawSelection = readFileSync(paths.selectionPath, "utf8");
  const { selection } = parseStoredCircleStackSelection(rawSelection, paths.selectionPath, paths.cycle);

  if (hasFlag(argv, "manifest")) {
    console.log(JSON.stringify(buildStackWriterInput(selection, copyPath), null, 2));
    return 0;
  }

  const apply = hasFlag(argv, "apply");
  if (!apply && !hasFlag(argv, "check")) throw new Error("Passe --manifest, --check ou --apply.");
  if (!existsSync(copyPath)) throw new Error(`Texto do ciclo ausente (${copyPath}) — o agente stack-writer ainda não rodou.`);

  const { copy, problems } = parseStackCopy(readFileSync(copyPath, "utf8"), selection);
  if (!copy) {
    console.error(`Texto da Stack recusado (${copyPath}) — nada foi aplicado:`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  if (!apply) {
    console.log(`OK: abertura + ${copy.notes.length} descrição(ões) válidas para o ciclo ${copy.cycle}.`);
    return 0;
  }
  // Grava sobre o JSON cru (não sobre o objeto validado) para preservar campos que
  // o render não lê, como `warnings`, `generatedAt` e `titleOriginal`.
  const stored = JSON.parse(rawSelection) as typeof selection;
  writeFileAtomic(paths.selectionPath, JSON.stringify(applyStackCopy(stored, copy), null, 2));
  console.log(`Seleção atualizada: ${paths.selectionPath} (abertura + ${copy.notes.length} descrição(ões)).`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  runCircleStackCopy(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
