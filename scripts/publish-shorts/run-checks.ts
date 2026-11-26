/**
 * Rechecagens antes de publicar, grade agendada da edição, fila do Worker, lock do corte e parsing de `--mark`.
 *
 * Parte de `scripts/publish-shorts.ts` (#14054): movido sem mudar a lógica; a entrada
 * reexporta o que os testes e os outros scripts importam.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CORTE_TIMER_DESTINATIONS, CORTE_TIMER_LOCK_FILE } from "../lib/diaria/short-corte.ts";
import type { ShortPublishedEntry, ShortsPublishedFile } from "../lib/diaria/short-video.ts";
import { readShortsRegistry } from "../lib/diaria/shorts-published-store.ts";
import {
  gridFromLinkedInPersonalIntent,
  gridFromShortsPublished,
  gridFromSocialPublished,
  gridFromWorkerQueue,
  mergeGrids,
  type ScheduledSlot,
} from "../lib/social-slot-planner.ts";
import { PERSONAL_INTENT_FILE } from "../lib/linkedin-personal.ts";
import { SHORT_COVER_FILE, SHORT_COVER_SOURCE_FILE, bufferThumbnailOffsetMs, parseShortCoverSource, withCoverRecord } from "../lib/diaria/short-cover.ts";
import { BUFFER_DESTINATIONS, MARKABLE_DESTINATIONS, type ShortsPlanItem } from "./_shared.ts";

/**
 * #11547: a capa do vertical na pasta da edição (`04-youtube-short-capa.jpg`)
 * e o offset da Buffer derivado do Still que a gerou (sidecar de
 * `fetch-drive-video.ts`). Capa vazia/ausente → `path: null`. Nunca lança:
 * leitura falha vira "sem capa" com aviso — a capa nunca barra o vídeo.
 * #11923: na leitura falha, `unreadable` traz o motivo (a capa EXISTE): o
 * "pode publicar" do corte não é gravado com `cover_sha256: null` por isso.
 */
export function readShortCover(dir: string, log: (line: string) => void = () => {}): { path: string | null; bytes: Buffer | null; bufferOffsetMs: number | null; unreadable?: string } {
  const path = join(dir, SHORT_COVER_FILE);
  try {
    if (!existsSync(path) || statSync(path).size === 0) return { path: null, bytes: null, bufferOffsetMs: null };
    const bytes = readFileSync(path);
    const sidecar = join(dir, SHORT_COVER_SOURCE_FILE);
    const source = parseShortCoverSource(existsSync(sidecar) ? readFileSync(sidecar, "utf8") : null, bytes.length);
    return { path, bytes, bufferOffsetMs: bufferThumbnailOffsetMs(source) };
  } catch (e) {
    log(`[aviso] capa do vertical ilegível (${(e as Error).message}) — segue sem capa`);
    return { path: null, bytes: null, bufferOffsetMs: null, unreadable: (e as Error).message };
  }
}

/**
 * #11157: destino que outro processo (o timer do 300, um `--mark` no neo)
 * registrou DEPOIS que esta rodada leu o registro. Relido do disco logo antes
 * de publicar: o plano foi montado com a leitura do início da rodada, e
 * publicar por cima de uma entrada nova duplicaria o post. Puro.
 */
export function registeredSinceRead(fresh: ShortsPublishedFile, destination: string): ShortPublishedEntry | null {
  return fresh.entries.find((e) => e.destination === destination) ?? null;
}

/** #11159: resultado da reconferência no disco logo antes de publicar um destino. */
export type PrePublishRecheck =
  | { kind: "proceed"; fresh: ShortsPublishedFile }
  | { kind: "already"; fresh: ShortsPublishedFile; entry: ShortPublishedEntry }
  | { kind: "unreadable"; error: string };

/**
 * #11157/#11159: a reconferência do laço de publicação, extraída pra ser
 * testável. Relê o registro unido do disco (`read`, injetável no teste);
 * registro ilegível nunca vira "publica" (`unreadable`), destino já registrado
 * por outro processo vira `already`.
 */
