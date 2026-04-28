/**
 * eai-compose.ts (#110 fix 2)
 *
 * Substitui o agent `eai-composer` por script TS determinístico.
 * Mata silent failure: orchestrator chama via Bash (não Agent), sem
 * dependência de Task tool aninhado.
 *
 * Trade-off vs agent LLM: credit line e SD prompt são template-based
 * (não natural-language poetry). Editor pode polir 01-eai.md no gate
 * se quiser.
 *
 * Pipeline:
 *   1. Fetch Wikimedia POTD com eligibility loop (orientação + dedup, max 7 tentativas)
 *   2. Download + crop-resize 800×450
 *   3. Log em data/eai-used.json
 *   4. Gerar SD prompt (positive = description, negative = boilerplate)
 *   5. Chamar gemini-image.js
 *   6. Escrever 01-eai.md (template) + _internal/01-eai-meta.json
 *
 * Uso:
 *   npx tsx scripts/eai-compose.ts --edition AAMMDD [--out-dir <path>] [--force]
 *
 * Output JSON em stdout: { out_md, out_real, out_ia, out_meta, image_title, image_credit, image_date_used, rejections[] }
 * Exit code != 0 em qualquer falha bloqueante (Wikimedia API down, sem POTD elegível, Gemini down).
 *
 * Resume-aware (#192): se Stage 4 já completo (md + meta + par de imagens
 * A/B ou legacy real/ia), aborta cedo com `{ skipped: true, ... }` e exit 0.
 * Use `--force` pra forçar regeneração. Importante porque re-run faz novo
 * coin flip — sem skip, o mapping A↔B pode trocar entre runs e divergir do
 * que foi aprovado no gate.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const IS_WINDOWS = process.platform === "win32";

interface WikimediaImage {
  title?: string;
  description?: { text?: string };
  thumbnail?: { source?: string; width?: number; height?: number };
  image?: { source?: string; width?: number; height?: number };
  artist?: { text?: string };
  credit?: { text?: string };
  license?: { type?: string; url?: string };
}

interface WikimediaResponse {
  image?: WikimediaImage;
}

interface UsedEntry {
  edition_date: string;
  image_date: string;
  title: string;
  url: string;
}

interface Rejection {
  date: string;
  reason: string;
  width?: number;
  height?: number;
}

interface EaiMeta {
  edition: string;
  composed_at: string;
  ai_image_file: string;
  real_image_file: string;
  ai_side: "A" | "B" | null;
  wikimedia: {
    title: string;
    image_url: string;
    credit: string;
    artist_url: string | null;
    subject_wikipedia_url: string | null;
    image_date_used: string;
  };
}

export interface EaiSides {
  realSide: "A" | "B";
  aiSide: "A" | "B";
}

/**
 * Sorteia qual slot (A/B) recebe a foto real e qual recebe a IA. Recebe um
 * número aleatório [0, 1) — em produção `Math.random()`, em teste valor fixo
 * pra cobrir os dois ramos de forma determinística.
 */
export function chooseSides(rand: number): EaiSides {
  return rand < 0.5
    ? { realSide: "A", aiSide: "B" }
    : { realSide: "B", aiSide: "A" };
}

/**
 * Stats do poll da edição anterior — formato emitido por
 * `scripts/compute-eai-poll-stats.ts`. Subset usado aqui pra construir
 * a linha "Resultado da última edição" (#107).
 */
export interface PrevPollStats {
  total_responses?: number;
  pct_correct?: number | null;
  below_threshold?: boolean;
  skipped?: string;
}

/**
 * Constrói a linha "Resultado da última edição" (#107) a partir das stats
 * do poll. Retorna `null` quando não há nada útil pra reportar (skipped,
 * 0 respostas, ou abaixo do threshold de confiabilidade).
 */
export function buildPrevResultLine(stats: PrevPollStats | null): string | null {
  if (!stats) return null;
  if (stats.skipped) return null;
  if (!stats.total_responses || stats.total_responses === 0) return null;
  if (stats.below_threshold) return null;
  if (stats.pct_correct === null || stats.pct_correct === undefined) return null;
  return `Resultado da última edição: ${stats.pct_correct}% das pessoas acertaram.`;
}

