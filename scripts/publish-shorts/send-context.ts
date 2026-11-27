/**
 * #14204: contexto explícito que o laço de envio de `mainUnlocked` (`run.ts`)
 * passa a cada etapa por destino, e o formato do resultado de cada destino.
 *
 * Só imports `import type` (os construtores de `shortsResult` não importam
 * nada): o módulo não cria ciclo entre os módulos de destino, que o importam. O estado que muda durante a rodada (o registro
 * `published`) passa por `registry`, que lê e grava a variável do laço: cada
 * etapa vê a versão mais recente, como quando o código morava inline.
 */
import type { CorteSpec } from "../lib/diaria/short-corte.ts";
import type { ShortReplacementTarget } from "../lib/diaria/short-scheduled-replace.ts";
import type { ShortPublishedEntry, ShortsConfig, ShortsPublishedFile } from "../lib/diaria/short-video.ts";
import type { ShortsRegistryWriter } from "../lib/diaria/shorts-published-store.ts";
import type { ResolvedFacebookPage } from "../lib/facebook-pages.ts";
import type { readPersonalCreds } from "../lib/linkedin-personal.ts";
import type { loadR2UploadConfig } from "../lib/r2-object-upload.ts";
import type { ThreadsTimerGateFailure, readThreadsPersonalCreds } from "../lib/threads-personal-video.ts";
import type { ShortsPlan, ShortsPlanItem } from "./_shared.ts";
import type { BufferPostInput } from "./buffer.ts";
import type { GraphDeps, PublishOutcome } from "./facebook.ts";
import type { InstagramTimerAlreadyMatch, InstagramTimerGateFailure } from "./instagram-confirm.ts";
import type { InstagramAuthor, ReelCoverUpload } from "./instagram.ts";
import type { readShortCover } from "./run-checks.ts";

/**
 * #14327: como um destino terminou a rodada `--publish`. Cada valor pede uma
 * conduta diferente de quem lê o `results[]` (a skill, os timers do 300):
 *
 * - `sent`: a plataforma aceitou e o registro foi gravado.
 * - `already`: o destino já estava no ar/registro (outro processo, post à mão);
 *   nada foi enviado por esta rodada.
 * - `handoff`: o preparo saiu e o resto é da skill (Buffer: falta o
 *   `create_post` e o `--mark`); nada está registrado.
 * - `sent_unrecorded`: a plataforma TEM o post e o registro falhou. NÃO
 *   reenviar: registrar com `--mark` (o marcador de envio fica).
 * - `failed`: nada saiu por esta rodada; pode tentar de novo.
 */
export type ShortsRunStatus = "sent" | "already" | "handoff" | "sent_unrecorded" | "failed";

interface ShortsRunResultBase {
  destination: string;
  warnings?: string[];
}

/** `sent`: aceito pela plataforma e registrado. */
export interface ShortsSentResult extends ShortsRunResultBase {
  status: "sent";
  ok: true;
  entry: ShortPublishedEntry;
  unconfirmed?: boolean;
}

/** `already` (#11157): o destino já estava registrado/no ar; nada foi enviado. */
export interface ShortsAlreadyResult extends ShortsRunResultBase {
  status: "already";
  ok: true;
  entry: ShortPublishedEntry;
  alreadyRegistered: true;
  /** #11265: como a conferência do timer achou o Reels já no ar (`time-window` pede conferir o permalink). */
  matchedBy?: InstagramTimerAlreadyMatch;
}

/** `handoff` (#10772): o que a skill passa pra Buffer `create_post` (nada é registrado até o `--mark`). */
export interface ShortsHandoffResult extends ShortsRunResultBase {
  status: "handoff";
  ok: true;
  buffer: BufferPostInput;
  /** #12279 (Buffer): o preparo só subiu o vídeo ao R2; falta o `create_post` da skill e o `--mark`. */
  pending_buffer_create?: true;
  /** #12279 (Buffer, na troca): o post antigo que a skill apaga antes do `create_post`. */
  replaces?: { id: string; at: string };
  /** #12279 (Buffer, na troca): a sequência get_post → delete_post → --mark-replaced → create_post → --mark. */
  next_steps?: string;
}

/**
 * `sent_unrecorded`: a plataforma aceitou (ou a conferência achou o post no ar)
 * e o registro não foi gravado. `cause` diz de onde veio a entrada: `record`
 * (o envio ou a conferência do perfil do Threads, #14327) ou `preflight` (a
 * conferência da conta do Instagram do timer, `preflight: "persist-failed"`).
 */
