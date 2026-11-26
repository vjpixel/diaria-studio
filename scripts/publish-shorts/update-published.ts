/**
 * Atualização do texto de um vertical já publicado (`--update-published`).
 *
 * Parte de `scripts/publish-shorts.ts` (#14054): movido sem mudar a lógica; a entrada
 * reexporta o que os testes e os outros scripts importam.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDestaques } from "../extract-destaques.ts";
import { writeFileAtomic } from "../lib/atomic-write.ts";
import {
  CORTE_SPEC_FILE,
  CORTE_TIMER_DESTINATIONS,
  corteTextInput,
  parseCorteSpec,
  type CorteSpec,
  corteAuthorizedDestinations,
} from "../lib/diaria/short-corte.ts";
import {
  corteTextChangeBlockers,
  executePublishedTextUpdates,
  planPublishedTextUpdates,
  type PublishedUpdateItem,
} from "../lib/diaria/short-published-update.ts";
import { loadResolvedFacebookPages } from "../lib/facebook-pages.ts";
import {
  resolveShortHorizontalTitle,
  verticalEditionLinkText,
  knownDestinationIds,
  loadShortsConfig,
  type ShortPublishedEntry,
} from "../lib/diaria/short-video.ts";
import { editionVideoLink } from "../lib/shared/latest-video-redirect.ts";
import { persistShortEntry, readShortsRegistry } from "../lib/diaria/shorts-published-store.ts";
import { defaultYouTubeUploadDeps, missingYouTubeCredentials, updatePublishedVideoText } from "../lib/diaria/youtube-upload.ts";
import { LINKEDIN_PERSONAL_ENV, defaultLinkedInApiVersion, readPersonalCreds, updatePersonalPostCommentary } from "../lib/linkedin-personal.ts";
import { ROOT, horizontalRoteiroWarnings, verticalBioCtaFromHorizontal, readHorizontalVideoForShort } from "./_shared.ts";
import { defaultGraphDeps, updateFacebookPublishedVideoText } from "./facebook.ts";

/** #12936: flags e valores que não combinam com `--update-published` (ele só troca texto de post no ar). */
export const UPDATE_PUBLISHED_FORBIDDEN_FLAGS = [
  "publish", "now", "update-scheduled", "cancel", "reschedule", "require-corte-authorization", "force-youtube",
  "linkedin-timer", "instagram-timer", "threads-timer", "confirm-instagram",
] as const;
export const UPDATE_PUBLISHED_FORBIDDEN_VALUES = ["video", "from-drive", "cover", "mark", "confirm-publish", "date", "at", "edition"] as const;

/**
 * Puro (#12936): confere a combinação de flags do `--update-published`. `null`
 * = ok, senão a mensagem de uso. `--title`/`--hook` só no corte (na edição o
 * texto é o D1 do `02-reviewed.md`); `--confirm` repete o slug do corte ou a
 * edição.
 */
export function updatePublishedArgsError(flags: ReadonlySet<string>, values: Record<string, string | undefined>, aammdd: string): string | null {
  if (!flags.has("update-published")) return null;
  const bad = [
    ...UPDATE_PUBLISHED_FORBIDDEN_FLAGS.filter((f) => flags.has(f)).map((f) => `--${f}`),
    ...UPDATE_PUBLISHED_FORBIDDEN_VALUES.filter((k) => values[k] !== undefined).map((k) => `--${k}`),
  ];
  if (bad.length) return `--update-published não combina com ${bad.join(", ")} (só troca o texto do que já está no ar; aplique com --confirm)`;
  const corte = values["corte"];
  if (corte === undefined && (values["title"] !== undefined || values["hook"] !== undefined)) {
    return "--title/--hook só valem com --corte (na edição o texto vem do D1 do 02-reviewed.md)";
  }
  for (const k of ["title", "hook"] as const) {
    if (values[k] !== undefined && !values[k]!.trim()) return `--${k} vazio`;
  }
  const expected = corte ?? aammdd;
  if (values["confirm"] !== undefined && values["confirm"] !== expected) {
    return `--confirm precisa repetir ${corte !== undefined ? "o slug do corte" : "a edição"} (${expected}), recebeu ${JSON.stringify(values["confirm"])}`;
  }
  return null;
}

