/**
 * apply-box-slot.ts (#8990) — troca a caixa de divulgação de um slot (1 ou 2)
 * DEPOIS do stitch, sem re-rodar o Stage 2:
 *
 *   1. relê o snippet novo (`data/snippets/{file}`, mesmo `loadDivulgacaoSnippet`
 *      do stitch);
 *   2. substitui o bloco do box no `02-reviewed.md` (só a faixa do box, o
 *      resto do arquivo fica byte a byte igual — #495);
 *   3. atualiza a entry do slot em `_internal/box-selection.json`
 *      (`mode: "manual"`, `file` novo);
 *   4. IMAGEM IRMÃ do snippet (`data/snippets/{X}.jpg|.jpeg|.png`, mesmo
 *      basename do `.md`, decisão do editor 260930): preparada num temporário
 *      ANTES dos passos 2-3 (PNG convertido pra JPEG via `sharp` — o render lê
 *      dimensões de JPEG; inválida → aborta sem escrever nada), depois copiada
 *      pra `04-box-slot{N}.jpg` e, se a edição já tem `06-public-images.json`,
 *      sobe pelo MESMO `upload-images-public.ts --mode newsletter` do pipeline
 *      (md5 novo → re-upload com cache-bust) com validação do md5 da entry
 *      `box_slot{N}_image`. SEM imagem irmã → a imagem do box anterior é
 *      retirada (`04-box-slot{N}.jpg` movida pra `_internal/` e a entry
 *      `box_slot{N}_image` removida de `06-public-images.json`, com backup) —
 *      senão ela acompanharia o box novo;
 *   5. avisa quando a edição já tem rascunho no ESP (re-rodar
 *      `/diaria-5-publicacao newsletter`) ou já foi agendada/enviada
 *      (marcadores Beehiiv `05-published.json` e Kit
 *      `newsletter-kit-published.json`).
 *
 * O núcleo com I/O (`applyBoxSlotToEdition`) é reusado pelo painel Caixas do
 * Studio (botão "aplicar na edição") — mesma proteção de box editado.
 *
 * **Nunca sobrescreve um box que o editor editou à mão (#495/#7401).** O texto
 * atual do slot no `02-reviewed.md` precisa ser IGUAL ao render do snippet
 * registrado em `box-selection.json` pra esse slot. Divergiu → aborta sem
 * tocar em nada. `--force` existe só pra quando o EDITOR confirmou que o texto
 * atual pode ser descartado (ex.: ele editou o próprio snippet depois do
 * stitch e quer reaplicar).
 *
 * Exit: 0 = aplicado; 1 = uso inválido / pré-condição (sem 02-reviewed.md,
 * snippet ausente, imagem irmã inválida); 2 = recusado pela proteção do box
 * (editado, sem baseline, slot sem box).
 *
 * Uso:
 *   npx tsx scripts/apply-box-slot.ts --edition AAMMDD --slot 1|2 --file X.md [--force] [--dry-run]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isMainModule } from "./lib/cli-args.ts";
import { runTsx } from "./lib/run-tsx.ts";
import { md5OfFile } from "./lib/shared/file-md5.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
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

/**
 * Estado de publicação da edição a partir dos marcadores LOCAIS do Stage 5/6 —
 * os dois backends: `05-published.json` (Beehiiv) e
 * `newsletter-kit-published.json` (Kit), em `_internal/` ou na raiz (mesma
 * lista de `collectLocalEditionMarkers`, check-dedup-freshness.ts / #8142).
 *   - `none`   — Stage 5 ainda não rodou;
 *   - `draft`  — rascunho no ESP existe, ainda não agendado;
 *   - `locked` — agendada/enviada (`scheduled_at`/`published_at`, ou status
 *     de envio). Marcador ilegível conta como `locked` (conservador: o
 *     painel não oferece aplicar sem saber).
 */
export type EditionPublishState = "none" | "draft" | "locked";

export const PUBLISH_MARKER_RELPATHS = [
  join("_internal", "05-published.json"),
  "05-published.json",
  join("_internal", "newsletter-kit-published.json"),
  "newsletter-kit-published.json",
] as const;

const LOCKED_STATUSES = new Set(["scheduled", "published", "sent", "confirmed"]);

