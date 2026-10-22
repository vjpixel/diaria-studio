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
import { parseVendaRecord, VENDA_KV_PREFIX, type VendaRecord } from "./shared/hotmart-vendas.ts";

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

/** Janela da VARREDURA mensal (#10876 item 1): o teto da rota, 93 dias. */
export const SYNC_DIAS_VARREDURA = JANELA_MAX_DIAS;

/** Até este dia do mês (Brasília), a rodada sem período explícito usa a
 * varredura de 93 dias em vez da janela de 35. Com a task semanal (sábado),
 * todo mês tem exatamente uma rodada nos dias 1-7. */
export const VARREDURA_ATE_DIA_DO_MES = 7;

/**
 * Dias da rodada sem período explícito (#10876 item 1). A chave do KV é
 * indexada pelo dia de `creation_date`, não pelo dia em que o evento chegou:
 * um reenvio manual de evento antigo pelo painel da Hotmart, ou uma
 * retentativa tardia, grava num dia que a janela de 35 dias já não lê. Uma
 * vez por mês a rodada lê 93 dias para trás e pega esse evento.
 *
 * Limite que fica: evento que chega com `creation_date` mais de 93 dias no
 * passado nunca é espelhado (a rota não lê mais que 93 dias por chamada e o
 * sync não varre o KV inteiro); só um backfill manual com `--de` o traz,
 * enquanto o TTL de 400 dias não o apagar.
 */
export function diasPadraoDoSync(nowMs: number): number {
  const diaDoMes = Number(brtDay(nowMs).slice(8, 10));
  return diaDoMes <= VARREDURA_ATE_DIA_DO_MES ? SYNC_DIAS_VARREDURA : SYNC_DIAS_PADRAO;
}

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
  /** Nomes dessas chaves, quando a rota os devolve (#10881 item 3). Sem
   * nomes, toda chave ignorada conta como nova (não dá para saber se já foi
   * avisada). */
  readonly chavesIgnoradas?: readonly string[];
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
  const ignorados = Array.isArray(o.ignorados) ? o.ignorados : [];
  return {
    registros,
    descartados,
    ignoradosNoKv: ignorados.length,
    chavesIgnoradas: ignorados.filter((k): k is string => typeof k === "string"),
  };
}

// ---------------------------------------------------------------------------
// Estado do sync (#10876, #10881 item 3, #10734 4b)
// ---------------------------------------------------------------------------

export const ESTADO_SYNC_VERSION = 1;

/**
 * Estado gravado ao lado do espelho (`estadoPathDoEspelho`), atualizado a cada
 * janela concluída:
 * - `cobertura`: intervalos de dias já lidos por inteiro da rota, fundidos
 *   quando se tocam. É o que diz ao ARPU/LTV (`ltv.ts`) se um mês inteiro já
 *   passou pelo espelho; sem estado, a Hotmart segue como fonte sem dado.
 * - `chaves_invalidas_conhecidas`: chaves do KV que o Worker pulou e que já
 *   viraram alarme uma vez. Uma chave inválida persistente fica no KV por até
 *   400 dias; sem esta lista, a task semanal sairia com exit 3 toda semana até
 *   o TTL (#10881 item 3). Chave nova continua dando exit 3.
 */
export interface EstadoSync {
  readonly v: typeof ESTADO_SYNC_VERSION;
  readonly cobertura: readonly Periodo[];
  readonly chaves_invalidas_conhecidas: readonly string[];
  readonly atualizado_em: string | null;
}

export const ESTADO_SYNC_VAZIO: EstadoSync = { v: ESTADO_SYNC_VERSION, cobertura: [], chaves_invalidas_conhecidas: [], atualizado_em: null };

/** `data/hotmart/vendas.jsonl` → `data/hotmart/vendas.estado.json`. */
export function estadoPathDoEspelho(espelhoPath: string): string {
  return `${espelhoPath.replace(/\.jsonl$/i, "")}.estado.json`;
}