/**
 * #12936: `--update-published` — troca o texto dos destinos JÁ NO AR com o
 * título/gancho atuais (D1 da edição, ou o `corte.json` com `--title`/`--hook`
 * por cima). Sem `--confirm`, só o plano. Com ele: YouTube e Facebook pela API
 * (relidos), LinkedIn pessoal pelo `PARTIAL_UPDATE` (sem releitura), e a lista
 * do que só se edita pela UI ou não edita. No corte, `--title`/`--hook` vão ao
 * `corte.json` só depois de nenhuma chamada falhar, sem tocar o "pode publicar"
 * (recusado enquanto houver destino por sair: `corteTextChangeBlockers`).
 */
export async function runUpdatePublished(input: {
  dir: string;
  aammdd: string;
  corteSlug: string | null;
  values: Record<string, string>;
  only: string[] | null;
}): Promise<number> {
  const { dir, values } = input;
  let d1: { title: string; body: string } | undefined;
  let spec: CorteSpec | null = null;
  let aammdd = input.aammdd;
  const specPath = join(dir, CORTE_SPEC_FILE);
  let textChange: { title: string; hook: string } | null = null;
  if (input.corteSlug !== null) {
    if (!existsSync(specPath)) {
      console.error(`publish-shorts: ${specPath} não existe: não há corte "${input.corteSlug}" no ar`);
      return 2;
    }
    try {
      spec = parseCorteSpec(readFileSync(specPath, "utf8"), specPath);
    } catch (e) {
      console.error(`publish-shorts: ${(e as Error).message}`);
      return 2;
    }
    aammdd = spec.date;
    const title = values["title"] ?? spec.title;
    const hook = values["hook"] ?? spec.hook;
    if (title !== spec.title || hook !== spec.hook) textChange = { title, hook };
    d1 = corteTextInput({ title, hook });
  } else {
    const reviewedPath = join(dir, "02-reviewed.md");
    if (!existsSync(reviewedPath)) {
      console.error(`publish-shorts: ${reviewedPath} não existe`);
      return 1;
    }
    d1 = parseDestaques(readFileSync(reviewedPath, "utf8")).find((d) => d.n === 1);
    if (!d1) {
      console.error("publish-shorts: 02-reviewed.md sem DESTAQUE 1");
      return 1;
    }
  }
  let entries: ShortPublishedEntry[];
  let items: PublishedUpdateItem[];
  try {
    entries = readShortsRegistry(dir, aammdd).entries;
    const shortsCfg = loadShortsConfig(JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")));
    const horizontal = spec ? null : readHorizontalVideoForShort(dir);
    for (const w of horizontalRoteiroWarnings(horizontal)) console.error(`[aviso] ${w}`); // #13210 item 1
    const horizontalTitle = horizontal ? resolveShortHorizontalTitle({ d1Title: d1.title, recordTitle: horizontal.recordTitle, noVideo: horizontal.noVideo }) : null;
    items = planPublishedTextUpdates({
      entries, d1, now: new Date(), horizontalTitle, horizontalLink: horizontal?.url ?? null, only: input.only, known: knownDestinationIds(shortsCfg),
      ctaVertical: horizontal ? verticalBioCtaFromHorizontal(horizontal, d1.title) : false, // #13117/#13209: nunca no corte (horizontal null)
      // #13781: o texto do 1º comentário, para o Reels antigo (ou postado à mão) que não tem comentário.
      instagramFirstComment: horizontal && !horizontal.noVideo ? verticalEditionLinkText(editionVideoLink(aammdd, "instagram")) : null,
      ...(shortsCfg.diariaProfiles ? { diariaProfiles: shortsCfg.diariaProfiles } : {}),
    });
  } catch (e) {
    console.error(`publish-shorts: ${(e as Error).message}`);
    return 2;
  }
  const blockers = spec && textChange
    ? corteTextChangeBlockers({ authorizedDestinations: corteAuthorizedDestinations(spec), timerDestinations: CORTE_TIMER_DESTINATIONS, entries, now: new Date() })
    : [];
  if (!blockers.length && !items.some((i) => i.action === "api_youtube" || i.action === "api_facebook" || i.action === "api_linkedin" || i.action === "ui") && !textChange) {
    blockers.push("nada a trocar: nenhum destino no ar editável");
  }
  for (const i of items) {
    if (i.action === "skip" || i.action === "not_editable") console.error(`[aviso] ${i.destination}: ${i.reason}`);
  }
  const confirmToken = input.corteSlug ?? aammdd;
  const apply = values["confirm"] === confirmToken;
  const target = input.corteSlug !== null ? { corte: input.corteSlug } : { aammdd };
  if (blockers.length) {
    for (const b of blockers) console.error(`[erro] ${b}`);
    console.log(JSON.stringify({ dry_run: !apply, update_published: true, ...target, items, blockers, applied: false }, null, 2));
    return 1;
  }
  if (!apply) {
    console.error(`[premissa] plano apenas (nada foi tocado): para aplicar, repita com --confirm ${confirmToken}`);
    console.log(JSON.stringify({ dry_run: true, update_published: true, ...target, items, ...(textChange ? { corte_text_change: textChange } : {}) }, null, 2));
    return 0;
  }
  let pagesCache: ReturnType<typeof loadResolvedFacebookPages> | null = null;
  const pages = () => (pagesCache ??= loadResolvedFacebookPages(ROOT, JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"))));
  const results = await executePublishedTextUpdates(items, entries, {
    youtube: async (videoId, u) => {
      const missing = missingYouTubeCredentials(process.env);
      if (missing.length) throw new Error(`faltam ${missing.join(", ")} no ambiente (rode scripts/youtube-oauth-setup.ts)`);
      await updatePublishedVideoText(defaultYouTubeUploadDeps, {
        clientId: (process.env.GOOGLE_CLIENT_ID ?? "").trim(),
        clientSecret: (process.env.GOOGLE_CLIENT_SECRET ?? "").trim(),
        refreshToken: (process.env.YOUTUBE_REFRESH_TOKEN ?? "").trim(),
        channelId: (process.env.YOUTUBE_CHANNEL_ID ?? "").trim(),
      }, videoId, u);
    },
    facebook: async (slug, videoId, description) => {
      const page = pages().pages.find((p) => p.slug === slug);
      if (!page || page.missing.length) throw new Error(`página ${slug} sem credencial (${page ? page.missing.join(", ") : "fora de publishing.social.facebook.pages"})`);
      await updateFacebookPublishedVideoText(defaultGraphDeps, page, pages().apiVersion, videoId, description);
    },
    linkedin: async (postUrn, text) => {
      const now = new Date();
      const creds = readPersonalCreds(process.env, now);
      if (!creds.ok) throw new Error(creds.reason);
      const apiVersion = process.env[LINKEDIN_PERSONAL_ENV.apiVersion]?.trim() || defaultLinkedInApiVersion(now);
      await updatePersonalPostCommentary({ fetchFn: (u, i) => fetch(u, i), accessToken: creds.creds.accessToken, apiVersion, postUrn, text });
    },
    // Só YouTube e Facebook gravam: o escritor deles é o `main`.
    persist: (entry) => {
      persistShortEntry(dir, aammdd, "main", entry);
    },
    now: () => new Date(),
  });
  for (const r of results) {
    if (r.outcome === "failed") console.error(`[erro] ${r.destination}: ${r.error}`);
    else if (r.outcome === "done") console.error(`[ok] ${r.destination}: texto trocado e relido`);
    else if (r.outcome === "done_unverified") console.error(`[ok] ${r.destination}: a API aceitou a troca (sem releitura)`);
    else if (r.outcome === "ui") console.error(`[pendente] ${r.destination}: ${r.ui!.how}`);
    if (r.warning) console.error(`[aviso] ${r.destination}: ${r.warning}`);
  }
  const failed = results.filter((r) => !r.ok).map((r) => r.destination);
  let corteJson: string | null = null;
  if (spec && textChange) {
    if (failed.length) {
      corteJson = `NÃO alterado: ${failed.join(", ")} falhou; rode de novo (a troca é idempotente) e o corte.json muda quando nada falhar`;
      console.error(`[erro] corte "${spec.slug}": ${corteJson}`);
    } else {
      // Só título e gancho: o "pode publicar" (consumido ou não) fica como está.
      const cur = parseCorteSpec(readFileSync(specPath, "utf8"), specPath);
      writeFileAtomic(specPath, JSON.stringify({ ...cur, title: textChange.title, hook: textChange.hook }, null, 2) + "\n");
      corteJson = "título e gancho atualizados";
      console.error(`[ok] corte "${spec.slug}": corte.json com ${corteJson}`);
    }
  }
  console.log(JSON.stringify({ dry_run: false, update_published: true, ...target, items, results, ...(corteJson ? { corte_json: corteJson } : {}) }, null, 2));
  return failed.length ? 1 : 0;
}
