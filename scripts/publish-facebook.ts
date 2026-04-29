/**
 * publish-facebook.ts
 *
 * Publica 3 posts no Facebook (d1, d2, d3) via Graph API.
 * Cada post: imagem + caption. Suporta publicação imediata ou agendada.
 *
 * Uso:
 *   npx tsx scripts/publish-facebook.ts \
 *     --edition-dir data/editions/260422/ \
 *     [--schedule]          # se presente, agenda nos horários de platform.config.json
 *     [--skip-existing]     # pula posts já em 06-social-published.json
 *     [--reschedule]        # modo reschedule: alinha posts existentes ao
 *                           # horário canônico (DELETE + re-publish, idempotente)
 *
 * Resume-aware: lê 06-social-published.json e pula posts facebook já publicados.
 * Append imediato após cada post para proteger contra crash.
 *
 * --reschedule (#123): a Graph API não permite editar `scheduled_publish_time`
 * de posts existentes em apps sem capabilities aprovadas. Workaround oficial:
 * DELETE + re-publish. Este modo lê os posts FB já em 06-social-published.json
 * com status `scheduled`, calcula o horário esperado a partir do config, e pra
 * cada post fora-do-horário deleta + republica. Posts já no horário certo são
 * pulados (idempotente).
 *
 * Output: appends em {edition-dir}/06-social-published.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeScheduledAt as computeScheduledAtShared } from "./compute-social-schedule.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface PostEntry {
  platform: string;
  destaque: string;
  url: string | null;
  status: "draft" | "scheduled" | "failed";
  scheduled_at: string | null;
  reason?: string;
  fb_post_id?: string;
}

interface SocialPublished {
  posts: PostEntry[];
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--schedule") {
      args.schedule = true;
    } else if (argv[i] === "--skip-existing") {
      args["skip-existing"] = true;
    } else if (argv[i] === "--reschedule") {
      args.reschedule = true;
    } else if (argv[i].startsWith("--") && i + 1 < argv.length) {
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

function savePublished(path: string, data: SocialPublished): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function extractPostText(socialMd: string, platform: string, destaque: string): string {
  // First isolate the platform section (# Facebook or # LinkedIn)
  const platTitle = platform.charAt(0).toUpperCase() + platform.slice(1);
  const platRe = new RegExp(`(?:^|\\n)# ${platTitle}\\n([\\s\\S]*?)(?=\\n# |$)`, "i");
  const platMatch = socialMd.match(platRe);
  if (!platMatch) throw new Error(`Platform section '${platTitle}' not found in 03-social.md`);

  // Then extract the destaque subsection
  const dRe = new RegExp(`(?:^|\\n)## ${destaque}\\n([\\s\\S]*?)(?=\\n## d\\d|\\n# |$)`, "i");
  const dMatch = platMatch[1].match(dRe);
  if (!dMatch) throw new Error(`Destaque '${destaque}' not found under '${platTitle}'`);

  return dMatch[1].replace(/<!--[\s\S]*?-->/g, "").trim();
}

// computeScheduledAt foi movido pra `scripts/compute-social-schedule.ts` (#270)
// pra ser compartilhado entre publish-facebook (Graph API) e publish-social
// (LinkedIn via Chrome). Ambos respeitam o invariante:
// target_date = parse(editionDate) + day_offset, nunca today() + day_offset.
// (import movido pro topo do arquivo em #290)

function computeScheduledAt(
  config: any,
  destaque: string,
  editionDate: string,
  dayOffsetOverride?: number
): string {
  return computeScheduledAtShared({
    config,
    editionDate,
    destaque: destaque as "d1" | "d2" | "d3",
    platform: "facebook",
    dayOffsetOverride,
  });
}

function isoToUnix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/**
 * Valida que `scheduledAt` está no futuro com margem mínima exigida pela
 * Graph API (10 min default). Throws com mensagem acionável se inválido.
 *
 * Introduzido em #78 — bug anterior: se scheduled_publish_time estivesse
 * no passado ou < 10min, publishPhoto silenciosamente publicava imediato
 * em vez de agendar. Validação prévia faz fail-fast.
 */
