/**
 * scripts/youtube-short-related-plan.ts (#10811)
 *
 * Plano determinístico da task LOCAL das 06:30 BRT no Neo que vincula o
 * horizontal da edição como "vídeo relacionado" do Short. A YouTube Data API
 * não expõe esse campo (`docs/youtube-short-related-video.md`); o vínculo em
 * si é feito pela task com o Claude in Chrome no YouTube Studio
 * (`.claude/skills/diaria-publica-video/short-related-task.md`). Este script
 * só (1) resolve os IDs do horizontal e do Short, (2) confere pela API que o
 * horizontal está PÚBLICO (#573, `resolveYouTubeState`) e (3) devolve a ação
 * (`link` | `wait` | `skip` | `alert`). Lógica pura em
 * `scripts/lib/diaria/youtube-short-related.ts`.
 *
 * Fontes dos IDs, nesta ordem:
 *   - horizontal: `_internal/05-youtube-published.json` → `_internal/05-video-url.txt`;
 *   - Short: `_internal/06-shorts-published.json` (destino `youtube_shorts`);
 *   - qualquer um que falte: listagem dos uploads do canal (token
 *     `youtube.readonly` de `YOUTUBE_REFRESH_TOKEN`), aceitando só match por
 *     marca da edição/título, ou um único candidato pelo dia da edição.
 *
 * Uso:
 *   npx tsx scripts/youtube-short-related-plan.ts [AAMMDD] [--json] [--poll-minutes N]
 *   npx tsx scripts/youtube-short-related-plan.ts [AAMMDD] --record linked|failed [--note "..."] [--json]
 *   npx tsx scripts/youtube-short-related-plan.ts [AAMMDD] --alert [--note "..."] [--json]
 *
 * Sem AAMMDD, a edição é a de HOJE em BRT (a task roda no dia da edição) —
 * calculado aqui, nunca pelo `date` do shell (Git Bash devolve UTC).
 * `--poll-minutes N` (máx. 9, cabe no timeout do Bash) re-confere a cada 2 min
 * enquanto a ação for `wait`. `--record` grava `_internal/06-short-related.json`
 * (já `linked` com os mesmos IDs = o plano devolve `skip`). `--alert` manda o
 * e-mail ao editor uma vez por edição. Saída: exit 0 com o plano (a ação está
 * no JSON); exit 1 em erro; exit 2 em uso inválido.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDestaques } from "./extract-destaques.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { resolveYouTubeState, type PublishState } from "./lib/publish-state.ts";
import { sendPushNotification } from "./lib/push-notify.ts";
import { isNoVideoEdition } from "./lib/diaria/d1-no-video.ts";
import { readD1VideoUrl } from "./lib/diaria/d1-video-link-file.ts";
import { buildYouTubeShortTitle, loadShortScheduleConfig, resolveShortTime } from "./lib/diaria/short-video.ts";
import { readShortsRegistry } from "./lib/diaria/shorts-published-store.ts";
import {
  defaultYouTubeUploadDeps,
  fetchVideoStatus,
  findExistingEditionVideo,
  missingYouTubeCredentials,
  refreshYouTubeAccessToken,
  YOUTUBE_API_BASE,
  type ExistingEditionVideo,
} from "./lib/diaria/youtube-upload.ts";
import { buildYouTubeTitle } from "./lib/diaria/youtube-video.ts";
import { readYouTubeRecordSummary } from "./lib/diaria/youtube-video-link-gate.ts";
import {
  DIARIA_YOUTUBE_CHANNEL_ID,
  SHORT_RELATED_FILE,
  brtInstant,
  brtTodayAammdd,
  buildShortRelatedAlert,
  buildShortRelatedRecord,
  decideShortRelatedPlan,
  isWeekdayEdition,
  parseShortRelatedRecord,
  resolveHorizontalId,
  resolveShortId,
  type ResolvedVideoId,
  type ShortRelatedPlan,
  type ShortRelatedRecord,
} from "./lib/diaria/youtube-short-related.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLL_STEP_MS = 2 * 60_000;
const POLL_MAX_MINUTES = 9;

const USAGE =
  "uso: youtube-short-related-plan.ts [AAMMDD] [--json] [--poll-minutes N] | --record linked|failed [--note TEXTO] | --alert [--note TEXTO]";

/**
 * Aceita o vídeo achado pela listagem? Marca da edição ou título valem; o
 * sinal fraco (só o dia) vale com um único candidato — vários vídeos no dia
 * (live, avulso) seriam chute.
 */
function acceptListing(v: ExistingEditionVideo | null): ExistingEditionVideo | null {
  if (!v) return null;
  if (v.matchedBy !== "period") return v;
  return (v.periodCandidates?.length ?? 1) === 1 ? v : null;
}