/** Puro: classifica os marcadores já lidos (`null` = arquivo ilegível). */
export function classifyPublishMarkers(markers: Array<Record<string, unknown> | null>): EditionPublishState {
  if (markers.length === 0) return "none";
  for (const m of markers) {
    if (m === null) return "locked";
    const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.length > 0;
    if (nonEmpty(m.scheduled_at) || nonEmpty(m.published_at)) return "locked";
    if (typeof m.status === "string" && LOCKED_STATUSES.has(m.status.toLowerCase())) return "locked";
  }
  return "draft";
}

export function readEditionPublishState(editionDir: string): EditionPublishState {
  const markers: Array<Record<string, unknown> | null> = [];
  for (const rel of PUBLISH_MARKER_RELPATHS) {
    const p = join(editionDir, rel);
    if (!existsSync(p)) continue;
    try {
      const v = JSON.parse(readFileSync(p, "utf8")) as unknown;
      markers.push(v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
    } catch {
      markers.push(null);
    }
  }
  return classifyPublishMarkers(markers);
}

/** Comando de CLI exato pra reaplicar com `--force` (o painel não tem force). */
export function applyBoxSlotForceCommand(edition: string, slot: 1 | 2, file: string): string {
  return `npx tsx scripts/apply-box-slot.ts --edition ${edition} --slot ${slot} --file ${file} --force`;
}

/**
 * Destino da imagem do slot: `copied` = imagem irmã aplicada; `removed` = sem
 * imagem irmã, a imagem do box anterior foi retirada (backup em `_internal/`);
 * `kept` = mesmo snippet reaplicado sem imagem irmã, imagem atual mantida;
 * `missing` = sem imagem irmã e o slot já não tinha imagem; `failed` = texto
 * aplicado mas o passo de imagem falhou (ver warnings).
 */
export type ApplyBoxSlotImageOutcome = "copied" | "removed" | "kept" | "missing" | "failed";

export interface ApplyBoxSlotToEditionOpts {
  /** Raiz do repo (onde vive `data/snippets/`). */
  rootDir: string;
  /** Diretório absoluto da edição (basename = AAMMDD). */
  editionDir: string;
  slot: 1 | 2;
  file: string;
  force?: boolean;
  dryRun?: boolean;
  /** Sobe as imagens da edição (default: `upload-images-public.ts --mode newsletter`). Injetável em teste. */
  runUpload?: (editionDir: string) => void;
  /** Carimbo dos backups em `_internal/` (injetável em teste). */
  now?: () => Date;
}

export type ApplyBoxSlotToEditionResult =
  | {
      ok: true;
      dryRun: boolean;
      previousFile: string | null;
      image: ApplyBoxSlotImageOutcome;
      imageSource: string | null;
      /** `true` = subiu e validou; `false` = falhou (ver warnings); `null` = não tentou. */
      uploaded: boolean | null;
      publishState: EditionPublishState;
      warnings: string[];
    }
  | {
      ok: false;
      reason: "no-reviewed" | "no-snippet" | "no-box" | "edited" | "no-baseline" | "image-failed";
      message: string;
    };

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

function defaultRunUpload(editionDir: string): void {
  runTsx(resolve(SCRIPTS_DIR, "upload-images-public.ts"), ["--edition-dir", editionDir, "--mode", "newsletter"], {
    stdout: "capture",
    cwd: resolve(SCRIPTS_DIR, ".."),
  });
}

/** Prepara a imagem num arquivo temporário (PNG → JPEG) e confere que é JPEG. */
async function prepareSnippetImage(src: string, dest: string): Promise<void> {
  if (/\.png$/i.test(src)) {
    // `04-box-slot{N}.jpg` precisa ser JPEG de verdade (isBoxSlotImagePortrait
    // lê marcadores SOF de JPEG) — PNG é convertido, não só renomeado.
    const sharp = (await import("sharp")).default;
    await sharp(src).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toFile(dest);
  } else {
    copyFileSync(src, dest);
  }
  const head = readFileSync(dest).subarray(0, 2);
  if (head.length < 2 || head[0] !== 0xff || head[1] !== 0xd8) {
    throw new Error(`${src} não é um JPEG válido`);
  }
}

/**
 * Núcleo com I/O — usado pelo CLI e pelo painel Caixas (#8990). Tudo-ou-nada
 * no que é local: a imagem irmã é preparada num temporário ANTES de gravar
 * `02-reviewed.md`/`box-selection.json`; falha de imagem → `image-failed` sem
 * escrever nada. Upload falho vira warning (texto e imagem local já
 * consistentes; `upload-images-public.ts` é idempotente e re-roda no Stage 4/5).
 */
export async function applyBoxSlotToEdition(opts: ApplyBoxSlotToEditionOpts): Promise<ApplyBoxSlotToEditionResult> {
  const { rootDir, editionDir: dir, slot, file } = opts;
  const edition = basename(dir);
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
  let previousError: string | null = null;
  if (previousFile) {
    try {
      currentRendered = loadDivulgacaoSnippet(previousFile, rootDir);
    } catch (err) {
      currentRendered = null;
      previousError = (err as Error).message;
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
  if (!res.ok) {
    if (res.reason === "no-box") return res;
    const why =
      res.reason === "no-baseline"
        ? `o box do slot ${slot} não tem snippet de referência ` +
          (previousFile ? `(caixa anterior "${previousFile}" ilegível: ${previousError ?? "vazia"})` : "(box-selection.json sem entry pro slot)") +
          " — não dá pra provar que o texto não foi editado à mão."
        : `o box do slot ${slot} no 02-reviewed.md difere do snippet registrado — provável edição do editor (#495/#7401).`;
    return {
      ok: false,
      reason: res.reason,
      message: `${why} Nada foi alterado. Se o editor confirmou que o texto atual pode ser descartado: \`${applyBoxSlotForceCommand(edition, slot, file)}\`.`,
    };
  }

  const publishState = readEditionPublishState(dir);
  const warnings: string[] = [];
  if (publishState === "draft") {
    warnings.push(
      `rascunho no ESP continua com o box antigo — re-rode \`/diaria-5-publicacao newsletter ${edition}\` pra refazer o rascunho.`,
    );
  } else if (publishState === "locked") {
    warnings.push(`edição ${edition} já agendada/enviada — a troca local NÃO chega ao que foi agendado/enviado.`);
  }

  const snippetsDir = join(rootDir, "data", "snippets");
  const sibling = findSiblingSnippetImage(file, (n) => existsSync(join(snippetsDir, n)));
  const target = join(dir, `04-box-slot${slot}.jpg`);
  const publicPath = join(dir, "06-public-images.json");
  const entryKey = `box_slot${slot}_image`;

  // Reaplicar o MESMO snippet (tipicamente `--force` depois de editar o
  // snippet) sem imagem irmã: a imagem atual do slot é do próprio box (pode ter
  // sido posta à mão) — mantém, não aposenta.
  const reapplySame = previousFile === file;
  const readSlotEntry = (): PublicImageEntry | undefined => {
    if (!existsSync(publicPath)) return undefined;
    try {
      const j = JSON.parse(readFileSync(publicPath, "utf8")) as { images?: Record<string, PublicImageEntry> };
      return ((j.images ?? j) as Record<string, PublicImageEntry>)[entryKey];
    } catch {
      return undefined;
    }
  };
  const noSiblingMsg = `sem imagem irmã do snippet (data/snippets/${siblingImageCandidates(file).join(" | ")})`;

  if (opts.dryRun) {
    let image: ApplyBoxSlotImageOutcome = "missing";
    if (sibling) {
      image = "copied";
    } else {
      const entry = readSlotEntry();
      const present: string[] = [];
      if (existsSync(target)) present.push(`04-box-slot${slot}.jpg`);
      if (entry) present.push(`entry ${entryKey} (${entry.cloudflare_url || entry.url || "sem URL"})`);
      if (present.length && reapplySame) {
        image = "kept";
        warnings.push(`${noSiblingMsg} — mesmo snippet reaplicado: imagem atual do slot ${slot} seria mantida.`);
      } else if (present.length) {
        image = "removed";
        warnings.push(`${noSiblingMsg} — seria retirado: ${present.join("; ")}.`);
      }
    }
    return { ok: true, dryRun: true, previousFile, image, imageSource: sibling, uploaded: null, publishState, warnings };
  }

  // 1) imagem num temporário ANTES de qualquer escrita (falha → nada escrito).
  const pending = join(dir, "_internal", `.04-box-slot${slot}.pending.jpg`);
  if (sibling) {
    try {
      mkdirSync(dirname(pending), { recursive: true });
      await prepareSnippetImage(join(snippetsDir, sibling), pending);
    } catch (err) {
      rmSync(pending, { force: true });
      return {
        ok: false,
        reason: "image-failed",
        message: `imagem irmã data/snippets/${sibling} inválida (${(err as Error).message.split("\n")[0]}) — nada foi alterado. Corrija/remova a imagem e aplique de novo.`,
      };
    }
  }

  // 2) texto + seleção (atômico).
  writeFileAtomic(reviewedPath, res.reviewedMd);
  writeFileAtomic(selectionPath, JSON.stringify(res.selection, null, 2));

  // 3) imagem — o texto já está aplicado: falha aqui vira warning explícito,
  // nunca exceção crua (o caller precisa saber que o texto MUDOU).
  let uploaded: boolean | null = null;
  let image: ApplyBoxSlotImageOutcome = "missing";
  try {
    if (sibling) {
      copyFileSync(pending, target);
      rmSync(pending, { force: true });
      image = "copied";
      if (!existsSync(publicPath)) {
        warnings.push(`06-public-images.json ainda não existe — 04-box-slot${slot}.jpg sobe no upload normal do pipeline (Stage 4/5).`);
      } else {
        const manual = `npx tsx scripts/upload-images-public.ts --edition-dir ${dir} --mode newsletter`;
        try {
          (opts.runUpload ?? defaultRunUpload)(dir);
          uploaded = isBoxSlotImageUploaded(JSON.parse(readFileSync(publicPath, "utf8")), slot, md5OfFile(target));
          if (!uploaded) {
            warnings.push(`upload rodou mas ${entryKey} em 06-public-images.json não bate com o md5 local — rode \`${manual}\`.`);
          }
        } catch (err) {
          uploaded = false;
          warnings.push(`upload da imagem falhou (${(err as Error).message.split("\n")[0]}) — rode \`${manual}\`.`);
        }
      }
    } else if (reapplySame && (existsSync(target) || readSlotEntry())) {
      image = "kept";
      warnings.push(`${noSiblingMsg} — mesmo snippet reaplicado: imagem atual do slot ${slot} mantida.`);
    } else {
      // Sem imagem irmã: a imagem do box ANTERIOR não pode acompanhar o box
      // novo. O render lê `box_slot{N}_image` de 06-public-images.json (e o
      // uploader mantém a URL antiga se o .jpg sumir) — retira os dois, com backup.
      const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
      const done: string[] = [];
      if (existsSync(target)) {
        const bak = join(dir, "_internal", `04-box-slot${slot}.replaced-${stamp}.jpg`);
        mkdirSync(dirname(bak), { recursive: true });
        renameSync(target, bak);
        done.push(`04-box-slot${slot}.jpg movida pra _internal/${basename(bak)}`);
      }
      if (existsSync(publicPath)) {
        const j = JSON.parse(readFileSync(publicPath, "utf8")) as Record<string, unknown> & { images?: Record<string, unknown> };
        const map = (j.images ?? j) as Record<string, unknown>;
        if (map[entryKey] !== undefined) {
          const bak = join(dir, "_internal", `${entryKey}.replaced-${stamp}.json`);
          writeFileSync(bak, JSON.stringify({ [entryKey]: map[entryKey] }, null, 2));
          delete map[entryKey];
          writeFileAtomic(publicPath, JSON.stringify(j, null, 2));
          done.push(`entry ${entryKey} removida de 06-public-images.json (backup em _internal/${basename(bak)})`);
        }
      }
      image = done.length ? "removed" : "missing";
      warnings.push(`${noSiblingMsg} — ` + (done.length ? `slot ${slot} fica sem imagem: ${done.join("; ")}.` : `slot ${slot} segue sem imagem.`));
    }
  } catch (err) {
    rmSync(pending, { force: true });
    image = "failed";
    warnings.push(`texto aplicado, imagem não: ${(err as Error).message.split("\n")[0]} — confira 04-box-slot${slot}.jpg e ${entryKey} em 06-public-images.json à mão.`);
  }
  return { ok: true, dryRun: false, previousFile, image, imageSource: sibling, uploaded, publishState, warnings };
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
    // 2 = recusa por proteção do box (edited/no-baseline/no-box); 1 = pré-condição/erro.
    process.exit(res.reason === "edited" || res.reason === "no-baseline" || res.reason === "no-box" ? 2 : 1);
  }
  for (const w of res.warnings) console.warn(`apply-box-slot: ⚠ ${w}`);
  const img =
    res.image === "copied"
      ? `imagem ${res.imageSource} → 04-box-slot${slot}.jpg${res.uploaded === true ? " (upload validado)" : ""}`
      : res.image === "removed"
        ? "imagem anterior retirada"
        : res.image === "kept"
          ? "imagem atual mantida"
          : res.image === "failed"
            ? "imagem NÃO aplicada"
            : "sem imagem";
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
