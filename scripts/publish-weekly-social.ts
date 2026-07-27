/**
 * publish-weekly-social.ts (#4101)
 *
 * Post semanal de destaques — os "5 D1" da semana (segunda a sexta),
 * produzido na sexta e AGENDADO pra sábado. Decisão do editor (260727): só
 * social (LinkedIn, Facebook, Instagram, Threads — Twitter/X é tratado à
 * parte por `prep-weekly-twitter.ts`, ver nota abaixo). Nunca vira edição no
 * Beehiiv, nunca dispara e-mail.
 *
 * GUARD DE PUBLICAÇÃO: este script SEMPRE agenda (nunca publica imediato).
 * Sem `--schedule`, o script só IMPRIME o preview (texto formatado por rede +
 * horário planejado) e retorna — nenhuma chamada de rede é feita. Com
 * `--schedule`, despacha pelos MESMOS caminhos agendados que os publishers
 * diários já usam:
 *   - LinkedIn/Instagram/Threads: Worker queue `diaria-linkedin-cron`
 *     (`scripts/lib/worker-queue-client.ts`, endpoint `/queue`, mesmo Worker
 *     usado por publish-instagram.ts/publish-threads.ts — LinkedIn roteia
 *     pro scenario Make.com "diaria" via `channel: "linkedin"`).
 *   - Facebook: Graph API `/{page}/photos` com `scheduled_publish_time`
 *     (`published: "false"` sempre — mesmo padrão de `publish-facebook.ts`).
 *
 * Twitter/X NÃO é publicado por este script: a API do X só é alcançável via
 * Buffer MCP (`mcp__claude_ai_Buffer__create_post`), que só existe dentro de
 * uma sessão de agente — não de um script Node puro (mesmo motivo de
 * `prep-twitter-posts.ts` pro X diário, #3994). Use
 * `scripts/prep-weekly-twitter.ts` pra obter a thread formatada, e
 * `scripts/append-twitter-published.ts` pra registrar o resultado depois do
 * `create_post` (reaproveitado — aceita `--destaque` arbitrário).
 *
 * Instagram — simplificação assumida (decisão a confirmar com o editor, ver
 * PR body): posta a imagem 4:5 (título embutido) da edição de SEXTA como
 * imagem ÚNICA, não um carrossel de 5 cards. Um carrossel real do Instagram
 * exige criar 5 media containers `is_carousel_item=true` + 1 container pai
 * `CAROUSEL` — fluxo não suportado pelo Worker de agendamento existente
 * (que só aceita 1 `image_url` por entry). Ver `formatInstagramWeekly` em
 * `scripts/lib/format-weekly-social.ts`.
 *
 * Horário — `--time` (default "11:00", ver DEFAULT_WEEKLY_TIME abaixo) é uma
 * ASSUNÇÃO da implementação, não uma decisão do editor: a issue #4101 deixa
 * o horário de sábado em aberto ("provavelmente pede horário próprio").
 * Timezone vem de `platform.config.json` (`publishing.social.timezone`,
 * leitura apenas — nunca escrito por este script).
 *
 * Uso:
 *   npx tsx scripts/publish-weekly-social.ts --saturday 260801 [--schedule]
 *     [--editions-root data/editions] [--time 11:00]
 *     [--channels linkedin,facebook,instagram,threads]
 *     [--no-skip-existing]
 *
 * `--saturday` é OBRIGATÓRIO e explícito (mesmo invariante de CLAUDE.md pras
 * skills `/diaria-*`: nunca inferir data de `today()`).
 *
 * Output: appends em `data/weekly/{saturday}/06-weekly-published.json`
 * (nunca em `data/editions/` — aquele diretório é das edições diárias).
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { resolveWeeklyEditionDirs, selectWeeklyD1, WeeklyD1Item } from "./lib/select-weekly-d1.ts";
import {
  formatLinkedInWeekly,
  formatFacebookWeekly,
  formatInstagramWeekly,
  formatThreadsWeekly,
} from "./lib/format-weekly-social.ts";
import { appendSocialPosts, readSocialPublished, PostEntry } from "./lib/social-published-store.ts";
import { postToWorkerQueue } from "./lib/worker-queue-client.ts";
import { parseEditionDate, timezoneOffsetIso } from "./compute-social-schedule.ts";
import { validateScheduledTime } from "./publish-facebook.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Assunção de implementação — ver nota no cabeçalho. Override via `--time`. */
export const DEFAULT_WEEKLY_TIME = "11:00";

