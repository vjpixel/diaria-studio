/**
 * publish-twitter.ts (#3994)
 *
 * Publica posts no Twitter/X (d1, d2, d3) via API v2 oficial, free tier
 * (`POST /2/tweets`), autenticado com OAuth 1.0a User Context
 * (`scripts/lib/twitter-oauth1.ts`).
 *
 * Fonte do texto (#3992): SÓ a seção `# Curto` de 03-social.md (texto único
 * compartilhado com Threads, ≤280 chars, escrito por `social-curto`).
 * **Sem fallback** — diferente de `publish-threads.ts` (que ainda cai pra
 * Facebook em edições antigas), aqui a ausência da seção é tratada como
 * "sem conteúdo pronto pro X nesta edição" e o destaque é pulado com log,
 * nunca improvisando texto (decisão explícita da issue #3994).
 *
 * Publicação imediata, sem agendamento (recomendação (a) do plano da issue):
 * o free tier do X não tem agendamento nativo, e X é canal despriorizado
 * (zero conversões atribuídas no dia 1 da campanha, decisão 22/07) — não
 * justifica a infra de fila do Worker (`diaria-linkedin-cron`) usada por
 * LinkedIn/Facebook/Instagram/Threads. Post sai no instante do dispatch do
 * Stage 5 (manhã, horário aceitável pro X). Sem `--schedule` nesta v1;
 * follow-up se o canal reagir.
 *
 * Credenciais (runtime-only, OAuth 1.0a User Context):
 *   TWITTER_API_KEY            — consumer key do app no X Developer Portal
 *   TWITTER_API_SECRET         — consumer secret
 *   TWITTER_ACCESS_TOKEN       — access token da conta @diar.ia (user context)
 *   TWITTER_ACCESS_TOKEN_SECRET — access token secret
 *
 * Se as env vars estiverem ausentes, o script encerra com exit 0 (skip
 * gracioso) — Twitter/X é best-effort, não bloqueia outros canais (mesmo
 * padrão de publish-threads.ts/publish-instagram.ts).
 *
 * Sem mídia nesta v1 (#3994 fase 1: texto+link — o card de preview do link
 * já traz imagem via OG tags da página de destino). Upload de mídia nativa
 * fica como follow-up.
 *
 * Uso:
 *   npx tsx scripts/publish-twitter.ts \
 *     --edition-dir data/editions/260624/ \
 *     [--skip-existing]     # pula posts já em 06-social-published.json (default: true)
 *     [--no-skip-existing]  # força re-publicação
 *     [--dry-run]           # não chama a API, só imprime o que seria publicado
 *
 * Resume-aware: lê 06-social-published.json e pula posts twitter já publicados.
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
import { extractSection } from "./lib/extract-section.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { generateOAuth1AuthHeader } from "./lib/twitter-oauth1.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TWITTER_API_URL = "https://api.twitter.com/2/tweets";

/** Limite de caracteres por tweet no free tier do X. */
export const TWITTER_CHAR_LIMIT = 280;

function loadPublished(path: string): SocialPublished {
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8"));
  }
  return { posts: [] };
}

/**
 * Extrai a lista de destaques da seção `# Curto` do 03-social.md.
 * Sem fallback (#3994): se a seção não existe, retorna `[]` — caller trata
 * como "nada pra publicar nesta edição", nunca improvisa texto de outra seção.
 */
export function extractDestaquesFromCurto(socialMd: string): string[] {
  const section = extractSection(socialMd, "Curto");
  if (section === null) return [];
  const valid = parseDestaqueHeaders(section);
  return valid;
}

/**
 * Extrai o texto do post `# Curto` para um destaque específico.
 * Retorna `null` se a seção `# Curto` ou o destaque dentro dela não existir
 * — nunca lança nem cai pra outra seção (#3994: sem fallback, sem texto
 * improvisado).
 */
export function extractCurtoText(socialMd: string, destaque: string): string | null {
  const normalized = socialMd.replace(/\r\n/g, "\n");
  const section = extractSection(normalized, "Curto");
  if (section === null) return null;

  const dRe = new RegExp(
    `(?:^|\\n)## ${destaque}\\n([\\s\\S]*?)(?=\\n## d\\d+\\b|\\n# |$)`,
    "i",
  );
  const dMatch = section.match(dRe);
  if (!dMatch) return null;
  return dMatch[1].replace(/<!--[\s\S]*?-->/g, "").trim();
}

/**
 * Publica um tweet via `POST /2/tweets` (API v2, OAuth 1.0a User Context).
 * Retorna o id do tweet publicado.
 */
async function postTweet(
  text: string,
  creds: { apiKey: string; apiSecret: string; accessToken: string; accessTokenSecret: string },
): Promise<string> {
  const authHeader = generateOAuth1AuthHeader({
    method: "POST",
    url: TWITTER_API_URL,
    consumerKey: creds.apiKey,
    consumerSecret: creds.apiSecret,
    token: creds.accessToken,
    tokenSecret: creds.accessTokenSecret,
  });

  const res = await fetch(TWITTER_API_URL, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Twitter POST /2/tweets HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  let data: { data?: { id?: string; text?: string }; errors?: unknown };
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`Twitter POST /2/tweets: resposta não é JSON: ${body.slice(0, 300)}`);
  }
  if (data.errors) {
    throw new Error(`Twitter POST /2/tweets API error: ${JSON.stringify(data.errors)}`);
  }
  if (!data.data?.id) {
    throw new Error(`Twitter POST /2/tweets: resposta sem data.id: ${body.slice(0, 300)}`);
  }
  return data.data.id;
}

