/**
 * upload-images-public.ts
 *
 * Faz upload das imagens de destaque (D1 square, D2, D3) pro Google Drive
 * como arquivos publicamente acessíveis, retornando URLs shareable.
 *
 * Usado pelo Stage 4 social (LinkedIn / Facebook) — `publish-linkedin.ts`
 * passa a URL no payload Make.com pra `image_url`; LinkedIn renderiza preview.
 *
 * Uso:
 *   npx tsx scripts/upload-images-public.ts --edition-dir data/editions/260424/
 *
 * Output (stdout JSON):
 *   {
 *     "out_path": "data/editions/260424/06-public-images.json",
 *     "images": {
 *       "d1": { "file_id": "img-260424-04-d1-1x1-HASH.jpg", "url": "https://poll.diaria.workers.dev/img/..." },
 *       "d2": { ... },
 *       "d3": { ... }
 *     }
 *   }
 *
 * Cache: escreve em `{edition_dir}/06-public-images.json`. Re-execuções
 * reusam file_ids existentes (skip re-upload).
 *
 * Credenciais: data/.credentials.json (via google-auth.ts).
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv(); // #1157 — carrega .env.local + .env antes de process.env access (CLOUDFLARE_*)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gFetch } from "./google-auth.ts";
import { uploadImageToWorkerKV } from "./lib/cloudflare-kv-upload.ts"; // #1119

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

export interface PublicImage {
  /** Drive file_id (target=drive) ou Cloudflare KV key (target=cloudflare). #1119 */
  file_id: string;
  url: string;
  mime_type: string;
  filename: string;
  /** Target onde a imagem está hospedada. Default drive (compat com edições antigas). #1119 */
  target?: "drive" | "cloudflare";
  /** #1418: md5 dos bytes locais no momento do upload — pra detectar drift
   * em re-runs (imagem regerada local com bytes novos mas cache aponta pro
   * upload antigo). Ausente em entries pre-#1418 → assume drift e re-uploadar. */
  md5?: string;
  /** #1584: Cloudflare URL persistente, separada de `url`. Quando uma key
   * (ex: `d1`) é uploadada primeiro pra Cloudflare (mode=newsletter) e depois
   * pra Drive (mode=social), a Cloudflare URL antes era perdida ao overwrite.
   * Agora preservada aqui pro renderer do social preview continuar resolvendo. */
  cloudflare_url?: string;
}

/** Target de hospedagem das imagens. #1119 */
export type UploadTarget = "drive" | "cloudflare";

/**
 * Default de target por modo (#1119, unificado em #2147):
 * todos os modes → cloudflare (KV). Parâmetro `mode` mantido por compat de
 * assinatura; ignorado — o retorno é sempre "cloudflare".
 *
 * Editor pode override via flag `--target drive`/`--target cloudflare`.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function defaultTargetFor(_mode: UploadMode): UploadTarget {
  return "cloudflare";
}

export interface PublicImagesOutput {
  out_path: string;
  images: Record<string, PublicImage>;
}

/**
 * URL shareable pra preview de imagem em LinkedIn/Facebook.
 * Formato `uc?id=X&export=view` serve bytes da imagem diretamente com
 * content-type correto — crawlers de preview detectam como imagem.
 *
 * Alternativa `file/d/{id}/view` serve HTML wrapper — útil pra OG preview,
 * mas preview de imagem direto é melhor visualmente.
 */
export function publicImageUrl(fileId: string): string {
  return `https://drive.google.com/uc?id=${fileId}&export=view`;
}

/**
 * URL alternativa formato "view" (HTML wrapper com og:image meta).
 * Pode funcionar melhor em alguns clients.
 */
export function publicFileViewUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;
}

