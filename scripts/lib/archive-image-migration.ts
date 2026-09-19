/**
 * archive-image-migration.ts (#8364)
 *
 * Guarda o mapa `URL original → { key, alt }` que reescreve `<img>` do
 * acervo (`/p/{slug}`, `scripts/lib/site-archive-pages.ts`) que hoje
 * dependem de `media.beehiiv.com` (host de terceiro, em migração de saída —
 * ver a issue) para o KV próprio (`diar.ia.br/img/{key}`, mesmo namespace
 * `POLL` que `eia.diar.ia.br`/`poll.diaria.workers.dev` já servem).
 *
 * Mesmo padrão de `beehiiv-publish-date-overrides.json`
 * (`beehiiv-publish-date.ts`, #4796): arquivo JSON git-tracked ao lado do
 * módulo (nunca em `data/`, que é gitignored/OneDrive — um mapa que só
 * existisse lá desapareceria em qualquer clone fresco e a migração
 * regrediria em silêncio na próxima regeneração do acervo), carregado lazy
 * e cacheado em módulo, fail-soft (arquivo ausente ou malformado nunca
 * lança — degrada pra mapa vazio, que é exatamente "nenhuma imagem migrada
 * ainda", o estado inicial legítimo).
 *
 * **Quem POPULA o mapa**: `scripts/migrate-archive-beehiiv-images.ts` — CLI
 * que baixa os bytes de `media.beehiiv.com`, sobe pro KV `POLL` via
 * `uploadImageToWorkerKV` (mesmo helper que `upload-images-public.ts` já
 * usa) e grava a entrada aqui. Essa parte exige `CLOUDFLARE_ACCOUNT_ID` +
 * `CLOUDFLARE_WORKERS_TOKEN` — sem essas credenciais no ambiente, o mapa
 * fica vazio e `rewriteMigratedBeehiivImages` é um no-op puro (nunca
 * lança, nunca corrompe o HTML) até alguém rodar o CLI com acesso real ao
 * KV de produção.
 *
 * **Quem CONSOME o mapa**: `buildArchivePageHtml` (site-archive-pages.ts),
 * no mesmo ponto de injeção onde `rewriteLegacyImageHost`/
 * `rewriteLegacyResourceLinks` já corrigem host morto — a lição do #7412/
 * #7911/#8351 é que corrigir só os arquivos de SAÍDA não sobrevive à
 * próxima regeneração em massa a partir do cache cru; o fix precisa viver
 * no gerador.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const MAP_PATH = resolve(MODULE_DIR, "archive-image-migration.json");

export interface ArchiveImageMigrationEntry {
  /** Chave gravada no KV `POLL` (`diar.ia.br/img/{key}` serve os bytes). */
  key: string;
  /** `alt` real a gravar no `<img>` migrado — nunca o genérico da Beehiiv
   * (`alt="Author"`, ausente, `alt=""` decorativo sem motivo). */
  alt: string;
}

export interface ArchiveImageMigrationFile {
  /** URL original (exata, como aparece em `src="..."`) → entrada migrada. */
  map?: Record<string, unknown>;
}

/** Mesmo padrão de discriminação de resultado que `PublishDateOverridesResult`
 * (`beehiiv-publish-date.ts`) — distingue "vazio" (normal, nada migrado
 * ainda) de "malformado" (json quebrado — sinaliza sem lançar). */
export interface ArchiveImageMigrationMapResult {
  map: Record<string, ArchiveImageMigrationEntry>;
  error?: string;
  discarded: string[];
}

function isValidEntry(value: unknown): value is ArchiveImageMigrationEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.key === "string" && v.key.length > 0 && typeof v.alt === "string";
}

let cachedResult: ArchiveImageMigrationMapResult | undefined;

