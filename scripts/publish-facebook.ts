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
 *
 * Resume-aware: lê 06-social-published.json e pula posts facebook já publicados.
 * Append imediato após cada post para proteger contra crash.
 *
 * Output: appends em {edition-dir}/06-social-published.json
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

function computeScheduledAt(
  config: any,
  destaque: string,
  editionDate: string,
  dayOffsetOverride?: number
): string {
  const sched = config.publishing.social.fallback_schedule.facebook;
  const tz = config.publishing.social.timezone;
  const timeKey = `${destaque}_time` as string;
  const time = sched[timeKey];
  const dayOffset = dayOffsetOverride ?? sched.day_offset ?? 0;

  // Parse edition date (YYMMDD) to a real date
  const yy = parseInt(editionDate.slice(0, 2));
  const mm = parseInt(editionDate.slice(2, 4));
  const dd = parseInt(editionDate.slice(4, 6));
  const year = 2000 + yy;

  const target = new Date(year, mm - 1, dd);
  target.setDate(target.getDate() + dayOffset);

  const [h, m] = time.split(":");
  const dateStr = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`;

  // For scheduled_publish_time, Facebook expects Unix timestamp
  // We need to compute it in the configured timezone
  // Use Intl to get the offset
  const tzFmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" });
  const tzName = tzFmt.formatToParts(target).find((p) => p.type === "timeZoneName")?.value || "GMT+0";
  const tzMatch = tzName.match(/GMT([+-]\d+(?::\d+)?)/);
  let offsetStr = "+00:00";
  if (tzMatch) {
    const raw = tzMatch[1];
    if (raw.includes(":")) {
      offsetStr = raw.padStart(6, "0");
    } else {
      offsetStr = `${raw}:00`;
    }
  }

  return `${dateStr}T${h}:${m}:00${offsetStr}`;
}

function isoToUnix(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const editionDir = resolve(ROOT, args["edition-dir"] as string);
  const doSchedule = !!args.schedule;
  const skipExisting = args["skip-existing"] !== false;
  const dayOffsetOverride = args["day-offset"] ? parseInt(args["day-offset"] as string, 10) : undefined;

  // Load credentials
  const creds = JSON.parse(readFileSync(resolve(ROOT, "data/.fb-credentials.json"), "utf8"));
  const { page_id, page_access_token, api_version } = creds;

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

  // Load/init published state
  const publishedPath = resolve(editionDir, "06-social-published.json");
  const published = loadPublished(publishedPath);

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

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
