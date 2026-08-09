/**
 * beehiiv-publish-date.ts (#4796)
 *
 * Helper compartilhado que resolve a data de publicação "canônica" de um
 * post do cache Beehiiv (`data/beehiiv-cache/posts/*.json`) pra exibição em
 * `workers/arquivo/` (home do arquivo + hubs temáticos). Extraído de
 * `generate-arquivo-titles.ts` (`buildTitlesCache`) e
 * `generate-hub-sources.ts` (`collectHubSources`), que antes duplicavam a
 * MESMA conversão Unix→BRT cada um com sua função local
 * (`publishDateLabel`/`toDateBrt`) — a lógica agora vive num lugar só.
 *
 * **Override por slug (#4796):** `publish_date` (e `created`, o único outro
 * campo de data que a API Beehiiv devolve) MENTEM pras 6 primeiras edições
 * já publicadas — ambos apontam pro dia do import em lote pro Beehiiv
 * (2025-09-03, num intervalo de ~9h), não pra data real de cada envio por
 * e-mail (a diar.ia.br rodava direto por e-mail antes de migrar pro Beehiiv
 * como ESP). Não existe campo na API Beehiiv que recupere a data real — ela
 * só sai do editor (Gmail pessoal/memória, issue #4796 passo 1).
 * `beehiiv-publish-date-overrides.json` guarda a correção `slug →
 * "YYYY-MM-DD"`, consultada ANTES de cair no `publish_date` bruto. O
 * arquivo nasce VAZIO (aguardando as 6 datas reais) — popular uma entrada
 * não muda nenhuma outra edição, só o(s) slug(s) presente(s) nele.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const OVERRIDES_PATH = resolve(MODULE_DIR, "beehiiv-publish-date-overrides.json");

interface PublishDateOverridesFile {
  overrides?: Record<string, string>;
}

let cachedOverrides: Record<string, string> | undefined;

/**
 * Carrega `beehiiv-publish-date-overrides.json` (lazy, cacheado em módulo —
 * mesmo padrão de `beehiiv-config.ts`). Fail-soft: arquivo ausente ou
 * malformado nunca lança, só cai em `{}` (comportamento idêntico a "sem
 * override nenhum") com um warning em stderr — o override é uma correção
 * pontual, não um dado obrigatório pro pipeline funcionar.
 */
export function loadPublishDateOverrides(): Record<string, string> {
  if (cachedOverrides) return cachedOverrides;
  if (!existsSync(OVERRIDES_PATH)) {
    cachedOverrides = {};
    return cachedOverrides;
  }
  try {
    const raw = JSON.parse(readFileSync(OVERRIDES_PATH, "utf8")) as PublishDateOverridesFile;
    cachedOverrides = raw.overrides ?? {};
  } catch (e) {
    process.stderr.write(
      `[beehiiv-publish-date] ⚠ falha ao ler ${OVERRIDES_PATH}: ${e instanceof Error ? e.message : e} — seguindo sem override.\n`,
    );
    cachedOverrides = {};
  }
  return cachedOverrides;
}

/** Unix seconds → `YYYY-MM-DD` ajustado pra BRT (UTC-3) — mesmo ajuste
 * histórico de `publishDateLabel`/`toDateBrt`/`monthly-relink-to-diaria.ts`,
 * pra publicações de madrugada não vazarem pro dia UTC seguinte/anterior. */
export function unixSecondsToBrtDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000 - 3 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve a data de publicação "canônica" de um post: consulta o override
 * por slug primeiro (#4796); cai no `publishDateUnixSeconds` convertido pra
 * todo o resto (comportamento pré-#4796, inalterado pras outras ~227
 * edições). Retorna `null` quando não há override pro slug E
 * `publishDateUnixSeconds` está ausente/inválido — caller decide como
 * reportar (warning, skip, etc), este helper nunca lança nem assume um
 * default silencioso.
 *
 * @param slug                     Slug do post (já resolvido pelo caller —
 *                                  cada script tem sua própria lógica de
 *                                  fallback pra derivar slug de `web_url`,
 *                                  não duplicada aqui).
 * @param publishDateUnixSeconds   `post.publish_date` (Unix seconds).
 * @param overrides                Injetável pra testes; default é o arquivo
 *                                  committado, carregado lazy e cacheado.
 */
export function resolvePublishDate(
  slug: string | null | undefined,
  publishDateUnixSeconds: number | null | undefined,
  overrides: Record<string, string> = loadPublishDateOverrides(),
): string | null {
  if (slug && overrides[slug]) return overrides[slug];
  if (typeof publishDateUnixSeconds === "number" && publishDateUnixSeconds > 0) {
    return unixSecondsToBrtDate(publishDateUnixSeconds);
  }
  return null;
}
