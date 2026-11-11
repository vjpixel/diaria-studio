/**
 * scripts/lib/mandala-semana.ts (#12347)
 *
 * Núcleo PURO do formulário semanal do Desafio Mandala Mão na Massa
 * (skill `/diaria-mandala-semana`). Nenhuma chamada de rede nem de disco:
 * o fetch do Tally, da Graph API e a leitura dos JSONL moram em
 * `scripts/mandala-semana.ts`.
 *
 * ## O que é decidido aqui (regras do editor na #12347)
 *
 * - Perfil do desafio: @diar.ia.br.
 * - O link de cada dia é o **1º conteúdo publicado no dia no Instagram**, dia
 *   contado em BRT (America/Sao_Paulo). Inclui os reels em collab do @vjpixel
 *   que aparecem no grid do @diar.ia.br.
 * - Extras = todos os demais posts do período.
 * - O período e as datas vêm do próprio formulário (títulos "Link do conteúdo
 *   do dia N (DD/MM)" e o texto "período de DD/MM até DD/MM"), nunca de valor
 *   fixo: o formulário muda de semana em semana.
 *
 * ## Collabs não vêm da Graph API (medido em 11/11/2026)
 *
 * `GET /{ig-user-id}/media` devolveu todos os posts próprios da semana 2
 * (29/10–04/11), batendo com a planilha montada à mão, mas NÃO devolveu os 2
 * reels em collab publicados pelo @vjpixel (DfExeVVqem3, DfHwG0uKZW8). Por isso
 * collab entra como dado do editor (`parseCollabArg`), com o horário dito por
 * ele: nada de ler o grid nem decodificar shortcode (a coleta só usa API
 * oficial, comentário de 06/11 na issue).
 */

export const MANDALA_TIMEZONE = "America/Sao_Paulo";
export const MANDALA_ACCOUNT = "diar.ia.br";

/** Uma pergunta de link de dia do formulário: "Link do conteúdo do dia 9 (29/10)". */
export interface TallyDayQuestion {
  /** Número do dia no desafio (9, 10, ...). */
  dayNum: number;
  /** `DD/MM` como aparece no título. */
  ddmm: string;
  /** Título da pergunta, para casar pelo texto (nunca pela posição) ao preencher. */
  question: string;
}

export interface TallyForm {
  /** Título do formulário, ex. "Desafio Mandala Mão na Massa - Semana 2". */
  title: string | null;
  /** Número da semana tirado do título, quando houver. */
  semana: number | null;
  /** Perguntas de link por dia, em ordem de `dayNum`, sem repetição. */
  days: TallyDayQuestion[];
  /** "período de DD/MM até DD/MM" da pergunta de seguidores. */
  period: { from: string; to: string } | null;
}

function decodeBasicEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/\\u([0-9a-f]{4})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Lê a estrutura do formulário a partir do HTML que o Tally devolve num GET
 * simples (verificado em 06/11/2026 e 11/11/2026: a página traz o JSON do
 * formulário inteiro). Nunca lança; sem perguntas de dia, `days` vem vazio e
 * quem chama decide cair para o navegador. @pure
 */
