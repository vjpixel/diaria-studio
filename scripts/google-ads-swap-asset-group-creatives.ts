#!/usr/bin/env npx tsx
/**
 * scripts/google-ads-swap-asset-group-creatives.ts (#8550)
 *
 * Troca os criativos (texto + imagem) do grupo de recursos PMax "Max"
 * (`asset_group` id `6642889160`, campanha `23343492446`) pelos
 * novos definidos na issue #8550 — script commitado com `--dry-run` como
 * comportamento DEFAULT, seguindo o pedido explícito da revisão de
 * 20/09/2026 ("passo 3 vira script commitado, não sessão manual").
 *
 * ## NÃO EXECUTAR --send hoje (28/09/2026) — ler antes de rodar
 *
 * Duas razões independentes, cada uma sozinha já seria motivo de não rodar
 * — **desde o #8960 as DUAS são verificadas por código**, não só a #2 como
 * antes (achado do review da PR #8956).
 *
 *   1. **[enforced em código desde #8960, `checkSwapCooldown`] Editor
 *      declinou autorização em 28/09/2026.** `/diaria-desbloqueia`
 *      perguntou explicitamente e a resposta foi "ainda não" — marcador
 *      `acao-adiada` no comentário da issue #8550, cooldown de 7 dias
 *      (`scripts/lib/issue-decisions.ts` — `isAcaoAdiadaAtiva`). `--send`
 *      agora lê os comentários da issue #8550 (via `gh`, `fetchCommentBodies`)
 *      e RECUSA se o cooldown ainda estiver ativo — reperguntar antes de
 *      expirar (~05/10/2026) repetiria uma pergunta já respondida. Fail-soft
 *      por design: `gh` indisponível/offline não bloqueia `--send` (mesma
 *      postura fail-open de `isAcaoAdiadaAtiva` — um cooldown que não dá pra
 *      confirmar não deve travar para sempre). Bypass explícito pra teste/
 *      emergência: `--skip-cooldown-check-UNSAFE` (nome de propósito feio —
 *      não é pra uso normal).
 *   2. **[enforced em código, `validateImagesManifest`] As imagens novas
 *      não existem ainda.** A decisão do editor (20/09) pede overlays das
 *      artes que rodam na Meta SEM o botão "Assine grátis" e SEM
 *      título/subtítulo queimados, gerados a partir dos masters, mais o
 *      formato 1,91:1 que não existe em nenhum conjunto hoje. Gerar essas
 *      imagens é edição de imagem, fora do escopo deste script (que só
 *      fala com a Google Ads API) — por isso `--send` exige
 *      `--images-manifest` apontando pros 12 arquivos finais (4 criativos
 *      × 3 proporções) e RECUSA rodar se qualquer um estiver ausente.
 *
 * ## Recuperação de falha parcial na Fase 1 (#8960)
 *
 * Cada etapa da Fase 1 (HEADLINE, LONG_HEADLINE, DESCRIPTION, e cada um dos
 * 3 `*_MARKETING_IMAGE`) grava seu progresso em `--progress-file` (default
 * `_internal/pmax-swap-progress.json`) assim que os recursos são CRIADOS
 * (antes de tentar o LINK) e de novo quando o LINK é confirmado. Um retry
 * depois de uma falha no meio recarrega esse arquivo e pula (nunca recria)
 * qualquer etapa já criada, e pula (nunca relinka) qualquer etapa já
 * linkada — não duplica os assets órfãos que uma falha parcial deixaria
 * pra trás. O arquivo é apagado sozinho no fim de uma Fase 1 concluída com
 * sucesso (não deve sobreviver pro PRÓXIMO swap, com texto/imagem
 * diferentes).
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

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
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
  emptySwapProgress,
  parseSwapProgress,
  withSwapProgressStep,
  serializeSwapProgress,
  NEW_HEADLINES,
  NEW_LONG_HEADLINES,
  NEW_DESCRIPTIONS,
  type AssetGroupAssetApiRow,
  type AssetGroupFieldType,
  type SwapProgress,
  type SwapProgressStepKey,
} from "./lib/google-ads-asset-group-assets.ts";
import { refreshGoogleAdsAccessToken, postGoogleAdsWithLoginRetry, DEFAULT_API_VERSION } from "./lib/google-ads-ingest.ts";
import { authConfigFromEnv } from "./lib/google-ads-conversion-sender.ts";
import { fetchCommentBodies, latestAcaoAdiadaFor, latestExecutionBlockFor, isAcaoAdiadaAtiva } from "./lib/issue-decisions.ts";

const DEFAULT_ASSET_GROUP_ID = "6642889160";
const DEFAULT_PROGRESS_FILE = "_internal/pmax-swap-progress.json";
/** Issue #8550 é onde o adiamento (`acao-adiada`) do editor foi gravado em
 *  28/09/2026 — ver docstring do módulo acima. Fixo porque este script
 *  serve UM swap específico (grupo `6642889160`), não um fluxo genérico. */
