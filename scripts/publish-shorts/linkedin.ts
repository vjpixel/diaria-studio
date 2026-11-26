/**
 * LinkedIn: vídeo no perfil pessoal, cadeia do repost pela página e a fila do Worker do repost.
 *
 * Parte de `scripts/publish-shorts.ts` (#14054): movido sem mudar a lógica; a entrada
 * reexporta o que os testes e os outros scripts importam.
 */
import { publishConfirmSuffix } from "../lib/diaria/publish-confirm.ts";
import { PAGE_REPOST_DESTINATION } from "../lib/diaria/video-publish-plan.ts";
import { CORTE_TIMER_TASK, corteBaseCommand } from "../lib/diaria/short-corte.ts";
import type { ShortPublishedEntry } from "../lib/diaria/short-video.ts";
import type { WorkerQueuePayload } from "../lib/worker-queue-client.ts";
import { buildPageRepostPayload, enqueuePageAction, linkedInPostUrnFrom, type EnqueueFn, type PageActionResult } from "../lib/diaria/linkedin-page-actions.ts";
import { postUrlFromUrn, type PersonalCreds } from "../lib/linkedin-personal.ts";
import { postVideoToPersonalProfile, type LinkedInVideoDeps } from "../lib/linkedin-video.ts";
import { withCoverRecord, type ShortCoverRecord } from "../lib/diaria/short-cover.ts";
import type { ShortsPlanItem } from "./_shared.ts";
import type { PublishOutcome } from "./facebook.ts";

/** #10907 — motivo do bloqueio do repost quando o vídeo do perfil ficou em `send_unknown`. */
export const PROFILE_SEND_UNKNOWN_BLOCKER =
  "o vídeo do perfil (linkedin_profile) ficou em send_unknown (envio ambíguo) — confira o perfil e registre com --mark linkedin_profile=URL";

/**
 * #12761 (review): teto, contado do horário planejado do vídeo do perfil, da
 * cadeia de re-agendamento do repost da página. Cada re-execução com o perfil
 * ainda pendente (timer do 300 que falhou, `--now` que o agente não rodou)
 * criaria outra task one-shot; passado o teto, o repost fica sem dono.
 * 12 h: folga sobre o teto de 3 h do alarme do timer e sobre o `skip_late` do
 * mesmo dia (vertical ao meio-dia → meia-noite).
 */
export const PROFILE_REPOST_CHAIN_MAX_MS = 12 * 60 * 60_000;

export const PROFILE_REPOST_CHAIN_STALE_DETAIL =
  "passaram mais de 12 h do horário planejado do perfil e ele não saiu: o repost fica sem dono automático, falta intervenção do editor (publicar o perfil e registrar com --mark linkedin_profile=URL)";

/**
 * #13733: texto do repost da página que fica com o timer do corte. Na rodada
 * manual do corte o vídeo do perfil ainda não existe (sai depois, pelo timer),
 * então a URN que a fila do Worker pede (#11121) também não; antes disto o
 * repost ficava "guiado" com dono `agent` e nenhuma task, e não saía.
 */
export function corteRepostTimerDetail(slug: string, aammdd: string): string {
  return (
    `repost pela página diar.ia.br: sai pelo timer do 300 (${CORTE_TIMER_TASK}) na mesma execução que publica o vídeo do perfil, ` +
    `pela fila do Worker com a URN recém-gravada, e o timer alarma se não conseguir (#13733). Não repostar à mão (sairia em dobro). ` +
    `Se o perfil sair por outro caminho (registrado com --mark), o repost vai à fila do Worker com: ${corteBaseCommand(slug)} --only ${PAGE_REPOST_DESTINATION} --publish ${publishConfirmSuffix(aammdd)}`
  );
}

/**
 * Pure (#13733): no corte com `corte_via_timer`, o repost guiado cujo vídeo do
 * perfil está `pending_schedule` (o timer do corte é o dono do perfil) vira
 * `skip_delegated`: o timer publica o perfil e, na mesma execução, põe o repost
 * na fila do Worker (`shorts-corte-timer.ts`, `corteTimerCompanions`). Fora desse
 * par, os itens voltam iguais.
 */
