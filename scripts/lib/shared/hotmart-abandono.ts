/**
 * scripts/lib/shared/hotmart-abandono.ts (#10082)
 *
 * Do checkout da Hotmart só sabíamos quem chegou (`InitiateCheckout`) e quem
 * comprou: desde 28/09/2026, uns 120 cliques no botão de compra viraram 2
 * ingressos, sem como saber quantas pessoas preencheram os dados e
 * desistiram. A Hotmart avisa esse abandono pelo webhook
 * `PURCHASE_OUT_OF_SHOPPING_CART` (versão 2.0.0; doc oficial:
 * https://developers.hotmart.com/docs/en/2.0.0/webhook/cart-abandonment-webhook/),
 * que o Worker `site` recebe em `POST /webhooks/hotmart`.
 *
 * O payload traz nome, e-mail, telefone e IP de quem abandonou
 * (`data.buyer.*`, `data.buyer_ip`). NADA disso é gravado: o registro é
 * montado por ALLOWLIST (`buildAbandonoRecord` copia só os campos abaixo,
 * nunca o payload inteiro), então um campo pessoal novo que a Hotmart
 * acrescente também fica de fora sem mudança de código.
 *
 * Gravado: data e hora (`creation_date`), dia em Brasília, id do produto,
 * código da oferta, afiliado sim/não e origem (`src`/`sck`) se vier no
 * payload. A doc atual do abandono não lista origem; os caminhos lidos são
 * os da compra (`data.purchase.origin`) e variações, por defesa.
 *
 * Miolo PURO (validação, montagem do registro, chaves do KV, comparação do
 * hottok): testável sem `Request`/`Env`, mesmo padrão de `click-beacon.ts`.
 */

export const HOTMART_WEBHOOK_PATH = "/webhooks/hotmart";
export const HOTMART_ABANDONOS_PATH = "/hotmart/abandonos";
export const HOTMART_ABANDONO_EVENT = "PURCHASE_OUT_OF_SHOPPING_CART";

/** Prefixo próprio no namespace KV reusado (`CURSOS_SUBSCRIBERS`), mesmo
 * padrão do #8062 (`counter:ai-fetch:site:`). Chave completa:
 * `hotmart:abandono:{AAAA-MM-DD}:{id do evento}`. O dia na chave permite
 * ler um período listando um prefixo por dia, sem varrer o namespace. */
export const ABANDONO_KV_PREFIX = "hotmart:abandono:";

/** ~13 meses: dá para comparar o mesmo mês do ano anterior e o KV não cresce
 * para sempre. */
export const ABANDONO_TTL_SECONDS = 400 * 24 * 60 * 60;

/** Teto de cada campo de texto gravado. O registro também vai como metadata
 * da chave no KV (limite de 1024 bytes), então todos os campos somados
 * precisam caber com folga. */
export const ABANDONO_FIELD_MAX = 100;

/** Maior período aceito pela rota de leitura (uma listagem do KV por dia). */
export const ABANDONOS_MAX_DIAS = 93;

/** Brasília está em UTC-3 fixo desde o fim do horário de verão (2019). */
const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;

export interface AbandonoRecord {
  /** Id do evento na Hotmart (não identifica a pessoa). Reenvio do mesmo
   * evento grava na mesma chave, sem duplicar. */
  evento_id: string;
  /** `creation_date` do evento, em ISO 8601 (UTC). */
  criado_em: string;
  /** Dia do abandono em Brasília (AAAA-MM-DD). */
  dia: string;
  produto_id: number | null;
  oferta: string | null;
  src: string | null;
  sck: string | null;
  afiliado: boolean | null;
}

export type BuildAbandonoResult =
  | { ok: true; record: AbandonoRecord }
  | { ok: false; reason: "invalid_payload" | "not_abandono" };

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Texto curto e sem cara de dado pessoal. `src`/`sck` vêm de parâmetro de
 * URL que qualquer um monta; um valor com "@" pode ser um e-mail colado num
 * link, então é descartado em vez de gravado.
 */
function cleanText(v: unknown, max = ABANDONO_FIELD_MAX): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim().slice(0, max).trim();
  if (!s || s.includes("@")) return null;
  return s;
}

