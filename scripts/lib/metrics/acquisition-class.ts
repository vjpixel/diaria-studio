/**
 * scripts/lib/metrics/acquisition-class.ts (#7173, fatia 1 do épico #7172)
 *
 * Taxonomia canônica de classe de aquisição — 5 valores exclusivos, primeira
 * regra que casa vence (mesma disciplina de `classifyExecTrack`,
 * `scripts/lib/issue-exec-track.ts`).
 *
 * **Por que este módulo existe.** O mesmo snapshot Beehiiv, classificado por
 * três pessoas na mesma sessão de investigação (02/09/2026), produziu
 * `organico` = 14, 6 e 14 — a divergência inteira vinha de `linkedin` ser
 * lido como pago ou orgânico, e de `boost` ser detectado por `utm_channel`
 * ou por `utm_source`. O número da meta de ativação (#7172) não é ambíguo
 * por falta de dado; é ambíguo por falta de tabela. Esta função é a tabela.
 *
 * **Módulo PURO, sem I/O.** Importa só de `scripts/lib/shared/*` e
 * `scripts/lib/cohorts.ts` (ambos dependency-free) — NUNCA de
 * `scripts/cohort-engagement.ts` nem de `scripts/lib/cac.ts`, que carregam
 * `import "dotenv/config"` na cadeia e poluiriam `process.env` como side
 * effect de import (ver a docstring de
 * `scripts/lib/shared/attribution-keys.ts` para o achado medido em 02/09).
 *
 * **O que este módulo NÃO faz:**
 * - Não filtra conta interna/teste. `classifyAcquisition` recebe a tupla de
 *   atribuição, não o e-mail — quem monta a série chama
 *   `filterInternalAndTestSubscribers` (`scripts/lib/cac.ts`) ANTES de
 *   classificar. As duas camadas são complementares: a exclusão por e-mail
 *   tira quem nunca foi cadastro; a regra de `utm_source` interno abaixo
 *   (classe `indeterminado`) impede que o resto infle esse balde.
 * - Não reclassifica retroativamente nada nem escreve em plataforma
 *   (função pura). A captura é F2 (#7174); a reconstrução histórica é F7.
 * - Não decide a taxonomia da onda 2 (retenção/receita) — só aquisição.
 *
 * ## Armadilhas medidas que este módulo resolve por construção
 *
 * 1. **`utm_source=linkedin*` é ambíguo, e `(source, medium)` sozinho NÃO
 *    resolve.** `CHANNEL_KEY_SPECS` lista as chaves LinkedIn como pagas, mas
 *    nenhuma campanha rodou (`spend.csv` tem só a linha placeholder R$0).
 *    Enquanto a spec LinkedIn não tiver gasto > 0, todo `utm_source` com
 *    prefixo `linkedin` é `organico` — resolvido aqui excluindo a spec
 *    "LinkedIn" do matching de `pago` (nunca casa, decisão explícita, não
 *    efeito colateral da ordem das regras).
 * 2. **`utm_medium=referral` rotula o maior canal pago não-boost.**
 *    `android.googlequicksearchbox` (PMax) tem `utm_medium=referral` no
 *    snapshot — por isso `pago` nunca usa `utm_medium === "referral"` como
 *    sinal; usa o match de `CHANNEL_KEY_SPECS` (que já cobre PMax) e
 *    `utm_medium ∈ {cpc, paid_social}` (os 2 valores que os 3 braços de
 *    `PREFLIGHT_UTM_ARMS` realmente emitem).
 * 3. **`utm_source=brevo-diaria`/`sendinblue` é REATIVAÇÃO, não aquisição.**
 *    `activateSubscription`/`promoteBeehiivSubscription` fazem DELETE+CREATE
 *    e o CREATE sobrescreve a atribuição original — se orgânico fosse
 *    resíduo, a meta seria batida com gente que já era da base. `reativacao`
 *    casa ANTES de `organico`/`indeterminado` conseguirem ver esses valores.
 * 4. **`utm_channel` resolve o histórico e não existe na série viva.** No
 *    corpus histórico ele separa `boost`/`boost_send`/`boost_direct_link`/
 *    `recommendation` de `website`/`api`; nenhum worker vivo o escreve. A
 *    cláusula (a) de `iniciativa` cobre o histórico; a cláusula (b) (catálogo
 *    de `utm_source`) cobre a série viva, que não tem `utm_channel`.
 *
 * **Boost é `iniciativa`, não `pago` — decisão explícita.** `pago` cobre
 * mídia comprada em leilão (CAC por clique faz sentido); boost é compra de
 * audiência de parceiro, contabilizada por FAIXA estimada em
 * `scripts/lib/cac.ts` (`computeBoostRange`), nunca por `CHANNEL_KEY_SPECS`.
 * A linha `pago` do painel não é o gasto total — boost aparece sob
 * `iniciativa`.
 */

