/**
 * onboarding-broadcast-exclusion.ts (#7916 — compat com #7922)
 *
 * O transporte Kit do onboarding (#7922, `scripts/onboarding-kit-transport-run.ts`)
 * envia cada lote de boas-vindas (email1/email2/email3) como um BROADCAST Kit
 * segmentado por tag — o `broadcast_id` fica persistido em
 * `store.kit_transport.lots[*].broadcast_id` (`data/onboarding/store.json`,
 * `onboarding.store_path` no config).
 *
 * `scripts/diaria-subscribers-ingest-kit.ts` ingere TODO broadcast
 * `status: completed` do Kit no store unificado, gravando eventos
 * sent/delivered/open/click com `edicao = broadcast_id`. Sem este filtro, cada
 * lote de onboarding viraria uma "edição" recebida/clicada para
 * `countDistinctEditions` (`leitor-store.ts`) — inflando o `leitor-v1`
 * (limiar de 20 edições recebidas + CTR) justamente na coorte nova, que
 * recebe 3 desses e-mails. Pela Brevo isso nunca aconteceu: o onboarding é
 * transacional e não passa pelo ingest de campanhas
 * (`diaria-subscribers-ingest-brevo.ts`).
 *
 * ## Política de falha
 *
 * Deixar passar um broadcast de onboarding = inflar o `leitor-v1` em
 * silêncio. Por isso:
 * - store ILEGÍVEL (existe, mas não parseia) → LANÇA SEMPRE, independente do
 *   switch. O arquivo existir prova que o transporte já rodou em algum
 *   momento e pode ter persistido lotes — inclusive numa janela anterior com
 *   o switch ligado, seguida de rollback. Ingerir tudo aí contaria esses
 *   lotes como edições. Melhor nenhum dado novo que dado contaminado sem
 *   sinal.
 * - store AUSENTE com `onboarding.kit_transport.enabled === true` → LANÇA.
 * - store AUSENTE com o switch OFF → aviso + conjunto vazio. Com o switch OFF
 *   o executor de produção recusa `--send`, então não há lote NOVO; mas
 *   lotes enviados numa janela anterior com o switch ligado NÃO são
 *   excluídos se o store se perdeu (o aviso diz isso). Abortar aqui
 *   derrubaria a ingestão diária de edições por um subsistema desligado no
 *   estado normal de hoje (store nunca criado).
 * - store legível → exclui todo `broadcast_id` persistido, INDEPENDENTE do
 *   estado do switch (um rollback que desliga o switch não pode fazer os
 *   lotes já enviados voltarem a contar como edição).
 *
 * ## Limites conhecidos
 *
 * - Lotes do modo `--pilot` vivem num store ISOLADO
 *   (`assertPilotStoreIsolated`) que este módulo não lê — os broadcasts de
 *   piloto (só destinatários de teste autorizados) não são excluídos.
 * - Broadcast ÓRFÃO (gap #1 da #7922): criado no Kit, mas o processo morreu
 *   antes de persistir o `broadcast_id` no lote. O lote fica com
 *   `broadcast_id == null` e status ≠ `cancelled`, e o broadcast real — se
 *   chegou a sair — é ingerido como edição. Este módulo não consegue
 *   identificá-lo (a identificação por tag fica fora desta PR); só CONTA
 *   esses lotes (`orphanLots`) e emite aviso alto, pra o ruído não passar
 *   calado. Não aborta nem com o switch ligado: um lote `pending` sem id é
 *   também o estado transitório normal de um lote planejado que ainda não
 *   chegou ao Kit, e abortar travaria a ingestão diária de edições até uma
 *   reconciliação manual.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_STORE_PATH, readStore, type OnboardingStore } from "./onboarding-store.ts";

type KitLots = NonNullable<OnboardingStore["kit_transport"]>["lots"];

export interface OnboardingBroadcastExclusion {
  /** `broadcast_id`s (como string, mesma chave do manifest de ingestão) a excluir. */
  ids: ReadonlySet<string>;
  /**
   * De onde veio o conjunto — `store` = lido com sucesso (mesmo sem lotes);
   * `store-absent` = arquivo inexistente com o switch OFF (exclusão desligada
   * de fato). Store ilegível nunca chega aqui: lança.
   */
  source: "store" | "store-absent";
  kitTransportEnabled: boolean;
  /** Aviso a imprimir no stderr (store ausente com switch OFF, ou lotes órfãos); `null` quando não há. */
  warning: string | null;
  /**
   * `lot_id`s com `broadcast_id == null` e status ≠ `cancelled` — possíveis
   * broadcasts órfãos (gap #1 da #7922), NÃO excluídos. Opcional pra manter
   * simples os fakes de teste; ausente = nenhum.
   */
  orphanLots?: readonly string[];
}

function hasBroadcastId(lot: { broadcast_id: number | null }): lot is { broadcast_id: number } {
  return typeof lot.broadcast_id === "number" && Number.isFinite(lot.broadcast_id);
}

/** @pure — todo `broadcast_id` não-nulo dos lotes persistidos, como string. */
export function collectOnboardingBroadcastIds(lots: KitLots | undefined | null): Set<string> {
  const ids = new Set<string>();
  for (const lot of Object.values(lots ?? {})) {
    if (lot != null && hasBroadcastId(lot)) ids.add(String(lot.broadcast_id));
  }
  return ids;
}

