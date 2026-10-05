/**
 * use-melhor-dispatch.ts (#9568 — Stage 5)
 *
 * Decide, no Stage 5, se o 4º post social (item de maior score do USE MELHOR,
 * `## um` em `03-social.md`) sai nesta edição e com quais peças. Consumido
 * pelos 5 publicadores (`publish-linkedin.ts`, `publish-facebook.ts`,
 * `publish-instagram.ts`, `publish-threads.ts`, `prep-twitter-posts.ts`), por
 * `upload-images-public.ts` (quais slides subir) e pelo lembrete do post
 * pessoal (`resolve-post-pixel.ts`) — um ponto só, pra que todos concordem
 * sobre o item, o horário e as imagens.
 *
 * Contrato FAIL-SOFT (#9568 item 8): o 4º post nunca quebra D1/D2/D3. Toda
 * ausência (slot desligado, item não selecionado, item mudou no gate, edição
 * final ilegível, texto ausente na seção do canal, imagem ausente) vira `skip`
 * com motivo logado — nenhuma entry `failed` é gravada por falta de peça. Só
 * erro de DISPATCH (rede, Worker) e erro de AGENDAMENTO gravam `failed`, igual
 * aos destaques.
 *
 * Imagens: a capa e os slides só valem quando o carimbo do Stage 3 bate com o
 * texto atual de `## um` + título da capa GRAVADO no carimbo
 * (`isUseMelhorCarouselStale`; #9630 — carimbo antigo sem o campo cai no
 * título resolvido na hora). Carimbo defasado = a arte pode ser de OUTRO
 * texto/item — nem a capa é usada.
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
  checkUseMelhorItemInFinal,
  readApprovedForUseMelhor,
  readUseMelhorPostState,
  resolveUseMelhorCoverTitle,
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

export type UseMelhorReadyPlan = {
  status: "ready";
  /** "HH:MM" BRT — `publishing.social.use_melhor_time`. */
  time: string;
  item: UseMelhorCandidate;
  /**
   * Slots do carrossel (capa → p1..pN → cta) quando o carimbo do Stage 3
   * existe E bate com o texto atual; senão `null` — e aí nem a capa é usada.
   */
  slots: string[] | null;
  /** Presente quando `slots === null`: por que as imagens não valem (vira warn por canal). */
  imageWarning?: string;
};

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
  | UseMelhorReadyPlan;

/** Mesma regra de `main_post_mentions_diaria(_url)` (#595): "Diar.ia" ou "diar.ia.br". */
const UM_BRAND_RE = /\bdiar\.ia\b/i;

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
 * Pure: plano do 4º post a partir das peças já lidas do disco. Confere contra
 * o `02-reviewed.md` FINAL — se o item escolhido saiu do USE MELHOR (ou a
 * seção sumiu), o texto de `## um` fala de um item que não está na edição:
 * pular (warning). Item de score maior na edição final NÃO pula mais (#9592):
 * a escolha gravada — inclusive troca manual do editor — vale. Sem `02-reviewed.md` ou sem JSON aprovado a
 * re-verificação é impossível → também pula (falha FECHADA).
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
  if (input.reviewedMd === null || input.approved === null) {
    return {
      status: "skip",
      reason:
        `não dá pra re-verificar o item contra a edição final (${input.reviewedMd === null ? "02-reviewed.md" : "01-approved(-capped).json"} ausente/ilegível)`,
    };
  }
  // #9592: basta o item ESCOLHIDO seguir no USE MELHOR final — não precisa ser
  // o de maior score (o editor pode ter trocado o item à mão; o `## um` foi
  // escrito pra ele). Pular só quando ele saiu da edição.
  const final = checkUseMelhorItemInFinal(state.item, input.reviewedMd);
  if (!final.ok) return { status: "skip", reason: `na edição final: ${final.reason}` };
  // #9628: o lint do `## um` é fail-soft no Stage 2 (#9619) — menção à marca/URL
  // só vira aviso lá, e o texto vai pra página da diar.ia.br. No Stage 5 isso
  // pula o 4º post (mesmo plano `skip` do #9568), nunca publica.
  if (input.socialUm && UM_BRAND_RE.test(input.socialUm)) {
    return { status: "skip", reason: `'## ${USE_MELHOR_POST_ID}' menciona a marca/URL diar.ia (#9628) — main post fica 100% editorial` };
  }
  const coverTitle = resolveUseMelhorCoverTitle(state.item, { reviewedMd: input.reviewedMd, approved: input.approved });
  let slots: string[] | null = null;
  let imageWarning: string | undefined;
  if (!input.stamp) {
    imageWarning = "carrossel do 4º post não gerado no Stage 3 (sem carimbo)";
  } else if (!input.socialUm) {
    imageWarning = `'## ${USE_MELHOR_POST_ID}' ausente em '# Social' — não dá pra conferir a arte`;
  } else if (isUseMelhorCarouselStale(input.stamp, input.socialUm, coverTitle, input.ctaOverride)) {
    imageWarning =
      `carrossel do 4º post DEFASADO ('## ${USE_MELHOR_POST_ID}' mudou depois do Stage 3) — capa e slides ignorados; ` +
      `re-rodar gen-carousel-cards.ts + upload-images-public.ts`;
  } else {
    slots = input.stamp.slots;
  }
  return { status: "ready", time: cfg.time, item: state.item, slots, ...(imageWarning && { imageWarning }) };
}

