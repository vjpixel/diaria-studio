/**
 * scripts/youtube-short-related-plan.ts (#10811)
 *
 * Plano determinístico da task LOCAL `diaria-short-video-relacionado` (Neo,
 * dias úteis 06:05 BRT) que vincula o horizontal da edição como "vídeo
 * relacionado" do Short. A YouTube Data API não expõe esse campo
 * (`docs/youtube-short-related-video.md`); o vínculo em si é feito pela task
 * com o Claude in Chrome no YouTube Studio
 * (`.claude/skills/diaria-publica-video/short-related-task.md`). Este script
 * só (1) resolve os IDs do horizontal e do Short, (2) confere pela API que o
 * horizontal está PÚBLICO (#573, `resolveYouTubeState`) e lê o título dele e
 * (3) devolve a ação (`link` | `wait` | `skip` | `alert`). Lógica pura em
 * `scripts/lib/diaria/youtube-short-related.ts`.
 *
 * Fontes dos IDs, nesta ordem:
 *   - horizontal: `_internal/05-youtube-published.json` → `_internal/05-video-url.txt`;
 *   - Short: `_internal/06-shorts-published.json` (destino `youtube_shorts`);
 *   - qualquer um que falte: listagem dos uploads do canal (`acceptListingMatch`).
 *
 * Credenciais (#8237): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e
 * `YOUTUBE_REFRESH_TOKEN` são lidas do `.env` do REPO, que vence o ambiente —
 * no Neo o app desktop injeta um `GOOGLE_CLIENT_*` de outro client OAuth, e
 * a task roda dentro dele. `YOUTUBE_CHANNEL_ID` não é usado (o canal é fixo).
 *
 * Uso:
 *   npx tsx scripts/youtube-short-related-plan.ts [AAMMDD] [--json] [--poll-minutes N]
 *   npx tsx scripts/youtube-short-related-plan.ts [AAMMDD] --record linked --horizontal-id ID --short-id ID [--note "..."]
 *   npx tsx scripts/youtube-short-related-plan.ts [AAMMDD] --record failed [--note "..."]
 *   npx tsx scripts/youtube-short-related-plan.ts [AAMMDD] --alert [--note "..."]
 *
 * Sem AAMMDD, a edição é a de HOJE em BRT, calculada aqui (o `date` do Git
 * Bash devolve UTC). `--poll-minutes N` (máx. 9) re-confere a cada
 * `SHORT_RELATED_RETRY_MINUTES` enquanto a ação for `wait` e o alerta não
 * estiver devido; quem chama pela ferramenta Bash precisa passar
 * `timeout: 600000` (o padrão de 2 min mata o processo no meio). `--record`
 * grava `_internal/06-short-related.json`; `--alert` manda o e-mail ao editor
 * uma vez por edição, mesmo se o plano falhar.
 *
 * Exit: 0 = plano/registro/alerta ok (a ação está no JSON); 1 = erro (inclui
 * `data/editions` ausente e e-mail que não saiu); 2 = uso inválido; 3 = e-mail
 * ENVIADO, mas o registro do alerta não foi gravado (sem dedup na próxima).
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as dotenvParse } from "dotenv";
import { parseDestaques } from "./extract-destaques.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { findUnknownFlags, isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { editionDir as editionDirFor, editionsRoot } from "./lib/edition-paths.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { resolveYouTubeState, type PublishState } from "./lib/publish-state.ts";
import { sendPushNotification } from "./lib/push-notify.ts";
import { isNoVideoEdition } from "./lib/diaria/d1-no-video.ts";
import { readD1VideoUrl } from "./lib/diaria/d1-video-link-file.ts";
import { buildYouTubeShortTitle, loadShortScheduleConfig, resolveShortTime } from "./lib/diaria/short-video.ts";
import { readShortsRegistry } from "./lib/diaria/shorts-published-store.ts";
import {
  YOUTUBE_API_BASE,
  defaultYouTubeUploadDeps,
  fetchVideoStatus,
  findExistingEditionVideo,
  refreshYouTubeAccessToken,
} from "./lib/diaria/youtube-upload.ts";
import { buildYouTubeTitle } from "./lib/diaria/youtube-video.ts";
import { readYouTubeRecordSummary } from "./lib/diaria/youtube-video-link-gate.ts";
import {
  DIARIA_YOUTUBE_CHANNEL_ID,
  SHORT_RELATED_FILE,
  SHORT_RELATED_RETRY_MINUTES,
  acceptListingMatch,
  brtInstant,
  brtTodayAammdd,
  buildShortRelatedRecord,
  decideShortRelatedPlan,
  isWeekdayEdition,
  parseShortRelatedRecord,
  resolveHorizontalId,
  resolveLinkedRecordIds,
  resolveShortId,
  resolveYouTubeReadCredentials,
  runShortRelatedAlert,
  type ResolvedVideoId,
  type ShortRelatedPlan,
  type ShortRelatedRecord,
} from "./lib/diaria/youtube-short-related.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLL_MAX_MINUTES = 9;
const KNOWN_FLAGS = ["json", "poll-minutes", "record", "note", "alert", "horizontal-id", "short-id"] as const;

const USAGE =
  "uso: youtube-short-related-plan.ts [AAMMDD] [--json] [--poll-minutes N] | --record linked --horizontal-id ID --short-id ID [--note TEXTO] | --record failed [--note TEXTO] | --alert [--note TEXTO]";

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

/** Variáveis do `.env` do repo (#8237); ausente/ilegível = vazio (o ambiente decide). */
function readRepoEnvFile(): Record<string, string> {
  try {
    return dotenvParse(readFileSync(join(ROOT, ".env"), "utf8"));
  } catch {
    return {};
  }
}

