/**
 * Instagram: etapas do Reels no laço do `--publish` (#14204) — a fila do
 * Worker (`enqueue`) e a publicação pela API, com o gate da conta do timer e
 * do corte (#11265/#11795).
 *
 * Extraídas de `mainUnlocked` (`run.ts`) sem mudar a lógica. Módulo próprio e
 * não `instagram.ts` porque o gate usa `confirm.ts` e `instagram-confirm.ts`,
 * que importam `instagram.ts` (o ciclo ficaria entre os três).
 */
import { corteBaseCommand, corteR2Key } from "../lib/diaria/short-corte.ts";
import { INSTAGRAM_CHROME_ROUTE, type ShortPublishedEntry } from "../lib/diaria/short-video.ts";
import { r2ObjectHasBody, r2PublicUrl } from "../lib/r2-object-upload.ts";
import { postToWorkerQueue } from "../lib/worker-queue-client.ts";
import {
  corteInstagramConfirmContext,
  instagramAccountGateApplies,
  instagramConfirmContext as instagramConfirmContextReal,
  sameDayOtherRegisteredIds as sameDayOtherRegisteredIdsReal,
} from "./confirm.ts";
import { defaultGraphDeps, type PublishOutcome } from "./facebook.ts";
import {
  type InstagramConfirmDecision,
  type InstagramTimerAlreadyMatch,
  decideInstagramTimerAcrossAccounts,
  instagramConfirmExpectedCollabs,
  instagramTimerAlreadyCollabWarnings as instagramTimerAlreadyCollabWarningsReal,
  instagramTimerBeforePublish,
  instagramTimerGate,
  instagramTimerPublishStep,
  readAndDecideInstagramConfirm as readAndDecideInstagramConfirmReal,
  resolveChromeAuthorReader as resolveChromeAuthorReaderReal,
  timerChromeAuthorDeps,
} from "./instagram-confirm.ts";
import {
  type InstagramEnqueueDeps,
  enqueueInstagramReel,
  instagramPublishRecheck as instagramPublishRecheckReal,
  instagramReelRouteChoice,
  instagramReelVideoUrl,
  publishInstagramReel as publishInstagramReelReal,
  resolveInstagramReelInputs as resolveInstagramReelInputsReal,
} from "./instagram.ts";
import {
  type ShortsEnqueueItem,
  type ShortsInstagramQueueSendContext,
  type ShortsInstagramReelSendContext,
  type ShortsPublishItem,
  type ShortsSendStep,
  shortsResult,
} from "./send-context.ts";

/**
 * #14204: etapa do Reels com horário futuro na fila do Worker (#10823). A
 * capa e o vídeo sobem ao R2 pelas funções da rodada (memo por chave).
 */
export async function sendInstagramQueueItem(
  ctx: ShortsInstagramQueueSendContext,
  item: ShortsEnqueueItem,
  enqueue: InstagramEnqueueDeps["enqueue"] = (payload) => postToWorkerQueue(ctx.workerUrl, ctx.workerToken, payload, 2, "publish-shorts"),
): Promise<ShortsSendStep> {
  const outcome: PublishOutcome = await enqueueInstagramReel(
    {
      uploadVideo: ctx.uploadVideo,
      uploadCover: ctx.uploadCover,
      enqueue,
      now: () => new Date(),
    },
    item,
    ctx.shortsCfg.instagramCollaborators,
  );
  return { kind: "outcome", outcome };
}

/** #14204: I/O da etapa do Reels pela API (rede da Graph, R2 e o registro em disco), trocável nos testes. */
export interface InstagramReelSendDeps {
  publishInstagramReel: typeof publishInstagramReelReal;
  resolveInstagramReelInputs: typeof resolveInstagramReelInputsReal;
  instagramPublishRecheck: typeof instagramPublishRecheckReal;
  instagramConfirmContext: typeof instagramConfirmContextReal;
  sameDayOtherRegisteredIds: typeof sameDayOtherRegisteredIdsReal;
  resolveChromeAuthorReader: typeof resolveChromeAuthorReaderReal;
  readAndDecideInstagramConfirm: typeof readAndDecideInstagramConfirmReal;
  instagramTimerAlreadyCollabWarnings: typeof instagramTimerAlreadyCollabWarningsReal;
}

export const defaultInstagramReelSendDeps: InstagramReelSendDeps = {
  publishInstagramReel: publishInstagramReelReal,
  resolveInstagramReelInputs: resolveInstagramReelInputsReal,
  instagramPublishRecheck: instagramPublishRecheckReal,
  instagramConfirmContext: instagramConfirmContextReal,
  sameDayOtherRegisteredIds: sameDayOtherRegisteredIdsReal,
  resolveChromeAuthorReader: resolveChromeAuthorReaderReal,
  readAndDecideInstagramConfirm: readAndDecideInstagramConfirmReal,
  instagramTimerAlreadyCollabWarnings: instagramTimerAlreadyCollabWarningsReal,
};

