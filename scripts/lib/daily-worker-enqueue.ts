/**
 * daily-worker-enqueue.ts (#14010)
 *
 * Enfileiramento idempotente dos posts diários de Instagram e Threads na fila
 * do Worker `linkedin-cron` (`--schedule` de `publish-instagram.ts` e
 * `publish-threads.ts`).
 *
 * Antes do #14010 esses dois publishers mandavam o `POST /queue` sem
 * `idempotency_key`. O `postToWorkerQueue` repete o POST em 5xx/timeout, e o
 * Worker, sem chave, sorteia um uuid novo a cada POST: uma resposta perdida
 * depois do commit no KV virava duas entries com o mesmo `scheduled_at` e dois
 * posts públicos. Mesmo efeito no re-run da Etapa 5 depois de um `failed`
 * cuja entry tinha sido gravada.
 *
 * Com a chave fixa por edição, canal e destaque, o retry e o re-run caem na
 * mesma entry (#10906). E, se as duas tentativas falharem de forma ambígua,
 * a fila é consultada (`findWorkerQueueEntryByIdempotencyKey`, #12664) antes
 * de o publisher gravar `failed`: achou a chave, o post está agendado. É o
 * mesmo desenho já aplicado ao LinkedIn (#12661, #12664, #12802) e aos Reels
 * (#10906).
 */
import {
  findWorkerQueueEntryByIdempotencyKey,
  idempotentConflictKey,
  postToWorkerQueue,
  WorkerQueueError,
  type IdempotencyLookupOptions,
  type IdempotencyLookupResult,
  type WorkerQueuePayload,
} from "./worker-queue-client.ts";

export type DailyWorkerQueueChannel = "instagram" | "threads";

/**
 * Namespace da chave para o diretório da edição. A Etapa 6 da `/diaria-anual`
 * roda os mesmos publishers em lotes `data/annual/{slug}/social/{AAMMDD}/`,
 * com `d1..d3` e o AAMMDD do dia do post: com o namespace da diária, a chave
 * do lote seria a MESMA do D1 da diária daquele dia, e o 2º enfileiramento
 * substituiria o 1º no Worker (#10917: mesma chave, conteúdo novo = regrava a
 * entry), apagando um dos dois posts. Mesma regra de
 * `linkedInIdempotencyNamespaceForDir` (#12584 item 5), com o canal no nome.
 */
export function dailyWorkerQueueNamespace(channel: DailyWorkerQueueChannel, editionDir?: string): string {
  const m = editionDir ? /(?:^|[\\/])annual[\\/]([^\\/]+)[\\/]social[\\/]\d{6}[\\/]*$/.exec(editionDir) : null;
  if (!m) return `${channel}-daily`;
  return `${channel}-annual-${m[1].replace(/[^A-Za-z0-9._-]/g, "-")}`.slice(0, 80);
}

/**
 * Chave idempotente do post diário na fila do Worker:
 * `{canal}-daily:{AAMMDD}:{destaque}:main` (`{canal}-daily-test:` em
 * `--test-mode`, pra um teste nunca reaproveitar nem substituir a entry de
 * produção; `{canal}-annual-{slug}:` no lote da anual). Mesmo formato de
 * `linkedInDailyIdempotencyKey`, com o canal no namespace: o D1 do Instagram e
 * o do Threads são posts diferentes e não podem cair na mesma entry. Fixa por
 * edição e destaque, então o re-run da Etapa 5 também cai na mesma entry.
 * Formato aceito pelo Worker: `[A-Za-z0-9._:-]{1,128}` (`IDEMPOTENCY_KEY_RE`).
 */
