/**
 * #14204: contexto explícito que o laço de envio de `mainUnlocked` (`run.ts`)
 * passa a cada etapa por destino, e o formato do resultado de cada destino.
 *
 * Só tipos (imports `import type`): o módulo não cria ciclo entre os módulos
 * de destino, que o importam. O estado que muda durante a rodada (o registro
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

/** Um destino no `results[]` da rodada `--publish` (o JSON final e o exit code leem esta lista). */
export interface ShortsRunResult {
  destination: string;
  ok: boolean;
  entry?: ShortPublishedEntry;
  unconfirmed?: boolean;
  warnings?: string[];
  error?: string;
  /** #11157: outro processo registrou o destino durante a rodada; nada foi enviado. */
  alreadyRegistered?: boolean;
  /** #11265: como a conferência do timer achou o Reels já no ar (`time-window` pede conferir o permalink). */
  matchedBy?: InstagramTimerAlreadyMatch;
  /** #10772: o que a skill passa pra Buffer `create_post` (nada é registrado até o `--mark`). */
  buffer?: BufferPostInput;
  /** #11265: a falha veio da conferência da conta do timer (`instagramTimerGate`), não do publish. */
  cause?: "preflight";
  preflight?: InstagramTimerGateFailure | ThreadsTimerGateFailure;
  /** #12279: falha na fase de cancelamento da troca (`record`: cancelado sem histórico). */
  phase?: "cancel" | "record";
  /** #12279: o cancelamento saiu e não confirmou: o post antigo PODE ter saído. */
  uncertain?: true;
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
  liCreds: ReturnType<typeof readPersonalCreds>;
  liApiVersion: string;
  threadsCreds: ReturnType<typeof readThreadsPersonalCreds>;
  registry: ShortsRunRegistry;
}

/** O item `publish` (API agora ou agendado) que as etapas de API recebem. */
export type ShortsPublishItem = Extract<ShortsPlanItem, { action: "publish" }>;
/** O item `enqueue` (Reels na fila do Worker). */
export type ShortsEnqueueItem = Extract<ShortsPlanItem, { action: "enqueue" }>;

/** Por item: o que o laço entrega à etapa além do contexto. */
export interface ShortsSendIo {
  /** Apaga o marcador de envio do destino (o laço o gravou antes de chamar a etapa). */
  clearSending(): void;
}

/**
 * Desfecho de uma etapa de destino. `outcome`: a plataforma respondeu e o laço
 * segue com o pós-envio comum (registro, marcador, log). `settled`: a etapa já
 * resolveu o destino (achou-o no ar e registrou, ou não publicou) e o laço só
 * acrescenta `result` (se houver) ao `results[]`. Exceção lançada = recusa, que
 * o laço trata como antes (marcador apagado, `[erro]`).
 */
export type ShortsSendStep =
  | { kind: "outcome"; outcome: PublishOutcome }
  | { kind: "settled"; result: ShortsRunResult | null };