export function delegateCorteRepostToTimer(items: ShortsPlanItem[], slug: string, aammdd: string): ShortsPlanItem[] {
  const profileToTimer = items.some((i) => i.destination === "linkedin_profile" && i.action === "pending_schedule");
  if (!profileToTimer) return items;
  return items.map((i) =>
    i.destination === PAGE_REPOST_DESTINATION && i.action === "guided"
      ? { destination: i.destination, mode: "api", action: "skip_delegated", detail: corteRepostTimerDetail(slug, aammdd) }
      : i,
  );
}

/** Pure (#12761): o perfil passou do teto da cadeia de re-agendamento do repost? */
export function isProfileRepostChainStale(plannedProfileAt: string, now: Date): boolean {
  const planned = Date.parse(plannedProfileAt);
  return Number.isFinite(planned) && now.getTime() - planned > PROFILE_REPOST_CHAIN_MAX_MS;
}

/**
 * #10772: vertical nativo no perfil pessoal do LinkedIn (Videos API + Posts
 * API, `scripts/lib/linkedin-video.ts`). Falha antes do envio lança (nada no
 * perfil, pode re-tentar). Envio AMBÍGUO (timeout/5xx no POST do post) volta
 * como `send_unknown`: o registro passa a contar o destino como feito e a
 * próxima rodada não re-posta — o editor confere o perfil e registra com
 * `--mark linkedin_profile=URL`.
 */
export async function publishLinkedInProfileVideo(
  deps: LinkedInVideoDeps & { now: () => Date },
  creds: PersonalCreds,
  apiVersion: string,
  file: Buffer,
  text: string,
  title: string,
  /** #11547: capa (JPEG) — `uploadThumbnail` na Videos API; falha nunca derruba o vídeo. */
  cover: Buffer | null = null,
): Promise<PublishOutcome> {
  // CONFERIR NA 1ª EXECUÇÃO REAL (#10772 F3): `new Uint8Array(file)` copia o
  // vertical inteiro (275 MB em 261022). Se a memória do processo apertar, trocar
  // por `new Uint8Array(file.buffer, file.byteOffset, file.length)` (sem cópia).
  const r = await postVideoToPersonalProfile({ deps, creds, apiVersion, text, title, bytes: new Uint8Array(file), thumbnail: cover ? new Uint8Array(cover) : null });
  const at = deps.now().toISOString();
  const coverRecord: ShortCoverRecord | null = r.thumbnail
    ? r.thumbnail.ok
      ? { method: "thumbnail_upload", ok: true }
      : { method: "thumbnail_upload", ok: false, error: r.thumbnail.error }
    : null;
  const coverWarnings = coverRecord && !coverRecord.ok ? [`capa não aplicada (${coverRecord.error}) — o vídeo segue com o frame automático`] : [];
  if (r.ok) {
    const url = postUrlFromUrn(r.postUrn);
    const warnings = [...(r.postUrn ? [] : ["a LinkedIn aceitou o post sem devolver a URN (x-restli-id) — confira o perfil"]), ...coverWarnings];
    return {
      entry: withCoverRecord({ destination: "linkedin_profile", status: "published", id: r.postUrn ?? `sem-urn-${at}`, ...(url ? { url } : {}), scheduled_at: null, at }, coverRecord),
      ...(warnings.length ? { warnings } : {}),
    };
  }
  if (r.phase === "ambiguous") {
    return {
      entry: withCoverRecord({ destination: "linkedin_profile", status: "send_unknown", id: `send_unknown-${at}`, scheduled_at: null, at }, coverRecord),
      warnings: [`envio ambíguo (${r.reason}) — confira o perfil antes de qualquer nova tentativa e registre com --mark linkedin_profile=URL`, ...coverWarnings],
    };
  }
  throw new Error(r.reason);
}

/**
 * #10772 F1 (em runtime): o plano oferece o repost da página contando com o
 * vídeo do perfil desta rodada; se o `--publish` falhar no perfil (sem nada
 * registrado), o repost vira `skip_invalid` em vez de passo guiado de um vídeo
 * que não existe.
 */
