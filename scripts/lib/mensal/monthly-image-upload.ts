/**
 * monthly-image-upload.ts (#1914)
 *
 * Extraído de `scripts/publish-monthly.ts` pra ser compartilhado entre o
 * publicador Brevo e o preview Cloudflare (`monthly-preview-cloudflare.ts`).
 * Ambos sobem as imagens do É IA? mensal pro KV do Worker poll com a MESMA
 * convenção de key, então a lógica precisa morar num único lugar (senão um
 * diverge do outro e a imagem quebra pós-voto — exatamente o bug do #1908).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { uploadImageToWorkerKV } from "../cloudflare-kv-upload.ts";
import { DIARIA_EIA_URL } from "../canonical-urls.ts"; // #3904

// scripts/lib/mensal/ → raiz são 3 níveis (mensal → lib → scripts). #2747 desceu
// este arquivo um nível e o `.., ..` original passou a apontar pra scripts/.
export const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Pure (#1908): key da imagem É IA? mensal no KV. Convenção
 * `img-{edition}-{basename}` — IDÊNTICA à do diário (upload-images-public.ts)
 * e ao que a result page do voto monta em `renderResultImagesHtml`
 * (`/img/img-{edition}-01-eia-{A|B}.jpg`). Antes era `img-monthly-*`, key que a
 * result page nunca encontrava → imagens quebradas pós-voto no mensal.
 */
export function monthlyEiaImageKey(edition: string, filePath: string): string {
  const filename = filePath.split(/[\\/]/).pop() ?? "image.jpg";
  return `img-${edition}-${filename}`;
}

/**
 * Faz upload de uma imagem do digest mensal pro KV do Worker.
 * Wrapper sobre `uploadImageToWorkerKV` (lib/cloudflare-kv-upload.ts) que
 * resolve o `kvNamespaceId` de `platform.config.json` e usa a key
 * `img-{edition}-{basename}` (ver `monthlyEiaImageKey`).
 *
 * A função genérica de upload vive em lib desde #1119; esta camada mensal foi
 * extraída em #1914 (antes era local em publish-monthly).
 *
 * `keyFilename` (#4440, opcional): quando informado, é ele — e NÃO o
 * basename de `filePath` — que vira a key no KV (via `monthlyEiaImageKey`).
 * Necessário pro caller normalizar a key mesmo quando o arquivo local usa um
 * naming legado (ver `uploadEiaImages`/`resolveEiaImagePair` abaixo — sem
 * isso, um upload cujo par local casou pelo nome legado `01-eai-*` subia pra
 * uma key com o mesmo typo, que o leitor (`renderArchiveVoteHtml`,
 * workers/poll/src/leaderboard-routes.ts) nunca busca — 404 permanente e
 * silencioso). Callers que não usam naming legado (`uploadDestaqueImages`,
 * `uploadLivrosImage`) não passam este parâmetro — comportamento inalterado
 * (cai no fallback `keyFilename ?? filePath`, idêntico ao pré-#4440).
 */
export async function uploadMonthlyImage(
  filePath: string,
  edition: string,
  root: string = DEFAULT_ROOT,
  keyFilename?: string,
): Promise<string> {
  const cfg = JSON.parse(readFileSync(resolve(root, "platform.config.json"), "utf8"));
  const kvNamespaceId: string = cfg?.poll?.kv_namespace_id;
  if (!kvNamespaceId) throw new Error("platform.config.json → poll.kv_namespace_id não configurado");

  const workerUrl = process.env.POLL_WORKER_URL ?? cfg?.poll?.worker_url ?? DIARIA_EIA_URL; // #3904
  const key = monthlyEiaImageKey(edition, keyFilename ?? filePath);

  return uploadImageToWorkerKV(filePath, key, {
    kvNamespaceId,
    workerUrl,
  });
}

/**
 * #1916: sobe as imagens 2x1 dos destaques (D1/D2/D3) do digest mensal pro KV e
 * devolve o map `{ 1: url, 2: url, 3: url }` (só os que existem). Usa
 * `uploadMonthlyImage` (mesma convenção de key `img-{edition}-04-d{N}-2x1.jpg`).
 * Compartilhado entre o preview Cloudflare e o publish-monthly (Brevo).
 *
 * `eiaEdition` = AAMMDD do É IA? (último dia do mês) — mesma usada pras imagens
 * do É IA?, pra manter todas as imagens da edição sob a mesma `edition` no KV.
 */
export async function uploadDestaqueImages(
  monthlyDir: string,
  eiaEdition: string,
  root: string = DEFAULT_ROOT,
): Promise<Record<number, string>> {
  // Uploads independentes → paralelos (#1922 review, consistente com uploadEiaImages).
  const present = [1, 2, 3].filter((n) =>
    existsSync(resolve(monthlyDir, `04-d${n}-2x1.jpg`)),
  );
  const urls = await Promise.all(
    present.map((n) =>
      uploadMonthlyImage(resolve(monthlyDir, `04-d${n}-2x1.jpg`), eiaEdition, root),
    ),
  );
  const out: Record<number, string> = {};
  present.forEach((n, i) => {
    out[n] = urls[i];
  });
  return out;
}

/** Key filenames NORMALIZADOS (sempre a grafia correta) usados no KV — nunca
 * o naming legado, independente de qual par foi encontrado no disco. */
const EIA_KEY_FILENAME_A = "01-eia-A.jpg";
const EIA_KEY_FILENAME_B = "01-eia-B.jpg";

