/**
 * scripts/lib/hotmart-vendas-espelho.ts (#10734, item 4c)
 *
 * Espelho local, append-only, das vendas da Hotmart gravadas no KV
 * `CURSOS_SUBSCRIBERS` pelo Worker `diaria-site` (`workers/site`,
 * `hotmart-vendas.ts`). O KV guarda cada evento por 400 dias
 * (`VENDA_TTL_SECONDS`); passado isso, a chave some. O espelho em
 * `data/hotmart/vendas.jsonl` é o que sobra depois disso: uma linha por evento
 * de venda, no MESMO formato do registro do KV (allowlist de
 * `parseVendaRecord`, e-mail só como hash).
 *
 * Idempotência: a chave do espelho é transação + evento, a mesma da dedup de
 * `lerVendas` no Worker. Uma transação tem mais de um evento legítimo
 * (aprovada e depois reembolsada), então a chave não pode ser só a transação.
 * Rodar o sync de novo sobre a mesma janela não acrescenta linha nenhuma; um
 * evento já espelhado nunca é reescrito, mesmo que o KV devolva uma versão
 * diferente dele (append-only: a primeira versão vista fica).
 *
 * A leitura vai pela rota autenticada `GET /hotmart/vendas`, que aceita no
 * máximo `ABANDONOS_MAX_DIAS` (93) dias por chamada (`resolvePeriodo`); um
 * período maior é quebrado em janelas por `planejarJanelas`.
 *
 * Miolo PURO: sem fs, sem rede. O CLI é `scripts/sync-hotmart-vendas.ts` (lá
 * ficam o lock do arquivo e a checagem da junction `data/`).
 */

import { ABANDONOS_MAX_DIAS, brtDay } from "./shared/hotmart-abandono.ts";
import { parseVendaRecord, type VendaRecord } from "./shared/hotmart-vendas.ts";

/** Caminho do espelho, relativo a `data/`. */
export const ESPELHO_REL_PATH = "hotmart/vendas.jsonl";

/** Arquivo que só existe com a junction `data/` do OneDrive montada (o store
 * unificado de assinantes), relativo a `data/`. A existência de `data/` não
 * serve de sinal: o runner das tasks (`task-runner.ts`, `defaultAppendLog`)
 * cria `data/` ao gravar o log mesmo com a junction desmontada. Usado pelo
 * guard da task `Diaria-Hotmart-Vendas-Sync` e pelo próprio CLI. */
export const SENTINELA_DATA_REL_PATH = "diaria-subscribers/diaria-subscribers.db";

/** Teto de dias por chamada da rota (o mesmo de `resolvePeriodo`). */
export const JANELA_MAX_DIAS = ABANDONOS_MAX_DIAS;

/** Janela padrão do sync: 35 dias para trás. Com a task semanal, cada evento
 * é lido em ~5 rodadas antes de sair da janela; uma semana de task parada não
 * perde nada. */
export const SYNC_DIAS_PADRAO = 35;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Período fechado de dias (AAAA-MM-DD, inclusive nas duas pontas). */
export interface Periodo {
  readonly de: string;
  readonly ate: string;
}

/** Chave de idempotência do espelho: transação + evento. */
export function chaveEspelho(r: Pick<VendaRecord, "transacao" | "evento">): string {
  return `${r.transacao}\u0000${r.evento}`;
}

export interface EspelhoLido {
  /** Um registro por chave (transação + evento): o da primeira linha. */
  readonly registros: readonly VendaRecord[];
  /** Linhas não vazias que não são um registro de venda válido. Ficam no
   * arquivo como estão (o sync nunca reescreve linhas antigas). */
  readonly invalidas: number;
  /** Linhas válidas cuja chave já apareceu numa linha anterior. Só acontece
   * se duas gravações correram ao mesmo tempo (o CLI usa lock para evitar)
   * ou se alguém editou o arquivo à mão. Ficam no arquivo; a leitura conta
   * só a primeira. */
  readonly duplicadas: number;
}

