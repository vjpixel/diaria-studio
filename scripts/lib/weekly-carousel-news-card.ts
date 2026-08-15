/**
 * weekly-carousel-news-card.ts (#5330)
 *
 * Recompõe o título dos cards de DESTAQUE (D1/D2/D3) com o tamanho de fonte
 * ÚNICO do carrossel (`weekly-carousel-font-size.ts`), gerando um card 4:5
 * NOVO a partir da MESMA arte-base (`04-{destaque}-4x5-nativo.jpg` etc, via
 * `generateCard`) — o `04-{destaque}-4x5.jpg` já publicado no feed diário
 * NUNCA é sobrescrito (é outro arquivo, outro upload).
 *
 * Existe porque `resolveWeeklyImageUrls` (publish-weekly-social.ts) original
 * só LÊ a URL do card diário já pronto — suficiente antes do #5330, mas
 * títulos de comprimento bem diferente publicados em dias diferentes da
 * semana usam tamanhos de fonte diferentes (44-88px, clamp por título), o
 * que destoa visualmente quando os 5 cards ficam lado a lado no carrossel.
 *
 * Cache: `data/weekly/{carouselKey}/_internal/06-news-cards.json`, chave
 * `{editionDate}-{destaque}-{fontSize}` — idempotente, mesmo padrão de
 * `weekly-flat-card.ts`/`weekly-instagram-ondemand-card.ts`. `fontSize` faz
 * parte da chave de propósito (#5330 fleet review, achado de correctness):
 * `carouselFontSize` é recalculado do zero a cada `main()` a partir do SET
 * de itens selecionado naquela rodada — um re-run com seleção diferente
 * (ex: editor troca 1 item e roda de novo) pode legitimamente mudar o
 * tamanho comum. Sem `fontSize` na chave, um item que não mudou de posição
 * serviria uma imagem cacheada no tamanho ANTIGO, quebrando a padronização
 * visual em silêncio — exatamente o bug que este módulo existe pra evitar.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateCard } from "../gen-social-card-4x5.ts";
import { assertBrandSerifAvailable } from "./shared/assert-brand-font.ts";
import { uploadImageToWorkerKV } from "./cloudflare-kv-upload.ts";
import { DIARIA_EIA_URL } from "./canonical-urls.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface NewsCardRecomposeInput {
  editionDate: string;
  editionDir: string;
  destaque: string; // "d1" | "d2" | "d3"
  title: string;
  category: string;
  fontSize: number;
}

function newsCardsCachePath(dataRoot: string, carouselKey: string): string {
  return resolve(dataRoot, "weekly", carouselKey, "_internal", "06-news-cards.json");
}

function cacheKey(input: Pick<NewsCardRecomposeInput, "editionDate" | "destaque" | "fontSize">): string {
  return `${input.editionDate}-${input.destaque}-${input.fontSize}`;
}

function readNewsCardUrl(dataRoot: string, carouselKey: string, key: string): { url: string | null; corruptError?: string } {
  const p = newsCardsCachePath(dataRoot, carouselKey);
  if (!existsSync(p)) return { url: null };
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as Record<string, { url?: string }>;
    return { url: data[key]?.url ?? null };
  } catch (e: any) {
    return { url: null, corruptError: e.message };
  }
}

function writeNewsCardUrl(dataRoot: string, carouselKey: string, key: string, url: string): void {
  const p = newsCardsCachePath(dataRoot, carouselKey);
  mkdirSync(resolve(dataRoot, "weekly", carouselKey, "_internal"), { recursive: true });
  const existing = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  existing[key] = { url };
  writeFileSync(p, JSON.stringify(existing, null, 2) + "\n", "utf8");
}

export interface NewsCardRecomposeResult {
  url: string;
}

/**
 * Injetável — mesmo padrão de `SectionCardGenerator`/`FlatCardGenerator`:
 * testes passam um fake, nunca a implementação real (sharp real + upload
 * pro KV Cloudflare).
 */
export type NewsCardGenerator = (input: NewsCardRecomposeInput & { outPath: string; kvKey: string }) => Promise<NewsCardRecomposeResult>;

/**
 * Implementação REAL — NUNCA invocada em teste. Reusa `generateCard` (MESMA
 * arte-base do card diário) com `fontSizeOverride` + `outPath` customizado —
 * nunca sobrescreve `04-{destaque}-4x5.jpg`.
 */
export const defaultNewsCardGenerator: NewsCardGenerator = async ({ editionDir, destaque, title, category, fontSize, outPath, kvKey }) => {
  await assertBrandSerifAvailable("weekly-carousel-news-card");

  const cardPath = await generateCard(editionDir, destaque, title, category, "4x5", "overlay", { fontSizeOverride: fontSize, outPath });
  if (!cardPath) {
    throw new Error(`arte-base de ${destaque} ausente em ${editionDir} (nem -4x5-nativo.jpg, nem -master.jpg, nem -2x1.jpg)`);
  }

  const platformCfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const kvNamespaceId = platformCfg?.poll?.kv_namespace_id;
  const workerUrl = platformCfg?.poll?.worker_url ?? DIARIA_EIA_URL;
  if (!kvNamespaceId) {
    throw new Error("platform.config.json → poll.kv_namespace_id não configurado (recomposição de card de notícia pro carrossel)");
  }
  const url = await uploadImageToWorkerKV(cardPath, kvKey, { kvNamespaceId, workerUrl });
  return { url };
};

/**
 * Resolve a URL do card de notícia RECOMPOSTO com o tamanho fixo do
 * carrossel: cache hit retorna direto (nunca regenera); cache miss chama
 * `generator` (default `defaultNewsCardGenerator`) + grava no cache. Nunca
 * lança — erros do gerador viram `{url: null, error}` (mesmo contrato de
 * `resolveOrGenerateSectionCardUrl`/`resolveOrGenerateFlatCardUrl`).
 */
export async function resolveOrGenerateNewsCardUrl(
  dataRoot: string,
  carouselKey: string,
  input: NewsCardRecomposeInput,
  generator: NewsCardGenerator = defaultNewsCardGenerator,
): Promise<{ url: string | null; error?: string }> {
  const key = cacheKey(input);
  const cached = readNewsCardUrl(dataRoot, carouselKey, key);
  if (cached.corruptError) {
    return { url: null, error: `06-news-cards.json corrompido: ${cached.corruptError}` };
  }
  if (cached.url) return { url: cached.url };

  const outDir = resolve(dataRoot, "weekly", carouselKey, "_internal");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `06-${key}-4x5.jpg`);
  const kvKey = `weekly/${carouselKey}/${key}-4x5.jpg`;

  try {
    const { url } = await generator({ ...input, outPath, kvKey });
    writeNewsCardUrl(dataRoot, carouselKey, key, url);
    return { url };
  } catch (e: any) {
    return { url: null, error: e.message };
  }
}