import { normalizeKey, resolveGroupKey, filterWindow, type CohortWindow } from "../shared/attribution-keys.ts";
import { CHANNEL_KEY_SPECS, type ChannelKeySpec } from "../shared/channel-key-specs.ts";
import { PREFLIGHT_UTM_ARMS } from "../preflight-utm-arms.ts";

// ---------------------------------------------------------------------------
// Taxonomia
// ---------------------------------------------------------------------------

/** As 5 classes exclusivas (decisão do editor, #7172, 02/09/2026). */
export type AcquisitionClass = "pago" | "reativacao" | "iniciativa" | "organico" | "indeterminado";

/**
 * O placar da meta de 5/dia (`não-pago e não-reativação`, decisão 1 do
 * #7172) = `organico + iniciativa`. Símbolo nomeado — F4 (registry) e F6
 * (painel) leem daqui em vez de somar as duas classes na tela cada um do seu
 * jeito, que é exatamente como a definição da meta divergiria de si mesma.
 * @pure
 */
export const NAO_PAGO_NAO_REATIVACAO: readonly AcquisitionClass[] = ["organico", "iniciativa"];

/** `true` se a classe conta para o placar da meta de ativação. @pure */
export function isNaoPagoNaoReativacao(cls: AcquisitionClass): boolean {
  return (NAO_PAGO_NAO_REATIVACAO as readonly AcquisitionClass[]).includes(cls);
}

// ---------------------------------------------------------------------------
// Guard de chave duplicada — nunca a mesma chave normalizada em duas classes
// ---------------------------------------------------------------------------

/** `utm_source` de REATIVAÇÃO — `activateSubscription`/`promoteBeehiivSubscription`
 *  fazem DELETE+CREATE e sobrescrevem a atribuição original com estes valores. */
export const REATIVACAO_UTM_SOURCES: readonly string[] = ["brevo-diaria", "sendinblue"];

/** `utm_channel` que sinaliza `iniciativa` no corpus HISTÓRICO (armadilha 4)
 *  — nenhum worker vivo escreve `utm_channel`, então esta cláusula só casa
 *  em dados vindos do backfill Beehiiv (F7), nunca na série viva. */
export const INICIATIVA_UTM_CHANNELS: readonly string[] = [
  "boost",
  "boost_send",
  "boost_direct_link",
  "recommendation",
];

/**
 * Catálogo NOMEADO de `utm_source` de `iniciativa` — cobre a série VIVA, que
 * não tem `utm_channel` (armadilha 4). Nunca regex solta sobre domínio de
 * parceiro (a lista de domínios de boost muda a cada parceria) — só valores
 * explícitos e estáveis: `clarice`/`clarice-email` (espaço editorial de
 * outro produto nosso, decisão 6 do #7172) e `sparkloop-upscribe` (parceria
 * de aquisição via SparkLoop/Upscribe). Estender esta lista quando uma nova
 * iniciativa nomeada (cross-promo, artigo em veículo, Creator Network)
 * ganhar `utm_source` próprio — nunca um match genérico.
 */
export const INICIATIVA_UTM_SOURCE_CATALOG: readonly string[] = [
  "clarice",
  "clarice-email",
  "sparkloop-upscribe",
];

/** `utm_channel` que sinaliza cadastro que NÃO É AQUISIÇÃO — nunca cai em
 *  `organico` por omissão. Inclui as fontes internas medidas no snapshot de
 *  30/08 com 1-2 registros cada. */
export const NAO_AQUISICAO_UTM_CHANNELS: readonly string[] = ["import", "api"];

