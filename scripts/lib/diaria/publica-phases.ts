/**
 * scripts/lib/diaria/publica-phases.ts (#12655)
 *
 * Telemetria e estado do fluxo híbrido do `/diaria-publica`
 * (`docs/publica-video-fluxo-hibrido.md`). Cada fase da sessão (fetch, plano,
 * capa, decisões, aprovação, upload, link, Etapa 5, teste/gate/Schedule da
 * Etapa 6, vertical por API e guiado) grava eventos `start`/`end`/`error`/
 * `interrupted` com edição, tentativa, sessão, task-id, parte/stage e o hash
 * do plano. O arquivo da edição (`_internal/publica-phases.jsonl`) é a fonte
 * do estado; o run-log recebe a mesma linha para a investigação de sempre.
 *
 * Este módulo é PURO (nenhum I/O): monta e valida eventos, deriva as tarefas,
 * decide se uma fase pode começar (dono único do Chrome, um escritor por
 * registro, vertical do thread principal fora das janelas das Etapas 5/6,
 * retry só depois da releitura do registro), confere a ordem "background
 * antes da pergunta bloqueante", o join (nenhuma fase concluída com tarefa
 * pendente) e monta o relatório por fase. Ausência de evento é
 * "indisponível" (`null`), nunca zero, e o caminho crítico é a UNIÃO dos
 * intervalos, não a soma de tarefas sobrepostas.
 *
 * O CLI é `scripts/publica-phase.ts`; o gate de efeito externo,
 * `publica-effect-gate.ts`.
 */

export const PUBLICA_PHASES_SCHEMA = "diaria-publica-phases/v1";
export const PUBLICA_PHASES_FILE = "_internal/publica-phases.jsonl";

export const PUBLICA_PHASES = [
  "preflight",
  "fetch",
  "plano",
  "capa",
  "decisoes",
  "aprovacao",
  "upload",
  "link",
  "stage5",
  "stage6-teste",
  "stage6-gate",
  "stage6-schedule",
  "vertical-api",
  "vertical-guiado",
] as const;
export type PublicaPhase = (typeof PUBLICA_PHASES)[number];

export const PUBLICA_PARTS = ["horizontal", "vertical", "sessao"] as const;
export type PublicaPart = (typeof PUBLICA_PARTS)[number];

/**
 * `spawned` anota a tarefa aberta com o PID do FILHO do `run` (o comando de
 * verdade); não abre nem fecha tarefa.
 */
export type PhaseEventKind = "start" | "end" | "error" | "interrupted" | "spawned";
export const PHASE_EVENT_KINDS: readonly PhaseEventKind[] = ["start", "end", "error", "interrupted", "spawned"];

/** `wait` = o tempo é do editor (pergunta aberta), não de execução. */
export type PhaseClock = "active" | "wait";

/**
 * `external` = a fase pode ter efeito fora da máquina (upload, publicação,
 * fila do Worker, agendamento). Só começa depois do gate de efeito
 * (`publica-effect-gate.ts`): nada disso antes da autorização.
 */
export type PhaseEffect = "reversible" | "external";

export interface PhaseMeta {
  clock: PhaseClock;
  effect: PhaseEffect;
  /** Stage do pipeline a que a fase pertence (5/6), ou `null` (parte de vídeo). */
  stage: 5 | 6 | null;
  /** Recursos que a fase segura enquanto roda (dono único). */
  resources: readonly string[];
}

/** Recurso de dono único: uma aba logada do editor, uma ação por vez. */
export const CHROME_RESOURCE = "chrome";

export const PHASE_META: Readonly<Record<PublicaPhase, PhaseMeta>> = {
  preflight: { clock: "active", effect: "reversible", stage: null, resources: [] },
  fetch: { clock: "active", effect: "reversible", stage: null, resources: [] },
  plano: { clock: "active", effect: "reversible", stage: null, resources: [] },
  capa: { clock: "active", effect: "reversible", stage: null, resources: [] },
  decisoes: { clock: "wait", effect: "reversible", stage: null, resources: [] },
  aprovacao: { clock: "wait", effect: "reversible", stage: null, resources: [] },
  upload: {
    clock: "active",
    effect: "external",
    stage: null,
    resources: ["registry:05-youtube-published", "registry:video-publish-authorizations"],
  },
  // `link-video-d1.ts --save` põe o 1º comentário do LinkedIn na fila do Worker e o vídeo no podcast;
  // a releitura do A4 grava no registro do upload.
  link: { clock: "active", effect: "external", stage: null, resources: ["registry:05-video-url", "registry:05-youtube-published"] },
  stage5: { clock: "active", effect: "external", stage: 5, resources: ["registry:06-social-published", "registry:05-published"] },
  "stage6-teste": { clock: "active", effect: "reversible", stage: 6, resources: [] },
  "stage6-gate": { clock: "wait", effect: "reversible", stage: 6, resources: [] },
  "stage6-schedule": { clock: "active", effect: "external", stage: 6, resources: ["registry:05-published"] },
  "vertical-api": {
    clock: "active",
    effect: "external",
    stage: null,
    resources: ["registry:06-shorts-published", "registry:video-publish-authorizations"],
  },
  "vertical-guiado": { clock: "active", effect: "external", stage: null, resources: [CHROME_RESOURCE, "registry:06-shorts-published"] },
};

