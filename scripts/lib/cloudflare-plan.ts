/**
 * cloudflare-plan.ts (#12533)
 *
 * Lógica pura do helper `scripts/cloudflare-plan.ts`: descobre o plano
 * Workers da conta Cloudflare (`GET /accounts/{id}/subscriptions`) e soma o
 * uso de KV no mês (GraphQL `kvOperationsAdaptiveGroups`) contra o que o plano
 * inclui.
 *
 * Por que existe: em 09/11/2026 o review da PR #12529 reteve a PR assumindo
 * que a conta estava no plano gratuito (teto de 1.000 escritas KV/dia). A
 * conta está no Workers Paid, e só uma fatura enviada pelo editor resolveu.
 * Premissa de plano tem que sair de consulta, nunca de memória ou de doc.
 *
 * Regra central: **sem a permissão Account › Billing › Read o helper nunca
 * afirma plano.** A Cloudflare responde `10000 Authentication error` (HTTP
 * 403) a `/subscriptions` quando o token não tem essa permissão — o mesmo
 * código de um token inválido ou expirado, então o veredito é "não
 * verificado", com a ação que destrava, e nunca um palpite de plano.
 *
 * Segunda regra: **plano gratuito nunca é afirmado por exclusão de um padrão
 * não confirmado.** Assinatura que mencione Workers e não case com o padrão
 * pago (ou esteja num estado fora da lista de estados ativos) vira
 * `workers-unrecognized`, exit != 0, listando o que veio.
 *
 * Tudo aqui é puro (sem rede, sem `process.env`): o CLI injeta `fetch` e as
 * variáveis. Os testes ficam em `test/cloudflare-plan.test.ts`.
 */

// ── Tipos da resposta da Cloudflare (só os campos que usamos) ────────────────

export interface CfApiError {
  code?: number;
  message?: string;
}

export interface CfSubscription {
  id?: string;
  state?: string;
  price?: number;
  currency?: string;
  frequency?: string;
  current_period_start?: string;
  current_period_end?: string;
  rate_plan?: {
    id?: string;
    public_name?: string;
    scope?: string;
  };
  product?: { name?: string };
}

export interface CfEnvelope<T> {
  success?: boolean;
  errors?: CfApiError[];
  result?: T;
}

// ── Veredito da consulta de assinaturas ──────────────────────────────────────

export type SubscriptionsVerdict =
  | { kind: "ok"; subscriptions: CfSubscription[] }
  /** Token sem Billing:Read, ou inválido/expirado: a API devolve o mesmo 10000. */
  | { kind: "no-billing-permission"; httpStatus: number; detail: string }
  | { kind: "error"; httpStatus: number; detail: string };

/** Código de erro que a Cloudflare usa para "Authentication error". */
export const CF_AUTH_ERROR_CODE = 10000;

export const NO_BILLING_PERMISSION_MESSAGE =
  "token sem Billing:Read OU inválido/expirado — não verificado";

