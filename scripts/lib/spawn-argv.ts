/**
 * scripts/lib/spawn-argv.ts (#13351)
 *
 * Monta a chamada de `spawn` que repassa um argv sem perder argumento.
 *
 * No Windows o comando de um wrapper costuma ser `npx`, que é `npx.cmd`: o
 * Node (desde o fix do CVE-2024-27980) só roda `.cmd`/`.bat` com shell. E
 * `spawn(cmd, args, { shell: true })` NÃO escapa nada: junta os argumentos
 * com espaço (é o aviso `DEP0190`). Um `--title "Deepfake do Drauzio"` chegava
 * ao comando como `--title Deepfake` mais três argumentos soltos (achado na
 * 261117, `publica-phase.ts run ... -- npx tsx scripts/publish-youtube.ts`).
 *
 * Aqui, no Windows, a linha do `cmd.exe` é montada à mão com o mesmo escape do
 * `cross-spawn` (pacote que o repo não tem como dependência direta): cada
 * argumento entre aspas pela regra do `CommandLineToArgvW` (barras antes de
 * aspas dobradas, aspas internas como `\"`) e os metacaracteres do `cmd`
 * escapados com `^`. A linha vai a `cmd.exe /d /s /c "..."` com
 * `windowsVerbatimArguments`, para o Node não reescapar. Fora do Windows não
 * há shell: o argv vai direto ao `execvp`.
 */

/** Metacaracteres do `cmd.exe` escapados com `^` (mesmo conjunto do `cross-spawn`). */
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/** Escapa o nome do comando para a linha do `cmd.exe`. */
export function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META_CHARS, "^$1");
}

/**
 * Escapa um argumento para a linha do `cmd.exe`: aspas pela regra do
 * `CommandLineToArgvW` e `^` antes de cada metacaractere do `cmd`.
 */
export function escapeCmdArgument(arg: string): string {
  // Barras seguidas de aspas: dobra as barras e escapa a aspa.
  let s = arg.replace(/(\\*)"/g, '$1$1\\"');
  // Barras no fim: dobradas, para não escaparem a aspa de fechamento.
  s = s.replace(/(\\*)$/, "$1$1");
  return `"${s}"`.replace(CMD_META_CHARS, "^$1");
}

export interface SpawnInvocation {
  command: string;
  args: string[];
  /** Opções extras do `spawn` (só no Windows: `windowsVerbatimArguments`). */
  options: { windowsVerbatimArguments?: true };
}

/**
 * Pure: a chamada de `spawn` que entrega `argv` intacto ao comando.
 * `platform` e `comspec` são injetáveis para teste.
 */
export function buildSpawnInvocation(
  argv: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comspec: string | undefined = process.env.ComSpec ?? process.env.COMSPEC,
): SpawnInvocation {
  if (argv.length === 0) throw new Error("buildSpawnInvocation: argv vazio");
  if (platform !== "win32") return { command: argv[0], args: argv.slice(1), options: {} };
  const line = [escapeCmdCommand(argv[0]), ...argv.slice(1).map(escapeCmdArgument)].join(" ");
  return { command: comspec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], options: { windowsVerbatimArguments: true } };
}
