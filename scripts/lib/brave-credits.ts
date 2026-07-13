/**
 * brave-credits.ts (#1558)
 *
 * Counter persistente de queries Brave Search. Cada chamada bem-sucedida
 * (`status: ok` ou `rate_limited`) vira 1 linha em `data/brave-credits.jsonl`.
 * Queries com `status: error` NÃO contam como query cobrada — mas (#3389) PODEM
 * ser gravadas mesmo assim, só pra preservar uma leitura fresca do header
 * `X-RateLimit-Remaining` quando ele veio presente na resposta de erro (ex: 402
 * "usage limit exceeded" quando o free tier esgota). Ver `computeBraveCreditStats`
 * abaixo — o guard `entry.status === "error"` exclui essas entradas da contagem,
 * mas ainda usa seu `quota_remaining` pra atualizar `quota_remaining_last_seen`.
 *
 * Free tier: 2000 queries/mês. Counter local dá visibilidade imediata —
 * dashboard Brave tem ~1h de delay.
 *
 * ## Semântica de query (#2378, revisado #3389)
 *
 * - **1 entrada = 1 query cobrada, EXCETO entradas `status: "error"`.** Cada
 *   chamada `braveSearch()` que retorna `ok` ou `rate_limited` gera exatamente
 *   1 entrada via `recordBraveCredit`, contada em `queries_this_month`/`_edition`.
 *   Não há batching — `count` (nº de resultados por query) não afeta o crédito.
 *   Entradas `status: "error"` (ver #3389 acima) NUNCA contam pra esses totais,
 *   independente de estarem no arquivo.
 *
 * - **Retries de falha NÃO contam duplo como query cobrada.** Um retry após
 *   `status: "error"` pode gravar uma entrada (só pro header, #3389 — ver
 *   `shouldRecordBraveResponse` em `fetch-websearch-batch.ts`), mas ela é
 *   excluída da contagem de créditos. Se o retry subsequente retornar `ok`,
 *   conta 1 crédito — comportamento correto (Brave cobra o retry como query
 *   nova). Não existe retry automático dentro de `braveSearch` nem de
 *   `fetch-websearch-batch.ts` — um retry é sempre uma nova invocação externa
 *   ao script, não um loop interno que duplicaria o counter.
 *
 * - **Escopo mensal usa UTC de ponta a ponta.** `timestamp` é gravado como
 *   `new Date().toISOString()` (UTC). `monthPrefix` é `now.toISOString()
 *   .slice(0,7)` (UTC). Ambos usam UTC → filtro de mês é consistente
 *   independentemente do timezone da máquina (BRT ou qualquer outro).
 *   O ciclo de 2000 queries/mês do Brave é também UTC-calendário, então
 *   a escolha de UTC é correta (não introduz desvio de 3h vs BRT).
 *
 * - **`daysInMonth` para projeção.** Calculado como
 *   `new Date(getUTCFullYear(), getUTCMonth() + 1, 0).getDate()` — correto:
 *   `Date(year, month+1, 0)` retorna o último dia do mês corrente UTC
 *   independentemente do timezone local da máquina.
 *
 * - **Fonte dos dados:** exclusivamente `data/brave-credits.jsonl` (append-only,
 *   gravado em runtime por `fetch-websearch-batch.ts`). Não há leitura de
 *   Beehiiv, run-log ou qualquer API externa — o counter é 100% local.
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

export const DEFAULT_PATH = "data/brave-credits.jsonl";

// (#3122) Sidecar de estado do reconcile — sobrevive à virada de mês (ao contrário
// dos stats de `computeBraveCreditStats`, que são escopados ao mês-calendário
// corrente). Ver `readBraveReconcileState`/`writeBraveReconcileState` abaixo.
export const DEFAULT_RECONCILE_STATE_PATH = "data/brave-reconcile-state.json";

export interface BraveCreditEntry {
  timestamp: string; // ISO 8601
  edition?: string; // AAMMDD when called from edition context
  query: string;
  // (#3389) "error" added: entries recorded SOLELY to preserve a fresh
  // `quota_remaining` reading when the query itself failed (e.g., 402 "usage
  // limit exceeded" once the free tier is exhausted) — see
  // `computeBraveCreditStats` below for why these must NEVER count toward
  // queries_this_month/_edition (Brave does not charge failed requests).
  status: "ok" | "rate_limited" | "error";
  http_status?: number;
  quota_remaining?: number; // X-RateLimit-Remaining from Brave API response (#2608 C)
  estimated?: true; // present when entry is an estimate, not a real API call (#2608 A)
  source?: string; // originating agent/step for estimated entries
}

/**
 * Append uma entrada ao log de créditos. Cria dir/arquivo se ausente.
 * No-op silent se path inválido (defensive — counter não pode quebrar pipeline).
 */
