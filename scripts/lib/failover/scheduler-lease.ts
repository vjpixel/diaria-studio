/**
 * scripts/lib/failover/scheduler-lease.ts (#12982)
 *
 * Lease anti-duplicação entre o `300` (dono padrão) e o Neo (contingência)
 * para as tasks `failover: "critical"` do registro
 * (`scripts/lib/scheduled-tasks.ts`).
 *
 * O risco que isto fecha: o `300` volta com a rede enquanto o Neo está
 * armado e os dois publicam o mesmo Short ou disparam a mesma campanha. Isso
 * é irreversível para terceiros. As idempotências que já existem por canal
 * (store de publicação, dedup do Buffer etc.) seguem como segunda camada; esta
 * é a primeira.
 *
 * ## Modelo
 *
 * Uma chave no KV `diaria-ops-state` (`platform.config.json →
 * ops_state_kv`): `infra:scheduler-owner = {"host": "300"|"neo", "until": ISO}`.
 * Toda task `critical`, nas duas máquinas, chama `acquireSchedulerLease` antes
 * de rodar (o gate fica em `scripts/run-task.ts`, nunca em cada script). Quem
 * age renova o lease quando falta menos da metade do TTL.
 *
 * Regras de posse (`decideLease`, pura):
 *   - Lease ATIVO de outro host: cede. É assim que o `300`, ao voltar, fica
 *     parado enquanto o Neo está armado, até o `--disarm` liberar o lease ou o
 *     lease do Neo expirar sem renovação. O `300` de pé cedendo a um lease do
 *     Neo que foi RENOVADO desde a execução anterior é anomalia (o Neo segue
 *     armado com o `300` no ar): o gate sai ≠0 para o alarme de units `failed`.
 *   - Lease ativo próprio: age (e renova se passou da metade). Falha na
 *     RENOVAÇÃO é aviso, não bloqueio: a posse já estava confirmada.
 *   - Lease ausente ou expirado:
 *       - `300`: age e grava o lease para si (dono padrão; retoma lease
 *         expirado do Neo).
 *       - Neo: retoma o PRÓPRIO lease expirado (se o `300` tivesse voltado, já
 *         o teria sobrescrito). Lease ausente ou expirado do `300`: só age com
 *         o sinal de queda `infra:300:down-since` (#12981) presente; erro ao
 *         ler o sinal é fail-closed. Sem o sinal, quem dá posse ao Neo é o
 *         `neo-takeover.ts --arm`, que grava o lease explicitamente.
 *   - Lease corrompido (não parseia): o `300` sobrescreve com o próprio; o Neo
 *     não age.
 *
 * ## Falha de leitura do KV: assimétrica de propósito
 *
 *   - `300` (dono padrão) → fail-OPEN: age. O regime normal não pode passar
 *     a depender do KV estar de pé; o KV fora do ar com o Neo desarmado (o
 *     caso comum, de longe) pararia a publicação do dia inteira. Exceção: se o
 *     último lease lido com sucesso NESTA máquina (`LeaseMemory`, arquivo
 *     local fora do `data/` sincronizado) era do Neo, o `300` fica
 *     fail-closed até voltar a ler o KV. É o caso "Neo armado e KV fora", em
 *     que agir duplicaria o que o Neo publica.
 *   - Neo (contingência) → fail-CLOSED: não age sem lease confirmado. O Neo
 *     só existe para cobrir a queda; publicar "no escuro" é exatamente o
 *     cenário de duplicação que o lease existe para impedir.
 *
 * ## Concorrência e limites do KV
 *
 * O KV da Cloudflare não tem escrita condicional (CAS) e é eventualmente
 * consistente entre regiões (até ~60 s). Por isso, depois de gravar,
 * `acquireSchedulerLease` relê e só age se o lease relido é o próprio
 * (read-back). Dois donos disputando o MESMO lease expirado no mesmo minuto
 * podem ainda, no pior caso, ler cada um a própria escrita em regiões
 * diferentes; a regra acima reduz isso a casos estreitos: o sinal de queda
 * presente com o `300` de pé ao mesmo tempo (sinal defasado), ou um
 * `--arm --force` rodado com o `300` de pé e o lease dele expirado no mesmo
 * minuto. A idempotência por canal é a rede abaixo. Um lock com CAS de
 * verdade existe no repo (D1, `scripts/lib/d1-locks.ts`, #12842); trocar o
 * backend fica para quando ele estiver provisionado.
 *
 * O relógio é o de cada máquina (`until` absoluto em ISO). Desvio de relógio
 * de minutos é irrelevante frente ao TTL de horas.
 */