function readIfExists(p: string): string | null {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function readCtaOverride(editionDir: string): CarouselCtaOverride | null {
  try {
    return readInstagramTestOverride(editionDir)?.cta_slide ?? null;
  } catch {
    return null;
  }
}

/** Lê do disco e devolve o plano. Nunca lança — erro inesperado vira `skip`. */
export function planUseMelhorDispatch(editionDir: string, config: unknown): UseMelhorDispatchPlan {
  try {
    const cfg = useMelhorPostConfigState(config);
    if (!cfg.enabled) return { status: "off", reason: cfg.reason ?? "4º post desligado" };
    return planUseMelhorDispatchFrom({
      config,
      state: readUseMelhorPostState(editionDir),
      reviewedMd: readIfExists(resolve(editionDir, "02-reviewed.md")),
      approved: readApprovedForUseMelhor(editionDir),
      socialUm: readUseMelhorBlock(readIfExists(resolve(editionDir, "03-social.md")), "Social"),
      stamp: readUseMelhorCarouselStamp(editionDir),
      ctaOverride: readCtaOverride(editionDir),
    });
  } catch (e) {
    return { status: "skip", reason: `erro ao montar o plano do 4º post: ${(e as Error).message}` };
  }
}

/**
 * Slots do carrossel que valem subir (`upload-images-public.ts`): os do
 * carimbo só quando ele bate com o texto/título atuais — nunca sobe arte de
 * carimbo defasado. `[]` sem estado/carimbo/texto. Nunca lança.
 */
export function freshUseMelhorCarouselSlots(editionDir: string): string[] {
  try {
    const stamp = readUseMelhorCarouselStamp(editionDir);
    const state = readUseMelhorPostState(editionDir);
    const socialUm = readUseMelhorBlock(readIfExists(resolve(editionDir, "03-social.md")), "Social");
    if (!stamp || !state?.item || !socialUm) return [];
    const coverTitle = resolveUseMelhorCoverTitle(state.item, {
      reviewedMd: readIfExists(resolve(editionDir, "02-reviewed.md")),
      approved: readApprovedForUseMelhor(editionDir),
    });
    if (isUseMelhorCarouselStale(stamp, socialUm, coverTitle, readCtaOverride(editionDir))) return [];
    return stamp.slots;
  } catch {
    return [];
  }
}

/** Ids extras a despachar além de D1/D2/D3: `["um"]` quando pronto, senão `[]`. */
export function useMelhorDispatchIds(plan: UseMelhorDispatchPlan): string[] {
  return plan.status === "ready" ? [USE_MELHOR_POST_ID] : [];
}

export interface UseMelhorImages {
  /** URLs ordenadas do carrossel (tudo-ou-nada), ou `null`. */
  carouselUrls: string[] | null;
  /** URL pública da capa tipográfica — só quando o carimbo está em dia; senão `null`. */
  coverUrl: string | null;
}

/** Pure: URLs públicas do 4º post a partir de `06-public-images.json` (`images`). */
export function resolveUseMelhorImages(
  images: Record<string, { url?: string }> | undefined,
  plan: UseMelhorDispatchPlan,
): UseMelhorImages {
  if (plan.status !== "ready" || !plan.slots) return { carouselUrls: null, coverUrl: null };
  const coverUrl = images?.[useMelhorSlideImageKey("cover")]?.url ?? null;
  const carouselUrls = resolveUseMelhorCarouselImageUrls(images, plan.slots);
  return { carouselUrls, coverUrl };
}

/** Arquivo local da capa (pra publishers que sobem arquivo, ex. Facebook single-image). */
export const USE_MELHOR_COVER_FILE = useMelhorSlideFilename("cover");

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"')\]]+/g;
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;
/**
 * Hosts do projeto: `diar.ia.br` (+ subdomínios) e a página pública da conta
 * Kit da diária (`diariabr.kit.com`, onde o `public_url` da edição mora) —
 * nunca `*.kit.com` inteiro, que inclui páginas de terceiros.
 */
const PROJECT_HOST_RE = /^(?:(?:[a-z0-9-]+\.)*diar\.ia\.br|diariabr\.kit\.com)$/i;

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
 * Loga que o 4º post foi pulado (ou degradado) num canal. `warn` → stderr +
 * `data/run-log.jsonl` (nível warn); `info` → só uma linha no stdout, sem
 * run-log (ausência esperada ou já acusada no gate do Stage 4). Best-effort:
 * falha de log nunca derruba o dispatch.
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

/** Loga o motivo do plano não-`ready` (off = info, skip = level do plano). No-op quando pronto. */
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

/**
 * Warn (stderr + run-log) quando o 4º post SAI, mas degradado: carrossel
 * defasado/ausente, ou incompleto em `06-public-images.json` e o canal caiu
 * pra capa única / só texto. `usesCarousel: false` (LinkedIn página, que só
 * usa a capa) só avisa do carimbo, nunca de slide faltando.
 */
export function reportUseMelhorImageFallback(
  channel: string,
  plan: UseMelhorReadyPlan,
  images: UseMelhorImages,
  opts: { editionId?: string | null; rootDir?: string; usesCarousel: boolean },
): void {
  let msg: string | null = null;
  if (plan.imageWarning) msg = plan.imageWarning;
  else if (opts.usesCarousel && plan.slots && !images.carouselUrls) {
    msg = "carrossel incompleto em 06-public-images.json (algum slide não subiu) — saindo com capa única/só texto";
  }
  if (!msg) return;
  const line = `${channel}/${USE_MELHOR_POST_ID}: 4º post (USE MELHOR) degradado — ${msg}`;
  console.warn(`WARN ${line}`);
  try {
    logEvent(
      {
        edition: opts.editionId && /^\d{6}$/.test(opts.editionId) ? opts.editionId : null,
        stage: 5,
        agent: `publish-${channel}`,
        level: "warn",
        message: `#9568: ${line}`,
        details: { channel, reason: msg },
      },
      opts.rootDir,
    );
  } catch {
    // best-effort
  }
}

/**
 * Idempotência em re-execução (resume): entry `um` já agendada/rascunho/
 * publicada naquela plataforma → não despachar de novo. `failed` é retentado,
 * igual aos destaques. Subtipo `main` só (LinkedIn): entry sem `subtype` conta
 * como `main`, mesma regra de `resolveSubtype`.
 */
export function findExistingUseMelhorEntry<
  T extends { platform: string; destaque: string; status: string; subtype?: string },
>(posts: readonly T[], platform: string): T | undefined {
  return posts.find(
    (p) =>
      p.platform === platform &&
      p.destaque === USE_MELHOR_POST_ID &&
      (p.subtype === undefined || p.subtype === "main") &&
      (p.status === "draft" || p.status === "scheduled" || p.status === "published"),
  );
}

/** Resumo do 4º post no JSON de saída dos publishers (Stage 5 → resumo/gate do Stage 6). */
export interface UseMelhorDispatchSummary {
  status: "ready" | "skip" | "off";
  reason?: string;
}

export function summarizeUseMelhor(
  plan: UseMelhorDispatchPlan,
  built: { ok: true } | { ok: false; reason: string } | null,
): UseMelhorDispatchSummary {
  if (plan.status !== "ready") return { status: plan.status, reason: plan.reason };
  if (built && !built.ok) return { status: "skip", reason: built.reason };
  return { status: "ready" };
}