function errorsText(errors: CfApiError[] | undefined): string {
  if (!errors || errors.length === 0) return "";
  return errors
    .map((e) => `${e?.code ?? "?"} ${e?.message ?? ""}`.trim())
    .join("; ");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Interpreta a resposta de `GET /accounts/{id}/subscriptions`.
 *
 * - 2xx com `success !== false` e `result` array → `ok` (elementos que não
 *   são objeto são descartados);
 * - 401/403, ou qualquer erro com código 10000 → `no-billing-permission`;
 * - o resto (5xx, JSON sem `result`, outro código) → `error`.
 */
export function interpretSubscriptionsResponse(
  httpStatus: number,
  body: unknown,
): SubscriptionsVerdict {
  const env = (isPlainObject(body) ? body : {}) as CfEnvelope<unknown>;
  const errs = Array.isArray(env.errors) ? env.errors : [];
  const detail = errorsText(errs) || `HTTP ${httpStatus}`;
  const hasAuthCode = errs.some((e) => e?.code === CF_AUTH_ERROR_CODE);

  if (httpStatus === 401 || httpStatus === 403 || hasAuthCode) {
    return { kind: "no-billing-permission", httpStatus, detail };
  }
  if (httpStatus >= 200 && httpStatus < 300 && env.success !== false && Array.isArray(env.result)) {
    const subscriptions = (env.result as unknown[]).filter(isPlainObject) as CfSubscription[];
    return { kind: "ok", subscriptions };
  }
  return { kind: "error", httpStatus, detail };
}

// ── Classificação do plano Workers ───────────────────────────────────────────

export type WorkersPlan = "workers-paid" | "workers-free";

export type PlanClassification =
  | { plan: "workers-paid"; subscription: CfSubscription; reason: string }
  | { plan: "workers-free"; reason: string }
  /** Há assinatura ligada a Workers que o padrão não reconhece: plano NÃO verificado. */
  | { plan: "workers-unrecognized"; reason: string; unrecognized: string[] };

/**
 * Estados de assinatura que contam como ativos (lista de INCLUSÃO). Estado
 * ausente ou fora desta lista nunca é tratado como ativo nem como inativo:
 * numa assinatura de Workers, deixa o plano não reconhecido.
 */
const ACTIVE_STATES: ReadonlySet<string> = new Set(["paid", "provisioned", "trial", "awaitingpayment"]);

/** Qualquer menção a Workers no rótulo da assinatura. */
const WORKERS_RELATED_PATTERN = /\bworkers?\b/i;

/**
 * Padrão do rate plan pago. **Escrito sem nenhuma resposta real de
 * `/subscriptions` capturada** (o token do projeto não tinha Billing:Read em
 * 13/11/2026): reconferir contra a saída real na 1ª execução com
 * Billing:Read e ajustar aqui e no teste. O que não casar cai em
 * `workers-unrecognized`, nunca em `workers-free`.
 */
const WORKERS_PAID_PATTERN = /workers.*(paid|bundled|unbound|standard)|(paid|bundled|unbound|standard).*workers/i;

function subscriptionLabel(s: CfSubscription): string {
  return [s.rate_plan?.id, s.rate_plan?.public_name, s.product?.name]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" | ");
}

function isActiveState(state: string | undefined): boolean {
  return typeof state === "string" && ACTIVE_STATES.has(state.toLowerCase());
}

/**
 * Decide o plano Workers a partir da lista de assinaturas da conta.
 *
 * Só é chamada com a lista já obtida (veredito `ok`) — sem Billing:Read não
 * existe classificação.
 * - Uma assinatura que case com o padrão pago E esteja em estado ativo →
 *   `workers-paid` (evidência positiva; vence assinaturas antigas da lista).
 * - Senão, qualquer assinatura que mencione Workers (padrão pago em estado
 *   não ativo/ausente/desconhecido, ou rótulo que não casa com o padrão, como
 *   "Workers Plan" ou "Workers & Pages") → `workers-unrecognized`.
 * - Só quando nenhuma assinatura tem relação com Workers → `workers-free`.
 */
export function classifyWorkersPlan(subscriptions: CfSubscription[]): PlanClassification {
  const paid = subscriptions.find(
    (s) => WORKERS_PAID_PATTERN.test(subscriptionLabel(s)) && isActiveState(s.state),
  );
  if (paid) {
    return {
      plan: "workers-paid",
      subscription: paid,
      reason: `assinatura ativa "${subscriptionLabel(paid)}" (estado: ${paid.state})`,
    };
  }
  const related = subscriptions.filter((s) => WORKERS_RELATED_PATTERN.test(subscriptionLabel(s)));
  if (related.length > 0) {
    const unrecognized = related.map(
      (s) => `${subscriptionLabel(s)} (id: ${s.id ?? "?"}, estado: ${s.state ?? "ausente"})`,
    );
    return {
      plan: "workers-unrecognized",
      unrecognized,
      reason:
        `${related.length} assinatura(s) ligada(s) a Workers sem plano pago ativo reconhecido: ` +
        unrecognized.join("; "),
    };
  }
  return {
    plan: "workers-free",
    reason: `nenhuma assinatura ligada a Workers entre ${subscriptions.length} assinatura(s) da conta`,
  };
}

