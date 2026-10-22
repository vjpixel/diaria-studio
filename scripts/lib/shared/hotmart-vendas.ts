/**
 * scripts/lib/shared/hotmart-vendas.ts (#10734)
 *
 * As vendas da Hotmart (eventos e cursos) não tinham fonte de receita no repo:
 * eram levantadas à mão pelos e-mails "Venda realizada". Este módulo trata os
 * webhooks de compra da Hotmart (versão 2.0.0; doc:
 * https://developers.hotmart.com/docs/en/2.0.0/webhook/purchase-webhook/),
 * recebidos pelo Worker `site` na MESMA URL do abandono (`POST
 * /webhooks/hotmart`, `hotmart-abandono.ts`) e autenticados pelo MESMO hottok
 * (o hottok é da conta Hotmart, não do webhook).
 *
 * Eventos gravados (`HOTMART_VENDA_EVENTS`): compra aprovada, cancelada,
 * reembolsada e chargeback. O chargeback não estava no pedido da issue, mas
 * desfaz a receita como o reembolso; deixá-lo de fora inflaria o líquido.
 * `PURCHASE_COMPLETE` (fim da garantia), boleto impresso, atrasada, expirada e
 * protesto continuam ignorados: não mudam a receita, ou ainda não são receita.
 *
 * Gravado, por ALLOWLIST (nunca o payload inteiro, mesmo desenho do abandono):
 * id do evento, transação, data e hora, dia em Brasília, produto, oferta,
 * valor LÍQUIDO e moeda, valor bruto e moeda, afiliado sim/não, `src`/`sck` e
 * o HASH do e-mail do comprador. Nome, telefone, documento, endereço e IP não
 * são gravados, nem o e-mail em claro.
 *
 * Premissas sobre o payload (conferir com a primeira entrega real no
 * histórico do webhook da Hotmart):
 * - Valor líquido = `value` da comissão com `source: "PRODUCER"` em
 *   `data.commissions[]` — o que a Hotmart repassa ao produtor depois da taxa
 *   (comissão `MARKETPLACE`) e de afiliado/coprodutor. Sem essa entrada, o
 *   líquido fica `null` (nunca é estimado a partir do bruto).
 * - Valor bruto = `data.purchase.price.value`; moedas em `currency_value`.
 * - Transação = `data.purchase.transaction` (ex.: "HP16015479281022"); oferta
 *   = `data.purchase.offer.code` (o abandono a lê em `data.offer.code`, que
 *   fica de reserva).
 * - Origem = `data.purchase.origin.src`/`.sck`, com o mesmo filtro de formato
 *   do abandono (`cleanToken`).
 * - Afiliado = `data.affiliates[]` não vazio.
 *
 * Hash do e-mail: SHA-256 em hex do e-mail normalizado (trim + minúsculas),
 * a mesma função (`sha256Hex` de `subscriber-verify.ts`) que já chaveia os
 * assinantes no KV. O cruzamento com o store unificado (#10734, follow-up)
 * pode hashear os e-mails do store com a mesma função. Hash de e-mail sem sal
 * é pseudonimização, não anonimização: quem tem uma lista de e-mails consegue
 * testá-la contra os hashes. Por isso a leitura exige token próprio.
 *
 * Idempotência: a chave é `hotmart:venda:{dia}:{transação}:{evento}`. A
 * Hotmart reenvia o mesmo payload (mesmo `creation_date`) até receber 2xx,
 * então o reenvio cai na mesma chave. Se `creation_date` faltar, o dia vem da
 * hora do recebimento e um reenvio noutro dia geraria outra chave; a leitura
 * (`lerVendas`) deduplica por transação + evento, ficando com o mais antigo.
 *
 * Miolo PURO, exceto o hash (Web Crypto, assíncrono): testável sem
 * `Request`/`Env`.
 */

import { brtDay, cleanToken } from "./hotmart-abandono.ts";
import { sha256Hex } from "./subscriber-verify.ts";

export const HOTMART_VENDAS_PATH = "/hotmart/vendas";

