/**
 * scripts/lib/systemd-unit-state.ts (#7210)
 *
 * Extraído de `scripts/arm-systemd-timers.ts` (#4828) — consulta pontual do
 * estado de UM unit systemd (`LoadState`/`ActiveState`) via `systemctl --user
 * show <unit>`. `arm-systemd-timers.ts` já usava isto pra distinguir "timer
 * nunca existiu" (`LoadState=not-found`, sempre arma) de "timer existe mas
 * está inativo" (`ActiveState=inactive` com `LoadState` != not-found —
 * parado deliberadamente via `systemctl --user stop`, guard `--rearm-stopped`).
 *
 * `Diaria-Task-Never-Armed-Alarm` (`scripts/task-never-armed-alarm.ts`,
 * #5607) precisava do MESMO sinal — antes desta issue, ele só cruzava contra
 * `systemctl --user list-timers --all` (presença/ausência), que não
 * distingue as duas situações, produzindo o mesmo achado/prescrição pra
 * "nunca configurada" e "parada de propósito pelo editor". Movido pra um
 * módulo `lib/` compartilhado em vez de importar `scripts/arm-systemd-timers.ts`
 * dentro de `scripts/task-never-armed-alarm.ts` (que por sua vez já é
 * importado por `arm-systemd-timers.ts`) — import circular entre os dois
 * scripts.
 *
 * @see scripts/arm-systemd-timers.ts (consumidor original, `--rearm-stopped`)
 * @see scripts/lib/task-never-armed-alarm.ts (consumidor novo, `classifyNeverArmedStatus`)
 */
import { execFileSync } from "node:child_process";

export interface SystemdUnitState {
  loadState: string;
  activeState: string;
}

/**
 * Parseia a saída de `systemctl --user show <unit> --property=LoadState,ActiveState`
 * — 2 linhas `Chave=Valor` (ordem não garantida). Chave ausente/output
 * malformado vira string vazia, nunca lança. @pure
 */
export function parseUnitStateOutput(output: string): SystemdUnitState {
  const lines = output.split(/\r?\n/);
  let loadState = "";
  let activeState = "";
  for (const line of lines) {
    const m = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === "LoadState") loadState = m[2].trim();
    if (m[1] === "ActiveState") activeState = m[2].trim();
  }
  return { loadState, activeState };
}

export interface QueryUnitStateResult {
  state: SystemdUnitState | null;
  /** Motivo de `state === null` — `null` no caminho de sucesso. `systemctl
   * show` NÃO lança pra unit ausente (devolve `LoadState=not-found`,
   * `ActiveState=inactive`, exit 0) — só chega aqui em falha real de
   * infraestrutura (systemctl ausente, bus indisponível, erro inesperado). */
  error: string | null;
}

/**
 * Consulta `systemctl --user show <unit> --property=LoadState,ActiveState`.
 * Ao contrário de `is-enabled`/`is-active` (que exigem tratar "exceção com
 * stdout 'not-found'" como caminho de sucesso disfarçado), `show` sempre sai
 * com exit 0 e reporta o estado via as duas propriedades — dá, numa única
 * chamada, tanto "existe?" (`loadState`) quanto "está rodando agora?"
 * (`activeState`). Só `is-active` sozinho não diferencia "nunca existiu" de
 * "parada deliberadamente" (as duas retornam `inactive`).
 *
 * `exec` injetável (default = `execFileSync` real) — nunca spawna
 * `systemctl` de verdade em teste.
 */
export function queryUnitState(unit: string, exec: typeof execFileSync = execFileSync): QueryUnitStateResult {
  try {
    const out = exec("systemctl", ["--user", "show", unit, "--property=LoadState,ActiveState"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as string;
    return { state: parseUnitStateOutput(String(out ?? "")), error: null };
  } catch (e: unknown) {
    const err = e as { code?: string; stderr?: string };
    if (err.code === "ENOENT") {
      return { state: null, error: "systemctl indisponível (ENOENT) nesta consulta." };
    }
    const stderrText = String(err.stderr ?? "").trim();
    return {
      state: null,
      error:
        `systemctl show falhou ao consultar '${unit}' — não foi possível confirmar o estado atual` +
        (stderrText ? ` (stderr: ${stderrText.slice(0, 200)})` : "") +
        ".",
    };
  }
}
