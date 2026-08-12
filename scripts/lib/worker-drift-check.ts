/**
 * worker-drift-check.ts (#4723)
 *
 * Lógica PURA (sem I/O) do alarme de drift entre o código publicado de cada
 * Worker (`workers/{nome}/`) e o master local — mesmo molde de
 * `scripts/lib/apoios-diff-alarm.ts` / `scripts/lib/brevo-diaria-guardrail.ts`:
 * uma função de decisão testável (`evaluateWorkerDrift`) que recebe os dois
 * timestamps já resolvidos (não faz shell-out nem chamada de rede), mais
 * fingerprint + estado de idempotência pro alarme por e-mail. O script
 * `scripts/worker-drift-check.ts` é quem faz o I/O (descobre os workers,
 * consulta a Cloudflare API, roda `git log`) e usa este módulo pra decidir
 * SE/O-QUE alarmar.
 *
 * ─── Contexto (#4723) ──────────────────────────────────────────────────────
 *
 * O Worker `reativar` ficou 4 dias em produção com código defasado — um
 * commit mergeou em master mas ninguém rodou `wrangler deploy`. Não havia
 * sinal automático; só foi percebido porque o editor estranhou um cadastro
 * anômalo. Este módulo é a Opção 1 recomendada na issue: comparar o
 * timestamp do último deploy publicado contra o timestamp do último commit
 * que tocou `workers/{nome}/**` — se o commit for mais recente, alarma.
 *
 * ─── Por que o script usa a Cloudflare REST API em vez de `wrangler
 * deployments list` (desvio deliberado do texto literal da issue) ─────────
 *
 * A issue sugere `wrangler deployments list --json` como caminho primário
 * ("ou API Cloudflare equivalente" — a issue já abre essa porta). Este
 * módulo/script segue o MESMO racional já registrado em
 * `check-cloudflare-token.ts` ("REST puro é preferível [ao wrangler CLI] —
 * não exige CLI instalado no PATH, sem side-effects de login interativo, e é
 * testável com mock de fetch"): usa `GET /accounts/{account_id}/workers/scripts`
 * (endpoint "List Workers", UMA chamada pra conta inteira — não
 * `.../scripts/{script_name}`, que na API da Cloudflare devolve o CONTEÚDO
 * do script, não metadata JSON; usar o endpoint singular teria feito
 * `res.json()` lançar pra praticamente todo worker, tratando drift real como
 * "erro de consulta" — achado do self-review deste PR, corrigido antes de
 * abrir) em vez de spawnar `wrangler`. `modified_on` de cada item é
 * exatamente "quando este script foi atualizado pela última vez" —
 * semanticamente idêntico a "último deploy" (só `wrangler deploy` atualiza
 * um Worker Script). Ver `fetchAllWorkerScriptsMetadata`/`resolveLastDeployedAt`
 * no script orquestrador.
 *
 * ─── Idempotência: RE-ARMA quando o drift muda de shape ou desaparece ──────
 *
 * Mesmo padrão de `apoios-diff-alarm.ts`: o fingerprint inclui o timestamp do
 * commit E do deploy de cada worker problemático, então:
 *   - o MESMO drift persistindo (nada mudou) não gera um novo e-mail a cada
 *     execução da task (a cada 6h) — só o PRIMEIRO alarme daquele estado;
 *   - um commit NOVO chegando em cima de um drift já alarmado (código
 *     divergiu ainda mais sem deploy) MUDA o fingerprint (timestamp de
 *     commit diferente) — alarma de novo, porque é informação nova;
 *   - o drift sendo resolvido (editor rodou `wrangler deploy`) faz esse
 *     worker sair do conjunto "problemático" — o fingerprint global muda
 *     (ou fica vazio, se era o único) — o cursor "re-arma" (`advanceState`
 *     grava `null` quando não há mais drift pendente);
 *   - o MESMO worker voltando a driftar depois (novo commit sem deploy,
 *     típico ciclo) gera um fingerprint novo (timestamp de commit novo) —
 *     alarma de novo mesmo partindo de um cursor "re-armado".
 */

