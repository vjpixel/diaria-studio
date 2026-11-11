/**
 * scripts/lib/instagram-follower-insights.ts (#12348, Fase 2 da #8260)
 *
 * Núcleo PURO da série BRUTA de novos seguidores do Instagram (@diar.ia.br):
 * parsing da resposta de `GET /{ig_id}/insights?metric=follower_count&period=day`,
 * diagnóstico de erro da Graph API, o JSONL append-only
 * `data/metrics/instagram-follows-daily.jsonl` e a soma de um período com
 * fallback para o saldo líquido da Fase 1 (`social-followers.ts`). Nenhuma
 * chamada de rede aqui; o fetch mora em `scripts/social-followers-collect.ts`.
 *
 * ## Qual dia é cada valor (medido em 10/11/2026)
 *
 * Cada ponto vem com `end_time` às 07:00 UTC (08:00 UTC fora do horário de
 * verão), que é meia-noite no horário do Pacífico. O valor daquele ponto é o
 * do dia do Pacífico que COMEÇA nesse instante: a soma de `end_time`
 * 29/10..04/11 deu 42, o mesmo número do Business Suite (Público →
 * Tendências, 29/10–04/11) registrado na #12348. Por isso o dia é a data de
 * `end_time` no fuso America/Los_Angeles, e o dia do Pacífico em curso
 * (incompleto) nunca é gravado.
 *
 * ## `follows_and_unfollows` ficou de fora
 *
 * A métrica só existe como `total_value` sobre o período inteiro, então a
 * série diária custaria 1 chamada por dia; e numa janela de 1 dia ela voltou
 * sem `total_value` (probe de 10/11/2026). `follower_count` dá o bruto diário
 * em 1 chamada, com 30 dias para trás, que é o que a #12347 precisa.
 *
 * ## Dia sem seguidor novo é 0, nunca ausente
 *
 * A API devolve `value: 0` nos dias sem seguidor novo (o Business Suite
 * omite esses dias). Gravamos o 0: dia ausente na série significa "não
 * coletado", e a soma de um período com dia ausente cai no fallback.
 */

export const IG_FOLLOWS_DAILY_PATH = "data/metrics/instagram-follows-daily.jsonl";

/** Fuso em que a Meta fecha o dia dos insights. */
export const META_INSIGHTS_TIMEZONE = "America/Los_Angeles";

/** 1 linha do JSONL bruto: novos seguidores (sem descontar quem saiu) num dia do Pacífico. */
export interface InstagramFollowsDay {
  /** `YYYY-MM-DD`, dia no horário do Pacífico. */
  date: string;
  /** Novos seguidores no dia (bruto). */
  follows: number;
}

const pacificDateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: META_INSIGHTS_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Data `YYYY-MM-DD` de um instante no horário do Pacífico. @pure */
export function pacificDate(d: Date): string {
  return pacificDateFmt.format(d);
}

/** Diagnóstico de uma resposta de erro da Graph API, sem nunca incluir o token. */
export interface InsightsError {
  /** `permission` = token sem `instagram_manage_insights`/`read_insights` (código 10 ou 200). */
  kind: "permission" | "auth" | "missing" | "http" | "shape";
  message: string;
}

/**
 * Traduz status + corpo de erro da Graph API num diagnóstico legível.
 * Código 10 (`Application does not have permission`) e a faixa 200-299 são
 * falta de escopo; 190 é token inválido/expirado. @pure
 */
export function diagnoseInsightsError(status: number, body: unknown): InsightsError {
  const err = (body as { error?: { message?: unknown; code?: unknown } } | null)?.error;
  const code = typeof err?.code === "number" ? err.code : null;
  const apiMsg = typeof err?.message === "string" ? err.message : `HTTP ${status}`;
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) {
    return {
      kind: "permission",
      message:
        `(#${code}) ${apiMsg} — o INSTAGRAM_ACCESS_TOKEN não tem instagram_manage_insights/read_insights. ` +
        `Gerar o token de System User com esses escopos (#12348) e rodar npm run sync-env; ` +
        `até lá vale o saldo líquido de data/metrics/social-followers.jsonl.`,
    };
  }
  if (code === 190) {
    return { kind: "auth", message: `(#190) ${apiMsg} — token inválido ou expirado; renovar o INSTAGRAM_ACCESS_TOKEN.` };
  }
  return { kind: "http", message: code !== null ? `(#${code}) ${apiMsg}` : apiMsg };
}

/**
 * Extrai os dias COMPLETOS da resposta de `metric=follower_count&period=day`.
 * Descarta o dia do Pacífico em curso e os posteriores (`todayPacific`).
 * Ponto com valor não numérico ou `end_time` ilegível é pulado. @pure
 */