/** Detecta mime type básico por extensão. */
export function mimeTypeFor(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

/**
 * Escolhe o arquivo fonte pra cada destaque (modo social — LinkedIn/IG).
 * D1 usa variante 1x1 (social square); D2/D3 usam 1x1 (proporção forçada em #372).
 */
export function sourceImageFor(destaque: "d1" | "d2" | "d3"): string {
  return destaque === "d1" ? "04-d1-1x1.jpg" : `04-${destaque}-1x1.jpg`;
}

/**
 * Mapeamento de imagens por modo:
 * - social: D1 1x1 (square), D2, D3 — pra LinkedIn/Instagram.
 * - newsletter: cover 2x1 (= D1 inline), D2, D3, É IA? real + IA —
 *   pra Custom HTML block do Beehiiv (#74).
 * - all: union dos dois.
 *
 * Chaves usadas como `images[key].url` downstream.
 */
export type UploadMode = "social" | "newsletter" | "all";

export interface ImageSpec {
  key: string;
  filename: string;
  /**
   * #1704: quando true, a KV key NÃO recebe o sufixo md5 de cache-bust (#1584).
   * Usado pelas imagens do É IA? (A/B): o Worker `poll` monta a URL do /vote
   * com convenção FIXA `/img/img-{AAMMDD}-01-eia-{A|B}.jpg` (sem hash). Com o
   * sufixo md5 a key gravada não bate com essa URL → /vote dá 404 em TODA edição.
   *
   * Trade-off (honesto): sem o sufixo, regenerar a imagem no MESMO edition
   * reescreve a mesma key (sem cache-bust). Isso é aceitável porque (a) o /vote
   * 404 é certo e recorrente, enquanto regen-após-envio é raro; e (b) o É IA?
   * já era servido por convenção fixa de key antes do #1584 (design #1242). NÃO
   * conte com o TTL 1h do edge pra invalidar cache do Gmail Image Proxy (que
   * cacheia por URL e ignora max-age) — a real justificativa é a convenção fixa
   * do /vote, não o TTL. cover/d1 vão pro email e MANTÊM o cache-bust por hash.
   */
  noCacheBust?: boolean;
  /**
   * #1701: spec best-effort — se o arquivo não existir, PULA (não lança). Usado
   * pra d2/d3 no newsletter mode: eles sobem ao Cloudflare KV só pro social
   * preview (o EMAIL não os usa), então não devem bloquear o newsletter-mode
   * upload (que roda standalone na publicação manual/email — caso 260602 review).
   */
  optional?: boolean;
}

/**
 * Especifica quais imagens fazer upload por modo. Quando `editionDir` é
 * passado e o modo inclui newsletter, detecta o naming É IA? em disco:
 * novas edições usam `01-eia-A.jpg`/`01-eia-B.jpg` (#192, random); edições
 * antigas usam `01-eia-real.jpg`/`01-eia-ia.jpg`. Sem `editionDir`, default
 * pra naming novo (A/B).
 */
export function imageSpecsFor(mode: UploadMode, editionDir?: string): ImageSpec[] {
  const social: ImageSpec[] = [
    { key: "d1", filename: "04-d1-1x1.jpg" },
    { key: "d2", filename: "04-d2-1x1.jpg" },
    { key: "d3", filename: "04-d3-1x1.jpg" },
  ];

  const eaiSpecs = (() => {
    const newA = editionDir ? resolve(editionDir, "01-eia-A.jpg") : null;
    const newB = editionDir ? resolve(editionDir, "01-eia-B.jpg") : null;
    if (newA && newB && existsSync(newA) && existsSync(newB)) {
      return [
        { key: "eia_a", filename: "01-eia-A.jpg", noCacheBust: true },
        { key: "eia_b", filename: "01-eia-B.jpg", noCacheBust: true },
      ];
    }
    if (editionDir) {
      const oldReal = resolve(editionDir, "01-eia-real.jpg");
      if (existsSync(oldReal)) {
        return [
          { key: "eia_real", filename: "01-eia-real.jpg", noCacheBust: true },
          { key: "eia_ia", filename: "01-eia-ia.jpg", noCacheBust: true },
        ];
      }
    }
    // Default sem disco: assume novo naming (caso de teste / dry-run).
    return [
      { key: "eia_a", filename: "01-eia-A.jpg", noCacheBust: true },
      { key: "eia_b", filename: "01-eia-B.jpg", noCacheBust: true },
    ];
  })();

  // #1121: newsletter mode upload-a o que o renderer substitui via `{{IMG:...}}`:
  // cover D1 (2x1), D2 hero (2x1), D3 hero (2x1), É IA? A/B.
  //
  // #2133/#2141: D2 e D3 passaram a ter hero inline 2:1 no email. Os arquivos
  // `04-d2-2x1.jpg` e `04-d3-2x1.jpg` são gerados pelo Stage 3 e substituem os
  // placeholders `{{IMG:04-d2-2x1.jpg}}` / `{{IMG:04-d3-2x1.jpg}}`.
  //
  // #1583/#1701/#2147: d2/d3 1x1 sobem ao CF KV. Antes, social mode mandava
  // d1/d2/d3 pro Drive e o preview usava Drive `uc?id` pra d2/d3 (quebrava
  // como hotlink por cookie/referer check). Agora social mode usa cloudflare
  // por default → d1/d2/d3 têm URLs KV estáveis em `url` e `cloudflare_url`.
  // Newsletter mode também sobe d2/d3 1x1 (best-effort, optional) pra garantir
  // `cloudflare_url` nos entries antes do social mode rodar.
  const newsletter: ImageSpec[] = [
    { key: "cover", filename: "04-d1-2x1.jpg" },
    { key: "d1", filename: "04-d1-1x1.jpg" },
    // #2133/#2141: d2/d3 hero 2x1 entram no email como {{IMG:04-d{N}-2x1.jpg}}.
    // optional=true: não bloqueiam o upload se ausentes (ex: re-run de edição
    // pré-#2133, ou regeneração manual falhou parcialmente).
    { key: "d2_2x1", filename: "04-d2-2x1.jpg", optional: true },
    { key: "d3_2x1", filename: "04-d3-2x1.jpg", optional: true },
    // #1701: 1x1 de d2/d3 sobem ao CF pro social preview.
    { key: "d2", filename: "04-d2-1x1.jpg", optional: true },
    { key: "d3", filename: "04-d3-1x1.jpg", optional: true },
    // #1808: box promo de livros (entre D1 e D2 no email, renderMidCallout).
    // optional — nem toda edição tem o box. Mantém o md5 cache-bust (#1584): a
    // URL é per-edição (`img-{AAMMDD}-04-livros-promo.jpg`) e o sufixo md5 evita
    // que o proxy de imagem do Gmail sirva uma promo stale se o arquivo for
    // regerado. readMidCalloutImage lê a entry `livros_promo`; sem este produtor
    // o box degradava pra só-texto silenciosamente (achado #1 da review do #1807).
    { key: "livros_promo", filename: "04-livros-promo.jpg", optional: true },
    ...eaiSpecs,
  ];
  if (mode === "social") return social;
  if (mode === "newsletter") return newsletter;
  // all — dedup por key (eaiSpecs em newsletter, d1/d2/d3 em social)
  const seen = new Set<string>();
  const out: ImageSpec[] = [];
  for (const s of [...social, ...newsletter]) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    out.push(s);
  }
  return out;
}

