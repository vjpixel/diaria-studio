/**
 * use-melhor-dispatch.ts (#9568 — Stage 5)
 *
 * Decide, no Stage 5, se o 4º post social (item de maior score do USE MELHOR,
 * `## um` em `03-social.md`) sai nesta edição e com quais peças. Consumido
 * pelos 5 publicadores (`publish-linkedin.ts`, `publish-facebook.ts`,
 * `publish-instagram.ts`, `publish-threads.ts`, `prep-twitter-posts.ts`) — um
 * ponto só, pra que as 5 redes concordem sobre o item e o horário.
 *
 * Contrato FAIL-SOFT (#9568 item 8): o 4º post nunca quebra D1/D2/D3. Toda
 * ausência (slot desligado, item não selecionado, item mudou no gate, texto
 * ausente na seção do canal, imagem ausente) vira `skip` com motivo logado —
 * nenhuma entry `failed` é gravada por falta de peça. Só erro de DISPATCH
 * (rede, Worker) grava `failed`, igual aos destaques.
 *
 * Horário: `publishing.social.use_melhor_time` (decisão do editor de
 * 04/10/2026: 08:00 BRT, slot único nas 5 redes), aplicado por
 * `computeScheduledAt({ destaque: "um" })` em `compute-social-schedule.ts`.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { logEvent } from "./run-log.ts";
import {
  USE_MELHOR_POST_ID,
  USE_MELHOR_UTM_CONTENT,
  normalizeUseMelhorUrl,
  readApprovedForUseMelhor,
  readUseMelhorPostState,
  renderedUseMelhorUrls,
  selectUseMelhorItem,
  useMelhorCandidatesFromApproved,
  useMelhorPostConfigState,
  type UseMelhorCandidate,
} from "./use-melhor-post.ts";
import {
  isUseMelhorCarouselStale,
  readUseMelhorCarouselStamp,
  resolveUseMelhorCarouselImageUrls,
  useMelhorSlideFilename,
  useMelhorSlideImageKey,
} from "./use-melhor-carousel.ts";
import { readUseMelhorBlock } from "./use-melhor-status.ts";
import { readInstagramTestOverride, type CarouselCtaOverride } from "./instagram-test-override.ts";

export type UseMelhorDispatchPlan =
  | { status: "off"; reason: string }
  | {
      status: "skip";
      reason: string;
      /**
       * `info` quando a ausência já foi acusada como ⚠️ no gate do Stage 4 e
       * não é novidade no Stage 5 (estado do Stage 2 ausente — edição anterior
       * à feature, ou Stage 2 rodado com ela desligada). Default: warn.
       */
      level?: "info" | "warn";
    }
  | {
      status: "ready";
      /** "HH:MM" BRT — `publishing.social.use_melhor_time`. */
      time: string;
      item: UseMelhorCandidate;
      /** Slots do carrossel (capa → p1..pN → cta) quando gerado E em dia com o texto; senão `null`. */
      slots: string[] | null;
    };

export interface UseMelhorPlanInput {
  config: unknown;
  state: ReturnType<typeof readUseMelhorPostState>;
  reviewedMd: string | null;
  approved: unknown | null;
  socialUm: string | null;
  stamp: ReturnType<typeof readUseMelhorCarouselStamp>;
  ctaOverride: CarouselCtaOverride | null;
}

/**
 * Pure: plano do 4º post a partir das peças já lidas do disco. Re-seleciona
 * contra o `02-reviewed.md` FINAL — se o editor mexeu no USE MELHOR no gate e
 * o item de maior score mudou, o texto de `## um` foi escrito pro item antigo:
 * pular (warning), nunca publicar texto de um item que não está na edição.
 */
export function planUseMelhorDispatchFrom(input: UseMelhorPlanInput): UseMelhorDispatchPlan {
  const cfg = useMelhorPostConfigState(input.config);
  if (!cfg.enabled || !cfg.time) return { status: "off", reason: cfg.reason ?? "4º post desligado" };
  const state = input.state;
  if (!state) {
    return {
      status: "skip",
      reason: "_internal/use-melhor-post.json ausente — o Stage 2 não selecionou o item",
      level: "info",
    };
  }
  if (!state.item) return { status: "skip", reason: state.reason ?? "sem item USE MELHOR elegível" };
  if (input.reviewedMd !== null && input.approved !== null) {
    const final = selectUseMelhorItem(
      useMelhorCandidatesFromApproved(input.approved),
      renderedUseMelhorUrls(input.reviewedMd),
    );
    if (!final.item) return { status: "skip", reason: `na edição final: ${final.reason}` };
    if (normalizeUseMelhorUrl(final.item.url) !== normalizeUseMelhorUrl(state.item.url)) {
      return {
        status: "skip",
        reason:
          `o item de maior score na edição final ("${final.item.title}") difere do item para o qual ` +
          `'## ${USE_MELHOR_POST_ID}' foi escrito ("${state.item.title}") — re-rodar a seleção + social agents`,
      };
    }
  }
  let slots: string[] | null = null;
  if (input.stamp && input.socialUm) {
    const stale = isUseMelhorCarouselStale(input.stamp, input.socialUm, state.item.title, input.ctaOverride);
    if (!stale) slots = input.stamp.slots;
  }
  return { status: "ready", time: cfg.time, item: state.item, slots };
}

