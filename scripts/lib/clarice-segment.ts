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

/** tier p/ ordenação: nulo vira +∞ (vai pro fim). */
function tierRank(t: number | null): number {
  return t == null ? Number.POSITIVE_INFINITY : t;
}

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
    if (!r.send_eligible) {
      excluded.push({ email: r.email, reason: r.ineligible_reason ?? "unknown" });
    } else if ((r.sends_count ?? 0) > 0) {
      reSend.push(r);
    } else {
      firstSend.push(r);
    }
  }

  reSend.sort(
    (a, b) =>
      b.priority_points - a.priority_points || a.email.localeCompare(b.email),
  );
  firstSend.sort(
    (a, b) => tierRank(a.tier) - tierRank(b.tier) || a.email.localeCompare(b.email),
  );

  return { reSend, firstSend, excluded };
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
