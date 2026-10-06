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
 * ## --send recusa enquanto as duas travas abaixo valerem — ler antes de rodar
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
 *      agora lê os comentários da issue #8550 (via `gh`,
 *      `fetchCooldownCommentsOrNull`) e RECUSA se o cooldown ainda estiver
 *      ativo — reperguntar antes de expirar (~05/10/2026) repetiria uma
 *      pergunta já respondida. **Fail-CLOSED por design (decisão do editor,
 *      review da PR #8972):** `gh`/rede indisponível também RECUSA
 *      `--send` — o inverso deliberado da postura fail-open de
 *      `isAcaoAdiadaAtiva` em si, porque aqui `--send` muta uma conta de
 *      terceiro com gasto real, e "não consegui confirmar" tem que se
 *      comportar como "não autorizado". Bypass explícito pra quem já
 *      confirmou manualmente: `--skip-cooldown-check-UNSAFE` (nome de
 *      propósito feio — não é pra uso normal).
 *   2. **[enforced em código, `validateImagesManifest`] As imagens novas
 *      não existem ainda.** A decisão do editor (20/09) pede overlays das
 *      artes que rodam na Meta SEM o botão "Assine grátis" e SEM
 *      título/subtítulo queimados, gerados a partir dos masters, mais o
 *      formato 1,91:1, que não existia em nenhum conjunto em 20/09. Gerar essas
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
 * diferentes). Um fieldType de imagem pode ter vários caminhos no
 * manifesto — um `existing` parcial só é reusado se a contagem já criada
 * bater com a do manifesto ATUAL; senão retoma criando só o que falta.
 *
 * O arquivo carrega um FINGERPRINT (hash do `--images-manifest` bruto +
 * asset group/customer, `computeSwapFingerprint`) — `--send` RECUSA reusar
 * um `--progress-file` cujo fingerprint não bate com a execução atual (#8972
 * item 3), pra nunca linkar `resourceNames` de um manifesto/alvo diferente
 * do que foi passado agora (ex: operador trocou `--images-manifest` mas
 * esqueceu de apagar/renomear o progresso de uma tentativa anterior).
 *
 * Rodar em modo leitura (default, sem `--send`) é seguro a qualquer
 * momento — só lê o estado atual e imprime o plano, nenhuma mutação.
 *
 * ## Fluxo em 2 fases (sequenciamento da issue #8550)
 *
 *   Fase 1 (`--send`, sem `--remove-stale`): cria os textos novos + as
 *   imagens do manifesto, linka tudo ao grupo de recursos. Só remove
 *   antigos onde antigos + novos passariam do máximo do PMax por fieldType
 *   (#9017 — LONG_HEADLINE e DESCRIPTION, porque o conjunto novo traz 5 de cada = máximo): aí o
 *   mínimo de stale necessário sai NO MESMO `assetGroupAssets:mutate` do
 *   link (remove+create atômico, `planTextFieldLinks`). O plano é validado
 *   contra antigos + novos antes de qualquer mutação — também para as
 *   imagens do manifesto (#9057, `planImageFieldLinks`, máx 20 por tipo):
 *   imagens existentes + manifesto > 20 num tipo também removem o mínimo
 *   de imagens stale no mesmo mutate (ou recusam, se o excedente não for
 *   stale). Por cima disso, o teto COMBINADO de 20 imagens somando os 3
 *   tipos (#9080, `PMAX_IMAGE_COMBINED_MAX`, premissa conservadora): cada
 *   link de imagem remove stale extra (de qualquer tipo) no mesmo mutate
 *   para que o total do grupo nunca passe de 20 em nenhum passo.
 *
 *   Fase 2 (`--send --remove-stale`, rodado numa invocação SEPARADA
 *   depois de confirmar pela API que os novos estão `ENABLED` e sem
 *   reprovação): remove os `asset_group_asset` classificados como stale
 *   na leitura mais recente.
 *
 * ## Plano JSON, piso e releitura (#8550 sync, `lib/google-ads-pmax-sync-plan.ts`)
 *
 *   - Toda execução que lê o estado do grupo (inclusive dry-run) grava o plano em `--plan-out`
 *     (default `data/aquisicao/campanhas-260816/pmax-swap-plan.json`):
 *     contagem por field_type depois de CADA mutate da Fase 1 e da Fase 2
 *     projetada, contra mínimo/máximo do PMax, e a lista de violações.
 *   - O plano é TRAVA: qualquer item em `violations` faz `--send` (Fase 1 ou
 *     Fase 2) recusar antes de qualquer mutação.
 *   - A Fase 2 tem PISO: remove o stale só até onde o que sobra — `keep`
 *     (inclui os textos novos do swap) e imagens novas, com
 *     `policy_summary.approval_status` APPROVED/APPROVED_LIMITED — cobre o
 *     mínimo do tipo e a regra de comprimento (≥1 DESCRIPTION ≤60; ≥1
 *     HEADLINE ≤15, premissa conservadora). `needsReview` não conta. Rodada
 *     cedo (antes da Fase 1, ou com os novos em revisão), mantém o stale
 *     necessário; rodar de novo depois da aprovação remove o resto.
 *   - Depois de cada fase, o grupo é RELIDO: os novos precisam aparecer
 *     ENABLED no tipo pedido; os removidos (inclusive os da troca atômica da
 *     Fase 1) não podem seguir ENABLED; nenhum tipo tocado abaixo do mínimo.
 *     Divergência = exit 1 (2xx não prova o estado).
 *   - Limitação conhecida (herdada do #9017, mantida): tipo já no máximo é
 *     trocado INTEIRO na Fase 1 e serve só recursos em revisão até a aprovação.
 *
 * `needsReview` (logos usados como marketing image — `logo_1.jpg`,
 * `logo_1.91:1.jpg` — e qualquer texto ENABLED desconhecido) NUNCA é tocado
 * por nenhuma fase nem conta no piso da Fase 2 — reportado à parte pra
 * decisão humana.
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
  buildSwapAssetGroupAssetsPayload,
  planTextFieldLinks,
  planImageFieldLinks,
  PMAX_IMAGE_COMBINED_MAX,
  PMAX_IMAGE_FIELD_MAX,
  type ImageFieldType,
  type ImageLinkPlanResult,
  buildRemoveAssetGroupAssetsPayload,
  emptySwapProgress,
  parseSwapProgress,
  withSwapProgressStep,
  withSwapProgressFingerprint,
  computeSwapFingerprint,
  serializeSwapProgress,
  NEW_HEADLINES,
  NEW_LONG_HEADLINES,
  NEW_DESCRIPTIONS,
  type AssetGroupAssetApiRow,
  type AssetGroupFieldType,
  type SwapProgress,
  type SwapProgressStepKey,
  type FieldLinkPlanResult,
} from "./lib/google-ads-asset-group-assets.ts";
import {
  buildSyncPlanReport,
  planPhase2Removal,
  verifyLinkedAfterApply,
  verifyRemovedAfterApply,
  fieldsBelowMin,
  type SyncPlanReport,
} from "./lib/google-ads-pmax-sync-plan.ts";
import { refreshGoogleAdsAccessToken, postGoogleAdsWithLoginRetry, DEFAULT_API_VERSION } from "./lib/google-ads-ingest.ts";
import { authConfigFromEnv } from "./lib/google-ads-conversion-sender.ts";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { latestAcaoAdiadaFor, isAcaoAdiadaAtiva } from "./lib/issue-decisions.ts";
import { trustedCommentBodies } from "./lib/trusted-comment-author.ts";

const DEFAULT_ASSET_GROUP_ID = "6642889160";
const DEFAULT_PROGRESS_FILE = "_internal/pmax-swap-progress.json";
/** Plano auditável (JSON) gravado em toda execução que lê o estado do grupo, inclusive dry-run —
 *  junto dos criativos (`data/` é gitignored e sincronizado entre máquinas).
 *  Precedência: `--plan-out` > env `PMAX_SWAP_PLAN_OUT` (os testes apontam
 *  pra tmp, nunca pro `data/` real) > este default. */
const DEFAULT_PLAN_OUT = "data/aquisicao/campanhas-260816/pmax-swap-plan.json";

function writePlanReport(path: string, report: SyncPlanReport): SyncPlanReport {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`[google-ads-swap-asset-group-creatives] plano gravado em ${path} (${report.violations.length} violação(ões)).`);
  for (const snap of [...report.phase1.snapshots, report.phase2.snapshot]) {
    const counts = Object.entries(snap.counts).map(([ft, n]) => `${ft}=${n}`).join(" ");
    console.log(`  ${snap.label}: ${counts} | imagens=${snap.imagesCombined}${snap.violations.length ? ` ✖ ${snap.violations.join("; ")}` : ""}`);
  }
  for (const note of report.notes) console.log(`  nota: ${note}`);
  for (const v of report.violations) console.error(`  ✖ violação: ${v}`);
  return report;
}
/** Issue #8550 é onde o adiamento (`acao-adiada`) do editor foi gravado em
 *  28/09/2026 — ver docstring do módulo acima. Fixo porque este script
 *  serve UM swap específico (grupo `6642889160`), não um fluxo genérico. */
const COOLDOWN_ISSUE_NUMBER = 8550;

/**
 * Checagem em CÓDIGO do cooldown de 7 dias (#8960 achado #2) — até aqui só
 * a docstring do módulo documentava que o editor disse "ainda não"; nada
 * chamava `isAcaoAdiadaAtiva`. Injetável (`fetchCommentBodiesFn`) pra
 * permitir teste sem `gh` real.
 *
 * `commentsBodies` é `null` quando a LEITURA em si falhou (não confunde
 * "leitura ok, zero comentários" com "não consegui ler") — nesse caso
 * `active: true` (**fail-CLOSED**, decisão do editor no review desta PR,
 * #8972): `--send` muta uma conta de terceiro com gasto real, e "não
 * consegui confirmar se o editor autorizou" tem que se comportar como "não
 * autorizado", não como "autorizado". Isto é o INVERSO deliberado da
 * postura fail-open de `isAcaoAdiadaAtiva` em si (que decide se um
 * adiamento JÁ CONFIRMADO ainda vale) — aqui o que falhou é a própria
 * confirmação. Bypass explícito pra quem já confirmou manualmente:
 * `--skip-cooldown-check-UNSAFE`.
 *
 * #9024 — o fail-closed vale também DEPOIS da leitura: `pedido_em`
 * inválido ou no futuro → ativo (em `isAcaoAdiadaAtiva` os dois são
 * fail-open), e um `bloqueio-execucao` posterior ao adiamento NUNCA desarma
 * o cooldown (lá ele reabre a pergunta; aqui liberaria a execução).
 */
export function checkSwapCooldown(
  commentsBodies: readonly string[] | null,
  now: Date = new Date(),
): { active: boolean; pedidoEm?: string; motivo?: string } {
  if (commentsBodies === null) {
    return { active: true, motivo: "não foi possível ler os comentários da issue para confirmar o cooldown (fail-closed)" };
  }
  const adiada = latestAcaoAdiadaFor(commentsBodies);
  if (!adiada) return { active: false };
  // #9024 — `isAcaoAdiadaAtiva` é fail-OPEN nos casos abaixo (desenhada pra
  // "posso perguntar de novo?"); aqui `false` libera `--send`, então cada
  // um deles precisa virar cooldown ATIVO em vez de herdar o `false`.
  const pedidoEmMs = new Date(adiada.pedido_em).getTime();
  if (Number.isNaN(pedidoEmMs)) {
    return { active: true, pedidoEm: adiada.pedido_em, motivo: `pedido_em inválido no marcador acao-adiada ("${adiada.pedido_em}") — fail-closed` };
  }
  if (pedidoEmMs > now.getTime()) {
    return { active: true, pedidoEm: adiada.pedido_em, motivo: `pedido_em no futuro no marcador acao-adiada ("${adiada.pedido_em}") — fail-closed` };
  }
  // `blocoMaisRecente` deliberadamente NÃO é repassado: um
  // `bloqueio-execucao` novo reabre a PERGUNTA no fluxo de desbloqueio, mas
  // é um motivo a mais para não executar — nunca pode desarmar o cooldown.
  const active = isAcaoAdiadaAtiva(adiada, { now });
  return { active, pedidoEm: adiada.pedido_em, motivo: adiada.motivo };
}

/**
 * Busca os comentários da issue via `gh` — devolve `null` (nunca `[]`) em
 * QUALQUER falha de leitura (processo, JSON, forma inesperada), pra
 * `checkSwapCooldown` poder distinguir "li e não achei marcador" de "não
 * consegui ler" e recusar `--send` no 2º caso (fail-closed, #8960).
 * Deliberadamente uma cópia local — não reusa `fetchCommentBodies` de
 * `scripts/lib/issue-decisions.ts`, cujo contrato fail-soft (`[]` nos dois
 * casos) é correto pros OUTROS consumidores dela (perguntar de novo é
 * barato) mas errado aqui (a falha vira ação real numa conta de terceiro).
 */
export function fetchCooldownCommentsOrNull(issueNumber: number, cwd: string): string[] | null {
  const result = spawnSync("gh", ["issue", "view", String(issueNumber), "--json", "comments"], { cwd, encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0 || !result.stdout) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  // #9752: só autor confiável (OWNER/MEMBER/COLLABORATOR) — repo público.
  // `null` (payload sem array) segue fail-closed como antes.
  return trustedCommentBodies((parsed as { comments?: unknown }).comments);
}

// Mesma ordem que `planImageFieldLinks` usa pra simular os mutates (#9080):
// o teto combinado é checado passo a passo NESTA ordem, então a CLI deriva a
// lista da mesma fonte em vez de repetir os literais.
const IMAGE_FIELD_TYPES = Object.keys(PMAX_IMAGE_FIELD_MAX) as readonly ImageFieldType[];

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
  let payload: { results?: AssetGroupAssetApiRow[]; nextPageToken?: string };
  try {
    payload = JSON.parse(attempt.text);
  } catch {
    return { error: `googleAds:search respondeu corpo não-JSON (HTTP ${attempt.res.status})` };
  }
  // Ler só a 1ª página em silêncio daria um piso/plano calculado sobre parte
  // do grupo — falha explícita em vez de paginar sem necessidade (o grupo
  // tem ~76 linhas, longe do tamanho de página da API).
  if (payload.nextPageToken) {
    return { error: "googleAds:search devolveu nextPageToken — resultado paginado; este script lê só uma página e recusa um estado parcial" };
  }
  return { items: parseAssetGroupAssetRows(payload.results ?? []) };
}

export async function main(
  argv: string[] = process.argv.slice(2),
  fetchFn: typeof fetch = fetch,
  fetchCooldownCommentsFn: typeof fetchCooldownCommentsOrNull = fetchCooldownCommentsOrNull,
): Promise<number> {
  loadProjectEnv();

  const assetGroupId = getStringArg(argv, "asset-group-id", { example: DEFAULT_ASSET_GROUP_ID }) ?? DEFAULT_ASSET_GROUP_ID;
  const customerId = getStringArg(argv, "customer-id", { example: "2369219639" }) ?? process.env.GOOGLE_ADS_CUSTOMER_ID;
  const send = hasFlag(argv, "send");
  const removeStale = hasFlag(argv, "remove-stale");
  const manifestPath = getStringArg(argv, "images-manifest", { example: "path/to/manifest.json" });
  const progressFile = getStringArg(argv, "progress-file", { example: DEFAULT_PROGRESS_FILE }) ?? DEFAULT_PROGRESS_FILE;
  const skipCooldownCheck = hasFlag(argv, "skip-cooldown-check-UNSAFE");
  const planOut = getStringArg(argv, "plan-out", { example: DEFAULT_PLAN_OUT }) ?? process.env.PMAX_SWAP_PLAN_OUT ?? DEFAULT_PLAN_OUT;

  // #8960 achado #2 — cooldown do editor agora é checado em CÓDIGO, não só
  // documentado. Só se aplica a `--send` (dry-run continua seguro sempre,
  // inclusive durante o cooldown — só lê e imprime o plano).
  if (send && !skipCooldownCheck) {
    const commentsBodies = fetchCooldownCommentsFn(COOLDOWN_ISSUE_NUMBER, process.cwd());
    const cooldown = checkSwapCooldown(commentsBodies);
    if (cooldown.active) {
      const naoConfirmado = commentsBodies === null;
      console.error(
        naoConfirmado
          ? `[google-ads-swap-asset-group-creatives] ✖ --send recusado: não foi possível confirmar o cooldown de "ação adiada" na issue #${COOLDOWN_ISSUE_NUMBER} ` +
              "(falha ao ler comentários via `gh`). Fail-closed: sem confirmar que o cooldown expirou, --send não prossegue. " +
              "Confirme manualmente (releia a issue) e rode com --skip-cooldown-check-UNSAFE, ou tente de novo quando `gh`/rede estiverem disponíveis. Nenhuma mutação foi feita."
          : `[google-ads-swap-asset-group-creatives] ✖ --send recusado: cooldown de "ação adiada" ainda ativo na issue #${COOLDOWN_ISSUE_NUMBER} ` +
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
    // Piso (#8550 sync): remove o stale só até onde o que SOBRA APROVADO
    // cobre o mínimo do PMax por tipo — nunca deixa o grupo inválido, nem
    // quando rodada antes da Fase 1 ou com os novos ainda em revisão.
    const phase2 = planPhase2Removal(current.items, classification);
    const phase2Report = writePlanReport(
      planOut,
      buildSyncPlanReport({
        generatedAt: new Date().toISOString(),
        assetGroup: assetGroupResourceName,
        mode: send ? "phase2" : "phase2-dry-run",
        items: current.items,
        classification,
        text: { headlines: NEW_HEADLINES, longHeadlines: NEW_LONG_HEADLINES, descriptions: NEW_DESCRIPTIONS, errors: [] },
        images: { manifest: null, pending: [] },
        phase1Plans: [],
        capacityErrors: [],
      }),
    );
    for (const f of phase2.fields) {
      if (f.staleEnabled === 0) continue;
      console.log(
        `[google-ads-swap-asset-group-creatives] Fase 2 ${f.fieldType}: ${f.confirmedPermanent} não-stale aprovado(s)` +
          (f.unconfirmedPermanent > 0 ? ` + ${f.unconfirmedPermanent} sem aprovação confirmada (não contam no piso)` : "") +
          (f.needsReview > 0 ? ` + ${f.needsReview} needsReview (não contam no piso)` : "") +
          `, mínimo ${f.min}` +
          (f.shortRule ? `, ≥1 com ≤${f.shortRule.maxChars} chars: ${f.shortRule.status}` : "") +
          ` — remove ${f.remove.length} de ${f.staleEnabled} stale` +
          (f.retain.length > 0 ? `, MANTÉM ${f.retain.length} (piso; rode a Fase 2 de novo depois da aprovação dos novos)` : "") +
          ".",
      );
    }
    if (phase2.unmanagedStale.length > 0) {
      console.log(`[google-ads-swap-asset-group-creatives] stale de tipo sem piso conhecido, NÃO removido: ${phase2.unmanagedStale.join(", ")}`);
    }
    if (send && phase2Report.violations.length > 0) {
      console.error("[google-ads-swap-asset-group-creatives] ✖ --send recusado: o plano da Fase 2 tem violações (ver acima). Nenhuma mutação foi feita.");
      return 1;
    }
    if (!send) {
      console.log("[google-ads-swap-asset-group-creatives] --remove-stale sem --send: plano de remoção (dry-run):");
      for (const rn of phase2.remove) console.log(`  removeria: ${rn}`);
      return 0;
    }
    if (phase2.remove.length === 0) {
      console.log("[google-ads-swap-asset-group-creatives] nada stale removível acima do piso — nenhuma chamada de mutação necessária.");
      return 0;
    }
    const removePayload = buildRemoveAssetGroupAssetsPayload(phase2.remove);
    const apiVersion = auth.apiVersion ?? DEFAULT_API_VERSION;
    const url = `https://googleads.googleapis.com/${apiVersion}/customers/${customerId.replace(/[^0-9]/g, "")}/assetGroupAssets:mutate`;
    console.log(`[google-ads-swap-asset-group-creatives] removendo ${phase2.remove.length} asset_group_asset stale (de ${classification.stale.length})...`);
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
    console.log(`[google-ads-swap-asset-group-creatives] ✔ ${removedCount} recurso(s) removido(s) (confirmado pela resposta).`);
    // Releitura: a resposta 2xx não prova o estado do grupo.
    const after = await readCurrentAssetGroupAssets(fetchFn, auth, accessToken, assetGroupResourceName);
    if ("error" in after) {
      console.error(`[google-ads-swap-asset-group-creatives] ✖ remoção enviada, mas a releitura falhou — conferir o grupo pela API: ${after.error}`);
      return 1;
    }
    const removeErrors = verifyRemovedAfterApply(after.items, phase2.remove);
    const touched = new Set(phase2.fields.filter((f) => f.remove.length > 0).map((f) => f.fieldType as string));
    const belowMin = fieldsBelowMin(after.items, touched);
    if (removeErrors.length > 0 || belowMin.length > 0) {
      for (const e of [...removeErrors, ...belowMin]) console.error(`  ✖ ${e}`);
      console.error("[google-ads-swap-asset-group-creatives] ✖ releitura pós-remoção não confere com o pedido (ver acima).");
      return 1;
    }
    console.log("[google-ads-swap-asset-group-creatives] ✔ releitura confere: nenhum removido segue ENABLED, nenhum tipo abaixo do mínimo.");
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

  // Lido já aqui (leitura pura, sem mutação) porque o plano de capacidade
  // abaixo precisa saber quais etapas já foram linkadas numa tentativa
  // anterior. O check de fingerprint continua só no caminho --send.
  let progress: SwapProgress = parseSwapProgress(existsSync(progressFile) ? readFileSync(progressFile, "utf8") : null);

  // #9017 — valida antigos + novos contra o máximo por fieldType ANTES de
  // qualquer mutação. `validateNewTextAssetPlan` só olha o conjunto novo
  // isolado; 5 long headlines/descriptions novos (= máximo) mais os antigos
  // ainda linkados estourariam o limite no meio da Fase 1.
  const alreadyLinked = new Set(Object.entries(progress.steps).filter(([, st]) => st?.linked).map(([k]) => k));
  const textLinkPlan = planTextFieldLinks(
    current.items,
    classification,
    { HEADLINE: NEW_HEADLINES.length, LONG_HEADLINE: NEW_LONG_HEADLINES.length, DESCRIPTION: NEW_DESCRIPTIONS.length },
    alreadyLinked,
  );
  const removeInLinkByFieldType = new Map<string, string[]>();
  /** Registra o plano de capacidade de um grupo de fieldTypes (texto #9017,
   *  imagem #9057) no mapa de remoções do link e loga — mesmo formato pros dois. */
  function applyLinkPlan(result: FieldLinkPlanResult): void {
    for (const pl of result.plans) {
      removeInLinkByFieldType.set(pl.fieldType, pl.removeInSameMutate);
      const cabe = pl.removeInSameMutate.length === 0;
      console.log(
        `[google-ads-swap-asset-group-creatives] capacidade ${pl.fieldType}: ${pl.existingEnabled} ENABLED hoje + ${pl.newCount} novo(s), máx ${pl.max} — ` +
          (cabe ? "cabe sem remover nada." : `remove ${pl.removeInSameMutate.length} stale no MESMO mutate do link (troca atômica): ${pl.removeInSameMutate.join(", ")}`),
      );
    }
    if (!result.ok) {
      for (const e of result.errors) console.error(`  ✖ ${e}`);
    }
  }
  applyLinkPlan(textLinkPlan);

  let manifest: ImagesManifest | null = null;
  let manifestRawText = "";
  let manifestErrors: string[] = ["--images-manifest não foi passado — imagens novas ainda não existem (ver docstring do módulo)."];
  if (manifestPath) {
    if (!existsSync(manifestPath)) {
      manifestErrors = [`--images-manifest aponta pra um arquivo que não existe: ${manifestPath}`];
    } else {
      try {
        manifestRawText = readFileSync(manifestPath, "utf8");
        manifest = JSON.parse(manifestRawText);
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

  // #9057 — mesma validação de capacidade do #9017, agora para as IMAGENS:
  // imagens já ENABLED + as do manifesto contra o máximo por fieldType
  // (PMAX_IMAGE_FIELD_MAX), ANTES de qualquer mutação. Só dá pra planejar com
  // manifesto válido (a contagem nova vem dele).
  let imageLinkPlan: ImageLinkPlanResult = { ok: true, plans: [] };
  if (manifest && manifestErrors.length === 0) {
    const m = manifest;
    const imageNewCounts = Object.fromEntries(
      IMAGE_FIELD_TYPES.map((ft) => [ft, (m[ft] ?? []).length]),
    ) as Record<ImageFieldType, number>;
    imageLinkPlan = planImageFieldLinks(current.items, classification, imageNewCounts, alreadyLinked);
    // #9080 — o plano por tipo acima já inclui as remoções extras do teto
    // COMBINADO (PMAX_IMAGE_COMBINED_MAX); esta linha dá o total que as explica.
    const imagesEnabledNow = current.items.filter((i) => i.status === "ENABLED" && (IMAGE_FIELD_TYPES as readonly string[]).includes(i.fieldType)).length;
    const imagesNew = imageLinkPlan.plans.reduce((a, pl) => a + pl.newCount, 0);
    console.log(
      `[google-ads-swap-asset-group-creatives] teto combinado de imagens: ${imagesEnabledNow} ENABLED hoje + ${imagesNew} nova(s) a linkar, máx ${PMAX_IMAGE_COMBINED_MAX} somando os 3 tipos.`,
    );
    applyLinkPlan(imageLinkPlan);
  }

  const phase1Report = writePlanReport(
    planOut,
    buildSyncPlanReport({
      generatedAt: new Date().toISOString(),
      assetGroup: assetGroupResourceName,
      mode: send ? "phase1" : "dry-run",
      items: current.items,
      classification,
      text: { headlines: NEW_HEADLINES, longHeadlines: NEW_LONG_HEADLINES, descriptions: NEW_DESCRIPTIONS, errors: textValidation.errors },
      images: { manifest: manifest && manifestErrors.length === 0 ? manifest : null, pending: manifestErrors },
      phase1Plans: [...textLinkPlan.plans, ...imageLinkPlan.plans],
      capacityErrors: [...(textLinkPlan.ok ? [] : textLinkPlan.errors), ...(imageLinkPlan.ok ? [] : imageLinkPlan.errors)],
    }),
  );

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

  if (!textValidation.ok || !textLinkPlan.ok || !imageLinkPlan.ok || manifestErrors.length > 0 || phase1Report.violations.length > 0) {
    console.error("[google-ads-swap-asset-group-creatives] ✖ --send recusado: plano de texto, capacidade do grupo, imagem ou o plano JSON (violations) tem pendências (ver acima). Nenhuma mutação foi feita.");
    return 1;
  }

  // A partir daqui, texto E imagem estão prontos (validados acima) — Fase 1
  // de verdade: cria os assets novos e linka ao grupo. Só remove o MÍNIMO
  // de stale que não cabe ao lado dos novos, no mesmo mutate do link
  // (#9017 texto, #9057 imagem); a remoção completa do stale é
  // --remove-stale, Fase 2, numa invocação separada.
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
  // (`progress` já foi carregado acima, antes do plano de capacidade.)

  // #8972 item 3 — o progresso carrega um fingerprint do manifesto de
  // imagens + asset group/customer que ele pertence. Se o arquivo tem
  // etapas E o fingerprint não bate com o swap de AGORA, recusa — nunca
  // reusa `resourceNames` de um manifesto/alvo DIFERENTE (ex: operador
  // rodou de novo com um `--images-manifest` corrigido mas esqueceu de
  // trocar/apagar o `--progress-file` de uma tentativa anterior).
  const expectedFingerprint = computeSwapFingerprint(manifestRawText, assetGroupResourceName, numericCustomerId);
  const hasExistingSteps = Object.keys(progress.steps).length > 0;
  if (hasExistingSteps && progress.fingerprint !== expectedFingerprint) {
    console.error(
      `[google-ads-swap-asset-group-creatives] ✖ --send recusado: ${progressFile} tem progresso de um swap DIFERENTE ` +
        "(fingerprint não bate com o --images-manifest/asset-group/customer desta execução). Reusar esse progresso " +
        "linkaria resourceNames de um manifesto que não é este. Apague ou renomeie o arquivo, ou aponte --progress-file " +
        "pra um caminho novo, antes de rodar de novo. Nenhuma mutação foi feita.",
    );
    return 1;
  }
  if (!hasExistingSteps) progress = withSwapProgressFingerprint(progress, expectedFingerprint);

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
  const imageResourceNamesByFieldType: Partial<Record<ImageFieldType, string[]>> = {};
  for (const fieldType of IMAGE_FIELD_TYPES) {
    const paths = manifest![fieldType] ?? [];
    const existing = progress.steps[fieldType];
    // Cada fieldType pode ter MÚLTIPLOS caminhos no manifesto (até 4
    // criativos por proporção) — um `existing` não-vazio NÃO significa
    // "etapa completa" se tiver menos itens que o manifesto pede hoje
    // (achado do self-review da PR #8972: tratar qualquer `existing`
    // truthy como completo deixaria imagens faltando sem erro nenhum,
    // linkando só o subconjunto parcial em silêncio). Só reusa como
    // COMPLETO quando a contagem já criada bate com a do manifesto atual;
    // caso contrário, retoma criando só os caminhos restantes (assume a
    // mesma ordem/conteúdo do `--images-manifest` entre tentativas — é o
    // mesmo arquivo, referenciado pelo mesmo `--progress-file`).
    if (existing && existing.resourceNames.length >= paths.length) {
      console.log(`[google-ads-swap-asset-group-creatives] ↷ ${fieldType}: reusando ${existing.resourceNames.length} recurso(s) já criado(s) numa tentativa anterior (${progressFile}).`);
      imageResourceNamesByFieldType[fieldType] = existing.resourceNames;
      continue;
    }
    const names: string[] = existing ? [...existing.resourceNames] : [];
    const startIndex = names.length;
    if (startIndex > 0) {
      console.log(
        `[google-ads-swap-asset-group-creatives] ↷ ${fieldType}: retomando de onde parou — ${startIndex}/${paths.length} já criado(s), criando o(s) ${paths.length - startIndex} restante(s)...`,
      );
    }
    for (let i = startIndex; i < paths.length; i++) {
      const path = paths[i];
      const base64 = readFileSync(path).toString("base64");
      const baseName = path.split(/[\\/]/).pop() ?? path;
      const result = await createAssets(buildCreateImageAssetPayload(base64, baseName), `assets:mutate (${fieldType} ${baseName})`);
      if ("error" in result) {
        // Persiste o que já foi criado NESTE fieldType antes da falha (ex:
        // 1,91:1 criada, 4:5 falhou) — um retry não recria a que já existe.
        if (names.length > 0) saveProgress(fieldType, names, false);
        console.error(`[google-ads-swap-asset-group-creatives] ✖ ${result.error}`);
        return 1;
      }
      names.push(...result.resourceNames);
    }
    saveProgress(fieldType, names, false);
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
    // #9017 — pros fieldTypes em que antigos + novos passariam do máximo, o
    // mesmo mutate remove o mínimo de stale necessário (atômico). Nos
    // demais, `removeInSameMutate` é vazio e o payload é só o link.
    const removeInSameMutate = removeInLinkByFieldType.get(fieldType) ?? [];
    const linkPayload = buildSwapAssetGroupAssetsPayload(assetGroupResourceName, resourceNames, fieldType, removeInSameMutate);
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
    // 1 resultado por operação (remove + create) — confere o total enviado.
    const confirmedCount = (linkParsed.results ?? []).length;
    const linkedCount = confirmedCount - removeInSameMutate.length;
    if (confirmedCount !== linkPayload.operations.length) {
      console.error(
        `[google-ads-swap-asset-group-creatives] ✖ assetGroupAssets:mutate (link ${fieldType}) confirmou ${confirmedCount} de ` +
          `${linkPayload.operations.length} operação(ões) pedida(s) (${resourceNames.length} link(s) + ${removeInSameMutate.length} remoção(ões)) — resposta: ${attempt.text.slice(0, 500)}. Estado agora INCONSISTENTE — ` +
          "alguns recursos já criados podem estar sem link. Não prossiga sem investigar pela API antes de tentar de novo.",
      );
      return 1;
    }
    saveProgress(fieldType as SwapProgressStepKey, resourceNames, true);
    console.log(
      `[google-ads-swap-asset-group-creatives] ✔ ${linkedCount} recurso(s) ${fieldType} linkado(s) ao grupo` +
        (removeInSameMutate.length > 0 ? ` e ${removeInSameMutate.length} stale removido(s) no mesmo mutate` : "") +
        " (confirmado pela resposta).",
    );
  }

  // Releitura (#8550 sync): a resposta 2xx com a contagem certa não prova o
  // estado do grupo — por etapa (fieldType), confere que cada asset novo
  // aparece ENABLED, que o stale removido no mesmo mutate (troca atômica) não
  // segue ENABLED, e que o tipo não ficou abaixo do mínimo. Falha mantém o
  // arquivo de progresso (todas as etapas linked:true) pra investigação.
  const afterPhase1 = await readCurrentAssetGroupAssets(fetchFn, auth, accessToken, assetGroupResourceName);
  if ("error" in afterPhase1) {
    console.error(`[google-ads-swap-asset-group-creatives] ✖ Fase 1 enviada, mas a releitura falhou — conferir o grupo pela API: ${afterPhase1.error}`);
    return 1;
  }
  const failedSteps: string[] = [];
  for (const { fieldType, resourceNames } of allNewAssetsByFieldType) {
    if (resourceNames.length === 0) continue;
    const stepErrors = [
      ...verifyLinkedAfterApply(afterPhase1.items, [{ fieldType, assetResourceNames: resourceNames }]),
      ...verifyRemovedAfterApply(afterPhase1.items, removeInLinkByFieldType.get(fieldType) ?? []),
      ...fieldsBelowMin(afterPhase1.items, new Set([fieldType])),
    ];
    if (stepErrors.length === 0) continue;
    failedSteps.push(fieldType);
    console.error(`  ✖ etapa ${fieldType}:`);
    for (const e of stepErrors) console.error(`      ${e}`);
  }
  if (failedSteps.length > 0) {
    console.error(
      `[google-ads-swap-asset-group-creatives] ✖ releitura pós-Fase 1 não confere nas etapas: ${failedSteps.join(", ")}. ` +
        `Remédio: confira o grupo pela API; para relinkar sem recriar assets, marque "linked": false em steps.{${failedSteps.join(",")}} ` +
        `de ${progressFile} e rode --send de novo com o mesmo --images-manifest.`,
    );
    return 1;
  }
  console.log("[google-ads-swap-asset-group-creatives] ✔ releitura confere: novos ENABLED, troca atômica aplicada, nenhum tipo abaixo do mínimo.");

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
