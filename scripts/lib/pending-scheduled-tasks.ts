/**
 * pending-scheduled-tasks.ts (#4708 Parte 1)
 *
 * Detecta tasks do Task Scheduler que estão DECLARADAS num
 * `scripts/**\/setup-*-schedule.ps1` mas nunca foram de fato registradas
 * nesta máquina — o padrão que a issue #4708 mediu ao vivo em 06/08: três
 * tasks (`Diaria-Brevo-Diaria-Evaluate` #4534, `Diaria-Apoios-Diff-Alarm`
 * #4485, `Diaria-Cursos-Error-Alarm` #4320/#4382) mergearam, testaram, e
 * ficaram órfãs do único passo que só roda na máquina do editor — a única
 * memória disso era um parágrafo no CLAUDE.md que ninguém relia.
 *
 * Fonte determinística e barata: cruzar o `$TaskName = "..."` declarado
 * dentro de cada script de setup contra as tasks REALMENTE presentes no
 * Task Scheduler (`Get-ScheduledTask -TaskName 'Diaria-*'`).
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
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { detectExecMode, type ExecMode } from "./exec-mode.ts";
import { isMainModule } from "./cli-args.ts";

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
 * Extrai o valor de `$TaskName = "..."` do source de um `setup-*-schedule.ps1`.
 * **Lança** (não retorna `null`) quando o padrão não é encontrado — ver
 * docstring do módulo: este é o ponto frágil que a issue #4708 pediu pra
 * nunca falhar em silêncio.
 */
export function parseTaskNameFromSetupScript(source: string, scriptPathForError: string): string {
  const m = source.match(/\$TaskName\s*=\s*"([^"]+)"/);
  if (!m) {
    throw new Error(
      `[pending-scheduled-tasks] não encontrei '$TaskName = "..."' em ${scriptPathForError} — ` +
        `o parser depende desse padrão literal (aspas duplas). Se o script mudou de convenção, ` +
        `atualize o regex em parseTaskNameFromSetupScript (scripts/lib/pending-scheduled-tasks.ts); ` +
        `sem isso o diff de tasks pendentes fica vazio SILENCIOSAMENTE e o relatório mente por omissão.`,
    );
  }
  return m[1];
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
 * Descobre TODOS os `setup-*-schedule.ps1` sob `{rootDir}/scripts` (recursivo
 * — cobre tanto `scripts/setup-*.ps1` quanto `scripts/overnight/setup-*.ps1`)
 * e extrai o `$TaskName` declarado em cada um. Ordenado por `taskName` para
 * output determinístico.
 *
 * Propaga a exceção de `parseTaskNameFromSetupScript` sem capturar — um
 * script que não bate o padrão esperado deve travar a listagem inteira
 * (fail LOUD), nunca ser descartado silenciosamente da lista de esperadas.
 */
export function listExpectedScheduledTasks(rootDir: string): SetupScriptTaskName[] {
  const rootAbs = resolve(rootDir);
  const scriptsDir = resolve(rootAbs, "scripts");
  const files = setupScheduleFilesUnder(scriptsDir);
  const result = files.map((full): SetupScriptTaskName => {
    const rel = full.startsWith(rootAbs + sep) ? full.slice(rootAbs.length + 1) : full;
    const scriptPath = rel.split(sep).join("/");
    const source = readFileSync(full, "utf8");
    const taskName = parseTaskNameFromSetupScript(source, scriptPath);
    return { scriptPath, taskName };
  });
  return result.sort((a, b) => a.taskName.localeCompare(b.taskName));
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
