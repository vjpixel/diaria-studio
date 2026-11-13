/**
 * scripts/lib/failover/neo-readiness.ts (#12983)
 *
 * Prontidão do Neo para assumir o `300` (contingência do #12982): lógica PURA.
 * O I/O (ler `.env`, Doppler, `gh`, `git`, `data/`, APIs das redes, KV) fica em
 * `scripts/failover/neo-readiness.ts`; aqui só entram valores já lidos.
 *
 * Para cada task `failover: "critical"` do registro sai uma linha
 * `pronto` / `falta X`. Uma task fica pronta quando:
 *   - os scripts dos passos existem no checkout;
 *   - o arquivo do `guard` (quando a task tem) existe em `data/`;
 *   - os segredos que ela usa estão presentes no ambiente local (`.env` +
 *     ambiente) e, quando o Doppler respondeu, também no vault;
 *   - os tokens das redes que ela usa responderam válidos (ou não puderam ser
 *     verificados, o que vira aviso e não falta);
 *   - as checagens comuns a todas (Node, `node_modules`, `gh`, checkout,
 *     `data/`, credenciais do KV do lease) passaram.
 *
 * Nunca guarda nem devolve VALOR de segredo: os resultados carregam só nomes
 * de variáveis e estados.
 *
 * O resultado vai para o KV `diaria-ops-state` na chave `infra:neo-readiness`
 * (`--record`), que o alarme do `300` lê (`neo-readiness-alarm.ts`).
 */

import type { ScheduledTaskDefinition } from "../scheduled-tasks.ts";

/** Chave do registro no KV `diaria-ops-state` (mesmo namespace do lease). */
export const NEO_READINESS_KV_KEY = "infra:neo-readiness";
export const NEO_READINESS_SCHEMA = 1;

/** `data/` sem nenhuma escrita há mais que isto: o Drive provavelmente parou. */
export const DATA_FRESHNESS_MAX_MS = 72 * 60 * 60 * 1000;

export type CheckStatus = "ok" | "fail" | "unverified";

export interface CheckResult {
  /** Identificador estável (ex.: `node`, `secret:KIT_API_KEY`, `token:threads`). */
  id: string;
  status: CheckStatus;
  /** Texto curto para humano. Nunca contém valor de segredo. */
  detail: string;
}

export type TokenId = "threads" | "linkedin" | "instagram";

/**
 * Segredos e tokens que cada script de task `critical` usa. Não há no repo um
 * mapa de variáveis por script; este foi derivado à mão do que cada script (e
 * as libs que ele chama para o canal) lê, em 13/11/2026. A varredura
 * automática do fecho de imports (medida no mesmo dia) traz ~100 variáveis por
 * script, quase todas de módulos importados por tabela: inútil como critério.
 *
 * Cada item de `secrets` é uma lista de nomes alternativos (o primeiro é o
 * preferido): basta um deles presente.
 *
 * Script novo numa task `critical` sem entrada aqui sai como `unverified`
 * (`secrets:sem-mapa`), nunca como pronto calado; o teste trava que toda task
 * `critical` atual tem entrada.
 */
