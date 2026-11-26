/**
 * Registro do mesmo dia, credenciais puladas, marcadores do Threads e o `--confirm-instagram`.
 *
 * Parte de `scripts/publish-shorts.ts` (#14054): movido sem mudar a lógica; a entrada
 * reexporta o que os testes e os outros scripts importam.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseDestaques } from "../extract-destaques.ts";
import { editionDir as editionDirFor } from "../lib/edition-paths.ts";
import { CORTE_SPEC_FILE, CORTES_REL_DIR, parseCorteSpec, type CorteSpec } from "../lib/diaria/short-corte.ts";
import { resolveEditionScheduledAt } from "../lib/edition-scheduled-at.ts";
import { loadResolvedFacebookPages } from "../lib/facebook-pages.ts";
import {
  VERTICAL_COMMENT_CTA_LINE,
  verticalEditionLinkText,
  INSTAGRAM_CHROME_ROUTE,
  loadShortScheduleConfig,
  loadShortsConfig,
  resolveShortTime,
  type ShortPublishedEntry,
  type ShortsPublishedFile,
} from "../lib/diaria/short-video.ts";
import { editionVideoLink } from "../lib/shared/latest-video-redirect.ts";
import { readShortsRegistry, type ShortsRegistryWriter } from "../lib/diaria/shorts-published-store.ts";
import { stripInlineMarkdown } from "../lib/diaria/youtube-video.ts";
import { ROOT, type ShortsPlanItem, verticalBioCtaFromHorizontal, readHorizontalVideoForShort } from "./_shared.ts";
import { resolveInstagramAuthor, collabInviteWarnings } from "./instagram.ts";
import { type GraphDeps, defaultGraphDeps, graphGet } from "./facebook.ts";
import {
  instagramEditionMarkers,
  instagramAlreadyRegistered,
  decideInstagramConfirmAcrossAccounts,
  instagramConfirmUrlEntry,
  resolveChromeAuthorReader,
  confirmChromeAuthorDeps,
  instagramConfirmExpectedCollabs,
  readAndDecideInstagramConfirm,
} from "./instagram-confirm.ts";
import { resolveEditionUrlInput } from "./run-checks.ts";

/**
 * Pure (#11410): o que identifica o vertical da edição num post do perfil do
 * Threads — o título do D1 como o texto de `buildShortSocialText` o leva, e o
 * `utm_campaign={AAMMDD}` do link da edição que o texto levava até o #11617
 * (segue como marcador pros posts já no ar).
 * Título com reticências (cortado pra caber) entra sem elas.
 */
export function threadsEditionMarkers(aammdd: string, d1Title: string): string[] {
  const title = stripInlineMarkdown(d1Title).replace(/\s+/g, " ").replace(/…$/, "").trim();
  return [`utm_campaign=${aammdd}`, ...(title ? [title] : [])];
}

/** #11742/#11795: o `utm_campaign={AAMMDD}` é da EDIÇÃO; no corte avulso ele casaria com o vertical da edição do mesmo dia. */
function withoutEditionUtmMarker(markers: string[]): string[] {
  return markers.filter((m) => !m.startsWith("utm_campaign="));
}

/**
 * Pure (#11742): a entrada da conferência do perfil do Threads antes de QUALQUER
 * rodada publicar `threads_profile` — a do timer (`--threads-timer`), a da
 * skill, a task one-shot do app desktop (que com o config em `false` num
 * checkout defasado corria com o timer do 300 no mesmo minuto) e o corte
 * avulso. Marcadores: o título como a 1ª linha do texto o leva (+ o
 * `utm_campaign` só na edição). O vídeo do OUTRO lado do mesmo dia, já
 * registrado (`sameDayOtherIds`), não conta: no corte, o da edição do dia
 * (`editionDayRegisteredIds`); na edição, o dos cortes do dia
 * (`sameDayCorteRegisteredIds`, #11913 — a extra das 06:30 bloqueava a
 * principal das 12:00). Sem isso um lado bloquearia o outro.
 */
export function threadsProfilePreflightInput(input: {
  aammdd: string;
  caption: string;
  corte: boolean;
  sameDayOtherIds: readonly string[];
}): { sinceIso: string; markers: string[]; ignoreIds: string[] } {
  const markers = threadsEditionMarkers(input.aammdd, input.caption.split("\n")[0] ?? "");
  return {
    sinceIso: resolveEditionScheduledAt(input.aammdd, "00:00"),
    markers: input.corte ? withoutEditionUtmMarker(markers) : markers,
    ignoreIds: [...input.sameDayOtherIds],
  };
}