// ── Cotas de KV incluídas por plano ──────────────────────────────────────────

export type KvAction = "read" | "write" | "delete" | "list";
export const KV_ACTIONS: readonly KvAction[] = ["read", "write", "delete", "list"];

export interface KvQuota {
  /** "month" no Workers Paid (cota mensal incluída), "day" no Free (teto diário). */
  readonly period: "month" | "day";
  readonly limits: Readonly<Record<KvAction, number>>;
  /** Onde o número foi conferido, para quem precisar reconferir. */
  readonly source: string;
}

/**
 * Cotas de KV por plano, conferidas em 13/11/2026 em
 * https://developers.cloudflare.com/kv/platform/pricing/ (tabela Free
 * "100,000 / day" de reads e "1,000 / day" de writes/deletes/lists; Paid
 * "10 million/month" de reads e "1 million/month" do resto).
 * No Paid o que passa da cota é cobrado (não bloqueia); no Free o teto é
 * diário, por conta, e bloqueia até a virada (00:00 UTC).
 */
export const KV_QUOTAS: Readonly<Record<WorkersPlan, KvQuota>> = Object.freeze({
  "workers-paid": Object.freeze({
    period: "month",
    limits: Object.freeze({ read: 10_000_000, write: 1_000_000, delete: 1_000_000, list: 1_000_000 }),
    source: "developers.cloudflare.com/kv/platform/pricing (conferido 13/11/2026)",
  }),
  "workers-free": Object.freeze({
    period: "day",
    limits: Object.freeze({ read: 100_000, write: 1_000, delete: 1_000, list: 1_000 }),
    source: "developers.cloudflare.com/kv/platform/pricing (conferido 13/11/2026)",
  }),
});

// ── Uso de KV (GraphQL kvOperationsAdaptiveGroups) ───────────────────────────

