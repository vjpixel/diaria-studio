/**
 * read-file-with-context.ts (#12554)
 *
 * Leitura de arquivo de texto que, em caso de erro, relança com o CAMINHO do
 * arquivo e o código do erro. O `readFileSync` cru, num arquivo marcado como
 * offline pelo OneDrive (atributo `O`, "O provedor de arquivos de nuvem
 * fechou inesperadamente"), falha só com `UNKNOWN: unknown error, read` — sem
 * nome de arquivo nem pista da causa. Caso de origem: `publish-circle-stack.ts
 * --publish-monday 261109` saiu com exit 1 e essa linha só; levou várias
 * tentativas para achar `data/editions/2611/261109/02-reviewed.md`.
 *
 * `existsSync` devolve `true` para o arquivo offline, então o erro só aparece
 * na leitura: é ali que o contexto precisa entrar.
 */
import { readFileSync } from "node:fs";

/** Códigos de erro que, em `data/` (sincronizado pelo OneDrive), costumam ser o provedor de nuvem. */
export const CLOUD_PROVIDER_ERROR_CODES: ReadonlySet<string> = new Set(["UNKNOWN", "EPERM", "EBUSY", "ETIMEDOUT", "EIO"]);

export const CLOUD_PROVIDER_HINT =
  "o arquivo pode estar só na nuvem (Drive for desktop fechado ou sem baixar o arquivo, ou bisync do 300 atrasado): " +
  "confira se o cliente de sync do Drive está rodando e se o arquivo abre no gerenciador de arquivos, e rode de novo";

/** Erro de leitura com o caminho do arquivo; `code` repete o do erro original. */
export class FileReadError extends Error {
  readonly path: string;
  readonly code: string | undefined;
  constructor(path: string, cause: unknown) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    const msg = cause instanceof Error ? cause.message : String(cause);
    const hint = code !== undefined && CLOUD_PROVIDER_ERROR_CODES.has(code) ? ` — ${CLOUD_PROVIDER_HINT}` : "";
    super(`Falha ao ler ${path}${code ? ` (${code})` : ""}: ${msg}${hint}`, { cause });
    this.name = "FileReadError";
    this.path = path;
    this.code = code;
  }
}

/**
 * Lê `path` como UTF-8; qualquer erro sai como `FileReadError`, com o caminho
 * e, para os códigos de `CLOUD_PROVIDER_ERROR_CODES`, a dica do OneDrive.
 * `read` é injetável para teste.
 */
export function readUtf8WithContext(path: string, read: (p: string, enc: "utf8") => string = readFileSync): string {
  try {
    return read(path, "utf8");
  } catch (err) {
    throw new FileReadError(path, err);
  }
}
