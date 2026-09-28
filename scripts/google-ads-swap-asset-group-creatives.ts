#!/usr/bin/env npx tsx
/**
 * scripts/google-ads-swap-asset-group-creatives.ts (#8550)
 *
 * Troca os criativos (texto + imagem) do grupo de recursos PMax "Max"
 * (`asset_group_asset` id `6642889160`, campanha `23343492446`) pelos
 * novos definidos na issue #8550 — script commitado com `--dry-run` como
 * comportamento DEFAULT, seguindo o pedido explícito da revisão de
 * 20/09/2026 ("passo 3 vira script commitado, não sessão manual").
 *
 * ## NÃO EXECUTAR --send hoje (28/09/2026) — ler antes de rodar
 *
 * Duas travas independentes, cada uma sozinha já bloqueia:
 *
 *   1. **Editor declinou autorização hoje.** `/diaria-desbloqueia`
 *      (28/09/2026) perguntou explicitamente e a resposta foi "ainda não"
 *      — marcador `acao-adiada` no comentário da issue #8550, cooldown de
 *      7 dias (`scripts/lib/issue-decisions.ts` — `isAcaoAdiadaAtiva`).
 *      Reperguntar antes do cooldown expirar (~05/10/2026) repete uma
 *      pergunta já respondida.
 *   2. **As imagens novas não existem ainda.** A decisão do editor (20/09)
 *      pede overlays das artes que rodam na Meta SEM o botão "Assine
 *      grátis" e SEM título/subtítulo queimados, gerados a partir dos
 *      masters, mais o formato 1,91:1 que não existe em nenhum conjunto
 *      hoje. Gerar essas imagens é edição de imagem, fora do escopo deste
 *      script (que só fala com a Google Ads API) — por isso `--send` exige
 *      `--images-manifest` apontando pros 12 arquivos finais (4 criativos
 *      × 3 proporções) e RECUSA rodar se qualquer um estiver ausente.
 *
 * Rodar em modo leitura (default, sem `--send`) é seguro a qualquer
 * momento — só lê o estado atual e imprime o plano, nenhuma mutação.
 *
 * ## Fluxo em 2 fases (sequenciamento da issue #8550)
 *
 *   Fase 1 (`--send`, sem `--remove-stale`): cria os textos novos + as
 *   imagens do manifesto, linka tudo ao grupo de recursos. NÃO remove nada
 *   dos antigos.
 *
 *   Fase 2 (`--send --remove-stale`, rodado numa invocação SEPARADA
 *   depois de confirmar pela API que os novos estão `ENABLED` e sem
 *   reprovação): remove os `asset_group_asset` classificados como stale
 *   na leitura mais recente.
 *
 * `needsReview` (hoje: `logo_1.jpg` e qualquer texto ENABLED desconhecido)
 * NUNCA é tocado por nenhuma fase — fica de fora do plano, reportado à
 * parte pra decisão humana.
 *
 * ## Uso
 *
 *   npx tsx scripts/google-ads-swap-asset-group-creatives.ts
 *     # dry-run — lê o estado atual, classifica, imprime o plano completo
 *
 *   doppler run -- npx tsx scripts/google-ads-swap-asset-group-creatives.ts \
 *     --images-manifest data/aquisicao/campanhas-260816/criativos/pmax-images-manifest.json --send
 *     # Fase 1 — cria texto+imagem novos, linka ao grupo (recusa se
 *     # qualquer imagem do manifesto estiver ausente)
 *
 *   doppler run -- npx tsx scripts/google-ads-swap-asset-group-creatives.ts \
 *     --send --remove-stale
 *     # Fase 2 — remove os asset_group_asset stale (rodar só depois de
 *     # confirmar os novos ENABLED/sem reprovação)
 *
 * Formato de `--images-manifest` (JSON):
 *   {
 *     "SQUARE_MARKETING_IMAGE": ["caminho/d1-1x1.jpg", "caminho/d2-1x1.jpg", ...],
 *     "MARKETING_IMAGE": ["caminho/d1-191x1.jpg", ...],
 *     "PORTRAIT_MARKETING_IMAGE": ["caminho/d1-4x5.jpg", ...]
 *   }
 */