export interface MonthWindow {
  /** "YYYY-MM" */
  month: string;
  /** Primeiro dia do mês, "YYYY-MM-DD" (UTC). */
  start: string;
  /** Último dia considerado: hoje se o mês é o corrente, senão o último do mês. */
  end: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Janela de datas (UTC) do mês pedido. Sem `month`, o mês corrente de `now`.
 * Mês corrente termina em `now` (dia de hoje); mês passado, no último dia.
 * Mês futuro ou malformado lança.
 */
export function monthWindow(now: Date, month?: string): MonthWindow {
  const curY = now.getUTCFullYear();
  const curM = now.getUTCMonth() + 1;
  let y = curY;
  let m = curM;
  if (month !== undefined) {
    const match = /^(\d{4})-(\d{2})$/.exec(month);
    if (!match) throw new Error(`--month inválido: "${month}" (esperado YYYY-MM)`);
    y = Number(match[1]);
    m = Number(match[2]);
    if (m < 1 || m > 12) throw new Error(`--month inválido: "${month}" (mês fora de 01-12)`);
    if (y > curY || (y === curY && m > curM)) {
      throw new Error(`--month ${month} está no futuro`);
    }
  }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const isCurrent = y === curY && m === curM;
  const endDay = isCurrent ? now.getUTCDate() : lastDay;
  return {
    month: `${y}-${pad2(m)}`,
    start: `${y}-${pad2(m)}-01`,
    end: `${y}-${pad2(m)}-${pad2(endDay)}`,
  };
}

/**
 * Query GraphQL de uso de KV por ação e por dia, numa conta. Mesma forma do
 * exemplo de https://developers.cloudflare.com/kv/observability/metrics-analytics/
 * (conferido 13/11/2026), sem o filtro de namespace: soma a conta inteira,
 * que é onde a cota vale.
 */
export const KV_USAGE_QUERY = `query KvUsage($accountTag: string!, $start: Date!, $end: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      kvOperationsAdaptiveGroups(
        limit: 10000
        filter: { date_geq: $start, date_leq: $end }
      ) {
        sum { requests }
        dimensions { actionType date }
      }
    }
  }
}`;

export interface KvUsageGroup {
  sum?: { requests?: number };
  dimensions?: { actionType?: string; date?: string };
}

export interface KvUsageSummary {
  /** Total do mês por ação. */
  totals: Record<KvAction, number>;
  /** Maior dia de cada ação (para comparar com o teto diário do Free). */
  peakDay: Record<KvAction, { date: string; requests: number } | null>;
  /** actionTypes que vieram e não são read/write/delete/list (ex.: "unknown"). */
  otherActions: Record<string, number>;
}

export type KvUsageVerdict =
  | { kind: "ok"; summary: KvUsageSummary }
  | { kind: "error"; detail: string };

/**
 * Detalhe quando `kvOperationsAdaptiveGroups` vem vazio: "sem dados", nunca
 * "uso zero" — a lista vazia não distingue conta sem uso de dataset sem
 * amostras na janela.
 */
export const KV_USAGE_NO_DATA_DETAIL =
  "sem dados: kvOperationsAdaptiveGroups veio vazio na janela (não é uso zero)";

function emptyRecord(): Record<KvAction, number> {
  return { read: 0, write: 0, delete: 0, list: 0 };
}

function isKvAction(v: string): v is KvAction {
  return (KV_ACTIONS as readonly string[]).includes(v);
}

/** Soma os grupos (ação × dia) em totais do mês e pico diário por ação. */
export function summarizeKvUsage(groups: KvUsageGroup[]): KvUsageSummary {
  const totals = emptyRecord();
  const perDay: Record<KvAction, Map<string, number>> = {
    read: new Map(),
    write: new Map(),
    delete: new Map(),
    list: new Map(),
  };
  const otherActions: Record<string, number> = {};
  for (const g of groups) {
    const n = Number(g?.sum?.requests ?? 0);
    if (!Number.isFinite(n) || n <= 0) continue;
    const action = String(g.dimensions?.actionType ?? "").toLowerCase();
    const date = String(g.dimensions?.date ?? "");
    if (!isKvAction(action)) {
      const key = action || "(vazio)";
      otherActions[key] = (otherActions[key] ?? 0) + n;
      continue;
    }
    totals[action] += n;
    perDay[action].set(date, (perDay[action].get(date) ?? 0) + n);
  }
  const peakDay = {} as KvUsageSummary["peakDay"];
  for (const a of KV_ACTIONS) {
    let best: { date: string; requests: number } | null = null;
    for (const [date, requests] of perDay[a]) {
      if (!best || requests > best.requests) best = { date, requests };
    }
    peakDay[a] = best;
  }
  return { totals, peakDay, otherActions };
}

/** Interpreta a resposta do endpoint GraphQL de analytics. */
export function interpretKvUsageResponse(httpStatus: number, body: unknown): KvUsageVerdict {
  const b = (body && typeof body === "object" ? body : {}) as {
    errors?: { message?: string }[] | null;
    data?: { viewer?: { accounts?: { kvOperationsAdaptiveGroups?: KvUsageGroup[] }[] } } | null;
  };
  if (httpStatus < 200 || httpStatus >= 300) {
    const msg = (b.errors ?? []).map((e) => e?.message ?? "").filter(Boolean).join("; ");
    return { kind: "error", detail: `HTTP ${httpStatus}${msg ? `: ${msg}` : ""}` };
  }
  if (Array.isArray(b.errors) && b.errors.length > 0) {
    return {
      kind: "error",
      detail: b.errors.map((e) => e?.message ?? "?").join("; "),
    };
  }
  const accounts = b.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return { kind: "error", detail: "resposta sem a conta pedida (accountTag errado ou token sem Account Analytics:Read)" };
  }
  const groups = accounts[0]?.kvOperationsAdaptiveGroups;
  if (!Array.isArray(groups)) {
    return { kind: "error", detail: "resposta sem kvOperationsAdaptiveGroups" };
  }
  if (groups.length === 0) {
    return { kind: "error", detail: KV_USAGE_NO_DATA_DETAIL };
  }
  return { kind: "ok", summary: summarizeKvUsage(groups) };
}

