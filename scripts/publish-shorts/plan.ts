/**
 * Plano puro da rodada (`planShortsPublish`): o que sai em cada destino e por quê.
 *
 * Parte de `scripts/publish-shorts.ts` (#14054): movido sem mudar a lógica; a entrada
 * reexporta o que os testes e os outros scripts importam.
 */
import { parseDestaques } from "../extract-destaques.ts";
import { publishConfirmSuffix } from "../lib/diaria/publish-confirm.ts";
import { editionDir as editionDirFor } from "../lib/edition-paths.ts";
import { deriveEditionUrl } from "../lib/edition-url.ts";
import {
  CORTE_TIMER_DESTINATIONS,
  CORTE_TIMER_INTERVAL_MS,
  CORTE_TIMER_TASK,
  ALLOW_UNWATCHED_DIR_FLAG,
  corteShortTime,
  corteTextInput,
} from "../lib/diaria/short-corte.ts";
import { resolveEditionScheduledAt } from "../lib/edition-scheduled-at.ts";
import {
  buildReelsCaption,
  buildYouTubeShortMetadata,
  resolveShortHorizontalTitle,
  resolveVerticalBioCta,
  VERTICAL_COMMENT_CTA_LINE,
  VERTICAL_REPLY_CTA_LINE,
  verticalEditionLinkText,
  TIKTOK_NO_BIO_CTA_LINE,
  INSTAGRAM_CHROME_ROUTE,
  instagramApiMaxSecondsPremise,
  instagramReelUploadRoute,
  instagramChromeRouteText,
  instagramReelsApiFit,
  isDestinationDone,
  knownDestinationIds,
  listShortDestinations,
  loadShortScheduleConfig,
  loadShortsConfig,
  planShortSlots,
  resolveInstagramApiMaxSeconds,
  resolveReelsSchedule,
  resolveShortTime,
  buildShortSocialText,
  diariaFollowLine,
  buildTikTokPost,
  planLinkedInRepostSlot,
  type ShortDestination,
  type ShortSlot,
  type ShortsConfig,
  type ShortTime,
  shortDestinationAccount,
  shortDestinationAlsoAccounts,
} from "../lib/diaria/short-video.ts";
import { D1_VIDEO_URL_FILE } from "../lib/diaria/d1-video-link.ts";
import { corteTimerHeartbeatStale } from "../lib/diaria/corte-timer-heartbeat.ts";
import { resolveYouTubeSchedule, stripInlineMarkdown, youtubeVideoFileName } from "../lib/diaria/youtube-video.ts";
import { MAX_FIRE_LATENESS_MS } from "../lib/linkedin-personal.ts";
import { planCoverDestination } from "../lib/diaria/short-cover.ts";
import {
  DIARIA_HOME_URL,
  LINKEDIN_TIMER_DETAIL,
  INSTAGRAM_TIMER_DETAIL,
  THREADS_TIMER_DETAIL,
  corteTimerDelegatedDetail,
  type ShortsPlanItem,
  type ShortsPlan,
  planShortHorizontalLinks,
  missingHorizontalLinkWarning,
  lateNowArgs,
  OWNER_SCHEDULE_MIN_LEAD_MS,
  assignShortsDestinationOwners,
  type ShortsPlanInput,
  ownersContextAfterPublish,
  corteTimerStaleWarning,
} from "./_shared.ts";
import { shortsReelsIdempotencyKey } from "./instagram.ts";
import { PROFILE_SEND_UNKNOWN_BLOCKER, PROFILE_REPOST_CHAIN_STALE_DETAIL, delegateCorteRepostToTimer, isProfileRepostChainStale } from "./linkedin.ts";

