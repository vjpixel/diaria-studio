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
 *   --apply     valida e grava `opening` + `stackNote` (+ `video.description`,
 *               #12549) na seleção
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

import { existsSync } from "node:fs";
import { readUtf8WithContext } from "./lib/read-file-with-context.ts";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { resolveWeeklyLinkedinCycle, weeklyLinkedinRelDir, currentOrPreviousMondayAAMMDD } from "./lib/weekly-linkedin-cycle.ts";
import { parseStoredCircleStackSelection, readEdition } from "./publish-circle-stack.ts";
import {
  applyStackCopy,
  buildStackWriterInput,
  hasStackVideo,
  parseStackCopy,
  videoDestaqueFromSelection,
  type StackVideoDestaque,
} from "./lib/circle-stack-copy.ts";
import type { CircleStackSelection } from "./lib/circle-stack-render.ts";

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

/** Resultado de `resolveVideoDestaque`: o D1 comentado, ou o motivo de não haver. */
export type VideoDestaqueResolution =
  | { destaque: StackVideoDestaque; reason?: undefined }
  | { destaque: null; reason: string };

/**
 * #12549 item 6: o D1 que o vídeo da semana comenta. Primeiro na seleção; se o
 * destaque não entrou em nenhuma seção, no `02-reviewed.md` da edição do
 * vídeo. Três casos sem destaque, todos com `reason`: seleção sem vídeo; pasta
 * da edição ausente (`"sem-edicao"`) ou sem `02-reviewed.md` (`null`); edição
 * lida sem D1. Nesses casos o agente não escreve descrição e o `--apply` não a
 * exige (sem fato, sem descrição), e o CLI avisa no stderr. Exceção de LEITURA
 * da edição (arquivo existe mas não abre) NÃO vira "sem vídeo": propaga, e o
 * comando sai com erro, porque uma descrição antiga seguiria publicada sem
 * validação por causa de uma falha de disco.
 */
export function resolveVideoDestaque(sel: CircleStackSelection, dataRoot: string): VideoDestaqueResolution {
  if (!hasStackVideo(sel)) return { destaque: null, reason: "a seleção não tem vídeo da semana" };
  const fromSel = videoDestaqueFromSelection(sel);
  if (fromSel) return { destaque: fromSel };
  const date = sel.video.editionDate;
  const ed = readEdition(join(dataRoot, "data", "editions"), date); // exceção propaga (#12549 review)
  let reason: string;
  if (ed === "sem-edicao") reason = `a edição ${date} do vídeo não existe em data/editions`;
  else if (ed === null) reason = `a edição ${date} do vídeo não tem 02-reviewed.md`;
  else {
    const d1 = ed.candidates.find((c) => c.kind === "destaque" && c.destaqueN === 1);
    if (d1) return { destaque: { editionDate: date, url: d1.url, title: d1.title, body: d1.body, why: d1.why } };
    reason = `o 02-reviewed.md da edição ${date} não tem D1`;
  }
  console.error(`⚠ Vídeo da semana sem o destaque que ele comenta: ${reason}. A descrição do vídeo não será escrita nem validada.`);
  if (sel.video.description?.trim()) {
    console.error("⚠ A descrição do vídeo já gravada na seleção segue no post SEM validação contra o destaque: confira à mão.");
  }
  return { destaque: null, reason };
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
  const rawSelection = readUtf8WithContext(paths.selectionPath); // #12554
  const { selection } = parseStoredCircleStackSelection(rawSelection, paths.selectionPath, paths.cycle);

  const video = resolveVideoDestaque(selection, dataRoot);
  if (hasFlag(argv, "manifest")) {
    console.log(JSON.stringify(buildStackWriterInput(selection, copyPath, video.destaque), null, 2));
    return 0;
  }

  const apply = hasFlag(argv, "apply");
  if (!apply && !hasFlag(argv, "check")) throw new Error("Passe --manifest, --check ou --apply.");
  if (!existsSync(copyPath)) throw new Error(`Texto do ciclo ausente (${copyPath}) — o agente stack-writer ainda não rodou.`);

  const { copy, problems } = parseStackCopy(readUtf8WithContext(copyPath), selection, {
    videoDestaque: video.destaque,
    videoUnavailableReason: video.reason,
  });
  if (!copy) {
    console.error(`Texto da Stack recusado (${copyPath}) — nada foi aplicado:`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  // #12549 review: sem descrição do vídeo, a linha OK diz por quê.
  const videoPart = copy.videoDescription !== undefined ? " + descrição do vídeo" : `; sem descrição do vídeo: ${video.reason ?? "?"}`;
  if (!apply) {
    console.log(`OK: abertura + ${copy.notes.length} descrição(ões)${videoPart}, válidas para o ciclo ${copy.cycle}.`);
    return 0;
  }
  // Grava sobre o JSON cru (não sobre o objeto validado) para preservar campos que
  // o render não lê, como `warnings`, `generatedAt` e `titleOriginal`.
  const stored = JSON.parse(rawSelection) as typeof selection;
  writeFileAtomic(paths.selectionPath, JSON.stringify(applyStackCopy(stored, copy), null, 2));
  console.log(
    `Seleção atualizada: ${paths.selectionPath} (abertura + ${copy.notes.length} descrição(ões)${videoPart}).`,
  );
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
