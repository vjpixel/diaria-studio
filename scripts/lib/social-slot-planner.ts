/**
 * social-slot-planner.ts (#10819)
 *
 * Escolhe o horário de um post social novo olhando o que JÁ está agendado,
 * por conta. Regra do editor (22/10/2026):
 *
 *   1. Conta destino sem nada no dia → alinhar ao horário de um post já
 *      agendado de OUTRA conta (ex.: o Reels da página VJ pixel sai no mesmo
 *      horário de um post da diar.ia.br).
 *   2. Conta destino com posts no dia → o horário que melhor distribui o dia
 *      DAQUELA conta: maximiza a distância até o vizinho mais próximo (posts
 *      dela e as bordas da janela), respeitando um espaçamento mínimo. Nunca
 *      empilha nem cola.
 *
 * Premissas (registradas em `premise` de cada decisão; nenhuma veio do editor):
 *   - "Conta" = `{plataforma}:{página/perfil}` (`socialAccountKey`) — o
 *     Facebook da diar.ia.br e o Instagram da diar.ia.br são contas diferentes.
 *   - Regra 1, com vários horários de outras contas: o mais próximo do
 *     `preferredAt` (o horário que o caller usaria sem esta regra); empate ou
 *     sem `preferredAt` → o mais cedo.
 *   - Regra 2: espaçamento mínimo default 60 min, grade de 15 min a partir do
 *     início da janela; as bordas da janela contam como vizinhos (sem isso o
 *     fim da noite, longe de tudo, ganharia sempre). Empate na distância → horário que coincide com post de
 *     outra conta (regra 1 como desempate), depois o mais perto de
 *     `preferredAt`, depois o mais cedo. Ainda não há dado de pico de uso por
 *     conta; quando houver, entra como mais um critério de desempate.
 *   - Grade vazia (nenhuma conta com post no dia): `preferredAt` se cabe na
 *     janela; senão o meio da janela útil ("distribuir uniformemente" com um
 *     post só).
 *
 * Puro: sem I/O. Os adaptadores `gridFrom*` convertem os stores de edição
 * (`_internal/06-social-published.json`, `_internal/06-shorts-published.json`)
 * na grade; a fila do Worker/Buffer entra pelo mesmo formato quando o caller
 * a tiver.
 *
 * Consumidores previstos: `publish-shorts.ts` (horário do Reels por página),
 * depois os publishers do Stage 5 e as skills de divulgação.
 */

export interface ScheduledSlot {
  /** Chave da conta — ver `socialAccountKey`. */
  account: string;
  /** ISO 8601 do horário agendado/publicado. */
  at: string;
  /** Rótulo livre pra log (ex.: "instagram d1"). */
  label?: string;
}

export interface SlotRequest {
  account: string;
  /** Janela do dia em que o post pode sair (ISO, inclusiva nas duas pontas). */
  window: { start: string; end: string };
  /** Horário que o caller usaria sem a regra (ex.: 06:00 dos Reels). */
  preferredAt?: string;
  /** Nada antes disto (ex.: agora + folga de agendamento). */
  notBefore?: string;
  /** Espaçamento mínimo entre posts da mesma conta (default 60). */
  minGapMinutes?: number;
  /** Passo da grade de candidatos na regra 2 (default 15). */
  stepMinutes?: number;
}

export type SlotRule = "align-other-account" | "spread-same-account" | "empty-grid" | "no-slot";

export interface SlotDecision {
  account: string;
  /** ISO UTC do horário escolhido; `null` só em `no-slot`. */
  at: string | null;
  rule: SlotRule;
  premise: string;
  warning?: string;
}

export const DEFAULT_MIN_GAP_MINUTES = 60;
export const DEFAULT_STEP_MINUTES = 15;
const MIN = 60_000;

/** Chave de conta: `facebook:diaria`, `instagram:vjpixel`, `linkedin:diaria`… */
export function socialAccountKey(platform: string, page?: string | null): string {
  return `${platform.toLowerCase()}:${(page || "diaria").toLowerCase()}`;
}