// ─── Descoberta de workers: parsing puro de config (sem I/O) ───────────────

/**
 * Extrai o `name = "..."` de um `wrangler.toml` (formato TOML, mas o campo
 * `name` no topo do arquivo é sempre uma linha simples `name = "valor"` em
 * todo `wrangler.toml` deste repo — regex é suficiente, não precisa de um
 * parser TOML completo só pra este campo).
 *
 * Restrito ao PREÂMBULO do arquivo — tudo ANTES da 1ª seção de tabela TOML
 * (`[...]`/`[[...]]`). #4723 fleet review, achado 2: vários `wrangler.toml`
 * reais do repo (`workers/poll`, `workers/linkedin-cron`) têm bindings como
 * `[[durable_objects.bindings]]` com seu PRÓPRIO campo `name = "..."` (ex:
 * `name = "VOTE_DEDUP"`) — sem esse corte, um regex sem âncora de seção
 * casaria o PRIMEIRO `name` do arquivo inteiro, que hoje é sempre o do topo
 * só por convenção de ordenação (nenhum `wrangler.toml` deste repo tem uma
 * seção ANTES do `name` de topo), não por garantia estrutural.
 *
 * Retorna `null` se o conteúdo não tiver uma linha `name = "..."` reconhecível
 * no preâmbulo (arquivo vazio/malformado, ou `name` só existe dentro de uma
 * seção) — caller decide o que fazer (pular o worker, reportar erro), esta
 * função nunca lança.
 */
export function parseWranglerTomlName(tomlContent: string): string | null {
  const sectionHeader = tomlContent.match(/^\s*\[/m);
  const preamble = sectionHeader ? tomlContent.slice(0, sectionHeader.index) : tomlContent;
  const m = preamble.match(/^\s*name\s*=\s*"([^"]+)"/m);
  return m ? m[1] : null;
}

/**
 * Extrai o `"name": "..."` de um `wrangler.jsonc` (JSON com comentários —
 * regex evita depender de um parser JSONC só pra este campo, mesmo racional
 * de `parseWranglerTomlName`). Nenhum worker deste repo usa `.jsonc` hoje
 * (todos os 11 são `.toml`, confirmado antes de escrever este módulo) — este
 * parser existe pra não deixar o discovery quebrado no dia em que um worker
 * novo (ou uma migração) adotar o formato `.jsonc` (formato mais recente
 * recomendado pelo Wrangler).
 */
