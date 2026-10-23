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
 * Critério da regra 2 (decisão do editor no briefing do overnight 261022b,
 * comentário na #10819): **espaçamento mínimo de 2 h** entre posts da mesma
 * conta + **preferência pelos picos de uso**. Ordem de escolha:
 *   (a) horários que respeitam o espaçamento mínimo vêm antes dos que não
 *       respeitam (se nenhum respeita, escolhe o mais espaçado e avisa);
 *   (b) entre eles, os que caem num pico de uso (`peakWindows`);
 *   (c) depois, o que mais distribui o dia (distância ao vizinho mais próximo,
 *       contando as bordas da janela);
 *   (d) depois, o que coincide com post de outra conta (regra 1 como
 *       desempate), o mais perto de `preferredAt`, o mais cedo.
 *
 * Premissas (registradas em `premise` de cada decisão; não vieram do editor):
 *   - "Conta" = `{plataforma}:{página/perfil}` (`socialAccountKey`) — o
 *     Facebook da diar.ia.br e o Instagram da diar.ia.br são contas diferentes.
 *   - Regra 1, com vários horários de outras contas: o mais próximo do
 *     `preferredAt` (o horário que o caller usaria sem esta regra); empate ou
 *     sem `preferredAt` → o mais cedo. Pico não pesa na regra 1: o editor pediu
 *     alinhar a um post existente, e esse horário já foi escolhido por alguém.
 *   - Picos default (`DEFAULT_PEAK_WINDOWS_BRT`): 07:00–09:00, 12:00–14:00 e
 *     18:00–21:00 BRT, inclusivos — deslocamento da manhã, almoço e noite, o
 *     padrão geral de uso de rede social no Brasil. Não há dado de pico POR
 *     CONTA no projeto; quando houver, o caller passa `peakWindows`.
 *   - Grade de 15 min a partir do início da janela; as bordas da janela contam
 *     como vizinhos em (c) (sem isso o fim da noite, longe de tudo, ganharia
 *     sempre) mas não em (a): espaçamento mínimo é só entre posts.
 *   - Grade vazia (nenhuma conta com post no dia): `preferredAt` se cabe na
 *     janela; senão o meio da janela útil ("distribuir uniformemente" com um
 *     post só).
 *
 * Collab do Instagram (decisão do editor, /diaria-desbloqueia 261023): o Reels
 * que sai na conta do editor com a @diar.ia.br em collab aparece no feed das
 * duas, então CONTA como post da @diar.ia.br no espaçamento mínimo. No modelo:
 * `alsoAccounts` (no slot da grade e no pedido) lista as contas em que o post
 * também aparece; "mesma conta" passa a ser "compartilha alguma conta". A
 * conta de um username de collab sai de `instagramCollabAccountKey`.
 *
 * Fontes da grade: os stores da edição (`gridFromSocialPublished`,
 * `gridFromShortsPublished`, `gridFromLinkedInPersonalIntent`) e a fila do
 * Worker (`gridFromWorkerQueue`, `GET /list`), que também traz o que as skills
 * de divulgação agendaram e nenhum store da edição registra. `mergeGrids`
 * junta as fontes sem duplicar o post que aparece em duas delas.
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
  /** Outras contas em que o post também aparece (collab do Instagram) — conta como post de cada uma. */
  alsoAccounts?: readonly string[];
}

export interface SlotRequest {
  account: string;
  /** Outras contas em que o post novo também vai aparecer (collab) — o espaçamento vale contra os posts delas. */
  alsoAccounts?: readonly string[];
  /** Janela do dia em que o post pode sair (ISO, inclusiva nas duas pontas). */
  window: { start: string; end: string };
  /** Horário que o caller usaria sem a regra (ex.: 06:00 dos Reels). */
  preferredAt?: string;
  /** Nada antes disto (ex.: agora + folga de agendamento). */
  notBefore?: string;
  /** Espaçamento mínimo entre posts da mesma conta (default 120, decisão do editor). */
  minGapMinutes?: number;
  /** Picos de uso, `HH:MM` BRT inclusivos (default `DEFAULT_PEAK_WINDOWS_BRT`; `[]` desliga). */
  peakWindows?: readonly PeakWindow[];
  /** Passo da grade de candidatos na regra 2 (default 15). */
  stepMinutes?: number;
}