/** Fases de preparo que contam como "background iniciado" antes da 1ª pergunta bloqueante. */
export const BACKGROUND_PREP_PHASES: ReadonlySet<PublicaPhase> = new Set<PublicaPhase>(["preflight", "fetch", "plano", "capa"]);

/** Fases de pergunta bloqueante (AskUserQuestion) do início da sessão. */
export const BLOCKING_QUESTION_PHASES: ReadonlySet<PublicaPhase> = new Set<PublicaPhase>(["decisoes", "aprovacao"]);

export interface PhaseEvent {
  schema: typeof PUBLICA_PHASES_SCHEMA;
  edition: string;
  phase: PublicaPhase;
  part: PublicaPart;
  /** Stage da fase (derivado de `PHASE_META`), repetido para o run-log ser filtrável. */
  stage: 5 | 6 | null;
  event: PhaseEventKind;
  at: string;
  attempt: number;
  /** `CLAUDE_CODE_SESSION_ID` de quem gravou; `null` = fora do Claude Code. */
  session_id: string | null;
  /** Id da tarefa (shell em background, task one-shot); `null` = thread principal. */
  task_id: string | null;
  /** `true` = processo em background (sem transcript de LLM); `false` = o thread principal da sessão. */
  background: boolean;
  plan_sha256: string | null;
  resources: string[];
  /** PID e máquina do processo (`run`), para saber se uma tarefa sem fim ainda vive. */
  pid?: number;
  /** PID do filho do `run` (evento `spawned`): o publisher pode sobreviver ao wrapper. */
  child_pid?: number;
  host?: string;
  exit_code?: number;
  detail?: string;
}

export interface BuildPhaseEventInput {
  edition: string;
  phase: string;
  part: string;
  event: PhaseEventKind;
  at: Date;
  attempt: number;
  sessionId?: string | null;
  taskId?: string | null;
  background?: boolean;
  planSha256?: string | null;
  extraResources?: readonly string[];
  pid?: number;
  childPid?: number;
  host?: string;
  exitCode?: number;
  detail?: string;
}

export function isPublicaPhase(v: string): v is PublicaPhase {
  return (PUBLICA_PHASES as readonly string[]).includes(v);
}

export function isPublicaPart(v: string): v is PublicaPart {
  return (PUBLICA_PARTS as readonly string[]).includes(v);
}

/** Pure: monta e valida um evento. Lança com mensagem acionável em entrada inválida. */
export function buildPhaseEvent(input: BuildPhaseEventInput): PhaseEvent {
  if (!/^\d{6}$/.test(input.edition)) throw new Error(`edição inválida: ${JSON.stringify(input.edition)} (AAMMDD)`);
  if (!isPublicaPhase(input.phase)) throw new Error(`fase desconhecida: ${input.phase} (válidas: ${PUBLICA_PHASES.join(", ")})`);
  if (!isPublicaPart(input.part)) throw new Error(`parte desconhecida: ${input.part} (válidas: ${PUBLICA_PARTS.join(", ")})`);
  if (!Number.isInteger(input.attempt) || input.attempt < 1) throw new Error(`tentativa inválida: ${input.attempt}`);
  if (Number.isNaN(input.at.getTime())) throw new Error("instante inválido");
  if (input.planSha256 != null && !/^[0-9a-f]{64}$/.test(input.planSha256)) {
    throw new Error(`plan_sha256 inválido: ${input.planSha256} (64 hex)`);
  }
  const meta = PHASE_META[input.phase];
  const resources = [...new Set([...meta.resources, ...(input.extraResources ?? [])])].sort();
  return {
    schema: PUBLICA_PHASES_SCHEMA,
    edition: input.edition,
    phase: input.phase,
    part: input.part,
    stage: meta.stage,
    event: input.event,
    at: input.at.toISOString(),
    attempt: input.attempt,
    session_id: input.sessionId ?? null,
    task_id: input.taskId ?? null,
    background: input.background ?? false,
    plan_sha256: input.planSha256 ?? null,
    resources,
    ...(input.pid !== undefined ? { pid: input.pid } : {}),
    ...(input.childPid !== undefined ? { child_pid: input.childPid } : {}),
    ...(input.host !== undefined ? { host: input.host } : {}),
    ...(input.exitCode !== undefined ? { exit_code: input.exitCode } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  };
}

/** Pure: o que está errado num objeto lido do JSONL (`null` = evento válido). */
function phaseEventDefect(obj: unknown): string | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "não é objeto";
  const o = obj as Record<string, unknown>;
  if (o.schema !== PUBLICA_PHASES_SCHEMA) return `schema ${JSON.stringify(o.schema)} (esperado ${PUBLICA_PHASES_SCHEMA})`;
  if (typeof o.phase !== "string" || !isPublicaPhase(o.phase)) return `fase ${JSON.stringify(o.phase)}`;
  if (typeof o.part !== "string" || !isPublicaPart(o.part)) return `parte ${JSON.stringify(o.part)}`;
  if (typeof o.event !== "string" || !(PHASE_EVENT_KINDS as readonly string[]).includes(o.event)) return `evento ${JSON.stringify(o.event)}`;
  if (typeof o.at !== "string" || !Number.isFinite(Date.parse(o.at))) return `instante ${JSON.stringify(o.at)}`;
  if (typeof o.attempt !== "number" || !Number.isInteger(o.attempt) || o.attempt < 1) return `tentativa ${JSON.stringify(o.attempt)}`;
  if (!Array.isArray(o.resources) || !o.resources.every((r) => typeof r === "string")) return "resources não é lista de texto";
  if (o.task_id !== null && o.task_id !== undefined && typeof o.task_id !== "string") return "task_id inválido";
  if (o.session_id !== null && o.session_id !== undefined && typeof o.session_id !== "string") return "session_id inválido";
  if (typeof o.background !== "boolean") return "background não é booleano";
  if (o.stage !== null && o.stage !== 5 && o.stage !== 6) return `stage ${JSON.stringify(o.stage)}`;
  return null;
}

