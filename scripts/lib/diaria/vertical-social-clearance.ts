/**
 * scripts/lib/diaria/vertical-social-clearance.ts (#12748)
 *
 * O vertical (Parte B do `/diaria-publica`) sai em horário FIXO por destino
 * desde o #12250 (YouTube Shorts 06:30, os outros 12:00) e nunca é movido pela
 * grade. Os posts sociais das Etapas 5/6 (Use Melhor, D1, D2, D3) saem nas
 * MESMAS contas (Facebook diar.ia.br, Instagram @diar.ia.br em collab, X), e
 * com a rotação do #10305 um deles caía todo dia a 1 h do vertical (D1 11:00 ×
 * vertical 12:00), abaixo dos 2 h de espaçamento mínimo do #10819.
 *
 * Decisão registrada na issue (#12748, "Decisão em aberto", default (a) até o
 * editor dizer o contrário): quem cede é o social do Stage 5 — ele desvia do
 * horário fixo do vertical, preservando a decisão do #12250. Como o Stage 5
 * roda ANTES da Parte B (#12591), o vertical ainda não está no store quando o
 * social é agendado: o horário vem da config (`publishing.shorts.schedule`),
 * não do registro.
 *
 * Premissas (não vieram do editor; registradas aqui e no corpo da PR):
 *   - O desvio é UM SÓ por dia e vale igual nas 5 redes do Stage 5 — mantém a
 *     restrição do #10305 de horário único por tipo de post em todas as redes,
 *     mesmo que a colisão seja só em parte delas (o Threads da diar.ia.br não
 *     recebe o vertical, que sai no Threads pessoal).
 *   - Só bloqueiam os horários dos destinos do vertical que caem numa conta do
 *     Stage 5 (`dailySocialAccounts`): Facebook das páginas ligadas, Instagram
 *     da diar.ia.br (autora ou collab), X. YouTube Shorts, TikTok e perfis
 *     pessoais não disputam conta com o Stage 5. O repost da página do LinkedIn
 *     não bloqueia: ele já é planejado na Parte B contra a grade da página
 *     (`planLinkedInRepostSlot`), depois do Stage 5.
 *   - Só vale quando o config tem o bloco `publishing.shorts` (sem ele não há
 *     vertical configurado) e o post sai no próprio dia da edição (com
 *     `day_offset` ≠ 0 o social sai noutro dia e não cola no vertical).
 *   - Edição sem vídeo (`no-video.json`) não é conhecida aqui (puro, só
 *     config): o desvio acontece mesmo assim. Custo: um post 1-2 h fora do
 *     horário da rotação num dia sem vertical.
 *   - Novo horário: o mais perto do original, na grade de 15 min entre 06:00 e
 *     22:00 BRT, a ≥ 2 h de todo horário bloqueado e de todo outro post do dia
 *     (empate: o mais cedo). Sem nenhum que caiba, mantém o original com aviso.
 *
 * Puro: sem I/O.
 */

import { DEFAULT_MIN_GAP_MINUTES, socialAccountKey } from "../social-slot-planner.ts";
import {
  ROTATION_POST_TYPES,
  formatCivilDate,
  resolveDailyPostTime,
  type CivilDate,
  type RotationPostType,
} from "../social-schedule-rotation.ts";
import {
  listShortDestinations,
  loadShortScheduleConfig,
  loadShortsConfig,
  resolveShortTime,
  shortDestinationAccount,
  shortDestinationAlsoAccounts,
  type ShortDestination,
} from "./short-video.ts";

/** Contas que recebem os posts diários das Etapas 5/6 (LinkedIn, Facebook ligado, Instagram, Threads e X da diar.ia.br). */
export function dailySocialAccounts(config: unknown): string[] {
  // Leitura mínima de `publishing.social.facebook.pages` (ausente = só a
  // diar.ia.br, como `loadFacebookPagesConfig`). Não importa `facebook-pages.ts`:
  // ele puxa `use-melhor-dispatch.ts` e fecha um ciclo de import com
  // `compute-social-schedule.ts` (ReferenceError no load do publish-instagram).
  const pages = (config as any)?.publishing?.social?.facebook?.pages;
  const fb = (Array.isArray(pages) ? pages : [{ slug: "diaria", enabled: true }])
    .filter((p: any) => p?.enabled === true && typeof p.slug === "string")
    .map((p: any) => socialAccountKey("facebook", p.slug));
  return [
    socialAccountKey("linkedin", "diaria"),
    ...fb,
    socialAccountKey("instagram", "diaria"),
    socialAccountKey("threads", "diaria"),
    socialAccountKey("twitter", "diaria"),
  ];
}

export interface VerticalDestinationTime {
  destination: ShortDestination["id"];
  /** HH:MM BRT no dia da edição; `null` = sem horário fixo (repost da página, planejado na Parte B). */
  hhmm: string | null;
  /** Contas da grade em que o vídeo aparece (autora + collab); vazio para destino sem conta (YouTube Shorts). */
  accounts: string[];
}