/** Evento da Hotmart → nome gravado. */
export const HOTMART_VENDA_EVENTS = {
  PURCHASE_APPROVED: "aprovada",
  PURCHASE_CANCELED: "cancelada",
  PURCHASE_REFUNDED: "reembolsada",
  PURCHASE_CHARGEBACK: "chargeback",
} as const;

export type HotmartVendaEvent = keyof typeof HOTMART_VENDA_EVENTS;
export type VendaEvento = (typeof HOTMART_VENDA_EVENTS)[HotmartVendaEvent];

export function isVendaEvent(event: unknown): event is HotmartVendaEvent {
  return typeof event === "string" && Object.prototype.hasOwnProperty.call(HOTMART_VENDA_EVENTS, event);
}

/** Prefixo próprio no namespace KV reusado (`CURSOS_SUBSCRIBERS`), ao lado de
 * `hotmart:abandono:`. Chave completa:
 * `hotmart:venda:{AAAA-MM-DD}:{transação}:{evento}`. */
export const VENDA_KV_PREFIX = "hotmart:venda:";

/** ~13 meses, como o abandono: tempo de sobra para um sync trazer os
 * registros para o store do repo antes de expirarem. */
export const VENDA_TTL_SECONDS = 400 * 24 * 60 * 60;

/** Maior registro aceito como metadata da chave no KV (o limite é 1024). */
export const VENDA_METADATA_MAX_BYTES = 1000;

export const VENDA_RECORD_VERSION = 1;

const CREATION_MIN_MS = Date.UTC(2020, 0, 1);
const CREATION_MAX_AHEAD_MS = 24 * 60 * 60 * 1000;
/** Ids da Hotmart (UUID do evento, código da transação). Têm muitos dígitos
 * seguidos, então não passam pelo filtro de telefone de `cleanToken`: só pelo
 * de formato. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Teto de valor aceito (R$ 10 milhões): acima disso é lixo, não venda. */
const VALOR_MAX = 10_000_000;

export interface VendaRecord {
  readonly v: typeof VENDA_RECORD_VERSION;
  readonly evento: VendaEvento;
  /** Id do evento na Hotmart (muda a cada evento, inclusive da mesma
   * transação) ou, sem ele, `sem-id-{hash do corpo}`. */
  readonly evento_id: string;
  /** Código da transação (comum a aprovação, reembolso etc. da mesma compra)
   * ou, sem ele, `sem-transacao-{hash do corpo}`. */
  readonly transacao: string;
  readonly criado_em: string;
  readonly criado_em_origem: "hotmart" | "recebimento";
  /** Dia do evento em Brasília (AAAA-MM-DD). */
  readonly dia: string;
  readonly produto_id: number | null;
  readonly oferta: string | null;
  /** Comissão do produtor (líquido). `null` se o payload não trouxer. */
  readonly valor_liquido: number | null;
  readonly moeda_liquido: string | null;
  readonly valor_bruto: number | null;
  readonly moeda_bruto: string | null;
  /** SHA-256 hex do e-mail normalizado; `null` sem e-mail válido. */
  readonly email_hash: string | null;
  readonly src: string | null;
  readonly sck: string | null;
  readonly afiliado: boolean | null;
}

export type BuildVendaResult =
  | { ok: true; record: VendaRecord }
  | { ok: false; reason: "invalid_payload" | "not_venda" };

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function cleanId(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" && Number.isSafeInteger(v) ? String(v) : "";
  return ID_RE.test(s) ? s : null;
}

function cleanCurrency(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return CURRENCY_RE.test(s) ? s : null;
}

/** Valor monetário: número (ou texto numérico) finito, ≥ 0, até `VALOR_MAX`,
 * arredondado a centavos. O resto vira `null`. */
export function cleanValor(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > VALOR_MAX) return null;
  return Math.round(n * 100) / 100;
}

function resolveCreated(raw: unknown, receivedAtMs: number): { ms: number; origem: "hotmart" | "recebimento" } {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  if (Number.isFinite(n) && n >= CREATION_MIN_MS && n <= receivedAtMs + CREATION_MAX_AHEAD_MS) return { ms: n, origem: "hotmart" };
  return { ms: receivedAtMs, origem: "recebimento" };
}

