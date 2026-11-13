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
 *     lease do Neo expirar sem renovação.
 *   - Lease ativo próprio: age (e renova se passou da metade).
 *   - Lease ausente ou expirado:
 *       - `300`: age e grava o lease para si (dono padrão; retoma lease
 *         expirado do Neo).
 *       - Neo: só age se o sinal de queda `infra:300:down-since` (#12981)
 *         estiver presente. Sem o sinal, quem dá posse ao Neo é o
 *         `neo-takeover.ts --arm`, que grava o lease explicitamente.
 *
 * ## Falha de leitura do KV: assimétrica de propósito
 *
 *   - `300` (dono padrão) → fail-OPEN: age. O regime normal não pode passar
 *     a depender do KV estar de pé; o KV fora do ar com o Neo desarmado (o
 *     caso comum, de longe) pararia a publicação do dia inteira. O custo é a
 *     janela "KV fora + Neo armado ao mesmo tempo", coberta pela segunda
 *     camada (idempotência por canal).
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
 * diferentes; a regra acima reduz isso a um caso estreito (só acontece com o
 * sinal de queda presente e o `300` de pé ao mesmo tempo, ou seja, sinal
 * defasado) e a idempotência por canal é a rede abaixo. Um lock com CAS de
 * verdade existe no repo (D1, `scripts/lib/d1-locks.ts`, #12842); trocar o
 * backend fica para quando ele estiver provisionado.
 *
 * O relógio é o de cada máquina (`until` absoluto em ISO). Desvio de relógio
 * de minutos é irrelevante frente ao TTL de horas.
 */

/** Hosts que disputam o lease. `300` é o dono padrão (regime normal). */
export type FailoverHost = "300" | "neo";
export const PRIMARY_HOST: FailoverHost = "300";
export const STANDBY_HOST: FailoverHost = "neo";

/** Chave do lease no KV `diaria-ops-state`. */
export const SCHEDULER_LEASE_KEY = "infra:scheduler-owner";
/** Sinal de queda do `300`, gravado pelo vigia da #12981 (Worker cron). */
export const DOWN_SIGNAL_KEY = "infra:300:down-since";

/**
 * TTL do lease. 6 h: as tasks `critical` de hora em hora (catchups dos
 * Shorts, Shorts-Cortes, Onboarding-Watch-Returning) renovam bem antes, e o
 * Neo aguenta uma suspensão curta sem perder a posse. O custo é o outro lado:
 * se o Neo morrer armado (sem `--disarm`), o `300` só retoma quando o lease
 * expirar, em até 6 h.
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
  /** Valor ilegível ou falha de rede/HTTP/config: não dá para saber o dono. */
  | { kind: "error"; error: string };

function isHost(v: unknown): v is FailoverHost {
  return v === "300" || v === "neo";
}

/** Parse do valor cru do KV. `null` = chave inexistente. */
export function parseLease(raw: string | null): LeaseRead {
  if (raw === null) return { kind: "absent" };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: "error", error: `lease ilegível (não é JSON): ${raw.slice(0, 120)}` };
  }
  const o = json as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || !isHost(o.host) || typeof o.until !== "string" || Number.isNaN(Date.parse(o.until))) {
    return { kind: "error", error: `lease com formato inválido: ${raw.slice(0, 120)}` };
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

/** `yield` = ceder é o comportamento correto (lease de outro host, ou Neo sem
 * sinal de queda); `fail-closed` = o Neo não conseguiu confirmar a posse
 * (falha de KV) e por isso não age; o gate trata como erro visível. */
export type LeaseOutcome = "act" | "yield" | "fail-closed";

export interface LeaseDecision {
  /** A task pode rodar nesta máquina agora. */
  act: boolean;
  outcome: LeaseOutcome;
  /** Lease a gravar antes de agir (aquisição ou renovação); `null` = nada a gravar. */
  write: SchedulerLease | null;
  reason: string;
}

export interface DecideLeaseInput {
  self: FailoverHost;
  read: LeaseRead;
  /** O sinal `infra:300:down-since` existe (leitura bem-sucedida e não vazia). */
  downSignal: boolean;
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
    return self === PRIMARY_HOST
      ? { act: true, outcome: "act", write: null, reason: `fail-open no ${self}: lease ilegível (${read.error}); o 300 é o dono padrão` }
      : { act: false, outcome: "fail-closed", write: null, reason: `fail-closed no ${self}: lease ilegível (${read.error}); o Neo não age sem lease confirmado` };
  }

  if (read.kind === "ok" && isLeaseActive(read.lease, now)) {
    const lease = read.lease;
    if (lease.host !== self) {
      return { act: false, outcome: "yield", write: null, reason: `lease ativo do ${lease.host} até ${lease.until}; ${self} cede` };
    }
    const remaining = Date.parse(lease.until) - now.getTime();
    if (remaining < ttlMs / 2) {
      return { act: true, outcome: "act", write: fresh(), reason: `lease próprio do ${self} renovado (faltavam ${Math.round(remaining / 60000)} min)` };
    }
    return { act: true, outcome: "act", write: null, reason: `lease próprio do ${self} ativo até ${lease.until}` };
  }

  // Ausente ou expirado.
  const what = read.kind === "absent" ? "lease ausente" : `lease do ${read.lease.host} expirado em ${read.lease.until}`;
  if (self === PRIMARY_HOST) {
    return { act: true, outcome: "act", write: fresh(), reason: `${what}; o 300 (dono padrão) assume` };
  }
  if (downSignal) {
    return { act: true, outcome: "act", write: fresh(), reason: `${what} e sinal de queda do 300 presente; o Neo assume` };
  }
  return {
    act: false,
    outcome: "yield",
    write: null,
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
}

export interface AcquireResult {
  act: boolean;
  outcome: LeaseOutcome;
  reason: string;
}

/**
 * Lê lease + sinal, decide, grava (se preciso) e relê para confirmar.
 * Nunca lança: toda falha vira decisão, com o fail-open/fail-closed por host.
 */
export async function acquireSchedulerLease(kv: LeaseKv, opts: AcquireOptions): Promise<AcquireResult> {
  const now = (opts.now ?? (() => new Date()))();
  const read = await readLease(kv);
  // O sinal de queda só importa para o Neo; o 300 não gasta a leitura.
  let downSignal = false;
  if (opts.self === STANDBY_HOST && read.kind !== "error") {
    const sig = await readDownSignal(kv);
    downSignal = sig.kind === "present";
  }
  const decision = decideLease({ self: opts.self, read, downSignal, now, by: opts.by, ttlMs: opts.ttlMs });
  if (!decision.act || !decision.write) return { act: decision.act, outcome: decision.outcome, reason: decision.reason };

  try {
    await kv.put(SCHEDULER_LEASE_KEY, serializeLease(decision.write));
  } catch (e) {
    const msg = (e as Error).message;
    return opts.self === PRIMARY_HOST
      ? { act: true, outcome: "act", reason: `${decision.reason}; gravação do lease falhou (${msg}), fail-open no 300` }
      : { act: false, outcome: "fail-closed", reason: `${decision.reason}; gravação do lease falhou (${msg}), fail-closed no Neo` };
  }

  // Read-back: sem CAS no KV, só age quem relê o próprio lease.
  const back = await readLease(kv);
  if (back.kind === "ok" && back.lease.host === opts.self && back.lease.until === decision.write.until) {
    return { act: true, outcome: "act", reason: decision.reason };
  }
  if (back.kind === "ok" && back.lease.host !== opts.self && isLeaseActive(back.lease, now)) {
    return { act: false, outcome: "yield", reason: `${decision.reason}; mas a releitura mostra lease do ${back.lease.host} (outra máquina gravou por cima); ${opts.self} cede` };
  }
  if (back.kind === "ok" && back.lease.host === opts.self) {
    // Mesmo host, `until` diferente: outra task desta máquina renovou junto. Posse confirmada.
    return { act: true, outcome: "act", reason: `${decision.reason} (releitura com renovação concorrente da mesma máquina)` };
  }
  const why = back.kind === "error" ? back.error : "lease sumiu depois da gravação";
  return opts.self === PRIMARY_HOST
    ? { act: true, outcome: "act", reason: `${decision.reason}; releitura inconclusiva (${why}), fail-open no 300` }
    : { act: false, outcome: "fail-closed", reason: `${decision.reason}; releitura inconclusiva (${why}), fail-closed no Neo` };
}
