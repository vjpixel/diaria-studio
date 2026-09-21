/**
 * scripts/lib/list-processes.ts (#8661)
 *
 * Enumeração de processos vivos com cmdline completo — POSIX apenas (Linux/
 * macOS via `ps -eo pid=,ppid=,args=`). Extraído como módulo próprio porque
 * duas features precisam da mesma pergunta ("que processos existem, com que
 * cmdline?"): `scripts/orphaned-test-process-sweep.ts` (varre a máquina
 * inteira atrás de processos `--test-isolation=process` cujo worktree já
 * não existe) e `removeWorktreeSafe` em `scripts/cleanup-merged-worktrees.ts`
 * (checa se algum processo ainda referencia o path antes de
 * `git worktree remove --force`). Sem este módulo compartilhado, o parsing
 * de `ps` seria duplicado nos dois lugares.
 *
 * Windows: sem implementação (retorna `[]`, fail-soft) — o incidente de
 * origem (#8661) foi medido no servidor Linux ("300"), onde processos de
 * teste ficam órfãos por dias rodando `--test` dentro de worktrees já
 * removidos (rodadas overnight/develop/continuo desassistidas, o único
 * lugar onde um worktree é removido enquanto um teste ainda roda dentro
 * dele). Mesmo escopo documentado de `claude-session-version-drift-alarm.ts`
 * (#6927) — Linux-only por decisão, não omissão; o chamador decide o que
 * fazer com uma lista vazia (item 2, `removeWorktreeSafe`, trata `[]` como
 * "nenhum processo vivo encontrado" e segue com a remoção normalmente —
 * comportamento idêntico ao pré-#8661 no Windows).
 */
import { execFileSync } from "node:child_process";

export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  /** Cmdline completo (`args=` do `ps` — argv concatenado, não só o nome do binário). */
  readonly cmd: string;
}

export interface ListProcessesOps {
  execFileSync: typeof execFileSync;
  platform: NodeJS.Platform;
}

const defaultOps: ListProcessesOps = { execFileSync, platform: process.platform };

/**
 * Faz o parsing da saída bruta de `ps -eo pid=,ppid=,args=` — puro,
 * testável sem precisar rodar `ps` de verdade. Uma linha que não bate o
 * formato esperado (`PID PPID ARGS...`) é silenciosamente ignorada (linha
 * em branco final do `ps`, por exemplo) — nunca lança.
 */
export function parsePsOutput(raw: string): ProcessInfo[] {
  const result: ProcessInfo[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pidStr, ppidStr, cmd] = match;
    const pid = Number(pidStr);
    const ppid = Number(ppidStr);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    result.push({ pid, ppid, cmd });
  }
  return result;
}

/**
 * Enumera todo processo vivo da máquina com PID/PPID/cmdline completo.
 * `[]` em qualquer plataforma que não seja POSIX (ver docstring do módulo).
 *
 * `ps` falhando PROPAGA (mesmo racional do #6953 em
 * `claude-session-version-drift-alarm.ts`): numa plataforma POSIX, `ps`
 * sempre está presente — uma falha aqui é ela mesma uma anomalia do host
 * (binário quebrado, `/proc` indisponível, recurso exaurido), nunca
 * "confirmado: zero processos". Tratar como lista vazia faria exatamente o
 * oposto do que este módulo existe pra evitar: um sweep que não acha nada
 * porque não conseguiu OLHAR, relatando como se tivesse olhado e achado
 * limpo.
 */
export function listAllProcesses(ops: ListProcessesOps = defaultOps): ProcessInfo[] {
  if (ops.platform === "win32") return [];
  const raw = ops.execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return parsePsOutput(raw);
}

/**
 * Relê PPID/cmdline de UM PID específico, agora — `null` se o PID não
 * existe mais (já morreu; `ps -p` sai não-zero sem stdout) ou em plataforma
 * não suportada. Existe pra reverificação imediatamente antes de um kill
 * (#8661, achado do fleet review da PR #8692): entre o snapshot de
 * `listAllProcesses()` e o momento do `kill`, o processo original pode ter
 * morrido e o SO reciclado o PID pra um processo novo, completamente
 * não-relacionado — `process.kill(pid, "SIGKILL")` nesse caso mata o
 * processo ERRADO, com sucesso, sem exceção, sem qualquer sinal de que
 * algo deu errado. Quem chama isto deve comparar o resultado (PPID e
 * cmdline) contra o que motivou o kill ANTES de executá-lo — nunca confiar
 * cegamente no snapshot antigo.
 */
export function readProcessNow(pid: number, ops: ListProcessesOps = defaultOps): ProcessInfo | null {
  if (ops.platform === "win32") return null;
  try {
    // `-o ppid=,args=` (2 campos, sem `pid=` — já sabemos qual é) —
    // formato PROPOSITALMENTE diferente do `-eo pid=,ppid=,args=` de
    // `listAllProcesses`, então faz o próprio parsing em vez de reusar
    // `parsePsOutput` (que espera 3 campos, PID primeiro).
    const raw = ops.execFileSync("ps", ["-p", String(pid), "-o", "ppid=,args="], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const match = trimmed.match(/^(\d+)\s+([\s\S]*)$/);
    if (!match) return null;
    const ppid = Number(match[1]);
    if (!Number.isFinite(ppid)) return null;
    return { pid, ppid, cmd: match[2] };
  } catch {
    return null; // `ps -p` sai não-zero quando o PID não existe mais
  }
}
