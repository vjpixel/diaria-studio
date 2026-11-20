/**
 * scripts/lib/diaria/agendamentos.ts (#12774)
 *
 * Banco de agendamentos: o registro único das publicações FUTURAS da diar.ia.br
 * (o 1º caso é o vertical 2, "o guia", gravado no dia da edição e publicado
 * uma semana depois, #12751). Até aqui cada publicação futura só existia a
 * partir do momento em que era agendada na plataforma, cada uma no seu
 * registro (`06-shorts-published.json`, fila do Worker, Buffer, task one-shot);
 * nada dizia "isto deve sair em D+7" antes de o conteúdo estar pronto.
 *
 * Arquivo: `data/agendamentos/banco.json` (`AGENDAMENTOS_DB_REL_PATH`). Um
 * item guarda edição de origem, peça, destinos, instante alvo, dono, estado e
 * o histórico das transições. Estados:
 *
 *   pendente  → o conteúdo ainda não existe (ex.: vertical 2 não exportado)
 *   pronto    → o conteúdo existe, falta agendar/publicar
 *   agendado  → agendado na plataforma, sem confirmação de que saiu
 *   publicado → confirmado RELENDO a plataforma (#573): exige `verificacao`
 *   falhou    → a tentativa falhou; volta a `pendente`/`pronto` num retry
 *
 * `publicado` é terminal e só entra com `verificacao` (fonte + instante da
 * releitura, URL opcional): o 2xx de uma mutação não é prova de publicação.
 *
 * Concorrência: escrita atômica (`writeFileAtomic`) + revisão otimista. Quem
 * grava passa a `revisao` que leu; se o arquivo em disco já está noutra
 * revisão, `saveAgendamentos` recusa em vez de sobrescrever a escrita alheia.
 * Entre máquinas vale o que o OneDrive sincronizou (o mesmo limite de
 * `timer-lock.ts`): o consumidor no `300` só LÊ o banco, então a escrita fica
 * com as sessões (skills de vídeo, CLI), uma por vez na prática.
 *
 * Lógica pura aqui; o CLI é `scripts/agendamentos.ts` e o consumidor do timer
 * é `scripts/agendamentos-tick.ts`.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../atomic-write.ts";
import { mainVerticalTimes } from "./extra-verticals.ts";
import type { ShortScheduleConfig } from "./short-video.ts";

/** Caminho do banco relativo à raiz do repo. */
export const AGENDAMENTOS_DB_REL_PATH = "data/agendamentos/banco.json";

export const AGENDAMENTO_ESTADOS = ["pendente", "pronto", "agendado", "publicado", "falhou"] as const;
export type AgendamentoEstado = (typeof AGENDAMENTO_ESTADOS)[number];

/** Estados em que o item ainda deveria sair (ou já devia ter saído). */
export const ESTADOS_EM_ABERTO: readonly AgendamentoEstado[] = ["pendente", "pronto", "agendado"];

/** Transições permitidas. `publicado` é terminal. */
export const TRANSICOES: Readonly<Record<AgendamentoEstado, readonly AgendamentoEstado[]>> = {
  pendente: ["pronto", "agendado", "publicado", "falhou"],
  pronto: ["agendado", "publicado", "falhou"],
  agendado: ["publicado", "falhou"],
  falhou: ["pendente", "pronto", "agendado"],
  publicado: [],
};

/** Prova de publicação lida da plataforma depois da mutação (#573). */
export interface AgendamentoVerificacao {
  /** Onde a releitura foi feita (ex.: "youtube-api videos.list", "instagram graph media"). */
  fonte: string;
  /** Instante ISO da releitura. */
  em: string;
  url?: string;
}

export interface AgendamentoHistorico {
  em: string;
  de: AgendamentoEstado | null;
  para: AgendamentoEstado;
  nota?: string;
}

export interface AgendamentoItem {
  /** `{edicao}-{peca}`: um item por peça de cada edição. */
  id: string;
  /** AAMMDD da edição de origem. */
  edicao: string;
  /** Peça (slug), ex.: `vertical-2`. */
  peca: string;
  /** Destinos (ids do `publish-shorts.ts`), ex.: `youtube_shorts`, `instagram`, `facebook:diaria`. */
  destinos: string[];
  /** Instante alvo, ISO com offset. */
  alvo: string;
  /** Quem publica no dia: timer, task ou sessão (texto livre, nunca vazio). */
  dono: string;
  estado: AgendamentoEstado;
  criado_em: string;
  atualizado_em: string;
  verificacao?: AgendamentoVerificacao;
  nota?: string;
  historico: AgendamentoHistorico[];
}

