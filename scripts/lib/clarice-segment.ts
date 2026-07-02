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
 *   - 1º envio (`sends_count = 0`) → ordenado por `cohort` (#2857 fase B —
 *     antes era `tier` ASC; `cohortSendRank` é um sucessor PROVADO equivalente
 *     pros 10 cohorts derivados de tier, ver test/cohorts.test.ts): assinante
 *     ativo primeiro, depois ex-assinante, depois leads por recência
 *     decrescente (safra mensal mais nova primeiro), depois caudão; cohort
 *     nulo/desconhecido por último. `tier` permanece no `StoreRow` (dupla-
 *     escrita, compat da fase B — a remoção é fase C).
 *
 * Desempate estável por email ASC em todos os grupos → output determinístico
 * (reproduzível, pré-requisito do pipeline).
 */

// cohortDisplayLabel/cohortFromSafra/cohortSendRank/cohortFromTier/
// isKnownCohortSlug: cohorts.ts é dependency-free/Workers-safe como este
// módulo (sem import de volta pra cá) — importar daqui não introduz ciclo nem
// dependência de node:sqlite.
import {
  cohortDisplayLabel,
  cohortFromSafra,
  cohortFromTier,
  cohortSendRank,
  isKnownCohortSlug,
} from "./cohorts.ts";

export interface StoreRow {
  email: string;
  tier: number | null;
  // #2857 fase B: coluna nova do store (slug de cohort nomeado — ver
  // scripts/lib/cohorts.ts). Governa a ordenação de 1º envio (ver
  // `segmentFromStore` abaixo, que troca `tierRank` por `cohortSendRank`).
  // Opcional (compat): consumidores que não passam pelo store real (ex:
  // scripts/lib/clarice-waves-dryrun.ts, que só mede elegibilidade/supressão,
  // não ordem) continuam válidos sem popular o campo — `cohortSendRank(undefined)`
  // degrada com segurança pro fim da fila (mesmo destino de `null`/desconhecido).
  cohort?: string | null;
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
 *
 * #2857 fase B: `segmentFromStore` NÃO usa mais esta função pra ordenar o
 * 1º envio (trocado por `cohortSendRank`, ver import de cohorts.ts) — `tier`
 * virou um atributo derivado/legado do StoreRow (dupla-escrita, fase A/B).
 * `tierRank` continua exportada e viva: o brevo-dashboard degrada pra ela
 * quando o payload do KV é um `by_tier` ANTIGO (pré-#2857-fase-B, ver
 * `workers/brevo-dashboard/src/sections-kv.ts`) — remover só na fase C,
 * quando não houver mais risco de KV cacheado nesse formato.
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
  // #2857 fase B: cohortSendRank (não mais tierRank) governa a ordem de 1º
  // envio — sucessor PROVADO equivalente pros 10 cohorts derivados de tier
  // (test/cohorts.test.ts, propriedade testada) + extensão pras safras
  // mensais (ordenadas por recência, não pelo tier residual que o merge
  // atribuiria). Comparador explícito (não subtrai ranks) — cohortSendRank
  // pode retornar valores enormes (RANK_UNKNOWN/RANK_LEADS_CAUDAO) cuja
  // subtração poderia estourar precisão de float; a comparação direta evita
  // qualquer edge de NaN/overflow.
  firstSend.sort((a, b) => {
    const ra = cohortSendRank(a.cohort);
    const rb = cohortSendRank(b.cohort);
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
      `SELECT email, tier, cohort, priority_points, send_eligible, ineligible_reason, sends_count
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

/** Casa alias de tier legado ("t04", "T4", case-insensitive) — #2857 fase B. */
const TIER_ALIAS_RE = /^t(\d{1,2})$/i;

/**
 * Resolve o valor de `--cohort` passado na CLI pro valor exato armazenado na
 * coluna `cohort`. Formas aceitas, nesta ordem de tentativa:
 *   1. forma canônica de safra "YYYY-MM" → `cohortFromSafra`.
 *   2. rótulo pt-BR do mês ("junho") → resolvido pro ano-epoch (2026).
 *   3. alias de tier LEGADO ("t04"/"T4", #2857 fase B) → `cohortFromTier`,
 *      com warning de depreciação em stderr (o alias é uma ponte de migração,
 *      não o identificador canônico — remoção prevista na fase C).
 *   4. slug canônico da taxonomia já resolvido ("assinantes-ativos",
 *      "leads-2025h2", "leads-2026-06", ...) → devolvido como está
 *      (`isKnownCohortSlug`), depois de rejeitar as 3 formas acima.
 * Rótulo pt-BR (forma 2) só é reconhecido pra o ano corrente da epoch (2026 —
 * único ano com safras rotuladas até agora); pra outro ano, use a forma
 * canônica direto ("2027-01"). Lança se o input não bater com NENHUMA das 4
 * formas — preferível a um filtro silenciosamente vazio.
 *
 * #2857 fase A: a coluna `cohort` guarda o slug `leads-YYYY-MM` (não mais a
 * safra crua) — o retorno das formas 1/2 passa pelo mesmo `cohortFromSafra`
 * que `recomputeDerived` usa pra popular a coluna, então o resultado sempre
 * bate com o valor armazenado (`resolveCohortArg('junho')` → `'leads-2026-06'`).
 * Assinatura preservada (string → string) — nenhum caller precisa mudar.
 */
export function resolveCohortArg(input: string): string {
  const trimmed = input.trim();
  if (/^\d{4}-\d{2}$/.test(trimmed)) return cohortFromSafra(trimmed);
  const idx = PT_MONTH_NAMES.indexOf(trimmed.toLowerCase());
  if (idx !== -1) {
    return cohortFromSafra(`${COHORT_EPOCH_YEAR}-${String(idx + 1).padStart(2, "0")}`);
  }
  const tierAlias = trimmed.match(TIER_ALIAS_RE);
  if (tierAlias) {
    const tierNum = Number(tierAlias[1]);
    const resolved = cohortFromTier(tierNum);
    if (resolved) {
      console.error(
        `⚠️  --cohort "${input}" é um alias de tier LEGADO (#2857 fase A/B) — ` +
          `resolvido pra "${resolved}". Prefira o slug nomeado diretamente; o ` +
          `alias "t${String(tierNum).padStart(2, "0")}" será removido na fase C ` +
          `(cutover, remoção de tier).`,
      );
      return resolved;
    }
    // Número fora do mapa (ex: t00, t11) — cai no erro genérico abaixo, mesma
    // mensagem que qualquer outro input não reconhecido.
  }
  if (isKnownCohortSlug(trimmed)) return trimmed;
  throw new Error(
    `--cohort "${input}" não reconhecido — use um rótulo pt-BR (ex: junho), ` +
      `a forma canônica YYYY-MM (ex: ${COHORT_EPOCH_YEAR}-06), um slug da ` +
      `taxonomia (ex: assinantes-ativos, leads-2025h2) ou o alias de tier ` +
      `legado (ex: t04).`,
  );
}