export const CRITICAL_SCRIPT_REQUIREMENTS: Readonly<Record<string, { secrets: readonly (readonly string[])[]; tokens: readonly TokenId[] }>> = {
  // Os 4 timers dos Shorts publicam por `publish-shorts.ts`, que sobe o
  // vertical no R2 (`r2-object-upload.ts`, `R2_ENV_VARS`) e baixa do Drive.
  "scripts/shorts-instagram-timer.ts": {
    secrets: [["INSTAGRAM_ACCESS_TOKEN"], ["INSTAGRAM_BUSINESS_ACCOUNT_ID"], ...r2()],
    tokens: ["instagram"],
  },
  "scripts/shorts-linkedin-profile-timer.ts": {
    secrets: [["LINKEDIN_PERSONAL_ACCESS_TOKEN"], ["LINKEDIN_PERSONAL_PERSON_URN"], ...r2()],
    tokens: ["linkedin"],
  },
  "scripts/shorts-threads-profile-timer.ts": {
    secrets: [["THREADS_PERSONAL_ACCESS_TOKEN"], ["THREADS_PERSONAL_USER_ID"], ...r2()],
    tokens: ["threads"],
  },
  "scripts/shorts-corte-timer.ts": {
    // Cortes saem nos mesmos destinos de API do vertical.
    secrets: [
      ["INSTAGRAM_ACCESS_TOKEN"],
      ["INSTAGRAM_BUSINESS_ACCOUNT_ID"],
      ["LINKEDIN_PERSONAL_ACCESS_TOKEN"],
      ["LINKEDIN_PERSONAL_PERSON_URN"],
      ["THREADS_PERSONAL_ACCESS_TOKEN"],
      ["THREADS_PERSONAL_USER_ID"],
      ...r2(),
    ],
    tokens: ["instagram", "linkedin", "threads"],
  },
  // YouTube (estado do horizontal) + Worker do LinkedIn (plano nos posts do D1).
  "scripts/video-d1-link-watch.ts": {
    secrets: [["GOOGLE_CLIENT_ID"], ["GOOGLE_CLIENT_SECRET"], ["YOUTUBE_REFRESH_TOKEN"], ["DIARIA_LINKEDIN_CRON_URL"], ["DIARIA_LINKEDIN_CRON_TOKEN"]],
    tokens: [],
  },
  // Post no Circle pelo webhook n8n da Stack + e-mail pelo Kit (#12538).
  "scripts/publish-circle-stack-scheduled.ts": {
    secrets: [["STACK_WEBHOOK_URL"], ["STACK_WEBHOOK_KEY"], ["KIT_API_KEY"]],
    tokens: [],
  },
  // `clarice-novos-run.ts` confere as três antes de rodar (lista do próprio script).
  "scripts/clarice-novos-run.ts": {
    secrets: [["STRIPE_API_KEY"], ["BREVO_CLARICE_API_KEY"], ["MILLION_VERIFIER_API_KEY"]],
    tokens: [],
  },
  "scripts/clarice-envio-run.ts": { secrets: [["BREVO_CLARICE_API_KEY"], ["MILLION_VERIFIER_API_KEY"]], tokens: [] },
  "scripts/clarice-envio-guard.ts": { secrets: [["BREVO_CLARICE_API_KEY"]], tokens: [] },
  "scripts/onboarding-watch-returning.ts": { secrets: [["KIT_API_KEY"]], tokens: [] },
  "scripts/onboarding-welcome-run.ts": { secrets: [["KIT_API_KEY"], ["BREVO_DIARIA_API_KEY"]], tokens: [] },
  "scripts/onboarding-kit-transport-run.ts": { secrets: [["KIT_API_KEY"]], tokens: [] },
  "scripts/onboarding-followup-run.ts": { secrets: [["KIT_API_KEY"]], tokens: [] },
};

function r2(): (readonly string[])[] {
  // Mesma lista de `R2_ENV_VARS` (`scripts/lib/r2-object-upload.ts`), sem importar
  // o módulo de upload só por ela (o teste confere que as duas não divergem).
  return [["R2_ACCOUNT_ID"], ["R2_ACCESS_KEY_ID"], ["R2_SECRET_ACCESS_KEY"], ["R2_BUCKET", "SHORTS_R2_BUCKET"], ["R2_PUBLIC_BASE", "SHORTS_R2_PUBLIC_BASE"]];
}

/** Segredos que TODA task `critical` precisa: o lease no KV (`resolveOpsStateKvConfig`). */
export const LEASE_SECRETS: readonly (readonly string[])[] = [["CLOUDFLARE_ACCOUNT_ID"], ["CLOUDFLARE_WORKERS_TOKEN", "CLOUDFLARE_API_TOKEN"]];

