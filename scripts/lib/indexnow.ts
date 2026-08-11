/**
 * scripts/lib/indexnow.ts (#4909 item 2)
 *
 * IndexNow (indexnow.org): protocolo aberto que avisa buscadores que uma
 * URL mudou, sem esperar o próximo crawl do sitemap — POST simples, custo
 * zero. **O Google NÃO participa** (retorno é o Bing; por tabela alimenta o
 * ChatGPT via parceria de busca com a Microsoft) — este módulo nunca deve
 * ser lido como promessa de ganho de citação (mesma ressalva do `<lastmod>`,
 * ver `docs/seo-notes.md` Fato 3).
 *
 * Lógica PURA aqui — builder do payload + gate "mudou desde o último
 * deploy" — nenhuma chamada de rede neste módulo (I/O fica em
 * `scripts/ping-indexnow.ts`, chamado só pelo workflow
 * `.github/workflows/deploy-arquivo.yml`, nunca localmente contra produção).
 *
 * O gate é o próprio corpo de `buildIndexNowUrls`/`buildIndexNowPayload`:
 * pingar uma URL que não mudou é o mesmo argumento de erosão de confiança
 * que motivou a ressalva do `<lastmod>` (Gary Illyes, ver #4909) — então só
 * pingamos quando pelo menos um `workers/arquivo/src/hubs/*.generated.ts`
 * está na lista de arquivos alterados do push (o mesmo sinal que já
 * determina se um hub mudou de conteúdo, usado pelo `<lastmod>` do sitemap
 * — `scripts/build-hub-page.ts`). Lista sem nenhum `.generated.ts` →
 * `buildIndexNowUrls` devolve `[]` e `buildIndexNowPayload` devolve `null`
 * — o caller (`scripts/ping-indexnow.ts`) trata `null` como "gate fechado,
 * não pinga".
 */

/** Host canônico do Worker `arquivo` — único host com hubs temáticos hoje. */
export const ARQUIVO_HOST = "arquivo.diar.ia.br";

/** Diretório (relativo à raiz do repo, POSIX) onde `scripts/build-hub-page.ts`
 * escreve o HTML gerado de cada hub — mesmo diretório importado por
 * `workers/arquivo/src/hubs/registry.ts`. */
const HUBS_GENERATED_DIR = "workers/arquivo/src/hubs/";

const GENERATED_SUFFIX = ".generated.ts";

/**
 * Pura — extrai os slugs de hub cujo `.generated.ts` está na lista de
 * arquivos alterados (tipicamente `git diff --name-only <before> <after>`).
 * Ignora qualquer path fora de `workers/arquivo/src/hubs/` ou que não
 * termine em `.generated.ts` (ex: `registry.ts`/`meta.ts` — escritos à mão,
 * não representam conteúdo de UM hub específico mudando). Normaliza
 * separador de path (`\` → `/`) e um eventual prefixo `./`, pra aceitar
 * tanto a saída crua do `git diff` (POSIX sempre, mesmo no Windows) quanto
 * um path montado manualmente em teste.
 */
export function extractChangedHubSlugs(changedFiles: readonly string[]): string[] {
  const slugs: string[] = [];
  for (const raw of changedFiles) {
    const f = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!f.startsWith(HUBS_GENERATED_DIR) || !f.endsWith(GENERATED_SUFFIX)) continue;
    const slug = f.slice(HUBS_GENERATED_DIR.length, f.length - GENERATED_SUFFIX.length);
    // Defensivo: um slug com "/" indicaria um subdiretório dentro de
    // hubs/, que não existe no layout atual (todos os *.generated.ts são
    // arquivos diretos do diretório) — descartado em vez de produzir uma
    // URL /temas/algo/errado.
    if (slug && !slug.includes("/")) slugs.push(slug);
  }
  return slugs;
}

/**
 * Pura — URLs de hub a pingar, derivadas dos arquivos alterados (gate
 * "mudou desde o último deploy" embutido: lista sem `.generated.ts` →
 * `[]`). `baseUrl` sem barra final (default `https://arquivo.diar.ia.br`).
 */
export function buildIndexNowUrls(
  changedFiles: readonly string[],
  baseUrl: string = `https://${ARQUIVO_HOST}`,
): string[] {
  return extractChangedHubSlugs(changedFiles).map((slug) => `${baseUrl}/temas/${slug}`);
}

/** Corpo do POST IndexNow — ver https://www.indexnow.org/documentation. */
export interface IndexNowPayload {
  /** Host das URLs em `urlList` — TODAS precisam pertencer a este host
   * (limitação do protocolo: 1 host por submissão). */
  host: string;
  /** Chave gerada pelo editor (string opaca) — precisa bater com o arquivo
   * servido em `keyLocation`. */
  key: string;
  /** URL absoluta do arquivo de chave (`{baseUrl}/{key}.txt`) — o buscador
   * confere esse arquivo pra validar que quem pinga é dono do host. */
  keyLocation: string;
  urlList: string[];
}

/**
 * Pura — monta o payload IndexNow, ou `null` se o gate "mudou desde o
 * último deploy" não abrir (nenhum `.generated.ts` alterado) OU se `key`
 * vier vazia (sem chave, não há como montar `keyLocation` nem autenticar o
 * ping — tratado como gate fechado, não como erro: permite o workflow
 * rodar antes do editor provisionar `INDEXNOW_KEY`, sem quebrar o deploy).
 * Nunca faz I/O — o POST em si é responsabilidade exclusiva de
 * `scripts/ping-indexnow.ts`.
 */
export function buildIndexNowPayload(
  changedFiles: readonly string[],
  key: string,
  opts: { host?: string; baseUrl?: string } = {},
): IndexNowPayload | null {
  if (!key) return null;
  const host = opts.host ?? ARQUIVO_HOST;
  const baseUrl = opts.baseUrl ?? `https://${host}`;
  const urlList = buildIndexNowUrls(changedFiles, baseUrl);
  if (urlList.length === 0) return null;
  return { host, key, keyLocation: `${baseUrl}/${key}.txt`, urlList };
}