export function validateScheduledTime(
  scheduledAt: string,
  now: Date = new Date(),
  minOffsetSeconds = 600,
): void {
  const unixTs = Math.floor(new Date(scheduledAt).getTime() / 1000);
  if (isNaN(unixTs)) {
    throw new Error(
      `scheduled_publish_time "${scheduledAt}" é uma data inválida.`,
    );
  }
  const nowUnix = Math.floor(now.getTime() / 1000);
  if (unixTs <= nowUnix) {
    const minsAgo = Math.round((nowUnix - unixTs) / 60);
    throw new Error(
      `scheduled_publish_time ${scheduledAt} já passou (${minsAgo}min atrás). ` +
        `Ajuste publishing.social.fallback_schedule em platform.config.json ou use --day-offset 1.`,
    );
  }
  if (unixTs < nowUnix + minOffsetSeconds) {
    const minsAhead = Math.round((unixTs - nowUnix) / 60);
    const minMins = Math.round(minOffsetSeconds / 60);
    throw new Error(
      `scheduled_publish_time ${scheduledAt} está a ${minsAhead}min de now — ` +
        `Graph API exige margem mínima de ${minMins}min. ` +
        `Aumente --day-offset ou ajuste fallback_schedule.`,
    );
  }
}

/**
 * Compara dois timestamps ISO retornando true se diferem por mais que `toleranceSec`.
 * Pure — exportado pra tests.
 *
 * Usado pelo modo --reschedule (#123): scheduled_at salvo em
 * 06-social-published.json contém offset de timezone, então comparação textual
 * pode dar falso positivo em rodadas adjacentes (mesmo instante representado
 * com offsets diferentes). Convertemos pra Unix ts e comparamos com tolerância.
 */
export function needsReschedule(
  actualISO: string | null,
  expectedISO: string,
  toleranceSec = 60,
): boolean {
  if (!actualISO) return true; // post sem scheduled_at registrado precisa reagendar
  const aTs = Math.floor(new Date(actualISO).getTime() / 1000);
  const eTs = Math.floor(new Date(expectedISO).getTime() / 1000);
  if (isNaN(aTs) || isNaN(eTs)) return true;
  return Math.abs(aTs - eTs) > toleranceSec;
}

async function deleteFacebookPost(
  pageToken: string,
  apiVersion: string,
  postId: string,
): Promise<void> {
  const url = `https://graph.facebook.com/${apiVersion}/${postId}`;
  const formData = new FormData();
  formData.append("access_token", pageToken);
  const res = await fetch(url, { method: "DELETE", body: formData });
  const data = await res.json();
  if (data.error) {
    throw new Error(`Facebook DELETE error: ${JSON.stringify(data.error)}`);
  }
}

async function publishPhoto(
  pageId: string,
  pageToken: string,
  apiVersion: string,
  imagePath: string,
  caption: string,
  scheduledAt: string | null
): Promise<{ id: string; post_id?: string }> {
  const url = `https://graph.facebook.com/${apiVersion}/${pageId}/photos`;

  const formData = new FormData();
  const imageBuffer = readFileSync(imagePath);
  const blob = new Blob([imageBuffer], { type: "image/jpeg" });
  formData.append("source", blob, "post.jpg");
  formData.append("caption", caption);
  formData.append("access_token", pageToken);

  if (scheduledAt) {
    const unixTs = isoToUnix(scheduledAt);
    // Facebook requires scheduled time to be between 10 min and 6 months in the future
    const now = Math.floor(Date.now() / 1000);
    if (unixTs > now + 600) {
      formData.append("published", "false");
      formData.append("scheduled_publish_time", String(unixTs));
    }
    // If time is in the past or too soon, publish immediately
  }

  const res = await fetch(url, { method: "POST", body: formData });
  const data = await res.json();

  if (data.error) {
    throw new Error(`Facebook API error: ${JSON.stringify(data.error)}`);
  }

  return data;
}