export function parseFollowerCountInsights(
  body: unknown,
  todayPacific: string,
): { days: InstagramFollowsDay[] } | { error: InsightsError } {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return { error: { kind: "shape", message: "resposta de insights sem `data`" } };
  const metric = data.find((m) => (m as { name?: unknown })?.name === "follower_count") as
    | { values?: unknown }
    | undefined;
  if (!metric || !Array.isArray(metric.values)) {
    return { error: { kind: "shape", message: "resposta de insights sem a métrica follower_count" } };
  }
  const byDate = new Map<string, number>();
  for (const v of metric.values as Array<{ value?: unknown; end_time?: unknown }>) {
    if (typeof v?.value !== "number" || !Number.isFinite(v.value) || v.value < 0) continue;
    if (typeof v.end_time !== "string") continue;
    const t = new Date(v.end_time);
    if (Number.isNaN(t.getTime())) continue;
    const date = pacificDate(t);
    if (date >= todayPacific) continue;
    byDate.set(date, v.value);
  }
  const days = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, follows]) => ({ date, follows }));
  return { days };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parseia o JSONL bruto. Mais de uma linha para o mesmo dia: vale a ÚLTIMA
 * (a Meta pode revisar o número de um dia recente, e o coletor anexa a
 * correção em vez de reescrever o arquivo). Linha inválida vai para
 * `errors`, nunca lança. @pure
 */
export function parseInstagramFollowsJsonl(content: string): {
  days: InstagramFollowsDay[];
  errors: Array<{ line: number; reason: string }>;
} {
  const byDate = new Map<string, number>();
  const errors: Array<{ line: number; reason: string }> = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let obj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) throw new Error();
      obj = parsed as Record<string, unknown>;
    } catch {
      errors.push({ line: i + 1, reason: "JSON inválido" });
      continue;
    }
    if (typeof obj.date !== "string" || !DATE_RE.test(obj.date)) {
      errors.push({ line: i + 1, reason: "date ausente ou fora do formato YYYY-MM-DD" });
      continue;
    }
    if (typeof obj.follows !== "number" || !Number.isFinite(obj.follows) || obj.follows < 0) {
      errors.push({ line: i + 1, reason: "follows ausente ou inválido" });
      continue;
    }
    byDate.set(obj.date, obj.follows);
  }
  const days = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, follows]) => ({ date, follows }));
  return { days, errors };
}

/**
 * Dias a anexar: os que ainda não estão na série e os que a Meta revisou
 * (valor diferente do último gravado). @pure
 */
export function daysToAppend(existing: InstagramFollowsDay[], fetched: InstagramFollowsDay[]): InstagramFollowsDay[] {
  const known = new Map(existing.map((d) => [d.date, d.follows]));
  return fetched.filter((d) => known.get(d.date) !== d.follows);
}

/** Linha JSONL de 1 dia. @pure */
export function serializeInstagramFollowsDay(day: InstagramFollowsDay, collectedAt: string): string {
  return JSON.stringify({ date: day.date, platform: "instagram", follows: day.follows, source: "insights.follower_count", collectedAt });
}

function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Resultado da soma de novos seguidores num período. */
export type NewFollowersSummary =
  | { source: "insights"; value: number; from: string; to: string }
  | { source: "net-balance"; value: number | null; from: string; to: string; missingDays: string[]; note: string };

/**
 * Novos seguidores do IG entre `from` e `to` (inclusive, dias do Pacífico).
 * Com a série bruta completa no período, devolve a soma bruta. Faltando
 * qualquer dia, cai no saldo líquido da Fase 1: `followers_count` no fim do
 * período menos o do dia anterior ao início (amostras da `social-followers.jsonl`,
 * plataforma instagram); `value: null` quando nem isso dá para calcular.
 * O fallback usa as datas UTC da coleta: suas bordas podem diferir em até
 * 1 dia das datas do Pacífico na série bruta. Sem instante nas amostras
 * históricas, não é possível convertê-las com precisão; não deslocar datas
 * por um offset fixo. Coletas faltantes podem ampliar ainda mais a janela. @pure
 */
export function summarizeInstagramNewFollowers(
  gross: InstagramFollowsDay[],
  netSamples: Array<{ date: string; platform: string; followersCount: number }>,
  from: string,
  to: string,
): NewFollowersSummary {
  const byDate = new Map(gross.map((d) => [d.date, d.follows]));
  const wanted = eachDate(from, to);
  const missingDays = wanted.filter((d) => !byDate.has(d));
  if (wanted.length > 0 && missingDays.length === 0) {
    return { source: "insights", value: wanted.reduce((s, d) => s + (byDate.get(d) ?? 0), 0), from, to };
  }
  const ig = netSamples.filter((s) => s.platform === "instagram").sort((a, b) => a.date.localeCompare(b.date));
  const before = [...ig].reverse().find((s) => s.date < from);
  const end = [...ig].reverse().find((s) => s.date <= to && s.date >= from);
  const value = before && end ? end.followersCount - before.followersCount : null;
  return {
    source: "net-balance",
    value,
    from,
    to,
    missingDays,
    note: "saldo líquido (novos − deixaram de seguir), não o bruto: faltam dias na série de insights; datas UTC da coleta, com bordas que podem diferir em até 1 dia dos dias do Pacífico (coletas faltantes podem ampliar a janela)",
  };
}
