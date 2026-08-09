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
 * "YYYY-MM-DD"` (aninhado dentro da chave `"overrides"`), consultada ANTES
 * de cair no `publish_date` bruto. O arquivo nasce VAZIO (aguardando as 6
 * datas reais) — popular uma entrada não muda nenhuma outra edição, só
 * o(s) slug(s) presente(s) nele.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const OVERRIDES_PATH = resolve(MODULE_DIR, "beehiiv-publish-date-overrides.json");

/** `YYYY-MM-DD` estrito — mesmo grão que `unixSecondsToBrtDate` produz. O
 * regex barra o formato (`15/06/2025`, números, etc); o round-trip por
 * `Date` barra valores que BATEM o regex mas não são uma data real — não
 * só "mês/dia fora de alcance" tipo "2025-13-45" (`Date` já rejeita isso
 * sozinho, vira `Invalid Date`), mas também rollover silencioso tipo
 * "2025-02-30" (`Date` NÃO rejeita — normaliza pra 2025-03-02, que o
 * regex sozinho deixaria passar como override "válido" apontando pro dia
 * errado). Reformatar o `Date` parseado e comparar contra a string
 * original pega os dois casos. */
const OVERRIDE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidOverrideDate(value: unknown): value is string {
  if (typeof value !== "string" || !OVERRIDE_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

interface PublishDateOverridesFile {
  overrides?: Record<string, unknown>;
}

/**
 * Resultado de `loadPublishDateOverrides` — distingue os 3 estados
 * possíveis do arquivo (achado #1 do fleet review da PR #4803, que
 * corrige a #4796): "ausente" (`error` undefined, `overrides: {}` — estado
 * ESPERADO até as 6 datas reais chegarem, nunca um problema); "presente e
 * válido" (`error` undefined, `overrides` populado com as entradas que
 * passaram na validação de formato); "presente mas malformado" (`error`
 * setado, `overrides: {}` — um erro de sintaxe do editor NÃO deve reverter
 * silenciosamente pro `publish_date` bruto sem sinalizar isso pro caller,
 * que é justamente o bug que a #4796 existe pra corrigir).
 */
export interface PublishDateOverridesResult {
  /** slug → "YYYY-MM-DD", só entradas que passaram em `isValidOverrideDate`. */
  overrides: Record<string, string>;
  /** Setado só quando o arquivo EXISTE mas falhou ao parsear (JSON
   * malformado). `undefined` cobre tanto "arquivo ausente" quanto "arquivo
   * válido" — os dois são estados normais, sem nada a reportar. */
  error?: string;
  /** Entradas descartadas por valor de formato inválido (não bate
   * `YYYY-MM-DD`, não é uma data real, ou é `""`/não-string) — nunca
   * aceitas silenciosamente (achados #2/#3 do fleet review da PR #4803).
   * Sempre um array, mesmo quando vazio. */
  discarded: string[];
}

let cachedResult: PublishDateOverridesResult | undefined;

/**
 * Carrega `beehiiv-publish-date-overrides.json` (lazy, cacheado em módulo
 * — SÓ quando lido do path default; uma invocação com `overridesPath`
 * explícito, usada pelos testes pra apontar pra um fixture temporário,
 * nunca cacheia e nunca lê/escreve o cache do path default). Diferente de
 * `beehiiv-config.ts` (que NÃO cacheia — relê o arquivo em toda chamada) —
 * citado aqui só pelo padrão de resultado discriminado (`{ok: false,
 * reason}` lá, `{overrides, error, discarded}` aqui), não como precedente
 * de cache idêntico. Fail-soft: arquivo ausente ou malformado nunca lança
 * — mas SÓ "ausente" é silencioso por design (não há nada a corrigir);
 * "malformado" sempre volta com `error` setado (mais um warning em
 * stderr, best-effort) pro caller decidir como tornar isso visível — o
 * override existe pra corrigir 6 edições especificas; se o arquivo quebrar
 * silenciosamente, o pipeline volta pro comportamento errado que a #4796
 * existe pra corrigir, sem ninguém perceber.
 */
export function loadPublishDateOverrides(overridesPath: string = OVERRIDES_PATH): PublishDateOverridesResult {
  const useCache = overridesPath === OVERRIDES_PATH;
  if (useCache && cachedResult) return cachedResult;

  let result: PublishDateOverridesResult;
  if (!existsSync(overridesPath)) {
    result = { overrides: {}, discarded: [] };
  } else {
    try {
      const raw = JSON.parse(readFileSync(overridesPath, "utf8")) as PublishDateOverridesFile;
      const rawOverrides = raw.overrides ?? {};
      const overrides: Record<string, string> = {};
      const discarded: string[] = [];
      for (const [slug, value] of Object.entries(rawOverrides)) {
        if (isValidOverrideDate(value)) {
          overrides[slug] = value;
        } else {
          discarded.push(
            `slug "${slug}": valor de override inválido (esperado "YYYY-MM-DD", recebido ${JSON.stringify(value)})`,
          );
        }
      }
      result = { overrides, discarded };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      process.stderr.write(
        `[beehiiv-publish-date] ⚠ falha ao ler ${overridesPath}: ${message} — seguindo sem override.\n`,
      );
      result = { overrides: {}, error: message, discarded: [] };
    }
  }

  if (useCache) cachedResult = result;
  return result;
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
 * todo o resto (comportamento pré-#4796, inalterado pra toda edição fora
 * do override — a contagem exata cresce todo dia, não vale fixar um
 * número aqui). Retorna `null` quando não há override pro slug E
 * `publishDateUnixSeconds` está ausente/inválido — caller decide como
 * reportar (warning, skip, etc), este helper nunca lança nem assume um
 * default silencioso.
 *
 * A checagem de presença é por CHAVE (`Object.hasOwn`), não por truthy
 * (achado #3 do fleet review da PR #4803): um override `""` ou de formato
 * inválido é tratado como AUSENTE, não aceito como data real — caller cai
 * pro `publishDateUnixSeconds` normalmente. `isValidOverrideDate` roda de
 * novo aqui (já rodou em `loadPublishDateOverrides` pro caminho default)
 * porque `overrides` é injetável — um caller que monta o objeto na mão
 * (testes, ou um consumidor futuro) não passou pela validação de load.
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
  overrides: Record<string, string> = loadPublishDateOverrides().overrides,
): string | null {
  if (slug && Object.hasOwn(overrides, slug) && isValidOverrideDate(overrides[slug])) {
    return overrides[slug];
  }
  if (typeof publishDateUnixSeconds === "number" && publishDateUnixSeconds > 0) {
    return unixSecondsToBrtDate(publishDateUnixSeconds);
  }
  return null;
}