/** Hosts que disputam o lease. `300` é o dono padrão (regime normal). */
export type FailoverHost = "300" | "neo";
export const PRIMARY_HOST = "300" satisfies FailoverHost;
export const STANDBY_HOST = "neo" satisfies FailoverHost;

/** Chave do lease no KV `diaria-ops-state`. */
export const SCHEDULER_LEASE_KEY = "infra:scheduler-owner";
/** Sinal de queda do `300`. Será gravado pelo vigia da #12981 (Worker cron);
 * até lá a chave fica ausente e o Neo só assume pelo `--arm`. */
export const DOWN_SIGNAL_KEY = "infra:300:down-since";

/**
 * TTL do lease. 6 h: as tasks `critical` de hora em hora (catchups dos
 * Shorts, Shorts-Cortes, Onboarding-Watch-Returning) renovam bem antes, e o
 * Neo aguenta uma suspensão curta sem perder a posse (e, se perder, retoma o
 * próprio lease expirado). O custo é o outro lado: se o Neo morrer armado
 * (sem `--disarm`), o `300` só retoma quando o lease expirar, em até 6 h.
 */
export const LEASE_TTL_MS = 6 * 60 * 60 * 1000;

export interface SchedulerLease {
  host: FailoverHost;
  /** Fim da posse, ISO 8601. */
  until: string;
  /** Quando esta escrita foi feita, ISO 8601 (informativo). */
  writtenAt?: string;
  /** Quem escreveu: nome da task ou `neo-takeover --arm` (informativo). */
  by?: string;
}

/** Resultado de ler o lease: a incerteza fica explícita. */
export type LeaseRead =
  | { kind: "absent" }
  | { kind: "ok"; lease: SchedulerLease }
  /** O KV respondeu, mas o valor não é um lease (JSON inválido ou formato errado). */
  | { kind: "invalid"; error: string }
  /** Falha de rede/HTTP/config: não dá para saber o dono. */
  | { kind: "error"; error: string };

function isHost(v: unknown): v is FailoverHost {
  return v === PRIMARY_HOST || v === STANDBY_HOST;
}

/** Parse do valor cru do KV. `null` = chave inexistente. */
export function parseLease(raw: string | null): LeaseRead {
  if (raw === null) return { kind: "absent" };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: "invalid", error: `lease ilegível (não é JSON): ${raw.slice(0, 120)}` };
  }
  const o = json as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || !isHost(o.host) || typeof o.until !== "string" || Number.isNaN(Date.parse(o.until))) {
    return { kind: "invalid", error: `lease com formato inválido: ${raw.slice(0, 120)}` };
  }
  const lease: SchedulerLease = { host: o.host, until: o.until };
  if (typeof o.writtenAt === "string") lease.writtenAt = o.writtenAt;
  if (typeof o.by === "string") lease.by = o.by;
  return { kind: "ok", lease };
}

export function serializeLease(lease: SchedulerLease): string {
  return JSON.stringify(lease);
}

export function isLeaseActive(lease: SchedulerLease, now: Date): boolean {
  return Date.parse(lease.until) > now.getTime();
}

export function makeLease(host: FailoverHost, now: Date, by: string, ttlMs: number = LEASE_TTL_MS): SchedulerLease {
  return { host, until: new Date(now.getTime() + ttlMs).toISOString(), writtenAt: now.toISOString(), by };
}

