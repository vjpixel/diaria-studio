/**
 * apply-box-slot.ts (#8990, fatia (a)) — troca a caixa de divulgação de um
 * slot (1 ou 2) DEPOIS do stitch, sem re-rodar o Stage 2:
 *
 *   1. relê o snippet novo (`data/snippets/{file}`, mesmo `loadDivulgacaoSnippet`
 *      do stitch);
 *   2. substitui o bloco do box no `02-reviewed.md` (só a faixa do box, o
 *      resto do arquivo fica byte a byte igual — #495);
 *   3. atualiza a entry do slot em `_internal/box-selection.json`
 *      (`mode: "manual"`, `file` novo).
 *
 * Fora de escopo (decisão do editor, briefing overnight 260930b): imagem
 * `04-box-slot{N}.jpg` e aviso no painel Caixas — seguem abertos no #8990.
 *
 * **Nunca sobrescreve um box que o editor editou à mão (#495/#7401).** O texto
 * atual do slot no `02-reviewed.md` precisa ser IGUAL ao render do snippet
 * registrado em `box-selection.json` pra esse slot. Divergiu → aborta (exit 2)
 * sem tocar em nada. `--force` existe só pra quando o EDITOR confirmou que o
 * texto atual pode ser descartado (ex.: ele editou o próprio snippet depois do
 * stitch e quer reaplicar).
 *
 * Uso:
 *   npx tsx scripts/apply-box-slot.ts --edition AAMMDD --slot 1|2 --file X.md [--force] [--dry-run]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "./lib/cli-args.ts";
import { editionDir as resolveEditionDir } from "./lib/edition-paths.ts";
import { locateBoxDivulgacaoRange } from "./lib/newsletter-parse.ts";
import { loadDivulgacaoSnippet } from "./stitch-newsletter.ts";

export interface BoxSelectionEntry {
  slot: number;
  mode: string;
  file: string | null;
  [k: string]: unknown;
}

export interface ApplyBoxSlotInput {
  reviewedMd: string;
  selection: BoxSelectionEntry[];
  slot: 1 | 2;
  newFile: string;
  /** Render (`loadDivulgacaoSnippet`) do snippet novo. */
  newRendered: string;
  /** Render do snippet registrado hoje no slot; `null` = sem registro/arquivo. */
  currentRendered: string | null;
  force?: boolean;
}

export type ApplyBoxSlotResult =
  | { ok: true; reviewedMd: string; selection: BoxSelectionEntry[]; unchanged: boolean }
  | { ok: false; reason: "no-box" | "edited" | "no-baseline"; message: string };

const norm = (s: string): string => s.replace(/\r\n/g, "\n").trim();

/** Núcleo puro — sem I/O. */
export function applyBoxSlot(input: ApplyBoxSlotInput): ApplyBoxSlotResult {
  const range = locateBoxDivulgacaoRange(input.reviewedMd, input.slot);
  if (!range) {
    return {
      ok: false,
      reason: "no-box",
      message: `slot ${input.slot} não tem box no 02-reviewed.md — inserir box novo está fora do escopo (#8990); edite à mão.`,
    };
  }
  const currentText = input.reviewedMd.slice(range.start, range.end);
  if (!input.force) {
    if (input.currentRendered === null) {
      return {
        ok: false,
        reason: "no-baseline",
        message: `slot ${input.slot} sem snippet registrado em box-selection.json (ou arquivo ausente) — não dá pra provar que o box não foi editado. Use --force se o editor confirmou.`,
      };
    }
    if (norm(currentText) !== norm(input.currentRendered)) {
      return {
        ok: false,
        reason: "edited",
        message: `box do slot ${input.slot} no 02-reviewed.md difere do snippet registrado — provável edição do editor (#495/#7401). Nada foi alterado. Use --force só se o editor confirmou que o texto atual pode ser descartado.`,
      };
    }
  }
  const replacement = norm(input.newRendered);
  const reviewedMd = input.reviewedMd.slice(0, range.start) + replacement + input.reviewedMd.slice(range.end);
  let found = false;
  const selection = input.selection.map((e) => {
    if (e.slot !== input.slot) return e;
    found = true;
    const { rejectedFile: _r, rejectReason: _rr, ...rest } = e;
    return { ...rest, mode: "manual", file: input.newFile };
  });
  if (!found) {
    selection.push({ slot: input.slot, mode: "manual", file: input.newFile, nome: null, score: null, trend: null, editionsAppeared: null, seasonal: null });
    selection.sort((a, b) => a.slot - b.slot);
  }
  return { ok: true, reviewedMd, selection, unchanged: reviewedMd === input.reviewedMd };
}

function main(): void {
  const { values } = parseArgs({
    options: {
      edition: { type: "string" },
      slot: { type: "string" },
      file: { type: "string" },
      force: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const slotNum = Number(values.slot);
  if (!values.edition || !/^\d{6}$/.test(values.edition) || (slotNum !== 1 && slotNum !== 2) || !values.file) {
    console.error("uso: apply-box-slot.ts --edition AAMMDD --slot 1|2 --file X.md [--force] [--dry-run]");
    process.exit(1);
  }
  const slot = slotNum as 1 | 2;
  const dir = resolveEditionDir(values.edition);
  const reviewedPath = join(dir, "02-reviewed.md");
  const selectionPath = join(dir, "_internal", "box-selection.json");
  if (!existsSync(reviewedPath)) {
    console.error(`apply-box-slot: ${reviewedPath} não existe (Stage 2 ainda não rodou?)`);
    process.exit(1);
  }
  const selection: BoxSelectionEntry[] = existsSync(selectionPath)
    ? (JSON.parse(readFileSync(selectionPath, "utf8")) as BoxSelectionEntry[])
    : [];
  const currentFile = selection.find((e) => e.slot === slot)?.file ?? null;
  let currentRendered: string | null = null;
  if (currentFile) {
    try {
      currentRendered = loadDivulgacaoSnippet(currentFile);
    } catch {
      currentRendered = null;
    }
  }
  const newRendered = loadDivulgacaoSnippet(values.file); // lança se ausente
  const res = applyBoxSlot({
    reviewedMd: readFileSync(reviewedPath, "utf8"),
    selection,
    slot,
    newFile: values.file,
    newRendered: newRendered!,
    currentRendered,
    force: values.force,
  });
  if (!res.ok) {
    console.error(`apply-box-slot: abortado (${res.reason}) — ${res.message}`);
    process.exit(2);
  }
  if (values["dry-run"]) {
    console.log(`apply-box-slot: dry-run — slot ${slot}: ${currentFile ?? "(nenhum)"} → ${values.file}`);
    return;
  }
  writeFileSync(reviewedPath, res.reviewedMd);
  writeFileSync(selectionPath, JSON.stringify(res.selection, null, 2));
  console.log(
    `apply-box-slot: slot ${slot}: ${currentFile ?? "(nenhum)"} → ${values.file} (02-reviewed.md + box-selection.json). Imagem 04-box-slot${slot}.jpg NÃO foi tocada (#8990).`,
  );
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`apply-box-slot: ${(err as Error).message}`);
    process.exit(1);
  }
}
