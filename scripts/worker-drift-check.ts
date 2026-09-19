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
 * **Deploy deliberadamente bloqueado não alarma (#7092).** Se o
 * `wrangler.toml`/`.jsonc` do worker ainda tiver um valor
 * `PLACEHOLDER_...` não resolvido, o drift vira status `deploy_blocked`:
 * aparece no log e no relatório, mas NÃO conta como pendência, não dispara
 * e-mail e não abre issue. Motivo: nesse estado `wrangler deploy` falha, e
 * `.github/workflows/deploy-*.yml` já pula o deploy automático pelo mesmo
 * sinal — o alarme estava mandando o editor rodar o único comando que não
 * funciona (issue #7092, worker `diaria-artigos`). Ver
 * `parseDeployBlockingPlaceholders` em `scripts/lib/worker-drift-check.ts`.
 * O trabalho REAL de destravar (provisionar KV/secret) é rastreado na issue
 * do worker, não por este alarme.
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
 * idempotência EXISTE só pra gatear a notificação (não tem valor operacional
 * independente), então uma notificação que NÃO chega ao editor NÃO avança o
 * cursor — a próxima execução da task tenta alarmar de novo, em vez de
 * marcar silenciosamente esse drift como "já avisado" sem o editor ter
 * recebido nada.
 *
 * ─── #7960 (fatia 6): os 2 fluxos passam pelo portão `notifyEditor` ────────
 *
 * Este arquivo foi o último da ALLOWLIST de `test/editor-notify-boundary.test.ts`
 * justamente por ter DOIS caminhos de notificação distintos:
 *
 *   1. **Drift** (issue-based) — `applyAlarmReconciliation` segue INTOCADO;
 *      só o e-mail passou a ser decidido por `notifyEditorForOutcomes`
 *      (`severity: "acao"`, `legacyResendIntent: "resend-every-run"` —
 *      `shouldAlarm` já é o gate de dedup, externo ao portão).
 *   2. **Falha SUSTENTADA da Cloudflare API** (#4746) — não tinha
 *      `AlarmFinding` nem issue; passou a abrir issue via `notifyEditor`
 *      (`severity: "acao"`, fingerprint constante, 1 issue reusada/reaberta
 *      por série) em vez de só e-mailar.
 *
 * A armadilha comum aos dois, e o motivo de `shouldPersistAlarmedState`/
 * `notifyEditorResultReachedEditor` (`scripts/lib/editor-notify.ts`):
 * `sendGmailMessage` LANÇAVA em falha e abortava `main()` antes do
 * `saveState`, então o retry era garantido por acidente do fluxo de
 * controle. O portão nunca lança — a decisão de persistir o cursor virou
 * explícita.
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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import {
  notifyEditor,
  notifyEditorForOutcomes,
  shouldPersistAlarmedState,
  notifyEditorResultReachedEditor,
} from "./lib/editor-notify.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import {
  parseWranglerTomlName,
  parseWranglerJsoncName,
  parseDeployBlockingPlaceholders,
  evaluateAllWorkerDrift,
  hasPendingDrift,
  computeDriftFingerprint,
  resolveNextAlarmedFingerprint,
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
  loadAlarmIssuesState,
  saveAlarmIssuesState,
  saveState,
  type AlarmFinding,
  type AlarmFindingOutcome,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKERS_DIR = resolve(ROOT, "workers");
const STATE_PATH = resolve(ROOT, "data", "worker-drift-check", "state.json");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "worker-drift-check", "alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[worker-drift-check]";
/** #5339: mesmo valor de CLOSE_ALARM_ISSUE_AFTER_RUNS de home-meta-check.ts
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

// saveState/loadAlarmIssuesState/saveAlarmIssuesState: consolidados em
// scripts/lib/alarm-issues.ts (#7124) — importados acima. Arquivo separado
// de STATE_PATH de propósito: idempotência do E-MAIL (acima) e tracking de
// ISSUE por achado são preocupações independentes.
export { saveState, loadAlarmIssuesState, saveAlarmIssuesState };

/** Converte um `WorkerDriftResult` defasado (status "drift"/"never_deployed")
 * no `AlarmFinding` genérico que `scripts/lib/alarm-issues.ts` consome
 * (#5339). `check` = nome do worker (cada worker é seu próprio eixo — não
 * há como 2 workers colidirem no mesmo achado). `fingerprint` usa
 * `workerDriftFindingKey`, a MESMA fórmula usada pra montar `issueRefs` em
 * `buildWorkerDriftAlarmEmail`. Todo achado nasce `P2` — mesma prioridade
 * da issue original #5337 (bug com workaround: deploy manual). */
export function toAlarmFinding(r: WorkerDriftResult): AlarmFinding {
  return {
    check: r.workerName,
    fingerprint: workerDriftFindingKey(r),
    // #5553 — condição RE-CHECÁVEL (commit vs deploy); resolve sozinho
    // quando o worker for redeployado.
    family: "estado",
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
  /** Placeholders não resolvidos no config deste worker (#7092) — `[]` no
   * caso normal. Lido aqui porque o config JÁ foi aberto pra extrair o
   * `name`: nenhum I/O extra. */
  deployBlockedBy: string[];
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
    let configContent = "";
    if (existsSync(tomlPath)) {
      configContent = readFileSync(tomlPath, "utf8");
      name = parseWranglerTomlName(configContent);
    } else if (existsSync(jsoncPath)) {
      configContent = readFileSync(jsoncPath, "utf8");
      name = parseWranglerJsoncName(configContent);
    }

    if (name) {
      discovered.push({
        workerDir: dir,
        workerName: name,
        deployBlockedBy: parseDeployBlockingPlaceholders(configContent),
      });
    } else {
      console.error(`${LOG_PREFIX} aviso: ${dir}/ não tem wrangler.toml/.jsonc com um "name" reconhecível — pulado.`);
    }
  }

  return discovered;
}

// ─── Git: timestamp do último commit por worker (I/O) ──────────────────────

/**
 * Resolve a ref de PRODUÇÃO a comparar (#6413): sempre `origin/master`
 * quando o remote tem essa ref localmente conhecida (o caso normal — fetch
 * já rodou antes em algum momento), com fallback pra `master` local (mesmo
 * padrão de `scripts/lib/git-sync.ts`, que trata `master` como a branch de
 * produção). NUNCA a branch checked out no momento — o checkout deste repo
 * é compartilhado entre sessões concorrentes (overnight, develop,
 * interativas) e pode estar em qualquer branch de feature a qualquer
 * momento — achado ao vivo #6413 (checkout numa branch de outra sessão,
 * trabalhando outra issue, gerou drift falso pro worker `poll`).
 * `git rev-parse --verify --quiet` não faz I/O de rede (não dá fetch) —
 * só confere se a ref já existe no repo local; se nem `origin/master` nem
 * `master` existirem (clone atípico), cai pro `master` mesmo e deixa o
 * `git log` seguinte reportar `null` como já fazia antes deste fix.
 */
export function resolveProductionRef(root: string = ROOT): string {
  const check = spawnSync("git", ["rev-parse", "--verify", "--quiet", "origin/master"], {
    encoding: "utf8",
    cwd: root,
    timeout: 30_000,
  });
  return check.status === 0 ? "origin/master" : "master";
}

/**
 * `git log -1 --format=%aI {ref} -- workers/{dir}` — `%aI` é a data do autor em
 * ISO 8601 estrito (com offset), a mesma disciplina de timestamp usada em
 * outros comparadores de tempo do repo (ver docstring de `sentDate` em
 * `brevo-client.ts`). `ref`, se omitido, vem de `resolveProductionRef` —
 * sempre `origin/master`/`master`, nunca a branch atualmente checked out
 * (#6413: sem isso, um commit de feature branch não-mergeada em outro
 * worktree do mesmo repo compartilhado gera falso positivo de drift, porque
 * o alarme lia o commit "alcançável a partir do HEAD" de quem quer que
 * estivesse checked out no momento da execução). O call site que avalia
 * TODOS os workers resolve a ref 1x e passa explicitamente (evita 1
 * `spawnSync` de `rev-parse` por worker); passar `undefined` resolve de
 * novo por chamada — usado pelos testes, que exercitam workers isolados.
 * Retorna `null` se não há nenhum commit tocando esse path na ref de
 * produção (não deveria acontecer na prática — o diretório existe
 * versionado em master — mas tratado como edge case, não uma exceção).
 */
export function getLastCommitAt(workerDir: string, root: string = ROOT, ref?: string): string | null {
  const resolvedRef = ref ?? resolveProductionRef(root);
  const res = spawnSync("git", ["log", "-1", "--format=%aI", resolvedRef, "--", join("workers", workerDir)], {
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

  // Resolvida 1x fora do .map() (#6413 self-review finding 2) — evita 1
  // `spawnSync("git", ["rev-parse", ...])` extra por worker (11 workers hoje).
  const productionRef = resolveProductionRef();

  const inputs: WorkerDriftCheckInput[] = workers.map((w) => ({
    workerName: w.workerName,
    workerDir: w.workerDir,
    lastDeployedAt: metadata ? resolveLastDeployedAt(w.workerName, metadata) : null,
    lastCommitAt: getLastCommitAt(w.workerDir, ROOT, productionRef),
    deployError: metadataError,
    deployBlockedBy: w.deployBlockedBy,
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
    if (isDryRun) {
      const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
      console.log(
        `${LOG_PREFIX} --dry-run: notificaria (falha sustentada da API) ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`,
      );
    } else {
      // #7960 (fatia 6): este era o 2o fluxo de e-mail do arquivo e o motivo
      // de `worker-drift-check.ts` ter ficado por ultimo na ALLOWLIST — ele
      // NUNCA passou por `ensureAlarmIssue`/`applyAlarmReconciliation` (sem
      // `AlarmFinding`, sem issue), entao nao havia outcome pra alimentar
      // `notifyEditorForOutcomes`. Migrado como os ~10 alarmes "sem issue
      // hoje" da 1a fatia: passa a ABRIR issue via `notifyEditor`
      // (`severity: "acao"` — e cegueira de checagem, nao envio/dinheiro em
      // risco), com `fingerprint` CONSTANTE de proposito: uma serie nova de
      // falha reusa/reabre a MESMA issue em vez de abrir uma por serie. A
      // idempotencia de QUANDO notificar continua sendo a desta funcao
      // (`shouldAlarmApiError` — 1x por serie, ver #4746); a issue so torna o
      // achado visivel fora do e-mail.
      const apiResult = await notifyEditor(
        {
          check: "worker-drift-api-error",
          fingerprint: "cloudflare-workers-api-sustained-failure",
          severity: "acao",
          subject,
          body,
          labels: ["bug"],
          priority: "P2",
          family: "estado",
        },
        { cwd: ROOT, platformConfigPath: PLATFORM_CONFIG_PATH, rootDir: ROOT, emailTo: toOverride },
      );
      // `notifyEditor` NUNCA lanca (fail-soft por desenho), ao contrario do
      // `sendGmailMessage` que estava aqui — avancar `lastApiErrorAlarmedAt`
      // incondicionalmente encerraria a serie como "ja avisada" mesmo sem
      // nada ter chegado ao editor, e esta serie NUNCA mais alarmaria
      // (`shouldAlarmApiError` so volta a disparar depois de um sucesso
      // resetar `firstApiErrorAt`). Ver `notifyEditorResultReachedEditor`.
      if (notifyEditorResultReachedEditor(apiResult)) {
        nextApiErrorState.lastApiErrorAlarmedAt = now.toISOString();
        console.log(`${LOG_PREFIX} alarme (falha sustentada da API) notificado — issue ${apiResult.issue?.url ?? "-"}.`);
      } else {
        console.error(
          `${LOG_PREFIX} alarme (falha sustentada da API) NAO chegou ao editor ` +
            `(${apiResult.issue?.action === "failed" ? `gh falhou: ${apiResult.issue.error}` : `push falhou: ${apiResult.emailError}`}) — ` +
            "serie NAO marcada como avisada, retry na proxima execucao.",
        );
      }
    }
  }

  // #5339 — reconcilia issue por worker defasado ANTES de montar o e-mail
  // (o e-mail cita a issue de cada achado pendente), mesmo padrão de
  // home-meta-check.ts. Roda toda execução não-dry-run, independente
  // de um e-mail novo disparar nesta rodada.
  const driftedResults = results.filter((r) => r.status === "drift" || r.status === "never_deployed");
  const alarmFindings = driftedResults.map(toAlarmFinding);
  const alarmState = loadAlarmIssuesState(ALARM_ISSUES_STATE_PATH);
  let issueRefs: Map<string, { issueNumber: number | null; url: string | null; action: string; error?: string }> | undefined;
  // #7960 (fatia 6) — alimenta `notifyEditorForOutcomes` no bloco de alarme
  // abaixo; `[]` no dry-run (nenhuma reconciliacao roda).
  let findingOutcomes: AlarmFindingOutcome[] = [];

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado.`,
    );
  } else {
    const { nextState, findingOutcomes: outcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
      cwd: ROOT,
      closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
    });
    findingOutcomes = outcomes;
    saveAlarmIssuesState(nextState, ALARM_ISSUES_STATE_PATH);
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

  // #7960 (fatia 6) — `true` quando NENHUM alarme de drift foi tentado nesta
  // execucao (nada a preservar) ou quando o tentado de fato chegou ao editor.
  // `false` so quando um alarme foi tentado e se perdeu — ai o cursor
  // `lastAlarmedFingerprint` NAO avanca (ver o `saveState` no fim de main()).
  let driftAlarmReachedEditor = true;

  if (shouldAlarm(state, results)) {
    const { subject, body } = buildWorkerDriftAlarmEmail(results, now, issueRefs);
    if (isDryRun) {
      const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
      console.log(`${LOG_PREFIX} --dry-run: notificaria ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      // #7960 (fatia 6): `shouldAlarm` (fingerprint do CONJUNTO de drifts vs.
      // `state.lastAlarmedFingerprint`) continua sendo o gate de dedup — e
      // ele, externo ao portao, que decide SE notificar. Por isso
      // `legacyResendIntent: "resend-every-run"` (todo outcome nao-`failed`
      // qualifica): mesma escolha de `systemd-failed-units-alarm.ts` na
      // fatia 5 — quando existe gate custom de dedup fora do portao, o
      // portao nao deve dedupar de novo, senao um conjunto genuinamente novo
      // cuja issue saiu como `"reused"` seria silenciado.
      const result = await notifyEditorForOutcomes(findingOutcomes, "acao", () => ({ subject, body }), {
        cwd: ROOT,
        platformConfigPath: PLATFORM_CONFIG_PATH,
        emailTo: toOverride,
        legacyResendIntent: "resend-every-run",
      });

      // Diferente de check-brevo-diaria-guardrail.ts (onde o ESTADO tem valor
      // operacional independente do e-mail — pausa um rollout — e por isso
      // persiste antes do envio best-effort), aqui `lastAlarmedFingerprint`
      // EXISTE so pra gatear esta notificacao. Se ela se perder e o cursor
      // avancasse mesmo assim, esse drift nunca mais seria reportado (a
      // checagem seguinte veria o mesmo fingerprint "ja alarmado" e ficaria
      // muda). Ate o #7960 isso era garantido por ACIDENTE do fluxo de
      // controle — `sendGmailMessage` lancava e abortava `main()` antes do
      // `saveState`; `notifyEditorForOutcomes` nunca lanca, entao a decisao
      // virou explicita via `shouldPersistAlarmedState`.
      const anyIssueSucceeded = findingOutcomes.some((o) => o.action !== "failed");
      driftAlarmReachedEditor = shouldPersistAlarmedState(anyIssueSucceeded, result.qualifying.length, result.emailSent);
      if (driftAlarmReachedEditor) {
        console.log(
          result.emailSent
            ? `${LOG_PREFIX} e-mail de alarme enviado.`
            : `${LOG_PREFIX} politica '${result.emailPolicy}': issue registrada, nenhum e-mail necessario.`,
        );
      } else {
        console.error(
          `${LOG_PREFIX} alarme de drift NAO chegou ao editor ` +
            `(${anyIssueSucceeded ? `push falhou: ${result.emailError}` : "gh falhou pra todos os achados"}) — ` +
            "cursor NAO avancado, retry na proxima execucao.",
        );
      }
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
    saveState({ ...state, ...nextApiErrorState }, STATE_PATH);
    process.exitCode = 1;
    return;
  }

  // #7960 (fatia 6) — quando o alarme desta execucao se perdeu, preserva o
  // `lastAlarmedFingerprint` ANTERIOR (o drift volta a alarmar na proxima
  // execucao); `lastCheckedAt`/estado da serie de API avancam normalmente.
  const nextFingerprint = resolveNextAlarmedFingerprint({
    previousFingerprint: state.lastAlarmedFingerprint,
    pending,
    computedFingerprint: pending ? computeDriftFingerprint(results) : null,
    alarmReachedEditor: driftAlarmReachedEditor,
  });
  saveState(advanceState(nextFingerprint, now, nextApiErrorState), STATE_PATH);
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