async function driveUploadFile(
  name: string,
  content: Buffer,
  mimeType: string,
): Promise<{ id: string }> {
  const boundary = "diaria_public_" + Date.now();
  const metadataPart =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name }) +
    `\r\n`;
  const contentPart =
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;
  const closingBoundary = `\r\n--${boundary}--`;

  const body = Buffer.concat([
    Buffer.from(metadataPart, "utf8"),
    Buffer.from(contentPart, "utf8"),
    content,
    Buffer.from(closingBoundary, "utf8"),
  ]);

  const res = await gFetch(
    `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    },
  );
  if (!res.ok) {
    throw new Error(`Drive upload error (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<{ id: string }>;
}

async function makeFilePublic(fileId: string): Promise<void> {
  const res = await gFetch(`${DRIVE_API}/files/${fileId}/permissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  });
  if (!res.ok) {
    throw new Error(`Drive permission error (${res.status}): ${await res.text()}`);
  }
}

function loadCache(cachePath: string): Record<string, PublicImage> {
  if (!existsSync(cachePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    return (parsed.images ?? {}) as Record<string, PublicImage>;
  } catch {
    return {};
  }
}

/**
 * #1865: base do merge cross-mode do `06-public-images.json` — SEMPRE o arquivo
 * existente, independente de `--no-cache`. Os modos `newsletter` (cover/eia_*) e
 * `social` (d1/d2/d3) gravam no MESMO arquivo; o modo que roda por último faz
 * spread por cima desta base, preservando as chaves do outro modo.
 *
 * `--no-cache` (skipExisting=false) afeta SÓ a decisão de re-upload (reuse), NÃO
 * a base do merge. Antes, `--no-cache` zerava a base (`{}`) e o social mode
 * apagava cover/eia do newsletter (260605, quase publicou sem capa).
 */
export function mergeBaseFromCache(cachePath: string): Record<string, PublicImage> {
  return { ...loadCache(cachePath) };
}

/** #1418: md5 hex de um arquivo, pra detectar drift entre local e cache. */
export function md5OfFile(path: string): string {
  const bytes = readFileSync(path);
  return createHash("md5").update(bytes).digest("hex");
}

/**
 * #1418: decide se um cached entry pode ser reused pra um source path local.
 * Reuse OK quando:
 *   1. cache tem file_id válido (upload anterior teve sucesso), E
 *   2. target bate (não mudou drive ↔ cloudflare), E
 *   3. md5 do cache bate com md5 atual do arquivo local
 *      (ausência de md5 no cache = entry pre-#1418 → assume drift, re-upload).
 */
export function shouldReuseCachedUpload(
  cached: PublicImage | undefined,
  imagePath: string,
  target: UploadTarget,
  localMd5?: string,
): boolean {
  if (!cached?.file_id) return false;
  if ((cached.target ?? "drive") !== target) return false;
  if (!cached.md5) return false;
  return cached.md5 === (localMd5 ?? md5OfFile(imagePath));
}

/**
 * #1704: constrói a KV key Cloudflare pra um spec, omitindo o sufixo md5 de
 * cache-bust (#1584) quando `spec.noCacheBust` (imagens do É IA?, que precisam
 * casar com a convenção fixa do Worker /vote). Single source of truth — usado
 * tanto pra decidir reuse (self-heal de keys legacy) quanto pro upload.
 */
export function kvKeyForSpec(
  editionDir: string,
  spec: ImageSpec,
  localMd5: string,
): string {
  return cloudflareKvKey(editionDir, spec.filename, spec.noCacheBust ? undefined : localMd5);
}

export interface UploadOptions {
  editionDir: string;
  /** Lista explícita de chaves a upload. Sobrescreve `mode` se ambos passados. */
  destaques?: Array<"d1" | "d2" | "d3">;
  /** Modo de seleção de imagens (social | newsletter | all). Default: social. */
  mode?: UploadMode;
  skipExisting?: boolean;
  /** Target de hospedagem (#1119). Default deriva do mode via `defaultTargetFor`. */
  target?: UploadTarget;
  /** #1418: ignora cache md5/target e força re-upload. Útil pra recovery. */
  forceReupload?: boolean;
  /**
   * #1865: seam de injeção pros uploads de rede (Cloudflare KV / Drive). Default
   * usa as implementações reais; testes injetam stubs pra exercitar o merge
   * cross-mode sem rede (gFetch faz OAuth do Google, inviável em teste).
   */
  uploaders?: UploadDeps;
}

export interface UploadDeps {
  uploadToCloudflare?: (
    imagePath: string,
    key: string,
    cfg: { kvNamespaceId: string; workerUrl: string },
  ) => Promise<string>;
  uploadToDrive?: (name: string, content: Buffer, mime: string) => Promise<{ id: string }>;
  makeDrivePublic?: (fileId: string) => Promise<void>;
}

/**
 * Constrói KV key única por edição + filename. Convenção #1119: `img-{AAMMDD}-{filename}`.
 * Extrai AAMMDD do path da edição (ex: `data/editions/260512/` → `260512`).
 *
 * #1584: quando `md5Hex` é passado, anexa sufixo `-{md5short}` antes da extensão
 * (`img-{AAMMDD}-{base}-{md5short}.{ext}`). Cache-busts re-uploads — Cloudflare
 * serve com `Cache-Control: max-age=1ano, immutable`, então sem suffix o browser
 * nunca pega imagem regenerada (caso 260529: D1 regen 3 vezes, sempre mesma URL
 * → editor via imagem antiga).
 */
export function cloudflareKvKey(
  editionDir: string,
  filename: string,
  md5Hex?: string,
): string {
  const match = editionDir.replace(/[\\/]+$/, "").match(/(\d{6})$/);
  const aammdd = match?.[1] ?? "unknown";
  if (!md5Hex) return `img-${aammdd}-${filename}`;
  const md5short = md5Hex.slice(0, 8);
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return `img-${aammdd}-${filename}-${md5short}`;
  const base = filename.slice(0, dot);
  const ext = filename.slice(dot);
  return `img-${aammdd}-${base}-${md5short}${ext}`;
}

export async function uploadPublicImages(
  opts: UploadOptions,
): Promise<PublicImagesOutput> {
  const { editionDir } = opts;
  const skipExisting = opts.skipExisting ?? true;
  const forceReupload = opts.forceReupload ?? false;
  const mode = opts.mode ?? "social";
  const target = opts.target ?? defaultTargetFor(mode);

  // Determinar lista de imagens a upload
  let specs: ImageSpec[];
  if (opts.destaques) {
    // Retrocompat: destaques explícitos
    specs = opts.destaques.map((d) => ({ key: d, filename: sourceImageFor(d) }));
  } else {
    specs = imageSpecsFor(mode, editionDir);
  }

  const cachePath = resolve(editionDir, "06-public-images.json");
  // #1865: SEMPRE carregar o `06-public-images.json` existente como base do
  // merge — preserva entries de OUTROS modos (cover/eia_a/eia_b do newsletter
  // quando o social roda, e d1/d2/d3 do social quando o newsletter roda). Os
  // dois modos gravam no mesmo arquivo. `--no-cache` (skipExisting=false) deve
  // forçar só RE-UPLOAD (decisão de reuse abaixo, que já gateia em skipExisting),
  // NÃO apagar o merge cross-mode. Antes, `--no-cache` zerava a base (`{}`) e o
  // modo que rodava por último sobrescrevia as chaves do outro → cover/É IA?
  // sumiam e a newsletter quase saiu sem capa (260605).
  const existing = mergeBaseFromCache(cachePath); // snapshot imutável (reuse + cloudflare_url lookup)
  const images: Record<string, PublicImage> = { ...existing }; // base mutável do merge

  // #1865: uploaders injetáveis (default = reais). Testes stubbam pra exercitar
  // o merge sem rede.
  const uploadToCloudflare = opts.uploaders?.uploadToCloudflare ?? uploadImageToWorkerKV;
  const uploadToDrive = opts.uploaders?.uploadToDrive ?? driveUploadFile;
  const makeDrivePublic = opts.uploaders?.makeDrivePublic ?? makeFilePublic;

  // Cloudflare config (lazy — só carrega se target=cloudflare e uploader real).
  // Quando opts.uploaders.uploadToCloudflare é injetado (testes), o cfConfig
  // não é necessário — o stub ignora o 3º arg. Isso elimina a dependência
  // implícita de platform.config.json nos testes (#2147 finding 6).
  let cfConfig: { kvNamespaceId: string; workerUrl: string } | null = null;
  if (target === "cloudflare" && !opts.uploaders?.uploadToCloudflare) {
    const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
    const kvNamespaceId = cfg?.poll?.kv_namespace_id;
    const workerUrl = cfg?.poll?.worker_url ?? "https://poll.diaria.workers.dev";
    if (!kvNamespaceId) {
      throw new Error("platform.config.json → poll.kv_namespace_id não configurado (target=cloudflare)");
    }
    cfConfig = { kvNamespaceId, workerUrl };
  }

  for (const spec of specs) {
    const imagePath = resolve(editionDir, spec.filename);
    if (!existsSync(imagePath)) {
      // #1701: specs best-effort (d2/d3 no newsletter mode) pulam quando ausentes
      // — não bloqueiam o upload do que o email de fato usa (cover/d1/eia).
      if (spec.optional) continue;
      throw new Error(`Imagem não encontrada: ${imagePath}`);
    }
    const mime = mimeTypeFor(spec.filename);
    const localMd5 = md5OfFile(imagePath);

    // #1418: cache hit + md5 match → reuse. md5 ausente (entries pre-#1418)
    // OU mudou drive↔cloudflare OU bytes locais diferem → re-uploadar.
    // #1865: a decisão de REUSE ainda gateia em `skipExisting` (--no-cache →
    // false → reuse=false → re-upload). `existing[spec.key]` só alimenta o
    // shouldReuse e a preservação de cloudflare_url; não força reuse sozinho.
    const cached = existing[spec.key];
    let reuse =
      skipExisting && !forceReupload && shouldReuseCachedUpload(cached, imagePath, target, localMd5);
    // #1704 self-heal: pra cloudflare, a key cacheada precisa bater com a que
    // gravaríamos agora. Uma key legacy do É IA? COM hash (cacheada antes do
    // noCacheBust) passa no check de md5 mas aponta pra key errada → /vote 404.
    // Forçar re-upload nesse caso pra a key sem hash de fato cair no KV.
    if (reuse && target === "cloudflare" && cached?.file_id !== kvKeyForSpec(editionDir, spec, localMd5)) {
      reuse = false;
    }
    if (reuse) continue;

    if (target === "cloudflare") {
      // #1584: md5 suffix no key cache-busts re-uploads.
      // #1704: imagens do É IA? (spec.noCacheBust) NÃO recebem o sufixo — o
      // Worker /vote monta a URL com convenção fixa sem hash; com sufixo dá 404.
      const key = kvKeyForSpec(editionDir, spec, localMd5);
      const url = await uploadToCloudflare(imagePath, key, cfConfig!);
      images[spec.key] = {
        file_id: key,
        url,
        mime_type: mime,
        filename: spec.filename,
        target: "cloudflare",
        md5: localMd5,
        cloudflare_url: url,
      };
    } else {
      const content = readFileSync(imagePath);
      const driveName = `diaria-${spec.key}-${Date.now()}-${spec.filename}`;
      const { id: fileId } = await uploadToDrive(driveName, content, mime);
      await makeDrivePublic(fileId);
      // #1584: preserva cloudflare_url se já estava no cache (mode=newsletter
      // rodou primeiro e fez upload pra Cloudflare). Sem isso, social mode
      // sobrescrevia o entry e o renderer social perdia a URL Cloudflare.
      const preservedCloudflare = cached?.cloudflare_url;
      images[spec.key] = {
        file_id: fileId,
        url: publicImageUrl(fileId),
        mime_type: mime,
        filename: spec.filename,
        target: "drive",
        md5: localMd5,
        ...(preservedCloudflare ? { cloudflare_url: preservedCloudflare } : {}),
      };
    }
  }

  writeFileSync(
    cachePath,
    JSON.stringify({ images }, null, 2) + "\n",
    "utf8",
  );

  return { out_path: cachePath, images };
}

/**
 * Verifica que o cache final contém todas as keys esperadas pro mode.
 * (#1275) — defesa contra cache misto entre modes onde upload-images-public
 * é chamado várias vezes mas cache fica parcial (ex: mode newsletter rodou,
 * mode social não, mas publish-linkedin lê cache assumindo d1/d2/d3 presentes).
 *
 * Throw com erro claro se alguma key estiver faltando.
 */
export function assertCacheCompleteness(
  images: Record<string, PublicImage>,
  mode: UploadMode,
): void {
  const expectedKeys = (() => {
    if (mode === "social") return ["d1", "d2", "d3"];
    // #1583: newsletter sobe cover/d1/eia (o que o EMAIL usa). #1701: d2/d3
    // 1x1 também sobem ao CF (pro social preview) mas são BEST-EFFORT (optional).
    // #2133/#2141: d2_2x1/d3_2x1 são required — email body usa {{IMG:04-d2-2x1.jpg}}
    // / {{IMG:04-d3-2x1.jpg}}; se ausentes, substitute-image-urls.ts escreve o HTML
    // com placeholders crus e sai com exit 2. Defense-in-depth na camada de upload.
    if (mode === "newsletter")
      return ["cover", "d1", "eia_a", "eia_b", "d2_2x1", "d3_2x1"];
    // mode === "all"
    return ["cover", "eia_a", "eia_b", "d1", "d2", "d3"];
  })();
  const missing = expectedKeys.filter((k) => !images[k]?.url);
  if (missing.length > 0) {
    throw new Error(
      `upload-images-public: cache final não tem todas as keys esperadas pro mode=${mode}. ` +
      `Missing: ${missing.join(", ")}. Presentes: ${Object.keys(images).join(", ") || "<none>"}. ` +
      `Verifique platform.config.json + se imagens locais existem em data/editions/{AAMMDD}/.`,
    );
  }
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  // Flags booleanas (sem valor após). #1275: --no-require-keys opt-out de validação.
  // #1418: --force-reupload ignora cache md5/target e força upload de novo.
  const BOOL_FLAGS = new Set(["--no-cache", "--no-require-keys", "--force-reupload"]);
  for (let i = 0; i < argv.length; i++) {
    if (BOOL_FLAGS.has(argv[i])) {
      out[argv[i].slice(2)] = true;
    } else if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const editionDirArg = args["edition-dir"];
  if (typeof editionDirArg !== "string") {
    console.error(
      "Uso: upload-images-public.ts --edition-dir <path> [--mode social|newsletter|all] [--target drive|cloudflare] [--no-cache] [--force-reupload]\n" +
        "\n" +
        "Default target: 'cloudflare' pra todos os modes (#2147 — d2/d3 social agora vão pro KV, não Drive).\n" +
        "--force-reupload: ignora cache md5/target e força re-upload (recovery após bytes locais mudarem).",
    );
    process.exit(1);
  }
  const editionDir = resolve(ROOT, editionDirArg);
  const skipExisting = !args["no-cache"];
  const forceReupload = args["force-reupload"] === true;
  const modeArg = args.mode;
  const mode: UploadMode =
    modeArg === "newsletter" || modeArg === "all" || modeArg === "social"
      ? modeArg
      : "social";

  const targetArg = args.target;
  const target: UploadTarget | undefined =
    targetArg === "drive" || targetArg === "cloudflare" ? targetArg : undefined;

  const result = await uploadPublicImages({ editionDir, mode, skipExisting, target, forceReupload });
  console.log(JSON.stringify(result, null, 2));

  // #1275: validate cache completeness por default. Opt-out via --no-require-keys
  // pra casos onde caller sabe que cache final é parcial (raro).
  const requireKeys = !args["no-require-keys"];
  if (requireKeys) {
    try {
      assertCacheCompleteness(result.images, mode);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(2);
    }
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
}