/**
 * Puro (#12001): destinos do timer do corte que ESTA rodada vai publicar (na
 * última hora antes do teto de 3 h a rodada manual não delega mais, #11996,
 * e o timer ainda pode passar). Não vazio = a rodada toma o lock do timer do
 * corte (`CORTE_TIMER_LOCK_FILE`) durante os envios. O filho do timer
 * (`timerRun`) nunca toma: quem o chamou já está com o lock.
 */
export function corteManualTimerDestinations(items: readonly ShortsPlanItem[], corte: { timerRun?: boolean } | null | undefined): string[] {
  if (!corte || corte.timerRun === true) return [];
  return items.filter((i) => (i.action === "publish" || i.action === "enqueue") && CORTE_TIMER_DESTINATIONS.includes(i.destination)).map((i) => i.destination);
}

/**
 * #12004: libera o lock na conclusão, em exceção e nos sinais de parada capturáveis.
 * No sinal, libera o lock, remove o handler e re-emite o mesmo sinal: o processo morre
 * pela disposição padrão (status 130 no SIGINT, 143 no SIGTERM), sem `process.exit()`,
 * que o #9911 proíbe em script com fetch (`scripts/lib/cli-exit.ts`).
 */
export function registerCorteLockCleanup(release: () => void): () => void {
  let released = false;
  const reraise = (sig: "SIGINT" | "SIGTERM", code: number) => () => {
    cleanup();
    process.exitCode = code;
    process.kill(process.pid, sig);
  };
  const onSigint = reraise("SIGINT", 130);
  const onSigterm = reraise("SIGTERM", 143);
  const cleanup = () => {
    if (released) return;
    released = true;
    process.removeListener("exit", cleanup);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    release();
  };
  // SIGKILL não é capturável; nesse caso continua valendo a expiração do lock.
  process.once("exit", cleanup);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  return cleanup;
}

/** #12001: motivo da recusa quando o timer do corte está com o lock (nada enviado nesses destinos). */
export function corteTimerLockBusyError(slug: string): string {
  return (
    `outra execução (manual ou timer) está com o lock do corte "${slug}" agora (${CORTE_TIMER_LOCK_FILE} de pé): nada enviado neste destino para não duplicar o post. ` +
    "Rode de novo em alguns minutos: a rodada relê o registro e só publica o que ainda não foi registrado (#12001)"
  );
}

export function recheckBeforePublish(
  dir: string,
  aammdd: string,
  destination: string,
  read: (dir: string, aammdd: string) => ShortsPublishedFile = readShortsRegistry,
): PrePublishRecheck {
  let fresh: ShortsPublishedFile;
  try {
    fresh = read(dir, aammdd);
  } catch (e) {
    return { kind: "unreadable", error: `registro ilegível na reconferência, não publica: ${(e as Error).message}` };
  }
  const entry = registeredSinceRead(fresh, destination);
  return entry ? { kind: "already", fresh, entry } : { kind: "proceed", fresh };
}

/**
 * Grade já agendada do dia (#10819): posts sociais da edição + o que o vertical
 * já registrou + a fila do Worker (`opts.workerQueue`, a resposta de `GET
 * /list` já lida — `loadWorkerQueueForGrid`). Store social ausente = só o do
 * vertical; ilegível = aviso e segue sem ele (a grade só ajusta horário; nunca
 * é motivo pra não publicar). `opts.instagramCollaborators`: o Reels registrado
 * ocupa também a conta dos collabs (decisão do editor 261023).
 */
export function loadScheduledGrid(
  dir: string,
  published: ShortsPublishedFile,
  instagramAccount: string | null,
  warn: (m: string) => void,
  opts: { instagramCollaborators?: readonly string[]; workerQueue?: unknown } = {},
): ScheduledSlot[] {
  const local = loadEditionGrid(dir, published, instagramAccount, warn, opts.instagramCollaborators ?? []);
  return opts.workerQueue === undefined ? local : mergeGrids(local, gridFromWorkerQueue(opts.workerQueue));
}

/**
 * #11795: grade da edição do dia, vista pelo corte avulso. Só leitura e
 * fail-soft: pasta ausente = grade vazia; registro ilegível = aviso.
 */