/** Pure: parseia o JSONL; linha ilegível ou fora do schema vira `problems` (nunca some em silêncio). */
export function parsePhaseEvents(raw: string): { events: PhaseEvent[]; problems: string[] } {
  const events: PhaseEvent[] = [];
  const problems: string[] = [];
  raw.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      problems.push(`linha ${i + 1}: JSON inválido (${(e as Error).message})`);
      return;
    }
    const defect = phaseEventDefect(obj);
    if (defect) {
      problems.push(`linha ${i + 1}: evento fora do schema ${PUBLICA_PHASES_SCHEMA} (${defect})`);
      return;
    }
    const e = obj as PhaseEvent;
    events.push({ ...e, task_id: e.task_id ?? null, session_id: e.session_id ?? null });
  });
  return { events, problems };
}

export type TaskStatus = "running" | "done" | "error" | "interrupted" | "orphaned";

/**
 * Por que uma tarefa virou `orphaned` (#12883): `pid-dead` = nesta máquina, o
 * wrapper e o filho morreram; `cross-host-stale` = o `run` é de OUTRA máquina
 * (o PID não pode ser conferido daqui) e nenhum evento dele chegou há mais de
 * `CROSS_HOST_STALE_MS`.
 */
export type OrphanReason = "pid-dead" | "cross-host-stale";

/**
 * Prazo para uma tarefa do `run` aberta em outra máquina deixar de segurar
 * recurso e join (#12883). Daqui não dá para conferir o PID de lá (nem há
 * canal entre as máquinas além do `data/` sincronizado), então o critério é a
 * idade do último evento da tarefa (`start` ou `spawned`). 3 h é o dobro do
 * teto mais longo que um publisher filho tem hoje (75 min no timer de cortes,
 * #11985) somado à folga de sincronização do Drive: uma tarefa viva em outra
 * máquina não expira no meio do trabalho. Expirada, ela vira `orphaned` e o
 * retry segue exigindo a releitura do registro (#11741), como qualquer órfã.
 */
export const CROSS_HOST_STALE_MS = 3 * 60 * 60 * 1000;

/**
 * Fases cujo `run` de outra máquina NUNCA expira pelo relógio (#12966). O
 * upload do YouTube não tem timeout (`youtube-upload.ts`) e o `run` não grava
 * heartbeat, então o prazo de 3 h acima não prova que ele morreu: um upload
 * longo (rede lenta, vídeo grande, Drive da outra máquina sem sincronizar o
 * `end`) virava órfão, liberava `registry:05-youtube-published` e abria a porta
 * para um 2º vídeo. Uma tarefa dessas só sai com o fim gravado por lá, ou
 * fechada à mão (`closeTaskCommand`) por quem confirmou que a sessão caiu.
 */
export const NO_CROSS_HOST_EXPIRY_PHASES: ReadonlySet<PublicaPhase> = new Set<PublicaPhase>(["upload"]);

