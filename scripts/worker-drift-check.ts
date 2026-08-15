#!/usr/bin/env node
/**
 * scripts/worker-drift-check.ts (#4723)
 *
 * Compara, para cada Worker do repo (`workers/*`), o timestamp do último
 * deploy publicado na Cloudflare contra o timestamp do último commit local
 * que tocou `workers/{nome}/**`. Se o commit for mais recente que o deploy
 * (ou o worker nunca foi deployado mas já tem código commitado), alarma o
 * editor por e-mail — nomeando o(s) worker(s) defasado(s), há quanto tempo,
 * e o comando de deploy pra rodar.
 *
 * Contexto: o Worker `reativar` ficou 4 dias em produção com código
 * defasado (commit mergeado em master, `wrangler deploy` nunca rodado) sem
 * nenhum sinal automático — só percebido porque o editor estranhou um
 * cadastro anômalo (#4723).
 *
 * ─── Descoberta de workers (sem lista hardcoded) ───────────────────────────
 *
 * Varre `workers/*​/wrangler.toml` (fallback `wrangler.jsonc`) e extrai o
 * campo `name` de cada um — a lista de workers e o nome publicado na
 * Cloudflare vêm SEMPRE do disco, nunca de uma lista mantida à mão aqui (um
 * worker novo entra automaticamente na próxima execução, sem precisar tocar
 * este arquivo). Ver `scripts/lib/worker-drift-check.ts` pros parsers puros
 * (`parseWranglerTomlName`/`parseWranglerJsoncName`).
 *
 * ─── Por que Cloudflare REST API em vez de `wrangler deployments list` ─────
 *
 * Ver o header de `scripts/lib/worker-drift-check.ts` — mesmo racional já
 * registrado em `check-cloudflare-token.ts` (REST > shell-out ao CLI: sem
 * dependência do CLI instalado no PATH, sem side-effects de login
 * interativo, testável com mock de fetch). Usa
 * `GET /accounts/{account_id}/workers/scripts` (endpoint "List Workers" —
 * NÃO `.../scripts/{name}`, que na API da Cloudflare devolve o CONTEÚDO do
 * script, não metadata JSON; ver docstring de `fetchAllWorkerScriptsMetadata`
 * abaixo). Campo `modified_on` de cada item = timestamp da última
 * atualização do script, equivalente a "último deploy" — só `wrangler
 * deploy` atualiza um Worker Script. UMA chamada pra a conta inteira, não N
 * chamadas por worker.
 *
 * Uso:
 *   npx tsx scripts/worker-drift-check.ts               # avalia + persiste + alarma se NOVO drift
 *   npx tsx scripts/worker-drift-check.ts --dry-run      # avalia + imprime, NÃO persiste nem alarma
 *   npx tsx scripts/worker-drift-check.ts --to email@x   # override do destinatário do alarme
 *
 * Env: `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_WORKERS_TOKEN` (mesmo par usado
 * por `cursos-error-alarm.ts`/`postmaster-spam-sync.ts` — token precisa de
 * permissão de LEITURA em Workers Scripts). Requer `data/.credentials.json`
 * com o scope `gmail.send` pro alarme (mesmo requisito dos scripts irmãos).
 * Diferente de `check-brevo-diaria-guardrail.ts` — aqui o estado de
 * idempotência EXISTE só pra gatear o e-mail (não tem valor operacional
 * independente), então uma falha no ENVIO propaga (sem try/catch, mesmo
 * padrão de `apoios-diff-alarm.ts`) e aborta ANTES de persistir o cursor —
 * a próxima execução da task tenta alarmar de novo, em vez de marcar
 * silenciosamente esse drift como "já avisado" sem o editor ter recebido
 * nada.
 *
 * Fail-soft: se a consulta à Cloudflare API falhar (credencial ausente, API
 * indisponível), TODOS os workers entram no relatório como `status: "error"`
 * (é 1 chamada pra conta inteira, não N chamadas por worker — ver
 * `fetchAllWorkerScriptsMetadata`) — não quebra o script, cada worker segue
 * listado individualmente no log/e-mail em vez de um crash sem diagnóstico
 * (#4723 item 3).
 *
 * Estado (idempotência): `data/worker-drift-check/state.json`.
 *
 * Como o resto dos alarmes locais deste repo (#4320/#4382/#4490/#4534), o
 * `wrangler deploy` real e a 1ª execução ao vivo desta checagem nunca
 * rodaram nesta unidade (worktree isolado, sem `CLOUDFLARE_ACCOUNT_ID`/
 * `CLOUDFLARE_WORKERS_TOKEN` nem Gmail credentials ao vivo) — validado só via
 * testes com a lógica pura + parsing determinístico (sem fetch/git real).
 */
import { existsSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import {
  parseWranglerTomlName,
  parseWranglerJsoncName,
  evaluateAllWorkerDrift,
  hasPendingDrift,
  computeDriftFingerprint,
  shouldAlarm,
  shouldAdvanceState,
  advanceState,
  advanceApiErrorState,
  shouldAlarmApiError,
  emptyWorkerDriftAlarmState,
  buildWorkerDriftAlarmEmail,
  buildApiErrorAlarmEmail,
  workerDriftFindingKey,
  type WorkerDriftCheckInput,
  type WorkerDriftResult,
  type WorkerDriftAlarmState,
} from "./lib/worker-drift-check.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  type AlarmFinding,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKERS_DIR = resolve(ROOT, "workers");
const STATE_PATH = resolve(ROOT, "data", "worker-drift-check", "state.json");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "worker-drift-check", "alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[worker-drift-check]";
/** #5339: mesmo valor de CLOSE_ALARM_ISSUE_AFTER_RUNS de beehiiv-home-meta-check.ts
 * (task roda a cada 6h — 2 execuções limpas consecutivas = 12h sem o achado
 * antes de fechar a issue automaticamente). */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

// ─── Estado (idempotência) — mesmo padrão I/O de apoios-diff-alarm.ts ──────

export function loadState(statePath: string = STATE_PATH): WorkerDriftAlarmState {
  if (!existsSync(statePath)) return emptyWorkerDriftAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<WorkerDriftAlarmState>;
    const fingerprint =
      typeof raw.lastAlarmedFingerprint === "string" || raw.lastAlarmedFingerprint === null
        ? raw.lastAlarmedFingerprint
        : null;
    const checkedAt = typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null ? raw.lastCheckedAt : null;
    // #4746: campos novos — fail-soft pra state.json legado (pré-#4746) sem
    // esses campos, mesmo padrão dos 2 campos originais acima.
    const firstApiErrorAt =
      typeof raw.firstApiErrorAt === "string" || raw.firstApiErrorAt === null ? raw.firstApiErrorAt : null;
    const lastApiErrorAlarmedAt =
      typeof raw.lastApiErrorAlarmedAt === "string" || raw.lastApiErrorAlarmedAt === null
        ? raw.lastApiErrorAlarmedAt
        : null;
    return {
      lastAlarmedFingerprint: fingerprint ?? null,
      lastCheckedAt: checkedAt ?? null,
      firstApiErrorAt: firstApiErrorAt ?? null,
      lastApiErrorAlarmedAt: lastApiErrorAlarmedAt ?? null,
    };
  } catch {
    return emptyWorkerDriftAlarmState();
  }
}

export function saveState(state: WorkerDriftAlarmState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

// ─── Estado (dedup/reconciliação de ISSUE por achado, #5339) ──────────────
// Arquivo separado de STATE_PATH de propósito — mesmo racional de
// beehiiv-home-meta-check.ts: idempotência do E-MAIL (acima) e tracking de
// ISSUE por achado são preocupações independentes.

export function loadAlarmIssuesState(statePath: string = ALARM_ISSUES_STATE_PATH): AlarmIssuesState {
  if (!existsSync(statePath)) return emptyAlarmIssuesState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AlarmIssuesState;
    return emptyAlarmIssuesState();
  } catch {
    return emptyAlarmIssuesState();
  }
}