function readRecord(dir: string, aammdd: string): ShortRelatedRecord | null {
  const path = join(dir, SHORT_RELATED_FILE);
  return existsSync(path) ? parseShortRelatedRecord(readFileSync(path, "utf8"), aammdd, path) : null;
}

function writeRecord(dir: string, rec: ShortRelatedRecord): string {
  const path = join(dir, SHORT_RELATED_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(rec, null, 2) + "\n");
  return path;
}

function readD1Title(dir: string): string {
  const path = join(dir, "02-reviewed.md");
  if (!existsSync(path)) return "";
  try {
    return parseDestaques(readFileSync(path, "utf8")).find((d) => d.n === 1)?.title ?? "";
  } catch {
    return "";
  }
}

function loadShortAt(aammdd: string): Date | null {
  try {
    const cfg = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
    return brtInstant(aammdd, resolveShortTime(loadShortScheduleConfig(cfg), aammdd).hhmm);
  } catch (e) {
    console.error(`[aviso] horário do Short não derivado (${(e as Error).message})`);
    return null;
  }
}

/** Monta o plano lendo disco e API. Nunca grava nada. */
async function computePlan(aammdd: string, dir: string, now: Date): Promise<ShortRelatedPlan> {
  const editionExists = existsSync(dir);
  const record = editionExists ? readRecord(dir, aammdd) : null;
  const common = {
    aammdd,
    now,
    editionExists,
    noVideo: editionExists && isNoVideoEdition(dir),
    shortAt: loadShortAt(aammdd),
    record,
  };
  if (!isWeekdayEdition(aammdd) || !editionExists || common.noVideo) {
    return decideShortRelatedPlan({ ...common, horizontal: null, short: null, horizontalState: null });
  }

  const urlRead = readD1VideoUrl(dir);
  if (urlRead.warning) console.error(`[aviso] ${urlRead.warning}`);
  let horizontal: ResolvedVideoId | null = resolveHorizontalFromDisk(dir, urlRead.url);
  let short: ResolvedVideoId | null = resolveShortFromDisk(dir, aammdd);

  const missing = missingYouTubeCredentials(process.env);
  if (missing.length) {
    return decideShortRelatedPlan({
      ...common,
      horizontal,
      short,
      horizontalState: null,
      stateError: `credenciais do YouTube ausentes (${missing.join(", ")})`,
    });
  }

  const deps = defaultYouTubeUploadDeps;
  const envChannel = (process.env.YOUTUBE_CHANNEL_ID ?? "").trim();
  if (envChannel !== DIARIA_YOUTUBE_CHANNEL_ID) {
    console.error(`[aviso] YOUTUBE_CHANNEL_ID=${envChannel} difere do @diariabr (${DIARIA_YOUTUBE_CHANNEL_ID}); a listagem usa o @diariabr`);
  }
  let horizontalState: PublishState | null = null;
  let horizontalTitle: string | null = null;
  let stateError: string | null = null;
  try {
    const token = await refreshYouTubeAccessToken(deps, {
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refreshToken: process.env.YOUTUBE_REFRESH_TOKEN ?? "",
      channelId: DIARIA_YOUTUBE_CHANNEL_ID,
    });
    if (!horizontal || !short) {
      const d1Title = readD1Title(dir);
      if (!horizontal) {
        const v = acceptListing(
          await findExistingEditionVideo(deps, token, DIARIA_YOUTUBE_CHANNEL_ID, { aammdd, title: d1Title ? buildYouTubeTitle(d1Title) : "", kind: "long" }),
        );
        if (v) horizontal = { id: v.videoId, source: "channel-listing" };
      }
      if (!short) {
        const v = acceptListing(
          await findExistingEditionVideo(deps, token, DIARIA_YOUTUBE_CHANNEL_ID, { aammdd, title: d1Title ? buildYouTubeShortTitle(d1Title) : "", kind: "short" }),
        );
        if (v) short = { id: v.videoId, source: "channel-listing" };
      }
    }
    if (horizontal) {
      const status = await fetchVideoStatus(deps, token, horizontal.id);
      if (status) horizontalState = resolveYouTubeState({ status }, now);
      else stateError = `a API não devolveu o vídeo ${horizontal.id}`;
      horizontalTitle = await fetchVideoTitle(token, horizontal.id);
    }
  } catch (e) {
    stateError = (e as Error).message;
  }
  return decideShortRelatedPlan({ ...common, horizontal, short, horizontalState, horizontalTitle, stateError });
}

