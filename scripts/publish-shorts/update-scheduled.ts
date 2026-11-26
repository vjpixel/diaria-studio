/**
 * Atualização do texto/vídeo de um vertical já agendado (`--update-scheduled`, `--replace-scheduled`).
 *
 * Parte de `scripts/publish-shorts.ts` (#14054): movido sem mudar a lógica; a entrada
 * reexporta o que os testes e os outros scripts importam.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDestaques } from "../extract-destaques.ts";
import { CORTE_SPEC_FILE, corteTextInput, parseCorteSpec, type CorteSpec, planCorteAuthorizationRestore } from "../lib/diaria/short-corte.ts";
import { planScheduledUpdates, type ScheduledUpdateItem } from "../lib/diaria/short-scheduled-update.ts";
import { loadResolvedFacebookPages } from "../lib/facebook-pages.ts";
import {
  resolveShortHorizontalTitle,
  knownDestinationIds,
  loadShortsConfig,
  type ShortPublishedEntry,
  type ShortsPublishedFile,
} from "../lib/diaria/short-video.ts";
import { defaultYouTubeUploadDeps, missingYouTubeCredentials, updateScheduledVideo } from "../lib/diaria/youtube-upload.ts";
import {
  keepStudioWebVerticalFeed,
  withCoverRecord,
  youtubeShortsCoverRecord,
  youtubeShortsVerticalCoverWarning,
  type ShortCoverRecord,
} from "../lib/diaria/short-cover.ts";
import { ROOT, horizontalRoteiroWarnings, verticalBioCtaFromHorizontal, readHorizontalVideoForShort } from "./_shared.ts";
import { defaultGraphDeps, updateFacebookScheduledVideo } from "./facebook.ts";
import { readShortCover } from "./run-checks.ts";
import { type CorteRevocation, restoreCorteAuthorizationAfterUpdate, corteRestoreBlockingFailures } from "./corte.ts";

/** #11795: I/O do `--update-scheduled`, injetável nos testes. */
export interface UpdateScheduledDeps {
  youtube: (videoId: string, input: { title: string; description: string; thumbnail: Buffer | null }) => Promise<{ thumbnail: { attempted: boolean; ok: boolean; error: string | null } }>;
  facebook: (slug: string, videoId: string, description: string, cover: Buffer | null) => Promise<{ cover: ShortCoverRecord | null }>;
  persist: (entry: ShortPublishedEntry) => void;
  now: () => Date;
}

export interface UpdateScheduledResult {
  destination: string;
  ok: boolean;
  error?: string;
  warnings?: string[];
  /** Buffer (X/TikTok): o que a skill passa pro `edit_post` (nada foi alterado pelo script). */
  buffer?: { bufferId: string; text: string; tiktokTitle?: string };
}

/**
 * #11795: aplica o plano do `--update-scheduled`. YouTube e Facebook trocam
 * pela API e gravam `updated_at` (e a capa nova) no registro; Buffer só volta
 * em `results[].buffer` para a skill. Falha de um destino não para os outros.
 */
