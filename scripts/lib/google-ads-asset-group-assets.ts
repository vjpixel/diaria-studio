/**
 * scripts/lib/google-ads-asset-group-assets.ts (#8550)
 *
 * Núcleo puro/testável pra ler, classificar e montar a troca de criativos
 * (texto + imagem) do grupo de recursos PMax "Max" (`asset_group` id
 * `6642889160`) — ler quais recursos são os antigos genéricos (a trocar) e
 * montar o payload de `assets:mutate` + `assetGroupAssets:mutate` pros
 * novos, seguindo `assets:mutate`/`assetGroupAssets:mutate`
 * (Google Ads REST API).
 *
 * ## Estado confirmado ao vivo (leitura, 28/09/2026, `googleAds:search`)
 *
 * A campanha PMax "Max" (`23343492446`) segue com os 76 registros de
 * `asset_group_asset` do grupo `6642889160` descritos na issue #8550 em
 * 20/09/2026 — nada mudou entre as duas leituras. Confirma que:
 *   - LOGO, LANDSCAPE_LOGO e BUSINESS_NAME estão todos `REMOVED` — nenhum
 *     recurso de logo/nome de empresa ativo no grupo hoje.
 *   - `logo_1.jpg` (id `315354815414`, `SQUARE_MARKETING_IMAGE`) é a única
 *     imagem quadrada "com cara de logo" ativa — pendência não resolvida
 *     (marcado como `needsReview`, nunca auto-classificado como stale).
 *   - O `HEADLINE` "diar.ia.br" (id `409202011006`) é o único texto não
 *     genérico — mantido (`keep`), não staleado.
 *   - 4 `YOUTUBE_VIDEO` ativos — sempre protegidos.
 *
 * ## Por que a execução NÃO acontece neste módulo/CLI hoje (28/09/2026)
 *
 * Duas razões independentes — desde #8960 as DUAS são checadas em código:
 *   1. **[código desde #8960, `checkSwapCooldown` no script CLI] Editor
 *      declinou autorização hoje** via `/diaria-desbloqueia` ("ainda não" —
 *      ver marcador `acao-adiada` no comentário da issue, cooldown de 7
 *      dias, `scripts/lib/issue-decisions.ts` `isAcaoAdiadaAtiva`). `--send`
 *      recusa sozinho enquanto o cooldown estiver ativo (achado do review
 *      da PR #8956, endurecido pela #8960).
 *   2. **[código, `validateImagesManifest`] As imagens novas ainda não
 *      existem** — a decisão do editor (comentário de 20/09) pede overlays
 *      SEM o botão "Assine grátis" e SEM título/subtítulo queimados,
 *      gerados a partir dos masters (`04-dN-master.jpg`), mais o 1,91:1 que
 *      não existe em nenhum conjunto hoje. Geração de imagem é FORA do
 *      escopo deste módulo (script de texto/API, não de edição de imagem)
 *      — `--send` exige um manifesto apontando pros arquivos finais e
 *      falha limpo se qualquer um estiver ausente (ver
 *      `scripts/google-ads-swap-asset-group-creatives.ts`).
 *
 * Este módulo/CLI existe pra deixar o passo 3 do plano da issue
 * ("script commitado, com --dry-run, não sessão manual") pronto pra rodar
 * assim que as duas razões acima caírem — não pra rodar agora. A #1 exige
 * conferência humana; só a #2 é um freio mecânico de verdade.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Leitura + normalização
// ---------------------------------------------------------------------------

export interface AssetGroupAssetApiRow {
  asset?: {
    resourceName?: string;
    id?: string;
    name?: string;
    type?: string;
    textAsset?: { text?: string };
    imageAsset?: { fullSize?: { url?: string } };
  };
  assetGroupAsset?: {
    resourceName?: string;
    asset?: string;
    fieldType?: string;
    status?: string;
    /** #8550 sync — lido pra a Fase 2 só contar no piso do PMax o que o
     *  Google já APROVOU (nunca o que ainda está em revisão). */
    primaryStatus?: string;
    policySummary?: { approvalStatus?: string };
  };
}

/** Conjunto FECHADO dos `field_type` conhecidos — usado pelos dois conjuntos
 *  de segurança do módulo (`PROTECTED_FIELD_TYPES`, `IMAGE_FIELD_TYPES` na
 *  CLI) que precisam de proteção real contra typo em tempo de compilação:
 *  um valor digitado errado num desses conjuntos deve ser erro de `tsc`, não
 *  um item real "escapando" silenciosamente da lista de protegidos. */
export type KnownAssetGroupFieldType =
  | "HEADLINE"
  | "LONG_HEADLINE"
  | "DESCRIPTION"
  | "BUSINESS_NAME"
  | "SQUARE_MARKETING_IMAGE"
  | "MARKETING_IMAGE"
  | "PORTRAIT_MARKETING_IMAGE"
  | "LOGO"
  | "LANDSCAPE_LOGO"
  | "CALL_TO_ACTION_SELECTION"
  | "YOUTUBE_VIDEO";

/** O campo como ele de fato chega da API — pode ser qualquer string (a
 *  Google pode introduzir um `field_type` novo amanhã). `string & {}` em vez
 *  de `| string` cru: um union de literais MAIS `string` cru colapsa pro
 *  `string` puro (perde toda a proteção de typo dos literais); `string & {}`
 *  preserva o autocomplete/checagem dos literais conhecidos e ainda aceita
 *  qualquer string em runtime — é o único dos dois que não é equivalente a
 *  `string` pra fins de tipagem. */
export type AssetGroupFieldType = KnownAssetGroupFieldType | (string & {});