const COOLDOWN_ISSUE_NUMBER = 8550;

/**
 * Checagem em CÓDIGO do cooldown de 7 dias (#8960 achado #2) — até aqui só
 * a docstring do módulo documentava que o editor disse "ainda não"; nada
 * chamava `isAcaoAdiadaAtiva`. Injetável (`fetchCommentBodiesFn`) pra
 * permitir teste sem `gh` real. Fail-soft: `gh` indisponível ou issue sem
 * marcador → `[]` de `fetchCommentBodies` → `latestAcaoAdiadaFor` devolve
 * `null` → `isAcaoAdiadaAtiva` devolve `false` (não bloqueia) — mesma
 * postura fail-open documentada em `isAcaoAdiadaAtiva` (um cooldown que não
 * dá pra confirmar não deve travar `--send` para sempre).
 */
export function checkSwapCooldown(
  commentsBodies: readonly string[],
  now: Date = new Date(),
): { active: boolean; pedidoEm?: string; motivo?: string } {
  const adiada = latestAcaoAdiadaFor(commentsBodies);
  if (!adiada) return { active: false };
  const blocoMaisRecente = latestExecutionBlockFor(commentsBodies);
  const active = isAcaoAdiadaAtiva(adiada, { now, blocoMaisRecente });
  return { active, pedidoEm: adiada.pedido_em, motivo: adiada.motivo };
}

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
    const raw: unknown = (manifest as Record<string, unknown>)[fieldType];
    if (raw === undefined) {
      errors.push(`manifesto não tem nenhum caminho para ${fieldType}`);
      continue;
    }
    // `JSON.parse` devolve `any` — validar a FORMA aqui antes de tratar
    // como `string[]`, senão um manifesto malformado (ex: valor não-array,
    // ou array com item não-string) quebra mais adiante com uma exceção
    // não tratada em vez de um erro limpo na lista (achado do review da
    // PR #8956, type-design-analyzer).
    if (!Array.isArray(raw) || !raw.every((p) => typeof p === "string")) {
      errors.push(`manifesto tem um valor inválido para ${fieldType} — esperado array de strings (caminhos de arquivo)`);
      continue;
    }
    const paths = raw;
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

