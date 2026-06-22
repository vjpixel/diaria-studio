/**
 * publish-instagram.ts (#49)
 *
 * Publica posts no Instagram (d1, d2 — ou d1, d2, d3) via Instagram Graph API.
 * Análogo a publish-facebook.ts — mesma estrutura, fluxo de 2 passos do IG.
 * #2343: suporta edições com 2 ou 3 destaques.
 *
 * Fluxo de 2 passos da Instagram Graph API:
 *   (1) POST /{ig-user-id}/media          → cria media container (image_url + caption)
 *   (2) POST /{ig-user-id}/media_publish   → publica o container
 *
 * NOTA: A API de agendamento do Instagram (published=false + scheduled_publish_time)
 * exige o escopo "instagram_content_publish" + a conta precisa ter o recurso
 * "Content Publishing" aprovado (apenas disponível em Business/Creator accounts
 * via Instagram Graph API v18+). Se o conta não tiver o recurso, a publicação
 * é imediata. Este script publica imediato por padrão (sem --schedule).
 * Para agendar: implementar quando o recurso for ativado na conta.
 *
 * Uso:
 *   npx tsx scripts/publish-instagram.ts \
 *     --edition-dir data/editions/260422/ \
 *     [--skip-existing]     # pula posts já em 06-social-published.json
 *
 * Resume-aware: lê 06-social-published.json e pula posts instagram já publicados.
 * Append imediato após cada post para proteger contra crash.
 *
 * Output: appends em {edition-dir}/_internal/06-social-published.json
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv(); // carrega .env.local + .env antes de process.env access

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { appendSocialPosts, PostEntry, SocialPublished } from "./lib/social-published-store.ts";
import { extractPlatformSection, parseDestaqueHeaders } from "./lint-social-md.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const INSTAGRAM_API_BASE = "https://graph.facebook.com"; // mesma base da Graph API
const INSTAGRAM_API_VERSION = "v25.0";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--skip-existing") {
      args["skip-existing"] = true;
    } else if (argv[i] === "--no-skip-existing") {
      args["no-skip-existing"] = true;
    } else if (argv[i] === "--test-mode") {
      args["test-mode"] = true;
    } else if (argv[i].startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

function loadPublished(path: string): SocialPublished {
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8"));
  }
  return { posts: [] };
}

/**
 * Extrai o conteúdo de uma seção `# {Title}` do 03-social.md.
 * Implementação inline para suportar "Instagram" (além de linkedin/facebook
 * do extractPlatformSection de lint-social-md.ts).
 */
function extractSection(md: string, sectionTitle: string): string | null {
  const re = new RegExp(
    `(?:^|\\n)# ${sectionTitle}\\n([\\s\\S]*?)(?=\\n# |$)`,
    "i",
  );
  const m = md.match(re);
  return m ? m[1] : null;
}

/**
 * Extrai a lista de destaques presentes na seção Instagram do 03-social.md.
 * Retorna ["d1","d2"] ou ["d1","d2","d3"] conforme a edição.
 * Fallback: seção Facebook (Instagram usa mesma caption + imagem quadrada).
 * Último fallback: ["d1","d2","d3"] se nenhuma seção for encontrada.
 */
export function extractDestaquesFromSocialMd(socialMd: string, platform: "instagram"): string[] {
  // Tentar seção Instagram primeiro; depois Facebook como fallback.
  let section = extractSection(socialMd, "Instagram");
  if (section === null) {
    section = extractPlatformSection(socialMd, "facebook");
  }
  if (section === null) return ["d1", "d2", "d3"];
  const valid = parseDestaqueHeaders(section);
  return valid.length >= 2 ? valid : ["d1", "d2", "d3"];
}

/**
 * Extrai o texto do post para uma plataforma + destaque específicos.
 * Análogo ao extractPostText de publish-facebook.ts.
 * Se não houver seção Instagram, usa seção Facebook como fallback.
 */
export function extractPostText(socialMd: string, destaque: string): string {
  // Normalizar CRLF → LF
  socialMd = socialMd.replace(/\r\n/g, "\n");

  // Tentar seção Instagram primeiro
  for (const platTitle of ["Instagram", "Facebook"]) {
    const platRe = new RegExp(`(?:^|\\n)# ${platTitle}\\n([\\s\\S]*?)(?=\\n# |$)`, "i");
    const platMatch = socialMd.match(platRe);
    if (!platMatch) continue;

    const dRe = new RegExp(
      `(?:^|\\n)## ${destaque}\\n([\\s\\S]*?)(?=\\n## d\\d+\\b|\\n# |$)`,
      "i",
    );
    const dMatch = platMatch[1].match(dRe);
    if (dMatch) {
      return dMatch[1].replace(/<!--[\s\S]*?-->/g, "").trim();
    }
  }

  throw new Error(
    `Destaque '${destaque}' não encontrado em seção Instagram ou Facebook de 03-social.md`,
  );
}

/**
 * Trunca caption para o limite do Instagram (2200 caracteres).
 * Preserva hashtags — corta no último espaço antes do limite.
 */
