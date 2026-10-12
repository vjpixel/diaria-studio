/**
 * scripts/lib/shared/hotmart-abandono.ts (#10082)
 *
 * Do checkout da Hotmart só sabíamos quem chegou (`InitiateCheckout`) e quem
 * comprou, sem medir quem preencheu os dados e desistiu. A Hotmart avisa esse
 * abandono pelo webhook `PURCHASE_OUT_OF_SHOPPING_CART` (versão 2.0.0; doc:
 * https://developers.hotmart.com/docs/en/2.0.0/webhook/cart-abandonment-webhook/),
 * que o Worker `site` recebe em `POST /webhooks/hotmart`.
 *
 * O payload traz nome, e-mail, telefone e IP de quem abandonou
 * (`data.buyer.*`, `data.buyer_ip`). Nada disso é gravado: o registro é
 * montado por ALLOWLIST (`buildAbandonoRecord` copia só os campos abaixo,
 * nunca o payload inteiro), então um campo pessoal novo que a Hotmart
 * acrescente também fica de fora sem mudança de código.
 *
 * Gravado: id do evento na Hotmart, data e hora (`creation_date`), dia em
 * Brasília, id do produto, código da oferta, afiliado sim/não e origem
 * (`src`/`sck`). A doc do abandono NÃO lista origem; os caminhos lidos, em
 * ordem, são `data.purchase.origin` (formato da compra), `data.origin` e
 * `data.src`/`data.sck`. Se nenhum vier, origem fica `null`.
 *
 * `src`/`sck` são texto que qualquer pessoa põe numa URL, então passam por um
 * filtro de formato (`cleanToken`): só letras, dígitos e `_ . : -`, até 100
 * caracteres, e nada que pareça e-mail ou número de telefone/documento. Valor
 * fora disso vira `null`. É uma heurística, não detecção de dado pessoal:
 * um nome sem espaço, por exemplo, passaria.
 *
 * Miolo PURO (validação, montagem do registro, chaves do KV, leitura de um
 * período sobre um KV mínimo): testável sem `Request`/`Env`.
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

/** Teto, em caracteres, de cada campo de texto. Como `cleanToken` só aceita
 * ASCII sem caractere de controle, caractere = byte no JSON, e o registro
 * inteiro fica em ~500 bytes, abaixo do limite de 1024 bytes da metadata do
 * KV (o handler ainda confere o tamanho antes do `put`). */
export const ABANDONO_FIELD_MAX = 100;

/** Maior registro aceito como metadata da chave no KV (o limite é 1024). */
export const ABANDONO_METADATA_MAX_BYTES = 1000;

/** Maior período aceito pela rota de leitura. Cada dia custa pelo menos uma
 * operação `list` no KV (o plano gratuito tem 1.000 por dia na conta); o
 * relatório diário pede um dia por vez. */
export const ABANDONOS_MAX_DIAS = 93;

/** Brasília está em UTC-3 fixo desde o fim do horário de verão (2019). */
const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;

/** `creation_date` aceito: de 2020 até um dia à frente do recebimento. Fora
 * disso (valor em segundos, lixo, fora da faixa de `Date`) usa a hora do
 * recebimento, para o registro nunca cair num dia que ninguém consulta. */
const CREATION_MIN_MS = Date.UTC(2020, 0, 1);
const CREATION_MAX_AHEAD_MS = 24 * 60 * 60 * 1000;

/** Versão do formato gravado: registros vivem 400 dias, e um campo novo ou
 * renomeado precisa ser distinguível na leitura. */
export const ABANDONO_RECORD_VERSION = 1;

export interface AbandonoRecord {
  readonly v: typeof ABANDONO_RECORD_VERSION;
  /** Id do evento na Hotmart (UUID do evento, não do comprador) ou, se não
   * vier, um hash do corpo recebido. Reenvio do mesmo evento grava na mesma
   * chave, sem duplicar. */
  readonly evento_id: string;
  /** Data e hora do evento em ISO 8601 (UTC). */
  readonly criado_em: string;
  /** "hotmart" quando `creation_date` veio válido; "recebimento" quando a
   * data é a da chegada ao Worker. */
  readonly criado_em_origem: "hotmart" | "recebimento";
  /** Dia do abandono em Brasília (AAAA-MM-DD). */
  readonly dia: string;
  readonly produto_id: number | null;
  readonly oferta: string | null;
  readonly src: string | null;
  readonly sck: string | null;
  readonly afiliado: boolean | null;
}

export type BuildAbandonoResult =
  | { ok: true; record: AbandonoRecord }
  | { ok: false; reason: "invalid_payload" | "not_abandono" };

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
/** 8 ou mais dígitos seguidos (telefone, CPF) mesmo com separadores. */
const LONG_DIGITS_RE = /\d(?:[\s.:-]?\d){7,}/;

/**
 * Texto curto em formato de código (`meta`, `lp-d-AD99`, `o8hknz2x`). O que
 * parece e-mail (`@`, inclusive `%40`) ou telefone/documento é descartado
 * ANTES do corte, para nunca gravar um pedaço do dado.
 */
export function cleanToken(v: unknown, max = ABANDONO_FIELD_MAX): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  if (!s || /@|%40/i.test(s) || LONG_DIGITS_RE.test(s) || !TOKEN_RE.test(s)) return null;
  return s.slice(0, max);
}