async function main() {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const editionDirArg = values["edition-dir"];
  if (!editionDirArg) {
    console.error("ERRO: --edition-dir é obrigatório.");
    process.exit(1);
  }
  const editionDir = resolve(ROOT, editionDirArg);
  const skipExisting = !flags.has("no-skip-existing");
  const isTest = flags.has("test-mode");
  const isDryRun = flags.has("dry-run");

  // Guard de config: permite ao editor desligar o canal via platform.config.json
  // sem mexer em credenciais — mesmo padrão de publish-threads.ts/publish-instagram.ts.
  const gateConfig = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const twitterGateConfig = gateConfig?.publishing?.social?.twitter;
  if (twitterGateConfig?.enabled === false) {
    console.warn(
      `SKIP: Twitter/X bloqueado via platform.config.json (publishing.social.twitter.enabled=false).\n` +
        `Motivo: ${twitterGateConfig.disabled_reason || "não especificado"}\n` +
        "Reative setando publishing.social.twitter.enabled:true quando pronto.",
    );
    process.exit(0);
  }

  // Credenciais — env vars obrigatórias em runtime (OAuth 1.0a User Context).
  const apiKey = process.env.TWITTER_API_KEY || "";
  const apiSecret = process.env.TWITTER_API_SECRET || "";
  const accessToken = process.env.TWITTER_ACCESS_TOKEN || "";
  const accessTokenSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET || "";

  // Best-effort: se creds ausentes, skip gracioso (exit 0, não exit 1).
  // Twitter/X é dispatch best-effort — conta + app da marca ainda não existem
  // (#3994, status confirmado 260724) — exit 1 mascararia violations de
  // consent de outros canais.
  if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) {
    const missing = [
      !apiKey && "TWITTER_API_KEY",
      !apiSecret && "TWITTER_API_SECRET",
      !accessToken && "TWITTER_ACCESS_TOKEN",
      !accessTokenSecret && "TWITTER_ACCESS_TOKEN_SECRET",
    ]
      .filter(Boolean)
      .join(", ");
    console.warn(
      `SKIP: ${missing} ausente(s) — Twitter/X não publicado nesta edição.\n` +
        "Configure em .env.local para habilitar (requer conta X da Diar.ia + app no Developer Portal, #3994).",
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

  const destaques = extractDestaquesFromCurto(socialMd);
  if (destaques.length === 0) {
    console.warn(
      "SKIP: seção '# Curto' ausente ou sem destaques em 03-social.md — " +
        "Twitter/X não publicado nesta edição (sem fallback, #3994). " +
        "Rode /diaria-2-escrita social pra gerar a seção via agent social-curto (#3992).",
    );
    process.exit(0);
  }

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
          p.platform === "twitter" &&
          p.destaque === d &&
          (p.status === "draft" || p.status === "scheduled" || p.status === "published"),
      );
      if (existing) {
        console.log(`SKIP twitter/${d} — already ${existing.status}`);
        results.push(existing);
        skippedCount += 1;
        continue;
      }
    }

    const text = extractCurtoText(socialMd, d);
    if (!text) {
      console.warn(`SKIP twitter/${d}: destaque ausente na seção '# Curto' — pulando sem improvisar texto.`);
      continue;
    }

    if (text.length > TWITTER_CHAR_LIMIT) {
      console.error(
        `ERROR twitter/${d}: texto de ${text.length} chars excede o limite de ${TWITTER_CHAR_LIMIT} — ` +
          `não publicado. Ajustar o agent social-curto (#3992) pra respeitar o orçamento.`,
      );
      const entry: PostEntry = {
        platform: "twitter",
        destaque: d,
        url: null,
        status: "failed",
        scheduled_at: null,
        reason: `texto de ${text.length} chars excede ${TWITTER_CHAR_LIMIT} — sem truncagem silenciosa`,
      };
      if (!isDryRun) tagAndAppend(entry);
      results.push(entry);
      continue;
    }

    if (isDryRun) {
      console.log(`DRY-RUN twitter/${d}: ${text.length} chars\n  ${text}`);
      results.push({
        platform: "twitter",
        destaque: d,
        url: null,
        status: "draft",
        scheduled_at: null,
        reason: "dry-run — não publicado",
      });
      continue;
    }

    // Retry com backoff exponencial (análogo a publish-instagram.ts/publish-threads.ts).
    // Chunk único sempre (sem encadeamento) — retry é seguro aqui.
    let lastError = "";
    let success = false;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`Publishing twitter/${d} (attempt ${attempt}/${maxAttempts})...`);
        const tweetId = await postTweet(text, { apiKey, apiSecret, accessToken, accessTokenSecret });
        const postUrl = `https://twitter.com/diar_ia/status/${tweetId}`;
        const entry: PostEntry = {
          platform: "twitter",
          destaque: d,
          url: postUrl,
          status: "published",
          scheduled_at: null,
          twitter_tweet_id: tweetId,
        };
        tagAndAppend(entry);
        results.push(entry);
        console.log(`OK twitter/${d} — published — ${postUrl}`);
        success = true;
        break;
      } catch (e: any) {
        lastError = e.message;
        console.error(`Attempt ${attempt}/${maxAttempts} failed for twitter/${d}: ${lastError}`);
        if (attempt < maxAttempts) {
          const delaySec = Math.pow(2, attempt - 1); // 1s, 2s
          if (!isTest) {
            await new Promise((r) => setTimeout(r, delaySec * 1000));
          }
        }
      }
    }

    if (!success) {
      const entry: PostEntry = {
        platform: "twitter",
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

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
}