export interface AgendamentosBanco {
  version: 1;
  /** Revisão otimista: sobe 1 a cada gravação. */
  revisao: number;
  itens: AgendamentoItem[];
}

export function emptyBanco(): AgendamentosBanco {
  return { version: 1, revisao: 0, itens: [] };
}

const AAMMDD_RE = /^\d{6}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
/** Destino: slug, ou `tipo:slug` como os ids do `publish-shorts.ts` (`facebook:diaria`, #12774). */
const DESTINO_RE = /^[a-z0-9][a-z0-9_-]*(?::[a-z0-9][a-z0-9_-]*)?$/;

function isIsoInstant(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(Date.parse(s));
}

function isEstado(s: unknown): s is AgendamentoEstado {
  return typeof s === "string" && (AGENDAMENTO_ESTADOS as readonly string[]).includes(s);
}

/** Puro: valida um item; lança com o caminho do campo inválido. */
export function validateItem(raw: unknown, where = "item"): AgendamentoItem {
  if (!raw || typeof raw !== "object") throw new Error(`${where}: não é objeto`);
  const it = raw as Record<string, unknown>;
  if (typeof it.edicao !== "string" || !AAMMDD_RE.test(it.edicao)) throw new Error(`${where}.edicao: esperado AAMMDD`);
  if (typeof it.peca !== "string" || !SLUG_RE.test(it.peca)) throw new Error(`${where}.peca: slug inválido`);
  if (it.id !== `${it.edicao}-${it.peca}`) throw new Error(`${where}.id: esperado ${it.edicao}-${it.peca}`);
  if (
    !Array.isArray(it.destinos) ||
    it.destinos.length === 0 ||
    !it.destinos.every((d) => typeof d === "string" && DESTINO_RE.test(d))
  ) {
    throw new Error(`${where}.destinos: lista não vazia de slugs (ou tipo:slug)`);
  }
  if (!isIsoInstant(it.alvo)) throw new Error(`${where}.alvo: instante ISO inválido`);
  if (typeof it.dono !== "string" || !it.dono.trim()) throw new Error(`${where}.dono: vazio`);
  if (!isEstado(it.estado)) throw new Error(`${where}.estado: inválido (${String(it.estado)})`);
  if (!isIsoInstant(it.criado_em) || !isIsoInstant(it.atualizado_em)) throw new Error(`${where}: datas de criação/atualização inválidas`);
  if (it.estado === "publicado") {
    const v = it.verificacao as Record<string, unknown> | undefined;
    if (!v || typeof v.fonte !== "string" || !v.fonte.trim() || !isIsoInstant(v.em)) {
      throw new Error(`${where}: publicado sem verificacao relida da plataforma (#573)`);
    }
  }
  if (!Array.isArray(it.historico)) throw new Error(`${where}.historico: não é lista`);
  return it as unknown as AgendamentoItem;
}