export interface ShortsSentUnrecordedResult extends ShortsRunResultBase {
  status: "sent_unrecorded";
  ok: false;
  entry: ShortPublishedEntry;
  error: string;
  cause?: "record" | "preflight";
  preflight?: InstagramTimerGateFailure;
}

/** `failed`: nada saiu por esta rodada. */
export interface ShortsFailedResult extends ShortsRunResultBase {
  status: "failed";
  ok: false;
  error: string;
  /** #11265: a falha veio da conferência da conta do timer (`instagramTimerGate`), não do publish. */
  cause?: "preflight";
  preflight?: InstagramTimerGateFailure | ThreadsTimerGateFailure;
  /** #12279: falha na fase de cancelamento da troca (`record`: cancelado sem histórico). */
  phase?: "cancel" | "record";
  /** #12279: o cancelamento saiu e não confirmou: o post antigo PODE ter saído. */
  uncertain?: true;
}

/**
 * Um destino no `results[]` da rodada `--publish` (o JSON final e o exit code
 * leem esta lista). #14327: união discriminada por `status`; `ok` segue no
 * JSON como campo derivado (`true` em `sent`/`already`/`handoff`).
 */
export type ShortsRunResult = ShortsSentResult | ShortsAlreadyResult | ShortsHandoffResult | ShortsSentUnrecordedResult | ShortsFailedResult;

type Extra<T extends ShortsRunResult> = Omit<T, "destination" | "status" | "ok" | "entry" | "error" | "buffer" | "alreadyRegistered">;

/** #14327: construtores dos resultados (o `ok` sai do `status`, nunca à mão). */
export const shortsResult = {
  sent: (destination: string, entry: ShortPublishedEntry, extra: Extra<ShortsSentResult> = {}): ShortsSentResult => ({ destination, status: "sent", ok: true, entry, ...extra }),
  already: (destination: string, entry: ShortPublishedEntry, extra: Extra<ShortsAlreadyResult> = {}): ShortsAlreadyResult => ({
    destination,
    status: "already",
    ok: true,
    entry,
    alreadyRegistered: true,
    ...extra,
  }),
  handoff: (destination: string, buffer: BufferPostInput, extra: Extra<ShortsHandoffResult> = {}): ShortsHandoffResult => ({ destination, status: "handoff", ok: true, buffer, ...extra }),
  sentUnrecorded: (destination: string, entry: ShortPublishedEntry, error: string, extra: Extra<ShortsSentUnrecordedResult> = {}): ShortsSentUnrecordedResult => ({
    destination,
    status: "sent_unrecorded",
    ok: false,
    entry,
    error,
    ...extra,
  }),
  failed: (destination: string, error: string, extra: Extra<ShortsFailedResult> = {}): ShortsFailedResult => ({ destination, status: "failed", ok: false, error, ...extra }),
};

/** A entrada do registro que o resultado leva (`undefined` em `handoff` e `failed`). */
export function shortsResultEntry(r: ShortsRunResult): ShortPublishedEntry | undefined {
  return r.status === "sent" || r.status === "already" || r.status === "sent_unrecorded" ? r.entry : undefined;
}

/**
 * O registro da rodada (`published` do laço). `persist` grava a entrada no
 * arquivo do escritor e troca a cópia em memória pela relida do disco;
 * `replace` só troca a cópia (releitura feita por quem chama).
 */
export interface ShortsRunRegistry {
  current(): ShortsPublishedFile;
  replace(fresh: ShortsPublishedFile): void;
  persist(entry: ShortPublishedEntry): void;
}

/** O que é fixo na rodada e cada etapa de destino lê (montado uma vez antes do laço). */
export interface ShortsSendContext {
  aammdd: string;
  dir: string;
  /** Bytes do vertical lidos no início da rodada (o que sobe, salvo o arquivo com a capa no 1º frame do YouTube). */
  file: Buffer;
  videoPath: string;
  /** #12279: hash dos bytes de origem. */
  videoHash: string | null;
  corte: CorteSpec | null;
  corteOutside?: { dir: string; warning: string };
  writer: ShortsRegistryWriter;
  plan: ShortsPlan;
  config: unknown;
  shortsCfg: ShortsConfig;
  pages: ResolvedFacebookPage[];
  apiVersion: string;
  igApiVersion: string;
  shortCover: ReturnType<typeof readShortCover>;
  deps: GraphDeps;
  replaceRun: boolean;
  /** #12279: o post antigo de cada alvo da substituição (`undefined` fora dela). */
  replaceTargetOf(destination: string): ShortReplacementTarget | undefined;
  /** #11547/#11679: offset da capa do X já limitado à duração do vertical. */
  bufferOffsetMs: number | null;
  /** `--force-youtube`. */
  forceYouTube: boolean;
  /** `--edition-url` (a conferência do Instagram do timer lê). */
  editionUrlArg: string | undefined;
  r2: ReturnType<typeof loadR2UploadConfig>;
  /** #11774: chaves do R2 em uso nesta rodada (fora da poda de retenção). */
  r2KeysInUse: Set<string>;
  uploadVideo(): Promise<string>;
  uploadVideoAt(key: string): Promise<string>;
  uploadCover(): Promise<ReelCoverUpload>;
  workerUrl: string;
  workerToken: string;
  igAuthor: InstagramAuthor;
  /** #14327: `ready` como as outras credenciais (o `readPersonalCreds` devolve `ok`; `linkedInSendCreds` converte). */
  liCreds: ShortsLinkedInCreds;
  liApiVersion: string;
  threadsCreds: ReturnType<typeof readThreadsPersonalCreds>;
  registry: ShortsRunRegistry;
}