/** `utm_source`/marcadores internos que nunca são aquisição real — mesma
 *  disciplina do item acima, valores medidos no snapshot de 30/08. */
export const NAO_AQUISICAO_UTM_SOURCES: readonly string[] = [
  "internal",
  "seed-inbox",
  "invitation",
  "eia-standalone",
  "dm",
  "office.net",
  "qrscan.code",
  "livros",
];

/**
 * `utm_medium` que sinaliza tráfego PAGO em leilão — os 2 valores que os 3
 * braços de `PREFLIGHT_UTM_ARMS` (google-ads/microsoft-ads/meta-ads)
 * realmente emitem (`cpc` para Google/Microsoft, `paid_social` para Meta).
 * Deriva de `PREFLIGHT_UTM_ARMS` em vez de repetir a lista pela 3ª vez.
 */
const PAID_UTM_MEDIA: readonly string[] = [...new Set(PREFLIGHT_UTM_ARMS.map((arm) => arm.utm_medium))];

/**
 * Lança se a mesma chave normalizada aparecer em duas classes diferentes —
 * chave declarada em duas classes é erro de configuração em tempo de carga,
 * nunca classificação silenciosa. Roda no load do módulo. @pure
 */
export function assertNoDuplicateClassKeys(): void {
  const seen = new Map<string, string>();
  const register = (raw: string, cls: string) => {
    const key = normalizeKey(raw);
    const prev = seen.get(key);
    if (prev && prev !== cls) {
      throw new Error(
        `[acquisition-class] chave "${key}" declarada em duas classes: "${prev}" e "${cls}" — ` +
          `classificação silenciosa não é aceitável, corrigir uma das listas.`,
      );
    }
    seen.set(key, cls);
  };
  for (const s of REATIVACAO_UTM_SOURCES) register(s, "reativacao");
  for (const s of INICIATIVA_UTM_SOURCE_CATALOG) register(s, "iniciativa");
  for (const s of NAO_AQUISICAO_UTM_SOURCES) register(s, "indeterminado");
}
assertNoDuplicateClassKeys();

// ---------------------------------------------------------------------------
// Input + adaptadores por plataforma
// ---------------------------------------------------------------------------

/**
 * Tupla de atribuição normalizada que `classifyAcquisition` consome. `input`
 * aceita os campos como eles existem em CADA plataforma via um adaptador —
 * a função de decisão é uma só. `created` é OBRIGATÓRIO (epoch em segundos,
 * como o snapshot Beehiiv grava) — sem ele, specs `ambigua: true` (ex:
 * `google.com`) não podem respeitar a janela e classificar cairia no erro
 * central que este módulo existe pra evitar.
 */
export interface AcquisitionClassInput {
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_channel?: string | null;
  referring_site?: string | null;
  /** Epoch em segundos (UTC) do cadastro. Obrigatório. */
  created: number;
}

/** Adapta um registro Beehiiv (snapshot local) para `AcquisitionClassInput`. @pure */
export function adaptBeehiivAttribution(sub: {
  utm_source?: string | null;
  referring_site?: string | null;
  utm_channel?: string | null;
  utm_medium?: string | null;
  created?: number | null;
}): AcquisitionClassInput {
  if (typeof sub.created !== "number") {
    throw new Error("adaptBeehiivAttribution: registro sem `created` — classe de aquisição exige data de cadastro");
  }
  return {
    utm_source: sub.utm_source ?? null,
    utm_medium: sub.utm_medium ?? null,
    utm_channel: sub.utm_channel ?? null,
    referring_site: sub.referring_site ?? null,
    created: sub.created,
  };
}

/**
 * Adapta um registro Kit (`fields` custom fields) para
 * `AcquisitionClassInput`. Declara explicitamente: `utm_channel` chega
 * AUSENTE fora dos registros vindos do backfill Beehiiv (`kit-attribution.ts`)
 * — a série viva do Kit não escreve esse campo (armadilha 4). @pure
 */