/** Janela de um dia em BRT (UTC−3, sem horário de verão desde 2019). */
export function brtDayWindow(aammdd: string, startHHMM = "06:00", endHHMM = "22:00"): { start: string; end: string } {
  if (!/^\d{6}$/.test(aammdd)) throw new Error(`aammdd inválido: ${aammdd}`);
  const date = `20${aammdd.slice(0, 2)}-${aammdd.slice(2, 4)}-${aammdd.slice(4, 6)}`;
  const iso = (hhmm: string) => new Date(`${date}T${hhmm}:00-03:00`).toISOString();
  return { start: iso(startHHMM), end: iso(endHHMM) };
}

function ms(iso: string, field: string): number {
  const v = Date.parse(iso);
  if (Number.isNaN(v)) throw new Error(`${field}: data inválida (${iso})`);
  return v;
}

const hhmmBrt = (t: number) => new Date(t - 3 * 60 * MIN).toISOString().slice(11, 16);

/**
 * Decide o horário de UM post novo contra a grade existente. Lança em data
 * inválida (input malformado é bug do caller, não "sem horário").
 */
export function planSlot(grid: readonly ScheduledSlot[], req: SlotRequest): SlotDecision {
  const start = ms(req.window.start, "window.start");
  const end = ms(req.window.end, "window.end");
  if (end < start) throw new Error("window.end antes de window.start");
  const notBefore = req.notBefore ? ms(req.notBefore, "notBefore") : -Infinity;
  const lo = Math.max(start, notBefore);
  const preferred = req.preferredAt ? ms(req.preferredAt, "preferredAt") : null;
  const minGap = (req.minGapMinutes ?? DEFAULT_MIN_GAP_MINUTES) * MIN;
  const step = (req.stepMinutes ?? DEFAULT_STEP_MINUTES) * MIN;
  if (step <= 0) throw new Error("stepMinutes deve ser > 0");

  const base = { account: req.account };
  if (lo > end) {
    return { ...base, at: null, rule: "no-slot", premise: "a janela do dia já passou (notBefore depois do fim da janela)" };
  }

  const inWindow = (t: number) => t >= lo && t <= end;
  // Posts da própria conta contam no dia inteiro da janela, inclusive os que
  // já passaram de `notBefore` — o espaçamento vale contra eles também.
  const dayTimes = grid
    .map((s) => ({ ...s, t: ms(s.at, `grid[${s.account}].at`) }))
    .filter((s) => s.t >= start && s.t <= end);
  const same = dayTimes.filter((s) => s.account === req.account).map((s) => s.t);
  const others = [...new Set(dayTimes.filter((s) => s.account !== req.account).map((s) => s.t))].sort((a, b) => a - b);
  const distToPreferred = (t: number) => (preferred === null ? 0 : Math.abs(t - preferred));

  if (same.length === 0) {
    const aligned = others.filter(inWindow);
    if (aligned.length > 0) {
      const at = [...aligned].sort((a, b) => distToPreferred(a) - distToPreferred(b) || a - b)[0];
      return {
        ...base,
        at: new Date(at).toISOString(),
        rule: "align-other-account",
        premise:
          `conta sem post no dia: alinhado ao horário de outra conta (${hhmmBrt(at)} BRT)` +
          (preferred === null ? ", o mais cedo disponível" : `, o mais perto do preferido ${hhmmBrt(preferred)} BRT`),
      };
    }
    if (preferred !== null && inWindow(preferred)) {
      return { ...base, at: new Date(preferred).toISOString(), rule: "empty-grid", premise: "grade vazia: horário preferido do caller" };
    }
    const mid = lo + Math.floor((end - lo) / 2 / step) * step;
    return {
      ...base,
      at: new Date(mid).toISOString(),
      rule: "empty-grid",
      premise: `grade vazia e sem horário preferido na janela: meio da janela útil (${hhmmBrt(mid)} BRT)`,
    };
  }

  const candidates = new Set<number>();
  for (let t = start; t <= end; t += step) if (inWindow(t)) candidates.add(t);
  for (const t of others) if (inWindow(t)) candidates.add(t);
  if (candidates.size === 0) {
    return { ...base, at: null, rule: "no-slot", premise: "nenhum horário da grade cabe na janela" };
  }
  const othersSet = new Set(others);
  // Pontuação: distância ao vizinho mais próximo contando as BORDAS da janela
  // como vizinhos — senão a borda (22:00, longe de tudo) vence sempre e o post
  // vai pro fim da noite em vez de dividir o maior intervalo do dia.
  // `real` (só posts da conta) é o que decide o aviso de espaçamento.
  const scored = [...candidates].map((t) => {
    const real = Math.min(...same.map((s) => Math.abs(t - s)));
    return { t, real, d: Math.min(real, t - start, end - t) };
  });
  scored.sort(
    (a, b) =>
      b.d - a.d ||
      Number(othersSet.has(b.t)) - Number(othersSet.has(a.t)) ||
      distToPreferred(a.t) - distToPreferred(b.t) ||
      a.t - b.t,
  );
  const best = scored[0];
  const decision: SlotDecision = {
    ...base,
    at: new Date(best.t).toISOString(),
    rule: "spread-same-account",
    premise:
      `conta com ${same.length} post(s) no dia: ${hhmmBrt(best.t)} BRT fica a ${Math.round(best.real / MIN)} min do post mais próximo dela` +
      (othersSet.has(best.t) ? ", alinhado a post de outra conta" : ""),
  };
  if (best.real < minGap) {
    decision.warning = `nenhum horário na janela respeita o espaçamento mínimo de ${minGap / MIN} min — escolhido o mais espaçado (${Math.round(best.real / MIN)} min)`;
  }
  return decision;
}