export interface PhaseTask {
  key: string;
  phase: PublicaPhase;
  part: PublicaPart;
  stage: 5 | 6 | null;
  attempt: number;
  task_id: string | null;
  session_id: string | null;
  background: boolean;
  plan_sha256: string | null;
  resources: string[];
  start: string;
  end: string | null;
  status: TaskStatus;
  pid?: number;
  child_pid?: number;
  host?: string;
  exit_code?: number;
  detail?: string;
  /** Instante do último evento da tarefa (`start` ou `spawned`; o fim, quando houver). */
  last_event_at: string;
  /** Só em `orphaned`: por que a tarefa foi dada por perdida. */
  orphan_reason?: OrphanReason;
}

export function taskKey(e: Pick<PhaseEvent, "phase" | "part" | "attempt" | "task_id">): string {
  return `${e.phase}|${e.part}|${e.attempt}|${e.task_id ?? "main"}`;
}

export interface DeriveOptions {
  /** Confere se o PID de uma tarefa sem fim ainda vive nesta máquina. Ausente = tarefa sem fim conta como `running`. */
  isPidAlive?: (pid: number) => boolean;
  host?: string;
  /**
   * Agora (ms). Com ele e `host`, tarefa do `run` de outra máquina sem evento
   * há mais de `crossHostStaleMs` vira `orphaned` (`cross-host-stale`, #12883).
   * Ausente = tarefa de outra máquina nunca expira (conta como `running`).
   */
  now?: number;
  /** Prazo da expiração entre máquinas; default `CROSS_HOST_STALE_MS`. */
  crossHostStaleMs?: number;
}

/**
 * Pure: eventos → tarefas. Um `start` abre a tarefa; `end`/`error`/
 * `interrupted` com a mesma chave fecha; `spawned` só anota o PID do filho.
 * Fim sem início é ignorado (não dá para inventar o início). Tarefa sem fim
 * cujo PID nesta máquina já morreu (o do wrapper E, quando gravado, o do
 * filho) vira `orphaned`: a interrupção não deixou rastro, e o retry exige a
 * releitura do registro como qualquer outra interrupção. Tarefa do `run` de
 * OUTRA máquina (o PID de lá não se confere daqui) vira órfã quando o último
 * evento dela passou de `crossHostStaleMs` (#12883); antes disso segue
 * `running`. Tarefa aberta por `start` manual (sem PID) nunca vira órfã: o
 * fim é gravado à mão (`publica-phase.ts interrupted`).
 */
export function deriveTasks(events: readonly PhaseEvent[], opts: DeriveOptions = {}): PhaseTask[] {
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const open = new Map<string, PhaseTask>();
  const tasks: PhaseTask[] = [];
  for (const e of sorted) {
    const key = taskKey(e);
    if (e.event === "start") {
      const t: PhaseTask = {
        key,
        phase: e.phase,
        part: e.part,
        stage: e.stage,
        attempt: e.attempt,
        task_id: e.task_id,
        session_id: e.session_id,
        background: e.background,
        plan_sha256: e.plan_sha256,
        resources: e.resources,
        start: e.at,
        end: null,
        status: "running",
        last_event_at: e.at,
        ...(e.pid !== undefined ? { pid: e.pid } : {}),
        ...(e.host !== undefined ? { host: e.host } : {}),
      };
      open.set(key, t);
      tasks.push(t);
      continue;
    }
    const t = open.get(key);
    if (!t) continue;
    t.last_event_at = e.at;
    if (e.event === "spawned") {
      if (e.child_pid !== undefined) t.child_pid = e.child_pid;
      continue;
    }
    t.end = e.at;
    t.status = e.event === "end" ? "done" : e.event === "error" ? "error" : "interrupted";
    if (e.exit_code !== undefined) t.exit_code = e.exit_code;
    if (e.detail !== undefined) t.detail = e.detail;
    if (e.plan_sha256 && !t.plan_sha256) t.plan_sha256 = e.plan_sha256;
    open.delete(key);
  }
  const staleMs = opts.crossHostStaleMs ?? CROSS_HOST_STALE_MS;
  for (const t of tasks) {
    if (t.status !== "running" || t.pid === undefined) continue;
    if (t.host !== undefined && opts.host !== undefined && t.host !== opts.host) {
      if (opts.now !== undefined && !NO_CROSS_HOST_EXPIRY_PHASES.has(t.phase) && isCrossHostStale(t, opts.now, staleMs)) {
        t.status = "orphaned";
        t.orphan_reason = "cross-host-stale";
      }
      continue;
    }
    if (!opts.isPidAlive) continue;
    const childAlive = t.child_pid !== undefined && opts.isPidAlive(t.child_pid);
    if (!opts.isPidAlive(t.pid) && !childAlive) {
      t.status = "orphaned";
      t.orphan_reason = "pid-dead";
    }
  }
  return tasks;
}

