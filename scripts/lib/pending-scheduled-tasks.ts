/**
 * pending-scheduled-tasks.ts (#4708 Parte 1, refatorado #4805 Fase 1)
 *
 * Detecta tasks do Task Scheduler que estão DECLARADAS mas nunca foram de
 * fato registradas nesta máquina — o padrão que a issue #4708 mediu ao vivo
 * em 06/08: três tasks (`Diaria-Brevo-Diaria-Evaluate` #4534,
 * `Diaria-Apoios-Diff-Alarm` #4485, `Diaria-Cursos-Error-Alarm`
 * #4320/#4382) mergearam, testaram, e ficaram órfãs do único passo que só
 * roda na máquina do editor — a única memória disso era um parágrafo no
 * CLAUDE.md que ninguém relia.
 *
 * **Fonte de "esperadas" (#4805): registro declarativo como PRIMÁRIA, scan
 * legado como FALLBACK.** Até o #4805, a lista de esperadas vinha inteira de
 * varrer `scripts/**\/setup-*-schedule.ps1` e extrair `$TaskName` por regex.
 * Agora `listExpectedScheduledTasks` primeiro consulta
 * `scripts/lib/scheduled-tasks.ts` (`SCHEDULED_TASKS` — as 14 tasks já
 * migradas pro registro TS) e só cai no scanner legado (mesmo regex de
 * sempre) pra `setup-*-schedule.ps1` que NÃO tenham `legacySetupScript`
 * correspondente no registro — hoje só `Diaria-Overnight-Watchdog` e
 * `Diaria-Edicao-Diaria` (runners fora do padrão `npx tsx <script>.ts` que o
 * registro modela; ver docstring de `scheduled-tasks.ts`). Uma entrada do
 * registro só conta se o `.ps1` legado dela também existir sob `rootDir` —
 * isso é o que mantém os testes com fixtures isoladas (`test/pending-
 * scheduled-tasks.test.ts`) controlando o universo completo de tasks sem
 * "vazamento" das 14 reais do repo pra dentro de um diretório de teste vazio.
 *
 * Fonte determinística e barata: cruzar essa lista de esperadas contra as
 * tasks REALMENTE presentes no Task Scheduler (`Get-ScheduledTask -TaskName
 * 'Diaria-*'`).
 *
 * **Por que PowerShell (`Get-ScheduledTask`) e não `schtasks` (#2814):** o
 * `check-watchdog-armed.ts` já documentou que `schtasks /query /fo LIST`
 * emite rótulos localizados (PT-BR: "Nome da Tarefa:" em vez de "TaskName:"),
 * quebrando parsers textuais em Windows não-EN. `Get-ScheduledTask` não tem
 * esse problema: é um cmdlet .NET — nomes de propriedade (`TaskName`) são
 * fixos independente do locale de exibição do Windows, só as MENSAGENS de
 * erro/log são traduzidas (que este módulo nunca parseia — só o valor da
 * propriedade `TaskName` via `Select-Object -ExpandProperty`).
 *
 * **Ponto frágil documentado na issue: o parsing do `-TaskName` a partir do
 * `.ps1`.** Se o padrão `$TaskName = "..."` mudar de convenção num script
 * novo/editado e o regex daqui não acompanhar, o diff vira vazio
 * silenciosamente e o relatório "mente por omissão" — reporta 0 pendências
 * quando na verdade o parser é que quebrou. Por isso
 * `parseTaskNameFromSetupScript` **lança** (não retorna `null`) quando não
 * encontra o padrão — barulhento de propósito, coberto por
 * `test/pending-scheduled-tasks.test.ts` contra TODOS os `.ps1` reais do
 * repo (não só fixtures), pra travar a regressão o mais cedo possível.
 *
 * **Fail-soft no restante do pipeline (#738):** falha ao consultar o Task
 * Scheduler (PowerShell indisponível, plataforma não-Windows, erro de
 * execução) retorna `pending: null` — nunca `[]` — porque `[]` seria
 * indistinguível de "0 pendências de verdade" e o relatório mentiria por
 * omissão do mesmo jeito que um parser quebrado mentiria. Só uma consulta
 * bem-sucedida com diff vazio produz `pending: []`.
 *
 * **Sessão cloud é no-op** (mesmo sinal de `scripts/lib/exec-mode.ts`,
 * #2643) — Task Scheduler é recurso local, um clone fresco nunca tem
 * `data/` nem PowerShell relevante pra checar.
 *
 * Uso como CLI (fecho de rodada — `/diaria-overnight` Fase 2,
 * `/diaria-develop` Fase 2):
 *   ```bash
 *   npx tsx scripts/lib/pending-scheduled-tasks.ts
 *   # imprime a seção markdown pronta pro relatório (ou nada, se não há
 *   # pendência / sessão cloud / consulta falhou) — exit 0 sempre.
 *   ```
 *
 * @see scripts/lib/check-watchdog-armed.ts (#2814 — mesmo domínio de
 *      problema, precedente pro locale-agnosticism)
 * @see scripts/lib/exec-mode.ts (#2643 — sinal cloud/local)
 * @see scripts/send-edition-report.ts (consumidor no relatório de edição)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { detectExecMode, type ExecMode } from "./exec-mode.ts";
import { isMainModule } from "./cli-args.ts";
import { SCHEDULED_TASKS } from "./scheduled-tasks.ts";

/** Nome de task esperado, extraído de um script de setup. */
export interface SetupScriptTaskName {
  /** Path relativo ao repo root, POSIX-style (ex: "scripts/setup-apoios-diff-alarm-schedule.ps1"). */
  scriptPath: string;
  taskName: string;
}