async function rescheduleFacebookPosts(opts: {
  editionDir: string;
  publishedPath: string;
  socialMd: string;
  editionDate: string;
  config: any;
  pageId: string;
  pageToken: string;
  apiVersion: string;
  dayOffsetOverride?: number;
}): Promise<{ rescheduled: number; skipped: number; failed: number; posts: PostEntry[] }> {
  const published = loadPublished(opts.publishedPath);
  const fbPosts = published.posts.filter(
    (p) => p.platform === "facebook" && p.status === "scheduled",
  );

  if (fbPosts.length === 0) {
    console.error("Nenhum post Facebook agendado em 06-social-published.json. Nada pra reagendar.");
    return { rescheduled: 0, skipped: 0, failed: 0, posts: [] };
  }

  let rescheduled = 0;
  let skipped = 0;
  let failed = 0;
  const results: PostEntry[] = [];

  for (const existing of fbPosts) {
    const d = existing.destaque;
    const expectedAt = computeScheduledAt(opts.config, d, opts.editionDate, opts.dayOffsetOverride);

    if (!needsReschedule(existing.scheduled_at, expectedAt)) {
      console.log(`SKIP facebook/${d} — já no horário (${existing.scheduled_at})`);
      skipped += 1;
      results.push(existing);
      continue;
    }

    // Validate new time before destruction (avoid losing post if expectedAt is invalid)
    try {
      validateScheduledTime(expectedAt);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`SKIP facebook/${d}: scheduled_time_invalid: ${msg}`);
      failed += 1;
      results.push({ ...existing, reason: `scheduled_time_invalid: ${msg}` });
      continue;
    }

    // Re-extract caption + image (in case 03-social.md or images changed since first publish)
    let caption: string;
    try {
      caption = extractPostText(opts.socialMd, "facebook", d);
    } catch (e: any) {
      console.error(`ERROR re-extracting text for facebook/${d}: ${e.message}`);
      failed += 1;
      results.push({ ...existing, status: "failed", reason: e.message });
      continue;
    }

    const imageFile = d === "d1" ? `04-${d}-1x1.jpg` : `04-${d}.jpg`;
    const imagePath = resolve(opts.editionDir, imageFile);
    if (!existsSync(imagePath)) {
      console.error(`ERROR: Image ${imageFile} not found`);
      failed += 1;
      results.push({ ...existing, status: "failed", reason: `${imageFile} not found` });
      continue;
    }

    // DELETE first, then re-publish. If DELETE fails, we don't proceed (would
    // create a duplicate). If re-publish fails after DELETE, log and mark
    // failed — better to know the post is gone than have stale data.
    try {
      console.log(`DELETING facebook/${d} (was ${existing.scheduled_at}, target ${expectedAt})...`);
      if (!existing.fb_post_id) {
        throw new Error(`fb_post_id ausente — não dá pra deletar`);
      }
      await deleteFacebookPost(opts.pageToken, opts.apiVersion, existing.fb_post_id);
    } catch (e: any) {
      console.error(`Failed to delete facebook/${d}: ${e.message}`);
      failed += 1;
      results.push({ ...existing, reason: `delete_failed: ${e.message}` });
      continue;
    }

    // Re-publish at new time
    try {
      console.log(`Re-publishing facebook/${d} at ${expectedAt}...`);
      const result = await publishPhoto(
        opts.pageId,
        opts.pageToken,
        opts.apiVersion,
        imagePath,
        caption,
        expectedAt,
      );
      const postId = result.post_id || result.id;
      const postUrl = `https://www.facebook.com/${opts.pageId}/posts/${postId}`;
      const newEntry: PostEntry = {
        platform: "facebook",
        destaque: d,
        url: postUrl,
        status: "scheduled",
        scheduled_at: expectedAt,
        fb_post_id: postId,
      };
      // Replace existing entry in published.posts
      const idx = published.posts.findIndex(
        (p) => p.platform === "facebook" && p.destaque === d && p.fb_post_id === existing.fb_post_id,
      );
      if (idx >= 0) {
        published.posts[idx] = newEntry;
      } else {
        published.posts.push(newEntry);
      }
      savePublished(opts.publishedPath, published);
      rescheduled += 1;
      results.push(newEntry);
      console.log(`OK facebook/${d} — rescheduled to ${expectedAt} — ${postUrl}`);
    } catch (e: any) {
      console.error(`Re-publish failed for facebook/${d}: ${e.message}`);
      // Mark old entry as deleted/lost
      const idx = published.posts.findIndex(
        (p) => p.platform === "facebook" && p.destaque === d && p.fb_post_id === existing.fb_post_id,
      );
      const lostEntry: PostEntry = {
        platform: "facebook",
        destaque: d,
        url: null,
        status: "failed",
        scheduled_at: null,
        reason: `delete_succeeded_but_repost_failed: ${e.message}`,
      };
      if (idx >= 0) published.posts[idx] = lostEntry;
      else published.posts.push(lostEntry);
      savePublished(opts.publishedPath, published);
      failed += 1;
      results.push(lostEntry);
    }
  }

  return { rescheduled, skipped, failed, posts: results };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const editionDir = resolve(ROOT, args["edition-dir"] as string);
  const doSchedule = !!args.schedule;
  const skipExisting = args["skip-existing"] !== false;
  const doReschedule = !!args.reschedule;
  const dayOffsetOverride = args["day-offset"] ? parseInt(args["day-offset"] as string, 10) : undefined;

  // Load credentials — pre-flight check de token (#263)
  let creds: { page_id: string; page_access_token: string; api_version: string };
  try {
    creds = JSON.parse(readFileSync(resolve(ROOT, "data/.fb-credentials.json"), "utf8"));
  } catch {
    console.error(
      "ERRO: data/.fb-credentials.json não encontrado ou inválido.\n" +
      "Criar via: cp data/.fb-credentials.json.example data/.fb-credentials.json\n" +
      "Preencher page_id e page_access_token (gerar em https://developers.facebook.com/tools/explorer)."
    );
    process.exit(1);
  }
  const { page_id, page_access_token, api_version } = creds;
  if (!page_access_token) {
    console.error(
      "ERRO: page_access_token não está setado em data/.fb-credentials.json.\n" +
      "Regenerar em https://developers.facebook.com/tools/explorer\n" +
      "(selecionar app + Page Diar.ia → Generate Page Access Token long-lived)."
    );
    process.exit(1);
  }

  // Load config
  const config = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));

  // Load social content
  const socialMdPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialMdPath)) {
    console.error("ERROR: 03-social.md not found. Run Stage 3 first.");
    process.exit(1);
  }
  const socialMd = readFileSync(socialMdPath, "utf8");

  // Extract edition date from dir name (last 6 chars)
  const editionDate = editionDir.replace(/[/\\]+$/, "").split(/[/\\]/).pop()!;

  // Load/init published state.
  // #158: prefer _internal/ (new convention) but fallback to root for backward
  // compat with editions já-rodadas. Writes always go to _internal/.
  const internalPath = resolve(editionDir, "_internal", "06-social-published.json");
  const rootPath = resolve(editionDir, "06-social-published.json");
  let publishedPath: string;
  if (existsSync(internalPath)) {
    publishedPath = internalPath;
  } else if (existsSync(rootPath)) {
    // Edição antiga: lê da raiz mas grava no _internal/ daqui pra frente
    publishedPath = rootPath;
  } else {
    // Edição nova: cria em _internal/
    mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
    publishedPath = internalPath;
  }
  const published = loadPublished(publishedPath);

  // Reschedule mode (#123): align existing scheduled posts to canonical time.
  if (doReschedule) {
    const result = await rescheduleFacebookPosts({
      editionDir,
      publishedPath,
      socialMd,
      editionDate,
      config,
      pageId: page_id,
      pageToken: page_access_token,
      apiVersion: api_version,
      dayOffsetOverride,
    });
    console.log(
      JSON.stringify(
        {
          mode: "reschedule",
          out_path: publishedPath,
          summary: {
            rescheduled: result.rescheduled,
            skipped: result.skipped,
            failed: result.failed,
          },
          posts: result.posts,
        },
        null,
        2,
      ),
    );
    return;
  }

  const destaques = ["d1", "d2", "d3"];
  const results: PostEntry[] = [];

  for (const d of destaques) {
    // Check if already published
    if (skipExisting) {
      const existing = published.posts.find(
        (p) => p.platform === "facebook" && p.destaque === d && (p.status === "draft" || p.status === "scheduled")
      );
      if (existing) {
        console.log(`SKIP facebook/${d} — already ${existing.status}`);
        results.push(existing);
        continue;
      }
      // Remove failed entries for retry
      published.posts = published.posts.filter(
        (p) => !(p.platform === "facebook" && p.destaque === d && p.status === "failed")
      );
    }

    // Extract post text
    let caption: string;
    try {
      caption = extractPostText(socialMd, "facebook", d);
    } catch (e: any) {
      console.error(`ERROR extracting text for facebook/${d}: ${e.message}`);
      const entry: PostEntry = {
        platform: "facebook",
        destaque: d,
        url: null,
        status: "failed",
        scheduled_at: null,
        reason: e.message,
      };
      published.posts.push(entry);
      savePublished(publishedPath, published);
      results.push(entry);
      continue;
    }

    // Check image — D1 uses square variant (1x1), D2/D3 use standard
    const imageFile = d === "d1" ? `04-${d}-1x1.jpg` : `04-${d}.jpg`;
    const imagePath = resolve(editionDir, imageFile);
    if (!existsSync(imagePath)) {
      console.error(`ERROR: Image ${imageFile} not found`);
      const entry: PostEntry = {
        platform: "facebook",
        destaque: d,
        url: null,
        status: "failed",
        scheduled_at: null,
        reason: `${imageFile} not found`,
      };
      published.posts.push(entry);
      savePublished(publishedPath, published);
      results.push(entry);
      continue;
    }

    // Determine scheduling
    let scheduledAt: string | null = null;
    if (doSchedule) {
      scheduledAt = computeScheduledAt(config, d, editionDate, dayOffsetOverride);
      // #78: pre-schedule validation — fail fast com erro claro em vez de
      // silenciosamente publicar imediato (bug anterior).
      try {
        validateScheduledTime(scheduledAt);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`SKIP facebook/${d}: scheduled_time_invalid: ${msg}`);
        const entry: PostEntry = {
          platform: "facebook",
          destaque: d,
          url: null,
          status: "failed",
          scheduled_at: scheduledAt,
          reason: `scheduled_time_invalid: ${msg}`,
        };
        published.posts.push(entry);
        savePublished(publishedPath, published);
        results.push(entry);
        continue;
      }
    }

    // Publish with retry
    let lastError: string = "";
    let success = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`Publishing facebook/${d} (attempt ${attempt})...`);
        const result = await publishPhoto(
          page_id,
          page_access_token,
          api_version,
          imagePath,
          caption,
          scheduledAt
        );

        const postId = result.post_id || result.id;
        const postUrl = `https://www.facebook.com/${page_id}/posts/${postId}`;
        const entry: PostEntry = {
          platform: "facebook",
          destaque: d,
          url: postUrl,
          status: scheduledAt ? "scheduled" : "draft",
          scheduled_at: scheduledAt,
          fb_post_id: postId,
        };

        published.posts.push(entry);
        savePublished(publishedPath, published);
        results.push(entry);
        console.log(`OK facebook/${d} — ${entry.status} — ${postUrl}`);
        success = true;
        break;
      } catch (e: any) {
        lastError = e.message;
        console.error(`Attempt ${attempt} failed for facebook/${d}: ${lastError}`);
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }

    if (!success) {
      const entry: PostEntry = {
        platform: "facebook",
        destaque: d,
        url: null,
        status: "failed",
        scheduled_at: null,
        reason: lastError,
      };
      published.posts.push(entry);
      savePublished(publishedPath, published);
      results.push(entry);
    }
  }

  // Summary
  const summary = {
    total: results.length,
    draft: results.filter((r) => r.status === "draft").length,
    scheduled: results.filter((r) => r.status === "scheduled").length,
    failed: results.filter((r) => r.status === "failed").length,
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