/**
 * Último lease lido COM SUCESSO nesta máquina (`absent` também é leitura bem
 * sucedida). Guardado fora do `data/` sincronizado: é memória da máquina, não
 * estado compartilhado. Ver `scripts/lib/failover/lease-memory.ts`.
 */
export type LastKnownLease = { kind: "absent"; seenAt: string } | { kind: "ok"; lease: SchedulerLease; seenAt: string };

export interface LeaseMemory {
  load: () => LastKnownLease | null;
  save: (value: LastKnownLease) => void;
}

/** Por que a task cedeu. */
export type YieldCause =
  /** Lease ativo da outra máquina. */
  | "other-host-active"
  /** Só no `300`: lease ativo do Neo que foi renovado desde a última leitura
   * desta máquina, ou seja, o Neo segue armado com o `300` de pé. */
  | "other-host-renewing"
  /** Só no Neo: lease ausente ou do `300` expirado, sem sinal de queda. */
  | "no-down-signal";

export type LeaseDecision =
  | {
      outcome: "act";
      /** Lease a gravar antes de agir (aquisição ou renovação); `null` = nada a gravar. */
      write: SchedulerLease | null;
      /** A escrita é a renovação de um lease próprio ainda ativo (falha não bloqueia). */
      renewal: boolean;
      reason: string;
    }
  | { outcome: "yield"; cause: YieldCause; holder: SchedulerLease | null; reason: string }
  /** O host não conseguiu confirmar a posse; o gate trata como erro visível. */
  | { outcome: "fail-closed"; reason: string };

export interface DecideLeaseInput {
  self: FailoverHost;
  read: LeaseRead;
  /** Leitura de `infra:300:down-since`. Só o Neo consulta; `undefined` = não lida. */
  downSignal?: DownSignalRead;
  /** Último lease lido com sucesso nesta máquina (só o `300` usa, no fail-open). */
  lastKnown?: LastKnownLease | null;
  now: Date;
  /** Rótulo de quem pede (nome da task), gravado em `by`. */
  by: string;
  ttlMs?: number;
}

/** Decisão de posse, pura. Ver a docstring do módulo para as regras. */
export function decideLease(input: DecideLeaseInput): LeaseDecision {
  const { self, read, downSignal, now, by } = input;
  const ttlMs = input.ttlMs ?? LEASE_TTL_MS;
  const fresh = () => makeLease(self, now, by, ttlMs);

  if (read.kind === "error") {
    if (self !== PRIMARY_HOST) {
      return { outcome: "fail-closed", reason: `fail-closed no ${self}: lease não lido (${read.error}); o Neo não age sem lease confirmado` };
    }
    const last = input.lastKnown;
    if (last?.kind === "ok" && last.lease.host === STANDBY_HOST) {
      return {
        outcome: "fail-closed",
        reason:
          `fail-closed no 300: lease não lido (${read.error}) e o último lease lido nesta máquina ` +
          `(em ${last.seenAt}) era do Neo até ${last.lease.until}; o 300 só volta a agir quando ler o KV`,
      };
    }
    return { outcome: "act", write: null, renewal: false, reason: `fail-open no 300: lease não lido (${read.error}); o 300 é o dono padrão` };
  }

  if (read.kind === "invalid") {
    return self === PRIMARY_HOST
      ? { outcome: "act", write: fresh(), renewal: false, reason: `${read.error}; o 300 (dono padrão) sobrescreve com o próprio lease` }
      : { outcome: "fail-closed", reason: `fail-closed no ${self}: ${read.error}; o Neo não age sem lease confirmado` };
  }

  if (read.kind === "ok" && isLeaseActive(read.lease, now)) {
    const lease = read.lease;
    if (lease.host !== self) {
      return { outcome: "yield", cause: "other-host-active", holder: lease, reason: `lease ativo do ${lease.host} até ${lease.until}; ${self} cede` };
    }
    const remaining = Date.parse(lease.until) - now.getTime();
    if (remaining < ttlMs / 2) {
      return { outcome: "act", write: fresh(), renewal: true, reason: `lease próprio do ${self} renovado (faltavam ${Math.round(remaining / 60000)} min)` };
    }
    return { outcome: "act", write: null, renewal: false, reason: `lease próprio do ${self} ativo até ${lease.until}` };
  }

  // Ausente ou expirado.
  const what = read.kind === "absent" ? "lease ausente" : `lease do ${read.lease.host} expirado em ${read.lease.until}`;
  if (self === PRIMARY_HOST) {
    return { outcome: "act", write: fresh(), renewal: false, reason: `${what}; o 300 (dono padrão) assume` };
  }
  if (read.kind === "ok" && read.lease.host === self) {
    return {
      outcome: "act",
      write: fresh(),
      renewal: false,
      reason: `${what}; o Neo retoma o próprio lease (o 300, se tivesse voltado, já o teria sobrescrito)`,
    };
  }
  if (!downSignal || downSignal.kind === "error") {
    const why = downSignal ? `sinal de queda ilegível (${downSignal.error})` : "sinal de queda não consultado";
    return { outcome: "fail-closed", reason: `${what} e ${why}; fail-closed no Neo` };
  }
  if (downSignal.kind === "present") {
    return { outcome: "act", write: fresh(), renewal: false, reason: `${what} e sinal de queda do 300 presente (desde ${downSignal.since}); o Neo assume` };
  }
  return {
    outcome: "yield",
    cause: "no-down-signal",
    holder: null,
    reason: `${what} e sem sinal de queda do 300; o Neo só assume pelo neo-takeover --arm`,
  };
}

