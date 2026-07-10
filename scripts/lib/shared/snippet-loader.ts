/**
 * snippet-loader.ts (#3219)
 *
 * Helper genérico de baixo nível pra ler um arquivo de `context/snippets/`:
 * resolve o path a partir da raiz do repo, lê o conteúdo, tira o comentário
 * HTML de header (convenção de todos os snippets — ver `clarice-divulgacao.md`,
 * `livros-divulgacao.md`, `encerramento-social-apoio.md`) e trima. Retorna
 * `null` se o arquivo não existir ou ficar vazio após o strip — graceful,
 * caller decide o fallback.
 *
 * Extraído em #3219 pra parar de duplicar essa mesma leitura em paralelo:
 * antes, `loadDivulgacaoSnippet` (`scripts/stitch-newsletter.ts`) e
 * `loadEncerramentoSocialApoioTemplate` (`scripts/lib/shared/
 * encerramento-snippet.ts`) reimplementavam o mesmo "resolve root → readFileSync
 * → strip `<!--...-->` → trim" cada um com sua própria cópia. `loadDivulgacaoSnippet`
 * segue com sua própria etapa de pós-processamento (extração de marker
 * bold-line/carrinho) por cima deste helper — só a leitura crua é compartilhada.
 *
 * `shared/` porque é consumido por código de diária E mensal (indiretamente,
 * via `encerramento-snippet.ts`) — ver test/lib-boundary.test.ts (#2747).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Lê `context/snippets/{filename}` a partir da raiz do repo, remove o
 * comentário HTML de header (`<!-- ... -->`) e trima. `null` se o arquivo
 * não existir ou ficar vazio após o strip.
 */
export function readSnippetFile(filename: string): string | null {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const p = join(root, "context", "snippets", filename);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
  return raw || null;
}