/** Pure: a tarefa de outra máquina está sem evento há mais de `staleMs`? Instante ilegível conta como velho. */
function isCrossHostStale(t: Pick<PhaseTask, "last_event_at">, now: number, staleMs: number): boolean {
  const last = Date.parse(t.last_event_at);
  if (!Number.isFinite(last)) return true;
  return now - last > staleMs;
}

/** Pure: texto curto de como a tarefa de outra máquina está (para as mensagens de recusa). */
export function crossHostNote(t: Pick<PhaseTask, "host" | "last_event_at" | "phase">, opts: DeriveOptions): string {
  if (t.host === undefined || opts.host === undefined || t.host === opts.host) return "";
  if (NO_CROSS_HOST_EXPIRY_PHASES.has(t.phase)) {
    return ` Iniciada em outra máquina (${t.host}): o PID não se confere daqui e ${t.phase} não expira pelo relógio (#12966) — só sai com o fim gravado lá, ou feche à mão depois de confirmar que a sessão de lá caiu e nada subiu.`;
  }
  const staleMs = opts.crossHostStaleMs ?? CROSS_HOST_STALE_MS;
  const last = Date.parse(t.last_event_at);
  const expires = Number.isFinite(last) ? new Date(last + staleMs).toISOString() : "já";
  return ` Iniciada em outra máquina (${t.host}): o PID não se confere daqui; expira sozinha em ${expires} (sem evento por ${Math.round(staleMs / 60_000)} min), ou feche antes se a sessão de lá caiu.`;
}

/** Próxima tentativa de uma fase/parte (1 + quantas já começaram). */
export function nextAttempt(events: readonly PhaseEvent[], phase: PublicaPhase, part: PublicaPart): number {
  return events.filter((e) => e.event === "start" && e.phase === phase && e.part === part).length + 1;
}

/** Releitura do registro gravada (`video-publish-registry-status.ts --record`). */
export interface RegistryCheckLike {
  at: string;
  since: string;
  verdict: string;
}

export interface StartCheckInput {
  events: readonly PhaseEvent[];
  candidate: PhaseEvent;
  deriveOptions?: DeriveOptions;
  /** Releituras do registro (store de autorizações), para o retry de fase externa. */
  registryChecks?: readonly RegistryCheckLike[];
  /** Declaração de limitação: preparo serial sem worker (a 1ª pergunta não exige background). */
  serialReason?: string | null;
  /**
   * Retomada de um upload JÁ registrado (#12883): o `05-youtube-published.json`
   * tem o vídeo desta edição e o comando não cria outro (sem `--force`), então
   * só refaz podcast/legenda/playlists. O CLI confere o registro antes de
   * passar `true`; aqui ela dispensa só a regra 3 (retry com releitura do
   * registro), porque o vídeo registrado já é o resultado da releitura. Só vale
   * para `upload/horizontal`.
   */
  resumeExisting?: boolean;
}

/** Fase/parte em que a retomada de upload registrado (`--resume-existing`) vale (#12883). */
export function canResumeExisting(phase: PublicaPhase, part: PublicaPart): boolean {
  return phase === "upload" && part === "horizontal";
}

/** Comando que fecha à mão uma tarefa aberta que perdeu o processo (`start` manual nunca vira órfã). */
export function closeTaskCommand(t: Pick<PhaseTask, "phase" | "part" | "attempt" | "task_id">, edition = "{AAMMDD}"): string {
  return `npx tsx scripts/publica-phase.ts interrupted ${edition} --phase ${t.phase} --part ${t.part} --attempt ${t.attempt}${t.task_id ? ` --task-id ${t.task_id}` : ""}`;
}

/**
 * Instante a partir do qual uma releitura do registro cobre a tentativa
 * anterior (regra 3 de `checkPhaseStart`). Com fim gravado, é o fim. Órfã não
 * tem fim (#12966): o `start` deixava valer uma releitura feita ENQUANTO a
 * tentativa ainda rodava, que não vê o que ela subiu depois. A de outra
 * máquina conta a partir da expiração (último evento + prazo); a desta
 * máquina, do último evento dela (o `spawned`, quando houver).
 */
export function retryCutoffMs(t: Pick<PhaseTask, "start" | "end" | "status" | "orphan_reason" | "last_event_at">, opts: DeriveOptions = {}): number {
  if (t.end) return Date.parse(t.end);
  if (t.status !== "orphaned") return Date.parse(t.start);
  const last = Date.parse(t.last_event_at);
  const base = Number.isFinite(last) ? Math.max(last, Date.parse(t.start)) : Date.parse(t.start);
  if (t.orphan_reason === "cross-host-stale") return base + (opts.crossHostStaleMs ?? CROSS_HOST_STALE_MS);
  return base;
}

/** Fases externas cujo retry exige a releitura do registro (o publisher pode ter enviado sem registro). */
export const REGISTRY_RETRY_PHASES: ReadonlySet<PublicaPhase> = new Set<PublicaPhase>(["upload", "vertical-api", "vertical-guiado"]);

