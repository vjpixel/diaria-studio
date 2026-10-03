/**
 * test/_helpers/pmax-stateful-search.ts (#8550)
 *
 * Desde que `google-ads-swap-asset-group-creatives.ts` RELÊ o grupo depois de
 * cada fase (escrita silenciosa — 2xx não prova o estado), um mock cujo
 * `:search` devolve sempre as mesmas linhas faz a releitura falhar. Este
 * wrapper mantém o estado do grupo: responde `:search` com o estado atual e,
 * quando o `assetGroupAssets:mutate` do mock interno devolve 2xx, aplica as
 * operações (remove → some; create → linha nova ENABLED/APPROVED). Todo o
 * resto (token, `assets:mutate`, respostas de erro) segue pro mock interno.
 *
 * Também fixa `PMAX_SWAP_PLAN_OUT` num diretório temporário — o plano JSON
 * nunca é gravado no `data/` real.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssetGroupAssetApiRow } from "../../scripts/lib/google-ads-asset-group-assets.ts";

/** Caminho temporário pro plano JSON — use em `AUTH_ENV` dos testes da CLI. */
export const PMAX_PLAN_OUT_TMP = join(mkdtempSync(join(tmpdir(), "gads-pmax-plan-")), "plan.json");

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function withStatefulSearch(inner: FetchLike, initialRows: readonly AssetGroupAssetApiRow[]): FetchLike {
  const rows = new Map<string, AssetGroupAssetApiRow>();
  for (const r of initialRows) rows.set(r.assetGroupAsset!.resourceName!, r);
  return async (input, init) => {
    if (input.endsWith(":search")) {
      return new Response(JSON.stringify({ results: [...rows.values()] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const res = await inner(input, init);
    if (input.endsWith("assetGroupAssets:mutate") && res.ok) {
      const body = JSON.parse(String(init?.body)) as {
        operations: Array<{ remove?: string; create?: { assetGroup: string; asset: string; fieldType: string } }>;
      };
      for (const op of body.operations) {
        if (op.remove) rows.delete(op.remove);
        else if (op.create) {
          const id = op.create.asset.split("/").pop()!;
          const groupId = op.create.assetGroup.split("/").pop()!;
          const customer = op.create.assetGroup.split("/")[1];
          const rn = `customers/${customer}/assetGroupAssets/${groupId}~${id}~${op.create.fieldType}`;
          rows.set(rn, {
            asset: { resourceName: op.create.asset, id, type: op.create.fieldType.includes("IMAGE") ? "IMAGE" : "TEXT" },
            assetGroupAsset: { resourceName: rn, asset: op.create.asset, fieldType: op.create.fieldType, status: "ENABLED", policySummary: { approvalStatus: "APPROVED" } },
          });
        }
      }
    }
    return res;
  };
}