export function adaptKitAttribution(sub: {
  fields?: {
    utm_source?: string | null;
    utm_medium?: string | null;
    utm_channel?: string | null;
    referring_site?: string | null;
  } | null;
  created_at?: string | null;
  createdEpochSeconds?: number | null;
}): AcquisitionClassInput {
  const created =
    typeof sub.createdEpochSeconds === "number"
      ? sub.createdEpochSeconds
      : sub.created_at
        ? Math.floor(new Date(sub.created_at).getTime() / 1000)
        : null;
  if (created == null || Number.isNaN(created)) {
    throw new Error("adaptKitAttribution: registro sem created_at/createdEpochSeconds válido");
  }
  const fields = sub.fields ?? {};
  return {
    utm_source: fields.utm_source ?? null,
    utm_medium: fields.utm_medium ?? null,
    // Ausente na série viva (nenhum worker escreve) — só presente em
    // registros vindos do backfill Beehiiv. Nunca inventar valor.
    utm_channel: fields.utm_channel ?? null,
    referring_site: fields.referring_site ?? null,
    created,
  };
}

// ---------------------------------------------------------------------------
// classifyAcquisition — a função central
// ---------------------------------------------------------------------------

/** Specs de `CHANNEL_KEY_SPECS` elegíveis pra `pago` — exclui explicitamente
 *  a spec "LinkedIn" enquanto ela não tiver gasto > 0 em `spend.csv`
 *  (armadilha 1, decisão explícita, não efeito colateral de ordem). */
function isEligibleForPaidMatch(spec: ChannelKeySpec): boolean {
  return spec.canal !== "LinkedIn";
}

/** `true` se `created` cai dentro da janela (fechada) da spec, quando houver. @pure */
function withinSpecWindow(created: number, janela: CohortWindow | undefined): boolean {
  if (!janela) return true;
  const filtered = filterWindow([{ created }], janela);
  return filtered.length === 1;
}

/**
 * Classifica UMA tupla de atribuição nas 5 classes exclusivas. Primeira
 * regra que casa vence.
 *
 * @pure
 */
export function classifyAcquisition(input: AcquisitionClassInput): AcquisitionClass {
  const source = normalizeKey(input.utm_source);
  const medium = normalizeKey(input.utm_medium);
  const channel = normalizeKey(input.utm_channel);
  const groupKey = resolveGroupKey({ utm_source: input.utm_source, referring_site: input.referring_site });

  // 1. pago — casa uma spec de CHANNEL_KEY_SPECS (respeitando ambigua/janela,
  //    e excluindo LinkedIn enquanto não houver gasto real) OU utm_medium
  //    de leilão (cpc/paid_social).
  for (const spec of CHANNEL_KEY_SPECS) {
    if (!isEligibleForPaidMatch(spec)) continue;
    const keySet = new Set(spec.keys.map(normalizeKey));
    if (!keySet.has(groupKey)) continue;
    if (spec.ambigua) {
      if (withinSpecWindow(input.created, spec.janela)) return "pago";
      continue; // ambígua fora da janela: segue para as regras seguintes, não vira `pago`
    }
    return "pago";
  }
  if (medium !== "__none__" && PAID_UTM_MEDIA.includes(input.utm_medium ?? "")) return "pago";

  // 2. reativacao — utm_source ∈ {brevo-diaria, sendinblue}.
  if (REATIVACAO_UTM_SOURCES.includes(source)) return "reativacao";

  // 3. iniciativa — sinal mecânico antes de catálogo.
  if (INICIATIVA_UTM_CHANNELS.includes(channel)) return "iniciativa";
  if (INICIATIVA_UTM_SOURCE_CATALOG.includes(source)) return "iniciativa";

  // 4. indeterminado — cadastro que não é aquisição (import/api, fontes internas).
  if (NAO_AQUISICAO_UTM_CHANNELS.includes(channel)) return "indeterminado";
  if (NAO_AQUISICAO_UTM_SOURCES.includes(source)) return "indeterminado";

  // 5. organico — todo utm_source com prefixo "linkedin" (enquanto a spec
  //    LinkedIn não tiver gasto real), mais qualquer outro sinal positivo
  //    de origem (source ou referring_site presentes e não capturados acima).
  if (source.startsWith("linkedin") || groupKey.startsWith("linkedin")) return "organico";
  if (groupKey !== "__none__") return "organico";

  // direct puro / utm_source vazio e sem referring_site: sem sinal positivo.
  return "indeterminado";
}