/**
 * Pure (#11795): a conferência da conta do Instagram antes de publicar o Reels
 * (`instagramTimerGate`, #11265) vale na rodada do timer da edição e em TODA
 * rodada do corte avulso (o timer `Diaria-Shorts-Cortes` roda sem
 * `--instagram-timer`, e o `--confirm-instagram` não existe no corte): um Reels
 * do corte postado à mão e não registrado sairia duplicado.
 */
export function instagramAccountGateApplies(writer: ShortsRegistryWriter, corte: boolean): boolean {
  return writer === "instagram-timer" || corte;
}

/**
 * Pure (#11795): marcadores, início da leitura e horário planejado do Reels do
 * corte avulso — o título e o gancho do `corte.json` (nunca o D1 da edição), o
 * dia do corte desde 00:00 BRT e o `--at`. Sem `utm_campaign` nem URL: o
 * vertical não leva link (#11617) e o utm do dia é o da edição.
 */
export function corteInstagramConfirmContext(corte: Pick<CorteSpec, "date" | "hhmm" | "title" | "hook">): { markers: string[]; sinceIso: string; expectedAtIso: string } {
  return {
    markers: withoutEditionUtmMarker(instagramEditionMarkers({ aammdd: corte.date, d1Title: corte.title, d1Body: corte.hook, editionUrl: null })),
    sinceIso: resolveEditionScheduledAt(corte.date, "00:00"),
    expectedAtIso: resolveEditionScheduledAt(corte.date, corte.hhmm),
  };
}

/**
 * #11742/#11795: ids que o registro do vertical da EDIÇÃO do dia já tem para o
 * destino. O corte avulso não os confunde com o próprio post na conferência da
 * conta. Registro ilegível → aviso e lista vazia (a conferência fica mais
 * restritiva, nunca menos).
 */
export function editionDayRegisteredIds(
  editionDir: string,
  aammdd: string,
  destination: string,
  warn: (m: string) => void,
  read: (dir: string, aammdd: string) => ShortsPublishedFile = readShortsRegistry,
): string[] {
  if (!existsSync(editionDir)) return [];
  try {
    return read(editionDir, aammdd)
      .entries.filter((e) => e.destination === destination && typeof e.id === "string" && e.id.length > 0)
      .map((e) => e.id as string);
  } catch (e) {
    warn(`registro do vertical da edição ${aammdd} ilegível (${(e as Error).message}) — a conferência da conta do corte não o desconta`);
    return [];
  }
}

/**
 * #11913: o espelho de `editionDayRegisteredIds` para a rodada da EDIÇÃO — os
 * ids que os cortes avulsos do mesmo dia (`data/cortes/{slug}/`, inclusive a
 * vertical extra, #11898) já registraram para o destino. O post do corte não
 * leva link nem `utm_campaign`, então sem descontá-lo a conferência da edição
 * o lê como "vídeo do dia sem marcador" e bloqueia. Corte com `corte.json` ou
 * registro ilegível → aviso e pula só aquele corte (a conferência fica mais
 * restritiva, nunca menos).
 */
