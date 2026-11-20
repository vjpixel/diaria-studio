/**
 * short-vertical-cover-step.ts (#13708) — o Passo B3a do `/diaria-publica`
 * (capa vertical do YouTube Shorts aplicada pelo Studio web, #12254) é
 * obrigatório: toda edição com Short no YouTube termina com
 * `cover.vertical_feed: "studio_web"` no registro, ou com um dono automático
 * registrado para fazer isso depois (mesmo espírito do #11550, "todo destino
 * tem dono").
 *
 * Caso real que motivou (edição 261119): o vertical subiu pela API, o
 * `thumbnails.set` trocou só a miniatura 16:9, o Chrome não estava conectado e
 * o B3a ficou como pendência em prosa; o editor precisou pedir à parte.
 *
 * Três estados por edição:
 *   - `not-applicable`: sem entrada `youtube_shorts` no registro (vertical não
 *     publicado, só o horizontal na sessão) ou agendamento cancelado (#13000);
 *   - `done`: `cover.vertical_feed === "studio_web"` (o agente aplicou e
 *     conferiu após reload, ou o `check-short-feed-cover.ts` viu a capa no
 *     `sardefault.jpg`);
 *   - `pending`: qualquer outro caso. Com `owner` quando um dono foi
 *     registrado para o MESMO vídeo (dono de outro id é de um Short trocado e
 *     não conta).
 *
 * `publica-phase.ts join` usa o veredito: `pending` sem dono sai 1 (a sessão
 * não se dá por concluída); com dono, o join passa e relata o dono, até o dono
 * vencer (`at` + 2 h com o passo pendente, #13752): aí volta a sair 1.
 *
 * Miolo puro; o I/O fica nas funções `read*`/`write*` no fim e em
 * `scripts/short-vertical-cover.ts`. Nada aqui chama o YouTube.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";
import { SHORT_COVER_FILE, type ShortCoverRecord, type ShortFeedCheckRecord } from "./short-cover.ts";
import type { ShortPublishedEntry, ShortsPublishedFile } from "./short-video.ts";
import { readShortsRegistry } from "./shorts-published-store.ts";

/** Destino do registro cuja capa vertical o passo cobre. */
export const SHORT_VERTICAL_COVER_DESTINATION = "youtube_shorts";

/**
 * Dono registrado do Passo B3a (sem Chrome na sessão). Nome fora do padrão
 * `06-shorts-published*`: nunca é lido como registro de destino.
 */
export const SHORT_VERTICAL_COVER_OWNER_FILE = "_internal/06-short-vertical-cover-owner.json";

/** Id de vídeo do YouTube: 11 caracteres de [A-Za-z0-9_-]. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Dono automático do passo, no formato dos donos do `owners[]` do
 * `publish-shorts.ts` (#11550): `agent-scheduled-task` = a skill cria uma
 * task agendada one-shot que roda `command` em `at`, numa máquina com o
 * Chrome logado no Studio. Nunca `editor`.
 */
export interface ShortVerticalCoverOwner {
  destination: typeof SHORT_VERTICAL_COVER_DESTINATION;
  step: "B3a";
  by: "agent-scheduled-task";
  video_id: string;
  at: string;
  command: string;
  /** Nome da task agendada, quando já criada. */
  task?: string;
  reason: string;
  recorded_at: string;
  note: string;
}

export type ShortVerticalCoverStep =
  | { state: "not-applicable"; reason: string }
  | { state: "done"; video_id: string | null; feed_check: ShortFeedCheckRecord | null }
  | {
      state: "pending";
      video_id: string | null;
      vertical_feed: string | null;
      owner: ShortVerticalCoverOwner | null;
      /** Dono registrado para OUTRO vídeo (Short trocado): não vale. */
      stale_owner: ShortVerticalCoverOwner | null;
      /**
       * #13752: dono do mesmo vídeo cujo `at` + `SHORT_VERTICAL_COVER_OWNER_GRACE_MS`
       * já passou com o passo ainda pendente (a task one-shot não rodou ou
       * falhou). Vale como `owner` para o relato, mas o join acusa problema.
       */
      owner_overdue: boolean;
    };

/**
 * Pure: id do vídeo de uma entrada `youtube_shorts`. A rodada pela API grava o
 * id; o `--mark youtube_shorts=URL` grava a URL (`/shorts/ID`, `watch?v=ID`,
 * `youtu.be/ID`). Sem id reconhecível → null.
 */