// ── Checagens individuais (puras) ─────────────────────────────────────────

/**
 * Presença de um segredo (com nomes alternativos). `dopplerNames = null`:
 * Doppler não consultado, decide só pelo local. Presente só no Doppler = falta
 * (o `.env` do Neo atrasou: `npm run sync-env`). Presente só no local = ok, com
 * aviso no detalhe (o vault não tem; o próximo `sync-env` aborta por chave
 * só-local, #5155).
 */
export function evaluateSecret(names: readonly string[], localEnv: Record<string, string | undefined>, dopplerNames: ReadonlySet<string> | null): CheckResult {
  const id = `secret:${names[0]}`;
  const label = names.length > 1 ? `${names[0]} (ou ${names.slice(1).join(", ")})` : names[0];
  const local = names.find((n) => (localEnv[n] ?? "").trim() !== "");
  const inVault = dopplerNames ? names.find((n) => dopplerNames.has(n)) : undefined;
  if (local) {
    if (dopplerNames && !inVault) return { id, status: "ok", detail: `${label}: no .env, mas ausente do Doppler` };
    return { id, status: "ok", detail: `${label}: presente` };
  }
  if (inVault) return { id, status: "fail", detail: `${label}: só no Doppler, .env atrasado (npm run sync-env)` };
  return { id, status: "fail", detail: `${label}: ausente${dopplerNames ? " (nem no Doppler)" : ""}` };
}

/** Versão do Node contra o `.nvmrc` (major) e o mínimo do projeto. */
export function evaluateNodeVersion(version: string, nvmrc: string | null, minOk: boolean): CheckResult {
  const m = /^v?(\d+)\./.exec(version);
  const major = m ? Number(m[1]) : NaN;
  const want = nvmrc ? Number(/^v?(\d+)/.exec(nvmrc.trim())?.[1] ?? NaN) : NaN;
  if (!minOk) return { id: "node", status: "fail", detail: `Node ${version} abaixo do mínimo do projeto` };
  if (Number.isNaN(want)) return { id: "node", status: "ok", detail: `Node ${version} (.nvmrc ilegível ou ausente)` };
  if (major !== want) return { id: "node", status: "fail", detail: `Node ${version}, .nvmrc pede ${want}` };
  return { id: "node", status: "ok", detail: `Node ${version}` };
}

interface LockEntry {
  version?: string;
  optional?: boolean;
  peer?: boolean;
  dev?: boolean;
}

/**
 * `node_modules` contra o `package-lock.json`: compara as versões do lockfile
 * com o lockfile oculto que o npm grava ao instalar (`node_modules/.package-lock.json`).
 * Pacote `optional` ausente não conta (dependência de outra plataforma).
 */
export function evaluateNodeModules(lock: unknown, hidden: unknown | null): CheckResult {
  const lockPkgs = (lock as { packages?: Record<string, LockEntry> } | null)?.packages;
  if (!lockPkgs || typeof lockPkgs !== "object") return { id: "node_modules", status: "unverified", detail: "package-lock.json ilegível" };
  if (hidden === null) return { id: "node_modules", status: "fail", detail: "node_modules ausente ou sem .package-lock.json (rode npm ci)" };
  const hiddenPkgs = (hidden as { packages?: Record<string, LockEntry> } | null)?.packages;
  if (!hiddenPkgs || typeof hiddenPkgs !== "object") return { id: "node_modules", status: "fail", detail: "node_modules/.package-lock.json ilegível (rode npm ci)" };
  const missing: string[] = [];
  const differ: string[] = [];
  for (const [key, entry] of Object.entries(lockPkgs)) {
    if (!key.startsWith("node_modules/")) continue;
    const got = hiddenPkgs[key];
    if (!got) {
      if (!entry.optional && !entry.peer) missing.push(key.slice("node_modules/".length));
      continue;
    }
    if (entry.version && got.version !== entry.version) differ.push(key.slice("node_modules/".length));
  }
  if (missing.length || differ.length) {
    const parts = [
      missing.length ? `${missing.length} pacote(s) faltando (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", ..." : ""})` : "",
      differ.length ? `${differ.length} com versão diferente (${differ.slice(0, 3).join(", ")}${differ.length > 3 ? ", ..." : ""})` : "",
    ].filter(Boolean);
    return { id: "node_modules", status: "fail", detail: `node_modules não bate com o lockfile: ${parts.join("; ")} (rode npm ci)` };
  }
  return { id: "node_modules", status: "ok", detail: "node_modules bate com o lockfile" };
}