export function parseTallyForm(html: string): TallyForm {
  const text = decodeBasicEntities(html);
  const days = new Map<number, TallyDayQuestion>();
  const dayRe = /Link do conte[uú]do do dia\s+(\d{1,3})\s*\((\d{1,2})\/(\d{1,2})\)/gi;
  for (const m of text.matchAll(dayRe)) {
    const dayNum = Number(m[1]);
    if (days.has(dayNum)) continue;
    const ddmm = `${m[2].padStart(2, "0")}/${m[3].padStart(2, "0")}`;
    days.set(dayNum, { dayNum, ddmm, question: m[0].replace(/\s+/g, " ") });
  }
  const periodM = /per[ií]odo de\s+(\d{1,2})\/(\d{1,2})\s+at[ée]\s+(\d{1,2})\/(\d{1,2})/i.exec(text);
  const period = periodM
    ? {
        from: `${periodM[1].padStart(2, "0")}/${periodM[2].padStart(2, "0")}`,
        to: `${periodM[3].padStart(2, "0")}/${periodM[4].padStart(2, "0")}`,
      }
    : null;
  const titleM = /Desafio Mandala[^"<\\]{0,80}?Semana\s+(\d+)/i.exec(text);
  return {
    title: titleM ? titleM[0].trim() : null,
    semana: titleM ? Number(titleM[1]) : null,
    days: [...days.values()].sort((a, b) => a.dayNum - b.dayNum),
    period,
  };
}

/**
 * `DD/MM` → `YYYY-MM-DD`, escolhendo o ano pelo instante de referência: o
 * formulário é da semana que acabou de passar, então a data nunca fica mais de
 * ~2 meses no futuro. 29/12 lido em 03/01 vira o ano anterior. @pure
 */
export function resolveDdmm(ddmm: string, now: Date): string {
  const m = /^(\d{1,2})\/(\d{1,2})$/.exec(ddmm.trim());
  if (!m) throw new Error(`data inválida (esperado DD/MM): ${ddmm}`);
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`data inválida: ${ddmm}`);
  const year = now.getUTCFullYear();
  const candidate = Date.UTC(year, month - 1, day);
  const limit = now.getTime() + 60 * 86400_000;
  const y = candidate > limit ? year - 1 : year;
  // 31/02 viraria 03/03 em silêncio no Date.UTC: conferir o dia no ano escolhido.
  if (!isRealDate(y, month, day)) throw new Error(`data inválida: ${ddmm} não existe em ${y}`);
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function isRealDate(y: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(y, month - 1, day));
  return d.getUTCFullYear() === y && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * Confere a estrutura do formulário antes de montar o plano: `DD/MM` repetido
 * em duas perguntas de dia, ou `--semana` diferente da semana do título, é
 * erro (o plano casaria o link errado com a pergunta). Devolve a semana a
 * usar. @pure
 */
export function checkFormConsistency(form: TallyForm, semanaArg: number | null): number {
  const seen = new Map<string, number>();
  for (const d of form.days) {
    const prev = seen.get(d.ddmm);
    if (prev !== undefined) {
      throw new Error(`o formulário traz a data ${d.ddmm} em duas perguntas (dia ${prev} e dia ${d.dayNum}); conferir o Tally`);
    }
    seen.set(d.ddmm, d.dayNum);
  }
  if (semanaArg !== null && form.semana !== null && semanaArg !== form.semana) {
    throw new Error(`--semana ${semanaArg} não bate com o título do formulário (Semana ${form.semana})`);
  }
  const semana = semanaArg ?? form.semana;
  if (!semana) throw new Error("o título do formulário não traz \"Semana N\": passe --semana N");
  return semana;
}

const brtDateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: MANDALA_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const brtTimeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: MANDALA_TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** `YYYY-MM-DD` de um instante em BRT. @pure */
export function brtDate(iso: string): string {
  return brtDateFmt.format(new Date(iso));
}

/** `HH:MM` de um instante em BRT. @pure */
export function brtTime(iso: string): string {
  return brtTimeFmt.format(new Date(iso));
}

export type MandalaAccount = typeof MANDALA_ACCOUNT | "vjpixel (collab)";
export type MandalaFormat = "post" | "reel";

/** Um conteúdo publicado no Instagram, de qualquer fonte. */
export interface MandalaPost {
  url: string;
  /** Instante de publicação, ISO com fuso. */
  timestamp: string;
  account: MandalaAccount;
  format: MandalaFormat;
  caption: string;
}

/** Normaliza o `timestamp` da Graph API (`2026-11-04T09:33:11+0000`) para ISO que o `Date` lê. @pure */
export function normalizeGraphTimestamp(ts: string): string {
  return ts.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
}

/**
 * Converte a página `data` de `GET /{ig-user-id}/media?fields=permalink,timestamp,
 * media_product_type,caption` em posts. Item sem `permalink` ou `timestamp` é
 * descartado e contado em `skipped`. @pure
 */
export function postsFromGraphMedia(data: unknown): { posts: MandalaPost[]; skipped: number } {
  const arr = Array.isArray(data) ? data : [];
  const posts: MandalaPost[] = [];
  let skipped = 0;
  for (const raw of arr) {
    const m = raw as { permalink?: unknown; timestamp?: unknown; media_product_type?: unknown; caption?: unknown };
    if (typeof m?.permalink !== "string" || typeof m.timestamp !== "string") {
      skipped++;
      continue;
    }
    const timestamp = normalizeGraphTimestamp(m.timestamp);
    if (Number.isNaN(Date.parse(timestamp))) {
      skipped++;
      continue;
    }
    posts.push({
      url: m.permalink,
      timestamp,
      account: MANDALA_ACCOUNT,
      format: m.media_product_type === "REELS" || /\/reel\//.test(m.permalink) ? "reel" : "post",
      caption: typeof m.caption === "string" ? m.caption : "",
    });
  }
  return { posts, skipped };
}

/**
 * Uma página de `/media` com HTTP 200. Corpo ilegível ou sem `data` em array é
 * erro, nunca "semana vazia": uma página vazia de verdade vem como `data: []`.
 * `rawCount` é o tamanho cru de `data` (a paginação para nele, não no número de
 * posts válidos). @pure
 */
export function readGraphPage(
  body: unknown,
): { ok: true; data: unknown[]; rawCount: number; next: string | null } | { ok: false; error: string } {
  const b = body as { data?: unknown; paging?: { next?: unknown } } | null;
  if (!b || typeof b !== "object") return { ok: false, error: "Graph API respondeu 200 com corpo ilegível" };
  if (!Array.isArray(b.data)) return { ok: false, error: "Graph API respondeu 200 sem o campo data" };
  const next = typeof b.paging?.next === "string" ? b.paging.next : null;
  return { ok: true, data: b.data, rawCount: b.data.length, next };
}

/**
 * Lê os registros locais de publicação de uma edição
 * (`_internal/06-social-published.json`, `06-shorts-published*.json`) e devolve
 * os posts do Instagram que já têm URL e instante de publicação. É o caminho de
 * reserva quando a Graph API falha: os carrosséis agendados pelo Worker ficam
 * com `url: null`, então a lista sai incompleta e quem chama avisa isso. @pure
 */
export function postsFromLocalRecord(json: unknown): MandalaPost[] {
  const out: MandalaPost[] = [];
  const obj = json as { posts?: unknown; entries?: unknown } | null;
  const items = [
    ...(Array.isArray(obj?.posts) ? obj!.posts : []),
    ...(Array.isArray(obj?.entries) ? obj!.entries : []),
  ] as Array<Record<string, unknown>>;
  for (const it of items) {
    const platform = (it.platform ?? it.destination) as unknown;
    if (platform !== "instagram") continue;
    if (it.status !== "published") continue;
    const url = it.url;
    // Post que passou pela fila do Worker: `published_at` é a hora em que a
    // reconciliação confirmou (12:12 para um post das 12:00), não a da
    // publicação. Nesse caso vale o `scheduled_at`.
    const viaWorker = it.worker_queue_key !== undefined || it.verification_note !== undefined;
    const ts = (viaWorker && typeof it.scheduled_at === "string" ? it.scheduled_at : (it.published_at ?? it.at)) as unknown;
    if (typeof url !== "string" || !/instagram\.com\//.test(url) || typeof ts !== "string") continue;
    if (Number.isNaN(Date.parse(ts))) continue;
    out.push({
      url,
      timestamp: ts,
      account: MANDALA_ACCOUNT,
      format: /\/reel\//.test(url) ? "reel" : "post",
      caption: "",
    });
  }
  return out;
}

/**
 * `--collab URL@YYYY-MM-DDTHH:MM` (horário BRT dito pelo editor). Sem horário,
 * erro: collab não vem da API e o horário decide qual é o 1º do dia. @pure
 */
export function parseCollabArg(arg: string): MandalaPost {
  const at = arg.lastIndexOf("@");
  if (at <= 0) throw new Error(`--collab sem horário: "${arg}" (use URL@AAAA-MM-DDTHH:MM, horário de Brasília)`);
  const url = arg.slice(0, at).trim();
  const when = arg.slice(at + 1).trim();
  if (!/^https:\/\/(www\.)?instagram\.com\/(?:[\w.]+\/)?(reel|p)\/[\w-]+\/?/.test(url)) {
    throw new Error(`--collab com URL que não é de post do Instagram: "${url}"`);
  }
  const wm = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(when);
  if (
    !wm ||
    !isRealDate(Number(wm[1]), Number(wm[2]), Number(wm[3])) ||
    Number(wm[4]) > 23 ||
    Number(wm[5]) > 59
  ) {
    throw new Error(`--collab "${arg}" com horário inválido: "${when}" (use AAAA-MM-DDTHH:MM, horário de Brasília)`);
  }
  // Brasil sem horário de verão desde 2019: BRT é UTC-3 fixo.
  const timestamp = `${when}:00-03:00`;
  return {
    url,
    timestamp,
    account: "vjpixel (collab)",
    format: /\/reel\//.test(url) ? "reel" : "post",
    caption: "",
  };
}

/** Normaliza URL para deduplicar posts que chegam de mais de uma fonte. @pure */
export function canonicalPostUrl(url: string): string {
  const m = /instagram\.com\/(?:[\w.]+\/)?(reel|p|tv)\/([\w-]+)/.exec(url);
  return m ? m[2] : url.replace(/[?#].*$/, "").replace(/\/+$/, "");
}

/** Junta fontes, sem repetir o mesmo post (a 1ª fonte vence). @pure */
export function mergePosts(...sources: MandalaPost[][]): MandalaPost[] {
  const seen = new Set<string>();
  const out: MandalaPost[] = [];
  for (const src of sources) {
    for (const p of src) {
      const k = canonicalPostUrl(p.url);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
  }
  return out;
}

export interface PlannedDay {
  dayNum: number;
  ddmm: string;
  /** `YYYY-MM-DD` resolvido. */
  date: string;
  question: string;
}

export interface WeekRow {
  dayNum: number;
  ddmm: string;
  date: string;
  timeBrt: string;
  account: MandalaAccount;
  format: MandalaFormat;
  url: string;
  /** `dia N` (resposta da pergunta do dia) ou `extra`. */
  slot: `dia ${number}` | "extra";
  captionStart: string;
}

/**
 * Link de um dia do formulário. `verified: true` = a lista de posts era
 * completa (Graph API) e `url` é a resposta (`null` = nenhum post no dia).
 * `verified: false` = a lista veio dos registros locais, que não têm a URL dos
 * carrosséis: `url` fica `null` e o 1º post que achamos vai em `candidate`,
 * para o editor confirmar ou corrigir antes do preenchimento.
 */
export type DailyLink = PlannedDay &
  ({ verified: true; url: string | null } | { verified: false; url: null; candidate: string | null });

export interface WeekSelection {
  rows: WeekRow[];
  /** Link de cada dia do formulário, já verificado (`url: null` = nenhum post naquele dia). */
  daily: Array<PlannedDay & { verified: true; url: string | null }>;
  extras: string[];
  /** Posts fora do período, só para o relatório (nunca entram no formulário). */
  outOfPeriod: number;
}

/** Começo do texto: 1ª linha, até ~45 caracteres, sem `;` (separador do CSV). @pure */
export function captionStart(caption: string, max = 45): string {
  const first = caption.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const clean = first.replace(/;/g, ",").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > 20 ? cut.slice(0, sp) : cut).trim();
}

/**
 * Regra do editor: o link de cada dia é o 1º conteúdo publicado naquele dia
 * (BRT); os demais posts do período são extras. Posts fora das datas do
 * formulário ficam de fora. Empate de horário: a ordem de entrada decide
 * (estável). @pure
 */
export function selectWeek(posts: MandalaPost[], days: PlannedDay[]): WeekSelection {
  const dayByDate = new Map(days.map((d) => [d.date, d]));
  const sorted = posts
    .map((p, i) => ({ p, i, t: Date.parse(p.timestamp) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.p);
  const firstByDate = new Map<string, MandalaPost>();
  const rows: WeekRow[] = [];
  const extras: string[] = [];
  let outOfPeriod = 0;
  for (const p of sorted) {
    const date = brtDate(p.timestamp);
    const day = dayByDate.get(date);
    if (!day) {
      outOfPeriod++;
      continue;
    }
    const isFirst = !firstByDate.has(date);
    if (isFirst) firstByDate.set(date, p);
    else extras.push(p.url);
    rows.push({
      dayNum: day.dayNum,
      ddmm: day.ddmm,
      date,
      timeBrt: brtTime(p.timestamp),
      account: p.account,
      format: p.format,
      url: p.url,
      slot: isFirst ? `dia ${day.dayNum}` : "extra",
      captionStart: captionStart(p.caption),
    });
  }
  const daily = days.map((d) => ({ ...d, verified: true as const, url: firstByDate.get(d.date)?.url ?? null }));
  return { rows, daily, extras, outOfPeriod };
}

/**
 * Com a lista de posts incompleta (registros locais), nenhum link de dia é
 * resposta: o 1º achado vira `candidate` e `url` fica `null`, para o plano não
 * carregar um link plausível e errado como se fosse o certo. @pure
 */
export function dailyLinks(daily: WeekSelection["daily"], postsSource: "graph" | "local"): DailyLink[] {
  if (postsSource === "graph") return daily;
  return daily.map(({ url, verified: _v, ...d }) => ({ ...d, verified: false as const, url: null, candidate: url }));
}

/** CSV no formato da planilha da semana 2 (`;`, cabeçalho em português). @pure */
export function weekCsv(rows: WeekRow[]): string {
  const header = "dia_desafio;data;hora_brt;conta;formato;link;no_formulario;inicio_do_texto";
  const lines = rows.map((r) =>
    [r.dayNum ?? "", r.ddmm, r.timeBrt, r.account, r.format, r.url, r.slot, r.captionStart]
      .map((v) => String(v).replace(/[;\r\n]/g, " "))
      .join(";"),
  );
  return [header, ...lines].join("\n") + "\n";
}

/** Datas `YYYY-MM-DD` de `from` a `to`, inclusive. @pure */
export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export type YoutubeSubsSummary =
  | { complete: true; value: number; from: string; to: string; missingDays: [] }
  | { complete: false; value: number | null; from: string; to: string; missingDays: string[] };

/**
 * Inscritos novos no YouTube (`subscribersGained`, bruto) entre `from` e `to`,
 * lendo `data/youtube-analytics/channel-daily.jsonl`. Cada dia aparece em
 * vários snapshots; vale o de `capturedAt` mais recente (o último dia costuma
 * vir revisado depois). Dia ausente vai em `missingDays` e `value` soma só os
 * presentes (ou `null` se nenhum). @pure
 */
export function summarizeYoutubeSubs(jsonl: string, from: string, to: string): YoutubeSubsSummary {
  const latest = new Map<string, { capturedAt: string; gained: number }>();
  for (const line of jsonl.split("\n")) {
    const raw = line.trim();
    if (!raw) continue;
    let o: { day?: unknown; capturedAt?: unknown; subscribersGained?: unknown };
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof o.day !== "string" || typeof o.subscribersGained !== "number") continue;
    const capturedAt = typeof o.capturedAt === "string" ? o.capturedAt : "";
    const prev = latest.get(o.day);
    if (!prev || capturedAt >= prev.capturedAt) latest.set(o.day, { capturedAt, gained: o.subscribersGained });
  }
  const wanted = eachDate(from, to);
  const missingDays = wanted.filter((d) => !latest.has(d));
  const present = wanted.filter((d) => latest.has(d));
  if (missingDays.length === 0) {
    return { complete: true, value: present.reduce((s, d) => s + latest.get(d)!.gained, 0), from, to, missingDays: [] };
  }
  return {
    complete: false,
    value: present.length ? present.reduce((s, d) => s + latest.get(d)!.gained, 0) : null,
    from,
    to,
    missingDays,
  };
}

/** Arquivo do YouTube ausente: todos os dias do período faltam. @pure */
export function youtubeSubsUnavailable(from: string, to: string): YoutubeSubsSummary {
  return { complete: false, value: null, from, to, missingDays: eachDate(from, to) };
}

export interface NewFollowersTotal {
  /** Soma IG + YouTube, só quando as duas partes existem; `null` se alguma falta. */
  total: number | null;
  /** `true` só com IG bruto (insights) e YouTube sem dia faltando: aí vai direto na pergunta 12. */
  totalComplete: boolean;
}

/**
 * Total da pergunta 12. Parte nula nunca vira 0 (somaria só o que existe e
 * pareceria completo); parte presente mas parcial (IG saldo líquido, YouTube
 * com dia faltando) dá `totalComplete: false`, e a skill pede confirmação. @pure
 */
export function combineNewFollowers(
  ig: { source: "insights" | "net-balance"; value: number | null },
  yt: YoutubeSubsSummary,
): NewFollowersTotal {
  const total = ig.value === null || yt.value === null ? null : ig.value + yt.value;
  return { total, totalComplete: total !== null && ig.source === "insights" && yt.complete };
}