export interface AssetGroupAssetItem {
  assetGroupAssetResourceName: string;
  assetResourceName: string;
  assetId: string;
  fieldType: AssetGroupFieldType;
  status: string;
  assetType: string;
  /** Texto do asset, quando `assetType === "TEXT"`. */
  text?: string;
  /** Nome do arquivo/asset, quando `assetType === "IMAGE"` (o campo `name`
   *  do asset — é onde os marcadores "Generated image"/"Gemini_Generated_Image"
   *  aparecem, não no texto). */
  imageName?: string;
  /** `asset_group_asset.policy_summary.approval_status` (APPROVED,
   *  APPROVED_LIMITED, DISAPPROVED, UNKNOWN...). Ausente = não lido. */
  approvalStatus?: string;
  /** `asset_group_asset.primary_status` (ELIGIBLE, NOT_ELIGIBLE, PENDING...). */
  primaryStatus?: string;
}

/** Monta a query GAQL de leitura de todos os `asset_group_asset` de um
 *  grupo de recursos, pelo resource name completo do grupo. Valida o
 *  formato (`customers/{dígitos}/assetGroups/{dígitos}`) antes de
 *  interpolar — GAQL não aceita parâmetros bind (mesma disciplina de
 *  `buildConversionActionReadQuery` em `google-ads-conversion-action.ts`,
 *  achado do review da PR #8956: esta função não tinha a mesma validação
 *  que a irmã, apesar do mesmo risco de interpolação direta em string).
 *  @pure */
export function buildAssetGroupAssetsQuery(assetGroupResourceName: string): string {
  if (!/^customers\/\d+\/assetGroups\/\d+$/.test(assetGroupResourceName)) {
    throw new Error(
      `assetGroupResourceName precisa ser "customers/{dígitos}/assetGroups/{dígitos}", recebido: "${assetGroupResourceName}"`,
    );
  }
  return (
    "SELECT asset_group_asset.asset, asset_group_asset.field_type, asset_group_asset.status, " +
    "asset_group_asset.primary_status, asset_group_asset.policy_summary.approval_status, " +
    "asset.id, asset.name, asset.type, asset.text_asset.text, asset.image_asset.full_size.url " +
    `FROM asset_group_asset WHERE asset_group_asset.asset_group = '${assetGroupResourceName}'`
  );
}

/** Normaliza as linhas brutas de `googleAds:search`. Linha sem os campos
 *  mínimos (resource names) é descartada — mesma disciplina de "nunca
 *  contaminar com dado incompleto" do resto do projeto. @pure */