/** O que o gate precisa do KV (subconjunto de `KvOps`, fácil de fingir em teste). */
export interface LeaseKv {
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string) => Promise<void>;
}

export async function readLease(kv: Pick<LeaseKv, "get">): Promise<LeaseRead> {
  try {
    return parseLease(await kv.get(SCHEDULER_LEASE_KEY));
  } catch (e) {
    return { kind: "error", error: (e as Error).message };
  }
}

export type DownSignalRead = { kind: "present"; since: string } | { kind: "absent" } | { kind: "error"; error: string };

/** Lê `infra:300:down-since`. Qualquer valor não vazio conta como queda (o
 * formato exato é da #12981; o valor é só exibido). */
export async function readDownSignal(kv: Pick<LeaseKv, "get">): Promise<DownSignalRead> {
  try {
    const raw = await kv.get(DOWN_SIGNAL_KEY);
    if (raw === null || raw.trim() === "") return { kind: "absent" };
    return { kind: "present", since: raw.trim() };
  } catch (e) {
    return { kind: "error", error: (e as Error).message };
  }
}

export interface AcquireOptions {
  self: FailoverHost;
  by: string;
  now?: () => Date;
  ttlMs?: number;
  /** Memória local do último lease lido (F3/F2). Sem ela, o `300` é fail-open puro. */
  memory?: LeaseMemory;
}

export type AcquireResult =
  | { outcome: "act"; reason: string; /** Algo deu errado sem tirar a posse (renovação falhou, fail-open). */ warning: boolean }
  | { outcome: "yield"; cause: YieldCause; holder: SchedulerLease | null; reason: string }
  | { outcome: "fail-closed"; reason: string };

function remember(memory: LeaseMemory | undefined, read: LeaseRead, now: Date): void {
  if (!memory) return;
  try {
    if (read.kind === "absent") memory.save({ kind: "absent", seenAt: now.toISOString() });
    else if (read.kind === "ok") memory.save({ kind: "ok", lease: read.lease, seenAt: now.toISOString() });
  } catch {
    // Memória é rede de segurança; falha ao gravar não muda a decisão.
  }
}

