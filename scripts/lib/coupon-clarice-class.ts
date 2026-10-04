/**
 * coupon-clarice-class.ts (#9571 adendo) — classifica quem resgatou um cupom
 * como "novo" ou "antigo" da Clarice. Módulo PURO e sem I/O (o worker importa
 * só tipo/chave daqui; o lookup no store SQLite fica no script).
 *
 * Critério (decisão do editor): "antigo" = e-mail já estava no store há MAIS
 * de 7 dias antes do resgate; todo o resto (ausente, ou entrou a ≤7d) = "novo".
 * O store não tem coluna de inserção — proxy `min(created, brevo_created_at)`.
 * Sem nenhuma das duas datas → "antigo" (estava no store, não sabemos desde
 * quando), contado em `undatedAntigo` pra auditoria.
 */
export const COUPON_CLARICE_CLASS_KV_KEY = "coupons:clarice-class";
export const CLARICE_CLASS_GRACE_SECS = 7 * 24 * 3600;

export type ClariceClass = "novo" | "antigo";

export interface CouponClariceClassPayload {
  generated_at: string;
  /** chave: `${email normalizado}|${created epoch do resgate}` */
  classes: Record<string, ClariceClass>;
}

export interface StoreDates {
  created: string | null;
  brevo_created_at: string | null;
}

export const clariceClassKey = (email: string, created: number): string =>
  `${email.trim().toLowerCase()}|${created}`;

/** Epoch (s) da 1ª data em que o contato existiu no store; null se sem datas válidas. */
export function storeFirstSeenEpoch(row: StoreDates): number | null {
  const epochs = [row.created, row.brevo_created_at]
    .map((d) => (d ? Date.parse(d) : NaN))
    .filter((ms) => Number.isFinite(ms))
    .map((ms) => Math.floor(ms / 1000));
  return epochs.length ? Math.min(...epochs) : null;
}

export function classifyRedeemer(
  row: StoreDates | null,
  redeemedEpoch: number,
): { cls: ClariceClass; undated: boolean } {
  if (!row) return { cls: "novo", undated: false };
  const first = storeFirstSeenEpoch(row);
  if (first === null) return { cls: "antigo", undated: true };
  return {
    cls: first < redeemedEpoch - CLARICE_CLASS_GRACE_SECS ? "antigo" : "novo",
    undated: false,
  };
}
