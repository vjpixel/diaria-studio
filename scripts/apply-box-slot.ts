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
 *   4. (#8990, decisão do editor 260930) copia a IMAGEM IRMÃ do snippet
 *      (`data/snippets/{X}.jpg|.jpeg|.png`, mesmo basename do `.md`) pra
 *      `04-box-slot{N}.jpg` da edição (PNG convertido pra JPEG via `sharp` —
 *      o render lê dimensões de JPEG) e, se a edição já tem
 *      `06-public-images.json`, roda o MESMO `upload-images-public.ts --mode
 *      newsletter` do pipeline (md5 drift → re-upload com cache-bust) e valida
 *      que a entry `box_slot{N}_image` ficou com o md5 do arquivo local.
 *      Imagem irmã ausente → AVISO (não erro), `04-box-slot{N}.jpg` atual fica.
 *
 * O núcleo com I/O (`applyBoxSlotToEdition`) é reusado pelo painel Caixas do
 * Studio (botão "aplicar na edição", #8990) — mesma proteção de box editado.
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
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isMainModule } from "./lib/cli-args.ts";
import { runTsx } from "./lib/run-tsx.ts";
import { md5OfFile } from "./lib/shared/file-md5.ts";
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

// ── #8990: imagem irmã do snippet + núcleo com I/O ──────────────────────

/** Extensões aceitas pra imagem irmã, em ordem de preferência. */
export const SNIPPET_IMAGE_EXTS = [".jpg", ".jpeg", ".png"] as const;

/** Nomes candidatos da imagem irmã de um snippet (`X.md` → `X.jpg`, …). Puro. */
export function siblingImageCandidates(snippetFile: string): string[] {
  const base = snippetFile.replace(/\.md$/i, "");
  return SNIPPET_IMAGE_EXTS.map((ext) => `${base}${ext}`);
}

/** 1º candidato que existe (`exists` recebe o NOME relativo a `data/snippets/`). Puro. */
export function findSiblingSnippetImage(snippetFile: string, exists: (name: string) => boolean): string | null {
  return siblingImageCandidates(snippetFile).find((n) => exists(n)) ?? null;
}

type PublicImageEntry = { md5?: string; url?: string; cloudflare_url?: string };

/** `06-public-images.json` já aponta `box_slot{N}_image` pros bytes locais (md5)? Puro. */
export function isBoxSlotImageUploaded(publicImages: unknown, slot: 1 | 2, localMd5: string): boolean {
  const j = publicImages as { images?: Record<string, PublicImageEntry> } | null;
  const map = (j?.images ?? (j as unknown as Record<string, PublicImageEntry> | null)) ?? null;
  const e = map?.[`box_slot${slot}_image`];
  return !!e && e.md5 === localMd5 && !!(e.cloudflare_url || e.url);
}

export interface ApplyBoxSlotToEditionOpts {
  /** Raiz do repo (onde vive `data/snippets/`). */
  rootDir: string;
  /** Diretório absoluto da edição. */
  editionDir: string;
  slot: 1 | 2;
  file: string;
  force?: boolean;
  dryRun?: boolean;
  /** Sobe as imagens da edição (default: `upload-images-public.ts --mode newsletter`). Injetável em teste. */
  runUpload?: (editionDir: string) => void;
}

export type ApplyBoxSlotToEditionResult =
  | {
      ok: true;
      dryRun: boolean;
      previousFile: string | null;
      /** `copied` = imagem irmã copiada (ou seria, em dry-run); `missing` = sem imagem irmã (aviso). */
      image: "copied" | "missing";
      imageSource: string | null;
      /** `true` = subiu e validou; `false` = falhou (ver warnings); `null` = não tentou. */
      uploaded: boolean | null;
      warnings: string[];
    }
  | { ok: false; reason: "no-reviewed" | "no-snippet" | "no-box" | "edited" | "no-baseline"; message: string };

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

function defaultRunUpload(editionDir: string): void {
  runTsx(resolve(SCRIPTS_DIR, "upload-images-public.ts"), ["--edition-dir", editionDir, "--mode", "newsletter"], {
    stdout: "capture",
    cwd: resolve(SCRIPTS_DIR, ".."),
  });
}

async function copySnippetImage(src: string, dest: string): Promise<void> {
  if (/\.png$/i.test(src)) {
    // `04-box-slot{N}.jpg` precisa ser JPEG de verdade (isBoxSlotImagePortrait
    // lê marcadores SOF de JPEG) — PNG é convertido, não só renomeado.
    const sharp = (await import("sharp")).default;
    await sharp(src).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toFile(dest);
  } else {
    copyFileSync(src, dest);
  }
}

/**
 * Núcleo com I/O — usado pelo CLI e pelo painel Caixas (#8990). Retorna
 * `ok:false` com `reason` nas condições esperadas (nada é escrito nesse caso);
 * upload falho vira warning, não erro (texto já trocado e imagem local certa —
 * `upload-images-public.ts` é idempotente e re-roda no Stage 4/5).
 */
export async function applyBoxSlotToEdition(opts: ApplyBoxSlotToEditionOpts): Promise<ApplyBoxSlotToEditionResult> {
  const { rootDir, editionDir: dir, slot, file } = opts;
  const reviewedPath = join(dir, "02-reviewed.md");
  const selectionPath = join(dir, "_internal", "box-selection.json");
  if (!existsSync(reviewedPath)) {
    return { ok: false, reason: "no-reviewed", message: `${reviewedPath} não existe (Stage 2 ainda não rodou?)` };
  }
  const selection: BoxSelectionEntry[] = existsSync(selectionPath)
    ? (JSON.parse(readFileSync(selectionPath, "utf8")) as BoxSelectionEntry[])
    : [];
  const previousFile = selection.find((e) => e.slot === slot)?.file ?? null;
  let currentRendered: string | null = null;
  if (previousFile) {
    try {
      currentRendered = loadDivulgacaoSnippet(previousFile, rootDir);
    } catch {
      currentRendered = null;
    }
  }
  let newRendered: string | null;
  try {
    newRendered = loadDivulgacaoSnippet(file, rootDir);
  } catch (err) {
    return { ok: false, reason: "no-snippet", message: (err as Error).message };
  }
  const res = applyBoxSlot({
    reviewedMd: readFileSync(reviewedPath, "utf8"),
    selection,
    slot,
    newFile: file,
    newRendered: newRendered!,
    currentRendered,
    force: opts.force,
  });
  if (!res.ok) return res;

  const snippetsDir = join(rootDir, "data", "snippets");
  const sibling = findSiblingSnippetImage(file, (n) => existsSync(join(snippetsDir, n)));
  const target = join(dir, `04-box-slot${slot}.jpg`);
  const warnings: string[] = [];
  if (!sibling) {
    warnings.push(
      `sem imagem irmã do snippet (data/snippets/${siblingImageCandidates(file).join(" | ")}) — ` +
        (existsSync(target)
          ? `04-box-slot${slot}.jpg ATUAL mantida (pode ser a imagem do box anterior: confira ou remova à mão).`
          : `slot ${slot} segue sem imagem.`),
    );
  }
  if (opts.dryRun) {
    return { ok: true, dryRun: true, previousFile, image: sibling ? "copied" : "missing", imageSource: sibling, uploaded: null, warnings };
  }

  writeFileSync(reviewedPath, res.reviewedMd);
  writeFileSync(selectionPath, JSON.stringify(res.selection, null, 2));

  let uploaded: boolean | null = null;
  if (sibling) {
    await copySnippetImage(join(snippetsDir, sibling), target);
    const publicPath = join(dir, "06-public-images.json");
    if (!existsSync(publicPath)) {
      warnings.push(`06-public-images.json ainda não existe — 04-box-slot${slot}.jpg sobe no upload normal do pipeline (Stage 4/5).`);
    } else {
      const manual = `npx tsx scripts/upload-images-public.ts --edition-dir ${dir} --mode newsletter`;
      try {
        (opts.runUpload ?? defaultRunUpload)(dir);
        uploaded = isBoxSlotImageUploaded(JSON.parse(readFileSync(publicPath, "utf8")), slot, md5OfFile(target));
        if (!uploaded) {
          warnings.push(`upload rodou mas box_slot${slot}_image em 06-public-images.json não bate com o md5 local — rode \`${manual}\`.`);
        }
      } catch (err) {
        uploaded = false;
        warnings.push(`upload da imagem falhou (${(err as Error).message.split("\n")[0]}) — rode \`${manual}\`.`);
      }
    }
  }
  return { ok: true, dryRun: false, previousFile, image: sibling ? "copied" : "missing", imageSource: sibling, uploaded, warnings };
}

async function main(): Promise<void> {
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
  const res = await applyBoxSlotToEdition({
    rootDir: resolve(SCRIPTS_DIR, ".."),
    editionDir: resolveEditionDir(values.edition),
    slot,
    file: values.file,
    force: values.force,
    dryRun: values["dry-run"],
  });
  if (!res.ok) {
    console.error(`apply-box-slot: abortado (${res.reason}) — ${res.message}`);
    process.exit(res.reason === "no-reviewed" || res.reason === "no-snippet" ? 1 : 2);
  }
  for (const w of res.warnings) console.warn(`apply-box-slot: ⚠ ${w}`);
  const img =
    res.image === "copied"
      ? `imagem ${res.imageSource} → 04-box-slot${slot}.jpg${res.uploaded === true ? " (upload validado)" : ""}`
      : "imagem não tocada";
  console.log(
    `apply-box-slot: ${res.dryRun ? "dry-run — " : ""}slot ${slot}: ${res.previousFile ?? "(nenhum)"} → ${values.file} (02-reviewed.md + box-selection.json; ${img}).`,
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`apply-box-slot: ${(err as Error).message}`);
    process.exit(1);
  });
}