export interface EiaImagePair {
  pathA: string;
  pathB: string;
  /** Filename LOCAL de cada lado (pode ser o legado `01-eai-*`). */
  localFilenameA: string;
  localFilenameB: string;
  /** Filename NORMALIZADO a usar como key no KV — sempre `01-eia-{A,B}.jpg`,
   * mesmo quando o par local encontrado é o legado (#4440). */
  keyFilenameA: string;
  keyFilenameB: string;
}

/**
 * Pure (#4440): resolve QUAL par de imagens do É IA? mensal existe no disco
 * (novo `01-eia-*` ou legado `01-eai-*`, nesta ordem de preferência) e os
 * filenames a usar tanto localmente (leitura do arquivo) quanto como KEY no
 * KV (sempre normalizados pra `01-eia-{A,B}.jpg`). Retorna `null` se nenhum
 * par completo existir (seção sem imagem — não-fatal).
 *
 * Extraída de `uploadEiaImages` pra ser testável sem rede: antes desta issue,
 * a key de upload vinha do FILENAME LOCAL (`monthlyEiaImageKey(edition,
 * filePath)`) — se o par que casou fosse o legado, a imagem subia pra
 * `img-{edition}-01-eai-A.jpg`, mas o leitor (`renderArchiveVoteHtml`,
 * workers/poll/src/leaderboard-routes.ts) sempre busca a grafia correta
 * (`01-eia-*`) — 404 permanente e silencioso.
 */
export function resolveEiaImagePair(monthlyDir: string): EiaImagePair | null {
  const namePairs: Array<[string, string]> = [
    ["01-eia-A.jpg", "01-eia-B.jpg"],
    ["01-eai-A.jpg", "01-eai-B.jpg"], // legacy
  ];
  for (const [nameA, nameB] of namePairs) {
    const pathA = resolve(monthlyDir, nameA);
    const pathB = resolve(monthlyDir, nameB);
    if (existsSync(pathA) && existsSync(pathB)) {
      return {
        pathA,
        pathB,
        localFilenameA: nameA,
        localFilenameB: nameB,
        keyFilenameA: EIA_KEY_FILENAME_A,
        keyFilenameB: EIA_KEY_FILENAME_B,
      };
    }
  }
  return null;
}

/**
 * Sobe as 2 imagens do É IA? mensal pro KV e devolve as URLs públicas,
 * tolerando o naming legado `01-eai-*`. Retorna `{}` se não achar o par
 * (seção sem imagem — não-fatal).
 *
 * Extraído de `monthly-preview-cloudflare.ts` (#2802) pra ser compartilhado
 * com `publish-monthly.ts`, que tinha uma cópia quase-idêntica dessa busca
 * com fallback legado — divergência de fonte é exatamente o bug do #1908.
 *
 * `aFilename`/`bFilename` (#3392): qual par de nome LOCAL venceu (novo
 * `01-eia-*` ou legado `01-eai-*`) — campos aditivos, só consumidos por
 * `monthly-preview-cloudflare.ts` pra montar o manifest de `embed-images-base64.ts`
 * (precisa do filename LOCAL correspondente à URL pra resolver o `data:` URI).
 * `publish-monthly.ts` continua lendo só `.a`/`.b`, sem quebra.
 *
 * #4440: a KEY no KV (via `uploadMonthlyImage(..., keyFilename)`) é SEMPRE
 * `01-eia-{A,B}.jpg`, normalizada por `resolveEiaImagePair` — independente de
 * qual par (novo ou legado) foi encontrado no disco. `aFilename`/`bFilename`
 * continuam refletindo o filename LOCAL real (não a key normalizada).
 */
export async function uploadEiaImages(
  monthlyDir: string,
  eiaEdition: string,
  root: string = DEFAULT_ROOT,
): Promise<{ a?: string; b?: string; aFilename?: string; bFilename?: string }> {
  const pair = resolveEiaImagePair(monthlyDir);
  if (!pair) return {};

  // Uploads independentes → paralelos (#1915 review).
  const [a, b] = await Promise.all([
    uploadMonthlyImage(pair.pathA, eiaEdition, root, pair.keyFilenameA),
    uploadMonthlyImage(pair.pathB, eiaEdition, root, pair.keyFilenameB),
  ]);
  return { a, b, aFilename: pair.localFilenameA, bFilename: pair.localFilenameB };
}

/** Filename da imagem do box de curadoria de livros do digest mensal. */
export const LIVROS_PROMO_FILENAME = "04-livros-promo.jpg";

/**
 * Sobe a imagem do box de curadoria de livros (`04-livros-promo.jpg`) do
 * digest mensal pro KV e devolve a URL pública. Retorna `undefined` se o
 * arquivo não existir na pasta da edição (degrade sem imagem — box de livros
 * segue renderizando sem `<img>`, igual ao comportamento do É IA?/destaques).
 *
 * #2802: `publish-monthly.ts` (caminho real de publicação/Brevo) não subia
 * essa imagem — só `monthly-preview-cloudflare.ts` fazia isso inline, então o
 * email real saía sem a imagem do box de livros enquanto o preview a
 * mostrava. Extraído aqui pra os dois callers compartilharem a mesma lógica.
 */
export async function uploadLivrosImage(
  monthlyDir: string,
  eiaEdition: string,
  root: string = DEFAULT_ROOT,
): Promise<string | undefined> {
  const livrosPath = resolve(monthlyDir, LIVROS_PROMO_FILENAME);
  if (!existsSync(livrosPath)) return undefined;
  return uploadMonthlyImage(livrosPath, eiaEdition, root);
}