/** Puro: parse + validação do banco inteiro. Lança em JSON ou forma inválida. */
export function parseBanco(text: string, path = AGENDAMENTOS_DB_REL_PATH): AgendamentosBanco {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path}: JSON inválido (${(e as Error).message})`);
  }
  if (!raw || typeof raw !== "object") throw new Error(`${path}: não é objeto`);
  const b = raw as Record<string, unknown>;
  if (b.version !== 1) throw new Error(`${path}: version desconhecida (${String(b.version)})`);
  if (typeof b.revisao !== "number" || !Number.isInteger(b.revisao) || b.revisao < 0) throw new Error(`${path}: revisao inválida`);
  if (!Array.isArray(b.itens)) throw new Error(`${path}: itens não é lista`);
  const itens = b.itens.map((it, i) => validateItem(it, `${path} itens[${i}]`));
  const ids = new Set<string>();
  for (const it of itens) {
    if (ids.has(it.id)) throw new Error(`${path}: id duplicado ${it.id}`);
    ids.add(it.id);
  }
  return { version: 1, revisao: b.revisao, itens };
}

export function agendamentosPath(root: string): string {
  return join(root, ...AGENDAMENTOS_DB_REL_PATH.split("/"));
}

/**
 * Lê o banco. Arquivo ausente = banco vazio (nada agendado ainda); arquivo
 * ilegível LANÇA: tratar corrupção como "vazio" apagaria os itens na próxima
 * gravação e silenciaria o alarme.
 */
export function loadAgendamentos(path: string): AgendamentosBanco {
  if (!existsSync(path)) return emptyBanco();
  return parseBanco(readFileSync(path, "utf8"), path);
}

/**
 * Grava atomicamente com revisão otimista: `banco.revisao` tem de ser a que
 * está em disco (a lida antes da mudança). Grava com `revisao + 1` e devolve
 * o banco gravado.
 */
export function saveAgendamentos(path: string, banco: AgendamentosBanco): AgendamentosBanco {
  const onDisk = loadAgendamentos(path);
  if (onDisk.revisao !== banco.revisao) {
    throw new Error(
      `${path}: banco mudou desde a leitura (revisão em disco ${onDisk.revisao}, lida ${banco.revisao}) — releia e repita`,
    );
  }
  const next: AgendamentosBanco = { ...banco, revisao: banco.revisao + 1 };
  parseBanco(JSON.stringify(next), path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(next, null, 2) + "\n");
  return next;
}

// ─── Mutações puras ──────────────────────────────────────────────────────────

export interface NovoAgendamento {
  edicao: string;
  peca: string;
  destinos: string[];
  alvo: string;
  dono: string;
  estado?: AgendamentoEstado;
  nota?: string;
}

export interface AddResult {
  banco: AgendamentosBanco;
  item: AgendamentoItem;
  /** `false` quando o mesmo item (mesmos campos) já existia: reexecução idempotente. */
  created: boolean;
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
}

/**
 * Puro (#13736): `dono` que o Git Bash (MSYS) converteu em caminho do Windows.
 * O MSYS troca o argumento que começa com `/` por um caminho dentro da
 * instalação do Git (`/diaria-publica 261123` vira `C:/Program
 * Files/Git/diaria-publica 261123`), e o item seria gravado com esse dono.
 * Devolve o dono provável de antes da conversão (`/diaria-publica 261123`),
 * ou `null` quando o dono não tem cara de conversão.
 */
export function donoConvertidoPeloMsys(dono: string): string | null {
  const d = dono.trim().replace(/\\/g, "/");
  if (!/^[A-Za-z]:\//.test(d)) return null;
  const git = /\/(?:Git|msys64|msys32)\/(.*)$/i.exec(d);
  if (git) return `/${git[1]}`;
  const skill = /\/((?:diaria-|modo corte).*)$/i.exec(d);
  return skill ? `/${skill[1]}` : null;
}

/**
 * Puro: registra um item. Reexecução com os mesmos dados é no-op
 * (`created: false`); mesmo id com dados diferentes lança — mudar alvo,
 * destinos ou dono de um item existente não é efeito colateral de um
 * "registrar de novo".
 */
export function addAgendamento(banco: AgendamentosBanco, input: NovoAgendamento, now: Date): AddResult {
  const estado = input.estado ?? "pendente";
  if (estado === "publicado") throw new Error("item novo não nasce publicado: registre e marque com verificacao");
  const original = donoConvertidoPeloMsys(input.dono);
  if (original !== null) {
    throw new Error(
      `dono ${JSON.stringify(input.dono.trim())} parece caminho convertido pelo Git Bash (MSYS troca argumento que começa com "/" por caminho): ` +
        `rode de novo com MSYS_NO_PATHCONV=1 na frente do comando (dono pretendido: ${JSON.stringify(original)}) (#13736)`,
    );
  }
  const nowIso = now.toISOString();
  const alvo = isIsoInstant(input.alvo) ? new Date(input.alvo).toISOString() : input.alvo;
  const item: AgendamentoItem = {
    id: `${input.edicao}-${input.peca}`,
    edicao: input.edicao,
    peca: input.peca,
    destinos: [...new Set(input.destinos)],
    alvo,
    dono: input.dono.trim(),
    estado,
    criado_em: nowIso,
    atualizado_em: nowIso,
    ...(input.nota ? { nota: input.nota } : {}),
    historico: [{ em: nowIso, de: null, para: estado }],
  };
  validateItem(item);
  const existing = banco.itens.find((it) => it.id === item.id);
  if (existing) {
    const same =
      existing.alvo === item.alvo && existing.dono === item.dono && sameStringSet(existing.destinos, item.destinos);
    if (same) return { banco, item: existing, created: false };
    throw new Error(`${item.id} já existe com outros dados (alvo ${existing.alvo}, dono ${existing.dono})`);
  }
  return { banco: { ...banco, itens: [...banco.itens, item] }, item, created: true };
}