export function loadEditionDayGrid(
  editionDir: string,
  aammdd: string,
  instagramAccount: string | null,
  instagramCollaborators: readonly string[],
  warn: (m: string) => void,
): ScheduledSlot[] {
  if (!existsSync(editionDir)) return [];
  let published: ShortsPublishedFile;
  try {
    published = readShortsRegistry(editionDir, aammdd);
  } catch (e) {
    warn(`registro do vertical da edição ${aammdd} ilegível (${(e as Error).message}) — a grade do corte segue sem ele`);
    published = { aammdd, entries: [] };
  }
  return loadEditionGrid(editionDir, published, instagramAccount, warn, instagramCollaborators);
}

function loadEditionGrid(
  dir: string,
  published: ShortsPublishedFile,
  instagramAccount: string | null,
  warn: (m: string) => void,
  instagramCollaborators: readonly string[],
): ScheduledSlot[] {
  const grid = gridFromShortsPublished(published, instagramAccount ?? "diaria", instagramCollaborators);
  // #10772: o 4º post no perfil pessoal do LinkedIn (#9568) disputa a mesma conta que o vertical nativo.
  const personal = join(dir, "_internal", PERSONAL_INTENT_FILE);
  if (existsSync(personal)) {
    try {
      grid.push(...gridFromLinkedInPersonalIntent(JSON.parse(readFileSync(personal, "utf8"))));
    } catch (e) {
      warn(`${personal} ilegível (${(e as Error).message}) — grade sem o 4º post do perfil pessoal`);
    }
  }
  const p = join(dir, "_internal", "06-social-published.json");
  if (!existsSync(p)) return grid;
  try {
    return [...gridFromSocialPublished(JSON.parse(readFileSync(p, "utf8"))), ...grid];
  } catch (e) {
    warn(`${p} ilegível (${(e as Error).message}) — grade #10819 sem os posts sociais do dia`);
    return grid;
  }
}

/**
 * #11001: teto da leitura da fila do Worker. A fila só ajusta horário, então um
 * Worker lento/pendurado nunca pode prender o script (nem o dry-run): estourou,
 * aborta e segue sem a fila, como em qualquer outra falha do Worker.
 */
export const WORKER_QUEUE_LIST_TIMEOUT_MS = 10_000;

/**
 * Lê a fila do Worker (`GET /list`, só leitura) pra grade do #10819. Fail-soft:
 * sem URL/token, com erro ou passado `timeoutMs` (#11001), avisa e devolve
 * `undefined` (a grade segue só com os stores da edição) — a fila só ajusta
 * horário, nunca impede publicar.
 */
export async function loadWorkerQueueForGrid(
  workerUrl: string,
  workerToken: string,
  fetchFn: typeof fetch,
  warn: (m: string) => void,
  opts: {
    timeoutMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  } = {},
): Promise<unknown | undefined> {
  if (!workerUrl || !workerToken) {
    warn("grade #10819 sem a fila do Worker (DIARIA_LINKEDIN_CRON_URL/_TOKEN ausente) — posts agendados fora dos stores da edição não entram");
    return undefined;
  }
  const url = workerUrl.replace(/\/+$/, "") + "/list";
  const timeoutMs = opts.timeoutMs ?? WORKER_QUEUE_LIST_TIMEOUT_MS;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const controller = new AbortController();
  // A corrida contra o timer garante o teto mesmo com um fetch que ignore o
  // `signal`; o abort libera o socket quando o fetch o respeita.
  let timer: unknown;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimer(() => {
      controller.abort();
      reject(new Error(`timeout de ${timeoutMs} ms no GET /list`));
    }, timeoutMs);
  });
  try {
    const json = await Promise.race([
      (async () => {
        const res = await fetchFn(url, { headers: { "X-Diaria-Token": workerToken }, signal: controller.signal });
        if (!res.ok) {
          // #9991: corpo descartado precisa ser cancelado, senão o socket segura o exit.
          await res.body?.cancel().catch(() => {});
          throw new Error(`HTTP ${res.status}`);
        }
        return (await res.json()) as unknown;
      })(),
      timedOut,
    ]);
    if (!Array.isArray((json as { items?: unknown })?.items)) throw new Error("resposta sem items");
    return json;
  } catch (e) {
    warn(`grade #10819 sem a fila do Worker (${(e as Error).message}) — posts agendados fora dos stores da edição não entram`);
    return undefined;
  } finally {
    clearTimer(timer);
    timedOut.catch(() => {});
  }
}

