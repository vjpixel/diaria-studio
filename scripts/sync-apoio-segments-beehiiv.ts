#!/usr/bin/env node
/**
 * scripts/sync-apoio-segments-beehiiv.ts (#4437 Entrega 2)
 *
 * Popula o cache LOCAL `data/apoia-se/beehiiv-segments.json` — usado pelo
 * painel Apoios do Studio (`deriveSegments` em `studio-ui/studio-apoios.ts`)
 * pra mostrar, no card de cada contato, em quais dos 6 segmentos
 * `Apoio — {Amigo,Apoiador,Mantenedor,Patrono,Todos,Nenhum}` ele está.
 *
 * ## Não existe endpoint de membership dedicado
 *
 * A pertinência é DERIVADA do custom field `apoio_nivel` (mesmo campo que
 * `sync-apoio-nivel-beehiiv.ts` escreve), usando a MESMA condição canônica de
 * `scripts/lib/apoio-segments-canonical.ts` (#4436) — nenhuma regra nova,
 * nenhuma reimplementação: um `apoio_nivel` setado casa com a faixa
 * correspondente + "Apoio — Todos"; `apoio_nivel` vazio/ausente casa só com
 * "Apoio — Nenhum". Reusa `fetchCurrentBeehiivState` de
 * `sync-apoio-nivel-beehiiv.ts` (leitura paginada de `/subscriptions`, já
 * existente e já testada) — este script SÓ LÊ da Beehiiv, nunca escreve.
 *
 * ## Dependência com #4436
 *
 * O `--push` de `sync-apoio-nivel-beehiiv.ts` nunca rodou ao vivo até esta
 * unidade (#4437) — rodar ESTE script contra a Beehiiv real hoje encontraria
 * `apoio_nivel` vazio pra praticamente toda a base, e o cache gerado
 * mostraria "Apoio — Nenhum" pra quase todo mundo. Não é um bug deste
 * script: reflete o estado real (nada foi escrito na Beehiiv ainda). O
 * painel Apoios explicita isso na UI ("sem segmento" pode significar "sync
 * nunca rodou", não "assinante fora da base") — ver `apoios.js`/`apoios.html`.
 *
 * ## IMPORTANTE — nunca executado nesta sessão
 *
 * Este script NUNCA foi executado contra a Beehiiv real nesta unidade (#4437,
 * rodada `/diaria-overnight`) — o guard de publicação da rodada proíbe rodar
 * scripts que toquem Beehiiv/apoia.se ao vivo, mesmo em modo leitura.
 * Validado só via testes com fixtures (`fetchImpl`/`fetchCurrentBeehiivState`
 * mockados, nenhuma chamada de rede real) — ver
 * `test/sync-apoio-segments-beehiiv.test.ts`.
 *
 * Uso:
 *   npx tsx scripts/sync-apoio-segments-beehiiv.ts
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { loadBeehiivConfig } from "./lib/beehiiv-config.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { fetchCurrentBeehiivState, type BeehiivSubscriptionSnapshot, type ApoioNivel } from "./sync-apoio-nivel-beehiiv.ts";
import { segmentsCachePath, type SegmentsCache } from "./studio-ui/studio-apoios.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[sync-apoio-segments-beehiiv]";

/** Nome exato dos 4 segmentos por faixa — mesmos nomes de
 * `scripts/lib/apoio-segments-canonical.ts::APOIO_SEGMENTS_CANONICAL`, não
 * duplicados como string solta em outro lugar além daqui e daquele módulo. */
const NIVEL_TO_SEGMENT_NAME: Record<ApoioNivel, string> = {
  amigo: "Apoio — Amigo",
  apoiador: "Apoio — Apoiador",
  mantenedor: "Apoio — Mantenedor",
  patrono: "Apoio — Patrono",
};

const SEGMENT_NAME_TODOS = "Apoio — Todos";
const SEGMENT_NAME_NENHUM = "Apoio — Nenhum";

/** Achado do self-review (#4437): `v in NIVEL_TO_SEGMENT_NAME` seria um bug
 * de object-injection — `apoio_nivel` vem de um custom field EXTERNO
 * (editável na UI da Beehiiv, string arbitrária), e o operador `in` também
 * enxerga a cadeia de protótipo (`"toString" in {}` é `true`). Um valor tipo
 * `"toString"`/`"constructor"` falsamente casaria como nível válido e
 * `NIVEL_TO_SEGMENT_NAME[apoioNivel]` devolveria uma função do
 * `Object.prototype` em vez de `undefined`. Mesmo padrão SEGURO já usado por
 * `sync-apoio-nivel-beehiiv.ts::isApoioNivel` (array `.includes()`, que
 * compara só VALORES, nunca enxerga protótipo). */
const APOIO_NIVEL_VALUES: readonly ApoioNivel[] = ["amigo", "apoiador", "mantenedor", "patrono"];

function isApoioNivel(v: string): v is ApoioNivel {
  return APOIO_NIVEL_VALUES.includes(v as ApoioNivel);
}

/**
 * Pure: deriva os segmentos `Apoio — *` de que um assinante faz parte a
 * partir do valor do custom field `apoio_nivel` — espelha exatamente as
 * condições-alvo de `APOIO_SEGMENTS_CANONICAL` (#4436): nível setado casa
 * com a faixa correspondente + "Todos"; nível vazio/desconhecido casa só com
 * "Nenhum".
 */
export function segmentsForNivel(apoioNivel: string): string[] {
  if (isApoioNivel(apoioNivel)) {
    return [NIVEL_TO_SEGMENT_NAME[apoioNivel], SEGMENT_NAME_TODOS];
  }
  return [SEGMENT_NAME_NENHUM];
}

/**
 * Pure: monta o cache completo (`email normalizado → SegmentsInfo`) a partir
 * do snapshot de assinantes Beehiiv já lido por `fetchCurrentBeehiivState`
 * (que já normaliza email pra lowercase/trim). `now` injetável pra teste
 * determinístico de `checkedAt`.
 */
export function buildSegmentsCache(
  subscriptions: readonly BeehiivSubscriptionSnapshot[],
  now: Date = new Date(),
): SegmentsCache {
  const checkedAt = now.toISOString();
  const cache: SegmentsCache = {};
  for (const sub of subscriptions) {
    cache[sub.email] = {
      segments: segmentsForNivel(sub.apoioNivel),
      apoioNivel: sub.apoioNivel,
      checkedAt,
    };
  }
  return cache;
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const { apiKey, publicationId } = loadBeehiivConfig(LOG_PREFIX);

  process.stderr.write(`${LOG_PREFIX} buscando estado atual na Beehiiv…\n`);
  const subscriptions = await fetchCurrentBeehiivState(publicationId, apiKey);
  process.stderr.write(`${LOG_PREFIX} ${subscriptions.length} assinante(s) ativo(s) na Beehiiv.\n`);

  const cache = buildSegmentsCache(subscriptions);
  const path = segmentsCachePath(ROOT);
  writeFileAtomic(path, JSON.stringify(cache, null, 2));
  process.stderr.write(`${LOG_PREFIX} cache gravado em ${path} (${Object.keys(cache).length} email(s)).\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${LOG_PREFIX} erro fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