export function truncateCaption(caption: string, maxLen = 2200): string {
  if (caption.length <= maxLen) return caption;
  const cut = caption.lastIndexOf(" ", maxLen - 3);
  const idx = cut > 0 ? cut : maxLen - 3;
  return caption.slice(0, idx) + "...";
}

/**
 * Passo 1: cria media container no Instagram.
 * Retorna o container_id para uso no passo 2 (media_publish).
 */
async function createMediaContainer(
  igUserId: string,
  accessToken: string,
  imageUrl: string,
  caption: string,
  apiVersion: string,
): Promise<string> {
  const url = `${INSTAGRAM_API_BASE}/${apiVersion}/${igUserId}/media`;
  const formData = new FormData();
  formData.append("image_url", imageUrl);
  formData.append("caption", caption);
  formData.append("access_token", accessToken);

  const res = await fetch(url, { method: "POST", body: formData });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Instagram /media HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { id?: string; error?: unknown };
  if (data.error) {
    throw new Error(`Instagram /media API error: ${JSON.stringify(data.error)}`);
  }
  if (!data.id) {
    throw new Error(`Instagram /media response sem id: ${JSON.stringify(data)}`);
  }
  return data.id;
}

/**
 * Passo 2: publica o container criado no passo 1.
 * Retorna o media_id do post publicado.
 */