/**
 * Pure: a fase `candidate` pode começar? Lista vazia = sim; senão, os motivos.
 *
 * 1. Dono único: nenhuma tarefa `running` segura um recurso que ela também
 *    segura (Chrome; um escritor por registro).
 * 2. Isolamento de custo, nos dois sentidos: fase da parte de vídeo no
 *    THREAD PRINCIPAL (`background: false`) não começa enquanto a Etapa 5 ou
 *    6 roda, e fase da Etapa 5/6 não começa enquanto uma fase do vídeo do
 *    thread principal está aberta — os tokens do vídeo cairiam na janela do
 *    stage (`capture-stage-usage.ts`). A parte de vídeo roda nesse intervalo
 *    só como processo em background.
 * 3. Retry de fase externa (upload, vertical) depois de erro, interrupção ou
 *    tarefa órfã exige uma releitura do registro POSTERIOR ao fim da
 *    tentativa anterior (#11741), com veredito legível. A retomada de um
 *    upload já registrado (`resumeExisting`, #12883) não passa por esta
 *    regra: ela não cria vídeo.
 * 4. A 1ª pergunta bloqueante da sessão só começa depois de alguma fase de
 *    preparo em background ter começado, ou com a limitação declarada.
 */
export function checkPhaseStart(input: StartCheckInput): string[] {
  const { candidate } = input;
  if (candidate.event !== "start") return [`evento ${candidate.event} não é início de fase`];
  const tasks = deriveTasks(input.events, input.deriveOptions);
  const problems: string[] = [];
  const running = tasks.filter((t) => t.status === "running");

  for (const t of running) {
    const shared = t.resources.filter((r) => candidate.resources.includes(r));
    if (shared.length) {
      problems.push(
        `recurso ocupado: ${shared.join(", ")} está com ${t.phase}/${t.part} (tentativa ${t.attempt}, desde ${t.start}${t.task_id ? `, task ${t.task_id}` : ""}) — um dono por vez. ` +
          `Se essa fase morreu sem gravar o fim, confira o registro e feche-a: ${closeTaskCommand(t, candidate.edition)}` +
          crossHostNote(t, input.deriveOptions ?? {}),
      );
    }
  }

  if (!candidate.background && candidate.stage === null && candidate.part !== "sessao") {
    const stageRunning = running.find((t) => t.stage !== null);
    if (stageRunning) {
      problems.push(
        `isolamento de custo: ${candidate.phase}/${candidate.part} no thread principal com a Etapa ${stageRunning.stage} rodando (${stageRunning.phase} desde ${stageRunning.start}) — rode em background ou depois do fim da etapa`,
      );
    }
  }

  if (candidate.stage !== null) {
    const videoMain = running.find((t) => t.stage === null && t.part !== "sessao" && !t.background);
    if (videoMain) {
      problems.push(
        `isolamento de custo: Etapa ${candidate.stage} (${candidate.phase}) com ${videoMain.phase}/${videoMain.part} aberta no thread principal (desde ${videoMain.start}) — ` +
          `grave o fim dela antes (end, ou ${closeTaskCommand(videoMain, candidate.edition)})`,
      );
    }
  }

  if (input.resumeExisting && !canResumeExisting(candidate.phase, candidate.part)) {
    problems.push(`retomada de upload registrado só vale para upload/horizontal, não para ${candidate.phase}/${candidate.part}`);
  }

  if (REGISTRY_RETRY_PHASES.has(candidate.phase) && !(input.resumeExisting && canResumeExisting(candidate.phase, candidate.part))) {
    const previous = tasks
      .filter((t) => t.phase === candidate.phase && t.part === candidate.part && (t.status === "error" || t.status === "interrupted" || t.status === "orphaned"))
      .sort((a, b) => retryCutoffMs(a, input.deriveOptions) - retryCutoffMs(b, input.deriveOptions));
    const last = previous[previous.length - 1];
    if (last) {
      const cutoff = retryCutoffMs(last, input.deriveOptions);
      const covering = (input.registryChecks ?? []).filter((c) => {
        const at = Date.parse(c.at);
        const since = Date.parse(c.since);
        return Number.isFinite(at) && Number.isFinite(since) && at >= cutoff && since <= Date.parse(last.start);
      });
      if (!covering.length) {
        problems.push(
          `retry de ${candidate.phase}/${candidate.part}: a tentativa ${last.attempt} terminou ${last.status} — antes de tentar de novo, invalide e releia o registro ` +
            `(video-publish-authorize.ts invalidate e video-publish-registry-status.ts --since ${last.start} --record)`,
        );
      } else if (covering.every((c) => c.verdict === "unreadable")) {
        problems.push(`retry de ${candidate.phase}/${candidate.part}: a releitura do registro saiu unreadable — confira o canal e as contas antes`);
      }
    }
  }

  if (BLOCKING_QUESTION_PHASES.has(candidate.phase)) {
    const sameSession = (e: PhaseEvent) => !candidate.session_id || e.session_id === candidate.session_id;
    const earlierQuestion = input.events.some((e) => e.event === "start" && BLOCKING_QUESTION_PHASES.has(e.phase) && sameSession(e));
    if (!earlierQuestion) {
      const prep = input.events.some((e) => e.event === "start" && e.background && BACKGROUND_PREP_PHASES.has(e.phase) && sameSession(e));
      if (!prep && !(input.serialReason ?? "").trim()) {
        problems.push(
          "1ª pergunta bloqueante sem preparo em background: inicie fetch/plano/capa com run_in_background antes do AskUserQuestion, " +
            "ou declare a limitação com --serial-reason",
        );
      }
    }
  }
  return problems;
}