export interface GitState {
  /** `null` = não deu para ler. */
  branch: string | null;
  /** Commits do `origin/master` local que faltam no HEAD; `null` = não deu para ler. */
  behind: number | null;
  /** Arquivos rastreados com mudança local (não conta untracked). */
  dirtyTracked: number | null;
  isAgentWorktree: boolean;
}

/** Checkout principal, em `master` e não atrás do `origin/master` (último fetch). */
export function evaluateGit(s: GitState): CheckResult {
  if (s.isAgentWorktree) return { id: "git", status: "fail", detail: "rodando de um worktree de agente: as tarefas do Neo usam o checkout principal" };
  if (s.branch === null) return { id: "git", status: "unverified", detail: "branch não lida" };
  if (s.branch !== "master") return { id: "git", status: "fail", detail: `checkout em ${s.branch}, não em master` };
  if (s.behind === null) return { id: "git", status: "unverified", detail: "em master; distância do origin/master não lida" };
  if (s.behind > 0) return { id: "git", status: "fail", detail: `master ${s.behind} commit(s) atrás do origin/master (git pull --ff-only)` };
  const dirty = s.dirtyTracked && s.dirtyTracked > 0 ? `, ${s.dirtyTracked} arquivo(s) com mudança local` : "";
  return { id: "git", status: "ok", detail: `master em dia com o origin/master (último fetch)${dirty}` };
}

export interface DataDirState {
  accessible: boolean;
  error?: string;
  /** mtime mais recente da varredura rasa de `data/`; `null` = nada lido. */
  newestMtimeMs: number | null;
}

/** `data/` acessível e com escrita recente (o Drive está sincronizando). */
export function evaluateDataDir(s: DataDirState, now: Date, maxAgeMs: number = DATA_FRESHNESS_MAX_MS): CheckResult {
  if (!s.accessible) return { id: "data", status: "fail", detail: `data/ inacessível${s.error ? ` (${s.error})` : ""}: Drive montado?` };
  if (s.newestMtimeMs === null) return { id: "data", status: "fail", detail: "data/ vazio ou ilegível" };
  const ageMs = now.getTime() - s.newestMtimeMs;
  const ageH = Math.round(ageMs / 3_600_000);
  if (ageMs > maxAgeMs) return { id: "data", status: "fail", detail: `data/ sem escrita há ${ageH} h: Drive parado?` };
  return { id: "data", status: "ok", detail: `data/ acessível, última escrita há ${ageH} h` };
}

/** `gh auth status`: só o exit code; a saída (que cita o token mascarado) nunca é repassada. */
export function evaluateGhAuth(exitCode: number | null, spawnError?: string): CheckResult {
  if (spawnError) return { id: "gh", status: "fail", detail: `gh indisponível (${spawnError})` };
  if (exitCode === 0) return { id: "gh", status: "ok", detail: "gh autenticado" };
  return { id: "gh", status: "fail", detail: "gh não autenticado (gh auth login)" };
}

/** Resultado da checagem de um token pela API, já reduzido. */
export type TokenProbe = { state: "valid" } | { state: "invalid"; reason: string } | { state: "unknown"; reason: string } | { state: "no-helper"; reason: string } | { state: "skipped"; reason: string };

