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
 *   npx tsx scripts/eai-compose.ts --edition AAMMDD [--out-dir <path>]
 *
 * Output JSON em stdout: { out_md, out_real, out_ia, out_meta, image_title, image_credit, image_date_used, rejections[] }
 * Exit code != 0 em qualquer falha bloqueante (Wikimedia API down, sem POTD elegível, Gemini down).
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

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
  ai_side: string | null;
  wikimedia: {
    title: string;
    image_url: string;
    credit: string;
    artist_url: string | null;
    subject_wikipedia_url: string | null;
    image_date_used: string;
  };
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
  execFileSync("npx", ["tsx", cmd, ...args], { cwd: ROOT, stdio: CHILD_STDIO });
}

function runNode(cmd: string, args: string[]): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  execFileSync("node", [cmd, ...args], { cwd: ROOT, stdio: CHILD_STDIO });
}

function curlDownload(url: string, outPath: string): void {
  execFileSync("curl", ["-sL", url, "-o", outPath], { stdio: CHILD_STDIO });
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
    console.error("Uso: eai-compose.ts --edition AAMMDD [--out-dir <path>]");
    process.exit(1);
  }
  const outDir =
    args["out-dir"] ?? resolve(ROOT, `data/editions/${edition}`);
  const internalDir = resolve(outDir, "_internal");
  mkdirSync(internalDir, { recursive: true });

  // 1. Fetch POTD com eligibility
  const usedTitles = readUsedTitles();
  const startIso = editionToIso(edition);
  const { image, imageDate, rejections } = await findEligiblePotd(
    startIso,
    usedTitles,
  );

  // 2. Download + crop
  const imageUrl = image.image?.source ?? image.thumbnail?.source;
  if (!imageUrl) {
    throw new Error("POTD sem URL de imagem");
  }
  const rawPath = resolve(outDir, "01-eai-real-raw.jpg");
  curlDownload(imageUrl, rawPath);
  const realPath = resolve(outDir, "01-eai-real.jpg");
  runScript("scripts/crop-resize.ts", [
    rawPath,
    realPath,
    "--width",
    "800",
    "--height",
    "450",
  ]);
  execFileSync("rm", [rawPath], { stdio: "inherit" });

  // 3. Log used
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

  // 4. Build SD prompt + 5. Gemini
  const sdPrompt = buildSdPrompt(image);
  const sdPromptPath = resolve(internalDir, "01-eai-sd-prompt.json");
  writeFileSync(sdPromptPath, JSON.stringify(sdPrompt, null, 2));
  const iaPath = resolve(outDir, "01-eai-ia.jpg");
  runNode("scripts/gemini-image.js", [sdPromptPath, iaPath, "diaria_eai_"]);

  // 6. Write 01-eai.md
  const creditLine = buildCreditLine(image);
  const mdPath = resolve(outDir, "01-eai.md");
  writeFileSync(mdPath, `É IA?\n\n${creditLine}\n`);

  // 7. Write meta JSON
  const meta: EaiMeta = {
    edition,
    composed_at: new Date().toISOString(),
    ai_image_file: "01-eai-ia.jpg",
    real_image_file: "01-eai-real.jpg",
    ai_side: null,
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
