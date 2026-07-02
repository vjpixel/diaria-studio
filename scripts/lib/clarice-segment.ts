/**
 * clarice-segment.ts — segmentação de waves a partir do store único (#2647).
 *
 * Núcleo PURO da redesign "store-driven" do clarice-build-waves (decisão do
 * editor: swap total + re-segmentação por priority_points). Aqui só a lógica
 * testável; o cutover do pipeline de wave (build-waves/import-waves/schedule)
 * consome `segmentFromStore` e fatia em W1..Wn. NÃO vira o default de produção
 * até o store estar populado + Brevo-sincronizado e o editor validar num dry-run.
 *
 * Modelo (os 3 eixos da #2647):
 *   - `send_eligible = 0`  → CORTE (vai pra `excluded` com a razão).
 *   - re-envio (`sends_count > 0`) → ordenado por `priority_points` DESC
 *     (mais engajado primeiro; quem ignorou/decaiu, por último).
 *   - 1º envio (`sends_count = 0`) → ordenado por `tier` ASC (T01 ativo primeiro,
 *     depois ex-assinante, depois leads); tier nulo (só-MV/Brevo, sem proveniência
 *     Stripe) por último.
 *
 * Desempate estável por email ASC em todos os grupos → output determinístico
 * (reproduzível, pré-requisito do pipeline).
 */

// cohortDisplayLabel/cohortFromSafra: cohorts.ts é dependency-free/Workers-safe
// como este módulo (sem import de volta pra cá) — importar daqui não introduz
// ciclo nem dependência de node:sqlite.
import { cohortDisplayLabel, cohortFromSafra } from "./cohorts.ts";

export interface StoreRow {
  email: string;
  tier: number | null;
  priority_points: number;
  send_eligible: number; // 0 | 1
  ineligible_reason: string | null;
  sends_count: number;
}

export interface Segmentation {
  /** Com histórico de envio, por priority_points DESC (re-envio). */
  reSend: StoreRow[];
  /** Sem histórico, por tier ASC (1º envio); tier nulo por último. */
  firstSend: StoreRow[];
  /** send_eligible = 0 (cortados), com a razão. */
  excluded: Array<{ email: string; reason: string }>;
}

/**
 * tier p/ ordenação: nulo vira +∞ (vai pro fim). Exportado (#2807 review):
 * o brevo-dashboard ordena o breakdown por tier com a MESMA regra — não
 * re-derivar lá (mesma classe de drift que o #2782 elimina pro firstSend).
 */
export function tierRank(t: number | null): number {
  return t == null ? Number.POSITIVE_INFINITY : t;
}

// ---------------------------------------------------------------------------
// Predicados de segmentação — fonte ÚNICA (#2782)
// ---------------------------------------------------------------------------
// `segmentFromStore` (ação: fila real de wave) e os relatórios SQL do dashboard
// (visão: clarice-db-summary.ts `by_tier`) precisam concordar sobre o que é
// "firstSend". Antes eram 2 implementações paralelas (JS aqui, SQL cru lá) que
// divergiam silenciosamente a cada mudança de regra (#2732/#2735). Agora ambos
// consomem estes predicados; `test/clarice-segment.test.ts` assegura a
// equivalência JS ⇄ SQL sobre um store real.

/** Elegível pra envio? Falsy (0 OU null nunca-recomputado) → corte fail-safe. */
export function isSendEligible(r: Pick<StoreRow, "send_eligible">): boolean {
  return Boolean(r.send_eligible);
}

/**
 * 1º envio: elegível E nunca recebeu email (sends_count 0, null, negativo ou NaN).
 *
 * `!(sends_count > 0)` (não `=== 0`, #2812 item 5): sends_count é
 * COUNT-derivado e nunca deveria ser negativo/NaN no schema atual (coluna
 * INTEGER), mas um valor patológico (dado corrompido / migração futura /
 * StoreRow construído fora do SQLite) tratado como "nunca enviado" é a
 * leitura mais segura — restaura a partição implícita pré-#2782, onde
 * qualquer valor que não fosse estritamente positivo caía no `else`
 * (firstSend) por não bater a condição de re-envio. Com `=== 0` estrito, um
 * sends_count negativo OU NaN caía silenciosamente em reSend (partição
 * errada, sem sinalizar o dado ruim). `!(x > 0)` cobre os dois: `NaN > 0` e
 * `-1 > 0` são ambos `false`, então a negação é `true` em ambos os casos —
 * equivalente a `<= 0` para números reais, mas também correto para NaN
 * (onde `NaN <= 0` seria `false`, o oposto do desejado).
 */
export function isFirstSend(
  r: Pick<StoreRow, "send_eligible" | "sends_count">,
): boolean {
  return isSendEligible(r) && !((r.sends_count ?? 0) > 0);
}