export function sameDayCorteRegisteredIds(
  cortesDir: string,
  aammdd: string,
  destination: string,
  warn: (m: string) => void,
  read: (dir: string, aammdd: string) => ShortsPublishedFile = readShortsRegistry,
  /** #11965: o corte que está publicando (a pasta = slug) não desconta o próprio registro. */
  exceptSlug?: string,
): string[] {
  if (!existsSync(cortesDir)) return [];
  let names: string[];
  try {
    names = readdirSync(cortesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch (e) {
    warn(`pasta dos cortes ${cortesDir} ilegível (${(e as Error).message}) — a conferência da edição não desconta os cortes do dia`);
    return [];
  }
  const ids: string[] = [];
  for (const name of names) {
    if (exceptSlug !== undefined && name === exceptSlug) continue;
    const dir = join(cortesDir, name);
    const specPath = join(dir, CORTE_SPEC_FILE);
    if (!existsSync(specPath)) continue;
    try {
      const spec = parseCorteSpec(readFileSync(specPath, "utf8"), specPath);
      if (spec.date !== aammdd) continue;
      for (const e of read(dir, spec.date).entries) {
        if (e.destination === destination && typeof e.id === "string" && e.id.length > 0) ids.push(e.id);
      }
    } catch (e) {
      warn(`corte ${name} ilegível (${(e as Error).message}) — a conferência da edição ${aammdd} não o desconta`);
    }
  }
  return ids;
}

/**
 * #11742/#11795/#11913/#11965: os ids do mesmo dia que a conferência da conta
 * de UM lado desconta — no corte, os da edição do dia E os dos OUTROS cortes do
 * dia (#11965: o 2º corte do dia era bloqueado pelo vídeo já registrado do 1º);
 * na edição, os dos cortes do dia. `corteSlug` = a rodada é do corte com esse slug.
 */
export function sameDayOtherRegisteredIdsFor(input: {
  corteSlug: string | null;
  aammdd: string;
  destination: string;
  editionDir: string;
  cortesDir: string;
  warn: (m: string) => void;
  read?: (dir: string, aammdd: string) => ShortsPublishedFile;
}): string[] {
  const read = input.read ?? readShortsRegistry;
  const cortes = sameDayCorteRegisteredIds(input.cortesDir, input.aammdd, input.destination, input.warn, read, input.corteSlug ?? undefined);
  if (input.corteSlug === null) return cortes;
  return [...editionDayRegisteredIds(input.editionDir, input.aammdd, input.destination, input.warn, read), ...cortes];
}

export function sameDayOtherRegisteredIds(corteSlug: string | null, aammdd: string, destination: string): string[] {
  return sameDayOtherRegisteredIdsFor({
    corteSlug,
    aammdd,
    destination,
    editionDir: editionDirFor(aammdd),
    cortesDir: join(ROOT, CORTES_REL_DIR),
    warn: (m) => console.error(`[aviso] ${m}`),
  });
}

/**
 * Destinos que a rodada pulou por falta de credencial/token do PRÓPRIO destino
 * (#11240), terminais pra limpeza do vertical. O pulo por falta de URL pública
 * (`cause: "public_video"`, X e Threads) NUNCA conta, em nenhum backend
 * (#11478): o R2 está habilitado desde 27/10/2026 (#10772), então esse pulo
 * só quer dizer que ESTA máquina não tem os secrets `R2_*`/`SHORTS_R2_*`
 * (clone novo, sync de env atrasado). Outra máquina com eles ainda publica
 * com o mesmo `-short.mp4`, que por isso não pode ser podado. A regra
 * anterior (terminal com `timer-300` sem R2, #11265) era do tempo em que o
 * R2 não seria habilitado. Puro.
 */
export function credentialSkippedItems(
  items: readonly ShortsPlanItem[],
): Array<{ destination: string; detail: string }> {
  return items.flatMap((i) =>
    i.action === "skip_missing_credentials" && i.cause !== "public_video"
      ? [{ destination: i.destination, detail: i.detail }]
      : [],
  );
}

/**
 * #10978 item 5 / #11265: o que identifica o Reels da edição na conta —
 * marcadores (título e gancho do D1, utm, URL), o corte default (00:00 BRT do
 * dia da edição, o vertical sai no próprio dia, #10831) e o horário planejado
 * do vertical (`resolveShortTime`), base da janela de horário quando a
 * legenda foi editada. Usado pelo `--confirm-instagram` e pela conferência do
 * timer antes de publicar.
 */
export function instagramConfirmContext(
  dir: string,
  aammdd: string,
  config: unknown,
  editionUrlFlag: string | undefined,
): { markers: string[]; sinceIso: string; expectedAtIso: string | null; d1Title: string | null } {
  const reviewedPath = join(dir, "02-reviewed.md");
  const d1 = existsSync(reviewedPath) ? (parseDestaques(readFileSync(reviewedPath, "utf8")).find((d) => d.n === 1) ?? null) : null;
  const markers = instagramEditionMarkers({ aammdd, d1Title: d1?.title ?? null, d1Body: d1?.body ?? null, editionUrl: resolveEditionUrlInput(dir, editionUrlFlag).url ?? null });
  let expectedAtIso: string | null = null;
  try {
    expectedAtIso = resolveEditionScheduledAt(aammdd, resolveShortTime(loadShortScheduleConfig(config), aammdd, "instagram").hhmm);
  } catch {
    expectedAtIso = null; // config de horário inválido: fica só o marcador (a recusa segue segura)
  }
  return { markers, sinceIso: resolveEditionScheduledAt(aammdd, "00:00"), expectedAtIso, d1Title: d1?.title ?? null };
}

/**
 * Pure (#13781): lembrete do 1º comentário na rota à mão do Reels
 * (`--confirm-instagram`, `--mark instagram=URL`). A legenda do vertical com
 * `cta_vertical` diz "link no primeiro comentário", mas só o publish pela API
 * comenta; o registro à mão não grava `first_comment_pending` de propósito: o
 * editor pode já ter comentado no app, e o timer comentaria de novo. `null` =
 * a legenda não promete o comentário (sem `cta_vertical` ou edição sem vídeo).
 */
export function instagramManualFirstCommentReminder(input: { aammdd: string; ctaVertical: boolean; noVideo: boolean }): string | null {
  if (!input.ctaVertical || input.noVideo) return null;
  const text = verticalEditionLinkText(editionVideoLink(input.aammdd, "instagram"));
  return `a legenda do vertical diz "${VERTICAL_COMMENT_CTA_LINE}" e o registro à mão não comenta (o timer do 300 só comenta o Reels que ele publica): confira os comentários do Reels e, se o link não estiver lá, comente: ${text} (#13781)`;
}

/** #13781: o lembrete acima, lendo o D1 e o horizontal da edição; leitura que falha ainda lembra. */
export function readInstagramManualFirstCommentReminder(dir: string, aammdd: string): string | null {
  try {
    const reviewedPath = join(dir, "02-reviewed.md");
    const d1 = existsSync(reviewedPath) ? parseDestaques(readFileSync(reviewedPath, "utf8")).find((d) => d.n === 1) : undefined;
    const horizontal = readHorizontalVideoForShort(dir);
    return instagramManualFirstCommentReminder({ aammdd, ctaVertical: d1 ? verticalBioCtaFromHorizontal(horizontal, d1.title) : false, noVideo: horizontal.noVideo });
  } catch (e) {
    const text = verticalEditionLinkText(editionVideoLink(aammdd, "instagram"));
    return `não deu pra conferir se a legenda promete o link no 1º comentário (${(e as Error).message}): se ela diz "${VERTICAL_COMMENT_CTA_LINE}", confira os comentários do Reels e, se faltar, comente: ${text} (#13781)`;
  }
}

/**
 * `--confirm-instagram` (#10915): depois do Share no Chrome (ou no app), acha o
 * Reels pela API (`/{ig-user}/media`, só leitura), grava a entrada `instagram`
 * e avisa se o collab ficou Pending. A confirmação vem da API, nunca da tela,
 * e só vale o Reels com o marcador desta edição na legenda
 * (`decideInstagramConfirm`); ambíguo → recusa e pede `--media-id`.
 */
export async function confirmInstagram(
  aammdd: string,
  dir: string,
  persist: (entry: ShortPublishedEntry) => ShortsPublishedFile,
  published: ShortsPublishedFile,
  sinceFlag: string | undefined,
  mediaIdFlag: string | undefined,
  editionUrlFlag: string | undefined,
  urlFlag?: string,
  /** #11794: I/O injetável para testar o wiring; o default é a Graph real e o config do repo. */
  io: { graph?: GraphDeps; config?: unknown } = {},
): Promise<number> {
  const graph = io.graph ?? defaultGraphDeps;
  const already = instagramAlreadyRegistered(published);
  if (already) {
    const e = already.entry;
    console.log(JSON.stringify({ confirmed: false, already_registered: true, status: e.status, url: e.url ?? e.id ?? null }));
    if (already.exitCode !== 0) {
      console.error(`publish-shorts: o instagram já está registrado como "${e.status}", não "published" — confira na conta antes de relatar; nada foi gravado`);
    }
    return already.exitCode;
  }
  // #11390: o editor colou o permalink do Reel.
  if (urlFlag !== undefined) {
    const built = instagramConfirmUrlEntry(urlFlag, new Date().toISOString());
    if (!built.ok) {
      console.error(`publish-shorts: ${built.error}`);
      return 2;
    }
    persist(built.entry);
    const warning = "registrado pela URL informada, sem conferir na API — confira que é o Reel desta edição";
    const reminder = readInstagramManualFirstCommentReminder(dir, aammdd); // #13781
    const urlWarnings = reminder ? [warning, reminder] : [warning];
    for (const w of urlWarnings) console.error(`[aviso] instagram: ${w}`);
    console.log(JSON.stringify({ confirmed: true, id: built.entry.id, url: built.entry.url, account: "--url", warnings: urlWarnings }));
    return 0;
  }
  // #10978: --since inválido falha antes de qualquer chamada à API.
  if (sinceFlag !== undefined && Number.isNaN(Date.parse(sinceFlag))) {
    console.error(`publish-shorts: --since inválido: ${sinceFlag}`);
    return 2;
  }
  const config: any = io.config ?? JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  const { pages, apiVersion } = loadResolvedFacebookPages(ROOT, config);
  const igApiVersion = process.env.INSTAGRAM_API_VERSION || apiVersion;
  const cfg = loadShortsConfig(config);
  const author = await resolveInstagramAuthor(graph, cfg.instagramAuthorPage, pages, igApiVersion, {
    igUserId: process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ?? "",
    token: process.env.INSTAGRAM_ACCESS_TOKEN ?? "",
  });
  if (!author.ready) {
    console.error(`publish-shorts: não deu pra ler a conta do Instagram (${author.reason}) — registre com --mark instagram=URL`);
    return 1;
  }
  const ctx = instagramConfirmContext(dir, aammdd, config, editionUrlFlag);
  if (!ctx.d1Title && !mediaIdFlag) console.error(`[aviso] instagram: sem título do D1 (${join(dir, "02-reviewed.md")}) — o marcador fica só utm_campaign/URL e a janela de horário; se recusar, use --media-id`);
  const readInput = {
    apiVersion: igApiVersion,
    published,
    sinceIso: sinceFlag ?? ctx.sinceIso,
    markers: ctx.markers,
    mediaId: mediaIdFlag ?? null,
    nowIso: new Date().toISOString(),
    expectedAtIso: ctx.expectedAtIso,
  };
  // #11794: o Reels do B3b é postado pela @diar.ia.br com a @vjpixel em collab.
  // Na config de produção ela é a conta da API; outro perfil só com outra autora no config.
  const chrome = await resolveChromeAuthorReader(cfg.instagramAuthorPage, pages, igApiVersion, graph);
  const chromeReader = chrome.reader;
  const across = await decideInstagramConfirmAcrossAccounts({
    primary: () => readAndDecideInstagramConfirm(graph, { ...readInput, igUserId: author.igUserId, token: author.token }),
    ...confirmChromeAuthorDeps(chrome, (igUserId, token) => () => readAndDecideInstagramConfirm(graph, { ...readInput, igUserId, token })),
  });
  const decision = across.decision;
  const reader = across.account === "chrome-author" && chromeReader ? chromeReader : author;
  const who = reader.username ? `@${reader.username}` : across.account === "chrome-author" ? `@${INSTAGRAM_CHROME_ROUTE.authorUsername}` : reader.igUserId;
  if (decision.kind !== "register") {
    // already_registered foi tratado acima; aqui só sobra a recusa.
    const reason = decision.kind === "refuse" ? decision.reason : "já registrado";
    const candidates = decision.kind === "refuse" ? decision.candidates : [];
    console.error(`publish-shorts: ${who}: ${reason}. Nada gravado.`);
    if (across.fallbackNote) console.error(`publish-shorts: ${across.fallbackNote}`);
    for (const c of candidates) console.error(`  candidato: --media-id ${c.id}  ${c.timestamp}  ${c.permalink ?? "(sem permalink)"}${c.matchesEdition ? "  [marcador da edição]" : ""}`);
    console.error(`publish-shorts: com o permalink em mãos, registre com --confirm-instagram --url URL (ou --mark instagram=URL)`);
    console.log(JSON.stringify({ confirmed: false, reason, candidates, ...(across.fallbackNote ? { fallback: across.fallbackNote } : {}) }));
    return 1;
  }
  const entry = decision.entry;
  const warnings: string[] = [];
  if (decision.matchedBy === "time-window") {
    warnings.push(`a legenda não tem o título nem o gancho do D1; registrado pelo único Reels no formato do vertical perto das ${ctx.expectedAtIso} (#10978) — confira o permalink`);
  }
  if (!entry.url) warnings.push(`a mídia ${entry.id} veio sem permalink — o id fica no registro`);
  // #11794: o Reels da autora da rota do Chrome sempre cobra o collab da @vjpixel.
  const expectedCollabs = instagramConfirmExpectedCollabs({ account: across.account, sameAccount: chrome.sameAccount === true, configCollaborators: cfg.instagramCollaborators });
  if (across.account === "chrome-author") {
    warnings.push(`achado no perfil do ${who} (rota do Chrome, #11390): o Reel aparece na @${INSTAGRAM_CHROME_ROUTE.collaboratorUsername} quando o convite de collab for aceito`);
  }
  if (expectedCollabs.length) {
    try {
      const collab = await graphGet(graph, `${entry.id}/collaborators`, { fields: "username,invite_status", access_token: reader.token }, igApiVersion);
      warnings.push(...collabInviteWarnings(collab?.data, expectedCollabs, { reportPending: true }));
    } catch (e) {
      warnings.push(`não deu pra conferir o collab (${(e as Error).message}) — confira no app`);
    }
  }
  persist(entry);
  const reminder = readInstagramManualFirstCommentReminder(dir, aammdd); // #13781
  if (reminder) warnings.push(reminder);
  for (const w of warnings) console.error(`[aviso] instagram: ${w}`);
  console.log(JSON.stringify({ confirmed: true, id: entry.id, url: entry.url ?? null, account: who, warnings }));
  return 0;
}
