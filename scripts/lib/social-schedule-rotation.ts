/**
 * social-schedule-rotation.ts (#10305) — teste rotativo dos horários das redes.
 *
 * O editor pediu pra reavaliar os horários de publicação nas redes (#10305) e
 * fixou o método no comentário de 15/10/2026: o histórico só cobre os horários
 * já usados e confunde horário com tipo de post (o Use Melhor sempre saiu às
 * 07:45, o D1 sempre às 09:45), então quem decide é um teste em posts futuros —
 * alternar candidatos entre os dias úteis girando também QUAL post (D1/D2/D3/
 * Use Melhor) cai em cada horário, até cada horário ter recebido todos os
 * tipos; sábado e domingo alternam candidatos semana a semana. Decisão de
 * 18/10/2026: autorizado, com o artigo semanal de segunda do LinkedIn
 * (`/diaria-linkedin-semanal`) entrando na mesma medição.
 *
 * Este módulo é PURO: dado o bloco `publishing.social.rotation` do config e a
 * data de publicação, devolve o horário. Nada de `Date.now()` — o resultado é
 * derivado só da data, então os 5 publicadores (LinkedIn, Facebook, Instagram,
 * Threads, X), o reagendamento do Facebook e o plano consultável da CLI
 * (`scripts/social-schedule-rotation.ts`) chegam sempre no MESMO horário.
 * Os 4 horários do dia útil valem pra todas as redes (restrição da issue: sem
 * override por plataforma).
 *
 * ── Desenho do dia útil ────────────────────────────────────────────────────
 * `weekday_candidates` tem N horários (N ≥ 4). `k` = quantos dias úteis
 * (seg–sex) se passaram desde `start_date`. O tipo de índice `t`
 * (`ROTATION_POST_TYPES`: um, d1, d2, d3) recebe o candidato
 * `(k + t * floor(N/4)) mod N`. Consequências:
 *   - num dia, os 4 posts caem em 4 candidatos distintos (espaçados N/4 casas);
 *   - a cada dia útil cada tipo anda 1 casa, então em N dias úteis seguidos
 *     cada tipo passa por todos os N candidatos exatamente 1 vez — cada célula
 *     (horário × tipo) recebe 1 post por ciclo de N dias úteis, sem viés.
 * O ciclo conta dias úteis do CALENDÁRIO, não edições publicadas: um feriado
 * sem edição perde as 4 células daquele dia, mas não desloca as dos dias
 * seguintes (o plano continua determinístico e reconstruível a qualquer hora).
 *
 * ── Fim de semana e artigo de segunda ──────────────────────────────────────
 * `w` = semanas inteiras desde a segunda-feira da semana de `start_date`.
 * Sábado usa `weekend_candidates[w mod M]`; domingo usa
 * `weekend_candidates[(w + floor(M/2)) mod M]` — na mesma semana os dois dias
 * caem em horários diferentes, pra não confundir efeito de semana com efeito
 * de horário. O artigo semanal de segunda usa
 * `linkedin_weekly_article_candidates[w mod L]`.
 *
 * ── Ligado/desligado ───────────────────────────────────────────────────────
 * Fora de `[start_date, end_date]` (ambos inclusivos, datas civis no fuso do
 * config), com `enabled: false` ou sem o bloco, nada muda: valem os horários
 * fixos (`fallback_schedule`, `use_melhor_time`, `DEFAULT_WEEKLY_TIME`,
 * `linkedin_weekly_article_time`). Config ligado e malformado LANÇA — agendar
 * no horário fixo em silêncio estragaria a medição sem ninguém ver.
 */

/**
 * Horário fixo do carrossel semanal (sábado/domingo) fora da rotação — fonte
 * única, reexportada como `DEFAULT_WEEKLY_TIME` por `publish-weekly-social.ts`
 * (assunção herdada do #4101, nunca medida).
 */
export const DEFAULT_WEEKLY_CAROUSEL_TIME = "11:00";

/**
 * Horário fixo do artigo semanal do LinkedIn fora da rotação quando o config
 * não define `publishing.social.linkedin_weekly_article_time` (09:30 BRT,
 * escolhido na sessão do ciclo 26w42 — #10305, comentário de 18/10/2026).
 */