// ---------------------------------------------------------------------------
// Parser puro (testável com fixtures de string — nunca toca disco/Task Scheduler)
// ---------------------------------------------------------------------------

/**
 * Extrai TODOS os nomes de task declarados num `setup-*-schedule.ps1`, na
 * ordem em que aparecem no source.
 *
 * Até #5027 a suposição era 1 script de setup ⇒ 1 task, e o parser lia só
 * `$TaskName`. `scripts/setup-clarice-envio-schedule.ps1` (automação do envio
 * Clarice) quebrou essa suposição de propósito: ele registra o PAR
 * `Diaria-Clarice-Envio` (19:00, planeja+agenda) e `Diaria-Clarice-Envio-Guard`
 * (05:00, reavalia o freio antes do disparo) num script só, porque armar uma
 * sem a outra é uma configuração que ninguém quer. Se o parser continuasse
 * lendo só a primeira, a task-guard ficaria invisível pro diff do #4708 —
 * exatamente o modo de falha "mente por omissão" que este módulo existe pra
 * impedir.
 *
 * O padrão aceito é `$<qualquer coisa>TaskName = "..."` (aspas duplas):
 * `$TaskName` no script de task única, `$TaskName` + `$GuardTaskName` no
 * script do par. **Lança** (não retorna `[]`) quando NENHUM nome é
 * encontrado — ver docstring do módulo.
 */
