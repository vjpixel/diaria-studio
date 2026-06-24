/**
 * publish-threads.ts (#2479)
 *
 * Publica posts no Threads (d1, d2 — ou d1, d2, d3) via Threads API oficial da Meta.
 * A Threads API é separada da Graph API do Instagram/Facebook: app próprio + token
 * de longa duração + Threads user ID.
 *
 * Fluxo de 2 passos da Threads API:
 *   (1) POST /{threads-user-id}/threads      → cria media container (text + image_url)
 *   (2) POST /{threads-user-id}/threads_publish → publica o container
 *
 * Limite do Threads: 500 chars por post. Se o texto exceder 500 chars, o post é
 * publicado como cadeia (thread): o primeiro post contém os primeiros 500 chars, e
 * os subsequentes encadeiam via reply_to_id — análogo a um thread no Twitter/X.
 *
 * Fallback de conteúdo: se 03-social.md não tiver seção `# Threads`, usa Facebook
 * como fallback (mesmo conteúdo de caption), truncando para 500 chars.
 *
 * Credenciais (runtime-only):
 *   THREADS_ACCESS_TOKEN — token de longa duração do app Threads da Meta
 *   THREADS_USER_ID      — Threads user ID da conta @diar.ia.br
 *
 * Se as env vars estiverem ausentes, o script encerra com exit 0 (skip gracioso) —
 * Threads é best-effort, não bloqueia outros canais (análogo a publish-instagram.ts).
 *
 * Uso:
 *   npx tsx scripts/publish-threads.ts \
 *     --edition-dir data/editions/260624/ \
 *     [--skip-existing]     # pula posts já em 06-social-published.json (default: true)
 *     [--no-skip-existing]  # força re-publicação
 *
 * Resume-aware: lê 06-social-published.json e pula posts threads já publicados.
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
import { parseDestaqueHeaders } from "./lint-social-md.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const THREADS_API_BASE = "https://graph.threads.net";
const THREADS_API_VERSION = "v1.0";

/** Limite de caracteres por post no Threads. */
export const THREADS_CHAR_LIMIT = 500;

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--skip-existing") {
      args["skip-existing"] = true;
    } else if (argv[i] === "--no-skip-existing") {
      args["no-skip-existing"] = true;
    } else if (argv[i] === "--test-mode") {
      args["test-mode"] = true;
    } else if (argv[i] === "--dry-run") {
      // --dry-run: real guard — does NOT call fetch at all (unlike --test-mode which
      // only skips sleep). Safe to run with real credentials in the environment.
      args["dry-run"] = true;
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
 * Extrai a seção genérica `# {Title}` do 03-social.md.
 * Normaliza CRLF → LF.
 */
function extractSection(md: string, sectionTitle: string): string | null {
  const normalized = md.replace(/\r\n/g, "\n");
  const re = new RegExp(`(?:^|\\n)# ${sectionTitle}\\n([\\s\\S]*?)(?=\\n# |$)`, "i");
  const m = normalized.match(re);
  return m ? m[1] : null;
}

/**
 * Extrai a lista de destaques da seção Threads do 03-social.md.
 * Fallback para seção Facebook se não houver seção Threads.
 * Último fallback: ["d1","d2","d3"].
 */
export function extractDestaquesFromSocialMd(socialMd: string): string[] {
  // Tentar seção Threads primeiro; depois Facebook como fallback
  let section = extractSection(socialMd, "Threads");
  if (section === null) {
    // Fallback para Facebook (mesma lógica do publish-instagram.ts)
    section = extractSection(socialMd, "Facebook");
  }
  if (section === null) return ["d1", "d2", "d3"];
  const valid = parseDestaqueHeaders(section);
  return valid.length >= 2 ? valid : ["d1", "d2", "d3"];
}

/**
 * Extrai o texto do post para um destaque específico.
 * Fallback: seção Facebook se Threads ausente.
 */
export function extractPostText(socialMd: string, destaque: string): string {
  // Normalizar CRLF → LF
  socialMd = socialMd.replace(/\r\n/g, "\n");

  // Tentar seção Threads primeiro; depois Facebook como fallback
  for (const platTitle of ["Threads", "Facebook"]) {
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
    `Destaque '${destaque}' não encontrado em seção Threads ou Facebook de 03-social.md`,
  );
}

/**
 * Divide um texto longo em chunks de no máximo `maxLen` chars,
 * quebrando em espaços (não no meio de palavras).
 * Retorna lista com 1+ chunks. Se o texto cabe em um único post,
 * retorna `[text]` sem modificação.
 */
export function splitIntoThreadChunks(text: string, maxLen = THREADS_CHAR_LIMIT): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Procurar o último espaço antes do limite
    let cut = remaining.lastIndexOf(" ", maxLen - 1);
    if (cut <= 0) {
      // Sem espaço (ou espaço na posição 0) — cortar no limite duro para
      // evitar chunk vazio quando cut=0.
      cut = maxLen;
    }
    const chunk = remaining.slice(0, cut).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(cut).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * Passo 1: cria media container no Threads.
 * Retorna o container_id para uso no passo 2 (threads_publish).
 *
 * Suporta post de texto puro (sem imagem — Threads API aceita media_type TEXT).
 * Para posts com imagem: adicionar image_url + media_type=IMAGE.
 */
async function createThreadsContainer(
  userId: string,
  accessToken: string,
  text: string,
  replyToId: string | null,
  apiVersion: string,
): Promise<string> {
  const url = `${THREADS_API_BASE}/${apiVersion}/${userId}/threads`;
  const params = new URLSearchParams();
  params.append("media_type", "TEXT");
  params.append("text", text);
  params.append("access_token", accessToken);
  if (replyToId) {
    params.append("reply_to_id", replyToId);
  }

  const res = await fetch(url, { method: "POST", body: params });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Threads /threads HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { id?: string; error?: unknown };
  if (data.error) {
    throw new Error(`Threads /threads API error: ${JSON.stringify(data.error)}`);
  }
  if (!data.id) {
    throw new Error(`Threads /threads response sem id: ${JSON.stringify(data)}`);
  }
  return data.id;
}

/**
 * Passo 2: publica o container criado no passo 1.
 * Retorna o media_id do post publicado.
 */
async function publishThreadsContainer(
  userId: string,
  accessToken: string,
  containerId: string,
  apiVersion: string,
): Promise<string> {
  const url = `${THREADS_API_BASE}/${apiVersion}/${userId}/threads_publish`;
  const params = new URLSearchParams();
  params.append("creation_id", containerId);
  params.append("access_token", accessToken);

  const res = await fetch(url, { method: "POST", body: params });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Threads /threads_publish HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { id?: string; error?: unknown };
  if (data.error) {
    throw new Error(`Threads /threads_publish API error: ${JSON.stringify(data.error)}`);
  }
  if (!data.id) {
    throw new Error(`Threads /threads_publish response sem id: ${JSON.stringify(data)}`);
  }
  return data.id;
}

/**
 * Publica um post (possivelmente encadeado) no Threads.
 * Se `chunks.length > 1`, publica o primeiro post e encadeia os restantes
 * via reply_to_id do post publicado anterior.
 *
 * Retorna o media_id do primeiro post (root da thread).
 */
async function publishThread(
  userId: string,
  accessToken: string,
  chunks: string[],
  apiVersion: string,
): Promise<string> {
  let rootMediaId: string | null = null;
  let replyToId: string | null = null;

  for (let i = 0; i < chunks.length; i++) {
    const containerId = await createThreadsContainer(
      userId,
      accessToken,
      chunks[i],
      replyToId,
      apiVersion,
    );
    const mediaId = await publishThreadsContainer(userId, accessToken, containerId, apiVersion);

    if (i === 0) {
      rootMediaId = mediaId;
      replyToId = mediaId; // próximo post encadeia a partir deste
    } else {
      replyToId = mediaId;
    }
  }

  if (rootMediaId === null) {
    throw new Error("publishThread: chunks array vazio — texto do post não pode ser vazio");
  }
  return rootMediaId;
}

/**
 * Busca o permalink público do post recém-publicado no Threads.
 * Best-effort: se falhar, retorna null (o post foi publicado com sucesso,
 * só não temos o link canônico).
 */
async function fetchThreadsPermalink(
  mediaId: string,
  accessToken: string,
  apiVersion: string,
): Promise<string | null> {
  try {
    const url =
      `${THREADS_API_BASE}/${apiVersion}/${mediaId}` +
      `?fields=permalink&access_token=${encodeURIComponent(accessToken)}`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return null;
    const data = (await res.json()) as { permalink?: string; error?: unknown };
    if (data.error || !data.permalink) return null;
    return data.permalink;
  } catch {
    return null;
  }
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
  const isDryRun = !!args["dry-run"];

  // Carregar credenciais — env vars obrigatórias em runtime
  const threadsUserId = process.env.THREADS_USER_ID || "";
  const accessToken = process.env.THREADS_ACCESS_TOKEN || "";
  const apiVersion = process.env.THREADS_API_VERSION || THREADS_API_VERSION;

  // Best-effort: se creds ausentes, skip gracioso (exit 0, não exit 1).
  // Threads é dispatch best-effort — análogo a publish-instagram.ts (#2486).
  // Exit 1 mascararia violations de consent de LinkedIn/Facebook nos outros canais.
  if (!threadsUserId || !accessToken) {
    const missing = [
      !threadsUserId && "THREADS_USER_ID",
      !accessToken && "THREADS_ACCESS_TOKEN",
    ]
      .filter(Boolean)
      .join(", ");
    console.warn(
      `SKIP: ${missing} ausente(s) — Threads não publicado nesta edição.\n` +
        "Configure em .env.local para habilitar o Threads.\n" +
        "  THREADS_USER_ID: Threads user ID da conta @diar.ia.br\n" +
        "  THREADS_ACCESS_TOKEN: token de longa duração do app Threads da Meta",
    );
    process.exit(0);
  }

  // Carregar social content
  const socialMdPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialMdPath)) {
    console.error("ERROR: 03-social.md não encontrado. Rode Stage 2 primeiro.");
    process.exit(1);
  }
  const socialMd = readFileSync(socialMdPath, "utf8");

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

  // Extrair destaques da seção Threads (ou fallback para Facebook)
  const destaques = extractDestaquesFromSocialMd(socialMd);
  const results: PostEntry[] = [];
  let skippedCount = 0;

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
          p.platform === "threads" &&
          p.destaque === d &&
          (p.status === "draft" || p.status === "scheduled" || p.status === "published"),
      );
      if (existing) {
        console.log(`SKIP threads/${d} — already ${existing.status}`);
        results.push(existing);
        skippedCount += 1;
        continue;
      }
    }

    // Extrair texto do post
    let text: string;
    try {
      text = extractPostText(socialMd, d);
    } catch (e: any) {
      console.error(`ERROR extracting text for threads/${d}: ${e.message}`);
      const entry: PostEntry = {
        platform: "threads",
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

    // Guard: texto vazio (ex: destaque com apenas comentários HTML) → fail-fast
    // sem tentar publicar post em branco na Threads API.
    if (!text) {
      console.error(`ERROR threads/${d}: texto vazio após strip de comentários — skip`);
      const entry: PostEntry = {
        platform: "threads",
        destaque: d,
        url: null,
        status: "failed",
        scheduled_at: null,
        reason: "texto vazio após strip de comentários HTML",
      };
      tagAndAppend(entry);
      results.push(entry);
      continue;
    }

    // Dividir em chunks de 500 chars se necessário
    const chunks = splitIntoThreadChunks(text, THREADS_CHAR_LIMIT);
    if (chunks.length > 1) {
      console.log(`threads/${d}: texto longo (${text.length} chars) → ${chunks.length} posts encadeados`);
    }

    // --dry-run guard: do NOT call fetch. Print what would be published and skip.
    // This is a real guard (unlike --test-mode which only skips sleep).
    if (isDryRun) {
      console.log(
        `DRY-RUN threads/${d}: ${chunks.length} chunk(s), ${text.length} chars total\n` +
        chunks.map((c, i) => `  chunk ${i + 1}: ${c.slice(0, 80)}${c.length > 80 ? "…" : ""}`).join("\n"),
      );
      const entry: PostEntry = {
        platform: "threads",
        destaque: d,
        url: null,
        status: "draft",
        scheduled_at: null,
        reason: "dry-run — não publicado",
      };
      results.push(entry);
      continue;
    }

    // Publicar com retry + exponential backoff (análogo a publish-instagram.ts).
    //
    // ATOMICIDADE: retry só é seguro para posts de chunk único (1 container →
    // threads_publish). Quando há múltiplos chunks, publishThread publica o
    // chunk 1 antes de tentar o chunk 2. Se o chunk 2 falha, o chunk 1 já está
    // ao vivo no Threads — um retry recomeça do zero e cria um segundo post
    // raiz independente (post órfão). Para evitar isso, não fazemos retry em
    // falhas de multi-chunk: a primeira exceção é registrada como "failed" e
    // o editor resolve manualmente.
    const isMultiChunk = chunks.length > 1;
    let lastError = "";
    let success = false;

    const maxAttempts = isMultiChunk ? 1 : 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`Publishing threads/${d} (attempt ${attempt}/${maxAttempts}, ${chunks.length} chunk(s))...`);

        const rootMediaId = await publishThread(threadsUserId, accessToken, chunks, apiVersion);
        console.log(`  Publicado: ${rootMediaId}`);

        // Buscar permalink real (best-effort)
        const postUrl = await fetchThreadsPermalink(rootMediaId, accessToken, apiVersion);
        const entry: PostEntry = {
          platform: "threads",
          destaque: d,
          url: postUrl,
          status: "published",
          scheduled_at: null,
          threads_media_id: rootMediaId,
          threads_chunks: chunks.length,
        };

        tagAndAppend(entry);
        results.push(entry);
        console.log(`OK threads/${d} — published — ${postUrl ?? `(media_id ${rootMediaId})`}`);
        success = true;
        break;
      } catch (e: any) {
        lastError = e.message;
        console.error(`Attempt ${attempt}/${maxAttempts} failed for threads/${d}: ${lastError}`);
        if (isMultiChunk) {
          console.warn(
            `threads/${d}: post multi-chunk — sem retry para evitar posts órfãos. ` +
            `Chunk 1 pode ter sido publicado. Verificar manualmente no Threads.`,
          );
        } else if (attempt < maxAttempts) {
          const delaySec = Math.pow(2, attempt - 1); // 1s, 2s
          if (!isTest) {
            await new Promise((r) => setTimeout(r, delaySec * 1000));
          }
        }
      }
    }

    if (!success) {
      const entry: PostEntry = {
        platform: "threads",
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

  const summary = {
    total: results.length,
    published: results.filter((r) => r.status === "published").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: skippedCount,
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