export function parseAssetGroupAssetRows(rows: AssetGroupAssetApiRow[]): AssetGroupAssetItem[] {
  const items: AssetGroupAssetItem[] = [];
  for (const row of rows) {
    const aga = row.assetGroupAsset;
    const asset = row.asset;
    if (!aga?.resourceName || !aga.asset || !aga.fieldType || !aga.status) continue;
    if (!asset?.resourceName || !asset.id) continue;
    items.push({
      assetGroupAssetResourceName: aga.resourceName,
      assetResourceName: asset.resourceName,
      assetId: asset.id,
      fieldType: aga.fieldType,
      status: aga.status,
      assetType: asset.type ?? "UNKNOWN",
      text: asset.textAsset?.text,
      imageName: asset.name,
      // Só presentes quando a API devolve — chave `undefined` explícita
      // quebraria comparações estritas de quem já consome este shape.
      ...(aga.policySummary?.approvalStatus ? { approvalStatus: aga.policySummary.approvalStatus } : {}),
      ...(aga.primaryStatus ? { primaryStatus: aga.primaryStatus } : {}),
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Classificação (stale / keep / needsReview / protected)
// ---------------------------------------------------------------------------

/** Nunca tocados por este módulo, independente de conteúdo — vídeos do
 *  YouTube (fora de escopo da troca de criativos), CTA (não faz parte do
 *  pacote texto/imagem definido na issue), e os 3 tipos que já estão todos
 *  `REMOVED` hoje e cuja restauração é decisão separada (ver docstring do
 *  módulo — "verificar antes de retirar" ainda pendente, então também
 *  pendente pra ADICIONAR). */
export const PROTECTED_FIELD_TYPES: ReadonlySet<AssetGroupFieldType> = new Set([
  "YOUTUBE_VIDEO",
  "CALL_TO_ACTION_SELECTION",
  "LOGO",
  "LANDSCAPE_LOGO",
  "BUSINESS_NAME",
]);

/** Textos genéricos confirmados ao vivo em 28/09/2026 (idênticos aos
 *  descritos na issue em 20/09/2026 — nada mudou) — candidatos a stale.
 *  Comparação exata (não regex): um texto novo que por acaso contenha uma
 *  destas substrings não deve ser staleado por engano. */
export const STALE_TEXT_VALUES: ReadonlySet<string> = new Set([
  "Newsletter de IA",
  "Notícias de IA diariamente",
  "Notícias de IA todos os dias",
  "Newsletter de IA grátis",
  "As notícias mais importantes sobre IA chegando todos os dias na sua caixa de entrada.",
  "As notícias mais importantes sobre IA, de graça em sua caixa de entrada.",
  "As notícias mais importantes sobre IA, resumidas para você.",
  "Fique Atualizado sobre IA",
  "Economizamos seu tempo com curadoria e resumo das principais notícias sobre IA.",
  "Newsletter de IA em português",
  "Resumos de IA em 5 minutos",
  "Fique à frente no mundo da IA",
  "Dicas de IA",
  "IA para Iniciantes",
  "Tutoriais de IA Diários",
  "Aprenda IA Todos os Dias",
  "IA: As Últimas Notícias",
  "IA:Resumo Diário de Notícias",
  "Assine e desbloqueie o acesso à nossa curadoria de cursos gratuitos de IA.",
  "Receba atualizações diárias sobre as últimas novidades em IA.",
  "Sua dose diária de notícias de IA.",
  "Cursos de IA gratuitos para assinantes.",
  "A newsletter de IA para pessoas ocupadas.",
]);

/** Texto conhecido a MANTER mesmo sendo um HEADLINE — não é genérico
 *  antigo, é recente (sitelinks 07/09 são da mesma safra, ids na faixa
 *  418xxx). */
export const KEEP_TEXT_VALUES: ReadonlySet<string> = new Set(["diar.ia.br"]);

/** Padrões de nome de arquivo de imagem que identificam os criativos
 *  genéricos gerados por IA em dez/2025 — candidatos a stale. @pure via
 *  {@link isStaleImageName}. */
const STALE_IMAGE_NAME_PATTERNS: RegExp[] = [/^Generated image/i, /^Gemini_Generated_Image/i];

/** @pure */
export function isStaleImageName(name: string | undefined): boolean {
  if (!name) return false;
  return STALE_IMAGE_NAME_PATTERNS.some((re) => re.test(name));
}

/** Nome de imagem que precisa de decisão humana antes de mexer — logos
 *  ativos como marketing image: `logo_1.jpg` (quadrada, ver docstring do
 *  módulo) e `logo_1.91:1.jpg` (id `318613044963`, MARKETING_IMAGE 724×378 —
 *  achado na leitura de 03/10/2026; antes caía em `keep` por não bater com
 *  nenhum padrão, sem aparecer no relatório de pendências). @pure */
const NEEDS_REVIEW_IMAGE_NAMES: ReadonlySet<string> = new Set(["logo_1.jpg", "logo_1.91:1.jpg"]);

export interface AssetGroupClassification {
  /** Recursos genéricos antigos — candidatos a REMOVER depois que os novos
   *  estiverem `ENABLED` e sem reprovação (sequenciamento da issue). */
  stale: AssetGroupAssetItem[];
  /** Recursos a manter como estão — nem stale nem em revisão. */
  keep: AssetGroupAssetItem[];
  /** Recursos ambíguos — a issue explicitamente NÃO resolveu se ficam ou
   *  saem (`logo_1.jpg`) — nunca auto-classificados, sempre reportados à
   *  parte pra decisão humana. */
  needsReview: AssetGroupAssetItem[];
  /** Tipos de campo nunca tocados por este classificador (vídeos, CTA,
   *  logo/nome de empresa já removidos). */
  protectedItems: AssetGroupAssetItem[];
}

/**
 * Classifica os `asset_group_asset` ENABLED de um grupo de recursos.
 * Itens `REMOVED`/`PAUSED` são ignorados — já não estão ativos, nada a
 * decidir sobre eles aqui (ver `filterEnabled`).
 *
 * @pure
 */
export function classifyAssetGroupAssets(items: readonly AssetGroupAssetItem[]): AssetGroupClassification {
  const stale: AssetGroupAssetItem[] = [];
  const keep: AssetGroupAssetItem[] = [];
  const needsReview: AssetGroupAssetItem[] = [];
  const protectedItems: AssetGroupAssetItem[] = [];

  for (const item of items) {
    if (item.status !== "ENABLED") continue;
    if (PROTECTED_FIELD_TYPES.has(item.fieldType)) {
      protectedItems.push(item);
      continue;
    }
    if (item.assetType === "IMAGE") {
      if (item.imageName && NEEDS_REVIEW_IMAGE_NAMES.has(item.imageName)) {
        needsReview.push(item);
      } else if (isStaleImageName(item.imageName)) {
        stale.push(item);
      } else {
        keep.push(item);
      }
      continue;
    }
    if (item.assetType === "TEXT") {
      if (item.text && KEEP_TEXT_VALUES.has(item.text)) {
        keep.push(item);
      } else if (item.text && STALE_TEXT_VALUES.has(item.text)) {
        stale.push(item);
      } else {
        // Texto ENABLED que não bate com nenhuma lista conhecida — não
        // presumir stale nem keep; tratado como needsReview pra nunca
        // remover algo desconhecido em silêncio.
        needsReview.push(item);
      }
      continue;
    }
    // Tipo de asset desconhecido (nem TEXT nem IMAGE) — mesma cautela.
    needsReview.push(item);
  }

  // Invariante de partição: todo item ENABLED cai em EXATAMENTE 1 dos 4
  // buckets (nunca 0, nunca 2+) — é o que garante que `--remove-stale`
  // (que só olha `stale`) nunca remove um item que também apareceu em
  // `keep`/`needsReview`/`protectedItems` por um branch novo mal encaixado
  // no loop acima. Lança (não `console.warn`) porque, se isto um dia for
  // falso, a função em si está quebrada — degradar em silêncio aqui seria
  // pior que abortar (achado do review da PR #8956, type-design-analyzer).
  const enabledCount = items.filter((i) => i.status === "ENABLED").length;
  const bucketedCount = stale.length + keep.length + needsReview.length + protectedItems.length;
  if (bucketedCount !== enabledCount) {
    throw new Error(
      `classifyAssetGroupAssets: invariante de partição violado — ${enabledCount} item(ns) ENABLED, ` +
        `${bucketedCount} classificado(s) nos 4 buckets. Um item ficou sem bucket ou foi contado 2x — bug na função, não no chamador.`,
    );
  }

  return { stale, keep, needsReview, protectedItems };
}

// ---------------------------------------------------------------------------
// Conjunto novo (texto) — definido pelo editor na issue #8550, 20/09/2026
// ---------------------------------------------------------------------------

/** Os 4 headlines curtos (≤30 chars), derivados do que roda na Meta +
 *  `copy-final.json` (ver corpo da issue #8550). */
export const NEW_HEADLINES: readonly string[] = [
  "5 minutos por dia",
  "Também o lado ruim da IA",
  "Acompanhe pra usar melhor",
  "De centenas para uns dez",
];

/** Os 5 long headlines (≤90 chars) — título exato do d1 na Meta + os 4
 *  `body` dos anúncios ativos (tabela da issue #8550, 20/09/2026). */
export const NEW_LONG_HEADLINES: readonly string[] = [
  "De centenas de links para uns dez",
  "Todo dia leio centenas de links sobre IA e mando uns dez que realmente importam.",
  "Toda manhã, de segunda a sexta, em 5 minutos. Newsletter gratuita sobre IA.",
  "Também o que dá errado: golpes, viés e impacto no trabalho. Sem euforia.",
  "Não basta saber o que a IA fez. Todo dia eu mando o que dá pra fazer com ela. Grátis.",
];

/** As 5 descriptions (≤90 chars, ao menos 1 ≤60) — a curta é o ÚNICO texto
 *  novo do conjunto (encurtamento do body do d2, mesmas palavras), as
 *  outras 4 repetem os `body` da Meta (PMax aceita o mesmo texto em mais
 *  de 1 tipo de recurso). */
export const NEW_DESCRIPTIONS: readonly string[] = [
  "Toda manhã, em 5 minutos. Newsletter gratuita sobre IA.",
  "Todo dia leio centenas de links sobre IA e mando uns dez que realmente importam.",
  "Toda manhã, de segunda a sexta, em 5 minutos. Newsletter gratuita sobre IA.",
  "Também o que dá errado: golpes, viés e impacto no trabalho. Sem euforia.",
  "Não basta saber o que a IA fez. Todo dia eu mando o que dá pra fazer com ela. Grátis.",
];

/** Limites de contagem do PMax (documentação pública do Google Ads —
 *  "citados de memória" na issue original, confirmados aqui contra os
 *  valores publicados: Headlines 3-15/30 chars, Long headlines 1-5/90
 *  chars, Descriptions 2-5/90 chars com ao menos 1 ≤60). Não
 *  re-confirmados ao vivo nesta sessão contra a API (a API não expõe um
 *  endpoint de "limites" — só rejeita na mutação). */
export const PMAX_TEXT_LIMITS = {
  headline: { min: 3, max: 15, maxChars: 30 },
  longHeadline: { min: 1, max: 5, maxChars: 90 },
  description: { min: 2, max: 5, maxChars: 90, shortMaxChars: 60, shortRequired: 1 },
} as const;

export interface TextAssetPlanValidation {
  ok: boolean;
  errors: string[];
}

/** Valida o conjunto de texto novo contra os limites do PMax — roda ANTES
 *  de montar qualquer payload de mutação, pra nunca enviar uma combinação
 *  que a API recusaria de qualquer forma. @pure */
export function validateNewTextAssetPlan(
  headlines: readonly string[] = NEW_HEADLINES,
  longHeadlines: readonly string[] = NEW_LONG_HEADLINES,
  descriptions: readonly string[] = NEW_DESCRIPTIONS,
): TextAssetPlanValidation {
  const errors: string[] = [];
  const { headline, longHeadline, description } = PMAX_TEXT_LIMITS;

  if (headlines.length < headline.min || headlines.length > headline.max) {
    errors.push(`headlines: ${headlines.length} fora do intervalo [${headline.min}, ${headline.max}]`);
  }
  for (const h of headlines) {
    if (h.length > headline.maxChars) errors.push(`headline "${h}" tem ${h.length} chars (máx ${headline.maxChars})`);
  }

  if (longHeadlines.length < longHeadline.min || longHeadlines.length > longHeadline.max) {
    errors.push(`long headlines: ${longHeadlines.length} fora do intervalo [${longHeadline.min}, ${longHeadline.max}]`);
  }
  for (const h of longHeadlines) {
    if (h.length > longHeadline.maxChars) errors.push(`long headline "${h}" tem ${h.length} chars (máx ${longHeadline.maxChars})`);
  }

  if (descriptions.length < description.min || descriptions.length > description.max) {
    errors.push(`descriptions: ${descriptions.length} fora do intervalo [${description.min}, ${description.max}]`);
  }
  for (const d of descriptions) {
    if (d.length > description.maxChars) errors.push(`description "${d}" tem ${d.length} chars (máx ${description.maxChars})`);
  }
  const shortCount = descriptions.filter((d) => d.length <= description.shortMaxChars).length;
  if (shortCount < description.shortRequired) {
    errors.push(
      `descriptions: precisa de ao menos ${description.shortRequired} com ≤${description.shortMaxChars} chars, achei ${shortCount}`,
    );
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Payloads de mutação (pure builders)
// ---------------------------------------------------------------------------

export type TextFieldType = "HEADLINE" | "LONG_HEADLINE" | "DESCRIPTION";

/** Monta o payload de `assets:mutate` (create) pros textos novos — 1
 *  operação por texto, sem `resourceName` (a API atribui um id no create).
 *  @pure */
export function buildCreateTextAssetsPayload(
  texts: readonly string[],
  fieldType: TextFieldType,
): { operations: Array<{ create: { textAsset: { text: string } } }> } {
  return { operations: texts.map((text) => ({ create: { textAsset: { text } } })) };
}

/** Monta o payload de `assets:mutate` (create) pra 1 imagem, a partir dos
 *  bytes já codificados em base64 (o caller lê o arquivo do disco — este
 *  módulo não toca disco). @pure */
export function buildCreateImageAssetPayload(
  imageBase64: string,
  name: string,
): { operations: Array<{ create: { name: string; imageAsset: { data: string } } }> } {
  return { operations: [{ create: { name, imageAsset: { data: imageBase64 } } }] };
}

/** Monta o payload de `assetGroupAssets:mutate` (create) linkando assets
 *  já criados (por resource name) ao grupo de recursos, com o field_type
 *  apropriado. @pure */
export function buildLinkAssetGroupAssetsPayload(
  assetGroupResourceName: string,
  assetResourceNames: readonly string[],
  fieldType: AssetGroupFieldType,
): { operations: Array<{ create: { assetGroup: string; asset: string; fieldType: string } }> } {
  return {
    operations: assetResourceNames.map((asset) => ({
      create: { assetGroup: assetGroupResourceName, asset, fieldType },
    })),
  };
}

// ---------------------------------------------------------------------------
// Capacidade por fieldType na Fase 1 (#9017)
// ---------------------------------------------------------------------------

/** Máximo de `asset_group_asset` ENABLED por fieldType de texto, derivado de
 *  `PMAX_TEXT_LIMITS` (fonte única — não duplicar os números). */
export const PMAX_TEXT_FIELD_MAX: Readonly<Record<TextFieldType, number>> = {
  HEADLINE: PMAX_TEXT_LIMITS.headline.max,
  LONG_HEADLINE: PMAX_TEXT_LIMITS.longHeadline.max,
  DESCRIPTION: PMAX_TEXT_LIMITS.description.max,
};

/** Os 3 fieldTypes de imagem de marketing que a Fase 1 linka (#9057). */
export type ImageFieldType = Extract<KnownAssetGroupFieldType, "SQUARE_MARKETING_IMAGE" | "MARKETING_IMAGE" | "PORTRAIT_MARKETING_IMAGE">;

/** Máximo de `asset_group_asset` ENABLED por fieldType de IMAGEM num asset
 *  group PMax (#9057). Fonte: Google Ads API, "Performance Max asset
 *  requirements" (https://developers.google.com/google-ads/api/performance-max/asset-requirements),
 *  lida em 29/09/2026 — MARKETING_IMAGE (1,91:1) mín 1/máx 20,
 *  SQUARE_MARKETING_IMAGE (1:1) mín 1/máx 20, PORTRAIT_MARKETING_IMAGE (4:5)
 *  máx 20. O teto COMBINADO entre os tipos vive à parte, em
 *  `PMAX_IMAGE_COMBINED_MAX` (#9080). Mesma ressalva de `PMAX_TEXT_LIMITS`: a
 *  API não expõe endpoint de limites, só rejeita na mutação. */
export const PMAX_IMAGE_FIELD_MAX: Readonly<Record<ImageFieldType, number>> = {
  SQUARE_MARKETING_IMAGE: 20,
  MARKETING_IMAGE: 20,
  PORTRAIT_MARKETING_IMAGE: 20,
};

/** Teto COMBINADO de imagens de marketing ENABLED por asset group (#9080) —
 *  soma dos 3 tipos de `PMAX_IMAGE_FIELD_MAX`. Premissa CONSERVADORA, não
 *  fato confirmado: a doc da API (lida em 29/09/2026) só cita 20 por tipo, mas
 *  guias de terceiros descrevem "até 20 imagens por asset group, em qualquer
 *  combinação de proporções", e a Central de Ajuda repete "Add up to 20 images"
 *  em cada linha sem desambiguar. Ao vivo (dry-run, 29/09/2026) o grupo
 *  `6642889160` tinha 19 imagens ENABLED somando os 3 tipos, o que não
 *  distingue as duas leituras. Impor o teto combinado custa pouco se ele não
 *  existir (a Fase 1 remove mais cedo imagens stale que a Fase 2 removeria de
 *  qualquer jeito); não impor, se ele existir, faz a Fase 1 falhar no meio
 *  (textos linkados, imagens criadas e órfãs). Logos (LOGO/LANDSCAPE_LOGO)
 *  ficam fora da soma: estão todos REMOVED no grupo e são PROTECTED aqui. */
export const PMAX_IMAGE_COMBINED_MAX = 20;

/** Mínimo de imagens ENABLED por tipo que o grupo precisa manter (mesma fonte
 *  de `PMAX_IMAGE_FIELD_MAX`: MARKETING_IMAGE e SQUARE_MARKETING_IMAGE são
 *  obrigatórios, mín 1; PORTRAIT é opcional). O teto combinado nunca remove
 *  stale de um tipo abaixo deste piso (#9080). */
export const PMAX_IMAGE_FIELD_MIN: Readonly<Record<ImageFieldType, number>> = {
  SQUARE_MARKETING_IMAGE: 1,
  MARKETING_IMAGE: 1,
  PORTRAIT_MARKETING_IMAGE: 0,
};

export interface FieldLinkPlan<F extends AssetGroupFieldType = AssetGroupFieldType> {
  fieldType: F;
  /** Quantos recursos novos a Fase 1 vai linkar neste fieldType. */
  newCount: number;
  /** ENABLED hoje no grupo neste fieldType (todos os buckets). */
  existingEnabled: number;
  /** Dos ENABLED, quantos NÃO são stale (keep + needsReview) — ficam no
   *  grupo de qualquer jeito, nenhuma fase os remove. */
  permanent: number;
  max: number;
  /** `asset_group_asset` stale deste fieldType que precisam sair NO MESMO
   *  `assetGroupAssets:mutate` do link (remove+create atômico), porque
   *  `existingEnabled + newCount > max`. Vazio = cabe sem remover nada — o
   *  "adicionar antes de remover" original vale. É o MÍNIMO necessário pra
   *  caber (o resto do stale continua pra Fase 2). */
  removeInSameMutate: string[];
}

export type FieldLinkPlanResult<F extends AssetGroupFieldType = AssetGroupFieldType> =
  | { ok: true; plans: FieldLinkPlan<F>[] }
  | { ok: false; errors: string[]; plans: FieldLinkPlan<F>[] };

export type TextLinkPlanResult = FieldLinkPlanResult<TextFieldType>;
export type ImageLinkPlanResult = FieldLinkPlanResult<ImageFieldType>;

/** Núcleo comum de `planTextFieldLinks`/`planImageFieldLinks` — mesma regra
 *  de capacidade para qualquer fieldType com máximo conhecido. @pure */
function planFieldLinksAgainstMax<F extends AssetGroupFieldType>(
  items: readonly AssetGroupAssetItem[],
  classification: AssetGroupClassification,
  maxByField: Readonly<Record<F, number>>,
  newCounts: Readonly<Record<F, number>>,
  skipFieldTypes: ReadonlySet<string>,
): FieldLinkPlanResult<F> {
  const plans: FieldLinkPlan<F>[] = [];
  const errors: string[] = [];
  for (const fieldType of Object.keys(maxByField) as F[]) {
    if (skipFieldTypes.has(fieldType)) continue;
    const newCount = newCounts[fieldType];
    if (newCount === 0) continue;
    const max = maxByField[fieldType];
    const existingEnabled = items.filter((i) => i.status === "ENABLED" && i.fieldType === fieldType).length;
    const staleOfType = classification.stale.filter((i) => i.fieldType === fieldType);
    const permanent = existingEnabled - staleOfType.length;
    const overflow = existingEnabled + newCount - max;
    let removeInSameMutate: string[] = [];
    if (overflow > 0) {
      if (permanent + newCount > max) {
        errors.push(
          `${fieldType}: ${permanent} recurso(s) não-stale (keep/needsReview) + ${newCount} novo(s) = ${permanent + newCount} > máximo ${max} — ` +
            "nem removendo todo o stale deste tipo cabe; decidir à mão o que sai antes de rodar --send",
        );
      } else {
        removeInSameMutate = staleOfType.slice(0, overflow).map((i) => i.assetGroupAssetResourceName);
      }
    }
    plans.push({ fieldType, newCount, existingEnabled, permanent, max, removeInSameMutate });
  }
  return errors.length === 0 ? { ok: true, plans } : { ok: false, errors, plans };
}

/**
 * Planeja o link dos textos novos contra a capacidade REAL do grupo (#9017):
 * `validateNewTextAssetPlan` só valida o conjunto novo isolado, mas o máximo
 * do PMax é sobre o que fica ENABLED no grupo — antigos + novos. Com 5 long
 * headlines / 5 descriptions novos (= máximo) e os antigos ainda linkados,
 * "linkar tudo antes de remover" estoura o limite e a API rejeita no meio da
 * Fase 1, deixando o grupo parcialmente trocado.
 *
 * Por fieldType:
 *   - `existingEnabled + newCount <= max` → linka sem remover nada.
 *   - senão, se `permanent + newCount <= max` → remove o mínimo de stale do
 *     mesmo fieldType no MESMO mutate (atômico: a API aplica tudo ou nada,
 *     então o grupo nunca fica abaixo do mínimo nem acima do máximo).
 *   - senão → inviável (keep/needsReview sozinhos já ocupam a vaga): erro,
 *     e o caller recusa ANTES de qualquer mutação.
 *
 * `skipFieldTypes`: etapas já linkadas numa tentativa anterior (progresso) —
 * os novos já estão no grupo e contariam como `permanent` (texto
 * desconhecido → needsReview), o que tornaria um retry falsamente inviável.
 *
 * @pure
 */
export function planTextFieldLinks(
  items: readonly AssetGroupAssetItem[],
  classification: AssetGroupClassification,
  newCounts: Readonly<Record<TextFieldType, number>>,
  skipFieldTypes: ReadonlySet<string> = new Set(),
): TextLinkPlanResult {
  return planFieldLinksAgainstMax(items, classification, PMAX_TEXT_FIELD_MAX, newCounts, skipFieldTypes);
}

/**
 * Mesmo plano de capacidade de `planTextFieldLinks`, para as IMAGENS do PMax
 * (#9057) — antes só os fieldTypes de texto eram validados contra o máximo, e
 * um manifesto que, somado às imagens já ENABLED, passasse de
 * `PMAX_IMAGE_FIELD_MAX` só falharia na mutação, no meio da Fase 1 (textos já
 * linkados, imagens criadas e órfãs). Imagem `needsReview` (`logo_1.jpg`) e
 * `keep` contam como permanentes — nunca removidas para abrir vaga. Desde o
 * #9080 aplica também o teto combinado (`applyCombinedImageCap`).
 *
 * @pure
 */
export function planImageFieldLinks(
  items: readonly AssetGroupAssetItem[],
  classification: AssetGroupClassification,
  newCounts: Readonly<Record<ImageFieldType, number>>,
  skipFieldTypes: ReadonlySet<string> = new Set(),
): ImageLinkPlanResult {
  const perType = planFieldLinksAgainstMax(items, classification, PMAX_IMAGE_FIELD_MAX, newCounts, skipFieldTypes);
  // Plano por tipo já inviável: o teto combinado só repetiria o mesmo erro.
  const combinedErrors = perType.ok ? applyCombinedImageCap(items, classification, perType.plans) : [];
  const errors = [...(perType.ok ? [] : perType.errors), ...combinedErrors];
  return errors.length === 0 ? { ok: true, plans: perType.plans } : { ok: false, errors, plans: perType.plans };
}

/**
 * Teto combinado (#9080, `PMAX_IMAGE_COMBINED_MAX`) por cima do plano por
 * tipo. Os links de imagem saem um `assetGroupAssets:mutate` por fieldType,
 * na ordem dos `plans` (= ordem de `PMAX_IMAGE_FIELD_MAX`, a mesma da CLI), e
 * CADA mutate precisa deixar o total ≤ teto — não só o estado final. Quando um
 * link passaria do teto, remove mais imagens stale no MESMO mutate (um
 * `assetGroupAssets:mutate` remove qualquer `asset_group_asset` do grupo, não
 * só do fieldType linkado): primeiro do próprio tipo, depois dos demais na
 * ordem, nunca deixando um tipo abaixo de `PMAX_IMAGE_FIELD_MIN` nem tocando
 * em keep/needsReview. Muta `plans[].removeInSameMutate`; devolve os erros.
 * Etapas já linkadas (fora de `plans`) já estão em `items` como ENABLED.
 */
function applyCombinedImageCap(
  items: readonly AssetGroupAssetItem[],
  classification: AssetGroupClassification,
  plans: FieldLinkPlan<ImageFieldType>[],
): string[] {
  if (plans.length === 0) return [];
  const imageTypes = Object.keys(PMAX_IMAGE_FIELD_MAX) as ImageFieldType[];
  const isImageType = (ft: string): ft is ImageFieldType => (imageTypes as string[]).includes(ft);
  const countByType = Object.fromEntries(imageTypes.map((ft) => [ft, 0])) as Record<ImageFieldType, number>;
  for (const i of items) if (i.status === "ENABLED" && isImageType(i.fieldType)) countByType[i.fieldType]++;
  const scheduled = new Set(plans.flatMap((p) => p.removeInSameMutate));
  const pool = classification.stale.filter(
    (i) => isImageType(i.fieldType) && !scheduled.has(i.assetGroupAssetResourceName),
  );
  let running = Object.values(countByType).reduce((a, b) => a + b, 0);
  const errors: string[] = [];
  for (const plan of plans) {
    running += plan.newCount - plan.removeInSameMutate.length;
    countByType[plan.fieldType] += plan.newCount - plan.removeInSameMutate.length;
    const order = [plan.fieldType, ...imageTypes.filter((ft) => ft !== plan.fieldType)];
    for (const ft of order) {
      while (running > PMAX_IMAGE_COMBINED_MAX && countByType[ft] > PMAX_IMAGE_FIELD_MIN[ft]) {
        const idx = pool.findIndex((i) => i.fieldType === ft);
        if (idx < 0) break;
        const [picked] = pool.splice(idx, 1);
        plan.removeInSameMutate.push(picked.assetGroupAssetResourceName);
        countByType[ft]--;
        running--;
      }
    }
    if (running > PMAX_IMAGE_COMBINED_MAX) {
      errors.push(
        `teto combinado de imagens: linkar ${plan.fieldType} deixaria ${running} imagem(ns) ENABLED no grupo > máximo combinado ${PMAX_IMAGE_COMBINED_MAX} ` +
          "mesmo removendo todo o stale disponível — decidir à mão o que sai antes de rodar --send",
      );
      return errors;
    }
  }
  return errors;
}

/** Monta o payload de `assetGroupAssets:mutate` que linka os novos E remove
 *  os stale indicados NA MESMA requisição (#9017) — `remove` primeiro, depois
 *  `create`, pra que mesmo um processamento sequencial nunca passe do máximo.
 *  Sem `partialFailure`, o mutate é atômico (tudo ou nada). Com
 *  `removeResourceNames` vazio, é idêntico a `buildLinkAssetGroupAssetsPayload`.
 *  @pure */
export function buildSwapAssetGroupAssetsPayload(
  assetGroupResourceName: string,
  assetResourceNames: readonly string[],
  fieldType: AssetGroupFieldType,
  removeResourceNames: readonly string[] = [],
): { operations: Array<{ remove: string } | { create: { assetGroup: string; asset: string; fieldType: string } }> } {
  return {
    operations: [
      ...buildRemoveAssetGroupAssetsPayload(removeResourceNames).operations,
      ...buildLinkAssetGroupAssetsPayload(assetGroupResourceName, assetResourceNames, fieldType).operations,
    ],
  };
}

/** Monta o payload de `assetGroupAssets:mutate` (remove) pros
 *  `asset_group_asset` staleados — SEMPRE a última chamada do fluxo (só
 *  depois dos novos estarem `ENABLED` e sem reprovação, sequenciamento da
 *  issue #8550). Exceção (#9017): reusado por
 *  `buildSwapAssetGroupAssetsPayload` pra remover, junto do link na Fase 1,
 *  só o mínimo de stale que não cabe ao lado dos novos. @pure */
export function buildRemoveAssetGroupAssetsPayload(
  assetGroupAssetResourceNames: readonly string[],
): { operations: Array<{ remove: string }> } {
  return { operations: assetGroupAssetResourceNames.map((resourceName) => ({ remove: resourceName })) };
}

// ---------------------------------------------------------------------------
// Manifesto de progresso da Fase 1 (#8960 — recuperação de falha parcial)
// ---------------------------------------------------------------------------

/** Uma "etapa" da Fase 1 = 1 `fieldType` (3 de texto + 3 de imagem). O
 *  script cria+linka um `fieldType` de cada vez (mesmo agrupamento que o
 *  código de `main()` já usava) — granularidade suficiente pra achado #1 da
 *  issue #8960 (retry ingênuo recriando o lote inteiro): se a Fase 1 falhar
 *  no meio, o `resourceNames` já criados ficam registrados aqui, e um retry
 *  reusa em vez de recriar (evita duplicar os órfãos). `linked: false`
 *  registra "criado mas ainda não linkado" — o pior caso de inconsistência
 *  descrito na issue (grupo parcialmente trocado). */
export interface SwapProgressStep {
  resourceNames: string[];
  linked: boolean;
}

export type SwapProgressStepKey = TextFieldType | ImageFieldType;

export interface SwapProgress {
  version: 1;
  updated_at: string;
  /** Hash de identidade do swap (manifesto de imagens + asset group +
   *  customer) que este progresso pertence — ver `computeSwapFingerprint`.
   *  `undefined` = progresso de antes do #8972 (item 3) ou manifesto vazio;
   *  o caller trata como "não bate" (fail-safe, nunca reusa um progresso
   *  sem fingerprint confirmado). */
  fingerprint?: string;
  steps: Partial<Record<SwapProgressStepKey, SwapProgressStep>>;
}

/** Manifesto vazio — ponto de partida de uma Fase 1 nova. @pure */
export function emptySwapProgress(now: Date = new Date()): SwapProgress {
  return { version: 1, updated_at: now.toISOString(), steps: {} };
}

/**
 * Hash de identidade de UM swap (#8960 achado #1 comment, #8972 item 3) —
 * combina o conteúdo bruto do `--images-manifest` com o asset group/customer
 * alvo, pra `main()` recusar reusar um `--progress-file` que pertence a um
 * swap DIFERENTE (manifesto trocado entre tentativas, ou arquivo do
 * asset-group/customer errado por engano de flag). Puro dado os 3 inputs
 * (SHA-256 é determinístico); o caller lê o manifesto do disco, não este
 * módulo. Não usa o `manifest` já parseado como input (usaria o texto BRUTO
 * do arquivo) pra não depender de normalização de JSON — dois arquivos
 * byte-idênticos sempre dão o mesmo fingerprint, e essa é a garantia que
 * importa (não "semanticamente equivalentes"). @pure
 */
export function computeSwapFingerprint(rawManifestText: string, assetGroupResourceName: string, customerId: string): string {
  return createHash("sha256").update(rawManifestText).update("\u0000").update(assetGroupResourceName).update("\u0000").update(customerId).digest("hex");
}

/** Devolve um NOVO manifesto com o `fingerprint` definido — chamado uma vez
 *  no início de uma Fase 1, antes de qualquer `withSwapProgressStep`, pra
 *  fixar a identidade que todas as etapas seguintes vão carregar. @pure */
export function withSwapProgressFingerprint(progress: SwapProgress, fingerprint: string, now: Date = new Date()): SwapProgress {
  return { version: 1, updated_at: now.toISOString(), fingerprint, steps: progress.steps };
}

function isValidSwapProgressStep(value: unknown): value is SwapProgressStep {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.resourceNames) && v.resourceNames.every((r) => typeof r === "string") && typeof v.linked === "boolean";
}

/** Parseia o conteúdo bruto (string) do arquivo de progresso. Fail-soft por
 *  design (mesmo contrato dos parsers de `issue-decisions.ts`): `null`,
 *  string vazia, JSON inválido ou forma inesperada devolvem um manifesto
 *  vazio em vez de lançar — um arquivo de progresso corrompido nunca deve
 *  travar um retry, só faz o retry recriar do zero (pior caso conhecido,
 *  não uma exceção não tratada). @pure */
export function parseSwapProgress(raw: string | null | undefined): SwapProgress {
  if (!raw) return emptySwapProgress();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptySwapProgress();
  }
  if (typeof parsed !== "object" || parsed === null) return emptySwapProgress();
  const p = parsed as Record<string, unknown>;
  if (p.version !== 1 || typeof p.steps !== "object" || p.steps === null) return emptySwapProgress();
  const steps: SwapProgress["steps"] = {};
  for (const [key, value] of Object.entries(p.steps as Record<string, unknown>)) {
    if (isValidSwapProgressStep(value)) steps[key as SwapProgressStepKey] = value;
  }
  return {
    version: 1,
    updated_at: typeof p.updated_at === "string" ? p.updated_at : new Date().toISOString(),
    fingerprint: typeof p.fingerprint === "string" ? p.fingerprint : undefined,
    steps,
  };
}

/** Devolve um NOVO manifesto com a etapa `stepKey` atualizada — nunca muta
 *  o argumento. Preserva `fingerprint` (setado uma vez, no início da Fase 1,
 *  via `withSwapProgressFingerprint`). @pure */
export function withSwapProgressStep(
  progress: SwapProgress,
  stepKey: SwapProgressStepKey,
  step: SwapProgressStep,
  now: Date = new Date(),
): SwapProgress {
  return { version: 1, updated_at: now.toISOString(), fingerprint: progress.fingerprint, steps: { ...progress.steps, [stepKey]: step } };
}

/** Serializa pra gravar em disco (o caller faz o `writeFileSync`, este
 *  módulo não toca disco). @pure */
export function serializeSwapProgress(progress: SwapProgress): string {
  return JSON.stringify(progress, null, 2);
}