function recall(memory: LeaseMemory | undefined): LastKnownLease | null {
  if (!memory) return null;
  try {
    return memory.load();
  } catch {
    return null;
  }
}

/**
 * Lê lease + sinal, decide, grava (se preciso) e relê para confirmar.
 * Nunca lança: toda falha vira decisão, com o fail-open/fail-closed por host.
 */
export async function acquireSchedulerLease(kv: LeaseKv, opts: AcquireOptions): Promise<AcquireResult> {
  const now = (opts.now ?? (() => new Date()))();
  const lastKnown = recall(opts.memory);
  const read = await readLease(kv);
  remember(opts.memory, read, now);

  // O sinal de queda só importa para o Neo; o 300 não gasta a leitura.
  let downSignal: DownSignalRead | undefined;
  if (opts.self === STANDBY_HOST && (read.kind === "ok" || read.kind === "absent")) {
    downSignal = await readDownSignal(kv);
  }
  const decision = decideLease({ self: opts.self, read, downSignal, lastKnown, now, by: opts.by, ttlMs: opts.ttlMs });

  if (decision.outcome === "yield") {
    const holder = decision.holder;
    if (
      opts.self === PRIMARY_HOST &&
      decision.cause === "other-host-active" &&
      holder?.host === STANDBY_HOST &&
      lastKnown?.kind === "ok" &&
      lastKnown.lease.host === STANDBY_HOST &&
      lastKnown.lease.until !== holder.until
    ) {
      return {
        outcome: "yield",
        cause: "other-host-renewing",
        holder,
        reason:
          `${decision.reason}. O lease do Neo foi renovado desde a leitura anterior (${lastKnown.lease.until} -> ${holder.until}) ` +
          `com o 300 de pé: 300 de pé cedendo para o Neo: rode \`npx tsx scripts/failover/neo-takeover.ts --disarm\` no Neo`,
      };
    }
    return decision;
  }
  if (decision.outcome === "fail-closed") return decision;
  if (!decision.write) return { outcome: "act", reason: decision.reason, warning: read.kind === "error" };

  const write = decision.write;
  const failed = (why: string): AcquireResult => {
    if (decision.renewal) {
      return { outcome: "act", reason: `${decision.reason}; AVISO: renovação falhou (${why}), age com a posse já confirmada`, warning: true };
    }
    return opts.self === PRIMARY_HOST
      ? { outcome: "act", reason: `${decision.reason}; ${why}, fail-open no 300`, warning: true }
      : { outcome: "fail-closed", reason: `${decision.reason}; ${why}, fail-closed no Neo` };
  };

  try {
    await kv.put(SCHEDULER_LEASE_KEY, serializeLease(write));
  } catch (e) {
    return failed(`gravação do lease falhou (${(e as Error).message})`);
  }

  // Read-back: sem CAS no KV, só age quem relê o próprio lease.
  const back = await readLease(kv);
  remember(opts.memory, back, now);
  if (back.kind === "ok" && back.lease.host === opts.self && back.lease.until === write.until) {
    return { outcome: "act", reason: decision.reason, warning: false };
  }
  if (back.kind === "ok" && back.lease.host !== opts.self && isLeaseActive(back.lease, now)) {
    return {
      outcome: "yield",
      cause: "other-host-active",
      holder: back.lease,
      reason: `${decision.reason}; mas a releitura mostra lease do ${back.lease.host} (outra máquina gravou por cima); ${opts.self} cede`,
    };
  }
  if (back.kind === "ok" && back.lease.host === opts.self) {
    // Mesmo host, `until` diferente: outra task desta máquina renovou junto. Posse confirmada.
    return { outcome: "act", reason: `${decision.reason} (releitura com renovação concorrente da mesma máquina)`, warning: false };
  }
  const why = back.kind === "error" || back.kind === "invalid" ? back.error : back.kind === "absent" ? "lease sumiu depois da gravação" : `lease do ${back.lease.host} expirado`;
  return failed(`releitura inconclusiva (${why})`);
}