export function youtubeVideoIdOf(entry: Pick<ShortPublishedEntry, "id" | "url">): string | null {
  for (const raw of [entry.id, entry.url]) {
    if (!raw) continue;
    const s = raw.trim();
    if (VIDEO_ID_RE.test(s)) return s;
    const m = s.match(/(?:\/shorts\/|[?&]v=|youtu\.be\/|\/video\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/);
    if (m) return m[1];
  }
  return null;
}

/**
 * #13752: margem depois do `at` do dono antes de o dono contar como vencido.
 * A task one-shot roda em `at`; 2 h cobre a execução da skill e um atraso
 * normal da máquina. Passado isso com o passo ainda pendente, a task não foi
 * criada ou falhou, e o join volta a acusar (senão a pendência fica muda).
 */
export const SHORT_VERTICAL_COVER_OWNER_GRACE_MS = 2 * 60 * 60_000;

/** Pure: o dono venceu em `now` (`at` + margem no passado). `at` ilegível conta como vencido. */
export function isShortVerticalCoverOwnerOverdue(owner: Pick<ShortVerticalCoverOwner, "at">, now: Date): boolean {
  const at = Date.parse(owner.at);
  if (Number.isNaN(at)) return true;
  return now.getTime() > at + SHORT_VERTICAL_COVER_OWNER_GRACE_MS;
}

/** Pure: o estado do passo para o registro (já unido), o dono registrado e o instante da leitura. */
export function assessShortVerticalCoverStep(
  registry: ShortsPublishedFile | null,
  owner: ShortVerticalCoverOwner | null,
  now: Date,
): ShortVerticalCoverStep {
  const entry = registry?.entries.find((e) => e.destination === SHORT_VERTICAL_COVER_DESTINATION);
  if (!entry) return { state: "not-applicable", reason: "sem youtube_shorts no registro do vertical" };
  if (entry.cancelled_at) return { state: "not-applicable", reason: `agendamento do youtube_shorts cancelado em ${entry.cancelled_at}` };
  const videoId = youtubeVideoIdOf(entry);
  if (entry.cover?.vertical_feed === "studio_web") return { state: "done", video_id: videoId, feed_check: entry.cover.feed_check ?? null };
  const sameVideo = owner !== null && videoId !== null && owner.video_id === videoId;
  return {
    state: "pending",
    video_id: videoId,
    vertical_feed: entry.cover?.vertical_feed ?? null,
    owner: sameVideo ? owner : null,
    stale_owner: owner !== null && !sameVideo ? owner : null,
    owner_overdue: sameVideo && owner !== null && isShortVerticalCoverOwnerOverdue(owner, now),
  };
}

/** Antecedência default da task one-shot do dono (o Short agendado aceita a capa antes de ir ao ar). */
export const SHORT_VERTICAL_COVER_OWNER_LEAD_MS = 15 * 60_000;

/**
 * Pure: monta o dono do passo. `at` default = agora + 15 min. Recusa (lança)
 * sem id de vídeo: a task não teria o que abrir no Studio.
 */
export function buildShortVerticalCoverOwner(input: {
  aammdd: string;
  videoId: string | null;
  now: Date;
  at?: string;
  task?: string;
  reason?: string;
}): ShortVerticalCoverOwner {
  if (!input.videoId) throw new Error("youtube_shorts sem id de vídeo no registro: registre o Short (--mark youtube_shorts=URL) antes de dar dono à capa");
  const at = input.at ?? new Date(input.now.getTime() + SHORT_VERTICAL_COVER_OWNER_LEAD_MS).toISOString();
  if (Number.isNaN(Date.parse(at))) throw new Error(`--at ${JSON.stringify(at)} não é data ISO`);
  return {
    destination: SHORT_VERTICAL_COVER_DESTINATION,
    step: "B3a",
    by: "agent-scheduled-task",
    video_id: input.videoId,
    at,
    command: `/diaria-publica ${input.aammdd} --so vertical`,
    ...(input.task ? { task: input.task } : {}),
    reason: input.reason ?? "Claude in Chrome indisponível nesta sessão",
    recorded_at: input.now.toISOString(),
    note:
      `capa vertical do Short ${input.videoId} (Passo B3a, Studio web via Chrome): a skill cria uma task agendada one-shot para ${at}, ` +
      `numa máquina com o Chrome logado, que roda este comando; o passo fecha com scripts/short-vertical-cover.ts confirm (#13708)`,
  };
}

/** Pure: o dono gravado no arquivo, validado. Inválido lança (nunca vira "sem dono" às cegas). */
export function parseShortVerticalCoverOwner(raw: string, where = SHORT_VERTICAL_COVER_OWNER_FILE): ShortVerticalCoverOwner {
  let j: any;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${where}: JSON inválido (${(e as Error).message})`);
  }
  const ok =
    j &&
    j.destination === SHORT_VERTICAL_COVER_DESTINATION &&
    j.by === "agent-scheduled-task" &&
    typeof j.video_id === "string" &&
    VIDEO_ID_RE.test(j.video_id) &&
    typeof j.at === "string" &&
    !Number.isNaN(Date.parse(j.at)) &&
    typeof j.command === "string" &&
    j.command.trim() !== "";
  if (!ok) throw new Error(`${where}: formato inesperado (esperado o dono do Passo B3a com video_id, at e command)`);
  return j as ShortVerticalCoverOwner;
}

/** Resultado do `check-short-feed-cover.ts` (JSON do stdout) que pode fechar o passo. */
export interface FeedCheckInput {
  verdict?: unknown;
  distance?: unknown;
  threshold?: unknown;
  image?: unknown;
  feed_url?: unknown;
}

/**
 * Pure: lê o JSON do `check-short-feed-cover.ts` para o vídeo `videoId`.
 * Só vale a medição do `sardefault.jpg` (a aba Shorts, #12251) do MESMO
 * vídeo: o `oar2` é o frame automático e não muda com a capa do Studio, e a
 * medição offline (`--feed-image`) não diz de qual Short é a imagem.
 */
export function parseFeedCheck(raw: string, videoId: string, checkedAt: Date): ShortFeedCheckRecord {
  let j: FeedCheckInput;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    throw new Error(`--feed-check: JSON inválido (${(e as Error).message}); use a saída (stdout) do check-short-feed-cover.ts`);
  }
  if (!j || (j.verdict !== "capa" && j.verdict !== "frame-automatico" && j.verdict !== "sem-capa-vertical")) {
    throw new Error("--feed-check: sem verdict reconhecível (capa, frame-automatico ou sem-capa-vertical)");
  }
  if (j.image !== undefined && j.image !== "sardefault") throw new Error(`--feed-check: medição do ${String(j.image)}; só a do sardefault.jpg diz se a aba Shorts mostra a capa (#12251)`);
  if (typeof j.feed_url !== "string" || !j.feed_url.includes(`/vi/${videoId}/sardefault.jpg`)) {
    throw new Error(`--feed-check: feed_url não é o sardefault.jpg do Short ${videoId} (medição de outro vídeo ou offline)`);
  }
  return {
    verdict: j.verdict,
    ...(typeof j.distance === "number" ? { distance: j.distance } : {}),
    ...(typeof j.threshold === "number" ? { threshold: j.threshold } : {}),
    checked_at: checkedAt.toISOString(),
  };
}

/**
 * Pure: a capa registrada depois da confirmação. `studio_web` exige a
 * persistência conferida no Studio OU a medição do feed com veredito `capa`
 * (a API não aplica capa vertical: se a aba mostra a capa, ela foi posta no
 * Studio). Medição divergente com a persistência conferida fica registrada
 * (o relato mostra as duas, #12251) e não impede o `studio_web`. Entrada sem
 * `cover` (Short guiado, ou `thumbnails.set` não tentado) ganha um registro
 * `thumbnails_set` com `ok: false`: o `ok` é da miniatura 16:9, que não foi
 * conferida aqui.
 */
export function confirmedVerticalCover(
  prior: ShortCoverRecord | undefined,
  confirm: { studioPersisted: boolean; feedCheck: ShortFeedCheckRecord | null },
): ShortCoverRecord {
  if (!confirm.studioPersisted && !confirm.feedCheck) {
    throw new Error("confirmação sem prova: passe --studio-persisted (persistiu após reload no Studio) e/ou --feed-check (saída do check-short-feed-cover.ts)");
  }
  if (!confirm.studioPersisted && confirm.feedCheck?.verdict !== "capa") {
    throw new Error(
      `o feed de Shorts não mostra a capa (verdict ${confirm.feedCheck?.verdict}${confirm.feedCheck?.distance !== undefined ? `, distância ${confirm.feedCheck.distance}` : ""}): ` +
        "aplique pelo Studio web (Passo B3a) e confirme com --studio-persisted",
    );
  }
  const base: ShortCoverRecord =
    prior && prior.method === "thumbnails_set"
      ? prior
      : { method: "thumbnails_set", ok: false, error: "miniatura 16:9 não registrada; capa vertical confirmada à parte (#13708)" };
  return { ...base, vertical_feed: "studio_web", ...(confirm.feedCheck ? { feed_check: confirm.feedCheck } : {}) };
}

/** Pure: linha do join/relato para o estado do passo (null = nada a dizer). */
export function describeShortVerticalCoverStep(aammdd: string, step: ShortVerticalCoverStep): { problem: string | null; note: string | null } {
  if (step.state === "not-applicable") return { problem: null, note: null };
  if (step.state === "done") {
    const fc = step.feed_check;
    return {
      problem: null,
      note:
        `capa vertical do Short ${step.video_id ?? "?"}: studio_web` +
        (fc ? ` (feed: ${fc.verdict}${fc.distance !== undefined ? `, distância ${fc.distance.toFixed(3)}` : ""})` : " (verificação do feed não registrada)"),
    };
  }
  const id = step.video_id ?? "{VIDEO_ID}";
  if (step.owner && step.owner_overdue) {
    return {
      problem:
        `capa vertical do Short ${id} pendente com dono vencido: ${step.owner.by} às ${step.owner.at}${step.owner.task ? ` (task ${step.owner.task})` : ""} ` +
        `e o passo não fechou em ${SHORT_VERTICAL_COVER_OWNER_GRACE_MS / 3_600_000} h (a task one-shot não foi criada ou falhou). ` +
        `Aplicar ${SHORT_COVER_FILE} no Studio web (Passo B3a) e fechar com npx tsx scripts/short-vertical-cover.ts confirm ${aammdd} --id ${id} --studio-persisted, ` +
        `ou registrar dono novo com npx tsx scripts/short-vertical-cover.ts defer ${aammdd} e criar a task (#13752)`,
      note: null,
    };
  }
  if (step.owner) {
    return {
      problem: null,
      note: `capa vertical do Short ${id} pendente com dono: ${step.owner.by} às ${step.owner.at}${step.owner.task ? ` (task ${step.owner.task})` : ""}, comando ${step.owner.command} (#13708)`,
    };
  }
  return {
    problem:
      `capa vertical do Short ${id} pendente (vertical_feed: ${step.vertical_feed ?? "ausente"}): aplicar ${SHORT_COVER_FILE} no Studio web (Passo B3a) e fechar com ` +
      `npx tsx scripts/short-vertical-cover.ts confirm ${aammdd} --id ${id} --studio-persisted [--feed-check SAIDA.json]; ` +
      `sem Chrome na sessão, registrar o dono com npx tsx scripts/short-vertical-cover.ts defer ${aammdd} e criar a task one-shot que ele imprime (#13708)` +
      (step.stale_owner ? ` (o dono registrado é do Short ${step.stale_owner.video_id}, outro vídeo: não vale)` : ""),
    note: null,
  };
}

/** I/O: o estado do passo na pasta da edição (registro unido + dono). Lança com registro ou dono ilegível. */
export function readShortVerticalCoverStep(editionDir: string, aammdd: string, now: Date): ShortVerticalCoverStep {
  return assessShortVerticalCoverStep(readShortsRegistry(editionDir, aammdd), readShortVerticalCoverOwner(editionDir), now);
}

/** I/O: lê o dono registrado; ausente = null; ilegível lança. */
export function readShortVerticalCoverOwner(editionDir: string): ShortVerticalCoverOwner | null {
  const path = join(editionDir, SHORT_VERTICAL_COVER_OWNER_FILE);
  if (!existsSync(path)) return null;
  return parseShortVerticalCoverOwner(readFileSync(path, "utf8"), path);
}

/** I/O: grava o dono (atômico). */
export function writeShortVerticalCoverOwner(editionDir: string, owner: ShortVerticalCoverOwner): string {
  const path = join(editionDir, SHORT_VERTICAL_COVER_OWNER_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(owner, null, 2) + "\n");
  return path;
}