export async function main(
  argv: string[] = process.argv.slice(2),
  fetchFn: typeof fetch = fetch,
  fetchCommentBodiesFn: typeof fetchCommentBodies = fetchCommentBodies,
): Promise<number> {
  loadProjectEnv();

  const assetGroupId = getStringArg(argv, "asset-group-id", { example: DEFAULT_ASSET_GROUP_ID }) ?? DEFAULT_ASSET_GROUP_ID;
  const customerId = getStringArg(argv, "customer-id", { example: "2369219639" }) ?? process.env.GOOGLE_ADS_CUSTOMER_ID;
  const send = hasFlag(argv, "send");
  const removeStale = hasFlag(argv, "remove-stale");
  const manifestPath = getStringArg(argv, "images-manifest", { example: "path/to/manifest.json" });
  const progressFile = getStringArg(argv, "progress-file", { example: DEFAULT_PROGRESS_FILE }) ?? DEFAULT_PROGRESS_FILE;
  const skipCooldownCheck = hasFlag(argv, "skip-cooldown-check-UNSAFE");

  // #8960 achado #2 — cooldown do editor agora é checado em CÓDIGO, não só
  // documentado. Só se aplica a `--send` (dry-run continua seguro sempre,
  // inclusive durante o cooldown — só lê e imprime o plano).
  if (send && !skipCooldownCheck) {
    const commentsBodies = fetchCommentBodiesFn(COOLDOWN_ISSUE_NUMBER, process.cwd());
    const cooldown = checkSwapCooldown(commentsBodies);
    if (cooldown.active) {
      console.error(
        `[google-ads-swap-asset-group-creatives] ✖ --send recusado: cooldown de "ação adiada" ainda ativo na issue #${COOLDOWN_ISSUE_NUMBER} ` +
          `(pedido em ${cooldown.pedidoEm}${cooldown.motivo ? `, motivo: ${cooldown.motivo}` : ""}). ` +
          "O editor respondeu 'ainda não' recentemente — reperguntar antes do cooldown expirar repete uma pergunta já respondida " +
          "(ver `scripts/lib/issue-decisions.ts` `isAcaoAdiadaAtiva`). Nenhuma mutação foi feita.",
      );
      return 1;
    }
  }

  if (!customerId) {
    console.error("[google-ads-swap-asset-group-creatives] ✖ --customer-id (ou GOOGLE_ADS_CUSTOMER_ID) é obrigatório.");
    return 1;
  }
  // GAQL não aceita bind params — validar como numérico ANTES de interpolar
  // no resource name (mesma disciplina de `buildConversionActionReadQuery`,
  // achado do review da PR #8956). `buildAssetGroupAssetsQuery` também
  // valida o resource name inteiro, mas falhar aqui dá uma mensagem que
  // aponta pro `--asset-group-id` passado, não pro resource name montado.
  if (!/^\d+$/.test(assetGroupId)) {
    console.error(`[google-ads-swap-asset-group-creatives] ✖ --asset-group-id precisa ser numérico, recebido: "${assetGroupId}"`);
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
    // Nunca confiar só em `res.ok` (#573, achado do review da PR #8956) —
    // parsear e conferir que a API confirmou remover exatamente o nº de
    // recursos pedido, não só que respondeu 2xx.
    let removeParsed: { results?: unknown[] };
    try {
      removeParsed = JSON.parse(attempt.text);
    } catch {
      console.error(`[google-ads-swap-asset-group-creatives] ✖ assetGroupAssets:mutate (remove) respondeu corpo não-JSON (HTTP ${attempt.res.status})`);
      return 1;
    }
    const removedCount = (removeParsed.results ?? []).length;
    if (removedCount !== removePayload.operations.length) {
      console.error(
        `[google-ads-swap-asset-group-creatives] ✖ assetGroupAssets:mutate (remove) confirmou ${removedCount} de ` +
          `${removePayload.operations.length} remoção(ões) pedida(s) — resposta: ${attempt.text.slice(0, 500)}`,
      );
      return 1;
    }
    console.log(`[google-ads-swap-asset-group-creatives] ✔ ${removedCount} recurso(s) removido(s) (confirmado pela resposta): ${attempt.text.slice(0, 500)}`);
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

  // #8960 achado #1 — manifesto de progresso: se a Fase 1 falhar no meio,
  // os `resourceNames` de cada etapa (fieldType) já criada/linkada ficam
  // registrados aqui em disco. Um retry recarrega este arquivo e PULA
  // (nunca recria) a etapa que já tem `resourceNames`, e pula o LINK da
  // etapa que já tem `linked: true` — evita duplicar os órfãos que o
  // review da PR #8956 apontou. Progresso é local ao ASSET GROUP (não
  // versionado — `_internal/` é sempre gitignored), e é limpo no fim de
  // uma Fase 1 bem-sucedida (não deve sobreviver pra confundir o PRÓXIMO
  // swap, que terá texto/imagem novos).
  let progress: SwapProgress = parseSwapProgress(existsSync(progressFile) ? readFileSync(progressFile, "utf8") : null);
  function saveProgress(stepKey: SwapProgressStepKey, resourceNames: string[], linked: boolean): void {
    progress = withSwapProgressStep(progress, stepKey, { resourceNames, linked });
    mkdirSync(dirname(progressFile), { recursive: true });
    writeFileSync(progressFile, serializeSwapProgress(progress), "utf8");
  }

  // `payload` tipado por `{ operations: unknown[] }` (não `unknown` cru) —
  // é o que permite validar `results.length === operations.length` abaixo
  // sem um parâmetro de contagem separado que pudesse divergir do payload
  // de verdade. Achado do review da PR #8956 (3 agentes independentes): o
  // check anterior só validava "todo resultado tem resourceName", nunca
  // "vieram tantos resultados quanto operações enviadas" — um `results: []`
  // (ou mais curto que o pedido) em cima de HTTP 2xx passava como sucesso
  // silencioso, criando MENOS assets do que o plano pedia sem nenhum erro.
  async function createAssets(payload: { operations: unknown[] }, label: string): Promise<{ resourceNames: string[] } | { error: string }> {
    const attempt = await postGoogleAdsWithLoginRetry(fetchFn, auth, accessToken, assetsMutateUrl, JSON.stringify(payload), label);
    if ("networkError" in attempt) return { error: attempt.networkError };
    if (!attempt.res.ok) return { error: `assets:mutate (${label}) respondeu HTTP ${attempt.res.status}: ${attempt.text.slice(0, 1000)}` };
    let parsed: { results?: Array<{ resourceName?: string }> };
    try {
      parsed = JSON.parse(attempt.text);
    } catch {
      return { error: `assets:mutate (${label}) respondeu corpo não-JSON (HTTP ${attempt.res.status})` };
    }
    const results = parsed.results ?? [];
    if (results.length !== payload.operations.length) {
      return {
        error:
          `assets:mutate (${label}) devolveu ${results.length} resultado(s) para ${payload.operations.length} operação(ões) ` +
          `enviada(s) — resposta: ${attempt.text.slice(0, 500)}`,
      };
    }
    const resourceNames = results.map((r) => r.resourceName).filter((r): r is string => Boolean(r));
    if (resourceNames.length !== results.length) {
      return { error: `assets:mutate (${label}) devolveu resultado sem resourceName — resposta: ${attempt.text.slice(0, 500)}` };
    }
    return { resourceNames };
  }

  /** Cria (ou reusa do progresso, se já criado numa tentativa anterior) os
   *  assets de UMA etapa/fieldType. Nunca recria uma etapa cujo
   *  `resourceNames` já esteja gravado — é exatamente o retry idempotente
   *  pedido pela issue #8960. */
  async function createStepIfNeeded(
    stepKey: SwapProgressStepKey,
    buildPayload: () => { operations: unknown[] },
    label: string,
  ): Promise<{ resourceNames: string[] } | { error: string }> {
    const existing = progress.steps[stepKey];
    if (existing) {
      console.log(`[google-ads-swap-asset-group-creatives] ↷ ${stepKey}: reusando ${existing.resourceNames.length} recurso(s) já criado(s) numa tentativa anterior (${progressFile}).`);
      return { resourceNames: existing.resourceNames };
    }
    const result = await createAssets(buildPayload(), label);
    if ("error" in result) return result;
    saveProgress(stepKey, result.resourceNames, false);
    return result;
  }

  console.log("[google-ads-swap-asset-group-creatives] Fase 1 — criando textos novos...");
  const headlineResult = await createStepIfNeeded("HEADLINE", () => buildCreateTextAssetsPayload(NEW_HEADLINES, "HEADLINE"), "assets:mutate (headlines)");
  if ("error" in headlineResult) {
    console.error(`[google-ads-swap-asset-group-creatives] ✖ ${headlineResult.error}`);
    return 1;
  }
  const longHeadlineResult = await createStepIfNeeded("LONG_HEADLINE", () => buildCreateTextAssetsPayload(NEW_LONG_HEADLINES, "LONG_HEADLINE"), "assets:mutate (long headlines)");
  if ("error" in longHeadlineResult) {
    console.error(`[google-ads-swap-asset-group-creatives] ✖ ${longHeadlineResult.error}`);
    return 1;
  }
  const descriptionResult = await createStepIfNeeded("DESCRIPTION", () => buildCreateTextAssetsPayload(NEW_DESCRIPTIONS, "DESCRIPTION"), "assets:mutate (descriptions)");
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
    const existing = progress.steps[fieldType as SwapProgressStepKey];
    if (existing) {
      console.log(`[google-ads-swap-asset-group-creatives] ↷ ${fieldType}: reusando ${existing.resourceNames.length} recurso(s) já criado(s) numa tentativa anterior (${progressFile}).`);
      imageResourceNamesByFieldType[fieldType] = existing.resourceNames;
      continue;
    }
    const paths = manifest![fieldType as keyof ImagesManifest] ?? [];
    const names: string[] = [];
    for (const path of paths) {
      const base64 = readFileSync(path).toString("base64");
      const baseName = path.split(/[\\/]/).pop() ?? path;
      const result = await createAssets(buildCreateImageAssetPayload(base64, baseName), `assets:mutate (${fieldType} ${baseName})`);
      if ("error" in result) {
        // Persiste o que já foi criado NESTE fieldType antes da falha (ex:
        // 1,91:1 criada, 4:5 falhou) — um retry não recria a que já existe.
        if (names.length > 0) saveProgress(fieldType as SwapProgressStepKey, names, false);
        console.error(`[google-ads-swap-asset-group-creatives] ✖ ${result.error}`);
        return 1;
      }
      names.push(...result.resourceNames);
    }
    saveProgress(fieldType as SwapProgressStepKey, names, false);
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
    if (progress.steps[fieldType as SwapProgressStepKey]?.linked) {
      console.log(`[google-ads-swap-asset-group-creatives] ↷ ${fieldType}: já linkado numa tentativa anterior (${progressFile}) — pulando.`);
      continue;
    }
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
    // Nunca confiar só em `res.ok` (#573) — conferir que a API confirmou
    // linkar exatamente o nº de recursos enviado antes de reportar sucesso.
    let linkParsed: { results?: unknown[] };
    try {
      linkParsed = JSON.parse(attempt.text);
    } catch {
      console.error(`[google-ads-swap-asset-group-creatives] ✖ assetGroupAssets:mutate (link ${fieldType}) respondeu corpo não-JSON (HTTP ${attempt.res.status})`);
      return 1;
    }
    const linkedCount = (linkParsed.results ?? []).length;
    if (linkedCount !== resourceNames.length) {
      console.error(
        `[google-ads-swap-asset-group-creatives] ✖ assetGroupAssets:mutate (link ${fieldType}) confirmou ${linkedCount} de ` +
          `${resourceNames.length} link(s) pedido(s) — resposta: ${attempt.text.slice(0, 500)}. Estado agora INCONSISTENTE — ` +
          "alguns recursos já criados podem estar sem link. Não prossiga sem investigar pela API antes de tentar de novo.",
      );
      return 1;
    }
    saveProgress(fieldType as SwapProgressStepKey, resourceNames, true);
    console.log(`[google-ads-swap-asset-group-creatives] ✔ ${linkedCount} recurso(s) ${fieldType} linkado(s) ao grupo (confirmado pela resposta).`);
  }

  // Fase 1 terminou com tudo criado E linkado — o progresso não deve
  // sobreviver pro PRÓXIMO swap (textos/imagens diferentes), então é
  // limpo aqui. Falha em apagar (raro, permissão) é log-only: um arquivo
  // de progresso "tudo linked:true" órfão não causa recriação indevida no
  // próximo retry (createStepIfNeeded reusaria os mesmos resourceNames),
  // só ficaria como lixo local até a limpeza manual.
  try {
    rmSync(progressFile, { force: true });
  } catch (e) {
    console.log(`[google-ads-swap-asset-group-creatives] aviso: não consegui remover ${progressFile} (${e instanceof Error ? e.message : e}) — sem impacto na próxima execução.`);
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