/** Título do vídeo (o que o seletor do Studio mostra). Best-effort: `null` em falha. */
async function fetchVideoTitle(token: string, videoId: string): Promise<string | null> {
  try {
    const res = await defaultYouTubeUploadDeps.fetch(`${YOUTUBE_API_BASE}/videos?part=snippet&id=${encodeURIComponent(videoId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { items?: Array<{ id?: string; snippet?: { title?: string } }> };
    return json.items?.find((i) => i.id === videoId)?.snippet?.title ?? null;
  } catch {
    return null;
  }
}

function resolveHorizontalFromDisk(dir: string, videoUrl: string | null): ResolvedVideoId | null {
  return resolveHorizontalId({ record: readYouTubeRecordSummary(dir), videoUrl });
}

function resolveShortFromDisk(dir: string, aammdd: string): ResolvedVideoId | null {
  return resolveShortId(readShortsRegistry(dir, aammdd));
}

function print(obj: Record<string, unknown>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(obj, null, 2));
    return;
  }
  const p = obj as Partial<ShortRelatedPlan> & { recorded?: string; alert?: string };
  console.log(`${p.aammdd}: ${String(p.action ?? p.recorded ?? p.alert ?? "").toUpperCase()} — ${p.reason ?? ""}`);
  if (p.horizontalId || p.shortId) {
    console.log(`  horizontal=${p.horizontalId ?? "?"}${p.horizontalTitle ? ` ("${p.horizontalTitle}")` : ""} short=${p.shortId ?? "?"} studio=${p.studioUrl}`);
  }
}

async function main(): Promise<number> {
  const { flags, values, positional } = parseArgs(process.argv.slice(2));
  const aammdd = positional[0] ?? brtTodayAammdd(new Date());
  if (!/^\d{6}$/.test(aammdd)) {
    console.error(USAGE);
    return 2;
  }
  if (!positional[0]) console.error(`[premissa] AAMMDD não informado — edição de hoje em BRT: ${aammdd}`);
  const json = flags.has("json");
  const recordStatus = values["record"];
  const alert = flags.has("alert");
  if ((flags.has("record") || recordStatus !== undefined) && recordStatus !== "linked" && recordStatus !== "failed") {
    console.error("youtube-short-related-plan: --record exige linked ou failed");
    return 2;
  }
  if (recordStatus && alert) {
    console.error("youtube-short-related-plan: --record e --alert são exclusivos");
    return 2;
  }
  const pollRaw = values["poll-minutes"];
  const pollMinutes = pollRaw === undefined ? 0 : Number(pollRaw);
  if (!Number.isFinite(pollMinutes) || pollMinutes < 0) {
    console.error("youtube-short-related-plan: --poll-minutes precisa ser um número >= 0");
    return 2;
  }
  const note = values["note"] ?? null;

  loadProjectEnv(ROOT);
  const dir = resolve(editionDirFor(aammdd));
  let plan = await computePlan(aammdd, dir, new Date());

  if (!recordStatus && !alert) {
    const deadline = Date.now() + Math.min(pollMinutes, POLL_MAX_MINUTES) * 60_000;
    while (plan.action === "wait" && Date.now() + POLL_STEP_MS <= deadline) {
      console.error(`[espera] ${plan.reason} — nova conferência em 2 min`);
      await new Promise((r) => setTimeout(r, POLL_STEP_MS));
      plan = await computePlan(aammdd, dir, new Date());
    }
    print({ ...plan }, json);
    return 0;
  }

  if (!existsSync(dir)) {
    console.error(`youtube-short-related-plan: ${dir} não existe — nada a registrar`);
    return 1;
  }
  const previous = readRecord(dir, aammdd);

  if (recordStatus) {
    const rec = buildShortRelatedRecord({
      aammdd,
      status: recordStatus,
      horizontalId: plan.horizontalId,
      shortId: plan.shortId,
      note,
      now: new Date(),
      previous,
    });
    const path = writeRecord(dir, rec);
    print({ ...rec, recorded: recordStatus, reason: `registrado em ${path}` }, json);
    return 0;
  }

  // --alert: um e-mail por edição.
  if (previous?.alertedAt) {
    print({ ...plan, alert: "skipped", reason: `alerta já enviado em ${previous.alertedAt}` }, json);
    return 0;
  }
  const message = buildShortRelatedAlert(plan, note);
  const sent = await sendPushNotification(message, { platformConfigPath: join(ROOT, "platform.config.json") });
  if (!sent.ok) {
    console.error(`youtube-short-related-plan: e-mail ao editor falhou (${sent.error})`);
    return 1;
  }
  const now = new Date();
  const rec: ShortRelatedRecord = {
    ...(previous ??
      buildShortRelatedRecord({ aammdd, status: "failed", horizontalId: plan.horizontalId, shortId: plan.shortId, note, now, previous: null })),
    alertedAt: now.toISOString(),
  };
  writeRecord(dir, rec);
  print({ ...plan, alert: "sent", reason: `e-mail enviado: ${message.subject}` }, json);
  return 0;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("youtube-short-related-plan:", e instanceof Error ? e.message : e) });
}
