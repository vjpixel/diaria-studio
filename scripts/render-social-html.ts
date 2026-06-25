/**
 * render-social-html.ts
 *
 * Renderiza 03-social.md como HTML mobile-friendly para preview no browser.
 * Output: HTML standalone com cards por plataforma e posts visualmente separados.
 *
 * Uso:
 *   npx tsx scripts/render-social-html.ts --md data/editions/260526/03-social.md --out data/editions/260526/_internal/social-preview.html --images data/editions/260526/06-public-images.json
 *
 * Flags:
 *   --md <path>       (obrigatório) markdown 03-social.md
 *   --out <path>      (obrigatório) HTML de saída
 *   --images <path>   06-public-images.json (na RAIZ da edição, não em _internal/)
 *   --require-images  exit≠0 se imagens não resolverem (default: warn-only)
 *
 * #1800: sem --images (ou path inválido), o preview saía SEM imagens
 * silenciosamente — o editor revisava o gate achando que o social estava sem
 * imagem. Agora: catch não é mais silencioso (warn loud no stderr) + check de
 * contagem de <img> vs posts de destaque pós-render.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveSocialImageUrl } from "./lib/social-image-url.ts";
import { escHtml } from "./lib/html-escape.ts"; // #1990 follow-up

export interface ImageMap {
  [key: string]: {
    url: string;
    filename?: string;
    md5?: string;
    /** #1584: Cloudflare URL preservada quando upload-images-public roda em
     * múltiplos modes (newsletter primeiro CF, social depois Drive). */
    cloudflare_url?: string;
  };
}

export interface ImageLoadResult {
  map: ImageMap;
  warnings: string[];
}

/**
 * Carrega o mapa de imagens. #1800: nunca falha em silêncio — cada cenário de
 * "sem imagens" vira um warning explícito (não um catch vazio).
 */
export function loadImageMap(imagesPath: string | null): ImageLoadResult {
  const warnings: string[] = [];
  if (!imagesPath) {
    warnings.push(
      "--images ausente: preview renderizado SEM imagens dos destaques. " +
        "Passe --images data/editions/{AAMMDD}/06-public-images.json (na RAIZ da edição).",
    );
    return { map: {}, warnings };
  }
  if (!existsSync(imagesPath)) {
    warnings.push(`--images path não existe: ${imagesPath} — preview SEM imagens.`);
    return { map: {}, warnings };
  }
  try {
    const raw = JSON.parse(readFileSync(imagesPath, "utf8"));
    const map: ImageMap = raw.images ?? raw;
    if (!map || typeof map !== "object" || Object.keys(map).length === 0) {
      warnings.push(`--images vazio (${imagesPath}) — preview SEM imagens.`);
      return { map: {}, warnings };
    }
    return { map, warnings };
  } catch (e) {
    warnings.push(
      `--images inválido/não-JSON (${imagesPath}): ${(e as Error).message} — preview SEM imagens.`,
    );
    return { map: {}, warnings };
  }
}

export interface Post {
  destaque: string;
  main: string;
  commentDiaria?: string;
  commentPixel?: string;
  hashtags: string;
}

export interface Platform {
  name: string;
  posts: Post[];
  note?: string;
}