export interface JoinResult {
  ok: boolean;
  pending: PhaseTask[];
  problems: string[];
  /** Parte de vídeo ainda pendente mesmo com as Etapas 5/6 concluídas. */
  partsPending: PublicaPart[];
}

/**
 * Pure: o join do fim da sessão. Nenhuma fase é dada por concluída com
 * tarefa pendente: `running` (inclusive em background) segura o join.
 * Órfã segura também, salvo quando uma tentativa POSTERIOR da mesma
 * fase/parte terminou `done` (o retry já passou pela releitura do registro).
 * Sentinel da Etapa 5/6 presente com a fase da etapa ainda rodando é sentinel
 * antecipado.
 */
export function joinCheck(
  events: readonly PhaseEvent[],
  sentinels: { step5: boolean; step6: boolean },
  opts: DeriveOptions = {},
): JoinResult {
  const tasks = deriveTasks(events, opts);
  const pending = tasks.filter((t) => t.status === "running");
  const problems: string[] = pending.map(
    (t) =>
      `pendente: ${t.phase}/${t.part} (tentativa ${t.attempt}${t.task_id ? `, task ${t.task_id}` : ""}, desde ${t.start}) — ` +
      `espere o fim ou, se o processo morreu, feche: ${closeTaskCommand(t)}` +
      crossHostNote(t, opts),
  );
  const supersededByDone = (t: PhaseTask) =>
    tasks.some((x) => x.phase === t.phase && x.part === t.part && x.status === "done" && Date.parse(x.start) > Date.parse(t.start));
  for (const t of tasks.filter((x) => x.status === "orphaned" && !supersededByDone(x))) {
    const why =
      t.orphan_reason === "cross-host-stale"
        ? `iniciada em outra máquina (${t.host}), sem evento desde ${t.last_event_at} e sem evento de fim`
        : `PID ${t.pid}${t.child_pid !== undefined ? ` e filho ${t.child_pid}` : ""} não vivem mais, sem evento de fim`;
    problems.push(`órfã: ${t.phase}/${t.part} (${why}) — releia o registro antes de qualquer retry; para fechar: ${closeTaskCommand(t)}`);
  }
  const stageRunning = (stage: 5 | 6) => pending.some((t) => t.stage === stage);
  if (sentinels.step5 && stageRunning(5)) problems.push("sentinel .step-5-done.json presente com a Etapa 5 ainda rodando (sentinel antecipado)");
  if (sentinels.step6 && stageRunning(6)) problems.push("sentinel .step-6-done.json presente com a Etapa 6 ainda rodando (sentinel antecipado)");
  const partsPending = [...new Set(pending.filter((t) => t.stage === null).map((t) => t.part))];
  return { ok: problems.length === 0, pending, problems, partsPending };
}

export interface Interval {
  start: number;
  end: number;
}

/** Pure: soma da UNIÃO dos intervalos (sobreposição conta uma vez). */
export function unionDurationMs(intervals: readonly Interval[]): number {
  const sorted = intervals.filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end >= i.start).sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = NaN;
  let curEnd = NaN;
  for (const i of sorted) {
    if (Number.isNaN(curStart)) {
      curStart = i.start;
      curEnd = i.end;
    } else if (i.start <= curEnd) {
      curEnd = Math.max(curEnd, i.end);
    } else {
      total += curEnd - curStart;
      curStart = i.start;
      curEnd = i.end;
    }
  }
  if (!Number.isNaN(curStart)) total += curEnd - curStart;
  return total;
}

export interface PhaseReportRow {
  phase: PublicaPhase;
  part: PublicaPart;
  attempts: number;
  /** Duração somada das tentativas COMPLETAS; `null` = indisponível (sem par início/fim). */
  duration_ms: number | null;
  clock: PhaseClock;
  statuses: TaskStatus[];
  plan_sha256: string[];
}