/**
 * `--mark DESTINO=URL`: só destinos guiados (+ `instagram`, #10893, e
 * `linkedin_profile`, #10772, depois de conferir um envio ambíguo), só URL
 * http(s). O X aceita também `x=buffer:{id}` (#10772): o post agendado na
 * Buffer ainda não tem URL.
 */
export function parseMarkArg(raw: string): { destination: string; url: string | null; bufferId?: string } {
  // #11515: o TikTok também sai pela Buffer (`tiktok=buffer:{id}`).
  const buf = raw.match(/^([a-z_]+)=buffer:([A-Za-z0-9_-]+)$/);
  if (buf && BUFFER_DESTINATIONS.has(buf[1])) return { destination: buf[1], url: null, bufferId: buf[2] };
  const m = raw.match(/^([a-z_]+)=(https?:\/\/\S+)$/);
  if (!m) throw new Error(`--mark espera DESTINO=URL (http/https), recebido ${JSON.stringify(raw)}`);
  if (!MARKABLE_DESTINATIONS.has(m[1])) {
    throw new Error(`--mark só registra destinos guiados (${[...MARKABLE_DESTINATIONS].join(", ")}); "${m[1]}" é publicado pelo script`);
  }
  return { destination: m[1], url: m[2] };
}

/**
 * Entrada que o `--mark` grava (#10772 F6). `x=buffer:{id}` vira `scheduled`
 * com o `--scheduled-at` (ISO) — sem ele, `scheduled_at` null (estado
 * `unknown` até conferir). Os demais viram `published` com a URL.
 */
export function buildMarkEntry(
  mark: ReturnType<typeof parseMarkArg>,
  scheduledAt: string | undefined,
  at: string,
  /**
   * #11547: `thumbnailOffset` (ms) que a skill passou no `create_post` da
   * Buffer (`--thumbnail-offset`). O `--mark` só registra, não confere a Buffer.
   */
  bufferThumbnailOffset: number | null = null,
): { ok: true; entry: ShortPublishedEntry } | { ok: false; error: string } {
  if (scheduledAt !== undefined && (!mark.bufferId || Number.isNaN(Date.parse(scheduledAt)))) {
    return { ok: false, error: "--scheduled-at só vale com --mark x=buffer:{id} (ou tiktok=buffer:{id}) e precisa ser ISO 8601" };
  }
  if (mark.bufferId) {
    return {
      ok: true,
      entry: withCoverRecord(
        { destination: mark.destination, status: "scheduled", id: `buffer:${mark.bufferId}`, scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null, at },
        bufferThumbnailOffset === null ? null : { method: "thumbnail_offset", ok: true, offset_ms: bufferThumbnailOffset },
      ),
    };
  }
  return { ok: true, entry: { destination: mark.destination, status: "published", id: mark.url!, url: mark.url!, at } };
}

/**
 * Pure (#11547): `--thumbnail-offset MS` do `--mark x=buffer:{id}` — inteiro
 * ≥ 0, só com `x=buffer`. Ausente = nenhuma capa registrada.
 */
export function parseThumbnailOffsetArg(raw: string | undefined, isBufferMark: boolean): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: null };
  if (!isBufferMark) return { ok: false, error: "--thumbnail-offset só vale com --mark x=buffer:{id} (ou tiktok=buffer:{id})" };
  if (!/^\d+$/.test(raw)) return { ok: false, error: `--thumbnail-offset espera milissegundos (inteiro ≥ 0), recebido ${JSON.stringify(raw)}` };
  return { ok: true, value: Number(raw) };
}

/** Link da edição: --edition-url > `_internal/05-edition-url.txt` > (derivado, no plano). */
export function resolveEditionUrlInput(dir: string, flag: string | undefined): { url?: string; source?: string } {
  if (flag) return { url: flag, source: "--edition-url" };
  const p = join(dir, "_internal", "05-edition-url.txt");
  if (existsSync(p)) {
    const url = readFileSync(p, "utf8").trim();
    if (/^https?:\/\//.test(url)) return { url, source: "_internal/05-edition-url.txt" };
  }
  return {};
}