export function parseTaskNamesFromSetupScript(source: string, scriptPathForError: string): string[] {
  const names = [...source.matchAll(/\$\w*TaskName\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  if (names.length === 0) {
    throw new Error(
      `[pending-scheduled-tasks] não encontrei '$TaskName = "..."' em ${scriptPathForError} — ` +
        `o parser depende desse padrão literal (aspas duplas). Se o script mudou de convenção, ` +
        `atualize o regex em parseTaskNamesFromSetupScript (scripts/lib/pending-scheduled-tasks.ts); ` +
        `sem isso o diff de tasks pendentes fica vazio SILENCIOSAMENTE e o relatório mente por omissão.`,
    );
  }
  return names;
}

/**
 * Primeiro nome de task declarado num `setup-*-schedule.ps1` — conveniência
 * sobre `parseTaskNamesFromSetupScript` pros callers que sabem estar diante
 * de um script de task única. **Lança** nas mesmas condições dela, E TAMBÉM
 * quando o script declara MAIS de 1 nome (achado do type-design-analyzer no
 * review do #5027): antes, um script multi-task passando por aqui perdia a
 * 2ª task em silêncio — `[0]` sem checar `length` é o mesmo "mente por
 * omissão" que este módulo inteiro existe pra evitar, só que num lugar
 * novo.
 *
 * Ainda é o caminho usado por `fromLegacyScan` em `listExpectedScheduledTasks`
 * — mas nunca recebe um script multi-task em produção, porque
 * `scripts/setup-clarice-envio-schedule.ps1` (o único hoje) é coberto pelo
 * registro (`fromRegistry`, 2 entradas com o mesmo `legacySetupScript`) e
 * fica de fora do scan legado via `registeredScriptPaths`. O guard acima
 * existe pro próximo script multi-task que ainda não tiver entrada no
 * registro — sem ele, a 2ª+ task desse script ficaria invisível em silêncio
 * dentro do `fromLegacyScan`.
 */
export function parseTaskNameFromSetupScript(source: string, scriptPathForError: string): string {
  const names = parseTaskNamesFromSetupScript(source, scriptPathForError);
  if (names.length > 1) {
    throw new Error(
      `[pending-scheduled-tasks] ${scriptPathForError} declara ${names.length} tasks (${names.join(", ")}) ` +
        `mas parseTaskNameFromSetupScript espera exatamente 1 — use parseTaskNamesFromSetupScript no ` +
        `caminho de descoberta/diff (senão a 2ª+ task fica invisível em silêncio).`,
    );
  }
  return names[0];
}

/** Lista `.ps1` recursivamente sob `dir` cujo basename bate `setup-*-schedule.ps1`
 * (mesmo padrão de varredura recursiva de `test/scheduled-task-registration.test.ts`). */
function setupScheduleFilesUnder(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...setupScheduleFilesUnder(full));
    } else if (/^setup-.*-schedule\.ps1$/i.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Lista as tasks esperadas: registro declarativo (`SCHEDULED_TASKS`, #4805)
 * como fonte PRIMÁRIA — só entram as entradas cujo `legacySetupScript`
 * também existe sob `rootDir` (ver docstring do módulo pro porquê disso) —
 * mais um FALLBACK que varre `{rootDir}/scripts` recursivamente (mesmo
 * scanner de sempre, cobre `scripts/setup-*.ps1` e
 * `scripts/overnight/setup-*.ps1`) por `setup-*-schedule.ps1` cujo path NÃO
 * está coberto por nenhuma entrada do registro — hoje só as tasks ainda não
 * migradas (`Diaria-Overnight-Watchdog`, `Diaria-Edicao-Diaria`). Ordenado
 * por `taskName` para output determinístico.
 *
 * Propaga a exceção de `parseTaskNameFromSetupScript` sem capturar — um
 * `.ps1` fora do registro que não bate o padrão esperado deve travar a
 * listagem inteira (fail LOUD), nunca ser descartado silenciosamente da
 * lista de esperadas.
 */
export function listExpectedScheduledTasks(rootDir: string): SetupScriptTaskName[] {
  const rootAbs = resolve(rootDir);

  // #5005: `legacySetupScript` é opcional (task registrada depois do
  // cutover systemd não tem `.ps1` legado) — essas entradas nunca entram em
  // `fromRegistry` por design: o check "task esperada ausente do Task
  // Scheduler" pressupõe uma contraparte Windows que não existe pra elas.
  const fromRegistry: SetupScriptTaskName[] = [];
  for (const t of SCHEDULED_TASKS) {
    if (!t.legacySetupScript) continue;
    if (existsSync(resolve(rootAbs, ...t.legacySetupScript.split("/")))) {
      fromRegistry.push({ scriptPath: t.legacySetupScript, taskName: t.name });
    }
  }
  const registeredScriptPaths = new Set(fromRegistry.map((t) => t.scriptPath));

  const scriptsDir = resolve(rootAbs, "scripts");
  const files = setupScheduleFilesUnder(scriptsDir);
  // #5027: filtra os arquivos JÁ cobertos pelo registro ANTES de parsear —
  // não depois. Um script coberto pelo registro pode declarar mais de 1 task
  // (setup-clarice-envio-schedule.ps1 tem $TaskName E $GuardTaskName) e a
  // singular `parseTaskNameFromSetupScript` LANÇA nesse caso (guard do
  // #5027, ver docstring da função) — se o filtro rodasse só depois do
  // `.map()` como antes, o próprio scan real do repo quebraria tentando
  // reparsear um arquivo que o registro já resolveu corretamente.
  const fromLegacyScan: SetupScriptTaskName[] = files
    .filter((full) => {
      const rel = full.startsWith(rootAbs + sep) ? full.slice(rootAbs.length + 1) : full;
      return !registeredScriptPaths.has(rel.split(sep).join("/"));
    })
    .map((full): SetupScriptTaskName => {
      const rel = full.startsWith(rootAbs + sep) ? full.slice(rootAbs.length + 1) : full;
      const scriptPath = rel.split(sep).join("/");
      const source = readFileSync(full, "utf8");
      const taskName = parseTaskNameFromSetupScript(source, scriptPath);
      return { scriptPath, taskName };
    });

  return [...fromRegistry, ...fromLegacyScan].sort((a, b) => a.taskName.localeCompare(b.taskName));
}

// ---------------------------------------------------------------------------
// Diff puro
// ---------------------------------------------------------------------------

/** Diff puro: tasks esperadas (dos scripts de setup) que NÃO aparecem na
 * lista de tasks registradas (comparação case-insensitive — Task Scheduler
 * do Windows não é case-sensitive em nome de task). */
export function computePendingScheduledTasksDiff(
  expected: SetupScriptTaskName[],
  registered: string[],
): SetupScriptTaskName[] {
  const registeredSet = new Set(registered.map((r) => r.trim().toLowerCase()));
  return expected.filter((e) => !registeredSet.has(e.taskName.toLowerCase()));
}

/** Seção markdown pronta pro relatório de fim de rodada — `null` quando não
 * há pendência (não polui rodada limpa, #4708). */
export function buildPendingScheduledTasksSection(pending: SetupScriptTaskName[]): string | null {
  if (pending.length === 0) return null;
  const lines = pending.map((p) => `- \`${p.taskName}\` — não registrada (setup: \`${p.scriptPath}\`)`);
  return [
    "## Tasks pendentes de registro (#4708)",
    "",
    `${pending.length} task${pending.length === 1 ? "" : "s"} declarada${pending.length === 1 ? "" : "s"} ` +
      `em script(s) de setup mas AUSENTE(S) do Task Scheduler desta máquina — provavelmente um PR ` +
      `implementou/testou o script sem rodar o registro real (ver CLAUDE.md, "ação pendente do editor").`,
    "",
    ...lines,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// I/O: consulta real ao Task Scheduler (impuro — não coberto por teste)
// ---------------------------------------------------------------------------

/**
 * Consulta as tasks REGISTRADAS cujo nome começa com `Diaria-` via
 * PowerShell `Get-ScheduledTask` (locale-agnóstico — ver docstring do
 * módulo). Retorna `null` em qualquer falha (PowerShell indisponível,
 * plataforma não-Windows, erro de execução) — fail-soft: `null` é
 * distinguível de `[]` (0 tasks registradas de verdade) exatamente pra
 * `checkPendingScheduledTasks` nunca confundir "não consegui checar" com
 * "não achei nenhuma".
 *
 * `exec` injetável (default `execFileSync` real) — mesmo padrão de
 * `check-watchdog-armed.ts::queryWatchdogTaskExitCode`, pra testar sem
 * PowerShell real nem module-mocking experimental do Node.
 */
export function queryRegisteredTaskNames(exec: typeof execFileSync = execFileSync): string[] | null {
  try {
    const out = exec(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-ScheduledTask -TaskName 'Diaria-*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty TaskName",
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    ) as unknown as string | Buffer;
    const text = typeof out === "string" ? out : out.toString("utf-8");
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Orquestração (impura)
// ---------------------------------------------------------------------------

export interface PendingScheduledTasksResult {
  mode: ExecMode;
  /** `null` quando fora de escopo (cloud) ou quando a checagem falhou
   * (listagem de scripts quebrou, ou consulta ao Task Scheduler falhou) —
   * nunca confundir com `[]` (checagem OK, 0 pendências). */
  pending: SetupScriptTaskName[] | null;
  /** Seção markdown pronta pro relatório — `null` quando não há nada a
   * mostrar (cloud, falha na checagem, ou diff vazio). */
  section: string | null;
}

/**
 * Checagem completa, fail-soft: nunca lança. Em sessão cloud, no-op
 * (Task Scheduler não se aplica). Em sessão local, lista as tasks esperadas
 * (via `listExpectedScheduledTasks` — pode lançar por parsing quebrado,
 * capturado aqui e convertido em warning + `pending: null`, nunca em
 * `pending: []`), consulta as registradas, e calcula o diff.
 */
export function checkPendingScheduledTasks(rootDir: string = resolve(process.cwd())): PendingScheduledTasksResult {
  const mode = detectExecMode({ projectRoot: rootDir });
  if (mode === "cloud") {
    return { mode, pending: null, section: null };
  }

  let expected: SetupScriptTaskName[];
  try {
    expected = listExpectedScheduledTasks(rootDir);
  } catch (e) {
    console.warn(
      `[pending-scheduled-tasks] falha ao listar tasks esperadas dos scripts de setup — checagem pulada (fail-soft, nunca reporta '0 pendências' por causa disso): ${(e as Error).message}`,
    );
    return { mode, pending: null, section: null };
  }

  const registered = queryRegisteredTaskNames();
  if (registered === null) {
    console.warn(
      `[pending-scheduled-tasks] não foi possível consultar o Task Scheduler (PowerShell indisponível ou erro de execução) — checagem pulada.`,
    );
    return { mode, pending: null, section: null };
  }

  const pending = computePendingScheduledTasksDiff(expected, registered);
  return { mode, pending, section: buildPendingScheduledTasksSection(pending) };
}

// ---------------------------------------------------------------------------
// CLI guard: só executa como main module, importável sem efeito colateral.
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const result = checkPendingScheduledTasks();
  if (result.section) {
    console.log(result.section);
  } else if (result.mode === "cloud") {
    console.log("[pending-scheduled-tasks] sessão cloud — Task Scheduler não se aplica.");
  } else if (result.pending === null) {
    console.log("[pending-scheduled-tasks] checagem indisponível nesta rodada (fail-soft — ver warning acima).");
  } else {
    console.log("[pending-scheduled-tasks] nenhuma pendência — todas as tasks esperadas estão registradas.");
  }
}
