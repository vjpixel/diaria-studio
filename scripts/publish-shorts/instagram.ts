/**
 * Reels do Instagram: autora, fonte do vídeo (R2/binário), publicação, 1º comentário, colaboradores, upload pelo Chrome e fila do Worker.
 *
 * Parte de `scripts/publish-shorts.ts` (#14054): movido sem mudar a lógica; a entrada
 * reexporta o que os testes e os outros scripts importam.
 */
import { initialFirstCommentPending } from "../lib/diaria/instagram-first-comment-retry.ts";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeFileAtomic } from "../lib/atomic-write.ts";
import type { ResolvedFacebookPage } from "../lib/facebook-pages.ts";
import {
  INSTAGRAM_ENV_ACCOUNT_KEY,
  instagramReelUploadRoute,
  shortInstagramVideoFileName,
  type InstagramReelUploadRoute,
  isDestinationDone,
  shortVideoFileName,
  type ShortPublishedEntry,
  type ShortsConfig,
  type ShortsPublishedFile,
  type WorkerInstagramAccount,
} from "../lib/diaria/short-video.ts";
import { readShortsRegistry } from "../lib/diaria/shorts-published-store.ts";
import { buildReelsQueuePayload, WorkerQueueError, type WorkerQueuePayload } from "../lib/worker-queue-client.ts";
import { resolveWorkerQueueState } from "../lib/publish-state.ts";
import { withCoverRecord, type ShortCoverRecord } from "../lib/diaria/short-cover.ts";
import {
  CHROME_UPLOAD_MAX_BYTES,
  buildChromeUploadFfmpegPasses,
  chromeUploadBitrate,
  chromeUploadFileName,
  chromeUploadReusable,
  chromeUploadSidecarPath,
  fitsChromeUpload,
  type ChromeUploadResult,
  type ChromeUploadSidecar,
} from "../lib/diaria/instagram-chrome-upload.ts";
import { RUPLOAD, type ShortsPlanItem, type InstagramQueueReadiness } from "./_shared.ts";
import {
  type GraphDeps,
  GraphResponseError,
  isGraphAuthError,
  graphPost,
  graphGet,
  ruploadBinary,
  type PublishOutcome,
  mediaPublishFailureIsDefinitive,
} from "./facebook.ts";
import { recheckBeforePublish } from "./run-checks.ts";

/**
 * #10906 — chave idempotente do Reels na fila do Worker: um por edição e conta.
 * O retry do `postToWorkerQueue` (resposta perdida depois do commit) e uma
 * rodada repetida no mesmo horário caem na mesma entry, nunca numa 2ª que
 * publicaria o mesmo Reels de novo.
 */
/**
 * Capa do Reel é opcional: erro no upload vira aviso e o Reel sai com o frame
 * automático, nunca derruba a publicação (review #11545).
 */
export async function uploadCoverOrFallback(
  upload: () => Promise<string>,
  log: (line: string) => void,
): Promise<ReelCoverUpload> {
  try {
    return await upload();
  } catch (e) {
    const error = `capa não enviada ao R2: ${(e as Error).message}`;
    log(`[aviso] ${error}; o Reel segue com o frame automático`);
    // #11679 item 1: a falha volta como valor, e não `undefined`, para o registro gravar `cover.ok: false`.
    return { error };
  }
}

/**
 * Resultado do upload da capa do Reel (#11679): a URL pública, a falha do
 * upload (o Reel sai com o frame automático e o registro diz que a capa não
 * foi) ou `undefined` (rodada sem capa a enviar).
 */
export type ReelCoverUpload = string | { error: string } | undefined;

/** Pure (#11679): URL que vai no `cover_url` do Reel; falha ou ausência = frame automático. */
export function reelCoverUrl(cover: ReelCoverUpload): string | undefined {
  return typeof cover === "string" ? cover : undefined;
}

/** Pure (#11547/#11679): registro da capa do Reel — `ok: false` com o erro quando o upload falhou. */
export function reelCoverRecord(cover: ReelCoverUpload): ShortCoverRecord | null {
  if (typeof cover === "string") return { method: "cover_url", ok: true };
  if (cover) return { method: "cover_url", ok: false, error: cover.error };
  return null;
}

export function shortsReelsIdempotencyKey(aammdd: string, account: WorkerInstagramAccount): string {
  return `shorts-instagram-${aammdd}-${account}`;
}

/**
 * Pure (#10823): a fila do Worker consegue agendar o Reels desta autora? Precisa
 * do Worker (URL + token), do R2 pro `video_url` público e de uma autora que o
 * Worker conhece: `instagram_author_page` null = conta da diar.ia.br
 * (`diaria`); `vjpixel` = a conta vinculada à página VJ pixel (secrets
 * `INSTAGRAM_VJPIXEL_*` no Worker). Qualquer outra página não tem credencial
 * no Worker.
 */