async function publishMediaContainer(
  igUserId: string,
  accessToken: string,
  containerId: string,
  apiVersion: string,
): Promise<string> {
  const url = `${INSTAGRAM_API_BASE}/${apiVersion}/${igUserId}/media_publish`;
  const formData = new FormData();
  formData.append("creation_id", containerId);
  formData.append("access_token", accessToken);

  const res = await fetch(url, { method: "POST", body: formData });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Instagram /media_publish HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { id?: string; error?: unknown };
  if (data.error) {
    throw new Error(`Instagram /media_publish API error: ${JSON.stringify(data.error)}`);
  }
  if (!data.id) {
    throw new Error(`Instagram /media_publish response sem id: ${JSON.stringify(data)}`);
  }
  return data.id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const editionDirArg = args["edition-dir"] as string | undefined;
  if (!editionDirArg) {
    console.error("ERRO: --edition-dir é obrigatório.");
    process.exit(1);
  }
  const editionDir = resolve(ROOT, editionDirArg);
  const skipExisting = args["no-skip-existing"] !== true;
  const isTest = !!args["test-mode"];

  // Carregar credenciais — env vars obrigatórias em runtime
  const igUserId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || "";
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN || "";
  const apiVersion = process.env.INSTAGRAM_API_VERSION || INSTAGRAM_API_VERSION;

  if (!igUserId) {
    console.error(
      "ERRO: INSTAGRAM_BUSINESS_ACCOUNT_ID não está setado.\n" +
        "Adicionar em .env. Encontrar o Business Account ID em:\n" +
        "  https://developers.facebook.com/apps/ → seu app → Instagram → Business Account ID\n" +
        "  ou via GET /me/accounts → /ig_users.",
    );
    process.exit(1);
  }
  if (!accessToken) {
    console.error(
      "ERRO: INSTAGRAM_ACCESS_TOKEN não está setado.\n" +
        "Adicionar em .env. Gerar em:\n" +
        "  https://developers.facebook.com/tools/explorer/\n" +
        "  Escopos necessários: instagram_basic, instagram_content_publish, pages_read_engagement.\n" +
        "  Usar token de longa duração (60 dias) — renovar antes de expirar.",
    );
    process.exit(1);
  }

  // Carregar social content
  const socialMdPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialMdPath)) {
    console.error("ERROR: 03-social.md não encontrado. Rode Stage 2 primeiro.");
    process.exit(1);
  }
  const socialMd = readFileSync(socialMdPath, "utf8");

  // Extrair data da edição do nome do diretório
  const editionDate = editionDir.replace(/[/\\]+$/, "").split(/[/\\]/).pop()!;

  // Resolver path do arquivo de publicações
  const internalPath = resolve(editionDir, "_internal", "06-social-published.json");
  const rootPath = resolve(editionDir, "06-social-published.json");
  let publishedPath: string;
  if (existsSync(internalPath)) {
    publishedPath = internalPath;
  } else if (existsSync(rootPath)) {
    publishedPath = rootPath;
  } else {
    mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
    publishedPath = internalPath;
  }

  // Extrair destaques da seção Instagram (ou fallback para Facebook)
  const destaques = extractDestaquesFromSocialMd(socialMd, "instagram");
  const results: PostEntry[] = [];

  const tagAndAppend = (entry: PostEntry): void => {
    if (isTest) entry.is_test = true;
    appendSocialPosts(publishedPath, [entry]);
  };

  for (const d of destaques) {
    // Releitura a cada iteração para detectar entradas concorrentes
    const published = loadPublished(publishedPath);

    if (skipExisting) {
      const existing = published.posts.find(
        (p) =>
          p.platform === "instagram" &&
          p.destaque === d &&
          (p.status === "draft" || p.status === "scheduled" || p.status === "published"),
      );
      if (existing) {
        console.log(`SKIP instagram/${d} — already ${existing.status}`);
        results.push(existing);
        continue;
      }
    }

    // Extrair caption
    let caption: string;
    try {
      const raw = extractPostText(socialMd, d);
      caption = truncateCaption(raw);
    } catch (e: any) {
      console.error(`ERROR extracting text for instagram/${d}: ${e.message}`);
      const entry: PostEntry = {
        platform: "instagram",
        destaque: d,
        url: null,
        status: "failed",
        scheduled_at: null,
        reason: e.message,
      };
      tagAndAppend(entry);
      results.push(entry);
      continue;
    }

    // Verificar imagem — Instagram prefere quadrada (1x1)
    const imageFile = `04-${d}-1x1.jpg`;
    const imagePath = resolve(editionDir, imageFile);
    if (!existsSync(imagePath)) {
      console.error(`ERROR: Imagem ${imageFile} não encontrada em ${editionDir}`);
      const entry: PostEntry = {
        platform: "instagram",
        destaque: d,
        url: null,
        status: "failed",
        scheduled_at: null,
        reason: `${imageFile} not found`,
      };
      tagAndAppend(entry);
      results.push(entry);
      continue;
    }

    // Para Instagram Graph API, a imagem precisa estar em URL pública acessível.
    // Lê o cache 06-public-images.json (gerado por upload-images-public.ts no Stage 5c-pre).
    const publicImagesPath = resolve(editionDir, "_internal", "06-public-images.json");
    if (!existsSync(publicImagesPath)) {
      console.error(
        `ERROR: 06-public-images.json não encontrado. ` +
          `Rode scripts/upload-images-public.ts antes de publicar no Instagram.`,
      );
      const entry: PostEntry = {
        platform: "instagram",
        destaque: d,
        url: null,
        status: "failed",
        scheduled_at: null,
        reason: "06-public-images.json ausente — rode upload-images-public.ts",
      };
      tagAndAppend(entry);
      results.push(entry);
      continue;
    }

    const publicImages = JSON.parse(readFileSync(publicImagesPath, "utf8")) as Record<
      string,
      unknown
    >;
    // Chave esperada: "d1_1x1", "d2_1x1", "d3_1x1"
    const imgKey = `${d}_1x1`;
    const imageUrl = publicImages[imgKey] as string | undefined;
    if (!imageUrl) {
      console.error(
        `ERROR: URL pública para ${imgKey} não encontrada em 06-public-images.json.\n` +
          `Chaves disponíveis: ${Object.keys(publicImages).join(", ")}`,
      );
      const entry: PostEntry = {
        platform: "instagram",
        destaque: d,
        url: null,
        status: "failed",
        scheduled_at: null,
        reason: `public URL para ${imgKey} ausente em 06-public-images.json`,
      };
      tagAndAppend(entry);
      results.push(entry);
      continue;
    }

    // Publicar com retry + exponential backoff (análogo a publish-facebook.ts)
    let lastError = "";
    let success = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`Publishing instagram/${d} (attempt ${attempt})...`);

        // Passo 1: criar media container
        const containerId = await createMediaContainer(
          igUserId,
          accessToken,
          imageUrl,
          caption,
          apiVersion,
        );
        console.log(`  Container criado: ${containerId}`);

        // Passo 2: publicar container
        const mediaId = await publishMediaContainer(igUserId, accessToken, containerId, apiVersion);
        console.log(`  Publicado: ${mediaId}`);

        const postUrl = `https://www.instagram.com/p/${mediaId}/`;
        const entry: PostEntry = {
          platform: "instagram",
          destaque: d,
          url: postUrl,
          status: "published",
          scheduled_at: null,
          ig_media_id: mediaId,
          ig_container_id: containerId,
        };

        tagAndAppend(entry);
        results.push(entry);
        console.log(`OK instagram/${d} — published — ${postUrl}`);
        success = true;
        break;
      } catch (e: any) {
        lastError = e.message;
        console.error(`Attempt ${attempt}/3 failed for instagram/${d}: ${lastError}`);
        if (attempt < 3) {
          const delaySec = Math.pow(2, attempt - 1); // 1s, 2s
          if (!isTest) {
            await new Promise((r) => setTimeout(r, delaySec * 1000));
          }
        }
      }
    }

    if (!success) {
      const entry: PostEntry = {
        platform: "instagram",
        destaque: d,
        url: null,
        status: "failed",
        scheduled_at: null,
        reason: lastError,
      };
      tagAndAppend(entry);
      results.push(entry);
    }
  }

  // Summary
  const summary = {
    total: results.length,
    published: results.filter((r) => r.status === "published").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status !== "failed" && results.indexOf(r) === results.indexOf(r)).length,
  };

  console.log(JSON.stringify({ out_path: publishedPath, summary, posts: results }, null, 2));
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