export type SlotRule = "align-other-account" | "spread-same-account" | "empty-grid" | "no-slot";

export interface SlotDecision {
  account: string;
  /** Repete `SlotRequest.alsoAccounts` (quando havia) pra o slot planejado entrar na grade com elas. */
  alsoAccounts?: readonly string[];
  /** ISO UTC do horário escolhido; `null` só em `no-slot`. */
  at: string | null;
  rule: SlotRule;
  premise: string;
  warning?: string;
}

export interface PeakWindow {
  /** `HH:MM` BRT. */
  start: string;
  /** `HH:MM` BRT, inclusivo. */
  end: string;
}

/** Decisão do editor (#10819, briefing 261022b): 2 h entre posts da mesma conta. */
export const DEFAULT_MIN_GAP_MINUTES = 120;
/** Premissa (#10819): manhã, almoço e noite — sem dado de pico por conta ainda. */
export const DEFAULT_PEAK_WINDOWS_BRT: readonly PeakWindow[] = Object.freeze([
  Object.freeze({ start: "07:00", end: "09:00" }),
  Object.freeze({ start: "12:00", end: "14:00" }),
  Object.freeze({ start: "18:00", end: "21:00" }),
]);
const PEAK_HHMM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export const DEFAULT_STEP_MINUTES = 15;
const MIN = 60_000;

/** Chave de conta: `facebook:diaria`, `instagram:vjpixel`, `linkedin:diaria`… */
export function socialAccountKey(platform: string, page?: string | null): string {
  return `${platform.toLowerCase()}:${(page || "diaria").toLowerCase()}`;
}

/**
 * Username do Instagram (collab) → slug de conta da grade. Premissa: a
 * @diar.ia.br é a conta `diaria` (a do env `INSTAGRAM_BUSINESS_ACCOUNT_ID`,
 * mesma chave do `ig_account` da fila do Worker); outro username vira o próprio
 * slug, em minúsculas (a @vjpixel é `vjpixel`).
 */
const INSTAGRAM_USERNAME_SLUGS: Readonly<Record<string, string>> = Object.freeze({ "diar.ia.br": "diaria" });

export function instagramCollabAccountKey(username: string): string {
  const u = username.replace(/^@/, "").toLowerCase();
  return socialAccountKey("instagram", INSTAGRAM_USERNAME_SLUGS[u] ?? u);
}

/** Contas da grade dos collabs de um post, sem repetir a conta autora. */
export function instagramCollabAccounts(collaborators: readonly string[] | undefined, authorAccount: string): string[] {
  const out: string[] = [];
  for (const c of collaborators ?? []) {
    if (typeof c !== "string" || !c.trim()) continue;
    const k = instagramCollabAccountKey(c.trim());
    if (k !== authorAccount && !out.includes(k)) out.push(k);
  }
  return out;
}