export function dailyWorkerQueueIdempotencyKey(
  channel: DailyWorkerQueueChannel,
  edition: string,
  destaque: string,
  opts: { isTest?: boolean; editionDir?: string } = {},
): string {
  const base = dailyWorkerQueueNamespace(channel, opts.editionDir);
  const ns = `${base}${opts.isTest ? "-test" : ""}`;
  const key = `${ns}:${edition}:${destaque}:main`;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
    throw new Error(`idempotency_key inválida para o Worker: ${JSON.stringify(key)}`);
  }
  return key;
}

export interface DailyWorkerEnqueueResult {
  /** Key da entry na fila do Worker. */
  key: string;
  /**
   * Ausente: o POST respondeu 2xx. `already_fired`: 409 da chave idempotente,
   * o post já saiu ou está saindo (#12661). `queue_lookup`: o POST falhou de
   * forma ambígua, mas a fila já tinha a chave (#12664).
   */
  recovered?: "already_fired" | "queue_lookup";
}

export interface DailyWorkerEnqueueOptions {
  logPrefix: string;
  /** Injetável pra teste. Default: `postToWorkerQueue` (2 tentativas). */
  post?: (workerUrl: string, token: string, payload: WorkerQueuePayload) => Promise<{ key: string }>;
  /** Injetável pra teste. Default: `findWorkerQueueEntryByIdempotencyKey`. */
  lookup?: (workerUrl: string, token: string, idempotencyKey: string) => Promise<IdempotencyLookupResult>;
  /** Repassado ao lookup default (testes passam backoff 0). */
  lookupOptions?: IdempotencyLookupOptions;
  log?: (msg: string) => void;
}

/**
 * Enfileira `payload` (que precisa trazer `idempotency_key`) e trata a falha:
 *
 * - 409 `already_fired`/`fire_in_progress` da chave: sucesso, nada novo.
 * - 4xx de validação: prova que nada foi gravado, PROPAGA (o publisher grava
 *   `failed`, como antes).
 * - 5xx, timeout, rede, resposta ilegível: a entry pode ter sido gravada.
 *   Procura a chave na fila; achou, é sucesso. Fila sem a chave em todas as
 *   leituras: propaga o erro original (re-run seguro, cai na mesma chave).
 *   Fila ilegível: propaga com o aviso de que o post pode estar na fila.
 */
export async function enqueueDailyWorkerPost(
  workerUrl: string,
  token: string,
  payload: WorkerQueuePayload & { idempotency_key: string },
  opts: DailyWorkerEnqueueOptions,
): Promise<DailyWorkerEnqueueResult> {
  const post =
    opts.post ??
    ((u: string, t: string, p: WorkerQueuePayload) => postToWorkerQueue(u, t, p, 2, opts.logPrefix));
  const lookup =
    opts.lookup ??
    ((u: string, t: string, k: string) => findWorkerQueueEntryByIdempotencyKey(u, t, k, opts.lookupOptions));
  const log = opts.log ?? ((m: string) => console.warn(m));
  const ikey = payload.idempotency_key;
  try {
    const response = await post(workerUrl, token, payload);
    return { key: response.key };
  } catch (e) {
    const firedKey = idempotentConflictKey(e);
    if (firedKey !== null) {
      log(`WARN [${opts.logPrefix}] a fila do Worker já tem este post disparado ou disparando (${ikey}); nada novo enfileirado (#14010).`);
      return { key: firedKey, recovered: "already_fired" };
    }
    if (e instanceof WorkerQueueError && e.status >= 400 && e.status < 500) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    const found = await lookup(workerUrl, token, ikey);
    if (found.status === "found") {
      log(`WARN [${opts.logPrefix}] Worker falhou (${msg}), mas a fila já tem ${found.key} com a idempotency_key ${ikey}; agendado (#14010).`);
      return { key: found.key, recovered: "queue_lookup" };
    }
    if (found.status === "error") {
      throw new Error(
        `${msg} (fila do Worker ilegível depois da falha: ${found.error}. O post pode estar na fila: confira a fila do Worker antes de re-rodar, #14010)`,
      );
    }
    throw e;
  }
}
