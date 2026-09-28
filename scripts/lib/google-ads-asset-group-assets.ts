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
 * Duas razões independentes — só a #2 é checada em código:
 *   1. **[processo, NÃO checado em código] Editor declinou autorização
 *      hoje** via `/diaria-desbloqueia` ("ainda não" — ver marcador
 *      `acao-adiada` no comentário da issue, cooldown de 7 dias,
 *      `scripts/lib/issue-decisions.ts`). Quem for rodar `--send` precisa
 *      reler a issue à mão antes — nenhuma chamada a `isAcaoAdiadaAtiva`
 *      acontece neste módulo/CLI (achado do review da PR #8956).
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

/** Nome de imagem que precisa de decisão humana antes de mexer — hoje só
 *  `logo_1.jpg` (a única imagem com cara de logo ativa como marketing
 *  image, ver docstring do módulo). @pure */
const NEEDS_REVIEW_IMAGE_NAMES: ReadonlySet<string> = new Set(["logo_1.jpg"]);

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

/** Monta o payload de `assetGroupAssets:mutate` (remove) pros
 *  `asset_group_asset` staleados — SEMPRE a última chamada do fluxo (só
 *  depois dos novos estarem `ENABLED` e sem reprovação, sequenciamento da
 *  issue #8550). @pure */
export function buildRemoveAssetGroupAssetsPayload(
  assetGroupAssetResourceNames: readonly string[],
): { operations: Array<{ remove: string }> } {
  return { operations: assetGroupAssetResourceNames.map((resourceName) => ({ remove: resourceName })) };
}