// ── Relatório ────────────────────────────────────────────────────────────────

/** `usage` e `usageError` são mutuamente exclusivos; os dois ausentes = uso não consultado. */
export type UsageFields =
  | { usage: KvUsageSummary; usageError?: never }
  | { usage?: never; usageError: string }
  | { usage?: never; usageError?: never };

export interface QuotaComparison {
  period: "month" | "day";
  source: string;
  rows: { action: KvAction; used: number; limit: number; pct: number; peakDate?: string }[];
}

interface ReportBase {
  /** Mensagem principal para o terminal. */
  message: string;
  window: MonthWindow;
}

export type PlanReport = ReportBase &
  UsageFields &
  (
    | {
        status: "verified";
        plan: WorkersPlan;
        planReason: string;
        /** Uso contra a cota, só quando o uso também foi verificado. */
        quotaComparison?: QuotaComparison;
      }
    /** Sem Billing:Read (ou token inválido/expirado): nunca há palpite de plano. */
    | { status: "unverified" }
    /** Assinatura de Workers fora do padrão conhecido: plano não verificado. */
    | { status: "unrecognized"; unrecognized: string[] }
    | { status: "error" }
  );

export type PlanReportStatus = PlanReport["status"];

/** Exit codes do CLI. */
export const EXIT_VERIFIED = 0;
export const EXIT_ERROR = 1;
export const EXIT_NO_BILLING_PERMISSION = 3;
/** Plano verificado, mas o uso de KV não (erro na GraphQL ou sem dados). */
export const EXIT_USAGE_UNVERIFIED = 4;
/** Assinatura de Workers não reconhecida pelo padrão: plano não verificado. */
export const EXIT_WORKERS_UNRECOGNIZED = 5;

export function exitCodeFor(report: PlanReport): number {
  switch (report.status) {
    case "verified":
      return report.usage ? EXIT_VERIFIED : EXIT_USAGE_UNVERIFIED;
    case "unverified":
      return EXIT_NO_BILLING_PERMISSION;
    case "unrecognized":
      return EXIT_WORKERS_UNRECOGNIZED;
    case "error":
      return EXIT_ERROR;
  }
}

