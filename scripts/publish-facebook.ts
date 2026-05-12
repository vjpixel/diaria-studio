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

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv(); // #923 — carrega .env.local + .env (precedência) antes de process.env access

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeScheduledAt as computeScheduledAtShared } from "./compute-social-schedule.ts";
import { appendSocialPosts, PostEntry, SocialPublished } from "./lib/social-published-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--schedule") {
      args.schedule = true;
    } else if (argv[i] === "--skip-existing") {
      args["skip-existing"] = true;
    } else if (argv[i] === "--reschedule") {
      args.reschedule = true;
    } else if (argv[i] === "--test-mode") {
      // #1056 — tag entries com is_test:true pra delete-test-schedules safety
      args["test-mode"] = true;
    } else if (argv[i] === "--no-skip-existing") {
      // #725 bug #2: opt-out explícito do skip default.
      args["no-skip-existing"] = true;
    } else if (argv[i] === "--allow-draft") {
      // #1156 — opt-in pra criar drafts sem warn (intent claro).
      args["allow-draft"] = true;
    } else if (argv[i].startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      // #725 bug #4: não consumir flag boolean seguinte como valor de outro arg
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

export function extractPostText(socialMd: string, platform: string, destaque: string): string {
  // Normalizar CRLF → LF (arquivo pode vir do Drive com Windows line endings)
  socialMd = socialMd.replace(/\r\n/g, '\n');

  // First isolate the platform section (# Facebook or # LinkedIn)
  const platTitle = platform.charAt(0).toUpperCase() + platform.slice(1);
  const platRe = new RegExp(`(?:^|\\n)# ${platTitle}\\n([\\s\\S]*?)(?=\\n# |$)`, "i");
  const platMatch = socialMd.match(platRe);
  if (!platMatch) throw new Error(`Platform section '${platTitle}' not found in 03-social.md`);

  // Then extract the destaque subsection
  // #725 bug #3: `## d\d` aceitava `## d10` como `## d1` + `0` no lookahead.
  // `\d+\b` garante match completo de número (2+ dígitos não batem em `d1`).
  const dRe = new RegExp(`(?:^|\\n)## ${destaque}\\n([\\s\\S]*?)(?=\\n## d\\d+\\b|\\n# |$)`, "i");
  const dMatch = platMatch[1].match(dRe);
  if (!dMatch) throw new Error(`Destaque '${destaque}' not found under '${platTitle}'`);

  return dMatch[1].replace(/<!--[\s\S]*?-->/g, "").trim();
}

// computeScheduledAt foi movido pra `scripts/compute-social-schedule.ts` (#270)
// pra ser compartilhado entre publish-facebook (Graph API) e publish-linkedin
// (Worker queue + Make webhook). Ambos respeitam o invariante:
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
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Facebook DELETE HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json() as { error?: unknown };
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

  // Always unpublished — prevents immediate live publication when called without scheduledAt.
  // Timing validation (min 10 min ahead) is the caller's responsibility via validateScheduledTime().
  formData.append("published", "false");
  if (scheduledAt) {
    const unixTs = isoToUnix(scheduledAt);
    formData.append("scheduled_publish_time", String(unixTs));
  }

  const res = await fetch(url, { method: "POST", body: formData });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Facebook POST HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json() as { id?: string; post_id?: string; error?: unknown };

  if (data.error) {
    throw new Error(`Facebook API error: ${JSON.stringify(data.error)}`);
  }

  return data as { id: string; post_id?: string };
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
  /** #1056 — when true, tag entries com is_test:true */
  isTest?: boolean;
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

    const imageFile = `04-${d}-1x1.jpg`;
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
      await deleteFacebookPost(opts.pageToken, opts.apiVersion, existing.fb_post_id as string);
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
      if (opts.isTest) newEntry.is_test = true; // #1056
      appendSocialPosts(opts.publishedPath, [newEntry]);
      rescheduled += 1;
      results.push(newEntry);
      console.log(`OK facebook/${d} — rescheduled to ${expectedAt} — ${postUrl}`);
    } catch (e: any) {
      console.error(`Re-publish failed for facebook/${d}: ${e.message}`);
      const lostEntry: PostEntry = {
        platform: "facebook",
        destaque: d,
        url: null,
        status: "failed",
        scheduled_at: null,
        reason: `delete_succeeded_but_repost_failed: ${e.message}`,
      };
      if (opts.isTest) lostEntry.is_test = true; // #1056
      appendSocialPosts(opts.publishedPath, [lostEntry]);
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
  // #725 bug #2: args["skip-existing"] é true (presente) ou undefined (ausente);
  // `undefined !== false` === true → skipExisting era SEMPRE true independente
  // da flag. Agora lê explicitamente: default true, desligar via --no-skip-existing.
  if (args["skip-existing"]) {
    console.warn("AVISO: --skip-existing não tem efeito (flag legada). Use --no-skip-existing pra desligar o skip.");
  }
  const skipExisting = args["no-skip-existing"] !== true;
  const doReschedule = !!args.reschedule;
  const isTest = !!args["test-mode"]; // #1056 — tag is_test:true em entries
  const dayOffsetOverride = args["day-offset"] ? parseInt(args["day-offset"] as string, 10) : undefined;
  const allowDraft = !!args["allow-draft"]; // #1156 — opt-in pra suprimir warning de draft

  // #1156 — Warning loud quando rodando sem --schedule (cria drafts) e sem opt-in
  // explícito via --allow-draft. Trap recorrente: editor/orchestrator esquece
  // `--schedule`, posts ficam como drafts não publicados em vez de scheduled.
  // (Caso real: Stage 4 test de 260516, 2026-05-12 — 3 drafts criados sem intent,
  // tive que deletar via delete-test-schedules + re-rodar com --schedule.)
  // Em test-mode pula o delay (testes não precisam esperar 3s).
  if (!doSchedule && !doReschedule && !allowDraft) {
    console.error(
      "⚠️  WARN: --schedule ausente. Posts serão criados como DRAFTS (não agendados).\n" +
      "    Se intent era agendar pelo platform.config.json, adicione --schedule.\n" +
      "    Se intent era mesmo draft, opt-in com --allow-draft pra suprimir este aviso.\n" +
      `    (Continuando em ${isTest ? "0" : "3"}s — Ctrl+C pra abortar.)`,
    );
    if (!isTest) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  // Load credentials — env vars com fallback para data/.fb-credentials.json (compat retroativa)
  // Migração para .env: FACEBOOK_PAGE_ID, FACEBOOK_PAGE_ACCESS_TOKEN, FACEBOOK_API_VERSION
  let fileCreds: { page_id?: string; page_access_token?: string; api_version?: string } = {};
  try {
    fileCreds = JSON.parse(readFileSync(resolve(ROOT, "data/.fb-credentials.json"), "utf8"));
  } catch {
    // Arquivo não existe — OK se env vars estão setadas
  }
  const page_id = process.env.FACEBOOK_PAGE_ID || fileCreds.page_id || "";
  const page_access_token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN || fileCreds.page_access_token || "";
  const api_version = process.env.FACEBOOK_API_VERSION || fileCreds.api_version || "v25.0";
  if (!page_id) {
    console.error(
      "ERRO: FACEBOOK_PAGE_ID não está setado.\n" +
      "Adicionar em .env (preferido) ou em data/.fb-credentials.json (legacy).\n" +
      "Encontrar Page ID em https://www.facebook.com/diaria.br → Sobre → ID da página."
    );
    process.exit(1);
  }
  if (!page_access_token) {
    console.error(
      "ERRO: FACEBOOK_PAGE_ACCESS_TOKEN não está setado.\n" +
      "Adicionar em .env (preferido) ou em data/.fb-credentials.json (legacy).\n" +
      "Gerar em https://developers.facebook.com/tools/explorer\n" +
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
      isTest,
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

  // #1056 — wrapper que injeta is_test:true em entries quando rodando test_mode
  const tagAndAppend = (entry: PostEntry): void => {
    if (isTest) entry.is_test = true;
    appendSocialPosts(publishedPath, [entry]);
  };

  for (const d of destaques) {
    // Re-read published state from disk on each iteration (#758): LinkedIn agent
    // may be writing concurrently; always read the latest state under lock.
    const published = loadPublished(publishedPath);

    // Check if already published (skip-existing: ignore failed entries, retry them)
    if (skipExisting) {
      const existing = published.posts.find(
        (p) => p.platform === "facebook" && p.destaque === d && (p.status === "draft" || p.status === "scheduled")
      );
      if (existing) {
        console.log(`SKIP facebook/${d} — already ${existing.status}`);
        results.push(existing);
        continue;
      }
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
      tagAndAppend(entry);
      results.push(entry);
      continue;
    }

    // Check image — all destaques use 1x1 variant (#502: image-generate always outputs 04-dN-1x1.jpg)
    const imageFile = `04-${d}-1x1.jpg`;
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
      tagAndAppend(entry);
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
        tagAndAppend(entry);
        results.push(entry);
        continue;
      }
    }

    // Publish with retry + exponential backoff (#725 bug #10)
    // Antes: 2 tentativas com 2s fixo. Agora: 3 tentativas com backoff 1s/2s
    // entre tentativas (sem sleep após a última).
    let lastError: string = "";
    let success = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
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

        tagAndAppend(entry);
        results.push(entry);
        console.log(`OK facebook/${d} — ${entry.status} — ${postUrl}`);
        success = true;
        break;
      } catch (e: any) {
        lastError = e.message;
        console.error(`Attempt ${attempt}/3 failed for facebook/${d}: ${lastError}`);
        if (attempt < 3) {
          const delaySec = Math.pow(2, attempt - 1); // 1s, 2s
          await new Promise((r) => setTimeout(r, delaySec * 1000));
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
      tagAndAppend(entry);
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