export async function executeScheduledUpdates(
  items: readonly ScheduledUpdateItem[],
  entries: readonly ShortPublishedEntry[],
  cover: Buffer | null,
  deps: UpdateScheduledDeps,
): Promise<UpdateScheduledResult[]> {
  const results: UpdateScheduledResult[] = [];
  for (const item of items) {
    if (item.action === "skip") continue;
    if (item.action === "buffer_edit") {
      results.push({ destination: item.destination, ok: true, buffer: { bufferId: item.bufferId, text: item.text, ...(item.tiktokTitle ? { tiktokTitle: item.tiktokTitle } : {}) } });
      continue;
    }
    const entry = entries.find((e) => e.destination === item.destination);
    if (!entry) continue; // o plano sai das entradas: inalcançável
    try {
      let coverRecord: ShortCoverRecord | null = null;
      if (item.action === "update_youtube") {
        const r = await deps.youtube(item.videoId, { title: item.title, description: item.description, thumbnail: item.cover ? cover : null });
        // #12100: `vertical_feed: "manual"` no sucesso; #12459: o `studio_web` já
        // aplicado no Studio web (Passo B3a) é preservado, o `thumbnails.set`
        // não mexe na capa do feed de Shorts.
        coverRecord = keepStudioWebVerticalFeed(youtubeShortsCoverRecord(r.thumbnail), entry.cover);
      } else {
        coverRecord = (await deps.facebook(item.slug, item.videoId, item.description, item.cover ? cover : null)).cover;
      }
      const warnings = coverRecord && !coverRecord.ok ? [`capa não trocada (${coverRecord.error}) — o texto foi trocado`] : [];
      const verticalWarning = item.action === "update_youtube" ? youtubeShortsVerticalCoverWarning(item.videoId, coverRecord) : null;
      if (verticalWarning) warnings.push(verticalWarning);
      try {
        deps.persist({ ...withCoverRecord(entry, coverRecord), updated_at: deps.now().toISOString() });
      } catch (e) {
        warnings.push(`texto trocado, mas o registro não gravou o updated_at: ${(e as Error).message}`);
      }
      results.push({ destination: item.destination, ok: true, ...(warnings.length ? { warnings } : {}) });
    } catch (e) {
      results.push({ destination: item.destination, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

/**
 * #11795: `--update-scheduled` — troca texto e capa dos destinos já
 * AGENDADOS com o título/gancho atuais (D1 da edição, ou `corte.json`) e a capa
 * da pasta. Sem `--publish`, só o plano; com ele (e `--confirm-publish`,
 * checado em `main`), aplica no YouTube e no Facebook e devolve o `edit_post`
 * da Buffer pra skill.
 */
export async function runUpdateScheduled(input: {
  dir: string;
  aammdd: string;
  corte: CorteSpec | null;
  publish: boolean;
  only: string[] | null;
  published: ShortsPublishedFile;
  persist: (entry: ShortPublishedEntry) => ShortsPublishedFile;
  /** #11912: autorizações do corte que caíram nesta rodada (vão no JSON). */
  corteRevocations?: readonly CorteRevocation[];
}): Promise<number> {
  const { dir, aammdd, corte } = input;
  const revokedOut = input.corteRevocations?.length ? { corte_authorization_revoked: input.corteRevocations } : {};
  let d1: { title: string; body: string } | undefined;
  if (corte) {
    d1 = corteTextInput(corte);
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
  const cover = readShortCover(dir, (l) => console.error(l));
  let items: ScheduledUpdateItem[];
  let known: Set<string>;
  try {
    const shortsCfg = loadShortsConfig(JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")));
    known = knownDestinationIds(shortsCfg);
    // #12191: a troca da descrição do Short mantém a citação do horizontal (o corte não tem horizontal).
    const horizontal = corte ? null : readHorizontalVideoForShort(dir);
    for (const w of horizontalRoteiroWarnings(horizontal)) console.error(`[aviso] ${w}`); // #13210 item 1
    const horizontalTitle = horizontal ? resolveShortHorizontalTitle({ d1Title: d1.title, recordTitle: horizontal.recordTitle, noVideo: horizontal.noVideo }) : null;
    items = planScheduledUpdates({
      entries: input.published.entries, d1, now: new Date(), coverPresent: cover.bytes !== null, horizontalTitle, only: input.only, known,
      horizontalLink: horizontal?.url ?? null, // #12735
      ctaVertical: horizontal ? verticalBioCtaFromHorizontal(horizontal, d1.title) : false, // #13117/#13209: nunca no corte (horizontal null)
      ...(shortsCfg.diariaProfiles ? { diariaProfiles: shortsCfg.diariaProfiles } : {}),
    });
  } catch (e) {
    console.error(`publish-shorts: ${(e as Error).message}`);
    return 2;
  }
  for (const i of items) if (i.action === "skip") console.error(`[aviso] ${i.destination}: ${i.reason}`);
  if (!input.publish) {
    // #11912: o plano avisa o que o --publish desta rodada faria com o "pode publicar" do corte.
    let restorePreview: ReturnType<typeof planCorteAuthorizationRestore> | null = null;
    if (corte) {
      const specPath = join(dir, CORTE_SPEC_FILE);
      restorePreview = planCorteAuthorizationRestore(parseCorteSpec(readFileSync(specPath, "utf8"), specPath), input.only, known);
      if (restorePreview.ok) {
        console.error(`[aviso] corte "${corte.slug}": o --publish --confirm-publish desta rodada regravaria o "pode publicar" de ${restorePreview.destinations.join(", ")} (se todas as atualizações derem certo e o vídeo e a capa forem os aprovados): o timer do 300 volta a publicá-los`);
      }
    }
    console.log(JSON.stringify({ dry_run: true, update_scheduled: true, aammdd, items, ...revokedOut, ...(restorePreview ? { corte_authorization_restore_preview: restorePreview } : {}) }, null, 2));
    return 0;
  }
  const config = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  const { pages, apiVersion } = loadResolvedFacebookPages(ROOT, config);
  const results = await executeScheduledUpdates(items, input.published.entries, cover.bytes, {
    youtube: (videoId, u) => {
      const missing = missingYouTubeCredentials(process.env);
      if (missing.length) throw new Error(`faltam ${missing.join(", ")} no ambiente (rode scripts/youtube-oauth-setup.ts)`);
      return updateScheduledVideo(defaultYouTubeUploadDeps, {
        clientId: (process.env.GOOGLE_CLIENT_ID ?? "").trim(),
        clientSecret: (process.env.GOOGLE_CLIENT_SECRET ?? "").trim(),
        refreshToken: (process.env.YOUTUBE_REFRESH_TOKEN ?? "").trim(),
        channelId: (process.env.YOUTUBE_CHANNEL_ID ?? "").trim(),
      }, videoId, u);
    },
    facebook: async (slug, videoId, description, coverBytes) => {
      const page = pages.find((p) => p.slug === slug);
      if (!page || page.missing.length) throw new Error(`página ${slug} sem credencial (${page ? page.missing.join(", ") : "fora de publishing.social.facebook.pages"})`);
      return updateFacebookScheduledVideo(defaultGraphDeps, page, apiVersion, videoId, description, coverBytes);
    },
    persist: (entry) => {
      input.persist(entry);
    },
    now: () => new Date(),
  });
  for (const r of results) {
    if (r.buffer) console.error(`[ok] ${r.destination}: falta o edit_post na Buffer (skill), post ${r.buffer.bufferId}`);
    else console.error(r.ok ? `[ok] ${r.destination}: texto${cover.bytes ? " e capa" : ""} do post agendado trocados` : `[erro] ${r.destination}: ${r.error}`);
    for (const w of r.warnings ?? []) console.error(`[aviso] ${r.destination}: ${w}`);
  }
  // #11912: a confirmação desta rodada é o "pode publicar" do plano corrigido: volta, DEPOIS das
  // atualizações e só se todas deram certo, para os destinos derrubados por mudança de plano (nunca
  // de conteúdo), dentro do --only (senão Instagram/LinkedIn pessoal/Threads do corte nunca saem).
  let corteAuthorization: ReturnType<typeof restoreCorteAuthorizationAfterUpdate> | null = null;
  if (corte) {
    // #11955: falha só no YouTube (escopo do token, Short já no ar) não segura o "pode publicar" dos outros.
    const blocking = corteRestoreBlockingFailures(results);
    corteAuthorization = !blocking.length
      ? restoreCorteAuthorizationAfterUpdate(dir, new Date().toISOString(), known, input.only, (l) => console.error(l))
      : { restored: false, reason: `a atualização de ${blocking.join(", ")} falhou: o "pode publicar" não volta numa rodada parcial` };
    if (!corteAuthorization.restored) console.error(`[aviso] corte "${corte.slug}": "pode publicar" não regravado — ${corteAuthorization.reason}`);
    else if (results.some((r) => !r.ok)) {
      console.error(`[aviso] corte "${corte.slug}": o youtube_shorts não foi atualizado (troque título/descrição no YouTube Studio), mas o "pode publicar" dos outros destinos voltou (#11955)`);
    }
  }
  console.log(JSON.stringify({ dry_run: false, update_scheduled: true, aammdd, items, results, ...revokedOut, ...(corteAuthorization ? { corte_authorization: corteAuthorization } : {}) }, null, 2));
  return results.some((r) => !r.ok) ? 1 : 0;
}