/**
 * Lê o estado. `null` (arquivo ausente) vira o estado vazio. Conteúdo
 * ilegível LANÇA: tratá-lo como vazio apagaria a cobertura e reabriria os
 * alarmes de chaves já conhecidas, em silêncio.
 */
export function parseEstadoSync(texto: string | null): EstadoSync {
  if (texto === null || texto.trim() === "") return ESTADO_SYNC_VAZIO;
  let raw: unknown;
  try {
    raw = JSON.parse(texto);
  } catch (e) {
    throw new Error(`estado do sync Hotmart ilegível (${(e as Error).message})`);
  }
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!o || !Array.isArray(o.cobertura) || !Array.isArray(o.chaves_invalidas_conhecidas)) {
    throw new Error("estado do sync Hotmart ilegível (formato inesperado)");
  }
  const cobertura: Periodo[] = [];
  for (const p of o.cobertura) {
    const q = p && typeof p === "object" ? (p as Record<string, unknown>) : {};
    if (typeof q.de !== "string" || typeof q.ate !== "string" || !DAY_RE.test(q.de) || !DAY_RE.test(q.ate) || q.ate < q.de) {
      throw new Error(`estado do sync Hotmart ilegível (intervalo de cobertura inválido: ${JSON.stringify(p)})`);
    }
    cobertura.push({ de: q.de, ate: q.ate });
  }
  return {
    v: ESTADO_SYNC_VERSION,
    cobertura: fundirCobertura(cobertura),
    chaves_invalidas_conhecidas: o.chaves_invalidas_conhecidas.filter((k): k is string => typeof k === "string"),
    atualizado_em: typeof o.atualizado_em === "string" ? o.atualizado_em : null,
  };
}

/** Ordena e funde intervalos que se sobrepõem ou se tocam (dia seguinte). */
export function fundirCobertura(intervalos: readonly Periodo[]): Periodo[] {
  const ord = [...intervalos].sort((a, b) => a.de.localeCompare(b.de));
  const out: Periodo[] = [];
  for (const p of ord) {
    const ult = out[out.length - 1];
    if (ult && diaMs(p.de) <= diaMs(ult.ate) + DAY_MS) {
      if (p.ate > ult.ate) out[out.length - 1] = { de: ult.de, ate: p.ate };
    } else {
      out.push({ de: p.de, ate: p.ate });
    }
  }
  return out;
}

/** `true` se `de..ate` cabe inteiro num único intervalo da cobertura. */
export function periodoCoberto(cobertura: readonly Periodo[], de: string, ate: string): boolean {
  return cobertura.some((p) => p.de <= de && p.ate >= ate);
}

/** O que a janela perdeu no caminho até o espelho (#10909). */
export interface PerdasDaJanela {
  /** Registros que a rota devolveu fora do formato (sem dia conhecido). */
  readonly descartados: number;
  /** Chaves do KV que o Worker pulou por conteúdo inválido — conhecidas ou
   * novas: chave "já avisada" continua sendo venda que não chegou ao espelho. */
  readonly ignoradosNoKv: number;
  /** Nomes dessas chaves, quando a rota os devolve. */
  readonly chavesIgnoradas: readonly string[];
}

const DIA_DA_CHAVE_RE = /^(\d{4}-\d{2}-\d{2}):/;

/**
 * Trechos da janela que podem entrar na cobertura (#10892 review, #10909):
 * - o dia de HOJE (Brasília) nunca conta como lido por inteiro: a rodada só
 *   viu as vendas até a hora em que rodou. A cobertura para em ONTEM — ex.:
 *   a varredura das 04:30 de sábado 31/10 cobre outubro só até 30/10, e o
 *   mês só fica coberto na rodada seguinte, que lê o dia 31 inteiro;
 * - janela com registro devolvido fora do formato (`descartados > 0`) não
 *   conta: há venda que não chegou ao espelho, e o mês não pode sair
 *   "coberto" com receita a menos sem rótulo de PISO;
 * - chave inválida no KV (#10909) é a mesma perda, inclusive a já conhecida
 *   (ela só deixa de repetir o ALARME, a venda continua fora do espelho). A
 *   chave traz o dia (`hotmart:venda:{dia}:...`), então só esse dia fica fora
 *   e o resto da janela entra: o mês do dia afetado segue sem cobertura (sai
 *   sem dado, com motivo) e os outros meses da janela não são penalizados.
 *   Chave sem nome, fora do formato ou com dia fora da janela tira a janela
 *   inteira — sem saber o dia, não dá para isolar a perda.
 * Devolve `[]` quando nada da janela pode ser registrado.
 */