/** Dia (AAAA-MM-DD) em Brasília de um instante em ms. Pure. */
export function brtDay(ms: number): string {
  return new Date(ms - BRT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Só caracteres seguros para compor a chave do KV. */
function keySafe(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, ABANDONO_FIELD_MAX);
}

/**
 * Monta o registro sem dados pessoais a partir do corpo do webhook. Nunca
 * lança. `receivedAtMs` cobre `creation_date` ausente ou inválido.
 */
export function buildAbandonoRecord(payload: unknown, receivedAtMs: number): BuildAbandonoResult {
  const root = obj(payload);
  if (!root) return { ok: false, reason: "invalid_payload" };
  if (root.event !== HOTMART_ABANDONO_EVENT) return { ok: false, reason: "not_abandono" };
  const data = obj(root.data) ?? {};

  const created = typeof root.creation_date === "number" && Number.isFinite(root.creation_date) ? root.creation_date : receivedAtMs;
  const product = obj(data.product);
  const productId = product && typeof product.id === "number" && Number.isFinite(product.id) ? product.id : null;
  const offer = obj(data.offer);

  // Origem: a doc do abandono não lista; a da compra usa data.purchase.origin.
  const origin = obj(obj(data.purchase)?.origin) ?? obj(data.origin) ?? data;

  const rawId = cleanText(root.id);
  const eventoId = (rawId && keySafe(rawId)) || `sem-id-${created}`;

  return {
    ok: true,
    record: {
      evento_id: eventoId,
      criado_em: new Date(created).toISOString(),
      dia: brtDay(created),
      produto_id: productId,
      oferta: cleanText(offer?.code, 50),
      src: cleanText(origin.src),
      sck: cleanText(origin.sck),
      afiliado: typeof data.affiliate === "boolean" ? data.affiliate : null,
    },
  };
}

export function abandonoKvKey(record: AbandonoRecord): string {
  return `${ABANDONO_KV_PREFIX}${record.dia}:${record.evento_id}`;
}

export function abandonoDayPrefix(dia: string): string {
  return `${ABANDONO_KV_PREFIX}${dia}:`;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type PeriodoResult = { ok: true; dias: string[] } | { ok: false; error: string };

/**
 * Valida `de`/`ate` (AAAA-MM-DD, inclusivos) e devolve a lista de dias.
 * Sem `ate`, vale o próprio `de`; sem os dois, o dia de hoje em Brasília.
 * Pure (recebe `nowMs`).
 */
export function resolvePeriodo(de: string | null, ate: string | null, nowMs: number): PeriodoResult {
  const start = de ?? brtDay(nowMs);
  const end = ate ?? start;
  if (!DAY_RE.test(start) || !DAY_RE.test(end)) return { ok: false, error: "use de=AAAA-MM-DD e ate=AAAA-MM-DD" };
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return { ok: false, error: "data inválida" };
  // Date.parse aceita 2026-02-31 e rola para março: confere o dia de volta.
  if (new Date(startMs).toISOString().slice(0, 10) !== start || new Date(endMs).toISOString().slice(0, 10) !== end) {
    return { ok: false, error: "data inválida" };
  }
  if (endMs < startMs) return { ok: false, error: "ate antes de de" };
  const dias: string[] = [];
  for (let ms = startMs; ms <= endMs; ms += 24 * 60 * 60 * 1000) {
    dias.push(new Date(ms).toISOString().slice(0, 10));
    if (dias.length > ABANDONOS_MAX_DIAS) return { ok: false, error: `período maior que ${ABANDONOS_MAX_DIAS} dias` };
  }
  return { ok: true, dias };
}

/**
 * Comparação de segredo em tempo constante, compatível com Workers (o
 * runtime não tem `timingSafeEqual`). Mesmo método de
 * `workers/brevo-dashboard/src/index.ts` (#3081): SHA-256 dos dois lados e
 * XOR dos digests, sem sair no primeiro byte diferente.
 */
export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/**
 * Confere um segredo recebido contra o configurado. Fail-closed: segredo
 * não configurado (ausente ou vazio) nunca autoriza, nem com valor vazio
 * do outro lado.
 */
export async function secretMatches(received: string | null | undefined, configured: string | undefined): Promise<boolean> {
  if (!configured || !received) return false;
  return timingSafeEqualStr(received, configured);
}