export interface TransicaoInput {
  id: string;
  para: AgendamentoEstado;
  nota?: string;
  verificacao?: AgendamentoVerificacao;
}

/** Puro: aplica uma transição de estado, conferindo `TRANSICOES` e a regra do #573. */
export function transicionarAgendamento(banco: AgendamentosBanco, input: TransicaoInput, now: Date): AgendamentosBanco {
  const idx = banco.itens.findIndex((it) => it.id === input.id);
  if (idx < 0) throw new Error(`item ${input.id} não existe`);
  const cur = banco.itens[idx];
  if (!TRANSICOES[cur.estado].includes(input.para)) {
    throw new Error(`transição ${cur.estado} → ${input.para} não permitida para ${cur.id}`);
  }
  if (input.para === "publicado" && !input.verificacao) {
    throw new Error(`${cur.id}: publicado exige verificacao relida da plataforma (#573)`);
  }
  const nowIso = now.toISOString();
  const next: AgendamentoItem = {
    ...cur,
    estado: input.para,
    atualizado_em: nowIso,
    ...(input.verificacao ? { verificacao: input.verificacao } : {}),
    ...(input.nota ? { nota: input.nota } : {}),
    historico: [...cur.historico, { em: nowIso, de: cur.estado, para: input.para, ...(input.nota ? { nota: input.nota } : {}) }],
  };
  validateItem(next);
  const itens = [...banco.itens];
  itens[idx] = next;
  return { ...banco, itens };
}

/** Puro: tira um item do banco (publicação desistida). Lança se o id não existe. */
export function removerAgendamento(banco: AgendamentosBanco, id: string): AgendamentosBanco {
  if (!banco.itens.some((it) => it.id === id)) throw new Error(`item ${id} não existe`);
  return { ...banco, itens: banco.itens.filter((it) => it.id !== id) };
}

// ─── Datas ───────────────────────────────────────────────────────────────────

/** Puro: AAMMDD + N dias de calendário. */
export function addDaysAammdd(aammdd: string, days: number): string {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(aammdd);
  if (!m) throw new Error(`AAMMDD inválido: ${aammdd}`);
  const d = new Date(Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/** Puro: instante ISO (UTC) do `HH:MM` BRT (UTC-3, sem horário de verão) no dia AAMMDD. */
export function brtAlvoIso(aammdd: string, hhmm: string): string {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(aammdd);
  const t = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m || !t) throw new Error(`data/hora inválida: ${aammdd} ${hhmm}`);
  return new Date(Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t[1]) + 3, Number(t[2]))).toISOString();
}

/** Puro: `HH:MM` BRT de um instante ISO (UTC-3 fixo, o mesmo de `brtAlvoIso`). */
function brtHhmmAndDate(iso: string): { aammdd: string; hhmm: string } | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t - 3 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    aammdd: `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`,
    hhmm: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
  };
}

export interface HorarioLivreResultado {
  hhmm: string;
  /** `true` quando o horário pedido foi trocado por um livre. */
  ajustado: boolean;
  /** `true` quando nenhum horário de `rotation_times` estava livre: fica o pedido, colidindo. */
  colide: boolean;
  motivo: string;
}

/**
 * Puro (#13729): o horário de um item do banco nos destinos da vertical no dia
 * `aammdd` sem colar em outra publicação das mesmas contas. Ocupados: os
 * horários da vertical principal daquele dia (`mainVerticalTimes`, só em dia
 * útil, que é quando há edição) e os alvos dos outros itens do banco no mesmo
 * dia com algum destino em comum (o extra de outra edição, #12934). Horário
 * pedido livre fica como está; ocupado vira o seguinte livre de
 * `rotation_times` (em ciclo, como a extra do `extraVerticalTime`); sem
 * nenhum livre, fica o pedido com `colide: true`.
 *
 * Motivo: o vertical 2 era registrado às 12:00 de D+7, e D+7 de uma edição de
 * dia útil é dia útil, com o vertical 1 da edição do dia às 12:00 nos mesmos
 * destinos.
 */
