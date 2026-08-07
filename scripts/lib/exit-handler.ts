/**
 * exit-handler.ts — wrapper padronizado para funcao main() de scripts CLI.
 * Substitui o padrao main().catch(e => { console.error(e); process.exit(1); })
 * que varia entre scripts.
 */

/**
 * Executa fn assincrona e captura erros com log estruturado para stderr.
 * Exit code 1 em qualquer erro nao capturado.
 *
 * #4653: usa `process.exitCode` em vez de `process.exit()` — a mesma classe
 * de bug já corrigida caso a caso em validate-gemini-config.ts (#1401),
 * verify-scheduled-post.ts (#4638) e 4 scripts brevo (#4651): `process.exit()`
 * força o shutdown do libuv antes de sockets keep-alive de `fetch` fecharem,
 * disparando a assertion `UV_HANDLE_CLOSING` no Windows (exit 127/134) mesmo
 * com o erro já logado corretamente em stderr. `process.exitCode` deixa o
 * event loop drenar sozinho — o processo termina com o código certo assim
 * que não sobrar handle pendente. Seguro aqui porque `process.exit(1)` já
 * era a ÚLTIMA instrução da função (não há código depois que dependesse do
 * encerramento imediato) e os 11 call sites de `runMain` no repo sempre
 * invocam como última instrução de um bloco `if (isMainModule(...))` no fim
 * do arquivo — nenhum consumidor depende do processo morrer no meio de
 * `fn()` ainda em voo (o caminho de SUCESSO já nunca chamava
 * `process.exit()`, só o de erro — ver docstring de `sendMailWithTimeout`
 * em `scripts/studio-ui/studio-reports.ts`, que já documentava essa
 * assimetria antes deste fix).
 */
export async function runMain(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[error]", msg);
    if (e instanceof Error && e.stack) {
      console.error(e.stack);
    }
    process.exitCode = 1;
  }
}

/**
 * Imprime mensagem de erro para stderr e encerra com exit code (default 1).
 * Util para validacao de args no inicio do script.
 *
 * #4653: deliberadamente NÃO trocado para `process.exitCode` como `runMain`
 * acima. A classe de bug #1401/#4638/#4651 exige um handle libuv pendente
 * (tipicamente sockets keep-alive de um `fetch` em voo) no momento do
 * `process.exit()` — `exitWithError` é chamado só na validação de args, no
 * início síncrono do script, antes de qualquer `await`/rede (único call site
 * hoje: `categorize.ts`, `if (!values["articles"]) exitWithError(...)`).
 * Sem handle pendente, não há UV_HANDLE_CLOSING pra disparar. Trocar por
 * `process.exitCode` aqui também exigiria abandonar `process.exit()` sem
 * quebrar o contrato `never` do tipo de retorno (usado no call site como
 * `?? exitWithError(...)` em cenários futuros) — o único jeito de preservar
 * `never` sem `process.exit()` é lançar uma exceção, o que muda o formato da
 * mensagem de erro impressa (stack trace de exceção não capturada em vez do
 * `[error]` limpo) para um ganho de robustez inexistente neste call site.
 * Reavaliar se `exitWithError` algum dia passar a ser chamado depois de um
 * `await fetch`.
 */
export function exitWithError(msg: string, code = 1): never {
  console.error("[error]", msg);
  process.exit(code);
}