export function saveAlarmIssuesState(state: AlarmIssuesState, statePath: string = ALARM_ISSUES_STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

/** Converte um `WorkerDriftResult` defasado (status "drift"/"never_deployed")
 * no `AlarmFinding` genérico que `scripts/lib/alarm-issues.ts` consome
 * (#5339). `check` = nome do worker (cada worker é seu próprio eixo — não
 * há como 2 workers colidirem no mesmo achado). `fingerprint` usa
 * `workerDriftFindingKey`, a MESMA fórmula usada pra montar `issueRefs` em
 * `buildWorkerDriftAlarmEmail`. Todo achado nasce `P2` — mesma prioridade
 * da issue original #5337 (bug com workaround: deploy manual). */
function toAlarmFinding(r: WorkerDriftResult): AlarmFinding {
  return {
    check: r.workerName,
    fingerprint: workerDriftFindingKey(r),
    title: `[diar.ia.br] worker "${r.workerName}" com deploy defasado`,
    body: [
      "Achado automático do alarme `Diaria-Worker-Drift-Check`",
      "(`scripts/worker-drift-check.ts`).",
      "",
      `Worker: \`${r.workerName}\` (workers/${r.workerDir}/)`,
      `Detalhe: ${r.message}`,
      `Último commit: ${r.lastCommitAt ?? "-"}`,
      `Último deploy: ${r.lastDeployedAt ?? "nunca"}`,
      "",
      `Deploy: cd workers/${r.workerDir} && npx wrangler deploy`,
      "",
      "Esta issue é criada automaticamente pelo alarme (#5339) e será",
      "comentada/fechada sozinha quando o achado deixar de reproduzir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
  };
}

// ─── Descoberta de workers (I/O) ────────────────────────────────────────────

export interface DiscoveredWorker {
  /** Nome do diretório sob workers/ (ex: "reativar", "brevo-dashboard"). */
  workerDir: string;
  /** `name` extraído do wrangler.toml/.jsonc — pode diferir de `workerDir` (ex: "artigos" -> "diaria-artigos"). */
  workerName: string;
}

/**
 * Varre `workers/*​/wrangler.toml` (fallback `.jsonc`) e retorna a lista de
 * workers descobertos com seu nome publicado. Workers cujo config não tem um
 * `name` reconhecível são pulados com um aviso (nunca quebram os demais).
 */
export function discoverWorkers(workersDir: string = WORKERS_DIR): DiscoveredWorker[] {
  if (!existsSync(workersDir)) return [];
  const entries = readdirSync(workersDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const discovered: DiscoveredWorker[] = [];

  for (const entry of entries) {
    const dir = entry.name;
    const tomlPath = join(workersDir, dir, "wrangler.toml");
    const jsoncPath = join(workersDir, dir, "wrangler.jsonc");

    let name: string | null = null;
    if (existsSync(tomlPath)) {
      name = parseWranglerTomlName(readFileSync(tomlPath, "utf8"));
    } else if (existsSync(jsoncPath)) {
      name = parseWranglerJsoncName(readFileSync(jsoncPath, "utf8"));
    }

    if (name) {
      discovered.push({ workerDir: dir, workerName: name });
    } else {
      console.error(`${LOG_PREFIX} aviso: ${dir}/ não tem wrangler.toml/.jsonc com um "name" reconhecível — pulado.`);
    }
  }

  return discovered;
}

// ─── Git: timestamp do último commit por worker (I/O) ──────────────────────

/**
 * `git log -1 --format=%aI -- workers/{dir}` — `%aI` é a data do autor em
 * ISO 8601 estrito (com offset), a mesma disciplina de timestamp usada em
 * outros comparadores de tempo do repo (ver docstring de `sentDate` em
 * `brevo-client.ts`). Retorna `null` se não há nenhum commit tocando esse
 * path (não deveria acontecer na prática — o diretório existe versionado —
 * mas tratado como edge case, não uma exceção).
 */
export function getLastCommitAt(workerDir: string, root: string = ROOT): string | null {
  const res = spawnSync("git", ["log", "-1", "--format=%aI", "--", join("workers", workerDir)], {
    encoding: "utf8",
    cwd: root,
    timeout: 30_000,
  });
  if (res.status !== 0) return null;
  const out = res.stdout.trim();
  return out || null;
}

// ─── Cloudflare API: timestamp do último deploy por worker (I/O) ───────────

interface WorkerScriptListItem {
  id?: string;
  modified_on?: string;
}
interface WorkerScriptListResponse {
  success: boolean;
  result?: WorkerScriptListItem[];
  errors?: Array<{ code: number; message: string }>;
}

export interface WorkerScriptsMetadataResult {
  /** `id` (nome do script) -> `modified_on`, ou `null` se a chamada falhou (ver `error`). */
  metadata: Map<string, string> | null;
  error: string | null;
}

/**
 * Consulta `GET /accounts/{accountId}/workers/scripts` (endpoint "List
 * Workers", estável há anos — usado aqui em vez de `GET .../scripts/{name}`,
 * que na API da Cloudflare devolve o CONTEÚDO do script (JS/multipart), não
 * metadata JSON; usar o endpoint singular teria feito `res.json()` lançar
 * pra praticamente todo worker, tratando drift real como "erro de consulta"
 * — achado do self-review deste PR, corrigido antes de abrir). UMA chamada
 * pra a conta inteira (não N chamadas por worker) — mais barato e evita
 * qualquer risco de rate limit entre workers.
 *
 * Retorna `metadata: null` (com `error` preenchido) se a chamada falhar —
 * fail-soft: o caller aplica o MESMO erro a todos os workers dessa execução
 * (nenhum crash, mas sem dado nenhum confiável nesta rodada — mais simples
 * e mais seguro que tentar decidir por worker qual falhou e qual não).
 */
export async function fetchAllWorkerScriptsMetadata(
  accountId: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<WorkerScriptsMetadataResult> {
  try {
    const res = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { metadata: null, error: `Cloudflare API retornou ${res.status}: ${text.slice(0, 300)}` };
    }

    const json = (await res.json()) as WorkerScriptListResponse;
    if (!json.success) {
      const msg = json.errors?.map((e) => e.message).join("; ") || "resposta success:false sem detalhe";
      return { metadata: null, error: `Cloudflare API: ${msg}` };
    }

    const metadata = new Map<string, string>();
    for (const item of json.result ?? []) {
      if (item.id && item.modified_on) metadata.set(item.id, item.modified_on);
    }
    return { metadata, error: null };
  } catch (e) {
    return { metadata: null, error: (e as Error).message };
  }
}

/**
 * Pura — resolve o `lastDeployedAt` de UM worker a partir do mapa já
 * carregado por `fetchAllWorkerScriptsMetadata`. Worker ausente do mapa
 * (nunca publicado) resolve pra `null` sem erro — mesma semântica de "nunca
 * deployado" que um 404 teria no desenho anterior (per-worker).
 */
export function resolveLastDeployedAt(workerName: string, metadata: Map<string, string>): string | null {
  return metadata.get(workerName) ?? null;
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const workersToken = process.env.CLOUDFLARE_WORKERS_TOKEN ?? "";
  if (!accountId || !workersToken) {
    console.error(
      `${LOG_PREFIX} ERRO: CLOUDFLARE_ACCOUNT_ID e/ou CLOUDFLARE_WORKERS_TOKEN não definidos — não é possível ` +
        "consultar deploys publicados. Configure ambos e rode de novo.",
    );
    process.exit(2);
  }

  const workers = discoverWorkers();
  console.log(`${LOG_PREFIX} ${workers.length} worker(s) descoberto(s) em workers/*/wrangler.toml.`);

  // 1 chamada pra conta inteira (não N chamadas por worker) — ver docstring
  // de `fetchAllWorkerScriptsMetadata`. Se falhar, TODOS os workers desta
  // rodada recebem o MESMO `deployError` — fail-soft (nenhum worker crasha o
  // resto), mas sem dado confiável nesta execução específica.
  const { metadata, error: metadataError } = await fetchAllWorkerScriptsMetadata(accountId, workersToken);

  const inputs: WorkerDriftCheckInput[] = workers.map((w) => ({
    workerName: w.workerName,
    workerDir: w.workerDir,
    lastDeployedAt: metadata ? resolveLastDeployedAt(w.workerName, metadata) : null,
    lastCommitAt: getLastCommitAt(w.workerDir),
    deployError: metadataError,
  }));

  const now = new Date();
  const results: WorkerDriftResult[] = evaluateAllWorkerDrift(inputs, now);

  for (const r of results) {
    console.log(`${LOG_PREFIX} ${r.workerName} (workers/${r.workerDir}/): ${r.status} — ${r.message}`);
  }

  const state = loadState();
  const pending = hasPendingDrift(results);
  console.log(
    `${LOG_PREFIX} ${pending ? "drift pendente" : "nenhum drift pendente"} ` +
      `(última checagem: ${state.lastCheckedAt ?? "nunca"}).`,
  );

  // #4746: falha SUSTENTADA da consulta à Cloudflare API (credencial
  // expirada/revogada) nunca disparava alarme — `metadataError` faz
  // `hasPendingDrift` excluir "error", `shouldAlarm` nunca vira `true`, e o
  // editor nunca sabia que a checagem estava cega, mesmo indefinidamente.
  // Alarme SEPARADO do alarme de drift acima, com sua própria idempotência
  // (`firstApiErrorAt`/`lastApiErrorAlarmedAt`, persistidos no MESMO
  // state.json). `nextApiErrorState` já é o valor que será persistido nesta
  // execução — sucesso reseta a série; falha preserva/inicia.
  const nextApiErrorState = advanceApiErrorState(state, metadataError, now);
  const sendApiErrorAlarm = shouldAlarmApiError(nextApiErrorState, metadataError, now);
  if (sendApiErrorAlarm) {
    const { subject, body } = buildApiErrorAlarmEmail(metadataError!, nextApiErrorState.firstApiErrorAt!, now);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(
        `${LOG_PREFIX} --dry-run: enviaria e-mail (falha sustentada da API) pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`,
      );
    } else {
      // Mesmo racional do alarme de drift abaixo: sem try/catch — se o envio
      // falhar, `lastApiErrorAlarmedAt` NÃO avança (não seta aqui embaixo) e
      // a próxima execução tenta alarmar de novo, em vez de marcar esta série
      // como "já avisada" sem o editor ter recebido nada.
      await sendGmailMessage(to, subject, body);
      console.log(`${LOG_PREFIX} e-mail de alarme (falha sustentada da API) enviado pra ${to}.`);
      nextApiErrorState.lastApiErrorAlarmedAt = now.toISOString();
    }
  }

  // #5339 — reconcilia issue por worker defasado ANTES de montar o e-mail
  // (o e-mail cita a issue de cada achado pendente), mesmo padrão de
  // beehiiv-home-meta-check.ts. Roda toda execução não-dry-run, independente
  // de um e-mail novo disparar nesta rodada.
  const driftedResults = results.filter((r) => r.status === "drift" || r.status === "never_deployed");
  const alarmFindings = driftedResults.map(toAlarmFinding);
  const alarmState = loadAlarmIssuesState();
  let issueRefs: Map<string, { issueNumber: number | null; url: string | null; action: string; error?: string }> | undefined;

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado.`,
    );
  } else {
    const { nextState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
      cwd: ROOT,
      closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
    });
    saveAlarmIssuesState(nextState);
    issueRefs = new Map(
      findingOutcomes.map((o) => [
        o.fingerprint,
        { issueNumber: o.issueNumber, url: o.url, action: o.action, error: o.error },
      ]),
    );
    for (const o of findingOutcomes) {
      if (o.action === "failed") {
        console.error(`${LOG_PREFIX} [${o.check}] issue não criada/reusada: ${o.error}`);
      } else {
        console.log(`${LOG_PREFIX} [${o.check}] issue #${o.issueNumber} (${o.action}): ${o.url}`);
      }
    }
  }

  if (shouldAlarm(state, results)) {
    const { subject, body } = buildWorkerDriftAlarmEmail(results, now, issueRefs);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      // Diferente de check-brevo-diaria-guardrail.ts (onde o ESTADO tem valor
      // operacional independente do e-mail — pausa um rollout — e por isso
      // persiste antes do envio best-effort), aqui `lastAlarmedFingerprint`
      // EXISTE só pra gatear este e-mail. Se o envio falhar e o cursor
      // avançasse mesmo assim, esse drift nunca mais seria reportado (a
      // checagem seguinte veria o mesmo fingerprint "já alarmado" e ficaria
      // muda) — deixar a exceção propagar (sem try/catch, mesmo padrão de
      // `apoios-diff-alarm.ts`) aborta ANTES do `saveState` abaixo, então a
      // próxima execução da task (6h depois) tenta alarmar de novo.
      await sendGmailMessage(to, subject, body);
      console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
    }
  } else {
    console.log(`${LOG_PREFIX} nenhum e-mail necessário (sem drift pendente, ou o mesmo drift já foi alarmado antes).`);
  }

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: cursor NÃO avançado.`);
    return;
  }

  if (!shouldAdvanceState({ isDryRun, metadataError })) {
    // #4723 fleet review, achado 1: `metadataError` (falha da conta inteira)
    // faz TODO worker cair em "error", `pending` vira false, e avançar o
    // cursor de DRIFT aqui gravaria `lastAlarmedFingerprint: null` mesmo com
    // um drift real já alarmado pendente — a próxima execução bem-sucedida
    // recomputaria o mesmo fingerprint e re-alarmaria, duplicando um e-mail
    // que o editor já recebeu. Preserva `lastAlarmedFingerprint`/
    // `lastCheckedAt` intactos (`state` original, não `advanceState`).
    //
    // #4746: MESMO sem avançar o cursor de drift, persiste o estado da
    // SÉRIE de falha da API (`nextApiErrorState`) — sem isso, `firstApiErrorAt`
    // nunca é salvo em disco e cada execução recomeça a série do zero,
    // fazendo a falha nunca ficar "sustentada" de verdade (o bug que este
    // fix resolve).
    console.error(
      `${LOG_PREFIX} consulta à Cloudflare Workers API falhou nesta execução (${metadataError}) — nenhum ` +
        "worker teve dado confiável. Cursor de drift NÃO avançado (preserva o estado anterior).",
    );
    saveState({ ...state, ...nextApiErrorState });
    process.exitCode = 1;
    return;
  }

  const nextFingerprint = pending ? computeDriftFingerprint(results) : null;
  saveState(advanceState(nextFingerprint, now, nextApiErrorState));
}

if (isMainModule(import.meta.url)) {
  // #4745: process.exitCode em vez de process.exit() — este catch roda DEPOIS
  // de awaits de rede (fetchAllWorkerScriptsMetadata/sendGmailMessage), o
  // cenário exato da classe UV_HANDLE_CLOSING no Windows (#1401/#4638/#4651/
  // #4653): process.exit() força o shutdown do libuv antes dos sockets
  // keep-alive do fetch fecharem. process.exitCode deixa o event loop drenar
  // sozinho. O guard pré-await (linha acima, envs ausentes) continua com
  // process.exit(2) de propósito — nenhum fetch rodou ainda nesse ponto.
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