export function parseWranglerJsoncName(jsoncContent: string): string | null {
  const m = jsoncContent.match(/"name"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

// ─── Avaliação de drift por worker (pura) ──────────────────────────────────

export type WorkerDriftStatus =
  /** Deploy está em dia — nenhum commit em `workers/{dir}/` é mais recente que o último deploy. */
  | "ok"
  /** Commit em `workers/{dir}/` mais recente que o último deploy — precisa `wrangler deploy`. */
  | "drift"
  /** Worker tem commit(s) em `workers/{dir}/` mas NUNCA foi deployado (edge case #4723 item 9). */
  | "never_deployed"
  /** Consulta da Cloudflare API falhou (credencial ausente/API indisponível) — sem dado pra decidir; não quebra os outros workers. */
  | "error"
  /** Nenhum commit encontrado em `workers/{dir}/` (não deveria acontecer na prática — o diretório existe — mas não há nada pra comparar). */
  | "no_data";

export interface WorkerDriftCheckInput {
  /** Nome publicado na Cloudflare (`name` do wrangler.toml/.jsonc) — usado pra consultar a API e no e-mail. */
  workerName: string;
  /** Diretório do worker sob `workers/` (ex: "reativar") — usado no `git log`/no comando de deploy sugerido. Pode diferir de `workerName` (ex: dir "artigos" -> name "diaria-artigos"). */
  workerDir: string;
  /** ISO 8601 do último deploy publicado, ou `null` se nunca deployado. */
  lastDeployedAt: string | null;
  /** ISO 8601 do último commit que tocou `workers/{workerDir}/**`, ou `null` se nenhum commit encontrado. */
  lastCommitAt: string | null;
  /** Mensagem de erro da consulta à Cloudflare API, se houve falha (credencial ausente, API indisponível, worker não encontrado, etc). Quando presente, `lastDeployedAt` é ignorado (não confiável). */
  deployError?: string | null;
}

export interface WorkerDriftResult {
  workerName: string;
  workerDir: string;
  status: WorkerDriftStatus;
  /** ISO 8601 — ecoa `lastDeployedAt` do input, pra relatório/e-mail. */
  lastDeployedAt: string | null;
  /** ISO 8601 — ecoa `lastCommitAt` do input, pra relatório/e-mail. */
  lastCommitAt: string | null;
  /** Duração do drift em ms — só presente quando `status` é "drift" ou "never_deployed". */
  driftMs: number | null;
  /** Mensagem legível — motivo do status (inclui o erro cru quando `status === "error"`). */
  message: string;
}

/**
 * Pura — decide o status de drift de UM worker, a partir dos dois timestamps
 * já resolvidos (nenhum I/O aqui — `now` é injetado pra determinismo em
 * teste, usado só pra calcular `driftMs` no caso `never_deployed`, onde não
 * há um segundo timestamp de deploy pra subtrair).
 */
export function evaluateWorkerDrift(input: WorkerDriftCheckInput, now: Date = new Date()): WorkerDriftResult {
  const { workerName, workerDir, lastDeployedAt, lastCommitAt, deployError } = input;

  if (deployError) {
    return {
      workerName,
      workerDir,
      status: "error",
      lastDeployedAt: null,
      lastCommitAt,
      driftMs: null,
      message: `erro ao consultar deploy publicado: ${deployError}`,
    };
  }

  if (lastCommitAt === null) {
    return {
      workerName,
      workerDir,
      status: "no_data",
      lastDeployedAt,
      lastCommitAt: null,
      driftMs: null,
      message: `nenhum commit encontrado em workers/${workerDir}/ — nada a comparar`,
    };
  }

  const commitMs = Date.parse(lastCommitAt);

  if (lastDeployedAt === null) {
    return {
      workerName,
      workerDir,
      status: "never_deployed",
      lastDeployedAt: null,
      lastCommitAt,
      driftMs: Math.max(0, now.getTime() - commitMs),
      message: `worker nunca foi deployado, mas tem commit(s) em workers/${workerDir}/`,
    };
  }

  const deployMs = Date.parse(lastDeployedAt);

  if (commitMs > deployMs) {
    return {
      workerName,
      workerDir,
      status: "drift",
      lastDeployedAt,
      lastCommitAt,
      driftMs: commitMs - deployMs,
      message: `commit mais recente (${lastCommitAt}) que o último deploy publicado (${lastDeployedAt})`,
    };
  }

  return {
    workerName,
    workerDir,
    status: "ok",
    lastDeployedAt,
    lastCommitAt,
    driftMs: null,
    message: "deploy publicado está em dia com o commit mais recente",
  };
}

/** Pura — mapeia `evaluateWorkerDrift` sobre uma lista de workers. */
export function evaluateAllWorkerDrift(
  inputs: readonly WorkerDriftCheckInput[],
  now: Date = new Date(),
): WorkerDriftResult[] {
  return inputs.map((input) => evaluateWorkerDrift(input, now));
}

// ─── Idempotência do alarme (fingerprint + estado) ─────────────────────────

/** Pura — só "drift"/"never_deployed" contam como pendência que justifica
 * e-mail. "error" é reportado no log/relatório mas não dispara alarme por si
 * só (uma falha transitória de API não deveria acordar o editor todo dia —
 * ver `scripts/worker-drift-check.ts` pro tratamento de erro persistente). */
export function hasPendingDrift(results: readonly WorkerDriftResult[]): boolean {
  return results.some((r) => r.status === "drift" || r.status === "never_deployed");
}

/** Pura — fingerprint estável (determinístico, independente da ordem de
 * chegada) do conjunto de workers com drift pendente — usado pra
 * idempotência. Inclui commit E deploy timestamp de cada worker pendente:
 * qualquer um dos dois mudando (novo commit sem deploy; um deploy parcial
 * que ainda não alcança o commit mais novo) muda o fingerprint e re-alarma. */
export function computeDriftFingerprint(results: readonly WorkerDriftResult[]): string {
  const pending = results.filter((r) => r.status === "drift" || r.status === "never_deployed");
  const keys = pending
    .map((r) => `${r.workerName}:${r.status}:${r.lastCommitAt ?? "-"}:${r.lastDeployedAt ?? "-"}`)
    .sort();
  return keys.join("|");
}

export interface WorkerDriftAlarmState {
  /** Fingerprint do drift já alarmado (ou `null` — sem drift pendente conhecido, "re-armado"). */
  lastAlarmedFingerprint: string | null;
  /** ISO — só pra REPORTAR ("desde X"), não participa da idempotência. */
  lastCheckedAt: string | null;
  /** ISO — quando a consulta à Cloudflare API (`fetchAllWorkerScriptsMetadata`)
   * começou a falhar nesta série CONSECUTIVA. `null` sempre que a consulta
   * mais recente teve sucesso — reseta a série inteira, porque uma falha
   * isolada nunca é "sustentada" (#4746). */
  firstApiErrorAt: string | null;
  /** ISO — quando o alarme de "consulta à API falhando há muito tempo" foi
   * enviado pela ÚLTIMA vez NESTA série. Reseta junto com `firstApiErrorAt`
   * quando a série resolve (sucesso), permitindo alarmar de novo numa série
   * futura sem repetir o mesmo e-mail a cada execução da série atual (#4746). */
  lastApiErrorAlarmedAt: string | null;
}

export function emptyWorkerDriftAlarmState(): WorkerDriftAlarmState {
  return {
    lastAlarmedFingerprint: null,
    lastCheckedAt: null,
    firstApiErrorAt: null,
    lastApiErrorAlarmedAt: null,
  };
}

/** Pura — avança o cursor. `fingerprint: null` quando não há drift pendente
 * nesta checagem (re-arma pra próxima ocorrência, mesmo padrão de
 * `apoios-diff-alarm.ts`). `apiErrorState` (default: série resetada) carrega
 * `firstApiErrorAt`/`lastApiErrorAlarmedAt` — só é chamado com um valor
 * explícito no branch de SUCESSO de main() (`advanceApiErrorState` já
 * resolveu pra `{ null, null }` nesse caso; o default aqui existe só pra não
 * quebrar callers/testes que não se importam com a série de erro). */
export function advanceState(
  fingerprint: string | null,
  now: Date,
  apiErrorState: Pick<WorkerDriftAlarmState, "firstApiErrorAt" | "lastApiErrorAlarmedAt"> = {
    firstApiErrorAt: null,
    lastApiErrorAlarmedAt: null,
  },
): WorkerDriftAlarmState {
  return { lastAlarmedFingerprint: fingerprint, lastCheckedAt: now.toISOString(), ...apiErrorState };
}

/** #4746 — threshold pra considerar a falha da consulta à Cloudflare API
 * "sustentada" (credencial expirada/revogada, não um blip transitório). A
 * task (`Diaria-Worker-Drift-Check`) roda a cada 6h — 24h ~ 4 execuções
 * consecutivas falhando antes de acordar o editor com um alarme distinto do
 * alarme de drift em si. */
export const API_ERROR_SUSTAINED_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * Pura — deriva `firstApiErrorAt`/`lastApiErrorAlarmedAt` PARA PERSISTIR
 * nesta execução, a partir do estado anterior + se ESTA execução teve
 * `metadataError` (#4746):
 *   - `metadataError` ausente (consulta OK) → RESETA a série inteira
 *     (`null`, `null`) — falha resolvida; a próxima falha começa uma série
 *     nova, com threshold contado do zero.
 *   - `metadataError` presente e já havia `firstApiErrorAt` anterior →
 *     PRESERVA o início da série (a falha continua) e `lastApiErrorAlarmedAt`
 *     tal como estava (main() avança pra `now` só se o e-mail for de fato
 *     enviado — ver `shouldAlarmApiError`).
 *   - `metadataError` presente mas `firstApiErrorAt` anterior era `null`
 *     (1ª falha desta série) → inicia a série agora.
 */
export function advanceApiErrorState(
  previous: Pick<WorkerDriftAlarmState, "firstApiErrorAt" | "lastApiErrorAlarmedAt">,
  metadataError: string | null,
  now: Date,
): Pick<WorkerDriftAlarmState, "firstApiErrorAt" | "lastApiErrorAlarmedAt"> {
  if (!metadataError) {
    return { firstApiErrorAt: null, lastApiErrorAlarmedAt: null };
  }
  return {
    firstApiErrorAt: previous.firstApiErrorAt ?? now.toISOString(),
    lastApiErrorAlarmedAt: previous.lastApiErrorAlarmedAt,
  };
}

/**
 * Pura — `true` quando a falha da consulta já persiste por >=
 * `API_ERROR_SUSTAINED_THRESHOLD_MS` E ainda não foi alarmada NESTA série
 * (idempotente: uma vez alarmado, só alarma de novo depois que a série
 * resolver — sucesso reseta `firstApiErrorAt`/`lastApiErrorAlarmedAt` via
 * `advanceApiErrorState` — e uma NOVA série atingir o threshold de novo).
 * Recebe o estado JÁ avançado por `advanceApiErrorState` desta mesma
 * execução (não o estado bruto anterior) — é o `firstApiErrorAt` da série
 * corrente que importa pro cálculo de duração.
 */
export function shouldAlarmApiError(
  nextApiErrorState: Pick<WorkerDriftAlarmState, "firstApiErrorAt" | "lastApiErrorAlarmedAt">,
  metadataError: string | null,
  now: Date,
  thresholdMs: number = API_ERROR_SUSTAINED_THRESHOLD_MS,
): boolean {
  if (!metadataError) return false;
  if (!nextApiErrorState.firstApiErrorAt) return false;
  if (nextApiErrorState.lastApiErrorAlarmedAt) return false;
  return now.getTime() - Date.parse(nextApiErrorState.firstApiErrorAt) >= thresholdMs;
}

/**
 * Pura — `true` quando há drift pendente E o fingerprint é diferente do
 * último já alarmado (drift novo, mudou de shape, ou reapareceu depois de
 * resolvido — ver docstring do módulo).
 */
export function shouldAlarm(state: WorkerDriftAlarmState, results: readonly WorkerDriftResult[]): boolean {
  if (!hasPendingDrift(results)) return false;
  return computeDriftFingerprint(results) !== state.lastAlarmedFingerprint;
}

/**
 * Pura — `false` quando o cursor de idempotência NÃO deve ser persistido
 * nesta execução: `--dry-run` (nunca grava) OU falha da consulta Cloudflair
 * para a conta inteira (`metadataError` presente).
 *
 * #4723 fleet review, achado 1: sem este guard, uma falha de API faz TODO
 * worker cair em `status: "error"`, `hasPendingDrift` exclui `"error"` (só
 * conta `drift`/`never_deployed`), então `pending = false` e o main()
 * gravaria `advanceState(null, now)` — resetando `lastAlarmedFingerprint`
 * pra `null` mesmo que um drift REAL já alarmado continuasse pendente. A
 * PRÓXIMA execução bem-sucedida recomputaria o mesmo fingerprint e
 * re-alarmaria, duplicando um e-mail que o editor já recebeu. Sem dado
 * confiável nesta execução (falha de conta inteira), o correto é preservar
 * o estado anterior intacto — mesmo espírito do `--dry-run` (nunca avança
 * cursor sem convicção do resultado).
 */
export function shouldAdvanceState(opts: { isDryRun: boolean; metadataError: string | null }): boolean {
  return !opts.isDryRun && !opts.metadataError;
}

// ─── Corpo do e-mail de alarme (puro) ──────────────────────────────────────

export function formatDuration(ms: number): string {
  const hours = ms / (1000 * 60 * 60);
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const days = hours / 24;
  return `${days.toFixed(1)} dia(s)`;
}

/** Pura — monta assunto + corpo do e-mail de alarme (texto puro, mesmo
 * padrão de `scripts/lib/gmail-send.ts`/`apoios-diff-alarm.ts`, sem HTML).
 * Lista só os workers com `status` "drift"/"never_deployed"; workers "error"
 * entram numa seção separada de aviso (não bloqueiam o alarme dos demais). */
export function buildWorkerDriftAlarmEmail(
  results: readonly WorkerDriftResult[],
  now: Date = new Date(),
): { subject: string; body: string } {
  const drifted = results.filter((r) => r.status === "drift" || r.status === "never_deployed");
  const errored = results.filter((r) => r.status === "error");

  const subject = `[diar.ia.br] ${drifted.length} worker(s) com deploy defasado`;

  const lines: string[] = [
    "O check de drift entre o código publicado de cada Worker e o master",
    "local encontrou worker(s) com commit mais recente que o último deploy.",
    "",
    `Worker(s) defasado(s) (${drifted.length}):`,
  ];

  for (const r of drifted) {
    const ago = r.driftMs !== null ? formatDuration(r.driftMs) : "?";
    const deployInfo =
      r.status === "never_deployed" ? "nunca deployado" : `último deploy: ${r.lastDeployedAt}`;
    lines.push(
      `  - ${r.workerName} (workers/${r.workerDir}/): drift há ~${ago} — último commit: ${r.lastCommitAt}, ${deployInfo}`,
    );
    lines.push(`    Deploy: cd workers/${r.workerDir} && npx wrangler deploy`);
  }

  if (errored.length > 0) {
    lines.push(
      "",
      `Aviso — ${errored.length} worker(s) não puderam ser checados (não bloqueou o alarme acima):`,
    );
    for (const r of errored) {
      lines.push(`  - ${r.workerName} (workers/${r.workerDir}/): ${r.message}`);
    }
  }

  lines.push("", `(alarme automático — checagem rodou em ${now.toISOString()})`);

  return { subject, body: lines.join("\n") };
}

/**
 * Pura — assunto + corpo do e-mail de "não consigo checar drift há muito
 * tempo" (#4746): DISTINTO do alarme de drift em si (`buildWorkerDriftAlarmEmail`)
 * — dispara quando a consulta à Cloudflare API vem falhando de forma
 * SUSTENTADA (`shouldAlarmApiError`), não quando um drift real foi
 * encontrado. Sem este alarme separado, uma credencial expirada/revogada faz
 * TODO worker cair em `status: "error"` (`hasPendingDrift` exclui "error"),
 * `shouldAlarm` nunca dispara, e nenhum e-mail é enviado indefinidamente —
 * mesmo que um drift real esteja acontecendo nesse meio-tempo, sem sinal
 * nenhum pro editor.
 */
export function buildApiErrorAlarmEmail(
  metadataError: string,
  firstApiErrorAt: string,
  now: Date = new Date(),
): { subject: string; body: string } {
  const elapsedMs = Math.max(0, now.getTime() - Date.parse(firstApiErrorAt));
  const ago = formatDuration(elapsedMs);

  const subject = "[diar.ia.br] Não consigo checar drift de Workers há muito tempo";

  const body = [
    "A consulta à Cloudflare Workers API (GET /accounts/{account}/workers/scripts,",
    `usada por scripts/worker-drift-check.ts) vem falhando continuamente há ~${ago}`,
    `(desde ${firstApiErrorAt}) — nenhum worker teve dado confiável nesse período,`,
    "então um drift real nesse meio-tempo não teria sido detectado nem alarmado.",
    "",
    `Último erro: ${metadataError}`,
    "",
    "Verifique se CLOUDFLARE_WORKERS_TOKEN expirou/foi revogado (ou",
    "CLOUDFLARE_ACCOUNT_ID mudou) e confirme com:",
    "",
    "  npx tsx scripts/worker-drift-check.ts --dry-run",
    "",
    `(alarme automático — checagem rodou em ${now.toISOString()})`,
  ].join("\n");

  return { subject, body };
}