export function trechosCobertosDaJanela(janela: Periodo, perdas: PerdasDaJanela, nowMs: number): Periodo[] {
  if (perdas.descartados > 0) return [];
  const ontem = diaDe(diaMs(brtDay(nowMs)) - DAY_MS);
  if (janela.de > ontem) return [];
  const fim = janela.ate < ontem ? janela.ate : ontem;
  if (perdas.ignoradosNoKv > perdas.chavesIgnoradas.length) return [];
  const diasPerdidos = new Set<string>();
  for (const chave of perdas.chavesIgnoradas) {
    const m = chave.startsWith(VENDA_KV_PREFIX) ? DIA_DA_CHAVE_RE.exec(chave.slice(VENDA_KV_PREFIX.length)) : null;
    const dia = m?.[1];
    if (!dia || Number.isNaN(Date.parse(`${dia}T00:00:00Z`)) || dia < janela.de || dia > janela.ate) return [];
    diasPerdidos.add(dia);
  }
  const trechos: Periodo[] = [];
  let inicio: string | null = null;
  for (let ms = diaMs(janela.de); ms <= diaMs(fim); ms += DAY_MS) {
    const dia = diaDe(ms);
    if (diasPerdidos.has(dia)) {
      if (inicio) trechos.push({ de: inicio, ate: diaDe(ms - DAY_MS) });
      inicio = null;
    } else if (!inicio) {
      inicio = dia;
    }
  }
  if (inicio) trechos.push({ de: inicio, ate: fim });
  return trechos;
}

/** Estado depois de uma janela lida. `trechosCobertos` é o que
 * `trechosCobertosDaJanela` devolveu (`[]` = não amplia a cobertura). */
export function registrarJanelaNoEstado(
  estado: EstadoSync,
  trechosCobertos: readonly Periodo[],
  chavesInvalidasNovas: readonly string[],
  nowIso: string,
): EstadoSync {
  return {
    v: ESTADO_SYNC_VERSION,
    cobertura: fundirCobertura([...estado.cobertura, ...trechosCobertos]),
    chaves_invalidas_conhecidas: [...new Set([...estado.chaves_invalidas_conhecidas, ...chavesInvalidasNovas])].sort(),
    atualizado_em: nowIso,
  };
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
  /** Dessas, as que não estavam em `chavesInvalidasConhecidas` (só elas viram
   * alarme, #10881 item 3). Chave sem nome conta sempre como nova. */
  readonly ignoradosNoKvNovos: number;
  /** Nomes das chaves ignoradas novas (para gravar no estado). */
  readonly chavesIgnoradasNovas: readonly string[];
  /** Linhas do espelho atual que não são registro válido (ficam como estão). */
  readonly invalidasNoEspelho: number;
  /** Linhas do espelho atual com chave repetida (ficam como estão). */
  readonly duplicadasNoEspelho: number;
  /** Texto acrescentado ao espelho, todas as janelas juntas (vazio se nada novo). */
  readonly acrescentar: string;
}

