/**
 * exit-handler.ts -- wrapper padronizado para funcao main() de scripts CLI.
 * Substitui o padrao main().catch(e => { console.error(e); process.exit(1); })
 * que varia entre scripts.
 */

/**
 * Executa fn assincrona e captura erros com log estruturado para stderr.
 * Exit code 1 em qualquer erro nao capturado.
 */
export async function runMain(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[error] ${msg}
`);
    if (e instanceof Error && e.stack) {
      process.stderr.write(e.stack + "
");
    }
    process.exit(1);
  }
}

/**
 * Imprime mensagem de erro para stderr e encerra com exit code 1.
 * Util para validacao de args no inicio do script.
 */
export function exitWithError(msg: string, code = 1): never {
  process.stderr.write(`[error] ${msg}
`);
  process.exit(code);
}