/**
 * Vários posts novos em sequência: cada horário escolhido entra na grade antes
 * do próximo, então dois posts da mesma conta nunca caem colados.
 */
export function planSlots(grid: readonly ScheduledSlot[], reqs: readonly SlotRequest[]): SlotDecision[] {
  const acc: ScheduledSlot[] = [...grid];
  return reqs.map((req) => {
    const d = planSlot(acc, req);
    if (d.at) acc.push({ account: d.account, at: d.at, label: "planejado" });
    return d;
  });
}

// ── Adaptadores dos stores da edição ────────────────────────────────────────

const LIVE_STATUSES = new Set(["scheduled", "published"]);

/**
 * `_internal/06-social-published.json` → grade. Só entradas agendadas ou
 * publicadas com horário; `failed`/`skipped`/`draft` não ocupam slot. Sem
 * `page` = página default `diaria` (mesma regra de `resolvePostPage`).
 */
export function gridFromSocialPublished(data: unknown): ScheduledSlot[] {
  const posts = (data as { posts?: unknown })?.posts;
  if (!Array.isArray(posts)) return [];
  const out: ScheduledSlot[] = [];
  for (const p of posts as Array<Record<string, unknown>>) {
    if (typeof p.platform !== "string" || typeof p.status !== "string" || !LIVE_STATUSES.has(p.status)) continue;
    const at = typeof p.scheduled_at === "string" ? p.scheduled_at : typeof p.published_at === "string" ? p.published_at : null;
    if (!at || Number.isNaN(Date.parse(at))) continue;
    out.push({
      account: socialAccountKey(p.platform, typeof p.page === "string" ? p.page : null),
      at,
      label: `${p.platform} ${String(p.destaque ?? "")}`.trim(),
    });
  }
  return out;
}

/**
 * `_internal/06-shorts-published.json` → grade. Destinos `facebook:{slug}` já
 * são chaves de conta; `instagram` vira `instagram:{instagramAccount}` (a
 * autora do Reels, `publishing.shorts.instagram_author_page` — `diaria` quando
 * nulo). Destinos guiados sem horário (`youtube_shorts`, `facebook_profile`)
 * entram com `at` quando registrados e viram contas próprias.
 */
export function gridFromShortsPublished(data: unknown, instagramAccount = "diaria"): ScheduledSlot[] {
  const entries = (data as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) return [];
  const out: ScheduledSlot[] = [];
  for (const e of entries as Array<Record<string, unknown>>) {
    if (typeof e.destination !== "string") continue;
    const at = typeof e.scheduled_at === "string" && e.scheduled_at ? e.scheduled_at : typeof e.at === "string" ? e.at : null;
    if (!at || Number.isNaN(Date.parse(at))) continue;
    const account = e.destination === "instagram"
      ? socialAccountKey("instagram", instagramAccount)
      : e.destination.includes(":")
        ? e.destination.toLowerCase()
        : socialAccountKey(e.destination, "diaria");
    out.push({ account, at, label: `shorts ${e.destination}` });
  }
  return out;
}