/** Todas as contas em que um post aparece (a dele + collabs). */
export function slotAccounts(s: { account: string; alsoAccounts?: readonly string[] }): string[] {
  return [s.account, ...(s.alsoAccounts ?? [])];
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

  const also = (req.alsoAccounts ?? []).filter((a) => a !== req.account);
  const base: Pick<SlotDecision, "account" | "alsoAccounts"> = also.length ? { account: req.account, alsoAccounts: also } : { account: req.account };
  const mine = new Set([req.account, ...also]);
  const sharesAccount = (s: ScheduledSlot) => slotAccounts(s).some((a) => mine.has(a));
  if (lo > end) {
    return { ...base, at: null, rule: "no-slot", premise: "a janela do dia já passou (notBefore depois do fim da janela)" };
  }

  const inWindow = (t: number) => t >= lo && t <= end;
  // Posts da própria conta contam no dia inteiro da janela, inclusive os que
  // já passaram de `notBefore` — o espaçamento vale contra eles também.
  const dayTimes = grid
    .map((s) => ({ ...s, t: ms(s.at, `grid[${s.account}].at`) }))
    .filter((s) => s.t >= start && s.t <= end);
  // "Mesma conta" = compartilha alguma conta com o post novo (collab conta, #10819 261023).
  const same = dayTimes.filter(sharesAccount).map((s) => s.t);
  const others = [...new Set(dayTimes.filter((s) => !sharesAccount(s)).map((s) => s.t))].sort((a, b) => a - b);
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
  const peaks = req.peakWindows ?? DEFAULT_PEAK_WINDOWS_BRT;
  for (const w of peaks) {
    if (!PEAK_HHMM_RE.test(w.start) || !PEAK_HHMM_RE.test(w.end) || w.end < w.start) {
      throw new Error(`peakWindows: janela inválida ${JSON.stringify(w)} (HH:MM, end >= start)`);
    }
  }
  const inPeak = (t: number) => {
    const h = hhmmBrt(t);
    return peaks.some((w) => h >= w.start && h <= w.end);
  };
  // `real` = distância ao post mais próximo DA CONTA: decide o espaçamento
  // mínimo (a) e o aviso. `d` conta também as BORDAS da janela como vizinhos —
  // senão a borda (22:00, longe de tudo) vence (c) sempre e o post vai pro fim
  // da noite em vez de dividir o maior intervalo do dia.
  const scored = [...candidates].map((t) => {
    const real = Math.min(...same.map((s) => Math.abs(t - s)));
    return { t, real, ok: real >= minGap, peak: inPeak(t), d: Math.min(real, t - start, end - t) };
  });
  scored.sort(
    (a, b) =>
      Number(b.ok) - Number(a.ok) ||
      (b.ok ? Number(b.peak) - Number(a.peak) : 0) ||
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
      `conta com ${same.length} post(s) no dia${also.length ? ` (contando ${also.join(", ")}, em collab)` : ""}: ${hhmmBrt(best.t)} BRT fica a ${Math.round(best.real / MIN)} min do post mais próximo dela` +
      (best.ok && best.peak ? ", em pico de uso" : "") +
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
    if (d.at) acc.push({ account: d.account, at: d.at, label: "planejado", ...(d.alsoAccounts ? { alsoAccounts: d.alsoAccounts } : {}) });
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
 *
 * `instagramCollaborators` (usernames, `publishing.shorts.instagram_collaborators`):
 * o store não grava os collabs, então o caller passa os da config; o Reels
 * registrado ocupa também a conta de cada collab (decisão do editor 261023).
 */
export function gridFromShortsPublished(data: unknown, instagramAccount = "diaria", instagramCollaborators: readonly string[] = []): ScheduledSlot[] {
  const entries = (data as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) return [];
  const out: ScheduledSlot[] = [];
  for (const e of entries as Array<Record<string, unknown>>) {
    if (typeof e.destination !== "string") continue;
    const at = typeof e.scheduled_at === "string" && e.scheduled_at ? e.scheduled_at : typeof e.at === "string" ? e.at : null;
    if (!at || Number.isNaN(Date.parse(at))) continue;
    const account = e.destination === "instagram"
      ? socialAccountKey("instagram", instagramAccount)
      : SHORTS_DESTINATION_ACCOUNTS[e.destination] ??
        (e.destination.includes(":") ? e.destination.toLowerCase() : socialAccountKey(e.destination, "diaria"));
    const also = e.destination === "instagram" ? instagramCollabAccounts(instagramCollaborators, account) : [];
    out.push({ account, at, label: `shorts ${e.destination}`, ...(also.length ? { alsoAccounts: also } : {}) });
  }
  return out;
}

/**
 * Destinos do vertical cujo id não é chave de conta (#10772): o vídeo do perfil
 * pessoal do LinkedIn, o repost dele pela página e o X @diariabr (que nos
 * stores diários é `platform: "twitter"`).
 */
const SHORTS_DESTINATION_ACCOUNTS: Readonly<Record<string, string>> = Object.freeze({
  linkedin_profile: socialAccountKey("linkedin", "pessoal"),
  linkedin_page_repost: socialAccountKey("linkedin", "diaria"),
  x: socialAccountKey("twitter", "diaria"),
});

/**
 * `_internal/06-linkedin-personal.json` (#9568, o 4º post no perfil pessoal) →
 * grade da conta `linkedin:pessoal` (#10772). Só intenção armada ou publicada
 * ocupa slot; o resto (falhou, expirou, ambíguo) fica de fora.
 */
export function gridFromLinkedInPersonalIntent(data: unknown): ScheduledSlot[] {
  const intent = data as { status?: unknown; scheduled_at?: unknown; published_at?: unknown } | null;
  if (!intent || (intent.status !== "armed" && intent.status !== "posting" && intent.status !== "published")) return [];
  const at = typeof intent.published_at === "string" && intent.published_at ? intent.published_at : intent.scheduled_at;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return [];
  return [{ account: socialAccountKey("linkedin", "pessoal"), at, label: "linkedin pessoal (4º post)" }];
}

/**
 * Fila do Worker `linkedin-cron` (`GET /list`, `{ count, items }`) → grade
 * (#10819). Traz o que nenhum store da edição registra: os posts que as skills
 * de divulgação (mensal-apoiadores, anual, artigo especial) e o semanal
 * agendaram pelo Worker para o mesmo dia. Mapeamento (o mesmo do Worker):
 *   - `channel` ausente = `linkedin`; `webhook_target: "pixel"` = perfil
 *     pessoal (`linkedin:pessoal`), o resto a página (`linkedin:diaria`);
 *   - `instagram` → `instagram:{ig_account ?? "diaria"}`, com os
 *     `collaborators` da entry em `alsoAccounts`;
 *   - `threads` → `threads:diaria`;
 *   - `action: "comment"` fica de fora: comentário não é post no feed.
 * Entry sem `scheduled_at` válido é ignorada. Resposta sem `items` = grade
 * vazia (o caller decide se avisa).
 */
export function gridFromWorkerQueue(data: unknown): ScheduledSlot[] {
  const items = (data as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const out: ScheduledSlot[] = [];
  for (const raw of items as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== "object") continue;
    if (raw.action === "comment") continue;
    const at = raw.scheduled_at;
    if (typeof at !== "string" || Number.isNaN(Date.parse(at))) continue;
    const channel = typeof raw.channel === "string" ? raw.channel : "linkedin";
    let account: string;
    let also: string[] = [];
    if (channel === "instagram") {
      account = socialAccountKey("instagram", typeof raw.ig_account === "string" ? raw.ig_account : "diaria");
      also = instagramCollabAccounts(Array.isArray(raw.collaborators) ? (raw.collaborators as string[]) : [], account);
    } else if (channel === "threads") {
      account = socialAccountKey("threads", "diaria");
    } else if (channel === "linkedin") {
      account = socialAccountKey("linkedin", raw.webhook_target === "pixel" ? "pessoal" : "diaria");
    } else {
      continue;
    }
    const label = `fila ${channel}${typeof raw.destaque === "string" ? ` ${raw.destaque}` : ""}`;
    out.push({ account, at, label, ...(also.length ? { alsoAccounts: also } : {}) });
  }
  return out;
}

/**
 * Junta grades de fontes diferentes sem contar duas vezes o mesmo post: o post
 * diário agendado pelo Worker está no store da edição E na fila. Chave = conta
 * + instante (ms); a primeira ocorrência fica, com a união dos `alsoAccounts`.
 */
export function mergeGrids(...grids: ReadonlyArray<readonly ScheduledSlot[]>): ScheduledSlot[] {
  const byKey = new Map<string, ScheduledSlot>();
  for (const grid of grids) {
    for (const s of grid) {
      const t = Date.parse(s.at);
      const key = `${s.account}@${Number.isNaN(t) ? s.at : t}`;
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, { ...s });
        continue;
      }
      const also = [...new Set([...(prev.alsoAccounts ?? []), ...(s.alsoAccounts ?? [])])].filter((a) => a !== prev.account);
      if (also.length) prev.alsoAccounts = also;
    }
  }
  return [...byKey.values()];
}