function readIfExists(p: string): string | null {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** Lê do disco e devolve o plano. Nunca lança — erro inesperado vira `skip`. */
export function planUseMelhorDispatch(editionDir: string, config: unknown): UseMelhorDispatchPlan {
  try {
    const cfg = useMelhorPostConfigState(config);
    if (!cfg.enabled) return { status: "off", reason: cfg.reason ?? "4º post desligado" };
    let ctaOverride: CarouselCtaOverride | null = null;
    try {
      ctaOverride = readInstagramTestOverride(editionDir)?.cta_slide ?? null;
    } catch {
      ctaOverride = null;
    }
    return planUseMelhorDispatchFrom({
      config,
      state: readUseMelhorPostState(editionDir),
      reviewedMd: readIfExists(resolve(editionDir, "02-reviewed.md")),
      approved: readApprovedForUseMelhor(editionDir),
      socialUm: readUseMelhorBlock(readIfExists(resolve(editionDir, "03-social.md")), "Social"),
      stamp: readUseMelhorCarouselStamp(editionDir),
      ctaOverride,
    });
  } catch (e) {
    return { status: "skip", reason: `erro ao montar o plano do 4º post: ${(e as Error).message}` };
  }
}

/** Ids extras a despachar além de D1/D2/D3: `["um"]` quando pronto, senão `[]`. */
export function useMelhorDispatchIds(plan: UseMelhorDispatchPlan): string[] {
  return plan.status === "ready" ? [USE_MELHOR_POST_ID] : [];
}

export interface UseMelhorImages {
  /** URLs ordenadas do carrossel (tudo-ou-nada), ou `null`. */
  carouselUrls: string[] | null;
  /** URL pública da capa tipográfica, ou `null`. */
  coverUrl: string | null;
}

/** Pure: URLs públicas do 4º post a partir de `06-public-images.json` (`images`). */
export function resolveUseMelhorImages(
  images: Record<string, { url?: string }> | undefined,
  plan: UseMelhorDispatchPlan,
): UseMelhorImages {
  if (plan.status !== "ready") return { carouselUrls: null, coverUrl: null };
  const coverUrl = images?.[useMelhorSlideImageKey("cover")]?.url ?? null;
  const carouselUrls = plan.slots ? resolveUseMelhorCarouselImageUrls(images, plan.slots) : null;
  return { carouselUrls, coverUrl };
}

/** Arquivo local da capa (pra publishers que sobem arquivo, ex. Facebook single-image). */
export const USE_MELHOR_COVER_FILE = useMelhorSlideFilename("cover");

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"')\]]+/g;
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;
/** Hosts do projeto (link da edição, CTA de assinatura, página Kit da edição). */
const PROJECT_HOST_RE = /(^|\.)(diar\.ia\.br|kit\.com)$/i;

/**
 * Pure: aplica `utm_content=usemelhor` a todo link do PROJETO no texto do 4º
 * post (link da edição no `# Curto`, linha de CTA do Facebook), preservando o
 * `utm_source`/`utm_medium`/`utm_campaign` por canal que o publisher já
 * aplicou — é o mesmo padrão de link dos destaques, com conteúdo próprio pra
 * medir o 4º post separado. Links de terceiros ficam intocados. Pontuação
 * final (ex.: o ponto que fecha a frase do CTA) fica FORA da URL.
 */
export function applyUseMelhorUtmToText(text: string): string {
  return text.replace(URL_IN_TEXT_RE, (raw) => {
    const trail = raw.match(TRAILING_PUNCT_RE)?.[0] ?? "";
    const core = trail ? raw.slice(0, -trail.length) : raw;
    let u: URL;
    try {
      u = new URL(core);
    } catch {
      return raw;
    }
    if (!PROJECT_HOST_RE.test(u.hostname)) return raw;
    u.searchParams.set("utm_content", USE_MELHOR_UTM_CONTENT);
    return u.toString() + trail;
  });
}

/**
 * Loga (stderr + `data/run-log.jsonl`, nível warn) que o 4º post foi pulado
 * num canal. `off` (feature desligada no config) só imprime uma linha, sem
 * warn — é o estado esperado, não um problema.
 */
export function reportUseMelhorSkip(
  channel: string,
  reason: string,
  opts: { editionId?: string | null; rootDir?: string; level?: "warn" | "info" } = {},
): void {
  const level = opts.level ?? "warn";
  const line = `${channel}/${USE_MELHOR_POST_ID}: 4º post (USE MELHOR) pulado — ${reason}`;
  if (level === "warn") console.warn(`WARN ${line}`);
  else console.log(line);
  if (level !== "warn") return;
  try {
    logEvent(
      {
        edition: opts.editionId && /^\d{6}$/.test(opts.editionId) ? opts.editionId : null,
        stage: 5,
        agent: `publish-${channel}`,
        level: "warn",
        message: `#9568: 4º post (USE MELHOR) pulado em ${channel} — ${reason}`,
        details: { channel, reason },
      },
      opts.rootDir,
    );
  } catch {
    // log é best-effort — nunca derruba o dispatch.
  }
}

/** Loga o motivo do plano não-`ready` (off = info, skip = warn). No-op quando pronto. */
export function reportUseMelhorPlan(
  channel: string,
  plan: UseMelhorDispatchPlan,
  opts: { editionId?: string | null; rootDir?: string } = {},
): void {
  if (plan.status === "ready") return;
  reportUseMelhorSkip(channel, plan.reason, {
    ...opts,
    level: plan.status === "off" ? "info" : (plan.level ?? "warn"),
  });
}