export function parsePlatforms(text: string): Platform[] {
  const platforms: Platform[] = [];
  const platformBlocks = text.split(/^# /m).filter(Boolean);

  for (const block of platformBlocks) {
    const lines = block.split("\n");
    const name = lines[0].trim();

    let note = "";
    const noteMatch = block.match(/^> .+$/m);
    if (noteMatch) note = noteMatch[0].replace(/^> /, "").replace(/\*\*/g, "");

    const postBlocks = block.split(/^## /m).slice(1);
    const posts: Post[] = [];

    for (const pb of postBlocks) {
      const pbLines = pb.split("\n");
      const destaque = pbLines[0].trim().toUpperCase();

      const commentDiariaIdx = pb.indexOf("### comment_diaria");
      const commentPixelIdx = pb.indexOf("### comment_pixel");

      let mainEnd = pb.length;
      if (commentDiariaIdx > 0) mainEnd = Math.min(mainEnd, commentDiariaIdx);
      if (commentPixelIdx > 0) mainEnd = Math.min(mainEnd, commentPixelIdx);

      const mainText = pb.slice(pbLines[0].length + 1, mainEnd).trim();

      let commentDiaria = "";
      if (commentDiariaIdx >= 0) {
        const cdEnd = commentPixelIdx > commentDiariaIdx ? commentPixelIdx : pb.length;
        commentDiaria = pb.slice(commentDiariaIdx + "### comment_diaria".length, cdEnd).trim();
      }

      let commentPixel = "";
      if (commentPixelIdx >= 0) {
        commentPixel = pb.slice(commentPixelIdx + "### comment_pixel".length).trim();
      }

      const hashtagMatch = mainText.match(/^#[A-Za-zÀ-ú].*$/m);
      const hashtags = hashtagMatch ? hashtagMatch[0] : "";
      const mainClean = mainText.replace(/^#[A-Za-zÀ-ú].*$/m, "").trim();

      posts.push({ destaque, main: mainClean, commentDiaria, commentPixel, hashtags });
    }

    platforms.push({ name, posts, note });
  }

  return platforms;
}

/** #1690: o post_pixel é o post standalone de D1 no perfil pessoal (vjpixel). */
export function isPostPixel(destaque: string): boolean {
  return /^post.?pixel/i.test(destaque.trim());
}

function getImageUrl(destaque: string, imageUrls: ImageMap, postPixelImageNum = "1"): string {
  // #1690: post_pixel reusa a imagem do D1 por padrão; #2549: override per-edição
  // (quando o post pessoal cobre outro destaque, ex: D2) via marker.
  const dNum = isPostPixel(destaque) ? postPixelImageNum : destaque.replace(/\D/g, "");
  // #1635: resolução delegada ao helper puro — prefere cloudflare_url, senão a
  // url real (Drive serve inline), nunca chuta uma key Cloudflare sem md5.
  return resolveSocialImageUrl(imageUrls[`d${dNum}`], (m) => console.error(m));
}

/** #1800: quantos posts esperam uma imagem (d1/d2/d3 + post_pixel que reusa d1, #1690). */
export function expectedImageCount(platforms: Platform[]): number {
  return platforms.reduce(
    (sum, p) =>
      sum + p.posts.filter((post) => /\d/.test(post.destaque) || isPostPixel(post.destaque)).length,
    0,
  );
}

/** #1800: conta `<img` no HTML renderizado (validação pós-render). */
export function countImgTags(html: string): number {
  return (html.match(/<img\b/g) ?? []).length;
}

function renderPost(post: Post, color: string, imageUrls: ImageMap, postPixelImageNum = "1"): string {
  const imgUrl = getImageUrl(post.destaque, imageUrls, postPixelImageNum);
  const imgHtml = imgUrl
    ? `<div class="post-image"><img src="${escHtml(imgUrl)}" alt="${escHtml(post.destaque)}" /></div>`
    : "";

  const mainParas = post.main
    .split(/\n\n+/)
    .filter(Boolean)
    .map(p => `<p>${escHtml(p).replace(/\n/g, "<br>").replace(/\{edition_url\}/g, "<em>[link da edição]</em>")}</p>`)
    .join("\n");

  const hashtags = post.hashtags
    ? `<div class="hashtags">${escHtml(post.hashtags).replace(/#(\w+)/g, `<span style="color:${color}">#$1</span>`)}</div>`
    : "";

  let comments = "";
  if (post.commentDiaria) {
    const cd = escHtml(post.commentDiaria).replace(/\n/g, "<br>").replace(/\{edition_url\}/g, "<em>[link da edição]</em>");
    comments += `<details class="comment"><summary>💬 Comentário Diar.ia (company page)</summary><p>${cd}</p></details>`;
  }
  if (post.commentPixel) {
    const cp = escHtml(post.commentPixel).replace(/\n/g, "<br>");
    comments += `<details class="comment"><summary>💬 Comentário Pixel (pessoal)</summary><p>${cp}</p></details>`;
  }

  // #1690: label claro pro post pessoal (vjpixel) no preview. #2549: o destaque
  // referenciado segue o override (default D1).
  const headerLabel = isPostPixel(post.destaque)
    ? `📣 POST PESSOAL — vjpixel (D${postPixelImageNum})`
    : post.destaque;

  return `
    <div class="post">
      <div class="post-header" style="border-left: 3px solid ${color}">${headerLabel}</div>
      ${imgHtml}
      <div class="post-body">
        ${mainParas}
        ${hashtags}
      </div>
      ${comments}
    </div>`;
}

export function buildSocialHtml(platforms: Platform[], imageUrls: ImageMap, postPixelImageNum = "1"): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Social Preview</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f0f2f5;
    color: #1a1a1a;
    padding: 12px;
    line-height: 1.6;
    font-size: 16px;
  }
  h1 {
    text-align: center;
    font-size: 18px;
    color: #666;
    margin-bottom: 16px;
    font-weight: 500;
  }
  .platform {
    margin-bottom: 24px;
  }
  .platform-header {
    font-size: 15px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    padding: 10px 16px;
    border-radius: 10px 10px 0 0;
    color: #fff;
  }
  .platform-header.linkedin { background: #0a66c2; }
  .platform-header.facebook { background: #1877f2; }
  .platform-note {
    font-size: 12px;
    color: #888;
    padding: 8px 16px;
    background: #fff;
    border-bottom: 1px solid #e5e5e5;
    font-style: italic;
  }
  .post {
    background: #fff;
    padding: 0;
    margin-bottom: 2px;
  }
  .post:last-child {
    border-radius: 0 0 10px 10px;
    margin-bottom: 0;
  }
  .post-image { padding: 0; }
  .post-image img { width: 100%; height: auto; display: block; }
  .post-header {
    font-size: 13px;
    font-weight: 700;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 14px 16px 0 16px;
    margin-left: 0;
    padding-left: 13px;
  }
  .post-body {
    padding: 8px 16px 14px;
  }
  .post-body p {
    margin-bottom: 12px;
    font-size: 15px;
    line-height: 1.55;
  }
  .post-body p:last-child { margin-bottom: 0; }
  .hashtags {
    font-size: 14px;
    margin-top: 10px;
    word-spacing: 4px;
  }
  .comment {
    border-top: 1px solid #f0f0f0;
    padding: 0;
  }
  .comment summary {
    padding: 10px 16px;
    font-size: 13px;
    color: #666;
    cursor: pointer;
    user-select: none;
  }
  .comment summary:hover { background: #fafafa; }
  .comment p {
    padding: 0 16px 14px;
    font-size: 14px;
    color: #555;
    line-height: 1.5;
  }
</style>
</head>
<body>
<h1>Social Preview</h1>
${platforms.map(p => {
  const isLinkedin = p.name.toLowerCase().includes("linkedin");
  const color = isLinkedin ? "#0a66c2" : "#1877f2";
  const cls = isLinkedin ? "linkedin" : "facebook";
  const icon = isLinkedin ? "💼" : "📘";
  return `
  <div class="platform">
    <div class="platform-header ${cls}">${icon} ${escHtml(p.name)}</div>
    ${p.note ? `<div class="platform-note">${escHtml(p.note)}</div>` : ""}
    ${p.posts.map(post => renderPost(post, color, imageUrls, postPixelImageNum)).join("\n")}
  </div>`;
}).join("\n")}
</body>
</html>`;
}

function main(): void {
  const args = process.argv.slice(2);
  const mdIdx = args.indexOf("--md");
  const outIdx = args.indexOf("--out");
  const imagesIdx = args.indexOf("--images");
  const requireImages = args.includes("--require-images");
  if (mdIdx < 0 || outIdx < 0) {
    console.error("Usage: --md <path> --out <path> [--images <06-public-images.json>] [--require-images]");
    process.exit(2);
  }
  const mdPath = args[mdIdx + 1];
  const outPath = args[outIdx + 1];
  const imagesPath = imagesIdx >= 0 ? args[imagesIdx + 1] : null;

  const md = readFileSync(mdPath, "utf8");
  const { map: imageUrls, warnings } = loadImageMap(imagesPath);

  // #2549: override per-edição da imagem/label do post_pixel (default "1" = D1,
  // #1690). Marker `_internal/post-pixel-image.txt` contém o destaque (ex: "d2")
  // quando o post pessoal cobre outro destaque que não o D1.
  let postPixelImageNum = "1";
  const ppMarker = resolve(dirname(mdPath), "_internal/post-pixel-image.txt");
  if (existsSync(ppMarker)) {
    const v = readFileSync(ppMarker, "utf8").trim().replace(/\D/g, "");
    if (v) postPixelImageNum = v;
  }

  const platforms = parsePlatforms(md);
  const html = buildSocialHtml(platforms, imageUrls, postPixelImageNum);
  writeFileSync(outPath, html);

  // #1800: validação pós-render — preview com menos <img> que posts de destaque
  // significa imagem faltando. Surfaçar loud em vez de enganar o editor no gate.
  const expected = expectedImageCount(platforms);
  const actual = countImgTags(html);
  if (expected > 0 && actual < expected) {
    warnings.push(
      `preview com ${actual}/${expected} imagens de destaque — ${expected - actual} faltando. ` +
        `Confira o --images e os 06-public-images.json (chaves d1/d2/d3).`,
    );
  }

  for (const w of warnings) console.error(`[render-social-html] ⚠️ ${w}`);

  const postCount = platforms.reduce((s, p) => s + p.posts.length, 0);
  console.log(
    JSON.stringify({
      out: outPath,
      platforms: platforms.length,
      posts: postCount,
      images_expected: expected,
      images_rendered: actual,
      warnings,
      bytes: Buffer.byteLength(html),
    }),
  );

  // #1800: com --require-images, qualquer imagem faltando falha o pipeline.
  if (requireImages && warnings.length > 0) {
    console.error("[render-social-html] --require-images: imagens faltando, exit 1.");
    process.exit(1);
  }
}

// CLI guard portável (Windows + Unix) — só roda main() em execução direta.
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