const ALL_CHANNELS = ["linkedin", "facebook", "instagram", "threads"] as const;
export type WeeklyChannel = (typeof ALL_CHANNELS)[number];

/**
 * Pure: calcula o ISO datetime do agendamento do post semanal — sempre
 * baseado em `saturday` (AAMMDD), nunca `Date.now()` (mesmo invariante de
 * `computeScheduledAt` em compute-social-schedule.ts, #270).
 */
export function computeWeeklyScheduledAt(opts: {
  saturday: string;
  time?: string;
  timezone: string;
}): string {
  const time = opts.time ?? DEFAULT_WEEKLY_TIME;
  if (!/^\d{1,2}:\d{2}$/.test(time)) {
    throw new Error(`--time inválido: '${time}' (esperado HH:MM).`);
  }
  const { year, month, day } = parseEditionDate(opts.saturday);
  const target = new Date(year, month - 1, day);
  const dateStr =
    `${target.getFullYear()}-` +
    String(target.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(target.getDate()).padStart(2, "0");
  const [h, m] = time.split(":");
  const offsetStr = timezoneOffsetIso(target, opts.timezone);
  return `${dateStr}T${h.padStart(2, "0")}:${m}:00${offsetStr}`;
}

/** Lê a URL pública da imagem 4:5 (fallback 1:1) do D1 de uma edição, para Instagram. */
export function resolvePublicImageUrl(editionDir: string): string | null {
  const publicImagesPath = resolve(editionDir, "06-public-images.json");
  if (!existsSync(publicImagesPath)) return null;
  try {
    const data = JSON.parse(readFileSync(publicImagesPath, "utf8")) as {
      images?: Record<string, { url?: string }>;
    };
    return data.images?.["d1_4x5"]?.url ?? data.images?.["d1"]?.url ?? null;
  } catch {
    return null;
  }
}

/** Resolve o path local do arquivo de imagem do D1 (4:5 preferido, fallback 1:1), para Facebook. */
export function resolveLocalImagePath(editionDir: string): string | null {
  const path4x5 = resolve(editionDir, "04-d1-4x5.jpg");
  if (existsSync(path4x5)) return path4x5;
  const path1x1 = resolve(editionDir, "04-d1-1x1.jpg");
  if (existsSync(path1x1)) return path1x1;
  return null;
}

async function publishFacebookWeekly(opts: {
  pageId: string;
  pageToken: string;
  apiVersion: string;
  imagePath: string;
  caption: string;
  scheduledAt: string;
}): Promise<{ id: string; post_id?: string }> {
  const url = `https://graph.facebook.com/${opts.apiVersion}/${opts.pageId}/photos`;
  const formData = new FormData();
  const imageBuffer = readFileSync(opts.imagePath);
  const blob = new Blob([imageBuffer], { type: "image/jpeg" });
  formData.append("source", blob, "weekly.jpg");
  formData.append("caption", opts.caption);
  formData.append("access_token", opts.pageToken);
  // Sempre unpublished — igual a publish-facebook.ts: só o schedule agenda a
  // publicação real; nunca "published: true" (nunca envio imediato).
  formData.append("published", "false");
  formData.append("scheduled_publish_time", String(Math.floor(new Date(opts.scheduledAt).getTime() / 1000)));

  const res = await fetch(url, { method: "POST", body: formData });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Facebook POST HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { id?: string; post_id?: string; error?: unknown };
  if (data.error) throw new Error(`Facebook API error: ${JSON.stringify(data.error)}`);
  return data as { id: string; post_id?: string };
}

async function main() {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const saturday = values["saturday"];
  if (!saturday) {
    console.error("ERRO: --saturday AAMMDD é obrigatório (data explícita, nunca inferida de today()).");
    process.exit(1);
  }
  // Valida formato/existência da data cedo (fail-fast, mensagem clara).
  try {
    parseEditionDate(saturday);
  } catch (e: any) {
    console.error(`ERRO: ${e.message}`);
    process.exit(1);
  }

  const editionsRoot = resolve(ROOT, values["editions-root"] ?? "data/editions");
  const time = values["time"] ?? DEFAULT_WEEKLY_TIME;
  const doSchedule = flags.has("schedule");
  const skipExisting = !flags.has("no-skip-existing");
  const requestedChannels = (values["channels"] ?? ALL_CHANNELS.join(","))
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean) as WeeklyChannel[];

  const { year, month, day } = parseEditionDate(saturday);
  const saturdayDate = new Date(year, month - 1, day);
  const weekCandidates = resolveWeeklyEditionDirs(saturdayDate, editionsRoot);

  const missing = weekCandidates.filter((c) => !c.exists);
  if (missing.length > 0) {
    console.log(
      `[publish-weekly-social] ${missing.length} edição(ões) da semana sem 02-reviewed.md — ` +
        `puladas (nunca completa com D2/D3): ${missing.map((c) => c.date).join(", ")}`,
    );
  }

  const existingDirs = weekCandidates.filter((c) => c.exists).map((c) => c.dir);
  const items: WeeklyD1Item[] = selectWeeklyD1(existingDirs);

  if (items.length === 0) {
    console.log(
      `[publish-weekly-social] Nenhuma edição válida na semana anterior a ${saturday} — ` +
        `post semanal NÃO será publicado (nenhum publisher chamado).`,
    );
    return;
  }

  console.log(`[publish-weekly-social] ${items.length} D1 selecionado(s): ${items.map((i) => i.editionDate).join(", ")}`);

  const platformConfig = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const timezone = platformConfig?.publishing?.social?.timezone ?? "America/Sao_Paulo";
  const scheduledAt = computeWeeklyScheduledAt({ saturday, time, timezone });

  const formatted: Record<WeeklyChannel, string> = {
    linkedin: formatLinkedInWeekly(items),
    facebook: formatFacebookWeekly(items),
    instagram: formatInstagramWeekly(items),
    threads: formatThreadsWeekly(items),
  };

  if (!doSchedule) {
    console.log(`\n[publish-weekly-social] PREVIEW (--schedule ausente — nenhuma chamada de rede feita).`);
    console.log(`Agendamento planejado: ${scheduledAt}\n`);
    for (const ch of requestedChannels) {
      console.log(`── ${ch} ──\n${formatted[ch]}\n`);
    }
    return;
  }

  mkdirSync(resolve(ROOT, "data", "weekly", saturday), { recursive: true });
  const publishedPath = resolve(ROOT, "data", "weekly", saturday, "06-weekly-published.json");

  const tagAndAppend = (entry: PostEntry): void => appendSocialPosts(publishedPath, [entry]);

  const alreadyPublished = (channel: string): PostEntry | undefined => {
    if (!skipExisting) return undefined;
    const published = readSocialPublished(publishedPath);
    return published.posts.find(
      (p) => p.platform === channel && p.destaque === "weekly" && (p.status === "draft" || p.status === "scheduled"),
    );
  };

  for (const channel of requestedChannels) {
    const existing = alreadyPublished(channel);
    if (existing) {
      console.log(`SKIP ${channel}/weekly — already ${existing.status}`);
      continue;
    }

    if (channel === "linkedin" || channel === "threads") {
      const workerUrl =
        process.env.DIARIA_LINKEDIN_CRON_URL ??
        platformConfig?.publishing?.social?.linkedin?.cloudflare_worker_url ??
        "";
      const workerToken = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
      if (!workerUrl || !workerToken) {
        console.error(`ERRO ${channel}/weekly: Worker não configurado (DIARIA_LINKEDIN_CRON_URL/DIARIA_LINKEDIN_CRON_TOKEN).`);
        tagAndAppend({ platform: channel, destaque: "weekly", url: null, status: "failed", scheduled_at: null, reason: "worker_not_configured" });
        continue;
      }
      const text = formatted[channel];
      if (channel === "threads" && text.length > 500) {
        console.error(`ERRO threads/weekly: texto de ${text.length} chars excede 500 (chunking agendado não suportado).`);
        tagAndAppend({ platform: "threads", destaque: "weekly", url: null, status: "failed", scheduled_at: null, reason: "text_exceeds_500_chars" });
        continue;
      }
      try {
        const response = await postToWorkerQueue(workerUrl, workerToken, {
          text,
          image_url: null,
          scheduled_at: scheduledAt,
          destaque: "weekly",
          channel,
        });
        tagAndAppend({ platform: channel, destaque: "weekly", url: null, status: "scheduled", scheduled_at: scheduledAt, worker_queue_key: response.key });
        console.log(`OK ${channel}/weekly — scheduled at ${scheduledAt} (worker_queue_key=${response.key})`);
      } catch (e: any) {
        console.error(`FAILED ${channel}/weekly: ${e.message}`);
        tagAndAppend({ platform: channel, destaque: "weekly", url: null, status: "failed", scheduled_at: null, reason: e.message });
      }
      continue;
    }

    if (channel === "instagram") {
      const workerUrl =
        process.env.DIARIA_LINKEDIN_CRON_URL ??
        platformConfig?.publishing?.social?.instagram?.cloudflare_worker_url ??
        platformConfig?.publishing?.social?.linkedin?.cloudflare_worker_url ??
        "";
      const workerToken = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
      if (!workerUrl || !workerToken) {
        console.error(`ERRO instagram/weekly: Worker não configurado.`);
        tagAndAppend({ platform: "instagram", destaque: "weekly", url: null, status: "failed", scheduled_at: null, reason: "worker_not_configured" });
        continue;
      }
      // Imagem: reusa a 4:5/1:1 já publicada publicamente pela última edição
      // da semana (tipicamente sexta) — ver resolvePublicImageUrl acima.
      const lastEditionDir = resolve(editionsRoot, items[items.length - 1].editionDate);
      const imageUrl = resolvePublicImageUrl(lastEditionDir);
      if (!imageUrl) {
        console.error(`ERRO instagram/weekly: 06-public-images.json ausente/sem URL em ${lastEditionDir}.`);
        tagAndAppend({ platform: "instagram", destaque: "weekly", url: null, status: "failed", scheduled_at: null, reason: "public_image_url_missing" });
        continue;
      }
      try {
        const response = await postToWorkerQueue(workerUrl, workerToken, {
          text: formatted.instagram,
          image_url: imageUrl,
          scheduled_at: scheduledAt,
          destaque: "weekly",
          channel: "instagram",
        });
        tagAndAppend({ platform: "instagram", destaque: "weekly", url: null, status: "scheduled", scheduled_at: scheduledAt, worker_queue_key: response.key });
        console.log(`OK instagram/weekly — scheduled at ${scheduledAt} (worker_queue_key=${response.key})`);
      } catch (e: any) {
        console.error(`FAILED instagram/weekly: ${e.message}`);
        tagAndAppend({ platform: "instagram", destaque: "weekly", url: null, status: "failed", scheduled_at: null, reason: e.message });
      }
      continue;
    }

    if (channel === "facebook") {
      const pageId = process.env.FACEBOOK_PAGE_ID ?? "";
      const pageToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN ?? "";
      const apiVersion = process.env.FACEBOOK_API_VERSION ?? "v25.0";
      if (!pageId || !pageToken) {
        console.error(`ERRO facebook/weekly: FACEBOOK_PAGE_ID/FACEBOOK_PAGE_ACCESS_TOKEN ausente.`);
        tagAndAppend({ platform: "facebook", destaque: "weekly", url: null, status: "failed", scheduled_at: null, reason: "credentials_missing" });
        continue;
      }
      const lastEditionDir = resolve(editionsRoot, items[items.length - 1].editionDate);
      const imagePath = resolveLocalImagePath(lastEditionDir);
      if (!imagePath) {
        console.error(`ERRO facebook/weekly: imagem 04-d1-4x5.jpg/04-d1-1x1.jpg ausente em ${lastEditionDir}.`);
        tagAndAppend({ platform: "facebook", destaque: "weekly", url: null, status: "failed", scheduled_at: null, reason: "image_missing" });
        continue;
      }
      try {
        validateScheduledTime(scheduledAt);
      } catch (e: any) {
        console.error(`SKIP facebook/weekly: ${e.message}`);
        tagAndAppend({ platform: "facebook", destaque: "weekly", url: null, status: "failed", scheduled_at: scheduledAt, reason: e.message });
        continue;
      }
      try {
        const result = await publishFacebookWeekly({
          pageId,
          pageToken,
          apiVersion,
          imagePath,
          caption: formatted.facebook,
          scheduledAt,
        });
        const postId = result.post_id ?? result.id;
        tagAndAppend({
          platform: "facebook",
          destaque: "weekly",
          url: `https://www.facebook.com/${pageId}/posts/${postId}`,
          status: "scheduled",
          scheduled_at: scheduledAt,
          fb_post_id: postId,
        });
        console.log(`OK facebook/weekly — scheduled at ${scheduledAt}`);
      } catch (e: any) {
        console.error(`FAILED facebook/weekly: ${e.message}`);
        tagAndAppend({ platform: "facebook", destaque: "weekly", url: null, status: "failed", scheduled_at: null, reason: e.message });
      }
      continue;
    }
  }

  console.log(`\n[publish-weekly-social] out_path: ${publishedPath}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
}