/**
 * Cláusula SQL equivalente a `isFirstSend` (pra agregar via SQL sem carregar o
 * store em JS). Espelhos: `send_eligible=1` ⇄ truthy (a coluna só assume 0|1|
 * NULL — schema em clarice-db.ts); `COALESCE(sends_count,0)<=0` ⇄
 * `!((?? 0) > 0)` — equivalentes para os valores reais que a coluna INTEGER
 * pode assumir (SQLite não representa NaN numa coluna INTEGER, então `<=0`
 * já cobre o mesmo universo que `!(x>0)` cobre em JS; #2812 item 5:
 * sincronizado com o guard de negativo/NaN de `isFirstSend`).
 * Mudou a regra? Mude AQUI e em `isFirstSend` juntos — o teste de equivalência
 * pega drift.
 *
 * #2812 item 4: colunas qualificadas com `clarice_users.` — hoje o único
 * consumidor (`scripts/clarice-db-summary.ts`) usa esta cláusula num
 * `FROM clarice_users WHERE ...` single-table (grep confirmado), então a
 * qualificação é redundante no uso atual, mas documenta a premissa e blinda
 * contra ambiguidade silenciosa se um JOIN futuro introduzir outra tabela
 * com colunas de mesmo nome (`send_eligible`/`sends_count`).
 */
export const FIRST_SEND_SQL_PREDICATE =
  "clarice_users.send_eligible=1 AND COALESCE(clarice_users.sends_count,0)<=0";

/**
 * Segmenta o universo do store nos 3 grupos. Puro e determinístico.
 * A ordem de cada lista É a ordem de prioridade de envio — o cutover fatia em
 * waves de cima pra baixo.
 */
export function segmentFromStore(rows: StoreRow[]): Segmentation {
  const reSend: StoreRow[] = [];
  const firstSend: StoreRow[] = [];
  const excluded: Array<{ email: string; reason: string }> = [];

  for (const r of rows) {
    // Fail-safe: send_eligible falsy (0 OU null de uma linha nunca recomputada)
    // → CORTE. Na dúvida NÃO enviar é a direção segura pro pipeline de envio.
    if (!isSendEligible(r)) {
      excluded.push({ email: r.email, reason: r.ineligible_reason ?? "unknown" });
    } else if (isFirstSend(r)) {
      firstSend.push(r);
    } else {
      reSend.push(r);
    }
  }

  reSend.sort(
    (a, b) =>
      (b.priority_points ?? 0) - (a.priority_points ?? 0) ||
      a.email.localeCompare(b.email),
  );
  // Comparador explícito (não subtrai ranks) — tierRank pode ser +∞ e
  // (+∞)−(+∞)=NaN quebraria a ordenação entre dois tiers nulos.
  firstSend.sort((a, b) => {
    const ra = tierRank(a.tier);
    const rb = tierRank(b.tier);
    if (ra !== rb) return ra < rb ? -1 : 1;
    return a.email.localeCompare(b.email);
  });

  return { reSend, firstSend, excluded };
}

/**
 * Fila de prioridade de ENVIO a partir da segmentação (#2656 cutover). Ordem de
 * warm-up: re-envio ENGAJADO primeiro (priority_points > 0, mais alto antes),
 * depois 1º envio por tier (T01 ativo → leads), e por último o re-envio
 * DECAÍDO (quem ignorou — priority_points ≤ 0). Assim quem prova engajamento
 * encabeça a fila, contatos novos entram no meio, e re-tentar quem ignora fica
 * por último. Determinístico (reSend/firstSend já vêm ordenados de segmentFromStore).
 */
export function priorityQueue(seg: Segmentation): StoreRow[] {
  // `?? 0`: priority_points pode ser null (coluna sem NOT NULL / linha pré-recompute).
  // Sem o coalesce, `null > 0` e `null <= 0` são AMBOS false → a linha sumiria da
  // fila (perda silenciosa). null → 0 → cai em decaído.
  const engagedReSend = seg.reSend.filter((r) => (r.priority_points ?? 0) > 0);
  const decayedReSend = seg.reSend.filter((r) => (r.priority_points ?? 0) <= 0);
  return [...engagedReSend, ...seg.firstSend, ...decayedReSend];
}

/**
 * Fatia uma lista já ordenada em waves de no máximo `maxSize` (conveniência do
 * cutover). Preserva a ordem; a última wave pode ser menor. `maxSize <= 0` → 1
 * wave com tudo.
 */
export function sliceIntoWaves<T>(ordered: T[], maxSize: number): T[][] {
  if (maxSize <= 0) return ordered.length ? [ordered.slice()] : [];
  const out: T[][] = [];
  for (let i = 0; i < ordered.length; i += maxSize) {
    out.push(ordered.slice(i, i + maxSize));
  }
  return out;
}