/** Junta os vereditos das duas consultas num relatório. */
export function buildPlanReport(input: {
  window: MonthWindow;
  subscriptions: SubscriptionsVerdict;
  usage: KvUsageVerdict | null;
}): PlanReport {
  const { window, subscriptions, usage } = input;
  const usageFields: UsageFields =
    usage === null
      ? {}
      : usage.kind === "ok"
        ? { usage: usage.summary }
        : { usageError: usage.detail };

  if (subscriptions.kind === "no-billing-permission") {
    return {
      status: "unverified",
      message:
        `Plano da conta NÃO verificado: ${NO_BILLING_PERMISSION_MESSAGE} ` +
        `(HTTP ${subscriptions.httpStatus}, ${subscriptions.detail}). ` +
        "Ação: conferir se o token é válido e dar Account › Billing › Read a ele " +
        "(ou definir CLOUDFLARE_BILLING_TOKEN com um token só de leitura). " +
        "Não assuma plano gratuito nem pago a partir desta saída.",
      window,
      ...usageFields,
    };
  }
  if (subscriptions.kind === "error") {
    return {
      status: "error",
      message: `Falha ao consultar as assinaturas da conta (HTTP ${subscriptions.httpStatus}, ${subscriptions.detail}). Plano não verificado.`,
      window,
      ...usageFields,
    };
  }

  const cls = classifyWorkersPlan(subscriptions.subscriptions);
  if (cls.plan === "workers-unrecognized") {
    return {
      status: "unrecognized",
      unrecognized: cls.unrecognized,
      message:
        `Plano Workers NÃO verificado: ${cls.reason}. ` +
        "O padrão de rate plan de scripts/lib/cloudflare-plan.ts não reconhece essa(s) assinatura(s); " +
        "conferir os rótulos acima e ajustar o padrão. Não assuma plano gratuito nem pago a partir desta saída.",
      window,
      ...usageFields,
    };
  }

  const plan: WorkersPlan = cls.plan;
  let quotaComparison: QuotaComparison | undefined;
  if (usage?.kind === "ok") {
    const quota = KV_QUOTAS[plan];
    quotaComparison = {
      period: quota.period,
      source: quota.source,
      rows: KV_ACTIONS.map((action) => {
        const limit = quota.limits[action];
        const peak = usage.summary.peakDay[action];
        const used = quota.period === "month" ? usage.summary.totals[action] : (peak?.requests ?? 0);
        return {
          action,
          used,
          limit,
          pct: limit > 0 ? Math.round((used / limit) * 1000) / 10 : 0,
          ...(quota.period === "day" && peak ? { peakDate: peak.date } : {}),
        };
      }),
    };
  }
  return {
    status: "verified",
    plan,
    planReason: cls.reason,
    message: `Plano Workers verificado: ${plan === "workers-paid" ? "Workers Paid" : "Workers Free"} (${cls.reason}).`,
    window,
    ...usageFields,
    ...(quotaComparison ? { quotaComparison } : {}),
  };
}

function fmt(n: number): string {
  return n.toLocaleString("pt-BR");
}

/** Texto para o terminal. */
export function renderPlanReport(report: PlanReport): string {
  const lines: string[] = [];
  lines.push(`[cloudflare-plan] ${report.message}`);
  lines.push(`Janela de uso: ${report.window.start} a ${report.window.end} (UTC)`);
  if (report.usage) {
    const t = report.usage.totals;
    lines.push(
      `Uso de KV no mês: read ${fmt(t.read)} · write ${fmt(t.write)} · delete ${fmt(t.delete)} · list ${fmt(t.list)}`,
    );
    const other = Object.entries(report.usage.otherActions);
    if (other.length > 0) {
      lines.push(`  outras ações: ${other.map(([k, v]) => `${k} ${fmt(v)}`).join(" · ")}`);
    }
    lines.push(
      "  (analytics amostrado do kvOperationsAdaptiveGroups; no mês corrente o último dia está parcial: " +
        "ordem de grandeza contra a cota, não conferência de fatura)",
    );
  } else if (report.usageError) {
    lines.push(`Uso de KV não verificado: ${report.usageError}`);
  }
  if (report.status === "verified" && report.quotaComparison) {
    const q = report.quotaComparison;
    lines.push(
      q.period === "month"
        ? `Contra a cota mensal incluída (${q.source}):`
        : `Contra o teto DIÁRIO do plano (maior dia do mês; ${q.source}):`,
    );
    for (const r of q.rows) {
      lines.push(
        `  ${r.action.padEnd(6)} ${fmt(r.used).padStart(12)} / ${fmt(r.limit).padStart(12)}  (${r.pct}%)${r.peakDate ? ` em ${r.peakDate}` : ""}`,
      );
    }
  } else if (report.status !== "verified" && report.usage) {
    lines.push("Sem plano verificado, o uso não é comparado com cota nenhuma.");
  }
  return lines.join("\n");
}