/** Horário configurado de cada destino do vertical da edição (`publishing.shorts.schedule`, #12250). */
export function verticalDestinationTimes(config: unknown, aammdd: string): VerticalDestinationTime[] {
  const cfg = loadShortsConfig(config);
  const sched = loadShortScheduleConfig(config);
  return listShortDestinations(cfg).map((dest) => {
    const account = shortDestinationAccount(dest, cfg);
    const accounts = account ? [account, ...shortDestinationAlsoAccounts(dest, cfg)] : [];
    if (dest.id === "linkedin_page_repost") {
      return { destination: dest.id, hhmm: null, accounts: [socialAccountKey("linkedin", "diaria")] };
    }
    return { destination: dest.id, hhmm: resolveShortTime(sched, aammdd, dest.id).hhmm, accounts };
  });
}

/**
 * Horários do vertical que disputam conta com o Stage 5 (sem repetição,
 * ordenados). Vazio quando o config não tem `publishing.shorts`.
 */
export function verticalBlockingTimes(config: unknown, aammdd: string): string[] {
  if ((config as any)?.publishing?.shorts === undefined) return [];
  const daily = new Set(dailySocialAccounts(config));
  const out = new Set<string>();
  for (const v of verticalDestinationTimes(config, aammdd)) {
    if (v.hhmm && v.destination !== "linkedin_page_repost" && v.accounts.some((a) => daily.has(a))) out.add(v.hhmm);
  }
  return [...out].sort();
}

export interface ClearedPostTime {
  /** Horário final (HH:MM BRT); `null` = post desligado (sem horário). */
  time: string | null;
  /** Horário antes do desvio. */
  original: string | null;
  shifted: boolean;
  /** Horário do vertical que forçou o desvio. */
  blockedBy?: string;
  warning?: string;
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/**
 * Pure: desvia do vertical os posts do dia que caem a menos de `minGapMinutes`
 * de um horário bloqueado. Posts que não colidem ficam onde estão.
 */
export function clearPostTimesFromVertical(
  times: Readonly<Record<RotationPostType, string | null>>,
  blocked: readonly string[],
  opts: { minGapMinutes?: number; windowStart?: string; windowEnd?: string; stepMinutes?: number } = {},
): Record<RotationPostType, ClearedPostTime> {
  const gap = opts.minGapMinutes ?? DEFAULT_MIN_GAP_MINUTES;
  const lo = toMin(opts.windowStart ?? "06:00");
  const hi = toMin(opts.windowEnd ?? "22:00");
  const step = opts.stepMinutes ?? 15;
  const blockedMin = blocked.map(toMin);
  const out = {} as Record<RotationPostType, ClearedPostTime>;
  const conflicts: RotationPostType[] = [];
  const fixed: number[] = [...blockedMin];
  for (const type of ROTATION_POST_TYPES) {
    const t = times[type];
    if (t === null) {
      out[type] = { time: null, original: null, shifted: false };
      continue;
    }
    const m = toMin(t);
    if (blockedMin.some((b) => Math.abs(m - b) < gap)) conflicts.push(type);
    else {
      out[type] = { time: t, original: t, shifted: false };
      fixed.push(m);
    }
  }
  conflicts.sort((a, b) => toMin(times[a] as string) - toMin(times[b] as string));
  for (const type of conflicts) {
    const orig = times[type] as string;
    const om = toMin(orig);
    const by = blocked.find((b) => Math.abs(om - toMin(b)) < gap) as string;
    let best: number | null = null;
    for (let c = lo; c <= hi; c += step) {
      if (fixed.some((f) => Math.abs(c - f) < gap)) continue;
      if (best === null || Math.abs(c - om) < Math.abs(best - om)) best = c;
    }
    if (best === null) {
      out[type] = {
        time: orig,
        original: orig,
        shifted: false,
        blockedBy: by,
        warning: `${type} ${orig} BRT fica a menos de ${gap} min do vertical (${by} BRT) e nenhum horário entre ${toHHMM(lo)} e ${toHHMM(hi)} respeita o espaçamento — mantido`,
      };
      fixed.push(om);
      continue;
    }
    fixed.push(best);
    out[type] = { time: toHHMM(best), original: orig, shifted: true, blockedBy: by };
  }
  return out;
}

/**
 * Pure: horários do dia (Use Melhor, D1, D2, D3) da edição `aammdd` publicada
 * em `publishDate`, já desviados do vertical. `null` quando nada bloqueia
 * (sem `publishing.shorts`, publicação em outro dia, nenhum destino do
 * vertical numa conta do Stage 5). Mesma conta da rotação do #10305
 * (`resolveDailyPostTime`), então todos os publicadores e as superfícies que
 * exibem o horário chegam no mesmo resultado.
 */
export function clearedDailyPostTimes(
  config: unknown,
  publishDate: CivilDate,
  aammdd: string,
): Record<RotationPostType, ClearedPostTime> | null {
  if (!/^\d{6}$/.test(aammdd)) return null;
  const editionIso = `20${aammdd.slice(0, 2)}-${aammdd.slice(2, 4)}-${aammdd.slice(4, 6)}`;
  if (formatCivilDate(publishDate) !== editionIso) return null;
  const blocked = verticalBlockingTimes(config, aammdd);
  if (!blocked.length) return null;
  const social = (config as any)?.publishing?.social ?? null;
  const times = {} as Record<RotationPostType, string | null>;
  for (const type of ROTATION_POST_TYPES) times[type] = resolveDailyPostTime(social, publishDate, type).time;
  return clearPostTimesFromVertical(times, blocked);
}
