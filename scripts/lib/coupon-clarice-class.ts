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
import { redemptionEpoch, type CouponUsageReport } from "./stripe-coupons.ts";

export const COUPON_CLARICE_CLASS_KV_KEY = "coupons:clarice-class";
export const CLARICE_CLASS_GRACE_SECS = 7 * 24 * 3600;

export type ClariceClass = "novo" | "antigo";

export interface CouponClariceClassPayload {
  generated_at: string;
  /** chave: `${email normalizado}|${redemptionEpoch(row)}` — data do resgate, não da assinatura (#9617) */
  classes: Record<string, ClariceClass>;
}

export interface StoreDates {
  created: string | null;
  brevo_created_at: string | null;
}

/** #9617: valida o JSON cru do KV; formato inesperado → null (coluna "—", nunca throw). */
export function normalizeClariceClassPayload(raw: unknown): CouponClariceClassPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.generated_at !== "string" || !Number.isFinite(Date.parse(o.generated_at))) return null;
  if (!o.classes || typeof o.classes !== "object" || Array.isArray(o.classes)) return null;
  const classes: Record<string, ClariceClass> = {};
  for (const [k, v] of Object.entries(o.classes as Record<string, unknown>)) {
    if (v === "novo" || v === "antigo") classes[k] = v;
  }
  return { generated_at: o.generated_at, classes };
}

export const clariceClassKey =(email: string, created: number): string =>
  `${email.trim().toLowerCase()}|${created}`;

/** Epoch (s) da 1ª data em que o contato existiu no store; null se sem datas válidas. */
export function storeFirstSeenEpoch(row: StoreDates): number | null {
  const epochs = [row.created, row.brevo_created_at]
    .map((d) => (d ? Date.parse(d) : NaN))
    .filter((ms) => Number.isFinite(ms))
    .map((ms) => Math.floor(ms / 1000));
  return epochs.length ? Math.min(...epochs) : null;
}

/**
 * #9617: classifica todos os resgates de um `coupons:usage`. `lookup` resolve
 * o e-mail no store (null = ausente). A data usada é a do RESGATE
 * (`redemptionEpoch`), a mesma que o worker usa pra montar a chave.
 */
export function buildClariceClasses(
  usage: CouponUsageReport,
  lookup: (email: string) => StoreDates | null,
): { classes: Record<string, ClariceClass>; undated: number } {
  const classes: Record<string, ClariceClass> = {};
  let undated = 0;
  for (const rep of Object.values(usage)) {
    for (const r of rep.redemptions) {
      const redeemed = redemptionEpoch(r);
      const { cls, undated: u } = classifyRedeemer(lookup(r.customer_email), redeemed);
      if (u) undated++;
      classes[clariceClassKey(r.customer_email, redeemed)] = cls;
    }
  }
  return { classes, undated };
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