/**
 * @pure — `lot_id`s sem `broadcast_id` e não cancelados: possíveis broadcasts
 * órfãos (criados no Kit, id perdido antes de persistir — gap #1 da #7922).
 */
export function collectOrphanOnboardingLots(lots: KitLots | undefined | null): string[] {
  const orphans: string[] = [];
  for (const [key, lot] of Object.entries(lots ?? {})) {
    if (lot == null) continue;
    if (!hasBroadcastId(lot) && lot.status !== "cancelled") orphans.push(lot.lot_id ?? key);
  }
  return orphans;
}

/**
 * @pure — decide o conjunto de exclusão a partir do que foi lido do disco.
 * Lança quando o store está ilegível (sempre) ou ausente com o transporte Kit
 * LIGADO (ver "Política de falha" na docstring do módulo).
 */
export function decideOnboardingBroadcastExclusion(input: {
  storeExists: boolean;
  corrupted: boolean;
  lots: KitLots | undefined | null;
  kitTransportEnabled: boolean;
  storePath: string;
}): OnboardingBroadcastExclusion {
  const { storeExists, corrupted, lots, kitTransportEnabled, storePath } = input;
  if (corrupted) {
    throw new Error(
      `[onboarding-broadcast-exclusion] store de onboarding ilegível (${storePath}) — o arquivo existe, então o ` +
        "transporte Kit já rodou e pode ter lotes persistidos (inclusive de uma janela anterior com o switch " +
        "ligado); impossível saber quais broadcasts do Kit são lotes de onboarding. Abortando a ingestão em vez " +
        `de contá-los como edições e inflar o leitor-v1 (#7916; onboarding.kit_transport.enabled=${kitTransportEnabled}).`,
    );
  }
  if (!storeExists) {
    if (kitTransportEnabled) {
      throw new Error(
        `[onboarding-broadcast-exclusion] store de onboarding ausente (${storePath}) com ` +
          "onboarding.kit_transport.enabled=true — impossível saber quais broadcasts do Kit são lotes de " +
          "onboarding; abortando a ingestão em vez de contá-los como edições e inflar o leitor-v1 (#7916).",
      );
    }
    return {
      ids: new Set(),
      source: "store-absent",
      kitTransportEnabled,
      orphanLots: [],
      warning:
        `[onboarding-broadcast-exclusion] store de onboarding ausente (${storePath}) — transporte Kit desligado, ` +
        "seguindo sem excluir broadcasts de onboarding: sem lotes NOVOS com o switch OFF, mas lotes enviados " +
        "numa janela anterior com o switch ligado NÃO são excluídos se o store se perdeu (#7916).",
    };
  }
  const orphanLots = collectOrphanOnboardingLots(lots);
  const warning =
    orphanLots.length > 0
      ? `[onboarding-broadcast-exclusion] ${orphanLots.length} lote(s) de onboarding sem broadcast_id e não ` +
        `cancelado(s) (${orphanLots.join(", ")}) — se algum chegou a criar broadcast no Kit (id perdido antes ` +
        "de persistir, gap #1 da #7922), ele está sendo ingerido como EDIÇÃO e infla o leitor-v1. Reconciliar " +
        "via onboarding-kit-transport-run.ts (#7916)."
      : null;
  return { ids: collectOnboardingBroadcastIds(lots), source: "store", kitTransportEnabled, orphanLots, warning };
}

/** @pure — separa os broadcasts de onboarding dos de edição. Preserva a ordem. */
export function excludeOnboardingBroadcasts<T extends { id: number | string }>(
  broadcasts: readonly T[],
  ids: ReadonlySet<string>,
): { kept: T[]; excluded: T[] } {
  const kept: T[] = [];
  const excluded: T[] = [];
  for (const b of broadcasts) (ids.has(String(b.id)) ? excluded : kept).push(b);
  return { kept, excluded };
}

/**
 * I/O — lê `platform.config.json` (`onboarding.store_path`,
 * `onboarding.kit_transport.enabled`) e o store de onboarding. Config
 * ilegível LANÇA: sem ele não dá pra saber se o switch está ligado.
 *
 * Resolução de path: `store_path` relativo é resolvido contra o DIRETÓRIO DO
 * CONFIG, não contra a raiz do repo como o executor faz
 * (`resolve(ROOT, store_path)` em `onboarding-kit-transport-run.ts`). Em
 * produção o config vive na raiz do repo, então os dois resolvem o mesmo
 * arquivo; a diferença só aparece com `--config` apontando pra outro
 * diretório (fixtures de teste, deliberadamente herméticas). Sem
 * `store_path` no config, o fallback é `DEFAULT_STORE_PATH` do módulo do
 * store (absoluto, raiz do repo) — o mesmo do executor.
 */
export function readOnboardingBroadcastExclusion(configPathAbs: string): OnboardingBroadcastExclusion {
  const raw = JSON.parse(readFileSync(configPathAbs, "utf8")) as {
    onboarding?: { store_path?: string; kit_transport?: { enabled?: boolean } };
  };
  const storePath = resolve(dirname(configPathAbs), raw.onboarding?.store_path ?? DEFAULT_STORE_PATH);
  const kitTransportEnabled = raw.onboarding?.kit_transport?.enabled === true;
  const storeExists = existsSync(storePath);
  const { store, corrupted } = storeExists ? readStore(storePath) : { store: null, corrupted: false };
  return decideOnboardingBroadcastExclusion({
    storeExists,
    corrupted,
    lots: store?.kit_transport?.lots,
    kitTransportEnabled,
    storePath,
  });
}