import { existsSync, readFileSync } from "node:fs";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import {
  buildAssetGroupAssetsQuery,
  parseAssetGroupAssetRows,
  classifyAssetGroupAssets,
  validateNewTextAssetPlan,
  buildCreateTextAssetsPayload,
  buildCreateImageAssetPayload,
  buildLinkAssetGroupAssetsPayload,
  buildRemoveAssetGroupAssetsPayload,
  NEW_HEADLINES,
  NEW_LONG_HEADLINES,
  NEW_DESCRIPTIONS,
  type AssetGroupAssetApiRow,
  type AssetGroupFieldType,
} from "./lib/google-ads-asset-group-assets.ts";
import { refreshGoogleAdsAccessToken, postGoogleAdsWithLoginRetry, DEFAULT_API_VERSION } from "./lib/google-ads-ingest.ts";
import { authConfigFromEnv } from "./lib/google-ads-conversion-sender.ts";

const DEFAULT_ASSET_GROUP_ID = "6642889160";

const IMAGE_FIELD_TYPES: readonly Extract<AssetGroupFieldType, string>[] = [
  "SQUARE_MARKETING_IMAGE",
  "MARKETING_IMAGE",
  "PORTRAIT_MARKETING_IMAGE",
];

interface ImagesManifest {
  SQUARE_MARKETING_IMAGE?: string[];
  MARKETING_IMAGE?: string[];
  PORTRAIT_MARKETING_IMAGE?: string[];
}

/** Valida o manifesto de imagens — todos os 3 tipos precisam de ao menos 1
 *  entrada, e todo caminho listado precisa existir em disco. Nunca lança;
 *  devolve a lista de problemas pro caller decidir. @pure exceto pelo
 *  `existsSync` (I/O intencional — é exatamente o que valida). */
function validateImagesManifest(manifest: ImagesManifest): string[] {
  const errors: string[] = [];
  for (const fieldType of IMAGE_FIELD_TYPES) {
    const paths = manifest[fieldType as keyof ImagesManifest] ?? [];
    if (paths.length === 0) {
      errors.push(`manifesto não tem nenhum caminho para ${fieldType}`);
      continue;
    }
    for (const p of paths) {
      if (!existsSync(p)) errors.push(`arquivo ausente (${fieldType}): ${p}`);
    }
  }
  return errors;
}

async function readCurrentAssetGroupAssets(
  fetchFn: typeof fetch,
  auth: Parameters<typeof postGoogleAdsWithLoginRetry>[1] & { apiVersion?: string },
  accessToken: string,
  assetGroupResourceName: string,
) {
  const apiVersion = auth.apiVersion ?? DEFAULT_API_VERSION;
  const customerId = auth.customerId.replace(/[^0-9]/g, "");
  const url = `https://googleads.googleapis.com/${apiVersion}/customers/${customerId}/googleAds:search`;
  const query = buildAssetGroupAssetsQuery(assetGroupResourceName);
  const attempt = await postGoogleAdsWithLoginRetry(fetchFn, auth, accessToken, url, JSON.stringify({ query }), "assetGroupAsset:search");
  if ("networkError" in attempt) return { error: attempt.networkError };
  if (!attempt.res.ok) return { error: `googleAds:search respondeu HTTP ${attempt.res.status}: ${attempt.text.slice(0, 800)}` };
  let payload: { results?: AssetGroupAssetApiRow[] };
  try {
    payload = JSON.parse(attempt.text);
  } catch {
    return { error: `googleAds:search respondeu corpo não-JSON (HTTP ${attempt.res.status})` };
  }
  return { items: parseAssetGroupAssetRows(payload.results ?? []) };
}