export function resolveInstagramQueueReadiness(input: {
  authorPage: string | null;
  workerUrl: string;
  workerToken: string;
  r2Missing: string[];
}): InstagramQueueReadiness {
  const account: WorkerInstagramAccount | null = input.authorPage === null ? INSTAGRAM_ENV_ACCOUNT_KEY : input.authorPage === "vjpixel" ? "vjpixel" : null;
  if (!account) return { ready: false, reason: `o Worker só publica nas contas diaria e vjpixel, não na da página ${input.authorPage}` };
  const missing = [
    ...(input.workerUrl ? [] : ["DIARIA_LINKEDIN_CRON_URL"]),
    ...(input.workerToken ? [] : ["DIARIA_LINKEDIN_CRON_TOKEN"]),
    ...input.r2Missing,
  ];
  if (missing.length) return { ready: false, reason: `falta ${missing.join(", ")}` };
  return { ready: true, account };
}

/**
 * Pure (#10820): esta rodada precisa resolver a autora do Instagram? Não quando
 * o Instagram está desligado, fora do `--only`, ou já registrado (skip_done) —
 * aí a resolução seria só uma chamada à Graph (e um aviso) à toa.
 */
export function wantsInstagram(cfg: Pick<ShortsConfig, "instagram">, only: string[] | null, published: ShortsPublishedFile): boolean {
  if (!cfg.instagram) return false;
  if (only && only.length && !only.includes("instagram")) return false;
  return !isDestinationDone(published, "instagram");
}

/** Autora do Reels no Instagram, resolvida pra uma conta + token (#10790). */
export type InstagramAuthor =
  | { ready: true; igUserId: string; token: string; username: string | null; source: string; warnings?: string[] }
  /**
   * `readFailed` (#11427): a credencial existe, mas a leitura da conta vinculada
   * na Graph falhou (5xx, rede) — falha transitória, não credencial ausente.
   */
  | { ready: false; reason: string; readFailed?: true };

/** Escopo que o token da página precisa pra publicar no Instagram vinculado. */
export const INSTAGRAM_PUBLISH_SCOPE = "instagram_content_publish";

/**
 * Escopos do token via `debug_token` (#10820). `error` = não deu pra conferir
 * (erro da Graph ou resposta sem `scopes`): o caller avisa e segue, porque
 * recusar aí bloquearia um token válido por falha de leitura.
 */