export function blockRepostOnProfileFailure(
  items: ShortsPlanItem[],
  results: Array<{ destination: string; ok: boolean; entry?: { status?: string } | unknown; error?: string }>,
): ShortsPlanItem[] {
  const profile = results.filter((r) => r.destination === "linkedin_profile");
  const failed = profile.some((r) => !r.ok && !r.entry);
  // #10907: envio ambíguo nesta mesma rodada — o vídeo pode não existir.
  const unknown = profile.some((r) => (r.entry as { status?: string } | undefined)?.status === "send_unknown");
  if (!failed && !unknown) return items;
  const detail = unknown
    ? `${PROFILE_SEND_UNKNOWN_BLOCKER} — repost só depois disso`
    : "o vídeo do perfil (linkedin_profile) falhou nesta rodada — repost só depois que ele sair (ou for registrado com --mark linkedin_profile=URL)";
  return items.map((i) =>
    i.destination === "linkedin_page_repost" && i.action === "guided"
      ? { destination: i.destination, mode: "guided", action: "skip_invalid", detail }
      : i,
  );
}

/**
 * #11121: o repost da página sai pela fila do Worker `diaria-linkedin-cron`
 * (API direta como página, `action: "repost"`) no horário do passo guiado
 * (`at`, a grade da página). Só com a URN do vídeo do perfil conhecida (o
 * registro do `linkedin_profile`). Enfileirado: registra `scheduled` com a key
 * da fila e o item vira `skip_done`. Sem os segredos da página no Worker
 * (#8816), sem Worker nesta máquina ou com falha: o passo guiado de sempre
 * fica, com aviso. Idempotente pela `idempotency_key` da edição.
 */
export async function enqueuePageRepostViaWorker(
  enqueue: EnqueueFn | null,
  input: {
    aammdd: string;
    items: ShortsPlanItem[];
    profileEntry: { id?: unknown; url?: unknown } | null | undefined;
    now: Date;
    corteSlug?: string;
  },
): Promise<{ items: ShortsPlanItem[]; entry?: ShortPublishedEntry; result?: PageActionResult; warning?: string }> {
  const idx = input.items.findIndex((i) => i.destination === "linkedin_page_repost" && i.action === "guided");
  if (idx === -1) return { items: input.items };
  const item = input.items[idx] as Extract<ShortsPlanItem, { action: "guided" }>;
  const keepGuided = (why: string, result?: PageActionResult) => {
    const items = [...input.items];
    items[idx] = { ...item, detail: `${item.detail} (fila do Worker: ${why})` };
    return { items, ...(result ? { result } : {}), warning: `linkedin_page_repost: segue guiado — ${why} (#11121)` };
  };
  const urn = linkedInPostUrnFrom(input.profileEntry);
  if (!urn) return keepGuided("URN do vídeo do perfil desconhecida no registro do linkedin_profile");
  let payload: WorkerQueuePayload;
  try {
    payload = buildPageRepostPayload({
      aammdd: input.aammdd,
      targetPostUrn: urn,
      scheduledAt: item.at ?? input.now.toISOString(),
      now: input.now,
      ...(input.corteSlug ? { variant: input.corteSlug } : {}),
    });
  } catch (e) {
    return keepGuided((e as Error).message);
  }
  const result = await enqueuePageAction(enqueue, payload);
  const at = input.now.toISOString();
  const done = (entry: ShortPublishedEntry) => {
    const items = [...input.items];
    items[idx] = { destination: item.destination, mode: "api", action: "skip_done" };
    return { items, entry, result };
  };
  if (result.status === "queued") {
    return done({ destination: "linkedin_page_repost", status: "scheduled", id: result.key, scheduled_at: result.scheduled_at, at });
  }
  if (result.status === "already_fired") {
    return done({ destination: "linkedin_page_repost", status: "published", id: `worker-queue:${payload.idempotency_key}`, scheduled_at: null, at });
  }
  const why =
    result.status === "failed" && result.ambiguous
      ? `${result.detail} — confira a fila do Worker (GET /list) antes de repostar à mão`
      : result.detail;
  return keepGuided(why, result);
}