/**
 * Lê stats da edição anterior do canonical path
 * (`{outDir}/_internal/04-eai-poll-stats.json`). Retorna null quando o
 * arquivo não existe ou não parseia — caller lida com ausência.
 */
export function readPrevPollStats(outDir: string): PrevPollStats | null {
  const path = resolve(outDir, "_internal/04-eai-poll-stats.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PrevPollStats;
  } catch {
    return null;
  }
}

/**
 * Monta o conteúdo do 01-eai.md com frontmatter YAML revelando A/B → real/ia.
 * O frontmatter é pra leitura humana (editor no gate); scripts leem
 * `_internal/01-eai-meta.json` para dados estruturados.
 *
 * Quando `prevResultLine` é fornecido (#107), inclui após o crédito:
 * "Resultado da última edição: X% das pessoas acertaram."
 */
export function buildEaiMd(
  sides: EaiSides,
  creditLine: string,
  prevResultLine: string | null = null,
): string {
  const aMapping = sides.realSide === "A" ? "real" : "ia";
  const bMapping = sides.realSide === "B" ? "real" : "ia";
  const lines = [
    "---",
    "eai_answer:",
    `  A: ${aMapping}`,
    `  B: ${bMapping}`,
    "---",
    "",
    "É IA?",
    "",
    creditLine,
  ];
  if (prevResultLine) {
    lines.push("", prevResultLine);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Detecta se o Stage 4 está completo num outDir (resume-aware): os 4 outputs
 * precisam existir em conjunto — `01-eai.md`, `_internal/01-eai-meta.json`, e
 * o par de imagens (A/B novo padrão #192 OU legacy real/ia).
 *
 * Usado pra evitar re-run não-determinístico: re-rodar `eai-compose` faz novo
 * coin flip e troca o mapping A↔B vs o que já foi aprovado no gate / publicado.
 */
export function isStage4Complete(outDir: string): boolean {
  const md = existsSync(resolve(outDir, "01-eai.md"));
  const meta = existsSync(resolve(outDir, "_internal/01-eai-meta.json"));
  const newAB =
    existsSync(resolve(outDir, "01-eai-A.jpg")) &&
    existsSync(resolve(outDir, "01-eai-B.jpg"));
  const legacyAB =
    existsSync(resolve(outDir, "01-eai-real.jpg")) &&
    existsSync(resolve(outDir, "01-eai-ia.jpg"));
  return md && meta && (newAB || legacyAB);
}

const NEGATIVE_PROMPT =
  "text, watermark, signature, logo, painting, illustration, drawing, cartoon, anime, cgi, 3d render, oil paint, watercolor, sketch, artistic, stylized, impressionist, brushstrokes, low quality, blurry subject, deformed, warped, border, frame, oversaturated, overexposed, studio backdrop, plain background, symmetrical composition, all subjects facing camera, posed, stock photo";

function editionToIso(edition: string): string {
  // 260418 → 2026-04-18
  return `20${edition.slice(0, 2)}-${edition.slice(2, 4)}-${edition.slice(4, 6)}`;
}

function decrementDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function firstSentence(text: string): string {
  const match = text.match(/^[^.!?]+[.!?]/);
  return (match ? match[0] : text).trim();
}

async function fetchPotd(iso: string): Promise<WikimediaImage | null> {
  const [yyyy, mm, dd] = iso.split("-");
  const url = `https://api.wikimedia.org/feed/v1/wikipedia/en/featured/${yyyy}/${mm}/${dd}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "diaria-studio/1.0 (diariaeditor@gmail.com)" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as WikimediaResponse;
  return data.image ?? null;
}

function readUsedTitles(): Set<string> {
  const path = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../data/eai-used.json",
  );
  if (!existsSync(path)) return new Set();
  try {
    const arr = JSON.parse(readFileSync(path, "utf8")) as UsedEntry[];
    return new Set(arr.map((e) => e.title.toLowerCase()));
  } catch {
    return new Set();
  }
}

interface EligibilityResult {
  image: WikimediaImage;
  imageDate: string;
  rejections: Rejection[];
}

export async function findEligiblePotd(
  startIso: string,
  usedTitles: Set<string>,
  maxAttempts = 7,
  fetcher: (iso: string) => Promise<WikimediaImage | null> = fetchPotd,
): Promise<EligibilityResult> {
  const rejections: Rejection[] = [];
  let iso = startIso;
  for (let i = 0; i < maxAttempts; i++) {
    const image = await fetcher(iso);
    if (!image) {
      rejections.push({ date: iso, reason: "api_no_image" });
      iso = decrementDate(iso);
      continue;
    }
    const w = image.image?.width ?? image.thumbnail?.width ?? 0;
    const h = image.image?.height ?? image.thumbnail?.height ?? 0;
    if (h > w) {
      rejections.push({ date: iso, reason: "vertical", width: w, height: h });
      iso = decrementDate(iso);
      continue;
    }
    const title = image.title ?? "";
    if (title && usedTitles.has(title.toLowerCase())) {
      rejections.push({ date: iso, reason: "already_used" });
      iso = decrementDate(iso);
      continue;
    }
    return { image, imageDate: iso, rejections };
  }
  throw new Error(
    `no_eligible_potd: tentei ${maxAttempts} dia(s); rejeições: ${JSON.stringify(rejections)}`,
  );
}

function extractCommonsUserUrl(artistText: string | undefined): string | null {
  if (!artistText) return null;
  // Procura href para User: page no commons
  const match = artistText.match(
    /https:\/\/commons\.wikimedia\.org\/wiki\/User:[^\s"'<>]+/,
  );
  return match ? match[0] : null;
}

function extractArtistName(artistText: string | undefined): string {
  if (!artistText) return "Wikimedia Commons";
  const stripped = stripHtml(artistText);
  // Tira "by " no início se houver
  return stripped.replace(/^by\s+/i, "").trim() || "Wikimedia Commons";
}

function buildCreditLine(image: WikimediaImage): string {
  const description = stripHtml(image.description?.text ?? "");
  const sentence = firstSentence(description) || "Imagem do dia da Wikimedia Commons.";
  const artistName = extractArtistName(image.artist?.text ?? image.credit?.text);
  const artistUrl = extractCommonsUserUrl(image.artist?.text ?? image.credit?.text);
  const license = image.license?.type ?? "CC BY-SA 4.0";
  const artistMd = artistUrl
    ? `[${artistName}](${artistUrl})`
    : artistName;
  return `${sentence} — ${artistMd} / ${license}.`;
}

function buildSdPrompt(image: WikimediaImage): {
  positive: string;
  negative: string;
  final_width: number;
  final_height: number;
} {
  const description = stripHtml(image.description?.text ?? "");
  // Trim para prompt razoável (~500 chars)
  const positive =
    (description.length > 500 ? description.slice(0, 500) : description) +
    ", documentary photograph, natural light, candid composition, photorealistic";
  return {
    positive,
    negative: NEGATIVE_PROMPT,
    final_width: 800,
    final_height: 450,
  };
}

// Silenciar stdout dos scripts filhos pra não poluir o JSON final que o
// orchestrator parseia. Stderr passa pra debug real continuar visível.
const CHILD_STDIO: ["inherit", "ignore", "inherit"] = [
  "inherit",
  "ignore",
  "inherit",
];

function runScript(cmd: string, args: string[]): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  execFileSync("npx", ["tsx", cmd, ...args], {
    cwd: ROOT,
    stdio: CHILD_STDIO,
    shell: IS_WINDOWS,
  });
}

function runNode(cmd: string, args: string[]): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  execFileSync(process.execPath, [cmd, ...args], { cwd: ROOT, stdio: CHILD_STDIO });
}

function curlDownload(url: string, outPath: string): void {
  execFileSync("curl", ["-sL", url, "-o", outPath], {
    stdio: CHILD_STDIO,
    shell: IS_WINDOWS,
  });
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const edition = args.edition;
  if (!edition || !/^\d{6}$/.test(edition)) {
    console.error("Uso: eai-compose.ts --edition AAMMDD [--out-dir <path>] [--force]");
    process.exit(1);
  }
  const force = process.argv.includes("--force");
  const outDir =
    args["out-dir"] ?? resolve(ROOT, `data/editions/${edition}`);
  const internalDir = resolve(outDir, "_internal");
  mkdirSync(internalDir, { recursive: true });

  // Resume-aware (#192): skip se Stage 4 já completo. Re-run faria novo
  // coin flip e quebraria consistência com o que foi aprovado no gate.
  if (!force && isStage4Complete(outDir)) {
    console.error(
      `[eai-compose] Stage 4 já completo em ${outDir}. ` +
        `Re-rodar mudaria o sorteio A/B (#192). Use --force pra regenerar.`,
    );
    console.log(
      JSON.stringify({
        skipped: true,
        reason: "stage4_already_complete",
        out_dir: outDir,
      }),
    );
    process.exit(0);
  }

  // 1. Fetch POTD com eligibility
  const usedTitles = readUsedTitles();
  const startIso = editionToIso(edition);
  const { image, imageDate, rejections } = await findEligiblePotd(
    startIso,
    usedTitles,
  );

  // 2. Coin flip (#192) — sorteia qual slot (A/B) recebe a foto real e qual recebe a IA.
  // Mantém o exercício "É IA?" cego: nem o leitor nem o nome do arquivo revelam a resposta.
  const sides = chooseSides(Math.random());
  const realFilename = `01-eai-${sides.realSide}.jpg`;
  const iaFilename = `01-eai-${sides.aiSide}.jpg`;

  // 3. Download + crop (real)
  const imageUrl = image.image?.source ?? image.thumbnail?.source;
  if (!imageUrl) {
    throw new Error("POTD sem URL de imagem");
  }
  const rawPath = resolve(outDir, "01-eai-real-raw.jpg");
  curlDownload(imageUrl, rawPath);
  const realPath = resolve(outDir, realFilename);
  runScript("scripts/crop-resize.ts", [
    rawPath,
    realPath,
    "--width",
    "800",
    "--height",
    "450",
  ]);
  unlinkSync(rawPath);

  // 4. Log used
  const credit = stripHtml(image.credit?.text ?? image.artist?.text ?? "");
  runScript("scripts/eai-log-used.ts", [
    "--edition",
    edition,
    "--image-date",
    imageDate,
    "--title",
    image.title ?? "",
    "--credit",
    credit,
    "--url",
    imageUrl,
  ]);

  // 5. Build SD prompt + 6. Gemini → escreve no slot oposto à foto real
  const sdPrompt = buildSdPrompt(image);
  const sdPromptPath = resolve(internalDir, "01-eai-sd-prompt.json");
  writeFileSync(sdPromptPath, JSON.stringify(sdPrompt, null, 2));
  const iaPath = resolve(outDir, iaFilename);
  runNode("scripts/gemini-image.js", [sdPromptPath, iaPath, "diaria_eai_"]);

  // 7. Write 01-eai.md (frontmatter + corpo + opcional resultado da edição anterior #107)
  const creditLine = buildCreditLine(image);
  const prevStats = readPrevPollStats(outDir);
  const prevResultLine = buildPrevResultLine(prevStats);
  const mdPath = resolve(outDir, "01-eai.md");
  writeFileSync(mdPath, buildEaiMd(sides, creditLine, prevResultLine));

  // 8. Write meta JSON
  const meta: EaiMeta = {
    edition,
    composed_at: new Date().toISOString(),
    ai_image_file: iaFilename,
    real_image_file: realFilename,
    ai_side: sides.aiSide,
    wikimedia: {
      title: image.title ?? "",
      image_url: imageUrl,
      credit,
      artist_url: extractCommonsUserUrl(image.artist?.text ?? image.credit?.text),
      subject_wikipedia_url: null,
      image_date_used: imageDate,
    },
  };
  const metaPath = resolve(internalDir, "01-eai-meta.json");
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");

  // Output JSON pra orchestrator
  console.log(
    JSON.stringify({
      out_md: mdPath,
      out_real: realPath,
      out_ia: iaPath,
      out_meta: metaPath,
      ai_side: sides.aiSide,
      image_title: image.title ?? "",
      image_credit: credit,
      image_date_used: imageDate,
      rejections,
    }),
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error(`[eai-compose] ${(e as Error).message}`);
    process.exit(2);
  });
}
