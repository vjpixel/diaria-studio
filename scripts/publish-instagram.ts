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
 * AGENDAMENTO (#3817): a API de Content Publishing do Instagram NÃO tem
 * agendamento nativo — não existe `scheduled_publish_time`/`published=false`
 * pro Instagram (isso é exclusivo do Facebook); `media_publish` sempre publica
 * no instante da chamada, sem exceção. Não existe "recurso a ser ativado na
 * conta" que mude isso — o comentário antigo desta nota sugeria esperar por
 * tal recurso; essa era a premissa errada corrigida pelo próprio #3817.
 *
 * Agendar exige um scheduler próprio: `--schedule` enfileira o post no Worker
 * `diaria-linkedin-cron` (generalizado em #3817 pra suportar `channel:
 * "instagram"` além de LinkedIn), que dispara no horário exato via Durable
 * Object alarm (fallback cron a cada 5min). Como o media container do Instagram
 * expira em 24h e a edição é sempre D+1, o Worker guarda legenda + URL
 * pública da imagem e roda os 2 passos completos (criar container + publicar)
 * no MOMENTO do disparo — nunca no momento do agendamento, que sempre
 * estaria fora da janela de 24h se o container fosse criado ali.
 *
 * Sem `--schedule` (default): publica imediato, sem passar pelo Worker —
 * comportamento inalterado desde a versão original deste script.
 *
 * Uso:
 *   npx tsx scripts/publish-instagram.ts \
 *     --edition-dir data/editions/260422/ \
 *     [--schedule]          # enfileira no Worker em vez de publicar imediato (#3817)
 *     [--skip-existing]     # pula posts já em 06-social-published.json
 *
 * `--schedule` requer o MESMO Worker já usado pelo LinkedIn:
 *   DIARIA_LINKEDIN_CRON_URL / DIARIA_LINKEDIN_CRON_TOKEN no env, OU
 *   publishing.social.linkedin.cloudflare_worker_url em platform.config.json
 *   (mesma instância de Worker — não é um Worker separado pro Instagram).
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
import { extractSection } from "./lib/extract-section.ts"; // #2834 fonte única (era duplicada aqui/publish-threads.ts/lint-social-md.ts)
import { injectChannelLine } from "./lib/social-cta-lines.ts"; // #3991 — injeção determinística da linha de canal no publish
import { parseArgs, isMainModule } from "./lib/cli-args.ts"; // #2834 — substitui parseArgs local
import { computeScheduledAt } from "./compute-social-schedule.ts"; // #3817 — mesmo fallback_schedule usado por LinkedIn/Facebook
import {
  postToWorkerQueue as sharedPostToWorkerQueue,
  type WorkerQueuePayload,
} from "./lib/worker-queue-client.ts"; // #3944 Parte B — cliente HTTP compartilhado com Threads

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const INSTAGRAM_API_BASE = "https://graph.facebook.com"; // mesma base da Graph API
const INSTAGRAM_API_VERSION = "v25.0";

function loadPublished(path: string): SocialPublished {
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8"));
  }
  return { posts: [] };
}

/**
 * Extrai a lista de destaques presentes na seção do 03-social.md usada pelo
 * Instagram. #3991: tenta a seção nova `# Social` (texto único pós-unificação)
 * primeiro; fallback legado: `# Instagram` própria, depois `# Facebook`
 * (comportamento pré-#3991, preservado pra edições publicadas antes deste
 * merge). Último fallback: ["d1","d2","d3"] se nenhuma seção for encontrada.
 */
export function extractDestaquesFromSocialMd(socialMd: string, platform: "instagram"): string[] {
  let section = extractSection(socialMd, "Social");
  if (section === null) section = extractSection(socialMd, "Instagram");
  if (section === null) section = extractPlatformSection(socialMd, "facebook");
  if (section === null) return ["d1", "d2", "d3"];
  const valid = parseDestaqueHeaders(section);
  return valid.length >= 2 ? valid : ["d1", "d2", "d3"];
}

/**
 * Extrai o texto do post para o Instagram e injeta a linha de CTA do canal
 * (`INSTAGRAM_CTA_LINE` — "link na bio" + follow, #3486 preservado) no
 * momento do publish, via `injectChannelLine` (#3991,
 * `scripts/lib/social-cta-lines.ts`) — nunca em `03-social.md`.
 *
 * Ordem de preferência da seção-fonte: `# Social` (texto único pós-#3991) →
 * `# Instagram` própria (legado) → `# Facebook` (legado, último recurso).
 * Só a seção `# Social` recebe a injeção da linha de canal — as duas
 * legadas já eram consumidas do jeito antigo (texto/CTA embutidos no próprio
 * agent) e não devem ganhar uma 2ª linha por cima.
 */
export function extractPostText(socialMd: string, destaque: string): string {
  // Normalizar CRLF → LF
  socialMd = socialMd.replace(/\r\n/g, "\n");

  // #3991: seção nova `# Social` tem precedência.
  const socialRe = /(?:^|\n)# Social\n([\s\S]*?)(?=\n# |$)/i;
  const socialMatch = socialMd.match(socialRe);
  if (socialMatch) {
    const dRe = new RegExp(`(?:^|\\n)## ${destaque}\\n([\\s\\S]*?)(?=\\n## d\\d+\\b|\\n# |$)`, "i");
    const dMatch = socialMatch[1].match(dRe);
    if (dMatch) {
      const text = dMatch[1].replace(/<!--[\s\S]*?-->/g, "").trim();
      return injectChannelLine(text, "instagram");
    }
  }

  // Legado (pré-#3991): tentar seção Instagram própria, depois Facebook.
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
    `Destaque '${destaque}' não encontrado em seção Social, Instagram ou Facebook de 03-social.md`,
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

/**
 * Busca o permalink público do post recém-publicado.
 *
 * IMPORTANTE: o `media_id` retornado por /media_publish é o ID numérico do
 * Graph API (ex: 17896453961137500), NÃO o shortcode usado nas URLs públicas
 * do Instagram (ex: /p/Cxyz123/). Construir `/p/${mediaId}/` daria um link 404.
 * A URL correta vem do campo `permalink` via GET /{media-id}?fields=permalink.
 *
 * Best-effort: se a chamada falhar, retorna null (o post foi publicado com
 * sucesso de qualquer forma — só não temos o link canônico). O caller registra
 * url: null em vez de um link quebrado.
 */
async function fetchPermalink(
  mediaId: string,
  accessToken: string,
  apiVersion: string,
): Promise<string | null> {
  try {
    const url = `${INSTAGRAM_API_BASE}/${apiVersion}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(accessToken)}`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return null;
    const data = (await res.json()) as { permalink?: string; error?: unknown };
    if (data.error || !data.permalink) return null;
    return data.permalink;
  } catch {
    return null;
  }
}

/**
 * Enfileira um post Instagram no Worker `diaria-linkedin-cron` (#3817 — Worker
 * generalizado pra suportar `channel: "instagram"` além de LinkedIn). O
 * cliente HTTP em si mora em `scripts/lib/worker-queue-client.ts` (#3944
 * Parte B — extraído daqui quando o Threads passou a precisar do mesmo
 * endpoint/schema de resposta); reexportado aqui por compatibilidade com
 * callers/testes existentes.
 *
 * O Worker guarda a entry completa (caption + image_url) e roda os 2 passos
 * da Graph API (criar container + publicar) no MOMENTO do disparo — nunca
 * agora, pra não esbarrar na expiração de 24h do container (ver header deste
 * arquivo).
 */
export type InstagramQueuePayload = WorkerQueuePayload;

export async function postToWorkerQueue(
  workerUrl: string,
  token: string,
  payload: InstagramQueuePayload,
  maxAttempts = 2,
): Promise<{ queued: true; key: string; scheduled_at: string; destaque: string }> {
  return sharedPostToWorkerQueue(workerUrl, token, payload, maxAttempts, "publish-instagram");
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
  // #3817 — --schedule enfileira no Worker em vez de publicar imediato.
  // Default (sem a flag) preserva o comportamento original: publica na hora.
  const doSchedule = flags.has("schedule");

  // #3635: kill-switch manual do editor via platform.config.json — mesmo
  // padrão de graceful-skip (exit 0) das credenciais ausentes abaixo, mas
  // acionado por decisão editorial (ex: formato do Instagram em redesenho),
  // não por configuração incompleta. Checar ANTES das credenciais: mesmo com
  // env vars válidas, o canal fica bloqueado até o editor reativar.
  const platformConfig = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const igConfig = platformConfig?.publishing?.social?.instagram;
  if (igConfig?.enabled === false) {
    console.warn(
      `SKIP: Instagram bloqueado via platform.config.json (publishing.social.instagram.enabled=false).\n` +
        `Motivo: ${igConfig.disabled_reason || "não especificado"}\n` +
        "Reative setando publishing.social.instagram.enabled:true quando pronto.",
    );
    process.exit(0);
  }

  // #3817 — Resolver Worker URL/token quando --schedule é passado. Reusa o
  // MESMO Worker do LinkedIn (`diaria-linkedin-cron`, generalizado em #3817
  // pra suportar channel="instagram") — mesma fila KV, mesmo endpoint /queue,
  // mesmos env vars (é literalmente a mesma instância de Worker).
  let workerUrl = "";
  let workerToken = "";
  if (doSchedule) {
    workerUrl =
      process.env.DIARIA_LINKEDIN_CRON_URL ??
      platformConfig?.publishing?.social?.instagram?.cloudflare_worker_url ??
      platformConfig?.publishing?.social?.linkedin?.cloudflare_worker_url ??
      "";
    workerToken = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
    // #923-like fail-fast (publish-linkedin.ts): sem Worker configurado,
    // --schedule não tem pra onde ir — a API do Instagram não agenda nativo
    // (ver header deste arquivo), então NÃO existe fallback de fire-now
    // "que ao menos publica"; abortar é mais seguro que publicar às cegas.
    if (!workerUrl || !workerToken) {
      console.error(
        [
          "ERRO: --schedule passado mas o Cloudflare Worker não está configurado.",
          "  DIARIA_LINKEDIN_CRON_URL: " + (workerUrl ? "set" : "MISSING"),
          "  DIARIA_LINKEDIN_CRON_TOKEN: " + (workerToken ? "set (length=" + workerToken.length + ")" : "MISSING"),
          "",
          "A API do Instagram não agenda nativamente (#3817) — sem o Worker",
          "não há como agendar. Resolução:",
          "  1. Confirmar .env.local com DIARIA_LINKEDIN_CRON_TOKEN",
          "  2. Confirmar platform.config.json (ou env DIARIA_LINKEDIN_CRON_URL)",
          "     com cloudflare_worker_url em publishing.social.linkedin (ou .instagram)",
          "  3. OU rodar SEM --schedule pra publicar imediatamente conscientemente",
        ].join("\n"),
      );
      process.exit(2);
    }
  }

  // Carregar credenciais — env vars obrigatórias em runtime
  const igUserId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || "";
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN || "";
  const apiVersion = process.env.INSTAGRAM_API_VERSION || INSTAGRAM_API_VERSION;

  // #2486 finding 2: sair com exit 0 (graceful skip) quando credenciais ausentes,
  // NÃO com exit 1 (erro duro). O invariante checkInstagramCredsSet registra
  // severity=warning (Instagram é best-effort). Se o exit fosse 1, o orchestrator
  // descartaria o payload inteiro do processo junto — incluindo violations reais
  // de consent de LinkedIn/Facebook — mascarando problemas nos canais em produção.
  // Exit 0 + log permite que os outros canais sejam inspecionados corretamente.
  if (!igUserId || !accessToken) {
    const missing = [
      !igUserId && "INSTAGRAM_BUSINESS_ACCOUNT_ID",
      !accessToken && "INSTAGRAM_ACCESS_TOKEN",
    ]
      .filter(Boolean)
      .join(", ");
    console.warn(
      `SKIP: ${missing} ausente(s) — Instagram não publicado nesta edição.\n` +
        "Configure em .env.local para habilitar o Instagram.\n" +
        "  INSTAGRAM_BUSINESS_ACCOUNT_ID: developers.facebook.com/apps/ → Instagram → Business Account ID\n" +
        "  INSTAGRAM_ACCESS_TOKEN: developers.facebook.com/tools/explorer/ (escopos: instagram_basic, instagram_content_publish)",
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

  // Ler o cache de imagens públicas UMA vez (não muda entre destaques).
  // Para Instagram Graph API, a imagem precisa estar em URL pública acessível —
  // gerado por upload-images-public.ts no Stage 5c-pre.
  const publicImagesPath = resolve(editionDir, "06-public-images.json");
  const publicImagesExists = existsSync(publicImagesPath);
  const publicImages: Record<string, unknown> = publicImagesExists
    ? (JSON.parse(readFileSync(publicImagesPath, "utf8")) as Record<string, unknown>)
    : {};

  // Extrair destaques da seção Instagram (ou fallback para Facebook)
  const destaques = extractDestaquesFromSocialMd(socialMd, "instagram");
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
          p.platform === "instagram" &&
          p.destaque === d &&
          (p.status === "draft" || p.status === "scheduled" || p.status === "published"),
      );
      if (existing) {
        console.log(`SKIP instagram/${d} — already ${existing.status}`);
        results.push(existing);
        skippedCount += 1;
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
    // (publicImages já foi lido UMA vez antes do loop — não muda entre destaques.)
    if (!publicImagesExists) {
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

    // Chave esperada: images.d1 / images.d2 / images.d3 (crop 1x1 — mesmo
    // shape lido por publish-linkedin.ts, ver ImageCacheFile em publish-linkedin.ts)
    const images = (publicImages as { images?: Record<string, { url?: string }> }).images;
    const imageUrl = images?.[d]?.url;
    if (!imageUrl) {
      console.error(
        `ERROR: URL pública para ${d} não encontrada em 06-public-images.json.\n` +
          `Chaves disponíveis: ${Object.keys(images ?? {}).join(", ")}`,
      );
      const entry: PostEntry = {
        platform: "instagram",
        destaque: d,
        url: null,
        status: "failed",
        scheduled_at: null,
        reason: `public URL para ${d} ausente em 06-public-images.json`,
      };
      tagAndAppend(entry);
      results.push(entry);
      continue;
    }

    // #3817 — modo --schedule: enfileira no Worker em vez de publicar agora.
    // scheduled_at vem da MESMA fonte usada por Facebook/LinkedIn
    // (fallback_schedule: d1 10:00, d2 12:30, d3 17:30 — compute-social-schedule.ts).
    if (doSchedule) {
      let scheduledIso: string;
      try {
        scheduledIso = computeScheduledAt({
          config: platformConfig,
          editionDate,
          destaque: d as "d1" | "d2" | "d3",
          platform: "instagram",
        });
      } catch (e: any) {
        console.error(`SKIP instagram/${d}: schedule_error: ${e.message}`);
        const entry: PostEntry = {
          platform: "instagram",
          destaque: d,
          url: null,
          status: "failed",
          scheduled_at: null,
          reason: `schedule_error: ${e.message}`,
        };
        tagAndAppend(entry);
        results.push(entry);
        continue;
      }

      try {
        const response = await postToWorkerQueue(workerUrl, workerToken, {
          text: caption,
          image_url: imageUrl,
          scheduled_at: scheduledIso,
          destaque: d,
          channel: "instagram",
        });
        const entry: PostEntry = {
          platform: "instagram",
          destaque: d,
          url: null,
          status: "scheduled",
          scheduled_at: scheduledIso,
          worker_queue_key: response.key,
        };
        tagAndAppend(entry);
        results.push(entry);
        console.log(`OK instagram/${d} — scheduled at ${scheduledIso} (worker_queue_key=${response.key})`);
      } catch (e: any) {
        console.error(`FAILED instagram/${d}: ${e.message}`);
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
      }
      continue; // não cai no fluxo de publicação imediata abaixo
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

        // O media_id NÃO é o shortcode da URL pública — buscar o permalink real.
        // Se falhar, registramos url: null em vez de um link 404.
        const postUrl = await fetchPermalink(mediaId, accessToken, apiVersion);
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
        console.log(`OK instagram/${d} — published — ${postUrl ?? `(media_id ${mediaId})`}`);
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

  // Summary. `skipped` conta entradas pré-existentes puladas via skipExisting
  // (já publicadas em rodada anterior) — rastreado por skippedCount, não derivado
  // de status (published cobre both new + skipped, então não dá pra distinguir
  // pós-fato).
  const summary = {
    total: results.length,
    published: results.filter((r) => r.status === "published").length,
    scheduled: results.filter((r) => r.status === "scheduled").length, // #3817 — modo --schedule
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