async function readTokenScopes(deps: Pick<GraphDeps, "fetch">, token: string, apiVersion: string): Promise<{ scopes: string[] } | { error: string }> {
  try {
    const json = await graphGet(deps as GraphDeps, "debug_token", { input_token: token, access_token: token }, apiVersion);
    const scopes = json?.data?.scopes;
    if (!Array.isArray(scopes)) return { error: "debug_token sem lista de escopos" };
    return { scopes: scopes.filter((x: unknown): x is string => typeof x === "string") };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * Resolve a conta do Instagram que publica o Reels (faz um GET na Graph, inclusive no
 * dry-run). Com `authorPage`, é a conta
 * VINCULADA a essa página do Facebook, usando o token da página (precisa de
 * `instagram_content_publish`). Sem vínculo ou sem token → não pronto, com o
 * passo que destrava: nunca cai em silêncio na conta da diar.ia.br.
 */
export async function resolveInstagramAuthor(
  deps: Pick<GraphDeps, "fetch">,
  authorPage: string | null,
  pages: ResolvedFacebookPage[],
  apiVersion: string,
  envAccount: { igUserId: string; token: string },
  /** #11390: `readOnly` = só lê a conta (o `--confirm-instagram` no perfil do autor); não exige o escopo de publicação. */
  opts: { readOnly?: boolean } = {},
): Promise<InstagramAuthor> {
  if (authorPage === null) {
    if (!envAccount.igUserId || !envAccount.token) return { ready: false, reason: "sem INSTAGRAM_BUSINESS_ACCOUNT_ID/INSTAGRAM_ACCESS_TOKEN" };
    return { ready: true, igUserId: envAccount.igUserId, token: envAccount.token, username: null, source: "conta da diar.ia.br (env)" };
  }
  const page = pages.find((p) => p.slug === authorPage);
  if (!page) return { ready: false, reason: `instagram_author_page "${authorPage}" não existe em publishing.social.facebook.pages` };
  if (page.missing.length || !page.token || !page.pageId) {
    return { ready: false, reason: `página ${authorPage} sem credencial (${page.missing.join(", ")}) — rode scripts/facebook-page-token-setup.ts --pages ${authorPage}` };
  }
  let json: any;
  try {
    json = await graphGet(deps as GraphDeps, page.pageId, { fields: "instagram_business_account{id,username}", access_token: page.token }, apiVersion);
  } catch (e) {
    return { ready: false, reason: `não foi possível ler a conta do Instagram vinculada à página ${authorPage}: ${(e as Error).message}`, readFailed: true };
  }
  const ig = json?.instagram_business_account;
  if (!ig?.id) {
    return {
      ready: false,
      reason:
        `nenhuma conta do Instagram vinculada à página ${authorPage} — torne a conta pessoal profissional (criador), ` +
        `vincule-a à página no Facebook e gere de novo o token da página com instagram_content_publish ` +
        `(scripts/facebook-page-token-setup.ts --pages ${authorPage})`,
    };
  }
  if (opts.readOnly) return { ready: true, igUserId: ig.id, token: page.token, username: ig.username ?? null, source: `conta vinculada à página ${authorPage}` };
  // #10820: ler a conta vinculada não prova que o token PUBLICA — sem o escopo, a falha só apareceria no --publish.
  const scopeCheck = await readTokenScopes(deps, page.token, apiVersion);
  const warnings: string[] = [];
  if ("scopes" in scopeCheck) {
    if (!scopeCheck.scopes.includes(INSTAGRAM_PUBLISH_SCOPE)) {
      return {
        ready: false,
        reason:
          `o token da página ${authorPage} lê a conta vinculada mas não tem o escopo ${INSTAGRAM_PUBLISH_SCOPE} — ` +
          `gere de novo com esse escopo (scripts/facebook-page-token-setup.ts --pages ${authorPage})`,
      };
    }
  } else {
    warnings.push(`não deu pra conferir se o token da página ${authorPage} tem ${INSTAGRAM_PUBLISH_SCOPE} (${scopeCheck.error}) — a falha, se houver, aparece no --publish`);
  }
  return {
    ready: true,
    igUserId: ig.id,
    token: page.token,
    username: ig.username ?? null,
    source: `conta vinculada à página ${authorPage}`,
    ...(warnings.length ? { warnings } : {}),
  };
}

/** #11355: como o Reels chega à Meta: bytes pelo rupload ou URL pública que ela baixa. */
export type InstagramReelSource = Buffer | { videoUrl: string };

/**
 * #11355: chave do vertical no R2 para o Reels. O arquivo genérico divide o
 * objeto com X e Threads; o corte próprio do Instagram (o timer passa `--video`
 * com ele) tem chave própria, senão o PUT trocaria o vídeo que a Buffer ainda
 * vai baixar pro X. A chave do corte leva o hash do conteúdo: trocado o corte no
 * Drive, a URL muda e nenhum cache serve o vídeo velho para a Meta.
 */
export function instagramR2VideoKey(aammdd: string, videoPath: string, file: Buffer): string {
  const generic = shortVideoFileName(aammdd);
  if (basename(videoPath) === generic) return `shorts/${generic}`;
  const hash = createHash("sha256").update(file).digest("hex").slice(0, 12);
  return `shorts/${shortInstagramVideoFileName(aammdd).replace(/\.mp4$/, "")}-${hash}.mp4`;
}

/** #11355: a rota do Reels nesta rodada e, na `video_url`, onde o vídeo fica no R2. */
export type InstagramReelRouteChoice =
  | { route: "rupload" }
  /** `genericKey`: objeto do vertical genérico, que serve se o corte for idêntico a ele; null quando `key` já é ele. */
  | { route: "video_url"; key: string; genericKey: string | null };

/** Pure (#11355): a ligação entre a autora, o arquivo e a rota, fora do `main()` para ter teste. */
export function instagramReelRouteChoice(input: {
  authorPage: string | null;
  aammdd: string;
  videoPath: string;
  file: Buffer;
  /** #11795: corte avulso — o Reels usa o mesmo objeto do corte que X e Threads (`corteR2Key`), nunca a chave da edição. */
  corteVideoKey?: string;
}): InstagramReelRouteChoice {
  if (instagramReelUploadRoute(input.authorPage) === "rupload") return { route: "rupload" };
  if (input.corteVideoKey) return { route: "video_url", key: input.corteVideoKey, genericKey: null };
  const key = instagramR2VideoKey(input.aammdd, input.videoPath, input.file);
  const generic = `shorts/${shortVideoFileName(input.aammdd)}`;
  return { route: "video_url", key, genericKey: key === generic ? null : generic };
}

/**
 * #11355: URL do vídeo do Reels. Corte idêntico ao vertical genérico já no
 * bucket reaproveita aquele objeto, sem duplicar o conteúdo em duas chaves.
 */
export async function instagramReelVideoUrl(
  choice: Extract<InstagramReelRouteChoice, { route: "video_url" }>,
  deps: { urlIfSameContent: (key: string) => Promise<string | null>; upload: (key: string) => Promise<string> },
): Promise<string> {
  const reused = choice.genericKey ? await deps.urlIfSameContent(choice.genericKey) : null;
  return reused ?? deps.upload(choice.key);
}

/**
 * #11355: reconferência do registro logo antes do `media_publish`, sem custo de
 * rede (o processamento leva até 72 s, e o `--mark` ou `--confirm-instagram` de
 * outro processo pode ter entrado nesse meio tempo). Registro ilegível lança.
 */
export function instagramPublishRecheck(
  dir: string,
  aammdd: string,
  onFresh: (fresh: ShortsPublishedFile) => void,
  read: (dir: string, aammdd: string) => ShortsPublishedFile = readShortsRegistry,
): () => ShortPublishedEntry | null {
  return () => {
    const recheck = recheckBeforePublish(dir, aammdd, "instagram", read);
    if (recheck.kind === "unreadable") throw new Error(recheck.error);
    if (recheck.kind === "proceed") return null;
    onFresh(recheck.fresh);
    return recheck.entry;
  };
}

/**
 * #11355 (porta `containerWasPublished` do Worker, #10877): o que o container diz
 * depois de uma falha no `media_publish`. Timeout ou 5xx não provam que o Reels
 * não saiu. `unknown` = a consulta falhou ou não trouxe o estado.
 */
async function instagramContainerPublishState(deps: GraphDeps, containerId: string, token: string, apiVersion: string): Promise<"published" | "finished" | "not_published" | "unknown"> {
  try {
    const code = (await graphGet(deps, containerId, { fields: "status_code", access_token: token }, apiVersion)).status_code;
    if (typeof code !== "string" || !code) return "unknown";
    if (code === "FINISHED") return "finished"; // #11774: pronto, e o publish pode estar em andamento
    return code === "PUBLISHED" ? "published" : "not_published";
  } catch {
    return "unknown";
  }
}

/**
 * #11355: fonte e capa do Reels, pela rota da autora. Na rota `video_url` a capa
 * sobe ANTES do vídeo: o upload da capa roda a poda de retenção de `shorts/`
 * (#10923), que apagaria um vertical mais velho que 7 dias reaproveitado antes
 * dela. Nesta ordem, o HEAD do vídeo vê o 404 da poda e sobe de novo. Falha no
 * upload do vídeo lança antes de qualquer container.
 */
export async function resolveInstagramReelInputs(input: {
  route: InstagramReelUploadRoute;
  file: Buffer;
  uploadCover: () => Promise<ReelCoverUpload>;
  uploadVideo: () => Promise<string>;
}): Promise<{ source: InstagramReelSource; cover: ReelCoverUpload }> {
  const cover = await input.uploadCover();
  if (input.route === "rupload") return { source: input.file, cover };
  return { source: { videoUrl: await input.uploadVideo() }, cover };
}

/**
 * Reels no Instagram → espera FINISHED → media_publish. Duas rotas de container
 * (#11355): `video_url` (a Meta baixa e processa sem o prazo de uma requisição,
 * mesmos parâmetros de `fireInstagramReels` no Worker) ou resumable + rupload.
 * O poll de até 10 min cobre o pior caso medido na `video_url`, 72 s.
 */
export async function publishInstagramReel(
  deps: GraphDeps,
  igUserId: string,
  token: string,
  apiVersion: string,
  source: InstagramReelSource,
  caption: string,
  collaborators: string[] = [],
  cover?: ReelCoverUpload,
  /**
   * `beforePublish`: devolve o registro de outro processo (não publica) ou null; lançar também não publica.
   * `firstComment` (#13709): texto do 1º comentário com o link por edição, postado logo depois do
   * `media_publish` (fail-soft: o Reels já saiu; falha vira aviso e `first_comment_pending` na entrada,
   * que o timer do Instagram retenta, #13759; nunca republica).
   */
  opts: { beforePublish?: () => ShortPublishedEntry | null | Promise<ShortPublishedEntry | null>; firstComment?: string | null } = {},
): Promise<PublishOutcome> {
  const coverUrl = reelCoverUrl(cover);
  const file = Buffer.isBuffer(source) ? source : null;
  const params: Record<string, string> = {
    media_type: "REELS",
    ...(Buffer.isBuffer(source) ? { upload_type: "resumable" } : { video_url: source.videoUrl }),
    caption,
    share_to_feed: "true",
    access_token: token,
  };
  // #10790: collab — a Graph API recebe a lista como JSON; cada conta aceita o convite no app.
  if (coverUrl) params.cover_url = coverUrl;
  if (collaborators.length) params.collaborators = JSON.stringify(collaborators);
  const container = await graphPost(deps, `${igUserId}/media`, params, apiVersion);
  const containerId: string = container.id;
  if (!containerId) throw new Error(`media (REELS) sem id: ${JSON.stringify(container)}`);
  if (file) {
    try {
      await ruploadBinary(deps, container.uri ?? `${RUPLOAD}/ig-api-upload/${apiVersion}/${containerId}`, token, file);
    } catch (e) {
      const msg = (e as Error).message;
      // #10893: é assim que o teto de duração aparece — o rupload aceita os bytes e recusa no processamento.
      if (/ProcessingFailedError/.test(msg)) {
        throw new Error(
          `${msg} — padrão do teto de duração do Reels pela API (#10893); poste pelo instagram.com no Chrome (Passo B3b do /diaria-publica) ou no app ` +
            `e registre com --confirm-instagram (lê a mídia pela API) ou --mark instagram=URL ` +
            `(ajuste o teto desta conta em publishing.shorts.instagram_api_max_seconds_by_account se ele mudou, #10916)`,
        );
      }
      throw e;
    }
  }
  let last = "";
  for (let i = 0; ; i++) {
    if (i >= 60) throw new Error(`container ${containerId} não ficou pronto em 10 min (último: ${last || "sem resposta"})`);
    let st: any;
    try {
      st = await graphGet(deps, containerId, { fields: "status_code,status", access_token: token }, apiVersion);
    } catch (e) {
      // #11774: token revogado (190) não melhora com o tempo — falha já, sem 10 min de poll.
      if (isGraphAuthError(e)) throw new Error(`container ${containerId}: token do Instagram recusado (${(e as Error).message}) — renove o token da página autora`);
      // Falha transitória na consulta não joga fora o upload — tenta de novo até o teto.
      last = (e as Error).message;
      deps.log(`[aviso] instagram: status do container falhou (${last}) — tentando de novo`);
      await deps.sleep(10_000);
      continue;
    }
    // #11774: o `status` (texto da Meta) acompanha o código no erro de tempo esgotado.
    last = [st.status_code, st.status].filter((x) => typeof x === "string" && x).join(" ");
    if (st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") {
      // #11355: o Reels não saiu; a rota à mão segue valendo.
      const hint = file ? "" : " — pela rota video_url (#11355); se persistir, poste pelo Chrome (Passo B3b do /diaria-publica) e registre com --confirm-instagram";
      throw new Error(`container ${containerId}: ${st.status_code} ${st.status ?? ""}${hint}`);
    }
    await deps.sleep(10_000);
  }
  const registered = (await opts.beforePublish?.()) ?? null;
  if (registered) return { entry: registered, alreadyRegistered: true };
  let pub: any;
  try {
    pub = await graphPost(deps, `${igUserId}/media_publish`, { creation_id: containerId, access_token: token }, apiVersion);
    // Resposta 200 sem id: a Graph respondeu, o publish não está em andamento (#11774).
    if (!pub.id) throw new GraphResponseError(`media_publish sem id: ${JSON.stringify(pub)}`, 200, null);
  } catch (e) {
    const failure = (e as Error).message;
    const container = await instagramContainerPublishState(deps, containerId, token, apiVersion);
    // #11774: container FINISHED depois de timeout/5xx não prova que o publish não segue em andamento.
    const state = container === "finished" ? (mediaPublishFailureIsDefinitive(e) ? "not_published" : "unknown") : container;
    if (state === "not_published") throw e;
    const at = deps.now().toISOString();
    if (state === "published") {
      // Sem o id da mídia não há permalink: o registro sai sem `url` e o timer pede a conferência.
      return {
        entry: withCoverRecord({ destination: "instagram", status: "published", id: containerId, scheduled_at: null, at }, reelCoverRecord(cover)),
        warnings: [`media_publish falhou (${failure}), mas o container ${containerId} está PUBLISHED: o Reels está no ar, sem permalink no registro — não reposte; registre com --mark instagram=URL`],
      };
    }
    return {
      entry: withCoverRecord({ destination: "instagram", status: "send_unknown", id: `send_unknown-${at}`, scheduled_at: null, at }, reelCoverRecord(cover)),
      warnings: [`media_publish falhou (${failure}) e a consulta do container ${containerId} também: o Reels PODE estar no ar — confira a conta antes de repostar; registre com --mark instagram=URL`],
    };
  }
  let url: string | undefined;
  try {
    url = (await graphGet(deps, pub.id, { fields: "permalink", access_token: token }, apiVersion)).permalink;
  } catch (e) {
    deps.log(`[aviso] instagram: permalink indisponível (${(e as Error).message}) — o id ${pub.id} identifica o Reels`);
  }
  const warnings = collaborators.length ? await checkInstagramCollaborators(deps, pub.id, token, apiVersion, collaborators) : [];
  const comment = opts.firstComment ? await postInstagramReelFirstComment(deps, pub.id, token, apiVersion, opts.firstComment) : null;
  if (comment && !comment.ok) warnings.push(comment.warning);
  return {
    entry: withCoverRecord(
      {
        destination: "instagram",
        status: "published",
        id: pub.id,
        url,
        scheduled_at: null,
        at: deps.now().toISOString(),
        ...(comment?.ok ? { first_comment_id: comment.id } : {}), // #13709
        // #13759: a falha fica no registro; o timer do Instagram retenta e alarma.
        ...(comment && !comment.ok && opts.firstComment ? { first_comment_pending: initialFirstCommentPending(opts.firstComment, comment, deps.now()) } : {}),
      },
      reelCoverRecord(cover), // #11547, #11679
    ),
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * #13709: 1º comentário do Reels com o link por edição (`diar.ia.br/video/{AAMMDD}`),
 * `POST /{ig-media-id}/comments` (mesmo endpoint do 4º post, #11724; exige
 * `instagram_manage_comments` no token). Nunca lança: o Reels já está no ar.
 */
export async function postInstagramReelFirstComment(
  deps: GraphDeps,
  mediaId: string,
  token: string,
  apiVersion: string,
  message: string,
): Promise<{ ok: true; id: string } | { ok: false; warning: string; error: string; uncertain?: boolean }> {
  try {
    const res = await graphPost(deps, `${mediaId}/comments`, { message, access_token: token }, apiVersion);
    if (res && typeof res.id === "string" && res.id) return { ok: true, id: res.id };
    const error = `resposta sem id: ${JSON.stringify(res).slice(0, 200)}`;
    // #13759: o comentário PODE existir — nunca retentado sozinho (sairia duplicado).
    return { ok: false, uncertain: true, error, warning: `Reels publicado (${mediaId}), 1º comentário com ${error}. Confira os comentários do post antes de comentar à mão: ${message} (#13709, #13759: sem retentativa automática)` };
  } catch (e) {
    const error = (e as Error).message;
    // #13791: sem resposta HTTP (timeout, abort, conexão caída no meio) o POST pode ter chegado à Graph.
    if (firstCommentErrorIsUncertain(e)) {
      return {
        ok: false,
        uncertain: true,
        error: `sem resposta da Graph (${error}): o comentário pode existir`,
        warning: `Reels publicado (${mediaId}), 1º comentário sem resposta da Graph (${error}): pode ter saído. Confira os comentários do post antes de comentar à mão: ${message} (#13709, #13791: sem retentativa automática)`,
      };
    }
    return {
      ok: false,
      error,
      warning: `Reels publicado (${mediaId}), 1º comentário não saiu: ${error}. Fica pendente no registro (first_comment_pending): o timer do Instagram no 300 tenta de novo; não comente à mão sem conferir o post. Texto: ${message} (#13709, #13759)`,
    };
  }
}

/** Códigos de rede em que a requisição nem saiu da máquina (o comentário não pode existir). */
const FIRST_COMMENT_NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * Pure (#13791): a falha do POST do 1º comentário deixa o comentário incerto?
 * Resposta HTTP com erro (`GraphResponseError`, 4xx ou 5xx) é falha que a
 * retentativa cobre, como no #13759. Sem resposta (timeout do
 * `AbortSignal.timeout`, abort, conexão caída depois de enviar) o pedido pode
 * ter chegado: incerto, nunca retentado. Exceção: DNS ou conexão recusada,
 * que provam que nada foi enviado.
 */
export function firstCommentErrorIsUncertain(e: unknown): boolean {
  if (e instanceof GraphResponseError) return false;
  const cause = (e as { cause?: { code?: unknown } } | null)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : typeof (e as { code?: unknown } | null)?.code === "string" ? (e as { code: string }).code : null;
  return !(code && FIRST_COMMENT_NOT_SENT_CODES.has(code));
}

/**
 * Relê os collaborators da mídia publicada (#10820): o Instagram pode descartar
 * o convite sem erro no `media_publish` (conta inexistente, conta que não
 * aceita collab). Nunca lança — o Reels já está no ar; devolve avisos.
 */
export async function checkInstagramCollaborators(
  deps: Pick<GraphDeps, "fetch">,
  mediaId: string,
  token: string,
  apiVersion: string,
  expected: string[],
): Promise<string[]> {
  let json: any;
  try {
    json = await graphGet(deps as GraphDeps, `${mediaId}/collaborators`, { fields: "username,invite_status", access_token: token }, apiVersion);
  } catch (e) {
    return [`não deu pra conferir o convite de collab (${(e as Error).message}) — confira no app`];
  }
  return collabInviteWarnings(json?.data, expected, { reportPending: false });
}

/**
 * Pure: avisos sobre os collabs esperados, a partir de `/{media}/collaborators`
 * (`[{username, invite_status}]`). Ausente = convite descartado. Com
 * `reportPending` (#10915, conferência do post feito no Chrome), também avisa
 * `Pending` (a conta ainda não aceitou) e `Declined`. Logo depois do
 * `media_publish` pela API o convite é sempre `Pending`, por isso lá não avisa.
 */
export function collabInviteWarnings(data: unknown, expected: string[], opts: { reportPending: boolean }): string[] {
  if (!Array.isArray(data)) return ["resposta de collaborators sem lista — confira o convite de collab no app"];
  const status = new Map(data.map((c: any) => [String(c?.username ?? "").toLowerCase(), String(c?.invite_status ?? "")]));
  const missing = expected.filter((u) => !status.has(u.toLowerCase()));
  const out: string[] = [];
  if (missing.length) out.push(`convite de collab descartado pelo Instagram: ${missing.map((u) => `@${u}`).join(", ")} — convide à mão no app`);
  if (opts.reportPending) {
    for (const u of expected) {
      const st = status.get(u.toLowerCase());
      if (st && /^pending$/i.test(st)) out.push(`collab @${u} está Pending: a @${u} ainda precisa aceitar o convite no app`);
      if (st && /^declined$/i.test(st)) out.push(`collab @${u} foi recusado (Declined) — convide de novo no app`);
    }
  }
  return out;
}

/** Lado com I/O do preparo do arquivo pro Chrome (#10915), injetável nos testes. */
export interface ChromeUploadDeps {
  runFfmpeg: (args: string[]) => { ok: true } | { ok: false; error: string };
  stat: (path: string) => { size: number; mtimeMs: number } | null;
  rename: (from: string, to: string) => void;
  /** Best-effort (arquivos de log do 2-pass, parcial de uma falha). */
  remove: (path: string) => void;
  mkdirp: (dir: string) => void;
  /** Sidecar do reuso; null = ausente/ilegível. */
  readText: (path: string) => string | null;
  writeText: (path: string, text: string) => void;
  /** `/dev/null` ou `NUL` (Windows). */
  nullSink: string;
}

/** Teto de cada passada do ffmpeg: um encode travado não pode segurar o --publish pra sempre. */
export const CHROME_UPLOAD_FFMPEG_TIMEOUT_MS = 15 * 60_000;

export const defaultChromeUploadDeps: ChromeUploadDeps = {
  runFfmpeg: (args) => {
    const r = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: CHROME_UPLOAD_FFMPEG_TIMEOUT_MS });
    if (r.error) return { ok: false, error: `${r.error.message}${r.signal ? ` (sinal ${r.signal})` : ""}` };
    if (r.signal) {
      return { ok: false, error: `ffmpeg encerrado por ${r.signal}${r.signal === "SIGTERM" ? ` (provável timeout de ${CHROME_UPLOAD_FFMPEG_TIMEOUT_MS / 60_000} min)` : ""}` };
    }
    if (r.status !== 0) return { ok: false, error: (r.stderr ?? "").trim().slice(-500) || `exit ${r.status}` };
    return { ok: true };
  },
  stat: (p) => {
    try {
      const st = statSync(p);
      return { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  },
  rename: (a, b) => renameSync(a, b),
  remove: (p) => rmSync(p, { force: true }),
  mkdirp: (d) => mkdirSync(d, { recursive: true }),
  readText: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  writeText: (p, t) => writeFileAtomic(p, t),
  nullSink: process.platform === "win32" ? "NUL" : "/dev/null",
};

/**
 * #10915: gera (ou reaproveita) a versão do vertical que cabe no `file_upload`
 * do Chrome. NUNCA lança: qualquer falha (ffmpeg ausente, encode quebrado,
 * timeout) volta `ok: false` e o passo guiado segue apontando pro original.
 * Reaproveita o arquivo já gerado só quando o sidecar `.json` bate exatamente
 * com a fonte (path, tamanho, mtime), o bitrate e o tamanho do próprio
 * arquivo, e ele tem de 1 byte a 10 MB.
 */
export function prepareInstagramChromeUpload(
  deps: ChromeUploadDeps,
  input: { source: string; output: string; durationSeconds: number },
): ChromeUploadResult {
  try {
    const bitrate = chromeUploadBitrate(input.durationSeconds);
    const src = deps.stat(input.source);
    if (!src) return { ok: false, error: `vídeo original ausente em ${input.source}` };
    const sidecarPath = chromeUploadSidecarPath(input.output);
    const expected = { source: { path: input.source, sizeBytes: src.size, mtimeMs: src.mtimeMs }, videoKbps: bitrate.videoKbps };
    const prev = deps.stat(input.output);
    if (prev && chromeUploadReusable(deps.readText(sidecarPath), expected, prev)) {
      return { ok: true, path: input.output, sizeBytes: prev.size, videoKbps: bitrate.videoKbps, reused: true };
    }
    deps.mkdirp(dirname(input.output));
    const tmp = input.output.replace(/\.mp4$/i, "") + ".part.mp4";
    const passlog = `${input.output}.2pass`;
    const cleanup = () => {
      for (const f of [`${passlog}-0.log`, `${passlog}-0.log.mbtree`]) deps.remove(f);
    };
    const passes = buildChromeUploadFfmpegPasses({
      input: input.source,
      output: tmp,
      videoKbps: bitrate.videoKbps,
      passlogfile: passlog,
      nullSink: deps.nullSink,
    });
    for (const [i, args] of passes.entries()) {
      const r = deps.runFfmpeg(args);
      if (!r.ok) {
        cleanup();
        deps.remove(tmp);
        return { ok: false, error: `ffmpeg (passada ${i + 1}) falhou: ${r.error}` };
      }
    }
    cleanup();
    const out = deps.stat(tmp);
    if (!out || out.size === 0) {
      deps.remove(tmp);
      return { ok: false, error: `ffmpeg terminou sem gerar ${tmp}` };
    }
    deps.rename(tmp, input.output);
    const sidecar: ChromeUploadSidecar = { ...expected, outputSizeBytes: out.size };
    const warnings: string[] = [];
    try {
      deps.writeText(sidecarPath, JSON.stringify(sidecar, null, 2) + "\n");
    } catch (e) {
      warnings.push(`sidecar ${sidecarPath} não gravado (${(e as Error).message}) — a próxima rodada refaz o arquivo`);
    }
    if (bitrate.warning) warnings.push(bitrate.warning);
    if (out.size > CHROME_UPLOAD_MAX_BYTES) {
      warnings.push(`o arquivo saiu com ${(out.size / 1e6).toFixed(1)} MB, acima dos ${CHROME_UPLOAD_MAX_BYTES / 1e6} MB do file_upload do Chrome — o editor escolhe o arquivo`);
    }
    return {
      ok: true,
      path: input.output,
      sizeBytes: out.size,
      videoKbps: bitrate.videoKbps,
      reused: false,
      ...(warnings.length ? { warning: warnings.join("; ") } : {}),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Pure (#10915): põe o arquivo do Chrome no passo guiado do Instagram, com
 * `upload.fitsChromeUpload` legível pela skill. Falha na compressão → o passo
 * aponta pro original (`fitsChromeUpload: false`), com aviso.
 */
export function attachChromeUploadToPlan(
  items: ShortsPlanItem[],
  upload: ChromeUploadResult,
  original: { path: string; sizeBytes: number | null },
): { items: ShortsPlanItem[]; warnings: string[] } {
  const warnings: string[] = [];
  const next = items.map((i): ShortsPlanItem => {
    if (i.destination !== "instagram" || i.action !== "guided") return i;
    if (upload.ok) {
      if (upload.warning) warnings.push(`instagram: ${upload.warning}`);
      const fits = fitsChromeUpload(upload.sizeBytes);
      const mb = (upload.sizeBytes / 1e6).toFixed(1);
      return {
        ...i,
        upload: { path: upload.path, sizeBytes: upload.sizeBytes, fitsChromeUpload: fits },
        detail:
          `${i.detail}. Arquivo pro Chrome: ${upload.path} (${mb} MB, ${upload.videoKbps} kbps${upload.reused ? ", reaproveitado" : ""}` +
          `${fits ? "" : `; passa dos ${CHROME_UPLOAD_MAX_BYTES / 1e6} MB do file_upload — o editor escolhe o arquivo`})`,
      };
    }
    warnings.push(`instagram: versão comprimida não gerada (${upload.error}) — o passo guiado usa o original, e o editor escolhe o arquivo`);
    return { ...i, upload: { path: original.path, sizeBytes: original.sizeBytes, fitsChromeUpload: false } };
  });
  return { items: next, warnings };
}

/**
 * #14204: etapa do arquivo do Chrome (#10915). Instagram acima do teto vira
 * passo guiado no Chrome; a compressão só alimenta esse passo, e o chamador
 * deve invocá-la DEPOIS do laço de envio: um encode lento ou travado nunca
 * atrasa os Reels/vídeos que saem por API. Sem passo guiado do Instagram (ou
 * sem duração legível) devolve o plano igual, sem encode.
 */
export function prepareInstagramChromeStep<P extends { items: ShortsPlanItem[]; warnings: string[] }>(
  plan: P,
  input: { aammdd: string; dir: string; videoPath: string; fileSizeBytes: number; durationSeconds: number | null },
  deps: ChromeUploadDeps = defaultChromeUploadDeps,
  log: (line: string) => void = (l) => console.error(l),
): P {
  if (input.durationSeconds === null || !plan.items.some((i) => i.destination === "instagram" && i.action === "guided")) return plan;
  const upload = prepareInstagramChromeUpload(deps, {
    source: input.videoPath,
    output: join(input.dir, "_internal", chromeUploadFileName(input.aammdd)),
    durationSeconds: input.durationSeconds,
  });
  const attached = attachChromeUploadToPlan(plan.items, upload, { path: input.videoPath, sizeBytes: input.fileSizeBytes });
  const next = { ...plan, items: attached.items, warnings: [...plan.warnings, ...attached.warnings] };
  if (upload.ok) {
    const fits = fitsChromeUpload(upload.sizeBytes);
    log(
      `${fits ? "[ok]" : "[aviso]"} instagram: arquivo pro Chrome ${upload.reused ? "reaproveitado" : "gerado"} (${(upload.sizeBytes / 1e6).toFixed(1)} MB` +
        `${fits ? "" : `, acima dos ${CHROME_UPLOAD_MAX_BYTES / 1e6} MB do file_upload`}) → ${upload.path}`,
    );
  }
  for (const w of attached.warnings) log(`[aviso] ${w}`);
  return next;
}

export interface InstagramEnqueueDeps {
  /** Sobe o vertical e devolve a URL pública (R2). */
  uploadVideo: () => Promise<string>;
  uploadCover?: () => Promise<ReelCoverUpload>;
  /** `POST /queue` do Worker. */
  enqueue: (payload: WorkerQueuePayload) => Promise<{ key: string; scheduled_at: string }>;
  now: () => Date;
}

/**
 * #10823: agenda o Reels pela fila do Worker — sobe o vertical, enfileira com a
 * conta e os collabs, e registra como `scheduled` com a key da fila no `id`.
 * O 202 do Worker só prova que a entry está na fila, nunca que saiu
 * (`resolveWorkerQueueState`, #573): o registro nunca diz `published`.
 */
export async function enqueueInstagramReel(
  deps: InstagramEnqueueDeps,
  item: { caption: string; scheduledAt: string; igAccount: WorkerInstagramAccount; idempotencyKey: string },
  collaborators: string[],
): Promise<PublishOutcome> {
  const videoUrl = await deps.uploadVideo();
  const cover = await deps.uploadCover?.();
  const coverUrl = reelCoverUrl(cover);
  let queued: { key: string; scheduled_at: string };
  try {
    queued = await deps.enqueue(
      buildReelsQueuePayload({
        caption: item.caption,
        videoUrl,
        coverUrl,
        scheduledAt: item.scheduledAt,
        account: item.igAccount,
        collaborators,
        idempotencyKey: item.idempotencyKey,
      }),
    );
  } catch (e) {
    if (e instanceof WorkerQueueError && e.code === "instagram_account_creds_missing") {
      throw new Error(
        `o Worker recusou a conta ${item.igAccount}: faltam os secrets INSTAGRAM_VJPIXEL_ACCOUNT_ID/INSTAGRAM_VJPIXEL_ACCESS_TOKEN no diaria-linkedin-cron (${e.message})`,
      );
    }
    throw e;
  }
  const state = resolveWorkerQueueState({ key: queued.key, scheduled_at: queued.scheduled_at }, deps.now());
  return {
    // #11547: a capa vai no payload; o Worker é quem a aplica — `ok` aqui é "enviada à fila".
    entry: withCoverRecord(
      { destination: "instagram", status: "scheduled", id: queued.key, scheduled_at: queued.scheduled_at, at: deps.now().toISOString() },
      reelCoverRecord(cover),
    ),
    ...(state === "scheduled" ? {} : { warnings: [`fila do Worker devolveu scheduled_at ${queued.scheduled_at} (estado ${state}) — confira se a entry não disparou na hora`] }),
  };
}