export function horarioLivreNoBanco(input: {
  sched: ShortScheduleConfig;
  aammdd: string;
  hhmm: string;
  destinos: readonly string[];
  /** Destinos da vertical principal (`--destinos vertical`); sem interseção com `destinos`, a principal não ocupa nada. */
  destinosVertical: readonly string[];
  banco: AgendamentosBanco;
  /** Id do próprio item: não ocupa o próprio horário (retomada idempotente). */
  id: string;
}): HorarioLivreResultado {
  const ocupados = new Map<string, string>();
  const wd = new Date(Date.UTC(2000 + Number(input.aammdd.slice(0, 2)), Number(input.aammdd.slice(2, 4)) - 1, Number(input.aammdd.slice(4, 6)))).getUTCDay();
  const diaUtil = wd !== 0 && wd !== 6;
  const cruza = (a: readonly string[], b: readonly string[]) => a.some((d) => b.includes(d));
  if (diaUtil && cruza(input.destinos, input.destinosVertical)) {
    for (const t of mainVerticalTimes(input.sched, input.aammdd).taken) ocupados.set(t, `vertical principal de ${input.aammdd}`);
  }
  for (const it of input.banco.itens) {
    if (it.id === input.id || !cruza(it.destinos, input.destinos)) continue;
    if (it.estado === "falhou") continue;
    const at = brtHhmmAndDate(it.alvo);
    if (at && at.aammdd === input.aammdd && !ocupados.has(at.hhmm)) ocupados.set(at.hhmm, `item ${it.id} do banco`);
  }
  if (!ocupados.has(input.hhmm)) {
    return { hhmm: input.hhmm, ajustado: false, colide: false, motivo: `${input.hhmm} livre em ${input.aammdd}` };
  }
  const times = input.sched.rotationTimes;
  const i = times.indexOf(input.hhmm);
  for (let step = 1; step <= times.length; step++) {
    const t = times[((i < 0 ? -1 : i) + step + times.length) % times.length];
    if (!ocupados.has(t)) {
      return {
        hhmm: t,
        ajustado: true,
        colide: false,
        motivo: `${input.hhmm} de ${input.aammdd} é da ${ocupados.get(input.hhmm)}: usa ${t}, o seguinte livre de rotation_times (${times.join("/")}) (#13729)`,
      };
    }
  }
  const lista = [...ocupados].map(([t, quem]) => `${t} (${quem})`).join(", ");
  return { hhmm: input.hhmm, ajustado: false, colide: true, motivo: `nenhum horário de rotation_times (${times.join("/")}) livre em ${input.aammdd}: ocupados ${lista}; fica ${input.hhmm}, colidindo (#13729)` };
}

// ─── Consumo e alarme ────────────────────────────────────────────────────────

/** Folga depois do alvo antes de o item contar como vencido. */
export const AGENDAMENTO_VENCIDO_GRACE_MINUTES = 60;

export type AgendamentoAchadoTipo = "vencido-sem-publicacao" | "falhou";

export interface AgendamentoAchado {
  tipo: AgendamentoAchadoTipo;
  item: AgendamentoItem;
  /** Minutos desde o alvo (negativo = ainda não venceu; só aparece em `falhou`). */
  atrasoMin: number;
}

export interface AgendamentosAvaliacao {
  achados: AgendamentoAchado[];
  /** Itens em aberto que venceram e seriam do consumidor publicar (estado `pronto`). */
  aPublicar: AgendamentoItem[];
  /** Itens em aberto que ainda não venceram. */
  futuros: AgendamentoItem[];
  /**
   * Itens `agendado` vencidos que NÃO viram achado porque o envio de cada
   * destino está registrado (#12825, ver `semAlarme`). Seguem esperando a
   * marcação à mão (`marcar --estado publicado`); o tick só os relata.
   */
  semAlarme: AgendamentoItem[];
}

export interface AvaliarAgendamentosOpts {
  graceMinutes?: number;
  /**
   * Ids de itens `agendado` cujo envio está registrado em todos os destinos
   * sem leitor (e relido no ar nos que têm leitor), decisão do editor na
   * #12825, opção (a): vencidos, não viram achado. Calculado por
   * `agendadosComEnvioRegistrado` (`agendamentos-verificar.ts`). Só vale
   * para o estado `agendado`: `pendente`/`pronto` vencidos alarmam sempre.
   */
  semAlarme?: ReadonlySet<string>;
}

/**
 * Puro: o que o consumidor vê no instante `now`. Item em aberto passado
 * `alvo + grace` vira achado `vencido-sem-publicacao` (exceto o `agendado`
 * listado em `opts.semAlarme`, que sai em `semAlarme`, #12825); item `falhou`
 * vira achado sempre (alguém precisa refazer). `aPublicar` lista os `pronto`
 * já no horário: o consumidor ainda não publica (nenhum publicador ligado, ver
 * `scripts/agendamentos-tick.ts`), só relata.
 */