export async function main(argv: string[] = process.argv.slice(2), fetchFn: typeof fetch = fetch): Promise<number> {
  loadProjectEnv();

  const assetGroupId = getStringArg(argv, "asset-group-id", { example: DEFAULT_ASSET_GROUP_ID }) ?? DEFAULT_ASSET_GROUP_ID;
  const customerId = getStringArg(argv, "customer-id", { example: "2369219639" }) ?? process.env.GOOGLE_ADS_CUSTOMER_ID;
  const send = hasFlag(argv, "send");
  const removeStale = hasFlag(argv, "remove-stale");
  const manifestPath = getStringArg(argv, "images-manifest", { example: "path/to/manifest.json" });

  if (!customerId) {
    console.error("[google-ads-swap-asset-group-creatives] ✖ --customer-id (ou GOOGLE_ADS_CUSTOMER_ID) é obrigatório.");
    return 1;
  }

  const configResult = authConfigFromEnv(process.env, customerId);
  if ("missing" in configResult) {
    console.error(
      `[google-ads-swap-asset-group-creatives] ✖ variáveis de ambiente ausentes: ${configResult.missing.join(", ")}. ` +
        "Rode via `doppler run -- npx tsx ...`.",
    );
    return 1;
  }
  const { auth } = configResult;
  const assetGroupResourceName = `customers/${customerId.replace(/[^0-9]/g, "")}/assetGroups/${assetGroupId}`;

  const tokenResult = await refreshGoogleAdsAccessToken(fetchFn, auth);
  if ("error" in tokenResult) {
    console.error(`[google-ads-swap-asset-group-creatives] ✖ falha ao renovar access token: ${tokenResult.error}`);
    return 1;
  }
  // Extraído numa `const` própria pra permanecer estreitado (`string`, não
  // a união com `{ error }`) dentro de closures declaradas mais abaixo
  // (`createAssets`) — narrowing de `tokenResult` não atravessa function
  // declarations aninhadas.
  const accessToken = tokenResult.accessToken;

  console.log(`[google-ads-swap-asset-group-creatives] lendo estado atual de ${assetGroupResourceName}...`);
  const current = await readCurrentAssetGroupAssets(fetchFn, auth, accessToken, assetGroupResourceName);
  if ("error" in current) {
    console.error(`[google-ads-swap-asset-group-creatives] ✖ falha ao ler estado atual: ${current.error}`);
    return 1;
  }

  const classification = classifyAssetGroupAssets(current.items);
  console.log(
    `[google-ads-swap-asset-group-creatives] ${current.items.length} registro(s) lido(s) — ` +
      `${classification.stale.length} stale, ${classification.keep.length} keep, ` +
      `${classification.needsReview.length} needsReview, ${classification.protectedItems.length} protected.`,
  );
  if (classification.needsReview.length > 0) {
    console.log("[google-ads-swap-asset-group-creatives] needsReview (decisão humana pendente, NUNCA tocado automaticamente):");
    for (const item of classification.needsReview) {
      console.log(`  - ${item.fieldType} ${item.assetId} ${item.text ? JSON.stringify(item.text) : item.imageName}`);
    }
  }

  if (removeStale) {
    if (!send) {
      console.log("[google-ads-swap-asset-group-creatives] --remove-stale sem --send: plano de remoção (dry-run):");
      for (const item of classification.stale) {
        console.log(`  removeria: ${item.assetGroupAssetResourceName} (${item.fieldType})`);
      }
      return 0;
    }
    if (classification.stale.length === 0) {
      console.log("[google-ads-swap-asset-group-creatives] nada stale a remover — nenhuma chamada de mutação necessária.");
      return 0;
    }
    const removePayload = buildRemoveAssetGroupAssetsPayload(classification.stale.map((i) => i.assetGroupAssetResourceName));
    const apiVersion = auth.apiVersion ?? DEFAULT_API_VERSION;
    const url = `https://googleads.googleapis.com/${apiVersion}/customers/${customerId.replace(/[^0-9]/g, "")}/assetGroupAssets:mutate`;
    console.log(`[google-ads-swap-asset-group-creatives] removendo ${classification.stale.length} asset_group_asset stale...`);
    const attempt = await postGoogleAdsWithLoginRetry(fetchFn, auth, accessToken, url, JSON.stringify(removePayload), "assetGroupAssets:mutate (remove)");
    if ("networkError" in attempt) {
      console.error(`[google-ads-swap-asset-group-creatives] ✖ falha de rede: ${attempt.networkError}`);
      return 1;
    }
    if (!attempt.res.ok) {
      console.error(`[google-ads-swap-asset-group-creatives] ✖ assetGroupAssets:mutate (remove) respondeu HTTP ${attempt.res.status}: ${attempt.text.slice(0, 1000)}`);
      return 1;
    }
    console.log(`[google-ads-swap-asset-group-creatives] ✔ ${classification.stale.length} recurso(s) removido(s): ${attempt.text.slice(0, 500)}`);
    return 0;
  }

  // Fase 1: adicionar os novos (texto sempre; imagem só com manifesto válido).
  const textValidation = validateNewTextAssetPlan(NEW_HEADLINES, NEW_LONG_HEADLINES, NEW_DESCRIPTIONS);
  console.log(
    `[google-ads-swap-asset-group-creatives] plano de texto novo: ${NEW_HEADLINES.length} headlines, ` +
      `${NEW_LONG_HEADLINES.length} long headlines, ${NEW_DESCRIPTIONS.length} descriptions — ` +
      `${textValidation.ok ? "dentro dos limites do PMax" : "FORA dos limites do PMax"}.`,
  );
  if (!textValidation.ok) {
    for (const e of textValidation.errors) console.error(`  ✖ ${e}`);
  }

  let manifest: ImagesManifest | null = null;
  let manifestErrors: string[] = ["--images-manifest não foi passado — imagens novas ainda não existem (ver docstring do módulo)."];
  if (manifestPath) {
    if (!existsSync(manifestPath)) {
      manifestErrors = [`--images-manifest aponta pra um arquivo que não existe: ${manifestPath}`];
    } else {
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifestErrors = validateImagesManifest(manifest!);
      } catch (e) {
        manifestErrors = [`falha ao ler/parsear --images-manifest: ${e instanceof Error ? e.message : e}`];
      }
    }
  }

  if (manifestErrors.length > 0) {
    console.log("[google-ads-swap-asset-group-creatives] imagens PENDENTES — plano de imagem não pode ser executado ainda:");
    for (const e of manifestErrors) console.log(`  - ${e}`);
  }

  if (!send) {
    console.log("[google-ads-swap-asset-group-creatives] DRY-RUN (default) — plano de texto que seria criado:");
    console.log(JSON.stringify(buildCreateTextAssetsPayload(NEW_HEADLINES, "HEADLINE"), null, 2));
    console.log(JSON.stringify(buildCreateTextAssetsPayload(NEW_LONG_HEADLINES, "LONG_HEADLINE"), null, 2));
    console.log(JSON.stringify(buildCreateTextAssetsPayload(NEW_DESCRIPTIONS, "DESCRIPTION"), null, 2));
    console.log(
      "[google-ads-swap-asset-group-creatives] stale hoje (candidatos à remoção NA FASE 2, depois de confirmar os novos):",
    );
    for (const item of classification.stale) {
      console.log(`  - ${item.fieldType} ${item.assetId} ${item.text ? JSON.stringify(item.text) : item.imageName}`);
    }
    console.log("[google-ads-swap-asset-group-creatives] rode com --send (e --images-manifest quando as imagens existirem) para executar a Fase 1.");
    return 0;
  }

  if (!textValidation.ok || manifestErrors.length > 0) {
    console.error("[google-ads-swap-asset-group-creatives] ✖ --send recusado: plano de texto ou imagem tem pendências (ver acima). Nenhuma mutação foi feita.");
    return 1;
  }

  // A partir daqui, texto E imagem estão prontos (validados acima) — Fase 1
  // de verdade: cria os assets novos e linka ao grupo. NUNCA remove nada
  // (isso é --remove-stale, Fase 2, numa invocação separada).
  const apiVersion = auth.apiVersion ?? DEFAULT_API_VERSION;
  const numericCustomerId = customerId.replace(/[^0-9]/g, "");
  const assetsMutateUrl = `https://googleads.googleapis.com/${apiVersion}/customers/${numericCustomerId}/assets:mutate`;
  const linkMutateUrl = `https://googleads.googleapis.com/${apiVersion}/customers/${numericCustomerId}/assetGroupAssets:mutate`;

  async function createAssets(payload: unknown, label: string): Promise<{ resourceNames: string[] } | { error: string }> {
    const attempt = await postGoogleAdsWithLoginRetry(fetchFn, auth, accessToken, assetsMutateUrl, JSON.stringify(payload), label);
    if ("networkError" in attempt) return { error: attempt.networkError };
    if (!attempt.res.ok) return { error: `assets:mutate (${label}) respondeu HTTP ${attempt.res.status}: ${attempt.text.slice(0, 1000)}` };
    let parsed: { results?: Array<{ resourceName?: string }> };
    try {
      parsed = JSON.parse(attempt.text);
    } catch {
      return { error: `assets:mutate (${label}) respondeu corpo não-JSON (HTTP ${attempt.res.status})` };
    }
    const resourceNames = (parsed.results ?? []).map((r) => r.resourceName).filter((r): r is string => Boolean(r));
    if (resourceNames.length !== (parsed.results ?? []).length) {
      return { error: `assets:mutate (${label}) devolveu resultado sem resourceName — resposta: ${attempt.text.slice(0, 500)}` };
    }
    return { resourceNames };
  }

  console.log("[google-ads-swap-asset-group-creatives] Fase 1 — criando textos novos...");
  const headlineResult = await createAssets(buildCreateTextAssetsPayload(NEW_HEADLINES, "HEADLINE"), "assets:mutate (headlines)");
  if ("error" in headlineResult) {
    console.error(`[google-ads-swap-asset-group-creatives] ✖ ${headlineResult.error}`);
    return 1;
  }
  const longHeadlineResult = await createAssets(buildCreateTextAssetsPayload(NEW_LONG_HEADLINES, "LONG_HEADLINE"), "assets:mutate (long headlines)");
  if ("error" in longHeadlineResult) {
    console.error(`[google-ads-swap-asset-group-creatives] ✖ ${longHeadlineResult.error}`);
    return 1;
  }
  const descriptionResult = await createAssets(buildCreateTextAssetsPayload(NEW_DESCRIPTIONS, "DESCRIPTION"), "assets:mutate (descriptions)");
  if ("error" in descriptionResult) {
    console.error(`[google-ads-swap-asset-group-creatives] ✖ ${descriptionResult.error}`);
    return 1;
  }
  console.log(
    `[google-ads-swap-asset-group-creatives] ✔ ${headlineResult.resourceNames.length} headline(s), ` +
      `${longHeadlineResult.resourceNames.length} long headline(s), ${descriptionResult.resourceNames.length} description(s) criados.`,
  );

  console.log("[google-ads-swap-asset-group-creatives] Fase 1 — criando imagens novas do manifesto...");
  const imageResourceNamesByFieldType: Partial<Record<(typeof IMAGE_FIELD_TYPES)[number], string[]>> = {};
  for (const fieldType of IMAGE_FIELD_TYPES) {
    const paths = manifest![fieldType as keyof ImagesManifest] ?? [];
    const names: string[] = [];
    for (const path of paths) {
      const base64 = readFileSync(path).toString("base64");
      const baseName = path.split(/[\\/]/).pop() ?? path;
      const result = await createAssets(buildCreateImageAssetPayload(base64, baseName), `assets:mutate (${fieldType} ${baseName})`);
      if ("error" in result) {
        console.error(`[google-ads-swap-asset-group-creatives] ✖ ${result.error}`);
        return 1;
      }
      names.push(...result.resourceNames);
    }
    imageResourceNamesByFieldType[fieldType] = names;
    console.log(`[google-ads-swap-asset-group-creatives] ✔ ${names.length} imagem(ns) ${fieldType} criada(s).`);
  }

  console.log("[google-ads-swap-asset-group-creatives] Fase 1 — linkando os novos recursos ao grupo...");
  const allNewAssetsByFieldType: Array<{ fieldType: AssetGroupFieldType; resourceNames: string[] }> = [
    { fieldType: "HEADLINE", resourceNames: headlineResult.resourceNames },
    { fieldType: "LONG_HEADLINE", resourceNames: longHeadlineResult.resourceNames },
    { fieldType: "DESCRIPTION", resourceNames: descriptionResult.resourceNames },
    ...IMAGE_FIELD_TYPES.map((ft) => ({ fieldType: ft, resourceNames: imageResourceNamesByFieldType[ft] ?? [] })),
  ];
  for (const { fieldType, resourceNames } of allNewAssetsByFieldType) {
    if (resourceNames.length === 0) continue;
    const linkPayload = buildLinkAssetGroupAssetsPayload(assetGroupResourceName, resourceNames, fieldType);
    const attempt = await postGoogleAdsWithLoginRetry(fetchFn, auth, accessToken, linkMutateUrl, JSON.stringify(linkPayload), `assetGroupAssets:mutate (link ${fieldType})`);
    if ("networkError" in attempt) {
      console.error(`[google-ads-swap-asset-group-creatives] ✖ falha de rede linkando ${fieldType}: ${attempt.networkError}`);
      return 1;
    }
    if (!attempt.res.ok) {
      console.error(`[google-ads-swap-asset-group-creatives] ✖ assetGroupAssets:mutate (link ${fieldType}) respondeu HTTP ${attempt.res.status}: ${attempt.text.slice(0, 1000)}`);
      return 1;
    }
    console.log(`[google-ads-swap-asset-group-creatives] ✔ ${resourceNames.length} recurso(s) ${fieldType} linkado(s) ao grupo.`);
  }

  console.log(
    "[google-ads-swap-asset-group-creatives] ✔ Fase 1 concluída — textos e imagens novos criados e linkados. " +
      "Aguarde a revisão do Google (reler status/reprovação pela API) antes de rodar --send --remove-stale (Fase 2).",
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`[google-ads-swap-asset-group-creatives] ✖ erro inesperado: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    });
}