/** Miolo puro: o que cada destino faria, sem I/O. Lança em config/`--only` inconsistentes. */
export function planShortsPublish(input: ShortsPlanInput): ShortsPlan {
  const premises: string[] = [];
  const warnings: string[] = [];
  const corte = input.corte;
  // #11795: o corte está fora do teste de horário por definição; o texto do skip_late não pode citá-lo.
  const lateReason = corte ? "passou do horário do corte (--at)" : "fora do horário do teste (#10831)";
  const d1 = corte ? { n: 1, ...corteTextInput(corte) } : parseDestaques(input.reviewedMd).find((d) => d.n === 1);
  if (!d1) throw new Error("02-reviewed.md sem DESTAQUE 1 — nada para derivar o vídeo curto");

  const editionUrl: string = input.editionUrl ?? (corte ? DIARIA_HOME_URL : deriveEditionUrl(d1.title));
  if (corte) {
    // #11795: o corte não é de edição — nenhum texto do vertical leva link (#11617), então o link é só referência do plano.
    premises.push(`corte avulso "${corte.slug}": título e gancho explícitos (sem D1); link de referência ${editionUrl}${input.editionUrl ? ` (${input.editionUrlSource ?? "--edition-url"})` : ""}`);
  } else if (input.editionUrl) {
    premises.push(`link da edição: ${editionUrl} (${input.editionUrlSource ?? "--edition-url"})`);
  } else {
    // #10943 item 3: no fluxo novo o vertical sai ANTES da Etapa 5, então
    // `05-edition-url.txt` ainda não existe. O Stage 5 grava exatamente
    // `deriveEditionUrl(D1)` (publish-newsletter-kit.ts, #7420): o link derivado
    // aqui é o mesmo que o Stage 5 vai gravar, não um palpite.
    premises.push(`link da edição: ${editionUrl} (derivado do título do D1 — mesma regra do Stage 5, #7420)`);
  }
  const d1In = { title: d1.title, body: d1.body };
  // #12191: o Short cita o horizontal do dia por título (só texto, #10831/#11617). O corte não tem horizontal.
  const horizontalTitle = corte
    ? null
    : resolveShortHorizontalTitle({
        d1Title: d1.title,
        recordTitle: input.horizontalVideo?.recordTitle ?? null,
        noVideo: input.horizontalVideo?.noVideo ?? false,
      });
  if (!corte) {
    premises.push(
      horizontalTitle
        ? `descrição do Short cita o horizontal: “${horizontalTitle}” (${input.horizontalVideo?.recordTitle?.trim() ? "registro do upload" : "derivado do D1, sem registro do upload"})`
        : "descrição do Short sem citação do horizontal (edição marcada sem vídeo)",
    );
  }
  const youtube = buildYouTubeShortMetadata({ d1: d1In, horizontalTitle });
  // #12735: o horizontal DA edição na legenda das redes que aceitam link (LinkedIn, X, Facebook). Nunca no corte.
  // #13117: fala `cta_vertical` no roteiro. #13209: a linha "Vídeo completo:
  // link na bio" só entra se, além da fala, o vertical tiver o mesmo título
  // do horizontal publicado (`resolveVerticalBioCta`). #13280: a marcação do
  // roteiro (`porVideo.vertical1.pertenceAoHorizontal`) decide no lugar do título.
  const ctaFala = !corte && input.horizontalVideo?.ctaVertical === true;
  const bioCta = resolveVerticalBioCta({
    ctaFala,
    d1Title: d1.title,
    recordTitle: input.horizontalVideo?.recordTitle ?? null,
    noVideo: input.horizontalVideo?.noVideo ?? false,
    pertenceAoHorizontal: corte ? undefined : input.horizontalVideo?.pertenceAoHorizontal,
  });
  const ctaVertical = bioCta.ctaVertical;
  if (ctaVertical && bioCta.criterio === "roteiro") {
    premises.push(`legenda do vertical com a chamada ao vídeo completo: o roteiro marca o vertical 1 como do horizontal (porVideo.vertical1.pertenceAoHorizontal, #13280)`);
  }
  if (ctaFala && !ctaVertical) {
    const motivo =
      bioCta.reason === "roteiro-nao-pertence"
        ? "o roteiro marca o vertical 1 como fora do horizontal (porVideo.vertical1.pertenceAoHorizontal: false, #13280)"
        : bioCta.reason === "titulo-diferente"
          ? "o título do vertical difere do horizontal publicado e o roteiro não marca o vertical 1 como do horizontal (porVideo.vertical1.pertenceAoHorizontal, #13280)"
          : "sem horizontal publicado nesta edição (registro do upload)";
    premises.push(`legenda do vertical sem a chamada ao vídeo completo ("${VERTICAL_COMMENT_CTA_LINE}" / "${VERTICAL_REPLY_CTA_LINE}"), sem 1º comentário nem resposta: ${motivo} (#13209, #13709)`);
  }
  if (!corte && input.horizontalVideo?.roteiroWarning) warnings.push(input.horizontalVideo.roteiroWarning);
  const horizontalLink = corte || input.horizontalVideo?.noVideo ? null : (input.horizontalVideo?.url ?? null);

  // #10831: o vertical tem horário próprio (nunca as 06:00 do horizontal).
  // #12250: fixo POR DESTINO (YouTube Shorts 06:30, os outros 12:00). `time` é o
  // dos destinos sem horário próprio (`default_time`); `timeFor` resolve cada um.
  // O corte avulso usa o `--at` em todos os destinos.
  const schedCfg = corte ? null : loadShortScheduleConfig(input.config);
  const time = corte ? corteShortTime(corte.hhmm) : resolveShortTime(schedCfg!, input.aammdd);
  const shortTime = { ...time, at: resolveEditionScheduledAt(input.aammdd, time.hhmm) };
  const destinationTimeCache = new Map<string, ShortTime & { at: string }>();
  const timeFor = (destinationId: string): ShortTime & { at: string } => {
    if (!schedCfg) return shortTime;
    let t = destinationTimeCache.get(destinationId);
    if (!t) {
      const own = resolveShortTime(schedCfg, input.aammdd, destinationId);
      t = own.hhmm === time.hhmm && own.source === time.source ? shortTime : { ...own, at: resolveEditionScheduledAt(input.aammdd, own.hhmm) };
      destinationTimeCache.set(destinationId, t);
    }
    return t;
  };
  premises.push(`horário do vertical: ${time.hhmm} BRT (${time.reason})`);
  if (input.forceNow) premises.push("--now: publica na hora");
  if (!input.video.exists) warnings.push(`vídeo curto ausente em ${input.video.path} — nada a publicar até ele existir`);

  const cfg = loadShortsConfig(input.config);
  for (const slug of cfg.facebookPages) {
    if (!input.pages.some((p) => p.slug === slug)) {
      throw new Error(`publishing.shorts.facebook_pages: página "${slug}" não existe em publishing.social.facebook.pages`);
    }
  }
  // #10820: mesmo tratamento do facebook_pages — slug inválido é erro de config, não aviso de runtime.
  if (cfg.instagram && cfg.instagramAuthorPage !== null && !input.pages.some((p) => p.slug === cfg.instagramAuthorPage)) {
    throw new Error(`publishing.shorts.instagram_author_page: página "${cfg.instagramAuthorPage}" não existe em publishing.social.facebook.pages`);
  }
  const known = knownDestinationIds(cfg);
  const only = input.only && input.only.length ? new Set(input.only) : null;
  if (only) {
    const unknown = [...only].filter((d) => !known.has(d));
    if (unknown.length) throw new Error(`--only com destino desconhecido: ${unknown.join(", ")} (válidos: ${[...known].join(", ")})`);
  }

  const destinations = listShortDestinations(cfg).filter((d) => !only || only.has(d.id));
  // #12250: destino com horário próprio (ex.: YouTube Shorts 06:30) vira premissa explícita.
  for (const d of destinations) {
    const t = timeFor(d.id);
    if (t !== shortTime) premises.push(`horário de ${d.id}: ${t.hhmm} BRT (${t.reason})`);
  }
  // #10893: Reels acima do teto medido da API do Instagram vira passo guiado
  // ANTES do upload, em vez de falhar no rupload depois de subir o arquivo.
  // #10916: o teto é POR CONTA (a autora do Reels), não global.
  const igMaxRes = resolveInstagramApiMaxSeconds(input.config, cfg.instagramAuthorPage);
  const igMax = igMaxRes.maxSeconds;
  const igMaxPremise = instagramApiMaxSecondsPremise(igMaxRes);
  if (igMaxPremise && destinations.some((d) => d.id === "instagram")) premises.push(igMaxPremise);
  const igAccountLabel = cfg.instagramAuthorPage === null ? "da diar.ia.br (env)" : `vinculada à página ${cfg.instagramAuthorPage}`;
  const igFit = input.instagramGuidedFallback
    ? ({ fits: false, reason: input.instagramGuidedFallback } as const)
    : instagramReelsApiFit(input.videoDurationSeconds ?? null, igMax, igAccountLabel);
  // Sem credencial (ou acima do teto, no Instagram) o destino não sai pela API — não disputa a grade nem gera premissa de horário.
  function publishable(d: ShortDestination): boolean {
    if (d.kind === "facebook_page") return !input.pages.find((p) => p.slug === d.slug)!.missing.length;
    if (d.kind === "instagram") return input.instagramReady && igFit.fits;
    if (d.kind === "linkedin_profile") return input.linkedinPersonal?.ready === true;
    if (d.kind === "x" || d.kind === "tiktok") return input.publicVideo?.ready === true;
    if (d.kind === "threads_profile") return input.threadsPersonal?.ready === true && input.publicVideo?.ready === true;
    return false;
  }
  // #10933: Instagram acima do teto vira post MANUAL no app, mas continua sendo
  // um post da conta naquele horário — reserva o slot na grade como os de API.
  const manualInstagram = (d: ShortDestination) => d.kind === "instagram" && !igFit.fits;
  // #10819: só os destinos que esta rodada ainda vai publicar disputam a grade;
  // os já registrados entram nela pelo `06-shorts-published.json`.
  // #11265: com o timer do 300 dono do Instagram, o Reels sai SEMPRE no
  // horário do vertical (`shortTime`), fora da grade — é o mesmo horário que
  // o timer usa pra decidir quando agir (`decideInstagramTimerRun`). Pela
  // grade, fora da rotação os dois divergiam (261117: shortTime 12:00, slot
  // 19:30) e o Reels nunca saía. Ele entra na grade como post fixo, pros
  // outros destinos se espaçarem em volta dele.
  // #11795: o corte avulso nunca delega aos timers do 300 (eles procuram a pasta da edição).
  // #11911: nem uma pasta fora de data/editions/{AAMM}/{AAMMDD} (`--edition-dir`): o timer não a
  // enxerga e pula em silêncio ("dia sem edição") — foi assim que o Reels do corte de 02/11 sumiu
  // (rodada em modo edição com --edition-dir ~/diaria-cortes/...).
  const timersBlind = Boolean(corte) || input.editionDirOverride !== undefined;
  if (input.editionDirOverride !== undefined && !corte) {
    if (input.unwatchedEditionWarning !== undefined) warnings.push(input.unwatchedEditionWarning);
    const delegable = [
      cfg.instagram && cfg.instagramBackend === "timer-300" ? "instagram" : null,
      cfg.linkedinProfile && cfg.linkedinProfileViaTimer ? "linkedin_profile" : null,
      cfg.threadsProfile && cfg.threadsProfileViaTimer ? "threads_profile" : null,
    ].filter((d): d is string => d !== null && (!only || only.has(d)));
    if (delegable.length) {
      warnings.push(
        `--edition-dir ${input.editionDirOverride} fica fora de ${editionDirFor(input.aammdd)}: os timers do 300 não enxergam esta pasta, então ${delegable.join(", ")} não é delegado a eles e o dono é esta rodada (re-execução com o mesmo --edition-dir e --${ALLOW_UNWATCHED_DIR_FLAG}). Para um corte fora de edição, use --corte SLUG (#11795, #11911)`,
      );
    }
  }
  const instagramViaTimer = cfg.instagramBackend === "timer-300" && !timersBlind;
  // #11911: corte fora de data/cortes/ — o timer do corte não o enxerga.
  const corteOutside = corte ? input.corteOutside : undefined;
  if (corteOutside) warnings.push(corteOutside.warning);
  const corteTimer = Boolean(corte) && cfg.corteViaTimer && !corteOutside;
  // #11795: quem roda de novo depois do horário um destino cuja API não agenda.
  const pendingRunner = (hhmm: string): string =>
    corteTimer
      ? `o timer do 300 (${CORTE_TIMER_TASK}) publica na 1ª execução depois das ${hhmm} BRT e alarma se falhar, só com o --publish confirmado (owners, #11795, #11912)`
      : `a skill agenda a re-execução para depois das ${hhmm} BRT (owners, #11550)`;
  // #11964: na janela em que o timer do corte publica (de 10 min antes do horário, quando a
  // rodada já publicaria na hora, até uma cadência do timer antes do teto de 3 h, #11996), só o filho do timer publica os destinos
  // dele. A rodada manual (com ou sem --now) os delega: as duas no mesmo destino duplicam o post.
  // Antes da janela segue `pending_schedule` (o timer é o dono); depois, `skip_late` (o timer já
  // não publica e só alarma, então a rodada manual com --now é segura).
  const corteTimerOwnsNow = (destination: string): boolean => {
    if (!corte || !corteTimer || corte.timerRun === true || !CORTE_TIMER_DESTINATIONS.includes(destination)) return false;
    // Reels acima do teto da API: o timer também não publica (vira passo guiado); o passo fica com esta rodada.
    if (destination === "instagram" && !igFit.fits) return false;
    const deltaMs = input.now.getTime() - Date.parse(shortTime.at);
    // #11996: com menos de uma cadência do timer até o teto, a próxima execução dele já cai em
    // `late` (só alarma): delegar ali deixava o post sem sair. A rodada manual fica com o destino.
    return deltaMs >= -OWNER_SCHEDULE_MIN_LEAD_MS && deltaMs <= MAX_FIRE_LATENESS_MS - CORTE_TIMER_INTERVAL_MS;
  };
  const instagramDelegated = instagramViaTimer && input.writer !== "instagram-timer";
  const slotDestinations = destinations.filter((d) => !isDestinationDone(input.published, d.id) && (publishable(d) || manualInstagram(d)));
  const fixedInstagram = instagramViaTimer ? slotDestinations.find((d) => d.kind === "instagram") : undefined;
  const fixedInstagramSlot: ShortSlot | null = fixedInstagram ? instagramTimerSlot(fixedInstagram, cfg, timeFor(fixedInstagram.id).hhmm, timeFor(fixedInstagram.id).at) : null;
  const slots = [
    ...(fixedInstagramSlot ? [fixedInstagramSlot] : []),
    ...planShortSlots({
      aammdd: input.aammdd,
      time,
      timeAt: shortTime.at,
      timeFor: (id) => {
        const t = timeFor(id);
        return { time: t, at: t.at };
      },
      destinations: slotDestinations.filter((d) => d !== fixedInstagram),
      cfg,
      grid: [
        ...(input.grid ?? []),
        ...(fixedInstagramSlot
          ? [{ account: fixedInstagramSlot.account, at: fixedInstagramSlot.at, label: "shorts instagram (timer do 300)", ...(fixedInstagramSlot.alsoAccounts ? { alsoAccounts: fixedInstagramSlot.alsoAccounts } : {}) }]
          : []),
      ],
    }),
  ];
  const slotOf = new Map(slots.map((s) => [s.destination, s]));
  for (const s of slots) {
    if (s.rule === "timer-300" || s.rule === "explicit") premises.push(`${s.destination}: ${s.hhmm} BRT (${s.premise})`);
    else if (s.rule !== "test-schedule" && s.rule !== "fixed-time") premises.push(`${s.destination}: ${s.hhmm} BRT (grade #10819: ${s.premise})`);
    if (s.warning) warnings.push(s.warning);
  }
  const scheduleFor = (s: ShortSlot) => (input.forceNow ? ({ mode: "immediate" } as const) : resolveReelsSchedule(s.at, input.now));
  for (const s of slots) {
    if (input.forceNow) continue;
    if (s.destination === "instagram" && !igFit.fits) {
      premises.push(`instagram: passo manual (Chrome ou app) às ${s.hhmm} BRT do dia da edição (acima do teto da API, #10893) — slot reservado na grade (#10933)`);
      continue;
    }
    const sch = scheduleFor(s);
    premises.push(
      sch.mode === "scheduled"
        ? `${s.destination}: ${s.destination !== "instagram" ? "agendado para" : instagramViaTimer ? "timer do 300 publica depois de" : input.instagramQueue?.ready ? "fila do Worker para" : "pendente até"} ${sch.at} (${s.hhmm} BRT do dia da edição)`
        : `${s.destination}: ${s.hhmm} BRT do dia da edição já passou (ou falta <10 min) — publica na hora`,
    );
  }

  // #12465: o perfil pessoal (LinkedIn, Threads) cita o perfil da diar.ia.br; o X sai pela @diariabr.
  const socialText = (platform: "linkedin" | "x" | "threads") =>
    buildShortSocialText({
      platform,
      d1: d1In,
      follow: diariaFollowLine(platform === "linkedin" ? "linkedin_profile" : platform === "threads" ? "threads_profile" : "x", cfg.diariaProfiles),
      horizontalLink, ctaVertical, // #13117/#13709: Threads aponta para a resposta com o link por edição
    });

  // #10772 F4: a Posts API do LinkedIn não agenda — o vídeo sai quando a rodada
  // roda. Sem teto, uma rodada horas depois (ou no dia seguinte) publicaria fora
  // do horário do teste (#10831). Mesmo teto do `--fire-due` do 4º post; `--now`
  // é a exceção explícita.
  // #11122: a Threads API também não agenda — mesmo teto pro Threads pessoal.
  const lateFor = (destination: string): string | null => {
    const slot = slotOf.get(destination);
    if (!slot || input.forceNow) return null;
    const lateMs = input.now.getTime() - Date.parse(slot.at);
    if (!(lateMs > MAX_FIRE_LATENESS_MS)) return null;
    return `${slot.hhmm} BRT passou há ${Math.round(lateMs / 60_000)} min (teto ${MAX_FIRE_LATENESS_MS / 3_600_000} h)`;
  };
  const profileLate = lateFor("linkedin_profile");
  // #10982: com o timer do 300 dono do vídeo do perfil, a rodada da skill não o publica.
  const profileDelegated = cfg.linkedinProfileViaTimer && input.writer !== "linkedin-timer" && !timersBlind;
  // #11410: idem pro Threads pessoal.
  const threadsDelegated = cfg.threadsProfileViaTimer && input.writer !== "threads-timer" && !timersBlind;

  // #10772 F1: o repost da página só existe se o vídeo do perfil já está
  // registrado ou sai nesta rodada (publish/pending_schedule). Sem isso a skill
  // receberia um passo de repost de um vídeo que não existe.
  // #12761: `pendingAt` = o perfil ainda vai sair por um dono automático (timer
  // do 300, timer do corte, ou o agente com --now): horário esperado do perfil,
  // base do dono do repost bloqueado. Ausente = bloqueio sem saída automática.
  const profileBlock = ((): { reason: string; pendingAt?: string } | null => {
    // #10907: `send_unknown` conta como feito pra NÃO repostar o vídeo do perfil,
    // mas não prova que ele existe — o repost espera o editor conferir e registrar a URL.
    if (input.published.entries.some((e) => e.destination === "linkedin_profile" && e.status === "send_unknown")) {
      return { reason: PROFILE_SEND_UNKNOWN_BLOCKER };
    }
    if (isDestinationDone(input.published, "linkedin_profile")) return null;
    const dest = destinations.find((d) => d.kind === "linkedin_profile");
    if (!dest) return { reason: "o vídeo do perfil (linkedin_profile) não está registrado nem nesta rodada" };
    if (!publishable(dest)) return { reason: "o vídeo do perfil (linkedin_profile) não sai nesta rodada (sem credencial)" };
    const plannedProfileAt = slotOf.get("linkedin_profile")?.at ?? timeFor(dest.id).at;
    // #12761 (review): teto da cadeia de re-agendamento. Cada re-execução com o perfil ainda
    // pendente reagendaria o repost de novo, sem fim; passado o teto desde o horário planejado
    // do perfil, o repost perde o dono e o plano pede intervenção do editor.
    const profileStale = isProfileRepostChainStale(plannedProfileAt, input.now);
    const pending = (reason: string, pendingAt: string): { reason: string; pendingAt?: string } =>
      profileStale ? { reason: `${reason}; ${PROFILE_REPOST_CHAIN_STALE_DETAIL}` } : { reason, pendingAt };
    if (profileDelegated) return pending(`o vídeo do perfil (linkedin_profile) ${LINKEDIN_TIMER_DETAIL}`, plannedProfileAt);
    if (corte && corteTimerOwnsNow("linkedin_profile")) {
      return pending(`o vídeo do perfil (linkedin_profile) ${corteTimerDelegatedDetail(corte.slug)}`, plannedProfileAt);
    }
    // skip_late: o dono do perfil (o agente) publica já, com --now.
    if (profileLate) return pending(`o vídeo do perfil (linkedin_profile) não sai nesta rodada (${profileLate})`, input.now.toISOString());
    try {
      socialText("linkedin");
    } catch (e) {
      return { reason: `o vídeo do perfil (linkedin_profile) não sai nesta rodada (${(e as Error).message})` };
    }
    return null;
  })();
  const profileBlocker = profileBlock?.reason ?? null;

  // #10772: repost da página — depois do vídeo do perfil, num horário da grade da página.
  // #12761: com o perfil pendente de um dono automático, o horário sai do horário esperado do perfil.
  const repostSlot = (() => {
    if (!destinations.some((d) => d.kind === "linkedin_page_repost") || isDestinationDone(input.published, "linkedin_page_repost")) return null;
    if (profileBlock && profileBlock.pendingAt === undefined) return null;
    const profileEntry = input.published.entries.find((e) => e.destination === "linkedin_profile");
    const profileAt =
      profileBlock?.pendingAt ?? (profileEntry ? (profileEntry.scheduled_at ?? profileEntry.at) : (slotOf.get("linkedin_profile")?.at ?? shortTime.at));
    const plannedGrid = [
      ...(input.grid ?? []),
      ...slots.map((s) => ({ account: s.account, at: s.at, label: `shorts ${s.destination}`, ...(s.alsoAccounts ? { alsoAccounts: s.alsoAccounts } : {}) })),
    ];
    const s = planLinkedInRepostSlot({ aammdd: input.aammdd, profileAt: Number.isNaN(Date.parse(profileAt)) ? shortTime.at : profileAt, grid: plannedGrid });
    premises.push(`linkedin_page_repost: ${s.hhmm} BRT (grade da página #10819: ${s.premise})`);
    if (s.warning) warnings.push(s.warning);
    return s;
  })();

  // #13733: no corte com o timer, o vídeo do perfil sai depois pelo timer do corte, que entrega o
  // repost à fila do Worker na mesma execução (a URN só existe depois do perfil): o repost é dele.
  const items: ShortsPlanItem[] = corteTimer && corte
    ? delegateCorteRepostToTimer(destinations.map((dest) => planDestination(dest)), corte.slug, input.aammdd)
    : destinations.map((dest) => planDestination(dest));

  function planDestination(dest: ShortDestination): ShortsPlanItem {
    if (isDestinationDone(input.published, dest.id)) {
      return { destination: dest.id, mode: dest.mode, action: "skip_done" };
    }
    if (corte && corteTimerOwnsNow(dest.id)) {
      // #11964: o timer do corte publica este destino agora; esta rodada não (sairia em dobro).
      return { destination: dest.id, mode: "api", action: "skip_delegated", detail: corteTimerDelegatedDetail(corte.slug) };
    }
    if (dest.kind === "youtube_shorts") {
      // #11070: Data API com publishAt (o horizontal provou em 23/10 que o
      // agendado vira público sozinho, sem a auditoria). Sem credencial, guiado.
      // #12250: horário próprio do Short (06:30), não o dos outros destinos.
      const ytTime = timeFor(dest.id);
      if (cfg.youtubeShortsApi && input.youtubeApi?.ready === true) {
        const sch = input.forceNow ? null : resolveYouTubeSchedule(input.aammdd, input.now, ytTime.at);
        const publishAt = sch?.mode === "scheduled" ? sch.publishAt : null;
        premises.push(
          publishAt
            ? `youtube_shorts: Data API, agendado (private + publishAt ${publishAt}, ${ytTime.hhmm} BRT do vertical) (#11070)`
            : `youtube_shorts: Data API, público na hora (${input.forceNow ? "--now" : `${ytTime.hhmm} BRT já passou ou falta menos de 15 min`}) (#11070)`,
        );
        return { destination: dest.id, mode: "api", action: "publish", caption: youtube.description, scheduledAt: publishAt, title: youtube.title };
      }
      const why = !cfg.youtubeShortsApi
        ? "publishing.shorts.youtube_shorts_api = false"
        : input.youtubeApi?.ready === false
          ? input.youtubeApi.reason
          : "credencial YOUTUBE_* não conferida";
      if (cfg.youtubeShortsApi) warnings.push(`youtube_shorts: ${why} — vira passo guiado no YouTube Studio (#11070)`);
      return { destination: dest.id, mode: "guided", action: "guided", detail: `YouTube Studio no Chrome (${why}), agendado para ${ytTime.hhmm} BRT`, at: ytTime.at };
    }
    if (dest.kind === "linkedin_profile") {
      if (profileDelegated) {
        return { destination: dest.id, mode: "api", action: "skip_delegated", detail: LINKEDIN_TIMER_DETAIL };
      }
      if (input.linkedinPersonal?.ready !== true) {
        const reason = input.linkedinPersonal?.ready === false ? input.linkedinPersonal.reason : "credencial LINKEDIN_PERSONAL_* não conferida";
        warnings.push(`linkedin_profile: ${reason}`);
        return { destination: dest.id, mode: "api", action: "skip_missing_credentials", detail: reason };
      }
      if (profileLate) {
        const nowCmd = `${lateNowArgs(dest.id, input.writer)} ${publishConfirmSuffix(input.aammdd)}`;
        const detail =
          `${profileLate} — ${lateReason}, esta rodada não publica sozinha. ` +
          `O agente publica com ${nowCmd} (ou registra com --mark linkedin_profile=URL se já saiu); nunca volta ao editor (#11550)`;
        warnings.push(`linkedin_profile: ${detail}`);
        return { destination: dest.id, mode: "api", action: "skip_late", detail };
      }
      let text: string;
      try {
        text = socialText("linkedin");
      } catch (e) {
        warnings.push(`linkedin_profile: ${(e as Error).message}`);
        return { destination: dest.id, mode: "api", action: "skip_invalid", detail: (e as Error).message };
      }
      const slot = slotOf.get(dest.id)!;
      const schedule = scheduleFor(slot);
      const title = stripInlineMarkdown(d1In.title).replace(/\s+/g, " ").trim();
      if (schedule.mode === "scheduled") {
        return {
          destination: dest.id,
          mode: "api",
          action: "pending_schedule",
          caption: text,
          scheduledAt: schedule.at,
          detail: `a Posts API do LinkedIn não agenda — ${pendingRunner(slot.hhmm)}`,
          title, // #12654: a task one-shot publica com este título; o plano aprovado já o mostra
        };
      }
      return { destination: dest.id, mode: "api", action: "publish", caption: text, scheduledAt: null, title };
    }
    if (dest.kind === "linkedin_page_repost") {
      if (profileBlocker) {
        const detail = `${profileBlocker} — repost só depois que o vídeo do perfil sair (ou for registrado com --mark linkedin_profile=URL)`;
        warnings.push(`linkedin_page_repost: ${detail}`);
        // #12761: perfil pendente de um dono automático → o repost leva o horário da re-execução (dono em owners[]).
        return { destination: dest.id, mode: "guided", action: "skip_invalid", detail, ...(repostSlot ? { retryAt: repostSlot.at } : {}) };
      }
      const profile = input.published.entries.find((e) => e.destination === "linkedin_profile");
      const where = profile?.url ? ` (${profile.url})` : profile ? "" : " — depois que o vídeo do perfil (linkedin_profile) sair";
      return {
        destination: dest.id,
        mode: "guided",
        action: "guided",
        at: repostSlot!.at,
        detail:
          `repost pela página diar.ia.br às ${repostSlot!.hhmm} BRT: no Chrome, como a página, "Repostar" o vídeo do perfil${where}. ` +
          `O --publish tenta antes a fila do Worker (repost como página, #11121); este passo só vale se ela recusar ` +
          `(Worker sem o token da página, #8816) — registre com --mark linkedin_page_repost=URL`,
      };
    }
    if (dest.kind === "x") {
      if (input.publicVideo?.ready !== true) {
        const reason = `o X recebe o vídeo por URL pública, indisponível nesta rodada (${input.publicVideo?.ready === false ? input.publicVideo.reason : "não conferido"})`;
        warnings.push(`x: ${reason}`);
        return { destination: dest.id, mode: "guided", action: "skip_missing_credentials", detail: reason, cause: "public_video" };
      }
      let text: string;
      try {
        text = socialText("x");
      } catch (e) {
        warnings.push(`x: ${(e as Error).message}`);
        return { destination: dest.id, mode: "guided", action: "skip_invalid", detail: (e as Error).message };
      }
      const slot = slotOf.get(dest.id)!;
      const schedule = scheduleFor(slot);
      return {
        destination: dest.id,
        mode: "guided",
        action: "buffer",
        caption: text,
        scheduledAt: schedule.mode === "scheduled" ? schedule.at : null,
        detail:
          "Buffer create_post no canal @diariabr com o vídeo de results[].buffer.videoUrl (o --publish sobe o vertical pro R2); " +
          "com results[].buffer.thumbnailOffset presente, o asset vai como { video: { url, metadata: { thumbnailOffset } } } (ms, a capa do X, #11547); " +
          "registre com --mark x=buffer:{id do post} --scheduled-at {dueAt} (+ --thumbnail-offset {ms} se passou o offset)",
      };
    }
    if (dest.kind === "tiktok") {
      // #11515: TikTok pela Buffer (decisão do editor de 28/10/2026), mesmo caminho do X:
      // o --publish sobe o vertical pro R2 e a skill chama o create_post.
      if (input.publicVideo?.ready !== true) {
        const reason = `o TikTok (Buffer) recebe o vídeo por URL pública, indisponível nesta rodada (${input.publicVideo?.ready === false ? input.publicVideo.reason : "não conferido"})`;
        warnings.push(`tiktok: ${reason}`);
        return { destination: dest.id, mode: "guided", action: "skip_missing_credentials", detail: reason, cause: "public_video" };
      }
      let post: { caption: string; title: string };
      try {
        post = buildTikTokPost({ d1: d1In, ctaVertical }); // #13209, #13709: TikTok sem link
      } catch (e) {
        warnings.push(`tiktok: ${(e as Error).message}`);
        return { destination: dest.id, mode: "guided", action: "skip_invalid", detail: (e as Error).message };
      }
      const slot = slotOf.get(dest.id)!;
      const schedule = scheduleFor(slot);
      const channelId = cfg.tiktokBufferChannelId!; // loadShortsConfig exige o canal com tiktok ligado
      return {
        destination: dest.id,
        mode: "guided",
        action: "buffer",
        caption: post.caption,
        scheduledAt: schedule.mode === "scheduled" ? schedule.at : null,
        channelId,
        tiktok: { title: post.title, isAiGenerated: false },
        detail:
          `Buffer create_post no canal TikTok ${channelId} com o vídeo de results[].buffer.videoUrl (o --publish sobe o vertical pro R2), ` +
          "metadata.tiktok de results[].buffer.metadata.tiktok (title, isAiGenerated: false); " +
          "registre com --mark tiktok=buffer:{id do post} --scheduled-at {dueAt} (+ --thumbnail-offset {ms} se passou o offset)",
      };
    }
    if (dest.kind === "threads_profile") {
      // #11122: vertical no Threads pessoal. Mesmo contrato do linkedin_profile:
      // sem credencial é fail-soft, a API não agenda (pending antes do horário,
      // skip_late depois do teto), `send_unknown` conta como feito.
      if (threadsDelegated) {
        return { destination: dest.id, mode: "api", action: "skip_delegated", detail: THREADS_TIMER_DETAIL };
      }
      if (input.threadsPersonal?.ready !== true) {
        const reason = input.threadsPersonal?.ready === false ? input.threadsPersonal.reason : "credencial THREADS_PERSONAL_* não conferida";
        warnings.push(`threads_profile: ${reason}`);
        return { destination: dest.id, mode: "api", action: "skip_missing_credentials", detail: reason };
      }
      if (input.publicVideo?.ready !== true) {
        const reason = `o Threads recebe o vídeo por URL pública, indisponível nesta rodada (${input.publicVideo?.ready === false ? input.publicVideo.reason : "não conferido"})`;
        warnings.push(`threads_profile: ${reason}`);
        return { destination: dest.id, mode: "api", action: "skip_missing_credentials", detail: reason, cause: "public_video" };
      }
      const late = lateFor(dest.id);
      if (late) {
        const detail =
          `${late} — ${lateReason}, esta rodada não publica sozinha. ` +
          `O agente publica com ${lateNowArgs(dest.id, input.writer)} ${publishConfirmSuffix(input.aammdd)} (ou registra com --mark threads_profile=URL se já saiu); nunca volta ao editor (#11550)`;
        warnings.push(`threads_profile: ${detail}`);
        return { destination: dest.id, mode: "api", action: "skip_late", detail };
      }
      let text: string;
      try {
        text = socialText("threads");
      } catch (e) {
        warnings.push(`threads_profile: ${(e as Error).message}`);
        return { destination: dest.id, mode: "api", action: "skip_invalid", detail: (e as Error).message };
      }
      const slot = slotOf.get(dest.id)!;
      const schedule = scheduleFor(slot);
      if (schedule.mode === "scheduled") {
        return {
          destination: dest.id,
          mode: "api",
          action: "pending_schedule",
          caption: text,
          scheduledAt: schedule.at,
          detail: `a Threads API não agenda — ${pendingRunner(slot.hhmm)}`,
        };
      }
      return { destination: dest.id, mode: "api", action: "publish", caption: text, scheduledAt: null };
    }
    if (dest.kind === "facebook_profile") {
      return {
        destination: dest.id,
        mode: "guided",
        action: "guided",
        caption: buildReelsCaption({ platform: "facebook", d1: d1In, follow: diariaFollowLine(dest.id, cfg.diariaProfiles), horizontalLink }), // #12465, #12735
        detail: "perfil pessoal: a Graph API não publica em perfil de pessoa — Chrome, ou compartilhar o Reels da página",
      };
    }
    if (dest.kind === "facebook_page") {
      const page = input.pages.find((p) => p.slug === dest.slug)!;
      if (page.missing.length) {
        warnings.push(`${dest.id}: sem credencial (${page.missing.join(", ")}) — rode scripts/facebook-page-token-setup.ts`);
        return { destination: dest.id, mode: "api", action: "skip_missing_credentials", detail: page.missing.join(", ") };
      }
      const schedule = scheduleFor(slotOf.get(dest.id)!);
      return {
        destination: dest.id,
        mode: "api",
        action: "publish",
        // #12465: a página VJ Pixel (não a diar.ia.br) leva o perfil da diar.ia.br.
        caption: buildReelsCaption({ platform: "facebook", d1: d1In, follow: diariaFollowLine(dest.id, cfg.diariaProfiles), horizontalLink }), // #12735
        scheduledAt: schedule.mode === "scheduled" ? schedule.at : null,
      };
    }
    // instagram
    if (instagramDelegated) {
      return { destination: dest.id, mode: "api", action: "skip_delegated", detail: INSTAGRAM_TIMER_DETAIL };
    }
    if (!igFit.fits) {
      // #10933: o horário vem da grade (o mesmo slot que os outros destinos já enxergaram).
      const slot = slotOf.get(dest.id);
      const hhmm = slot?.hhmm ?? timeFor(dest.id).hhmm;
      // #10915: o --publish gera a versão comprimida pro file_upload do Chrome (campo `upload` do item).
      // #11794: a rota à mão tem a mesma autoria da API (@diar.ia.br autora, @vjpixel em collab).
      const detail =
        `${igFit.reason} — poste pelo instagram.com no Chrome (Passo B3b do /diaria-publica, com o arquivo mirando 9,5 MB, abaixo do limite de 10 MB do file_upload, que o --publish gera em _internal/) ` +
        `ou no app, ${instagramChromeRouteText()}, às ${hhmm} BRT do dia da edição (slot reservado na grade, #10933), ` +
        `e registre com --confirm-instagram (lê a conta da @${INSTAGRAM_CHROME_ROUTE.authorUsername}; ou --url URL do Reel) ou --mark instagram=URL`;
      warnings.push(`instagram: ${detail}`);
      let caption: string | undefined;
      try {
        caption = buildReelsCaption({ platform: "instagram", d1: d1In, ctaVertical });
      } catch (e) {
        warnings.push(`instagram: ${(e as Error).message}`);
      }
      return { destination: dest.id, mode: "guided", action: "guided", ...(caption ? { caption } : {}), detail, at: slot?.at ?? timeFor(dest.id).at };
    }
    // Só quando o caller MEDIU e não conseguiu ler (null); ausente = não medido (testes, chamadas antigas).
    if (input.videoDurationSeconds === null && igMax !== null && input.video.exists && input.instagramReady) {
      warnings.push(`instagram: duração do vertical não lida do MP4 — sobe pela API sem conferir o teto de ~${igMax} s (#10893); se o rupload der ProcessingFailedError, poste à mão`);
    }
    for (const w of input.instagramWarnings ?? []) warnings.push(`instagram: ${w}`);
    if (!input.instagramReady) {
      warnings.push(`instagram: ${input.instagramNotReadyReason ?? "sem INSTAGRAM_BUSINESS_ACCOUNT_ID/INSTAGRAM_ACCESS_TOKEN"}`);
      return { destination: dest.id, mode: "api", action: "skip_missing_credentials", detail: input.instagramNotReadyReason ?? "INSTAGRAM_*" };
    }
    let caption: string;
    try {
      caption = buildReelsCaption({ platform: "instagram", d1: d1In, ctaVertical });
    } catch (e) {
      // Legenda grande demais só derruba o Instagram, não os outros destinos.
      warnings.push(`instagram: ${(e as Error).message}`);
      return { destination: dest.id, mode: "api", action: "skip_invalid", detail: (e as Error).message };
    }
    // #11355: na @diar.ia.br o Reels depende da URL pública. Sem R2 o publish não
    // chega a tentar: o timer alarma citando o R2 (`cause`), e a limpeza do
    // vertical não conta o destino como terminal (#11478).
    const publishOrBlocked = (text: string): ShortsPlanItem => {
      if (instagramReelUploadRoute(cfg.instagramAuthorPage) === "video_url" && input.publicVideo?.ready !== true) {
        const why = input.publicVideo?.ready === false ? (input.publicVideo.cause ?? input.publicVideo.reason) : "não conferido";
        const detail = `o Reels da @diar.ia.br sobe por URL pública (video_url, #11355), indisponível nesta rodada: ${why}`;
        warnings.push(`instagram: ${detail}`);
        return { destination: dest.id, mode: "api", action: "skip_missing_credentials", detail, cause: "public_video" };
      }
      return { destination: dest.id, mode: "api", action: "publish", caption: text, scheduledAt: null };
    };
    const slot = slotOf.get(dest.id)!;
    const schedule = scheduleFor(slot);
    if (instagramViaTimer) {
      // #11265: rodada do timer do 300. Antes do horário espera; até 3 h depois
      // publica (`video_url` na @diar.ia.br, #11355); depois disso não publica
      // sozinho fora do horário do teste (#10831), mesmo teto do linkedin_profile.
      if (schedule.mode === "scheduled") {
        return {
          destination: dest.id,
          mode: "api",
          action: "pending_schedule",
          caption,
          scheduledAt: schedule.at,
          detail: `o Instagram não agenda Reels pela API — o timer do 300 publica depois das ${slot.hhmm} BRT (ou use --now)`,
        };
      }
      const late = lateFor(dest.id);
      if (late) {
        const detail =
          `${late} — ${lateReason}, não publica sozinho. ` +
          `Publique à mão (Passo B3b) e registre com --confirm-instagram ou --mark instagram=URL, ou rode com --now para publicar mesmo assim`;
        warnings.push(`instagram: ${detail}`);
        return { destination: dest.id, mode: "api", action: "skip_late", detail };
      }
      return publishOrBlocked(caption);
    }
    if (schedule.mode === "scheduled") {
      // #10823: a fila do Worker publica no horário (o Instagram não agenda Reels pela API).
      if (input.instagramQueue?.ready) {
        return {
          destination: dest.id,
          mode: "api",
          action: "enqueue",
          caption,
          scheduledAt: schedule.at,
          igAccount: input.instagramQueue.account,
          idempotencyKey: shortsReelsIdempotencyKey(input.aammdd, input.instagramQueue.account),
        };
      }
      const why = input.instagramQueue ? ` Fila do Worker indisponível: ${input.instagramQueue.reason}.` : "";
      if (input.instagramQueue) warnings.push(`instagram: sem fila do Worker (${input.instagramQueue.reason}) — fica pendente até ${slot.hhmm} BRT`);
      return {
        destination: dest.id,
        mode: "api",
        action: "pending_schedule",
        caption,
        scheduledAt: schedule.at,
        detail: `o Instagram não agenda Reels pela API — ${pendingRunner(slot.hhmm)}.${why}`,
      };
    }
    return publishOrBlocked(caption);
  }

  // #11547: o que cada destino faz com a capa (Still) — ver scripts/lib/diaria/short-cover.ts.
  const coverCtx = {
    coverPath: input.coverPath ?? null,
    coverUploadReady: input.coverUploadReady === true,
    bufferOffsetMs: input.coverBufferOffsetMs ?? null,
    youtubeFirstFrameMs: cfg.youtubeFirstFrameCoverMs, // #12100 opção 2
  };
  const cover = { path: input.coverPath ?? null, destinations: Object.fromEntries(items.map((i) => [i.destination, planCoverDestination(i, coverCtx)])) };
  // #11986: delegar a um timer parado deixa os destinos sem sair por até 3 h, sem alarme do timer.
  if (corteTimer && input.corteTimerHeartbeat && corteTimerHeartbeatStale(input.corteTimerHeartbeat, input.now)) {
    const delegated = items
      .filter((i) => CORTE_TIMER_DESTINATIONS.includes(i.destination) && (i.action === "skip_delegated" || i.action === "pending_schedule"))
      .map((i) => i.destination);
    if (delegated.length) warnings.push(corteTimerStaleWarning(delegated, input.corteTimerHeartbeat, input.now));
  }
  // #11944: a regra de dono mora só em `ownersContextAfterPublish` (o recálculo depois do publish usa a mesma).
  const owners = assignShortsDestinationOwners(
    items,
    ownersContextAfterPublish({
      aammdd: input.aammdd,
      now: input.now,
      instagramBackend: cfg.instagramBackend,
      corteViaTimer: cfg.corteViaTimer,
      ...(input.writer !== undefined ? { writer: input.writer } : {}),
      ...(corte ? { corteSlug: corte.slug } : {}),
      ...(corteOutside ? { corteOutsideDir: corteOutside.dir } : {}),
      ...(!corte && input.editionDirOverride !== undefined ? { editionDirOverride: input.editionDirOverride } : {}),
    }),
  );
  const destinationTimes = Object.fromEntries(destinations.map((d) => [d.id, timeFor(d.id)]));
  // #12735: o dry-run mostra, por destino, o link do horizontal que o vertical usa.
  const horizontalLinks = corte ? undefined : planShortHorizontalLinks(destinations.map((d) => d.id), horizontalLink, input.horizontalVideo?.noVideo ?? false, input.aammdd);
  // #13209: o aviso de horizontal ausente segue a FALA (o vídeo promete o
  // completo); a linha da bio e a resposta do Threads seguem a linha resolvida.
  if (horizontalLinks && ctaFala && !horizontalLink) {
    for (const id of Object.keys(horizontalLinks)) warnings.push(`${id}: roteiro com cta_vertical, mas falta horizontal desta edição (${D1_VIDEO_URL_FILE}); confira também o vídeo relacionado do Short (#13117)`);
  }
  // #13709: sem link da bio. Instagram leva o link por edição no 1º comentário,
  // Threads numa resposta ao próprio post, TikTok a chamada sem link.
  if (horizontalLinks && ctaVertical) {
    for (const [id, h] of Object.entries(horizontalLinks)) {
      if (h.route === "none") {
        h.note += `; chamada sem link: ${TIKTOK_NO_BIO_CTA_LINE} (#13274)`;
      } else if (h.route === "comment" && h.link) {
        h.commentText = verticalEditionLinkText(h.link);
        h.note += `; legenda: ${VERTICAL_COMMENT_CTA_LINE}; 1º comentário: ${h.commentText}`;
        // O comentário sai pelo publish da API (timer do 300 ou rodada com --now). Fila do Worker
        // (o Worker recusa first_comment com REELS) e rota à mão não comentam: passo do editor.
        const ig = items.find((i) => i.destination === id);
        if (ig && (ig.action === "enqueue" || ig.action === "guided")) {
          warnings.push(`${id}: o 1º comentário NÃO sai sozinho nesta rota (${ig.action === "enqueue" ? "fila do Worker, que não comenta Reels" : "postagem à mão"}). Depois do Reels no ar, comente: ${h.commentText} (#13709)`);
        }
      } else if (h.route === "reply" && h.link) {
        h.replyText = verticalEditionLinkText(h.link);
        h.note += `; legenda: ${VERTICAL_REPLY_CTA_LINE}; resposta ao próprio post: ${h.replyText}`;
      }
    }
  }
  if (horizontalLinks) {
    // Prefixo próprio: premissas que começam com `{destino}:` são as de horário (testes do #10772/#10907 as distinguem assim).
    for (const [id, h] of Object.entries(horizontalLinks)) premises.push(`caminho até o horizontal (${id}): ${h.route}${h.link ? ` ${h.link}` : ""} — ${h.note} (#12735)`);
  }
  // #12786: destino com link na legenda saindo antes do horizontal fica sem o link.
  const noHorizontalLink = missingHorizontalLinkWarning(input.aammdd, horizontalLinks, items, input.horizontalVideo?.noVideo ?? false);
  if (noHorizontalLink) warnings.push(noHorizontalLink);
  return {
    aammdd: input.aammdd, editionUrl, video: input.video, cover, longVideo: youtubeVideoFileName(input.aammdd), youtube, shortTime, destinationTimes, slots, items, owners,
    ...(horizontalLinks ? { horizontalLinks } : {}),
    premises, warnings,
  };
}

/**
 * Pure (#11265): slot do Instagram com o timer do 300 — o horário do vertical,
 * sem passar pela grade (ver o comentário em `planShortsPublish`).
 */
export function instagramTimerSlot(dest: ShortDestination, cfg: ShortsConfig, hhmm: string, at: string): ShortSlot {
  const account = shortDestinationAccount(dest, cfg);
  if (!account) throw new Error(`instagramTimerSlot: ${dest.id} sem conta na grade`);
  const also = shortDestinationAlsoAccounts(dest, cfg);
  return {
    destination: dest.id,
    account,
    ...(also.length ? { alsoAccounts: also } : {}),
    at: new Date(Date.parse(at)).toISOString(),
    hhmm,
    rule: "timer-300",
    premise: "timer do 300: sempre no horário do vertical, fora da grade (#11265)",
  };
}
