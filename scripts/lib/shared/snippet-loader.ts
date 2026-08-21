/**
 * snippet-loader.ts (#3219, migrado pra `data/snippets/` em #5227)
 *
 * Helper genérico de baixo nível pra ler um arquivo de `data/snippets/`:
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
 * **#5227 (14/08/2026):** `context/snippets/` (git-tracked) migrou pra
 * `data/snippets/` (junction OneDrive, gitignored — mesma pasta compartilhada
 * usada por `clarice-subscribers`, `editions`, etc.). Motivo: caixa criada/
 * editada localmente (chat ou Studio) ficava invisível no checkout remoto que
 * serve o Studio até alguém lembrar de commitar+dar push (#5227) — e o Studio
 * TAMBÉM escreve nesse diretório (`studio-boxes.ts`), então o problema era
 * bidirecional. `data/` já sincroniza sozinho entre as máquinas do projeto,
 * então o passo commit+push manual deixa de existir. `context/snippets/README.md`
 * (spec do formato, é documentação) continua no git. Fail-soft PERMANECE
 * (`existsSync` abaixo) — clone fresco/sessão cloud sem `data/` continua sem
 * lançar aqui; é o CAMINHO DA NEWSLETTER (`loadDivulgacaoSnippet` em
 * `stitch-newsletter.ts`) que passou a tratar "slot configurado mas arquivo
 * ausente" como erro duro, não este helper de baixo nível (que não sabe se o
 * caller é um slot obrigatório ou uma leitura best-effort).
 *
 * `shared/` porque é consumido por código de diária E mensal (indiretamente,
 * via `encerramento-snippet.ts`) — ver test/lib-boundary.test.ts (#2747).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Lê `data/snippets/{filename}` a partir da raiz do repo, remove o
 * comentário HTML de header (`<!-- ... -->`) e trima. `null` se o arquivo
 * não existir ou ficar vazio após o strip.
 *
 * `rootDir` (opcional) — override de teste: quando fornecido, resolve
 * `{rootDir}/data/snippets/{filename}` em vez da raiz real do repo (#5227 —
 * `data/snippets/` é gitignored/junction OneDrive, ausente em CI/clone
 * fresco/worktree isolado; sem este override, qualquer teste que precise de
 * conteúdo de snippet REAL não teria como fornecê-lo). Produção nunca passa
 * este parâmetro.
 */
export function readSnippetFile(filename: string, rootDir?: string): string | null {
  const root = rootDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const p = join(root, "data", "snippets", filename);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
  return raw || null;
}

/**
 * Conteúdo CRU de `data/snippets/{filename}` (header de comentário `<!--
 * ... -->` PRESERVADO, ao contrário de `readSnippetFile` acima, que o
 * remove) — `null` se o arquivo não existir. #5882: callers que precisam ler
 * um campo declarado do header (`parseBoxHeaderField`/`readBoxTituloFlag`,
 * `shared/snippet-header.ts`) do MESMO snippet cujo corpo já carregam via
 * `readSnippetFile` (ex: `renderConviteAmigo`, o único caminho "fixo" —
 * fora de `boxes_divulgacao` — que precisa inspecionar o próprio header).
 * Mesmo `rootDir` de override de teste que `readSnippetFile` aceita.
 */
export function readSnippetFileRaw(filename: string, rootDir?: string): string | null {
  const root = rootDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const p = join(root, "data", "snippets", filename);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}