/**
 * #14204: etapa do Reels pela API (Graph). No timer do Instagram e no corte
 * avulso (`instagramAccountGateApplies`) o gate confere a conta antes e de
 * novo logo antes do `media_publish`: Reels achado no ar é registrado e não
 * sai de novo (`settled`). Fora deles, publica com a releitura do registro
 * local. Sem autora pronta lança (o plano não marca `publish` sem ela).
 * `ioDeps` troca a rede e o disco nos testes (o default é o I/O real).
 */
export async function sendInstagramReelItem(
  ctx: ShortsInstagramReelSendContext,
  item: ShortsPublishItem,
  ioDeps: InstagramReelSendDeps = defaultInstagramReelSendDeps,
): Promise<ShortsSendStep> {
  // Mesmos nomes das funções importadas: o corpo segue igual ao do laço inline (e aos guards estáticos).
  const {
    publishInstagramReel,
    resolveInstagramReelInputs,
    instagramPublishRecheck,
    instagramConfirmContext,
    sameDayOtherRegisteredIds,
    resolveChromeAuthorReader,
    readAndDecideInstagramConfirm,
    instagramTimerAlreadyCollabWarnings,
  } = ioDeps;
  const { igAuthor, shortsCfg, aammdd, videoPath, file, corte, r2, dir, deps, igApiVersion } = ctx;
  if (!igAuthor.ready) throw new Error(igAuthor.reason); // o plano não marca publish sem autora pronta
  const author = igAuthor;
  const publishReel = async (
    accountGate?: () => ReturnType<typeof instagramTimerGate>,
    onRecheckAlready?: (hit: { entry: ShortPublishedEntry; matchedBy: InstagramTimerAlreadyMatch }) => void, // #11870
  ) => {
    const choice = instagramReelRouteChoice({
      authorPage: shortsCfg.instagramAuthorPage,
      aammdd,
      videoPath,
      file,
      ...(corte ? { corteVideoKey: corteR2Key(corte.slug, "video") } : {}),
    });
    const { source, cover } = await resolveInstagramReelInputs({
      route: choice.route,
      file,
      uploadCover: ctx.uploadCover,
      uploadVideo: async () => {
        if (choice.route !== "video_url") throw new Error("a rota rupload não usa o R2");
        return instagramReelVideoUrl(choice, {
          urlIfSameContent: async (key) => {
            if (!r2.ready) return null;
            const same = await r2ObjectHasBody({ fetch: (u, i) => fetch(u, i), now: () => new Date() }, r2.config, key, file);
            if (same) {
              ctx.r2KeysInUse.add(key); // #11774: o reaproveitado também fica fora da poda
              console.error(`[ok] corte do Instagram igual ao vertical genérico: reaproveita ${key}`);
            }
            return same ? r2PublicUrl(r2.config, key) : null;
          },
          upload: ctx.uploadVideoAt,
        });
      },
    });
    const localRecheck = instagramPublishRecheck(dir, aammdd, (fresh) => {
      ctx.registry.replace(fresh);
    });
    const beforePublish = accountGate ? instagramTimerBeforePublish({ local: localRecheck, gate: accountGate, onAlready: onRecheckAlready }) : localRecheck;
    return publishInstagramReel(deps, author.igUserId, author.token, igApiVersion, source, item.caption, shortsCfg.instagramCollaborators, cover, {
      beforePublish,
      firstComment: ctx.plan.horizontalLinks?.instagram?.commentText ?? null, // #13709
    });
  };
  if (!instagramAccountGateApplies(ctx.writer, corte !== null)) {
    return { kind: "outcome", outcome: await publishReel() }; // sem gate da conta fora do timer e do corte (o registro local segue valendo)
  }
  // #11265: o timer confere a conta antes — um Share feito por fora sem
  // --confirm-instagram não está no registro, mas está no /media.
  // #11795: o corte avulso também (o Reels do corte postado à mão), com o
  // título e o gancho do corte e sem contar o Reels da edição do dia.
  const ctxConfirm = corte ? corteInstagramConfirmContext(corte) : instagramConfirmContext(dir, aammdd, ctx.config, ctx.editionUrlArg);
  // #11913: na edição, o Reels dos cortes do dia (a extra) também não conta.
  const ignoreIds = sameDayOtherRegisteredIds(corte?.slug ?? null, aammdd, "instagram");
  // Fix do review do PR #11395: o gate olha também o perfil do autor à mão, se for outra conta (#11794: na produção, é a mesma).
  const chrome = await resolveChromeAuthorReader(shortsCfg.instagramAuthorPage, ctx.pages, igApiVersion);
  // #11421: sem a credencial da página do autor, o gate não publica (fail-closed) se a conta da API não tiver o Reels.
  // #11427: leitura que falhou com a credencial presente vira `read-failed` (nova tentativa), não `author-unchecked`.
  if (!chrome.reader && !chrome.sameAccount) console.error(`[aviso] instagram: perfil do @${INSTAGRAM_CHROME_ROUTE.authorUsername} não consultável (${chrome.unavailable ?? "sem motivo"})${chrome.readFailed ? " — leitura falhou; o timer não publica pela API sem conferir e tenta de novo na próxima rodada" : " — o timer não publica pela API sem conferir"}`);
  const readFor = (igUserId: string, token: string) => () =>
    readAndDecideInstagramConfirm(defaultGraphDeps, {
      igUserId,
      token,
      apiVersion: igApiVersion,
      published: ctx.registry.current(),
      sinceIso: ctxConfirm.sinceIso,
      markers: ctxConfirm.markers,
      nowIso: new Date().toISOString(),
      expectedAtIso: ctxConfirm.expectedAtIso,
      ignoreIds,
    });
  // #11828: em qual conta o gate achou o Reels (e com que token reler os collabs).
  let foundIn: { account: "primary" | "chrome-author"; token: string } = { account: "primary", token: author.token };
  const tagged = (account: "primary" | "chrome-author", token: string, read: () => Promise<InstagramConfirmDecision>) => async () => {
    const d = await read();
    if (d.kind === "register") foundIn = { account, token };
    return d;
  };
  const accountGate = () =>
    instagramTimerGate({
      decide: () =>
        decideInstagramTimerAcrossAccounts({
          primary: tagged("primary", author.token, readFor(author.igUserId, author.token)),
          ...timerChromeAuthorDeps(chrome, (igUserId, token) => tagged("chrome-author", token, readFor(igUserId, token))),
        }),
      persist: (entry) => {
        ctx.registry.persist(entry);
      },
      ...(corte ? { registerHint: () => `${corteBaseCommand(corte.slug, ctx.corteOutside?.dir)} --mark instagram=URL` } : {}),
    });
  // #11870: o gate re-rodado antes do media_publish também pode achar o Reels; guarda o matchedBy dele.
  const recheck: { hit: { entry: ShortPublishedEntry; matchedBy: InstagramTimerAlreadyMatch } | null } = { hit: null };
  const step = await instagramTimerPublishStep({
    gate: accountGate,
    // #11774: o mesmo gate roda de novo logo antes do media_publish.
    publish: () =>
      publishReel(accountGate, (hit) => {
        recheck.hit = hit;
      }),
  });
  const already =
    step.kind === "already"
      ? { entry: step.entry, matchedBy: step.matchedBy, when: "" }
      : step.outcome.alreadyRegistered && recheck.hit
        ? { entry: recheck.hit.entry, matchedBy: recheck.hit.matchedBy, when: " na reconferência antes do publish" }
        : null;
  if (already) {
    // #14327: o laço apaga o marcador de envio (`marker: "clear"`): o gate já registrou o Reels.
    // #11828/#11870: o Reels feito à mão pode ter saído sem o convite da @vjpixel; avisa sem bloquear o registro.
    const collabWarnings = await instagramTimerAlreadyCollabWarnings(deps, {
      matchedBy: already.matchedBy,
      mediaId: already.entry.id,
      token: foundIn.token,
      apiVersion: igApiVersion,
      expected: instagramConfirmExpectedCollabs({ account: foundIn.account, sameAccount: chrome.sameAccount === true, configCollaborators: shortsCfg.instagramCollaborators }),
    });
    console.error(`[aviso] instagram: o Reels da edição já está na conta${already.when} (${already.matchedBy}, ${already.entry.url ?? already.entry.id}) — registrado, não publica de novo`);
    for (const w of collabWarnings) console.error(`[aviso] instagram: ${w}`);
    return {
      kind: "settled",
      marker: "clear",
      result: shortsResult.already(item.destination, already.entry, { matchedBy: already.matchedBy, ...(collabWarnings.length ? { warnings: collabWarnings } : {}) }),
    };
  }
  // Inalcançável: `already` acima cobre `step.kind === "already"`. Lança em vez de sumir com o destino do results[].
  if (step.kind !== "published") throw new Error("instagram: passo do timer sem desfecho (nem publicado, nem já na conta)");
  return { kind: "outcome", outcome: step.outcome };
}