/** Dia (AAAA-MM-DD) em Brasília de um instante em ms. Pure. */
export function brtDay(ms: number): string {
  return new Date(ms - BRT_OFFSET_MS).toISOString().slice(0, 10);
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

/**
 * Monta o registro sem dados pessoais a partir do corpo do webhook. Não lança.
 * `bodyHash` (hex do SHA-256 do corpo bruto, calculado pelo handler) vira o
 * id quando o payload não traz `id` utilizável: reenvio idêntico cai na mesma
 * chave, e eventos diferentes não colidem.
 */
export function buildAbandonoRecord(payload: unknown, receivedAtMs: number, bodyHash: string): BuildAbandonoResult {
  const root = obj(payload);
  if (!root) return { ok: false, reason: "invalid_payload" };
  if (root.event !== HOTMART_ABANDONO_EVENT) return { ok: false, reason: "not_abandono" };
  const data = obj(root.data) ?? {};

  const created = resolveCreated(root.creation_date, receivedAtMs);
  const origin = obj(obj(data.purchase)?.origin) ?? obj(data.origin) ?? data;
  // O id é um UUID da Hotmart: tem sequências de dígitos, então não passa
  // pelo filtro de telefone do `cleanToken`, só pelo de formato.
  const rawId = typeof root.id === "string" ? root.id.trim() : "";
  const eventoId = ID_RE.test(rawId) ? rawId : `sem-id-${bodyHash.replace(/[^0-9a-f]/gi, "").slice(0, 32)}`;

  return {
    ok: true,
    record: {
      v: ABANDONO_RECORD_VERSION,
      evento_id: eventoId,
      criado_em: new Date(created.ms).toISOString(),
      criado_em_origem: created.origem,
      dia: brtDay(created.ms),
      produto_id: resolveProductId(obj(data.product)?.id),
      oferta: cleanToken(obj(data.offer)?.code, 50),
      src: cleanToken(origin.src),
      sck: cleanToken(origin.sck),
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

/** Registro serializado cabe como metadata da chave? */
export function fitsKvMetadata(record: AbandonoRecord): boolean {
  return new TextEncoder().encode(JSON.stringify(record)).length <= ABANDONO_METADATA_MAX_BYTES;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Confere a forma mínima de um registro lido do KV (que pode ter sido gravado
 * à mão ou por versão antiga). Devolve `null` se não servir. */
export function parseAbandonoRecord(x: unknown): AbandonoRecord | null {
  const o = obj(x);
  if (!o) return null;
  if (typeof o.evento_id !== "string" || typeof o.criado_em !== "string" || !Number.isFinite(Date.parse(o.criado_em))) return null;
  if (typeof o.dia !== "string" || !DAY_RE.test(o.dia)) return null;
  return o as unknown as AbandonoRecord;
}

export type PeriodoResult =
  | { ok: true; de: string; ate: string; dias: string[] }
  | { ok: false; reason: "bad_format" | "invalid_date" | "range_inverted" | "range_too_long" };

/**
 * Valida `de`/`ate` (AAAA-MM-DD, inclusivos) e devolve a lista de dias. Só
 * um dos dois informado vale como período de um dia; nenhum, o dia de hoje
 * em Brasília. Pure (recebe `nowMs`).
 */
export function resolvePeriodo(de: string | null, ate: string | null, nowMs: number): PeriodoResult {
  const start = de ?? ate ?? brtDay(nowMs);
  const end = ate ?? start;
  if (!DAY_RE.test(start) || !DAY_RE.test(end)) return { ok: false, reason: "bad_format" };
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  // Date.parse aceita 2026-02-31 e rola para março: confere o dia de volta.
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    new Date(startMs).toISOString().slice(0, 10) !== start ||
    new Date(endMs).toISOString().slice(0, 10) !== end
  ) {
    return { ok: false, reason: "invalid_date" };
  }
  if (endMs < startMs) return { ok: false, reason: "range_inverted" };
  const dias: string[] = [];
  for (let ms = startMs; ms <= endMs; ms += 24 * 60 * 60 * 1000) {
    dias.push(new Date(ms).toISOString().slice(0, 10));
    if (dias.length > ABANDONOS_MAX_DIAS) return { ok: false, reason: "range_too_long" };
  }
  return { ok: true, de: start, ate: end, dias };
}

/** O pedaço do KV que a leitura usa. O `KVNamespace` real satisfaz este tipo
 * por estrutura, sem cast. */
export interface AbandonoKvReader {
  list(options: { prefix: string; cursor?: string }): Promise<{
    keys: Array<{ name: string; metadata?: unknown }>;
    list_complete: boolean;
    cursor?: string;
  }>;
  get(key: string): Promise<string | null>;
}

export interface AbandonosLidos {
  registros: AbandonoRecord[];
  /** Chaves listadas cujo conteúdo não tem a forma de um registro. */
  ignorados: string[];
}

/**
 * Lê os registros dos dias pedidos. Cada chave usa a metadata (gravada junto
 * pelo webhook); sem ela, lê o valor. Registro com forma inválida é pulado e
 * listado em `ignorados`, para um item ruim não derrubar o período todo.
 * Erro do próprio KV (list/get) sobe para o handler.
 */
export async function lerAbandonos(kv: AbandonoKvReader, dias: string[]): Promise<AbandonosLidos> {
  const registros: AbandonoRecord[] = [];
  const ignorados: string[] = [];
  for (const dia of dias) {
    let cursor: string | undefined;
    do {
      const page = await kv.list({ prefix: abandonoDayPrefix(dia), cursor });
      for (const k of page.keys) {
        let candidate: unknown = k.metadata;
        if (!candidate) {
          const raw = await kv.get(k.name);
          if (raw === null) continue; // expirou entre o list e o get
          try {
            candidate = JSON.parse(raw);
          } catch {
            candidate = null;
          }
        }
        const rec = parseAbandonoRecord(candidate);
        if (rec) registros.push(rec);
        else ignorados.push(k.name);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
  registros.sort((a, b) => a.criado_em.localeCompare(b.criado_em));
  return { registros, ignorados };
}