/** Lê o conteúdo do espelho (JSONL, LF ou CRLF), deduplicando por
 * `chaveEspelho`. Nunca lança. */
export function lerEspelho(texto: string): EspelhoLido {
  const registros: VendaRecord[] = [];
  const vistas = new Set<string>();
  let invalidas = 0;
  let duplicadas = 0;
  for (const linha of texto.split(/\r?\n/)) {
    if (!linha.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(linha);
    } catch {
      invalidas++;
      continue;
    }
    const rec = parseVendaRecord(parsed);
    if (!rec) {
      invalidas++;
      continue;
    }
    const k = chaveEspelho(rec);
    if (vistas.has(k)) {
      duplicadas++;
      continue;
    }
    vistas.add(k);
    registros.push(rec);
  }
  return { registros, invalidas, duplicadas };
}

export interface MesclaEspelho {
  /** Eventos que ainda não estavam no espelho, em ordem de `criado_em`. */
  readonly novos: readonly VendaRecord[];
  /** Eventos recebidos cuja chave já estava no espelho (ou repetida no
   * próprio lote recebido). */
  readonly jaPresentes: number;
}

/** Instante de `criado_em` em ms; data ilegível vai para o fim. */
function instante(r: VendaRecord): number {
  const ms = Date.parse(r.criado_em);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * Separa, dos eventos recebidos do KV, os que faltam no espelho. As janelas
 * de `planejarJanelas` não se sobrepõem, mas o mesmo evento ainda pode vir
 * repetido no lote: o Worker grava uma chave por dia de recebimento, e um
 * reenvio da Hotmart noutro dia cai noutra janela (ou na mesma, noutro dia).
 * A repetição fica só no mais antigo por `Date.parse(criado_em)`, como em
 * `lerVendas`.
 */
export function mesclarEspelho(existentes: readonly VendaRecord[], recebidos: readonly VendaRecord[]): MesclaEspelho {
  const vistos = new Set(existentes.map(chaveEspelho));
  const ordenados = [...recebidos].sort((a, b) => instante(a) - instante(b));
  const novos: VendaRecord[] = [];
  let jaPresentes = 0;
  for (const r of ordenados) {
    const k = chaveEspelho(r);
    if (vistos.has(k)) {
      jaPresentes++;
      continue;
    }
    vistos.add(k);
    novos.push(r);
  }
  return { novos, jaPresentes };
}

/**
 * Texto a ACRESCENTAR ao espelho para gravar `novos`. Se o arquivo atual não
 * termina em quebra de linha, a primeira linha nova começa com uma (senão
 * colaria na última linha existente e as duas virariam JSON inválido).
 * Vazio quando não há nada novo.
 */
export function textoParaAcrescentar(novos: readonly VendaRecord[], textoAtual: string): string {
  if (novos.length === 0) return "";
  const prefixo = textoAtual.length > 0 && !textoAtual.endsWith("\n") ? "\n" : "";
  return prefixo + novos.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function diaMs(dia: string): number {
  if (!DAY_RE.test(dia)) throw new Error(`dia inválido "${dia}" (use AAAA-MM-DD)`);
  const ms = Date.parse(`${dia}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== dia) {
    throw new Error(`dia inexistente "${dia}"`);
  }
  return ms;
}

function diaDe(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Período padrão do sync: os últimos `dias` dias, terminando hoje em
 * Brasília (inclusive). */
export function periodoPadrao(nowMs: number, dias: number = SYNC_DIAS_PADRAO): Periodo {
  if (!Number.isInteger(dias) || dias < 1) throw new Error(`dias deve ser inteiro ≥ 1, recebido ${dias}`);
  const ate = brtDay(nowMs);
  return { de: diaDe(diaMs(ate) - (dias - 1) * DAY_MS), ate };
}

/** Quebra `de..ate` (inclusive) em janelas consecutivas de até `maxDias`
 * dias, sem buraco nem sobreposição. Lança em data inválida ou invertida. */
export function planejarJanelas(de: string, ate: string, maxDias: number = JANELA_MAX_DIAS): Periodo[] {
  if (!Number.isInteger(maxDias) || maxDias < 1) throw new Error(`maxDias deve ser inteiro ≥ 1, recebido ${maxDias}`);
  const inicio = diaMs(de);
  const fim = diaMs(ate);
  if (fim < inicio) throw new Error(`período invertido: ${de} depois de ${ate}`);
  const janelas: Periodo[] = [];
  for (let ms = inicio; ms <= fim; ms += maxDias * DAY_MS) {
    janelas.push({ de: diaDe(ms), ate: diaDe(Math.min(ms + (maxDias - 1) * DAY_MS, fim)) });
  }
  return janelas;
}

export interface RespostaVendas {
  readonly registros: readonly VendaRecord[];
  /** Registros da resposta que não passaram por `parseVendaRecord`. */
  readonly descartados: number;
  /** Chaves do KV que o próprio Worker já pulou por conteúdo inválido. */
  readonly ignoradosNoKv: number;
}

/** Valida o corpo de `GET /hotmart/vendas`. Lança se a resposta não for um
 * `{ ok: true, registros: [...] }`: resposta estranha não pode virar "zero
 * vendas" em silêncio. */
export function parseRespostaVendas(body: unknown): RespostaVendas {
  const o = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!o || o.ok !== true || !Array.isArray(o.registros)) {
    const erro = o && typeof o.error === "string" ? o.error : "formato inesperado";
    throw new Error(`resposta de /hotmart/vendas inválida (${erro})`);
  }
  const registros: VendaRecord[] = [];
  let descartados = 0;
  for (const x of o.registros) {
    const rec = parseVendaRecord(x);
    if (rec) registros.push(rec);
    else descartados++;
  }
  return { registros, descartados, ignoradosNoKv: Array.isArray(o.ignorados) ? o.ignorados.length : 0 };
}

export interface ResultadoSync {
  readonly janelas: number;
  /** Soma, entre as janelas, dos registros válidos recebidos. */
  readonly recebidos: number;
  readonly novos: readonly VendaRecord[];
  readonly jaPresentes: number;
  /** Soma, entre as janelas, dos registros que a rota devolveu fora do formato. */
  readonly descartados: number;
  /** Soma, entre as janelas, das chaves que o Worker pulou por conteúdo inválido. */
  readonly ignoradosNoKv: number;
  /** Linhas do espelho atual que não são registro válido (ficam como estão). */
  readonly invalidasNoEspelho: number;
  /** Linhas do espelho atual com chave repetida (ficam como estão). */
  readonly duplicadasNoEspelho: number;
  /** Texto a acrescentar ao espelho (vazio se nada novo). */
  readonly acrescentar: string;
}

/**
 * Orquestra o sync sem tocar fs nem rede: busca cada janela com `buscarJanela`
 * (erro sobe: janela que falhou não pode virar "sem vendas") e devolve o que
 * acrescentar ao espelho atual.
 */
export async function sincronizarEspelho(opts: {
  janelas: readonly Periodo[];
  buscarJanela: (de: string, ate: string) => Promise<RespostaVendas>;
  textoAtual: string;
}): Promise<ResultadoSync> {
  const recebidos: VendaRecord[] = [];
  let descartados = 0;
  let ignoradosNoKv = 0;
  for (const j of opts.janelas) {
    const r = await opts.buscarJanela(j.de, j.ate);
    recebidos.push(...r.registros);
    descartados += r.descartados;
    ignoradosNoKv += r.ignoradosNoKv;
  }
  const { registros: existentes, invalidas, duplicadas } = lerEspelho(opts.textoAtual);
  const { novos, jaPresentes } = mesclarEspelho(existentes, recebidos);
  return {
    janelas: opts.janelas.length,
    recebidos: recebidos.length,
    novos,
    jaPresentes,
    descartados,
    ignoradosNoKv,
    invalidasNoEspelho: invalidas,
    duplicadasNoEspelho: duplicadas,
    acrescentar: textoParaAcrescentar(novos, opts.textoAtual),
  };
}