export function evaluateToken(token: TokenId, probe: TokenProbe): CheckResult {
  const id = `token:${token}`;
  switch (probe.state) {
    case "valid":
      return { id, status: "ok", detail: `token ${token} válido` };
    case "invalid":
      return { id, status: "fail", detail: `token ${token} inválido: ${probe.reason}` };
    default:
      return { id, status: "unverified", detail: `token ${token} não verificado: ${probe.reason}` };
  }
}

/** Erro de leitura do Threads (`listThreadsProfilePosts` lança com `HTTP nnn`): 400/401/403 = token ruim. */
export function classifyThreadsReadError(message: string): TokenProbe {
  const m = /HTTP (\d{3})/.exec(message);
  if (m && ["400", "401", "403"].includes(m[1])) return { state: "invalid", reason: `leitura do perfil HTTP ${m[1]}` };
  if (/OAuthException|"code":\s*190/.test(message)) return { state: "invalid", reason: "OAuthException" };
  return { state: "unknown", reason: message.slice(0, 160) };
}

// ── Agregação ─────────────────────────────────────────────────────────────

export interface TaskReadiness {
  name: string;
  ready: boolean;
  /** O que falta (detalhes das checagens `fail`). */
  missing: string[];
  /** O que não deu para verificar (não impede `ready`). */
  unverified: string[];
}

export interface ReadinessReport {
  schema: number;
  checkedAt: string;
  /** Hostname da máquina que rodou. */
  machineId: string;
  /** Todas as tasks prontas. */
  ok: boolean;
  tasks: TaskReadiness[];
  /** Checagens comuns e por recurso, com estado e detalhe (sem valores). */
  checks: CheckResult[];
}

export interface AggregateInput {
  tasks: readonly Pick<ScheduledTaskDefinition, "name" | "steps" | "guard" | "enabled">[];
  /** Checagens que valem para toda task (node, node_modules, gh, git, data, segredos do lease). */
  common: readonly CheckResult[];
  /** Checagem por id (`script:...`, `guard:...`, `secret:...`, `token:...`). */
  byId: ReadonlyMap<string, CheckResult>;
  now: Date;
  machineId: string;
}

/** Ids das checagens específicas de uma task. */
export function taskCheckIds(task: Pick<ScheduledTaskDefinition, "steps" | "guard">): string[] {
  const ids: string[] = [];
  const add = (id: string) => {
    if (!ids.includes(id)) ids.push(id);
  };
  for (const step of task.steps) {
    add(`script:${step.script}`);
    const req = CRITICAL_SCRIPT_REQUIREMENTS[step.script];
    if (!req) {
      add(`secrets:sem-mapa:${step.script}`);
      continue;
    }
    for (const names of req.secrets) add(`secret:${names[0]}`);
    for (const t of req.tokens) add(`token:${t}`);
  }
  if (task.guard) add(`guard:${task.guard.requiredFile}`);
  return ids;
}

/**
 * Junta tudo numa linha por task. Checagem esperada que não veio em `byId`
 * (o coletor não rodou, ou caiu) entra como não verificada, nunca como ok.
 * Task `enabled: false` sai pronta sem checagem (não roda nem no `300`).
 */
export function aggregateReadiness(input: AggregateInput): ReadinessReport {
  const tasks: TaskReadiness[] = [];
  for (const task of input.tasks) {
    if (task.enabled === false) {
      tasks.push({ name: task.name, ready: true, missing: [], unverified: ["task desabilitada no registro"] });
      continue;
    }
    const results: CheckResult[] = [...input.common];
    for (const id of taskCheckIds(task)) {
      if (id.startsWith("secrets:sem-mapa:")) {
        results.push({ id, status: "unverified", detail: `segredos de ${id.slice("secrets:sem-mapa:".length)} sem mapa em CRITICAL_SCRIPT_REQUIREMENTS` });
        continue;
      }
      results.push(input.byId.get(id) ?? { id, status: "unverified", detail: `${id}: não checado` });
    }
    const missing = results.filter((r) => r.status === "fail").map((r) => r.detail);
    const unverified = results.filter((r) => r.status === "unverified").map((r) => r.detail);
    tasks.push({ name: task.name, ready: missing.length === 0, missing, unverified });
  }
  const seen = new Set<string>();
  const checks: CheckResult[] = [];
  for (const c of [...input.common, ...input.byId.values()]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    checks.push(c);
  }
  return {
    schema: NEO_READINESS_SCHEMA,
    checkedAt: input.now.toISOString(),
    machineId: input.machineId,
    ok: tasks.every((t) => t.ready),
    tasks,
    checks,
  };
}