export const DEFAULT_LINKEDIN_WEEKLY_ARTICLE_TIME = "09:30";

export const ROTATION_POST_TYPES = ["um", "d1", "d2", "d3"] as const;
export type RotationPostType = (typeof ROTATION_POST_TYPES)[number];

export const HHMM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** Shape cru de `publishing.social.rotation` em `platform.config.json`. */
export interface SocialRotationConfigRaw {
  enabled?: unknown;
  start_date?: unknown;
  end_date?: unknown;
  weekday_candidates?: unknown;
  weekend_candidates?: unknown;
  linkedin_weekly_article_candidates?: unknown;
  [k: string]: unknown;
}

export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

export interface SocialRotation {
  start: CivilDate;
  /** Inclusivo. `null` = sem fim (a rotação segue até alguém desligar). */
  end: CivilDate | null;
  weekday: string[];
  weekend: string[];
  /** Vazio = artigo de segunda fora da rotação (fica no horário fixo). */
  article: string[];
}

/** Pure: "AAAA-MM-DD" → CivilDate validada (round-trip — rejeita 2026-02-31). */
export function parseIsoCivilDate(s: string, label = "data"): CivilDate {
  const m = ISO_DATE_RE.exec(s);
  if (!m) throw new Error(`${label} inválida: '${s}' (esperado AAAA-MM-DD).`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new Error(`${label} inválida (não existe): '${s}'.`);
  }
  return { year, month, day };
}

/** Pure: número do dia civil (dias desde 1970-01-01), sem depender do fuso do runner. */
export function civilDayNumber(d: CivilDate): number {
  return Math.round(Date.UTC(d.year, d.month - 1, d.day) / MS_PER_DAY);
}

/** Pure: dia da semana (0 = domingo … 6 = sábado). */
export function civilWeekday(d: CivilDate): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