/** #14327: a credencial do LinkedIn pessoal no contexto, com o mesmo `ready` de Threads e Instagram. */
export type ShortsLinkedInCreds =
  | { ready: true; creds: Extract<ReturnType<typeof readPersonalCreds>, { ok: true }>["creds"] }
  | { ready: false; reason: string };

/** #14327: converte o `ok` do `readPersonalCreds` no `ready` do contexto. */
export function linkedInSendCreds(c: ReturnType<typeof readPersonalCreds>): ShortsLinkedInCreds {
  return c.ok ? { ready: true, creds: c.creds } : { ready: false, reason: c.reason };
}

/** O item `publish` (API agora ou agendado) que as etapas de API recebem. */
export type ShortsPublishItem = Extract<ShortsPlanItem, { action: "publish" }>;
/** O item `enqueue` (Reels na fila do Worker). */
export type ShortsEnqueueItem = Extract<ShortsPlanItem, { action: "enqueue" }>;

/**
 * Desfecho de uma etapa de destino. `outcome`: a plataforma respondeu e o laço
 * segue com o pós-envio comum (registro, marcador, log). `settled`: a etapa já
 * resolveu o destino (achou-o no ar e registrou, ou não publicou) e o laço só
 * acrescenta `result` ao `results[]`. Exceção lançada = recusa, que o laço
 * trata como antes (marcador apagado, `[erro]`).
 *
 * #14327: `marker` diz ao laço o que fazer com o marcador de envio que ele
 * gravou antes de chamar a etapa: `clear` apaga (o registro já diz onde o
 * destino está), `keep` deixa (a plataforma tem o post e o registro não diz:
 * a releitura acusa "pode ter saído"). A etapa nunca apaga o marcador sozinha.
 */
export type ShortsSettledStep = { kind: "settled"; result: ShortsRunResult; marker: "clear" | "keep" };
export type ShortsSendStep = { kind: "outcome"; outcome: PublishOutcome } | ShortsSettledStep;

/**
 * #14327: o contexto que cada etapa de destino de fato lê (o laço passa o
 * `ShortsSendContext` inteiro; o tipo estreito documenta e trava o que a etapa
 * usa, e os testes montam só isso).
 */
export type ShortsBufferSendContext = Pick<ShortsSendContext, "uploadVideo" | "bufferOffsetMs" | "replaceTargetOf" | "videoHash">;
export type ShortsThreadsSendContext = Pick<ShortsSendContext, "threadsCreds" | "corte" | "aammdd" | "plan" | "registry" | "uploadVideo">;
export type ShortsLinkedInSendContext = Pick<ShortsSendContext, "liCreds" | "deps" | "liApiVersion" | "file" | "plan" | "shortCover">;
export type ShortsFacebookSendContext = Pick<ShortsSendContext, "pages" | "deps" | "apiVersion" | "file" | "shortCover" | "replaceRun">;
export type ShortsYouTubeSendContext = Pick<ShortsSendContext, "file" | "corte" | "videoHash" | "aammdd" | "plan" | "shortCover" | "forceYouTube" | "dir" | "registry">;
export type ShortsInstagramQueueSendContext = Pick<ShortsSendContext, "workerUrl" | "workerToken" | "uploadVideo" | "uploadCover" | "shortsCfg">;
export type ShortsInstagramReelSendContext = Pick<
  ShortsSendContext,
  | "igAuthor"
  | "shortsCfg"
  | "aammdd"
  | "videoPath"
  | "file"
  | "corte"
  | "corteOutside"
  | "r2"
  | "r2KeysInUse"
  | "dir"
  | "deps"
  | "igApiVersion"
  | "uploadCover"
  | "uploadVideoAt"
  | "registry"
  | "plan"
  | "writer"
  | "config"
  | "editionUrlArg"
  | "pages"
>;