/** O que `aoConcluirJanela` recebe ao fim de cada janela lida. */
export interface JanelaConcluida {
  readonly janela: Periodo;
  /** Texto a acrescentar AGORA ao espelho (vazio se a janela não trouxe nada novo). */
  readonly acrescentar: string;
  readonly novos: readonly VendaRecord[];
  /** Chaves inválidas desta janela que ainda não eram conhecidas. */
  readonly chavesIgnoradasNovas: readonly string[];
  /** Registros desta janela que a rota devolveu fora do formato. */
  readonly descartados: number;
  /** Chaves do KV que o Worker pulou nesta janela, conhecidas ou não (#10909):
   * entram em `trechosCobertosDaJanela` para o dia afetado não sair coberto. */
  readonly ignoradosNoKv: number;
  /** Nomes de todas essas chaves (conhecidas e novas), quando a rota os devolve. */
  readonly chavesIgnoradas: readonly string[];
}

/**
 * Orquestra o sync sem tocar fs nem rede: busca cada janela com `buscarJanela`
 * (erro sobe: janela que falhou não pode virar "sem vendas").
 *
 * Grava POR JANELA (#10876 item 2): ao fim de cada janela lida,
 * `aoConcluirJanela` recebe o texto a acrescentar daquela janela, já
 * deduplicado contra o espelho e contra as janelas anteriores. Num backfill de
 * várias janelas, um erro na última não descarta o que as anteriores leram — o
 * chamador já gravou. Sem `aoConcluirJanela` (dry-run, teste), nada é gravado e
 * `acrescentar` traz o texto total.
 */
export async function sincronizarEspelho(opts: {
  janelas: readonly Periodo[];
  buscarJanela: (de: string, ate: string) => Promise<RespostaVendas>;
  textoAtual: string;
  chavesInvalidasConhecidas?: ReadonlySet<string>;
  aoConcluirJanela?: (j: JanelaConcluida) => void;
}): Promise<ResultadoSync> {
  const conhecidas = opts.chavesInvalidasConhecidas ?? new Set<string>();
  const { registros: existentesIniciais, invalidas, duplicadas } = lerEspelho(opts.textoAtual);
  const existentes: VendaRecord[] = [...existentesIniciais];
  let textoCorrente = opts.textoAtual;
  let acrescentado = "";
  const todosNovos: VendaRecord[] = [];
  let recebidos = 0;
  let jaPresentes = 0;
  let descartados = 0;
  let ignoradosNoKv = 0;
  let ignoradosNoKvNovos = 0;
  const chavesIgnoradasNovas: string[] = [];
  for (const j of opts.janelas) {
    const r = await opts.buscarJanela(j.de, j.ate);
    const mescla = mesclarEspelho(existentes, r.registros);
    const texto = textoParaAcrescentar(mescla.novos, textoCorrente);
    const nomes = r.chavesIgnoradas ?? [];
    const novasDaJanela = [...new Set(nomes.filter((k) => !conhecidas.has(k) && !chavesIgnoradasNovas.includes(k)))];
    const semNome = Math.max(0, r.ignoradosNoKv - nomes.length);
    opts.aoConcluirJanela?.({
      janela: j,
      acrescentar: texto,
      novos: mescla.novos,
      chavesIgnoradasNovas: novasDaJanela,
      descartados: r.descartados,
      ignoradosNoKv: r.ignoradosNoKv,
      chavesIgnoradas: nomes,
    });
    existentes.push(...mescla.novos);
    todosNovos.push(...mescla.novos);
    textoCorrente += texto;
    acrescentado += texto;
    recebidos += r.registros.length;
    jaPresentes += mescla.jaPresentes;
    descartados += r.descartados;
    ignoradosNoKv += r.ignoradosNoKv;
    ignoradosNoKvNovos += novasDaJanela.length + semNome;
    chavesIgnoradasNovas.push(...novasDaJanela);
  }
  return {
    janelas: opts.janelas.length,
    recebidos,
    novos: todosNovos,
    jaPresentes,
    descartados,
    ignoradosNoKv,
    ignoradosNoKvNovos,
    chavesIgnoradasNovas,
    invalidasNoEspelho: invalidas,
    duplicadasNoEspelho: duplicadas,
    acrescentar: acrescentado,
  };
}