/** Pure: CivilDate a partir do número do dia. */
export function civilFromDayNumber(n: number): CivilDate {
  const d = new Date(n * MS_PER_DAY);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Pure: "AAAA-MM-DD". */
export function formatCivilDate(d: CivilDate): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

function readCandidates(raw: unknown, key: string, min: number): string[] {
  if (raw === undefined || raw === null) {
    if (min === 0) return [];
    throw new Error(`publishing.social.rotation.${key} ausente (rotação ligada exige ≥${min} horários).`);
  }
  if (!Array.isArray(raw)) throw new Error(`publishing.social.rotation.${key} não é lista.`);
  const out = raw.map((v, i) => {
    if (typeof v !== "string" || !HHMM_RE.test(v)) {
      throw new Error(`publishing.social.rotation.${key}[${i}] inválido: ${JSON.stringify(v)} (esperado "HH:MM").`);
    }
    return v;
  });
  if (out.length < min) {
    throw new Error(`publishing.social.rotation.${key} tem ${out.length} horário(s); mínimo ${min}.`);
  }
  if (new Set(out).size !== out.length) {
    throw new Error(`publishing.social.rotation.${key} tem horário repetido: ${JSON.stringify(out)}.`);
  }
  return out;
}

/**
 * Pure: lê e valida `publishing.social.rotation`. `null` = rotação desligada
 * (bloco ausente ou `enabled !== true`). Ligada e malformada → lança.
 */
export function readSocialRotation(social: { rotation?: unknown } | null | undefined): SocialRotation | null {
  const raw = social?.rotation as SocialRotationConfigRaw | undefined | null;
  if (!raw || typeof raw !== "object") return null;
  if (raw.enabled !== true) return null;
  if (typeof raw.start_date !== "string") {
    throw new Error("publishing.social.rotation.start_date ausente (esperado AAAA-MM-DD).");
  }
  const start = parseIsoCivilDate(raw.start_date, "publishing.social.rotation.start_date");
  let end: CivilDate | null = null;
  if (raw.end_date !== undefined && raw.end_date !== null) {
    if (typeof raw.end_date !== "string") throw new Error("publishing.social.rotation.end_date não é string.");
    end = parseIsoCivilDate(raw.end_date, "publishing.social.rotation.end_date");
    if (civilDayNumber(end) < civilDayNumber(start)) {
      throw new Error(`publishing.social.rotation.end_date (${raw.end_date}) antes de start_date (${raw.start_date}).`);
    }
  }
  return {
    start,
    end,
    weekday: readCandidates(raw.weekday_candidates, "weekday_candidates", ROTATION_POST_TYPES.length),
    weekend: readCandidates(raw.weekend_candidates, "weekend_candidates", 1),
    article: readCandidates(raw.linkedin_weekly_article_candidates, "linkedin_weekly_article_candidates", 0),
  };
}

function inWindow(rot: SocialRotation, date: CivilDate): boolean {
  const n = civilDayNumber(date);
  if (n < civilDayNumber(rot.start)) return false;
  if (rot.end && n > civilDayNumber(rot.end)) return false;
  return true;
}

/** Pure: quantos dias úteis (seg–sex) existem em `[from, to)`. */
export function countWeekdaysBetween(from: CivilDate, to: CivilDate): number {
  const a = civilDayNumber(from);
  const b = civilDayNumber(to);
  if (b <= a) return 0;
  const total = b - a;
  const fullWeeks = Math.floor(total / 7);
  let count = fullWeeks * 5;
  // 1970-01-01 (dia 0) foi quinta → getUTCDay = (n + 4) mod 7.
  for (let n = a + fullWeeks * 7; n < b; n++) {
    const wd = (((n + 4) % 7) + 7) % 7;
    if (wd !== 0 && wd !== 6) count++;
  }
  return count;
}

/** Pure: semanas inteiras entre a segunda-feira da semana de `start` e `date`. */
export function weekIndexSince(start: CivilDate, date: CivilDate): number {
  const s = civilDayNumber(start);
  const mondayOfStart = s - ((civilWeekday(start) + 6) % 7);
  return Math.floor((civilDayNumber(date) - mondayOfStart) / 7);
}

export interface WeekdayRotationSlot {
  time: string;
  /** Dia útil nº `weekdayIndex` desde `start_date` (0-based). */
  weekdayIndex: number;
  /** Ciclo completo nº `cycle` (cada ciclo = N dias úteis, N = nº de candidatos). */
  cycle: number;
  candidateIndex: number;
}

/**
 * Pure: horário do post `type` publicado em `date` (dia útil). `null` quando a
 * rotação não se aplica (desligada, fora da janela, sábado/domingo).
 */
export function weekdayRotationSlot(
  rot: SocialRotation | null,
  date: CivilDate,
  type: RotationPostType,
): WeekdayRotationSlot | null {
  if (!rot || !inWindow(rot, date)) return null;
  const wd = civilWeekday(date);
  if (wd === 0 || wd === 6) return null;
  const t = ROTATION_POST_TYPES.indexOf(type);
  if (t < 0) return null;
  const n = rot.weekday.length;
  const stride = Math.floor(n / ROTATION_POST_TYPES.length);
  const k = countWeekdaysBetween(rot.start, date);
  const candidateIndex = (k + t * stride) % n;
  return { time: rot.weekday[candidateIndex], weekdayIndex: k, cycle: Math.floor(k / n), candidateIndex };
}

export interface WeekRotationSlot {
  time: string;
  weekIndex: number;
  candidateIndex: number;
}

/**
 * Pure: horário do carrossel semanal publicado em `date` (sábado ou domingo).
 * `null` fora da rotação ou em dia útil.
 */
export function weekendRotationSlot(rot: SocialRotation | null, date: CivilDate): WeekRotationSlot | null {
  if (!rot || !inWindow(rot, date)) return null;
  const wd = civilWeekday(date);
  if (wd !== 0 && wd !== 6) return null;
  const m = rot.weekend.length;
  const w = weekIndexSince(rot.start, date);
  const candidateIndex = wd === 6 ? w % m : (w + Math.floor(m / 2)) % m;
  return { time: rot.weekend[candidateIndex], weekIndex: w, candidateIndex };
}

/**
 * Pure: horário do artigo semanal do LinkedIn (`/diaria-linkedin-semanal`)
 * publicado em `date` (a segunda-feira). `null` fora da rotação, sem
 * candidatos de artigo, ou se `date` não for segunda.
 */
export function linkedinArticleRotationSlot(rot: SocialRotation | null, date: CivilDate): WeekRotationSlot | null {
  if (!rot || rot.article.length === 0 || !inWindow(rot, date)) return null;
  if (civilWeekday(date) !== 1) return null;
  const w = weekIndexSince(rot.start, date);
  const candidateIndex = w % rot.article.length;
  return { time: rot.article[candidateIndex], weekIndex: w, candidateIndex };
}

// ── Plano consultável ──────────────────────────────────────────────────────

export type RotationPlanRow =
  | { date: string; kind: "weekday"; type: RotationPostType; time: string; source: "rotation" | "base"; weekday_index?: number; cycle?: number }
  | { date: string; kind: "weekend"; day: "sabado" | "domingo"; time: string; source: "rotation" | "base"; week_index?: number }
  | { date: string; kind: "linkedin_article"; time: string; source: "rotation" | "base"; week_index?: number };

/** Horários fixos (fora da rotação) — vêm do config/constantes dos consumidores. */
export interface BaseTimes {
  weekday: Record<RotationPostType, string | null>;
  weekend: string;
  linkedinArticle: string | null;
}

/**
 * Pure: plano completo `[from, to]` (inclusivo) — o que cada post recebe em
 * cada dia, com `source` dizendo se veio da rotação ou do horário fixo. É o
 * registro consultável do teste (#10305): reconstruível a qualquer momento a
 * partir do config versionado, e cruzável com `06-social-published.json`
 * (horário real de cada canal) na medição.
 */
export function buildRotationPlan(rot: SocialRotation | null, base: BaseTimes, from: CivilDate, to: CivilDate): RotationPlanRow[] {
  const rows: RotationPlanRow[] = [];
  for (let n = civilDayNumber(from); n <= civilDayNumber(to); n++) {
    const d = civilFromDayNumber(n);
    const date = formatCivilDate(d);
    const wd = civilWeekday(d);
    if (wd === 0 || wd === 6) {
      const s = weekendRotationSlot(rot, d);
      rows.push(
        s
          ? { date, kind: "weekend", day: wd === 6 ? "sabado" : "domingo", time: s.time, source: "rotation", week_index: s.weekIndex }
          : { date, kind: "weekend", day: wd === 6 ? "sabado" : "domingo", time: base.weekend, source: "base" },
      );
      continue;
    }
    if (wd === 1) {
      const a = linkedinArticleRotationSlot(rot, d);
      if (a) rows.push({ date, kind: "linkedin_article", time: a.time, source: "rotation", week_index: a.weekIndex });
      else if (base.linkedinArticle) rows.push({ date, kind: "linkedin_article", time: base.linkedinArticle, source: "base" });
    }
    for (const type of ROTATION_POST_TYPES) {
      // #10427: sem horário fixo o post está desligado — `computeScheduledAt`
      // valida o fixo ANTES de aplicar a rotação e lança, então nada é agendado
      // (o caso real é o Use Melhor sem `use_melhor_time`). Gerar a linha de
      // rotação aqui faria o registro e `weekdayCoverage` contarem como coberta
      // uma célula que nunca recebeu post.
      if (!base.weekday[type]) continue;
      const s = weekdayRotationSlot(rot, d, type);
      if (s) rows.push({ date, kind: "weekday", type, time: s.time, source: "rotation", weekday_index: s.weekdayIndex, cycle: s.cycle });
      else rows.push({ date, kind: "weekday", type, time: base.weekday[type] as string, source: "base" });
    }
  }
  return rows;
}

/**
 * Pure: matriz de cobertura do dia útil — quantos posts de cada tipo caem em
 * cada candidato dentro do plano. O teste está completo quando toda célula
 * tem ≥ 1 (critério do comentário de 15/10: "até cada horário ter recebido
 * todos os tipos").
 */
export function weekdayCoverage(rot: SocialRotation, rows: RotationPlanRow[]): Record<string, Record<RotationPostType, number>> {
  const out: Record<string, Record<RotationPostType, number>> = {};
  for (const c of rot.weekday) out[c] = { um: 0, d1: 0, d2: 0, d3: 0 };
  for (const r of rows) {
    if (r.kind === "weekday" && r.source === "rotation" && out[r.time]) out[r.time][r.type]++;
  }
  return out;
}

// ── Leitura dos horários fixos a partir do config ──────────────────────────

interface SocialLike {
  rotation?: unknown;
  fallback_schedule?: { d1_time?: unknown; d2_time?: unknown; d3_time?: unknown } | null;
  use_melhor_time?: unknown;
  linkedin_weekly_article_time?: unknown;
  [k: string]: unknown;
}

function hhmmOrNull(v: unknown): string | null {
  return typeof v === "string" && HHMM_RE.test(v.trim()) ? v.trim() : null;
}

/** Pure: horários fixos (fora da rotação) lidos de `publishing.social`. */
export function baseTimesFromSocial(social: SocialLike | null | undefined): BaseTimes {
  const fs = social?.fallback_schedule ?? {};
  return {
    weekday: {
      um: hhmmOrNull(social?.use_melhor_time),
      d1: hhmmOrNull(fs.d1_time),
      d2: hhmmOrNull(fs.d2_time),
      d3: hhmmOrNull(fs.d3_time),
    },
    weekend: DEFAULT_WEEKLY_CAROUSEL_TIME,
    linkedinArticle: hhmmOrNull(social?.linkedin_weekly_article_time) ?? DEFAULT_LINKEDIN_WEEKLY_ARTICLE_TIME,
  };
}

/**
 * Pure: horário do artigo semanal do LinkedIn da segunda `date` — a fonte de
 * config que o Passo 9 de `/diaria-linkedin-semanal` consulta (#10305). Dentro
 * da rotação, o candidato da semana; fora dela,
 * `publishing.social.linkedin_weekly_article_time` (default 09:30).
 */
export function resolveLinkedinArticleTime(
  social: SocialLike | null | undefined,
  date: CivilDate,
): { time: string; source: "rotation" | "base"; weekIndex?: number } {
  const slot = linkedinArticleRotationSlot(readSocialRotation(social), date);
  if (slot) return { time: slot.time, source: "rotation", weekIndex: slot.weekIndex };
  return { time: baseTimesFromSocial(social).linkedinArticle ?? DEFAULT_LINKEDIN_WEEKLY_ARTICLE_TIME, source: "base" };
}

/**
 * Pure: data de PUBLICAÇÃO de uma edição diária (`AAMMDD` + `fallback_schedule.day_offset`),
 * a mesma conta de `computeScheduledAt`. `null` quando `edition` não é `AAMMDD` válido.
 * `dayOffsetOverride` (o `--day-offset` de `publish-facebook.ts`/`publish-linkedin.ts`)
 * vence o do config, como em `computeScheduledAt` (#10427); valor não inteiro é ignorado.
 */
export function publishDateForEdition(
  edition: string,
  social: SocialLike | null | undefined,
  dayOffsetOverride?: number,
): CivilDate | null {
  if (!/^\d{6}$/.test(edition)) return null;
  let d: CivilDate;
  try {
    d = parseIsoCivilDate(`20${edition.slice(0, 2)}-${edition.slice(2, 4)}-${edition.slice(4, 6)}`);
  } catch {
    return null;
  }
  const raw = (social?.fallback_schedule as { day_offset?: unknown } | null | undefined)?.day_offset;
  const offset =
    typeof dayOffsetOverride === "number" && Number.isInteger(dayOffsetOverride)
      ? dayOffsetOverride
      : typeof raw === "number" && Number.isInteger(raw)
        ? raw
        : 0;
  return offset === 0 ? d : civilFromDayNumber(civilDayNumber(d) + offset);
}

/**
 * Pure: horário que o post `type` da edição diária publicada em `date` vai
 * receber — o MESMO que `computeScheduledAt` usa (rotação do dia, senão o fixo).
 * Para as superfícies que só EXIBEM o horário (gate 4, preview social, Studio),
 * self-review #10417 finding 1: sem isto o editor via 07:45 no gate enquanto o
 * post saía no horário rotacionado. `time: null` = sem horário fixo (4º post
 * desligado). Config de rotação malformado lança, como em `readSocialRotation`.
 */
export function resolveDailyPostTime(
  social: SocialLike | null | undefined,
  date: CivilDate,
  type: RotationPostType,
): { time: string | null; base: string | null; source: "rotation" | "base" } {
  const base = baseTimesFromSocial(social).weekday[type];
  const slot = weekdayRotationSlot(readSocialRotation(social), date, type);
  if (slot) return { time: slot.time, base, source: "rotation" };
  return { time: base, base, source: "base" };
}