export interface PhaseReport {
  edition: string;
  rows: PhaseReportRow[];
  /** Fases sem nenhum par início/fim: indisponíveis, não zero. */
  unavailable: PublicaPhase[];
  /** União de todos os intervalos completos (caminho crítico observado); `null` sem nenhum. */
  critical_path_ms: number | null;
  /** União dos intervalos de execução (`active`) e de espera do editor (`wait`), separados. */
  active_ms: number | null;
  wait_ms: number | null;
  /** Soma ingênua (com sobreposição): mostrada só para contraste com a união. */
  naive_sum_ms: number | null;
  pending: string[];
}

/** Pure: relatório por fase. Nada é inventado: sem evento de fim, a duração é `null`. */
export function phaseReport(edition: string, events: readonly PhaseEvent[], opts: DeriveOptions = {}): PhaseReport {
  const tasks = deriveTasks(events.filter((e) => e.edition === edition), opts);
  const byKey = new Map<string, PhaseTask[]>();
  for (const t of tasks) {
    const k = `${t.phase}|${t.part}`;
    byKey.set(k, [...(byKey.get(k) ?? []), t]);
  }
  const complete = (t: PhaseTask) => t.end !== null && Number.isFinite(Date.parse(t.end)) && Number.isFinite(Date.parse(t.start));
  const interval = (t: PhaseTask): Interval => ({ start: Date.parse(t.start), end: Date.parse(t.end as string) });
  const rows: PhaseReportRow[] = [];
  for (const [k, ts] of byKey) {
    const [phase, part] = k.split("|") as [PublicaPhase, PublicaPart];
    const done = ts.filter(complete);
    rows.push({
      phase,
      part,
      attempts: ts.length,
      duration_ms: done.length ? done.reduce((s, t) => s + (Date.parse(t.end as string) - Date.parse(t.start)), 0) : null,
      clock: PHASE_META[phase].clock,
      statuses: ts.map((t) => t.status),
      plan_sha256: [...new Set(ts.map((t) => t.plan_sha256).filter((h): h is string => !!h))],
    });
  }
  rows.sort((a, b) => PUBLICA_PHASES.indexOf(a.phase) - PUBLICA_PHASES.indexOf(b.phase) || a.part.localeCompare(b.part));
  const seen = new Set(rows.filter((r) => r.duration_ms !== null).map((r) => r.phase));
  const done = tasks.filter(complete);
  const union = (ts: PhaseTask[]) => (ts.length ? unionDurationMs(ts.map(interval)) : null);
  return {
    edition,
    rows,
    unavailable: PUBLICA_PHASES.filter((p) => !seen.has(p)),
    critical_path_ms: union(done),
    active_ms: union(done.filter((t) => PHASE_META[t.phase].clock === "active")),
    wait_ms: union(done.filter((t) => PHASE_META[t.phase].clock === "wait")),
    naive_sum_ms: done.length ? done.reduce((s, t) => s + (Date.parse(t.end as string) - Date.parse(t.start)), 0) : null,
    pending: tasks.filter((t) => t.status === "running").map((t) => `${t.phase}/${t.part}`),
  };
}

/**
 * Pure: intervalos do THREAD PRINCIPAL da sessão `sessionId` gastos com a
 * parte de vídeo (fase sem stage, `background: false`). `capture-stage-usage`
 * tira esses intervalos da janela das Etapas 5/6, para o custo do vídeo não
 * cair no stage. Tarefa ainda aberta (o fim nunca foi gravado) vai só até o
 * próximo `start` do thread principal da mesma sessão (o thread passou a
 * outra fase, por exemplo a própria Etapa 5); sem nenhum depois dela, até
 * `openUntil` (fim da janela). `open: true` marca o intervalo estimado.
 */
export function videoPartMainThreadIntervals(
  events: readonly PhaseEvent[],
  sessionId: string | null,
  openUntil: number,
): Array<Interval & { phase: PublicaPhase; part: PublicaPart; open: boolean }> {
  const tasks = deriveTasks(events);
  const mainStarts = events
    .filter((e) => e.event === "start" && !e.background)
    .map((e) => ({ at: Date.parse(e.at), session: e.session_id, key: taskKey(e) }))
    .filter((s) => Number.isFinite(s.at));
  return tasks
    .filter((t) => t.stage === null && t.part !== "sessao" && !t.background && (sessionId === null || t.session_id === sessionId))
    .map((t) => {
      const start = Date.parse(t.start);
      if (t.end) return { phase: t.phase, part: t.part, start, end: Date.parse(t.end), open: false };
      const next = mainStarts
        .filter((s) => s.session === t.session_id && s.at > start && s.key !== t.key)
        .reduce((min, s) => Math.min(min, s.at), Infinity);
      return { phase: t.phase, part: t.part, start, end: Math.min(openUntil, next), open: true };
    })
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end >= i.start);
}