/** Lê as linhas relevantes pra segmentação do store SQLite. */
export function loadStoreRows(db: {
  prepare: (sql: string) => { all: () => unknown[] };
}): StoreRow[] {
  return db
    .prepare(
      `SELECT email, tier, priority_points, send_eligible, ineligible_reason, sends_count
         FROM clarice_users`,
    )
    .all() as StoreRow[];
}

// ---------------------------------------------------------------------------
// cohort (#2817) — safra mensal derivada de `created` (Stripe), dimensão
// independente do `tier` numérico (que continua governando SÓ a ordenação de
// 1º envio). Pedido do editor 260702: "coloque todos os contatos de junho no
// tier junho e os de maio no maio" — modelado como coluna nova em vez de
// tiers nomeados (ver decisão registrada na issue #2817).
//
// Funções puras aqui (não em clarice-db.ts, que importa `node:sqlite` — o
// worker `brevo-dashboard` importa deste arquivo diretamente, igual `tierRank`,
// porque o runtime do Worker não tem `node:sqlite`).
// ---------------------------------------------------------------------------

/** Primeiro mês com safra rotulada (decisão do editor, #2817). Anterior → NULL. */
const COHORT_EPOCH_YEAR = 2026;
const COHORT_EPOCH_MONTH = 5; // maio (1-indexed)

/**
 * Deriva a safra mensal ('YYYY-MM', forma canônica) a partir de `created`
 * (ISO date/datetime da Stripe). NULL se `created` ausente/inválido ou
 * anterior a 2026-05 (dado histórico sem safra rotulada). Extensível: qualquer
 * mês >= 2026-05 vira 'YYYY-MM' sem precisar de mudança de código (não há
 * lista hardcoded de meses futuros).
 */
export function deriveCohort(created: string | null | undefined): string | null {
  if (!created) return null;
  const d = new Date(created);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1; // 1-12
  if (year < COHORT_EPOCH_YEAR || (year === COHORT_EPOCH_YEAR && month < COHORT_EPOCH_MONTH)) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

const PT_MONTH_NAMES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

/**
 * Rótulo de exibição pro dashboard. #2857 fase A: a coluna `cohort` do store
 * passou a guardar o slug da taxonomia unificada (`assinantes-ativos`,
 * `leads-2026-06`, `leads-2025h2`, `leads-caudao`...) em vez de só a safra
 * crua 'YYYY-MM' (#2817) — delega pra `cohortDisplayLabel` (scripts/lib/
 * cohorts.ts), que cobre todos os slugs da taxonomia. Mantido aqui (thin
 * wrapper, mesma assinatura) porque é o símbolo que os callers existentes
 * (`workers/brevo-dashboard`) importam — trocar o import em todo consumidor
 * não é escopo da fase A.
 */
export function cohortLabel(cohort: string | null): string {
  return cohortDisplayLabel(cohort);
}

/**
 * Resolve o valor de `--cohort` passado na CLI (rótulo pt-BR tipo "junho" OU
 * a forma canônica "YYYY-MM") pro valor exato armazenado na coluna `cohort`.
 * Rótulo pt-BR só é reconhecido pra o ano corrente da epoch (2026 — único ano
 * com safras rotuladas até agora); pra outro ano, use a forma canônica direto
 * ("2027-01"). Lança se o input não bater com nenhuma das duas formas —
 * preferível a um filtro silenciosamente vazio.
 *
 * #2857 fase A: a coluna `cohort` guarda o slug `leads-YYYY-MM` (não mais a
 * safra crua) — o retorno agora passa pelo mesmo `cohortFromSafra` que
 * `recomputeDerived` usa pra popular a coluna, então o resultado sempre bate
 * com o valor armazenado (`resolveCohortArg('junho')` → `'leads-2026-06'`).
 * Assinatura preservada (string → string) — nenhum caller precisa mudar.
 */
export function resolveCohortArg(input: string): string {
  const trimmed = input.trim();
  if (/^\d{4}-\d{2}$/.test(trimmed)) return cohortFromSafra(trimmed);
  const idx = PT_MONTH_NAMES.indexOf(trimmed.toLowerCase());
  if (idx !== -1) {
    return cohortFromSafra(`${COHORT_EPOCH_YEAR}-${String(idx + 1).padStart(2, "0")}`);
  }
  throw new Error(
    `--cohort "${input}" não reconhecido — use um rótulo pt-BR (ex: junho) ` +
      `ou a forma canônica YYYY-MM (ex: ${COHORT_EPOCH_YEAR}-06).`,
  );
}