/**
 * Carrega `archive-image-migration.json` (lazy, cacheado em módulo — só
 * quando lido do path default; um `mapPath` explícito, usado pelos testes
 * pra apontar pra um fixture temporário, nunca cacheia). Arquivo ausente OU
 * `{}`/`{"map":{}}` são o MESMO estado normal ("nada migrado ainda") — só
 * JSON malformado seta `error` (best-effort warning em stderr).
 */
export function loadArchiveImageMigrationMap(mapPath: string = MAP_PATH): ArchiveImageMigrationMapResult {
  const useCache = mapPath === MAP_PATH;
  if (useCache && cachedResult) return cachedResult;

  let result: ArchiveImageMigrationMapResult;
  if (!existsSync(mapPath)) {
    result = { map: {}, discarded: [] };
  } else {
    try {
      const raw = JSON.parse(readFileSync(mapPath, "utf8")) as ArchiveImageMigrationFile;
      const rawMap = raw.map ?? {};
      const map: Record<string, ArchiveImageMigrationEntry> = {};
      const discarded: string[] = [];
      for (const [url, value] of Object.entries(rawMap)) {
        if (isValidEntry(value)) {
          map[url] = value;
        } else {
          discarded.push(`url "${url}": entrada inválida (esperado {key, alt}, recebido ${JSON.stringify(value)})`);
        }
      }
      result = { map, discarded };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      process.stderr.write(
        `[archive-image-migration] ⚠ falha ao ler ${mapPath}: ${message} — seguindo sem migração.\n`,
      );
      result = { map: {}, error: message, discarded: [] };
    }
  }

  if (useCache) cachedResult = result;
  return result;
}

/** Só pra teste — força o próximo `loadArchiveImageMigrationMap()` (path
 * default) a reler o arquivo em vez de servir o cache em módulo. */
export function resetArchiveImageMigrationMapCache(): void {
  cachedResult = undefined;
}

const IMG_TAG_RE = /<img\b[^>]*>/gi;
const SRC_ATTR_RE = /\ssrc\s*=\s*(["'])([^"']*)\1/i;
const ALT_ATTR_RE = /\salt\s*=\s*(["'])([^"']*)\1/i;

/**
 * Reescreve `<img>` cujo `src` bate EXATAMENTE (string completa, sem
 * normalização) uma URL presente no mapa — o gatilho é sempre uma entrada
 * migrada de verdade (bytes já no KV), nunca um regex de host solto: uma
 * URL de `media.beehiiv.com` AUSENTE do mapa passa intocada (fail-soft —
 * nunca aponta pra uma key que não existe no KV).
 *
 * Sempre GRAVA o `alt` da entrada por cima do que a página tinha —
 * conteúdo 100% renderizado pela Beehiiv, nunca editado à mão pelo editor
 * (`alt="Author"`/ausente são os únicos valores observados nesse HTML,
 * ver #8364), então sobrescrever aqui não apaga curadoria humana nenhuma.
 * `html` sem nenhuma URL mapeada passa intocado (mesma string).
 */
export function rewriteMigratedBeehiivImages(
  html: string,
  map: Record<string, ArchiveImageMigrationEntry>,
  archiveBaseUrl: string,
): string {
  if (Object.keys(map).length === 0) return html;
  return html.replace(IMG_TAG_RE, (tag) => {
    const srcMatch = tag.match(SRC_ATTR_RE);
    if (!srcMatch) return tag;
    const entry = map[srcMatch[2]];
    if (!entry) return tag;

    const newSrc = `${archiveBaseUrl}/img/${entry.key}`;
    let out = tag.replace(SRC_ATTR_RE, ` src="${newSrc}"`);
    if (ALT_ATTR_RE.test(out)) {
      out = out.replace(ALT_ATTR_RE, ` alt="${entry.alt.replace(/"/g, "&quot;")}"`);
    } else {
      out = out.replace(/^<img\b/i, `<img alt="${entry.alt.replace(/"/g, "&quot;")}"`);
    }
    return out;
  });
}