/** Título do vídeo (o que o seletor do Studio mostra). Lança em falha (o plano trata). */
async function fetchVideoTitle(token: string, videoId: string): Promise<string | null> {
  const res = await defaultYouTubeUploadDeps.fetch(`${YOUTUBE_API_BASE}/videos?part=snippet&id=${encodeURIComponent(videoId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`videos.list (snippet) respondeu ${res.status}`);
  const json = (await res.json()) as { items?: Array<{ id?: string; snippet?: { title?: string } }> };
  return json.items?.find((i) => i.id === videoId)?.snippet?.title ?? null;
}

/** Monta o plano lendo disco e API. Nunca grava nada. Lança só com registro do vínculo ilegível. */
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

  const resolveErrors: string[] = [];
  const urlRead = readD1VideoUrl(dir);
  if (urlRead.warning) console.error(`[aviso] ${urlRead.warning}`);
  let horizontal: ResolvedVideoId | null = null;
  try {
    horizontal = resolveHorizontalId({ record: readYouTubeRecordSummary(dir), videoUrl: urlRead.url });
  } catch (e) {
    resolveErrors.push((e as Error).message);
  }
  let short: ResolvedVideoId | null = null;
  try {
    short = resolveShortId(readShortsRegistry(dir, aammdd));
  } catch (e) {
    resolveErrors.push((e as Error).message);
  }
  const resolveError = resolveErrors.length ? resolveErrors.join("; ") : null;

  const creds = resolveYouTubeReadCredentials(readRepoEnvFile(), process.env);
  if (creds.overridden.length) console.error(`[premissa] ${creds.overridden.join(", ")} do .env do repo vencem o ambiente (#8237)`);
  if (!creds.credentials) {
    return decideShortRelatedPlan({
      ...common, horizontal, short, horizontalState: null, resolveError,
      stateError: `credenciais do YouTube ausentes (${creds.missing.join(", ")})`, stateErrorKind: "permanent",
    });
  }

  const deps = defaultYouTubeUploadDeps;
  let horizontalState: PublishState | null = null;
  let horizontalTitle: string | null = null;
  let stateError: string | null = null;
  try {
    const token = await refreshYouTubeAccessToken(deps, { ...creds.credentials, channelId: DIARIA_YOUTUBE_CHANNEL_ID });
    if (!horizontal || !short) {
      const d1Title = readD1Title(dir);
      if (!horizontal) {
        const v = acceptListingMatch(
          await findExistingEditionVideo(deps, token, DIARIA_YOUTUBE_CHANNEL_ID, { aammdd, title: d1Title ? buildYouTubeTitle(d1Title) : "", kind: "long" }),
        );
        if (v) horizontal = { id: v.videoId, source: "channel-listing" };
      }
      if (!short) {
        const v = acceptListingMatch(
          await findExistingEditionVideo(deps, token, DIARIA_YOUTUBE_CHANNEL_ID, { aammdd, title: d1Title ? buildYouTubeShortTitle(d1Title) : "", kind: "short" }),
        );
        if (v) short = { id: v.videoId, source: "channel-listing" };
      }
    }
    if (horizontal) {
      const status = await fetchVideoStatus(deps, token, horizontal.id);
      if (status) horizontalState = resolveYouTubeState({ status }, now);
      else stateError = `a API não devolveu o vídeo ${horizontal.id} (removido, ou de outro canal)`;
      if (horizontalState === "published") {
        try {
          horizontalTitle = await fetchVideoTitle(token, horizontal.id);
        } catch (e) {
          console.error(`[aviso] título do horizontal não lido (${(e as Error).message})`);
        }
      }
    }
  } catch (e) {
    stateError = (e as Error).message;
  }
  return decideShortRelatedPlan({ ...common, horizontal, short, horizontalState, horizontalTitle, stateError, resolveError });
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
  const argv = process.argv.slice(2);
  const unknown = findUnknownFlags(argv, KNOWN_FLAGS);
  const { flags, values, positional } = parseArgs(argv);
  // `--alert 261028` / `--json 261028`: o parser leria a data como VALOR da flag
  // e cairia em modo plano em silêncio.
  const booleanWithValue = (["json", "alert"] as const).filter((k) => values[k] !== undefined);
  if (unknown.length || booleanWithValue.length || positional.length > 1) {
    if (unknown.length) console.error(`youtube-short-related-plan: flag desconhecida: ${unknown.join(", ")}`);
    if (booleanWithValue.length) {
      console.error(`youtube-short-related-plan: --${booleanWithValue.join("/--")} não leva valor — passe o AAMMDD antes das flags`);
    }
    if (positional.length > 1) console.error(`youtube-short-related-plan: argumentos demais: ${positional.join(" ")}`);
    console.error(USAGE);
    return 2;
  }
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
  if (flags.has("poll-minutes") || !Number.isFinite(pollMinutes) || pollMinutes < 0) {
    console.error("youtube-short-related-plan: --poll-minutes precisa ser um número >= 0");
    return 2;
  }
  const note = values["note"] ?? null;

  loadProjectEnv(ROOT);
  const editionsDir = resolve(ROOT, editionsRoot());
  if (!existsSync(editionsDir)) {
    console.error(`youtube-short-related-plan: ${editionsDir} não existe (junction data/ não montada?) — não dá para afirmar que não há edição`);
    return 1;
  }
  const dir = resolve(ROOT, editionDirFor(aammdd));

  if (alert) {
    const outcome = await runShortRelatedAlert({
      aammdd,
      note,
      now: new Date(),
      computePlan: () => computePlan(aammdd, dir, new Date()),
      readRecord: () => readRecord(dir, aammdd),
      send: (m) => sendPushNotification(m, { platformConfigPath: join(ROOT, "platform.config.json") }),
      writeRecord: (rec) => {
        writeRecord(dir, rec);
      },
      log: (line) => console.error(line),
    });
    print({ aammdd, alert: outcome.kind, reason: JSON.stringify(outcome) }, json);
    if (outcome.kind === "send-failed") {
      console.error(`youtube-short-related-plan: e-mail ao editor NÃO saiu (${outcome.error})`);
      return 1;
    }
    if (outcome.kind === "sent-not-recorded") {
      console.error(`youtube-short-related-plan: e-mail ENVIADO, mas o registro do alerta não foi gravado (${outcome.error}) — a próxima chamada reenviaria`);
      return 3;
    }
    return 0;
  }

  let plan = await computePlan(aammdd, dir, new Date());

  if (!recordStatus) {
    const stepMs = SHORT_RELATED_RETRY_MINUTES * 60_000;
    const deadline = Date.now() + Math.min(pollMinutes, POLL_MAX_MINUTES) * 60_000;
    while (plan.action === "wait" && !(plan.alertDue && !plan.alreadyAlerted) && Date.now() + stepMs <= deadline) {
      console.error(`[espera] ${plan.reason} — nova conferência em ${SHORT_RELATED_RETRY_MINUTES} min`);
      await new Promise((r) => setTimeout(r, stepMs));
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
  let ids: { horizontalId: string | null; shortId: string | null } = { horizontalId: plan.horizontalId, shortId: plan.shortId };
  if (recordStatus === "linked") {
    ids = resolveLinkedRecordIds(plan, { horizontalId: values["horizontal-id"] ?? null, shortId: values["short-id"] ?? null });
  }
  const rec = buildShortRelatedRecord({ aammdd, status: recordStatus, ...ids, note, now: new Date(), previous });
  const path = writeRecord(dir, rec);
  print({ ...rec, recorded: recordStatus, reason: `registrado em ${path}` }, json);
  return 0;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("youtube-short-related-plan:", e instanceof Error ? e.message : e) });
}