export function avaliarAgendamentos(
  banco: AgendamentosBanco,
  now: Date,
  opts: AvaliarAgendamentosOpts = {},
): AgendamentosAvaliacao {
  const graceMinutes = opts.graceMinutes ?? AGENDAMENTO_VENCIDO_GRACE_MINUTES;
  const achados: AgendamentoAchado[] = [];
  const aPublicar: AgendamentoItem[] = [];
  const futuros: AgendamentoItem[] = [];
  const semAlarme: AgendamentoItem[] = [];
  for (const item of banco.itens) {
    const atrasoMin = Math.floor((now.getTime() - Date.parse(item.alvo)) / 60_000);
    if (item.estado === "falhou") {
      achados.push({ tipo: "falhou", item, atrasoMin });
      continue;
    }
    if (!ESTADOS_EM_ABERTO.includes(item.estado)) continue;
    if (atrasoMin < 0) {
      futuros.push(item);
      continue;
    }
    if (item.estado === "pronto") aPublicar.push(item);
    if (atrasoMin <= graceMinutes) continue;
    if (item.estado === "agendado" && opts.semAlarme?.has(item.id)) {
      semAlarme.push(item);
      continue;
    }
    achados.push({ tipo: "vencido-sem-publicacao", item, atrasoMin });
  }
  futuros.sort((a, b) => a.alvo.localeCompare(b.alvo));
  return { achados, aPublicar, futuros, semAlarme };
}

/** Puro: fingerprint do CONJUNTO de achados (muda quando o conjunto muda). */
export function agendamentosAlarmFingerprint(achados: readonly AgendamentoAchado[]): string {
  return achados
    .map((a) => `${a.item.id}:${a.tipo}`)
    .sort()
    .join(",");
}

function fmtBrt(iso: string): string {
  const d = new Date(Date.parse(iso) - 3 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} BRT`;
}

/** Puro: assunto e corpo da issue do alarme. */
export function buildAgendamentosAlarm(achados: readonly AgendamentoAchado[]): { subject: string; body: string } {
  const n = achados.length;
  const subject = `Banco de agendamentos: ${n} ${n === 1 ? "item vencido ou falho" : "itens vencidos ou falhos"} sem publicação`;
  const lines = [
    `O consumidor do banco de agendamentos (\`${AGENDAMENTOS_DB_REL_PATH}\`, #12774) encontrou ${n} ${n === 1 ? "item" : "itens"} que já deviam ter saído e não estão marcados como publicados.`,
    "",
    "| Item | Estado | Alvo | Atraso | Destinos | Dono |",
    "|---|---|---|---|---|---|",
    ...achados.map(
      (a) =>
        `| \`${a.item.id}\` | ${a.tipo === "falhou" ? "falhou" : a.item.estado} | ${fmtBrt(a.item.alvo)} | ${a.atrasoMin >= 0 ? `${a.atrasoMin} min` : "—"} | ${a.item.destinos.join(", ")} | ${a.item.dono} |`,
    ),
    "",
    "Para resolver: publicar o item pelo dono indicado e marcar com a releitura da plataforma (#573). Item `agendado` do vertical: o `verificar` relê na plataforma os destinos que têm leitor (hoje só o YouTube) e marca `publicado` quando todos os destinos do item foram relidos no ar; com algum destino sem leitor o item continua `agendado`, e a marcação é à mão, depois de conferir na rede. Item `agendado` só chega a este alarme quando falta o registro de envio de algum destino (ou a releitura do YouTube não o confirma no ar): com o envio registrado em todos, o tick não alarma (#12825):",
    "",
    "```",
    "npx tsx scripts/agendamentos.ts verificar --id {id}",
    "npx tsx scripts/agendamentos.ts marcar --id {id} --estado publicado --verificado-fonte \"{onde releu}\" [--verificado-url URL]",
    "```",
    "",
    "Item `falhou` continua achado até alguém refazer (`--estado pronto` ou `agendado`). Se a publicação não vai mais sair, `npx tsx scripts/agendamentos.ts remover --id {id}`. Esta issue fecha sozinha quando o banco não tiver mais itens vencidos nem falhos.",
  ];
  return { subject, body: lines.join("\n") };
}
