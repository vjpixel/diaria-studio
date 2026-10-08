/**
 * cli-exit.ts (#9911): entry point de CLI que grava `process.exitCode` em vez
 * de chamar `process.exit()`.
 *
 * No Windows, com Node 24, `process.exit(code)` logo depois de um `fetch` cai
 * no assert do libuv `!(handle->flags & UV_HANDLE_CLOSING)`
 * (`src\win\async.c:76`) e o processo sai 127, não com o código pedido.
 * Medido em 08/10/2026: `fetch` + `process.exit(4)` → 127 (5 de 5); fechar o
 * dispatcher global antes não resolve; `fetch` + `process.exitCode = 4` → 4.
 * O caso que mordeu foi o #9884 (PR #9910): um `--arm` bem-sucedido saía 127
 * e o Stage 6 lia sucesso como falha.
 *
 * Padrão (o mesmo do #9910): `main()` DEVOLVE o código e só o entry point o
 * grava em `process.exitCode`, deixando o loop drenar os handles.
 *
 * ```ts
 * if (isMainModule(import.meta.url)) {
 *   runCli(main, { onError: (e) => console.error("Fatal error:", e) });
 * }
 * ```
 *
 * Para sair de dentro de uma função auxiliar sem reescrever a cadeia de
 * retornos, lance `new CliExit(code)`: `runCli` o reconhece e grava o código
 * sem tratar como erro. Só use quando nenhum `try/catch` no caminho até o
 * `main()` engolir a exceção.
 *
 * Consequência a lembrar ao migrar: `process.exit()` matava handles pendentes
 * (timer, servidor, intervalo); `process.exitCode` espera o loop esvaziar.
 * Um handle esquecido vira processo pendurado em vez de saída imediata.
 *
 * Guard de CI: `test/process-exit-fetch-guard-9911.test.ts` (scanner em
 * `scripts/lib/process-exit-fetch-scan.ts`) recusa `process.exit(` em script
 * que usa `fetch`, com allowlist dos que ainda não migraram.
 */

/** Saída antecipada com código, reconhecida por `runCli` (não é erro). */
export class CliExit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`CliExit(${code})`);
    this.name = "CliExit";
    this.code = code;
  }
}

export type CliMain = () => Promise<number | void> | number | void;

export interface RunCliOptions {
  /** Chamado quando `main` lança algo que não é `CliExit`. Default: `console.error(e)`. */
  onError?: (e: unknown) => void;
  /** Código gravado quando `main` lança. Default 1. */
  errorCode?: number;
}

/**
 * Roda `main` e grava o código em `process.exitCode`. `main` que devolve
 * `undefined` não mexe no `exitCode` (o processo sai 0, ou com o que outro
 * trecho já gravou). Devolve a promise para teste; o entry point pode ignorá-la.
 */
export function runCli(main: CliMain, opts: RunCliOptions = {}): Promise<void> {
  return Promise.resolve()
    .then(main)
    .then(
      (code) => {
        if (typeof code === "number") process.exitCode = code;
      },
      (e: unknown) => {
        if (e instanceof CliExit) {
          process.exitCode = e.code;
          return;
        }
        (opts.onError ?? ((err: unknown) => console.error(err)))(e);
        process.exitCode = opts.errorCode ?? 1;
      },
    );
}