function resolveProductId(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return raw;
  if (typeof raw === "string" && /^\d{1,15}$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

/** E-mail normalizado (trim + minúsculas) se tiver forma de e-mail; `null`
 * caso contrário. Nunca é gravado: só alimenta o hash. */
export function normalizeBuyerEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

/** Comissão do produtor (`source: "PRODUCER"`) em `data.commissions[]`. Mais
 * de uma entrada PRODUCER (não documentado) soma, se a moeda bater. */
function producerCommission(data: Record<string, unknown>): { valor: number | null; moeda: string | null } {
  const list = Array.isArray(data.commissions) ? data.commissions : [];
  let valor: number | null = null;
  let moeda: string | null = null;
  for (const c of list) {
    const o = obj(c);
    if (!o || o.source !== "PRODUCER") continue;
    const v = cleanValor(o.value);
    const m = cleanCurrency(o.currency_value);
    if (v === null) return { valor: null, moeda: null };
    if (valor === null) {
      valor = v;
      moeda = m;
    } else if (m === moeda) {
      valor = Math.round((valor + v) * 100) / 100;
    } else {
      return { valor: null, moeda: null };
    }
  }
  return { valor, moeda };
}

/**
 * Monta o registro de venda a partir do corpo do webhook. Não lança.
 * `bodyHash` (hex do SHA-256 do corpo bruto) completa id/transação ausentes,
 * como no abandono.
 */
export async function buildVendaRecord(payload: unknown, receivedAtMs: number, bodyHash: string): Promise<BuildVendaResult> {
  const root = obj(payload);
  if (!root) return { ok: false, reason: "invalid_payload" };
  if (!isVendaEvent(root.event)) return { ok: false, reason: "not_venda" };
  const data = obj(root.data) ?? {};
  const purchase = obj(data.purchase) ?? {};
  const origin = obj(purchase.origin) ?? obj(data.origin) ?? {};
  const price = obj(purchase.price) ?? {};
  const created = resolveCreated(root.creation_date, receivedAtMs);
  const hashSuffix = bodyHash.replace(/[^0-9a-f]/gi, "").slice(0, 32);
  const liquido = producerCommission(data);
  const email = normalizeBuyerEmail(obj(data.buyer)?.email);

  return {
    ok: true,
    record: {
      v: VENDA_RECORD_VERSION,
      evento: HOTMART_VENDA_EVENTS[root.event],
      evento_id: cleanId(root.id) ?? `sem-id-${hashSuffix}`,
      transacao: cleanId(purchase.transaction) ?? `sem-transacao-${hashSuffix}`,
      criado_em: new Date(created.ms).toISOString(),
      criado_em_origem: created.origem,
      dia: brtDay(created.ms),
      produto_id: resolveProductId(obj(data.product)?.id),
      oferta: cleanToken(obj(purchase.offer)?.code ?? obj(data.offer)?.code, 50),
      valor_liquido: liquido.valor,
      moeda_liquido: liquido.moeda,
      valor_bruto: cleanValor(price.value),
      moeda_bruto: cleanCurrency(price.currency_value),
      email_hash: email ? await sha256Hex(email) : null,
      src: cleanToken(origin.src),
      sck: cleanToken(origin.sck),
      afiliado: Array.isArray(data.affiliates) ? data.affiliates.length > 0 : null,
    },
  };
}

export function vendaKvKey(record: VendaRecord): string {
  return `${VENDA_KV_PREFIX}${record.dia}:${record.transacao}:${record.evento}`;
}

export function vendaDayPrefix(dia: string): string {
  return `${VENDA_KV_PREFIX}${dia}:`;
}

export function vendaFitsKvMetadata(record: VendaRecord): boolean {
  return new TextEncoder().encode(JSON.stringify(record)).length <= VENDA_METADATA_MAX_BYTES;
}

const EVENTOS = new Set<string>(Object.values(HOTMART_VENDA_EVENTS));

/** Confere a forma de um registro lido do KV e devolve um objeto NOVO só com
 * os campos da allowlist (campo a mais gravado à mão nunca sai). `null` se
 * não servir. */
export function parseVendaRecord(x: unknown): VendaRecord | null {
  const o = obj(x);
  if (!o) return null;
  if (typeof o.evento !== "string" || !EVENTOS.has(o.evento)) return null;
  if (typeof o.evento_id !== "string" || typeof o.transacao !== "string") return null;
  if (typeof o.criado_em !== "string" || !Number.isFinite(Date.parse(o.criado_em))) return null;
  if (typeof o.dia !== "string" || !DAY_RE.test(o.dia)) return null;
  const strOrNull = (v: unknown) => (typeof v === "string" ? v : null);
  const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    v: VENDA_RECORD_VERSION,
    evento: o.evento as VendaEvento,
    evento_id: o.evento_id,
    transacao: o.transacao,
    criado_em: o.criado_em,
    criado_em_origem: o.criado_em_origem === "recebimento" ? "recebimento" : "hotmart",
    dia: o.dia,
    produto_id: numOrNull(o.produto_id),
    oferta: strOrNull(o.oferta),
    valor_liquido: numOrNull(o.valor_liquido),
    moeda_liquido: strOrNull(o.moeda_liquido),
    valor_bruto: numOrNull(o.valor_bruto),
    moeda_bruto: strOrNull(o.moeda_bruto),
    email_hash: typeof o.email_hash === "string" && HASH_RE.test(o.email_hash) ? o.email_hash : null,
    src: strOrNull(o.src),
    sck: strOrNull(o.sck),
    afiliado: typeof o.afiliado === "boolean" ? o.afiliado : null,
  };
}

/** O pedaço do KV que a leitura usa (o `KVNamespace` real satisfaz). */
export interface VendaKvReader {
  list(options: { prefix: string; cursor?: string }): Promise<{
    keys: Array<{ name: string; metadata?: unknown }>;
    list_complete: boolean;
    cursor?: string;
  }>;
  get(key: string): Promise<string | null>;
}

export interface VendasLidas {
  registros: VendaRecord[];
  ignorados: string[];
  /** Registros descartados por repetirem transação + evento já lidos. */
  duplicados: number;
}

/**
 * Lê as vendas dos dias pedidos (metadata da chave; sem ela, o valor).
 * Registro inválido vai para `ignorados`; transação + evento repetidos ficam
 * só no mais antigo. Erro do KV sobe para o handler.
 */
export async function lerVendas(kv: VendaKvReader, dias: string[]): Promise<VendasLidas> {
  const todos: VendaRecord[] = [];
  const ignorados: string[] = [];
  for (const dia of dias) {
    let cursor: string | undefined;
    do {
      const page = await kv.list({ prefix: vendaDayPrefix(dia), cursor });
      for (const k of page.keys) {
        let candidate: unknown = k.metadata;
        if (!candidate) {
          const raw = await kv.get(k.name);
          if (raw === null) continue;
          try {
            candidate = JSON.parse(raw);
          } catch {
            candidate = null;
          }
        }
        const rec = parseVendaRecord(candidate);
        if (rec) todos.push(rec);
        else ignorados.push(k.name);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
  todos.sort((a, b) => a.criado_em.localeCompare(b.criado_em));
  const vistos = new Set<string>();
  const registros: VendaRecord[] = [];
  for (const r of todos) {
    const k = `${r.transacao}\u0000${r.evento}`;
    if (vistos.has(k)) continue;
    vistos.add(k);
    registros.push(r);
  }
  return { registros, ignorados, duplicados: todos.length - registros.length };
}

/** Sinal de cada evento no saldo de receita: aprovada soma; reembolso e
 * chargeback subtraem; cancelada não mexe (premissa: `PURCHASE_CANCELED` é
 * compra que não chegou a ser paga, como boleto vencido ou cartão recusado;
 * a devolução de compra paga chega como `PURCHASE_REFUNDED`). */
export function sinalReceita(evento: VendaEvento): 1 | -1 | 0 {
  if (evento === "aprovada") return 1;
  if (evento === "reembolsada" || evento === "chargeback") return -1;
  return 0;
}

export interface SaldoMoeda {
  readonly moeda: string;
  readonly liquido: number;
  readonly aprovadas: number;
  readonly estornos: number;
}

export interface SaldoVendas {
  readonly porMoeda: SaldoMoeda[];
  /** Eventos que mexem na receita mas vieram sem valor líquido ou moeda: o
   * saldo é PISO enquanto este número for > 0. */
  readonly semValorLiquido: number;
}

/**
 * Escolhe, por transação, a ÚNICA reversão (reembolso ou chargeback) que entra
 * no saldo (#10750). A mesma compra pode chegar como reembolsada E como
 * chargeback (reembolso pedido e depois disputado, ou o contrário): são
 * eventos distintos, a dedup de `lerVendas` (transação + evento) guarda os
 * dois, e somar os dois desfaria a receita duas vezes. Fica a reversão com
 * valor líquido (a sem valor só deixaria o saldo como piso), e entre elas a
 * mais antiga por `criado_em`; empate cai no `evento_id`, para o resultado não
 * depender da ordem de chegada. Devolve o conjunto de registros escolhidos.
 */
function reversoesContadas(registros: readonly VendaRecord[], base: BaseReceita = "liquido"): Set<VendaRecord> {
  const escolhida = new Map<string, VendaRecord>();
  const melhor = (a: VendaRecord, b: VendaRecord): VendaRecord => {
    const aVal = valorDaBase(a, base).valor !== null && valorDaBase(a, base).moeda !== null;
    const bVal = valorDaBase(b, base).valor !== null && valorDaBase(b, base).moeda !== null;
    if (aVal !== bVal) return aVal ? a : b;
    const t = a.criado_em.localeCompare(b.criado_em);
    if (t !== 0) return t < 0 ? a : b;
    return a.evento_id <= b.evento_id ? a : b;
  };
  for (const r of registros) {
    if (sinalReceita(r.evento) >= 0) continue;
    const atual = escolhida.get(r.transacao);
    escolhida.set(r.transacao, atual ? melhor(atual, r) : r);
  }
  return new Set(escolhida.values());
}

/** Qual valor do registro o saldo soma: o LÍQUIDO (comissão do produtor) ou
 * o BRUTO (preço pago pelo comprador). O ARPU/LTV usa o bruto (#10734 4b),
 * pela definição do #8423: receita BRUTA. */
export type BaseReceita = "liquido" | "bruto";

function valorDaBase(r: VendaRecord, base: BaseReceita): { valor: number | null; moeda: string | null } {
  return base === "bruto" ? { valor: r.valor_bruto, moeda: r.moeda_bruto } : { valor: r.valor_liquido, moeda: r.moeda_liquido };
}

/** Saldo líquido do período, por moeda (regime de caixa: o reembolso conta no
 * dia em que chegou, não no da compra). No máximo UMA reversão por transação
 * (`reversoesContadas`, #10750) — dentro dos registros recebidos: um reembolso
 * e um chargeback da mesma compra lidos em períodos diferentes contam um em
 * cada leitura. */
export function saldoLiquido(registros: readonly VendaRecord[]): SaldoVendas {
  return saldoReceita(registros, "liquido");
}

/** Mesmo saldo de `saldoLiquido`, sobre o valor de `base`. Com `"bruto"`,
 * `porMoeda[].liquido` é o saldo BRUTO e `semValorLiquido` conta os eventos
 * sem valor bruto (o nome dos campos fica pelo contrato de `saldoLiquido`). */
export function saldoReceita(registros: readonly VendaRecord[], base: BaseReceita): SaldoVendas {
  const acc = new Map<string, { liquido: number; aprovadas: number; estornos: number }>();
  let semValorLiquido = 0;
  const reversoes = reversoesContadas(registros, base);
  for (const r of registros) {
    const s = sinalReceita(r.evento);
    if (s === 0) continue;
    if (s < 0 && !reversoes.has(r)) continue;
    const { valor, moeda } = valorDaBase(r, base);
    if (valor === null || moeda === null) {
      semValorLiquido++;
      continue;
    }
    const cur = acc.get(moeda) ?? { liquido: 0, aprovadas: 0, estornos: 0 };
    cur.liquido = Math.round((cur.liquido + s * valor) * 100) / 100;
    if (s > 0) cur.aprovadas++;
    else cur.estornos++;
    acc.set(moeda, cur);
  }
  const porMoeda = [...acc.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([moeda, v]) => ({ moeda, ...v }));
  return { porMoeda, semValorLiquido };
}