function ensureDir(fullPath: string): void {
  const dir = dirname(fullPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function recordBraveCredit(
  entry: Omit<BraveCreditEntry, "timestamp">,
  path: string = DEFAULT_PATH,
): void {
  try {
    const fullPath = resolve(process.cwd(), path);
    ensureDir(fullPath);
    const fullEntry: BraveCreditEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    appendFileSync(fullPath, JSON.stringify(fullEntry) + "\n", "utf8");
  } catch {
    // Counter não pode quebrar pipeline
  }
}

/**
 * (#2608 A) Estimativa de queries consumidas por agentes Path B (source-researcher /
 * discovery-searcher via harness WebSearch), que não passam por recordBraveCredit().
 *
 * Escreve `count` entradas com `estimated: true` no JSONL. O campo `source` identifica
 * o passo que gerou a estimativa. Hoje a única fonte é `path-b-reconcile`
 * (`scripts/reconcile-brave-path-b.ts`, #2668) — NÃO usar outro `source` pra a mesma
 * edição/mês: o guard de idempotência é keyed em edition+source+mês, então duas
 * fontes distintas pra a mesma edição contariam em dobro. As entradas são somadas em
 * `computeBraveCreditStats` junto das reais, distinguidas em `_estimated` vs `_real`.
 *
 * `now` injetável (default new Date()) — usado p/ monthPrefix (idempotência) E
 * timestamp das entradas, pra ambos ficarem no MESMO mês (sem split em virada de mês).
 *
 * ## Valor de retorno (#3271)
 *
 * Retorna `true` quando as `count` entradas foram de fato gravadas no JSONL, `false`
 * em qualquer outro caso (count não-finito, count<=0, guard de idempotência disparou —
 * já existe entry pra este edition+source+mês —, ou falha de I/O). Callers que derivam
 * estado incremental do resultado (ex: `reconcile-brave-path-b.ts` avançando seu anchor)
 * DEVEM checar este retorno antes de considerar o gap "reconciliado" — um no-op de
 * idempotência não é uma escrita bem-sucedida, e tratá-lo como tal perde o gap
 * permanentemente (a causa raiz da issue #3271).
 */
export function recordBraveCreditEstimate(
  {
    edition,
    source,
    count,
  }: { edition?: string; source: string; count: number },
  path: string = DEFAULT_PATH,
  now: Date = new Date(),
): boolean {
  if (!Number.isFinite(count)) {
    // #2630 — warn explícito para count não-finito (NaN/±Infinity); não engolir silenciosamente.
    // Causa original: LLM passava expressão não-avaliada ({N}*2+{M}+{J}) que resultava em NaN
    // quando alguma variável era undefined. O gap ficava invisível porque o no-op era silencioso.
    console.warn(
      `[brave-credits] recordBraveCreditEstimate: count não-finito (${count}) — estimativa ignorada.` +
        ` source=${source}, edition=${edition ?? "n/a"}`,
    );
    return false;
  }
  // (#3271 review) Round ANTES do gate <=0: um count fracionário como 0.4 passa
  // `count > 0` mas arredonda pra 0 — sem este reorder, a função geraria 0 entradas
  // reais (só um "\n" em branco) e AINDA retornaria `true`, quebrando o contrato
  // "true ⇒ pelo menos 1 entrada foi de fato gravada" que reconcile-brave-path-b.ts
  // agora depende para decidir se avança seu anchor.
  count = Math.round(count);
  if (count <= 0) return false;
  try {
    const fullPath = resolve(process.cwd(), path);
    ensureDir(fullPath);
    const monthPrefix = now.toISOString().slice(0, 7);
    // Idempotency guard: skip if an estimated entry for this edition+source already exists this month
    if (edition && source && existsSync(fullPath)) {
      const existing = readFileSync(fullPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .some((l) => {
          try {
            const e = JSON.parse(l);
            return (
              e.estimated === true &&
              e.edition === edition &&
              e.source === source &&
              typeof e.timestamp === "string" &&
              e.timestamp.startsWith(monthPrefix)
            );
          } catch {
            return false;
          }
        });
      if (existing) return false;
    }
    const ts = now.toISOString();
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      const entry: BraveCreditEntry = {
        timestamp: ts,
        query: `[estimated:${source}:${i + 1}/${count}]`,
        status: "ok",
        estimated: true,
        source,
        ...(edition ? { edition } : {}),
      };
      lines.push(JSON.stringify(entry));
    }
    appendFileSync(fullPath, lines.join("\n") + "\n", "utf8");
    return true;
  } catch {
    // Counter não pode quebrar pipeline
    return false;
  }
}

export interface BraveCreditStats {
  queries_this_edition: number;
  queries_this_month: number;
  // (#2608 A) breakdown real vs estimated
  queries_this_edition_real: number;
  queries_this_edition_estimated: number;
  queries_this_month_real: number;
  queries_this_month_estimated: number;
  free_tier_limit: number;
  percent_used: number;
  projected_month_end: number | null;
  alert_level: "ok" | "warn" | "critical";
  // (#2608 C) reconciliação com quota real via header X-RateLimit-Remaining
  quota_remaining_last_seen?: number; // last value seen from Brave API header
  delta_untracked?: number; // real_used − local_counted (queries not tracked locally)
  // base do alerta: o MAIOR entre contagem local e uso real do header Brave.
  effective_used: number;
  alert_basis: "local" | "brave_header";
  // (#3002) true quando o header foi descartado por divergência implausível
  // vs. a contagem local (sinal de ciclo de rate-limit desalinhado do Brave,
  // não uso real subnotificado).
  header_discarded?: true;
  // (#3122) uso absoluto derivado do header (`FREE_TIER_LIMIT - quota_remaining_last_seen`,
  // clampado ≥0), SEM o desconto de `queries_this_month` e SEM o guard de descarte
  // de #3002 aplicado ao valor em si (só reflete se o header foi lido — permanece
  // ausente quando não há `quota_remaining` este mês). Existe para consumidores
  // (como `reconcile-brave-path-b.ts`) que precisam do valor cumulativo bruto do
  // ciclo de cobrança do Brave para diffar contra uma leitura anterior — usar
  // `delta_untracked`/`effective_used` para relato ao editor, não este campo.
  real_used_raw?: number;
  // (#3389) idade, em horas, da entrada que produziu `quota_remaining_last_seen`
  // (now − timestamp dessa entrada). Defesa em profundidade complementar ao fix
  // de #3389 (gravar o header também em respostas de erro): mesmo que uma
  // situação futura volte a impedir a leitura fresca do header (ex: Brave para
  // de enviar X-RateLimit-Remaining em respostas 402 — não verificável nesta
  // sessão sem BRAVE_API_KEY live), este campo torna a estagnação VISÍVEL no
  // relatório em vez de silenciosa, para que "critical" nunca seja lido como
  // uma leitura de agora quando na verdade é de dias atrás. Ausente quando não
  // há quota_remaining este mês.
  quota_remaining_age_hours?: number;
}

export const FREE_TIER_LIMIT = 2000;
const WARN_THRESHOLD = 0.8;
const CRITICAL_THRESHOLD = 0.95;

// (#3002) `X-RateLimit-Remaining` reflete o ciclo interno de rate-limit da Brave,
// que pode desalinhar do mês-calendário (ex: resquício do ciclo anterior que não
// zerou junto com o dashboard oficial em 1º/mês). Quando isso acontece, o valor
// derivado do header (`2000 - remaining`) explode muito além do que a contagem
// local + Path B plausivelmente explicariam — sinal de ciclo errado, não de
// subnotificação real. Descartamos o header nesse caso e caímos pra contagem local.
//
// Threshold escolhido: header-derived-usage > 10× a contagem local (com piso de 1
// pra evitar divisão por zero em mês com 0 queries locais ainda). Calibrado contra
// os dois casos conhecidos:
//   - Falso positivo (#3002, edição 260706): local=55, header-derived=1951 → ~35×
//     → descartado corretamente.
//   - Caso legítimo que motivou #2668 (jun/2026): local=999, header-derived=1951 →
//     ~2× → NÃO descartado, header continua autoritativo (Path B genuinamente
//     subnotificado por contagem local incompleta).
const HEADER_DIVERGENCE_DISCARD_RATIO = 10;

/**
 * Pure: lê o JSONL, filtra por mês corrente (e edição se informada),
 * retorna stats agregadas. Linhas inválidas são puladas silently.
 */
export function computeBraveCreditStats(
  edition: string | null = null,
  path: string = DEFAULT_PATH,
  now: Date = new Date(),
): BraveCreditStats {
  const fullPath = resolve(process.cwd(), path);
  if (!existsSync(fullPath)) {
    return {
      queries_this_edition: 0,
      queries_this_month: 0,
      queries_this_edition_real: 0,
      queries_this_edition_estimated: 0,
      queries_this_month_real: 0,
      queries_this_month_estimated: 0,
      free_tier_limit: FREE_TIER_LIMIT,
      percent_used: 0,
      projected_month_end: null,
      alert_level: "ok",
      effective_used: 0,
      alert_basis: "local",
    };
  }

  const content = readFileSync(fullPath, "utf8");
  const lines = content.split("\n").filter(Boolean);

  const monthPrefix = now.toISOString().slice(0, 7); // YYYY-MM
  let queries_this_month_real = 0;
  let queries_this_month_estimated = 0;
  let queries_this_edition_real = 0;
  let queries_this_edition_estimated = 0;
  let quota_remaining_last_seen: number | undefined;
  let quota_remaining_last_seen_ts: string | undefined; // (#3389) staleness tracking

  for (const line of lines) {
    let entry: BraveCreditEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.timestamp !== "string") continue;

    if (!entry.timestamp.startsWith(monthPrefix)) continue;

    // (#2608 C) track last quota_remaining seen — scoped to this month so cross-month
    // values from previous billing cycles don't corrupt delta_untracked at cycle boundaries
    if (typeof entry.quota_remaining === "number") {
      quota_remaining_last_seen = entry.quota_remaining;
      quota_remaining_last_seen_ts = entry.timestamp; // (#3389)
    }

    // (#3389) "error" entries exist ONLY to keep quota_remaining_last_seen fresh
    // during free-tier exhaustion (fetch-websearch-batch.ts's runQuery records
    // them for their header alone once every query starts failing with 402 —
    // see shouldRecordBraveResponse). Brave doesn't charge failed requests, so
    // these must NEVER inflate queries_this_month/_edition — a "real" query
    // count that grows just because we kept retrying a query Brave rejected
    // would be its own false signal, on top of the one this fix addresses.
    if (entry.status === "error") continue;

    const isEstimated = entry.estimated === true;
    if (isEstimated) {
      queries_this_month_estimated++;
      if (edition && entry.edition === edition) queries_this_edition_estimated++;
    } else {
      queries_this_month_real++;
      if (edition && entry.edition === edition) queries_this_edition_real++;
    }
  }

  const queries_this_month = queries_this_month_real + queries_this_month_estimated;
  const queries_this_edition = queries_this_edition_real + queries_this_edition_estimated;

  // Uso real do header (clamp ≥ 0 — defensivo contra quota_remaining > limite,
  // ex: mudança de API ou janela errada, que daria real_used negativo).
  const real_used =
    typeof quota_remaining_last_seen === "number"
      ? Math.max(0, FREE_TIER_LIMIT - quota_remaining_last_seen)
      : undefined;

  // (#3002) Descartar o header quando ele diverge implausivelmente da contagem
  // local — sinal de ciclo de rate-limit desalinhado do Brave, não subnotificação
  // real. Ver comentário de HEADER_DIVERGENCE_DISCARD_RATIO acima.
  let header_discarded: true | undefined;
  let real_used_for_alert = real_used;
  if (
    real_used !== undefined &&
    real_used > Math.max(queries_this_month, 1) * HEADER_DIVERGENCE_DISCARD_RATIO
  ) {
    header_discarded = true;
    real_used_for_alert = undefined;
  }

  // Alerta: o header X-RateLimit-Remaining do Brave inclui o Path B (WebSearch
  // dos agentes) que NÃO passa pelo counter local — quando plausível, dirigir o
  // alerta pelo MAIOR entre contagem local e uso real do header, pra nunca
  // subnotificar. (Causa original do esgotamento de jun/2026 — #2668: local=999
  // mas Brave contava 1951; o alerta confiava nos 999 → "ok" → voamos pelo $5.
  // Esse caso segue coberto: divergência ~2× não é descartada.) Quando o header
  // foi descartado por divergência implausível (#3002), cair pra contagem local.
  let effective_used = queries_this_month;
  let alert_basis: BraveCreditStats["alert_basis"] = "local";
  if (real_used_for_alert !== undefined && real_used_for_alert > effective_used) {
    effective_used = real_used_for_alert;
    alert_basis = "brave_header";
  }

  // (#2608 C) delta = queries cobradas pelo Brave − (reais + estimadas locais).
  // delta ≈ 0 → estimativas corretas; delta > 0 → gap não explicado (Path B > estimativa).
  // (#3002) Quando o header foi descartado, delta_untracked fica ausente — ele
  // não representa mais um gap real, e mostrá-lo confundiria o relatório.
  const delta_untracked =
    real_used_for_alert !== undefined ? real_used_for_alert - queries_this_month : undefined;

  // Projeção: extrapolar linear pelo dia do mês. Base = effective_used quando o
  // header é autoritativo (senão a projeção contradiria o alerta: "97% crítico"
  // + "projeção ~5"); senão só queries reais locais (estimativas vêm em lote
  // único no Stage 1 → incluí-las inflaria ~10× a projeção no início do mês).
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getDate();
  const projectionBase =
    alert_basis === "brave_header" ? effective_used : queries_this_month_real;
  const projected_month_end =
    dayOfMonth > 0 ? Math.round((projectionBase / dayOfMonth) * daysInMonth) : null;

  const percent_used = effective_used / FREE_TIER_LIMIT;
  const alert_level: BraveCreditStats["alert_level"] =
    percent_used >= CRITICAL_THRESHOLD
      ? "critical"
      : percent_used >= WARN_THRESHOLD
        ? "warn"
        : "ok";

  // (#3389) Idade da leitura do header em horas — defesa em profundidade (ver
  // doc do campo em BraveCreditStats acima). NaN-safe: só computa quando o
  // timestamp parseia; nunca lança.
  let quota_remaining_age_hours: number | undefined;
  if (quota_remaining_last_seen_ts) {
    const readAt = new Date(quota_remaining_last_seen_ts).getTime();
    if (!isNaN(readAt)) {
      quota_remaining_age_hours = Math.round(((now.getTime() - readAt) / 3600000) * 10) / 10;
    }
  }

  return {
    queries_this_edition,
    queries_this_month,
    queries_this_edition_real,
    queries_this_edition_estimated,
    queries_this_month_real,
    queries_this_month_estimated,
    free_tier_limit: FREE_TIER_LIMIT,
    percent_used: Math.round(percent_used * 10000) / 100, // 2 decimais como %
    projected_month_end,
    alert_level,
    effective_used,
    alert_basis,
    ...(typeof quota_remaining_last_seen === "number" ? { quota_remaining_last_seen } : {}),
    ...(typeof delta_untracked === "number" ? { delta_untracked } : {}),
    ...(header_discarded ? { header_discarded } : {}),
    ...(typeof real_used === "number" ? { real_used_raw: real_used } : {}),
    ...(typeof quota_remaining_age_hours === "number" ? { quota_remaining_age_hours } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reconcile state (#3122)
// ---------------------------------------------------------------------------

/**
 * Estado persistido do ÚLTIMO run bem-sucedido (não-no-op, header não-descartado)
 * de `reconcile-brave-path-b.ts`. Ao contrário de `computeBraveCreditStats`, que
 * escopa tudo ao mês-calendário corrente, este estado sobrevive à virada de mês —
 * é a âncora que permite ao reconcile calcular o delta INCREMENTAL do header desde
 * a última rodada, em vez do gap absoluto (`header − tracked_do_mês_corrente`),
 * que mis-atribui todo o residual de ciclos de cobrança anteriores ao mês novo
 * (causa raiz do alarme falso em #3122 — o header do Brave é cumulativo pelo
 * CICLO DE COBRANÇA da conta, não pelo mês-calendário).
 */
export interface BraveReconcileState {
  /** Último `X-RateLimit-Remaining` visto (para diagnóstico). */
  quota_remaining: number;
  /** `FREE_TIER_LIMIT - quota_remaining`, clampado ≥0 — a âncora usada no diff. */
  real_used: number;
  /** Quando este estado foi gravado (ISO 8601). */
  timestamp: string;
}

/** Lê o estado persistido. Retorna null se ausente, corrompido ou com shape inválido. */
export function readBraveReconcileState(
  path: string = DEFAULT_RECONCILE_STATE_PATH,
): BraveReconcileState | null {
  try {
    const fullPath = resolve(process.cwd(), path);
    if (!existsSync(fullPath)) return null;
    const parsed = JSON.parse(readFileSync(fullPath, "utf8"));
    if (
      typeof parsed?.quota_remaining !== "number" ||
      typeof parsed?.real_used !== "number" ||
      typeof parsed?.timestamp !== "string"
    ) {
      return null;
    }
    return parsed as BraveReconcileState;
  } catch {
    return null;
  }
}

/** Grava o estado do reconcile. Best-effort — não pode quebrar o pipeline. */
export function writeBraveReconcileState(
  state: BraveReconcileState,
  path: string = DEFAULT_RECONCILE_STATE_PATH,
): void {
  try {
    const fullPath = resolve(process.cwd(), path);
    ensureDir(fullPath);
    writeFileSync(fullPath, JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch {
    // Estado não pode quebrar pipeline
  }
}