// ── Saída ─────────────────────────────────────────────────────────────────

/** Uma linha por task: `pronto` / `falta X`. */
export function formatTaskLines(report: ReadinessReport): string[] {
  return report.tasks.map((t) => {
    if (!t.ready) return `${t.name}: falta ${t.missing.join("; ")}`;
    return t.unverified.length ? `${t.name}: pronto (não verificado: ${t.unverified.join("; ")})` : `${t.name}: pronto`;
  });
}

/** Resumo de uma linha (Passo 0 de `/diaria-edicao`). */
export function formatSummaryLine(report: ReadinessReport): string {
  const ready = report.tasks.filter((t) => t.ready).length;
  const total = report.tasks.length;
  if (report.ok) {
    const unv = new Set(report.tasks.flatMap((t) => t.unverified)).size;
    return `prontidão do Neo: ${ready}/${total} tasks critical prontas${unv ? ` (${unv} item(ns) não verificado(s))` : ""}`;
  }
  const missing = [...new Set(report.tasks.flatMap((t) => t.missing))];
  return `prontidão do Neo: ${ready}/${total} prontas; falta: ${missing.slice(0, 4).join("; ")}${missing.length > 4 ? `; +${missing.length - 4}` : ""}`;
}

// ── Registro no KV ────────────────────────────────────────────────────────

export function serializeReadinessRecord(report: ReadinessReport): string {
  return JSON.stringify(report);
}

export type ReadinessRecordRead =
  | { kind: "absent" }
  | { kind: "ok"; report: ReadinessReport }
  /** O KV respondeu, mas o valor não é um registro (JSON inválido ou formato errado). */
  | { kind: "invalid"; error: string }
  /** Falha de rede/HTTP/config: não dá para saber. */
  | { kind: "error"; error: string };

/** Parse do valor cru do KV. `null` = chave inexistente. */
export function parseReadinessRecord(raw: string | null): ReadinessRecordRead {
  if (raw === null) return { kind: "absent" };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: "invalid", error: "registro ilegível (não é JSON)" };
  }
  const o = json as Partial<ReadinessReport> | null;
  if (!o || typeof o !== "object" || typeof o.checkedAt !== "string" || Number.isNaN(Date.parse(o.checkedAt)) || typeof o.ok !== "boolean" || !Array.isArray(o.tasks)) {
    return { kind: "invalid", error: "registro com formato inválido" };
  }
  const tasks: TaskReadiness[] = o.tasks
    .filter((t): t is TaskReadiness => !!t && typeof (t as TaskReadiness).name === "string")
    .map((t) => ({
      name: t.name,
      ready: t.ready === true,
      missing: Array.isArray(t.missing) ? t.missing.filter((x) => typeof x === "string") : [],
      unverified: Array.isArray(t.unverified) ? t.unverified.filter((x) => typeof x === "string") : [],
    }));
  return {
    kind: "ok",
    report: {
      schema: typeof o.schema === "number" ? o.schema : NEO_READINESS_SCHEMA,
      checkedAt: o.checkedAt,
      machineId: typeof o.machineId === "string" ? o.machineId : "",
      ok: o.ok,
      tasks,
      checks: Array.isArray(o.checks) ? (o.checks as CheckResult[]) : [],
    },
  };
}
