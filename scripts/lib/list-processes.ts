/**
 * scripts/lib/list-processes.ts (#8661)
 *
 * Enumeração de processos vivos com cmdline completo: POSIX via `ps -eo
 * pid=,ppid=,args=` (`listAllProcesses`) e, desde o #14335, Windows via CIM
 * (`listWindowsProcesses`, usado só pelos guards de remoção de worktree, fim
 * do arquivo). Extraído como módulo próprio porque
 * duas features precisam da mesma pergunta ("que processos existem, com que
 * cmdline?"): `scripts/orphaned-test-process-sweep.ts` (varre a máquina
 * inteira atrás de processos `--test-isolation=process` cujo worktree já
 * não existe) e `removeWorktreeSafe` em `scripts/cleanup-merged-worktrees.ts`
 * (checa se algum processo ainda referencia o path antes de
 * `git worktree remove --force`). Sem este módulo compartilhado, o parsing
 * de `ps` seria duplicado nos dois lugares.
 *
 * Windows: `listAllProcesses` sem implementação (retorna `[]`, fail-soft).
 * Desde o #14335 o guard de remoção de worktree usa
 * `listProcessesForWorktreeGuard` (fim do arquivo), que no Windows lê o CIM;
 * o sweep que mata processo continua POSIX-only. O incidente de
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
  /** #14335: PID que uma listagem válida tem que conter (default `process.pid`). Só `listProcessesStrict` lê. */
  selfPid?: number;
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

/**
 * #14335: faz o parsing do JSON de `Get-CimInstance Win32_Process | Select
 * ProcessId,ParentProcessId,CommandLine | ConvertTo-Json` — puro. O
 * `ConvertTo-Json` devolve um objeto solto (não array) quando só há um
 * processo; os dois formatos são aceitos. Entrada sem `ProcessId` numérico é
 * ignorada; `CommandLine` nulo (processo de sistema sem permissão de leitura)
 * vira string vazia, que nunca casa um path. JSON inválido lança: quem chama
 * decide o fail-soft.
 */
export function parseWin32ProcessJson(raw: string): ProcessInfo[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const result: ProcessInfo[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.ProcessId !== "number" || !Number.isFinite(r.ProcessId)) continue;
    const ppid = typeof r.ParentProcessId === "number" && Number.isFinite(r.ParentProcessId) ? r.ParentProcessId : 0;
    result.push({ pid: r.ProcessId, ppid, cmd: typeof r.CommandLine === "string" ? r.CommandLine : "" });
  }
  return result;
}

/** #14335: teto do PowerShell/CIM. Estourou = lança (o chamador estrito preserva a pasta). */
export const WIN32_PROCESS_QUERY_TIMEOUT_MS = 30_000;

const WIN32_PROCESS_QUERY =
  "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";

/**
 * #14335: processos vivos com cmdline no Windows, pelo CIM (`Win32_Process`).
 * Existe para o guard de remoção de worktree (`removeWorktreeSafe`, #8661),
 * não para o sweep que mata processo (`orphaned-test-process-sweep.ts`
 * segue POSIX-only via `listAllProcesses`): no Windows um processo vivo com
 * DLL carregada de dentro do worktree (`@img/sharp-win32-x64/lib/*.dll`, num
 * teste pendurado) faz o `git worktree remove --force` parar no meio com
 * "Invalid argument", depois de já ter apagado o `.git` e desregistrado o
 * worktree. Lança se o PowerShell falhar ou passar de
 * `WIN32_PROCESS_QUERY_TIMEOUT_MS`.
 */
export function listWindowsProcesses(ops: ListProcessesOps = defaultOps): ProcessInfo[] {
  const raw = ops.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN32_PROCESS_QUERY], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    timeout: WIN32_PROCESS_QUERY_TIMEOUT_MS,
  });
  return parseWin32ProcessJson(String(raw));
}

/**
 * #14335: snapshot de processos para o guard ANTIGO, antes do `git worktree
 * remove` (#8661, `removeWorktreeSafe`). POSIX: `listAllProcesses` (propaga
 * falha do `ps`, como antes). Windows: `listWindowsProcesses`, fail-soft — se
 * o PowerShell falhar, devolve `[]` com aviso no stderr, o mesmo
 * comportamento de antes do #14335 (a remoção segue, sem a checagem). Os
 * caminhos NOVOS do #14335, que apagam a pasta pelo sistema de arquivos,
 * usam `listProcessesStrict`: lá "não deu para listar" preserva a pasta.
 */
export function listProcessesForWorktreeGuard(ops: ListProcessesOps = defaultOps): ProcessInfo[] {
  if (ops.platform !== "win32") return listAllProcesses(ops);
  try {
    return listWindowsProcesses(ops);
  } catch (e) {
    process.stderr.write(
      `[list-processes] aviso: não deu pra listar processos no Windows (#14335), remoção segue sem checar processo vivo: ${(e as Error).message}\n`,
    );
    return [];
  }
}

/**
 * #14335: snapshot de processos que LANÇA quando não consegue listar (falha
 * ou timeout do PowerShell no Windows, lista vazia ou sem o próprio PID no
 * Windows, falha do `ps` no POSIX). Para os
 * caminhos que apagam pelo sistema de arquivos uma pasta de remoção parcial
 * (`cleanupPartialRemovalLeftover`, varredura de órfãos): sem saber se há
 * processo vivo, a pasta fica.
 */
export function listProcessesStrict(ops: ListProcessesOps = defaultOps): ProcessInfo[] {
  if (ops.platform !== "win32") return listAllProcesses(ops);
  // No Windows o PowerShell pode sair 0 com saída vazia ou truncada. Uma
  // listagem que não contém nem este processo (que está vivo) não serve:
  // lança, e o chamador preserva a pasta.
  const list = listWindowsProcesses(ops);
  const selfPid = ops.selfPid ?? process.pid;
  if (list.length === 0) throw new Error("listagem de processos do Windows veio vazia");
  if (!list.some((p) => p.pid === selfPid)) {
    throw new Error(`listagem de processos do Windows não contém o próprio processo (PID ${selfPid}); incompleta`);
  }
  return list;
}
