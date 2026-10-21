/**
 * scripts/lib/metrics/acquisition-class.ts (#7173, fatia 1 do épico #7172)
 *
 * Taxonomia canônica de classe de aquisição — 6 valores exclusivos (5 até o
 * #10735, que separou `rede`), primeira
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
 *    prefixo `linkedin` é não-pago (`rede` desde o #10735; era `organico`
 *    antes) — resolvido aqui excluindo a spec
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
import {
  LIVROS_INLINE_UTM,
  CURSOS_GATE_INLINE_UTM,
  ARQUIVO_INLINE_UTM,
  HUB_INLINE_UTM,
  EIA_STANDALONE_SOURCE,
  DIARIA_APEX_SOURCE,
} from "../shared/utm-registry.ts";

// ---------------------------------------------------------------------------
// Taxonomia
// ---------------------------------------------------------------------------

/** As 6 classes exclusivas (decisão do editor, #7172, 02/09/2026; `rede`
 *  separada de `organico`/`indeterminado` no #10735, 21/10/2026). */
export type AcquisitionClass = "pago" | "reativacao" | "iniciativa" | "rede" | "organico" | "indeterminado";

/**
 * Todas as classes, na ordem de exibição — fonte única pra quem precisa
 * enumerá-las (contadores zerados por classe, tabelas). Travado contra o
 * union por `test/acquisition-class.test.ts`.
 */
export const ACQUISITION_CLASSES: readonly AcquisitionClass[] = [
  "pago",
  "reativacao",
  "iniciativa",
  "rede",
  "organico",
  "indeterminado",
];

/** Contador zerado por classe — evita que cada consumidor repita o literal
 *  (e esqueça uma classe nova, que foi o risco do #10735). @pure */
export function emptyAcquisitionClassCounts(): Record<AcquisitionClass, number> {
  return Object.fromEntries(ACQUISITION_CLASSES.map((c) => [c, 0])) as Record<AcquisitionClass, number>;
}

/**
 * O placar da meta de 5/dia (`não-pago e não-reativação`, decisão 1 do
 * #7172) = `organico + iniciativa + rede`. `rede` (#10735) entra no placar
 * porque é não-paga e não-reativação por definição — e porque `direct` e
 * `linkedin`, que a compõem, já contavam no placar como `organico` antes da
 * separação (o placar não encolhe por causa de uma mudança de rótulo). Símbolo nomeado — F4 (registry) e F6
 * (painel) leem daqui em vez de somar as duas classes na tela cada um do seu
 * jeito, que é exatamente como a definição da meta divergiria de si mesma.
 * @pure
 */
export const NAO_PAGO_NAO_REATIVACAO: readonly AcquisitionClass[] = ["organico", "iniciativa", "rede"];

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
 *  30/08 com 1-2 registros cada. `import` saiu daqui no #10735 — é cadastro
 *  da rede do editor (`REDE_UTM_CHANNELS`), não sistema. */
export const NAO_AQUISICAO_UTM_CHANNELS: readonly string[] = ["api"];

/**
 * Classe `rede` (#10735): cadastro vindo da rede pessoal do editor — quem
 * chega por ele, não por descoberta fria. Na análise de LTV por origem de
 * 21/10/2026 esses cadastros tiveram LTV de R$ 31–36 contra R$ 2–3 do
 * orgânico frio e do pago, e concentram os apoiadores do apoia.se — misturá-
 * los em `organico` (direct/linkedin) ou `indeterminado` (import) apagava a
 * diferença. Três sinais, todos explícitos:
 * - `utm_channel = import` (`REDE_UTM_CHANNELS`) — contato importado pelo
 *   editor. O import EM MASSA da migração Beehiiv→Kit já sai antes, por dia
 *   (`KIT_IMPORT_DAY` em `registry.ts`), não por esta regra;
 * - `utm_source = direct` (`REDE_UTM_SOURCES`) — o literal que a plataforma
 *   grava pra quem digitou/colou o link (`utm-canonical.ts`, classe
 *   `"direct"`). Direct PURO (sem `utm_source` nem `referring_site`) NÃO é
 *   rede: sem sinal nenhum, segue `indeterminado`;
 * - `utm_source`/grupo com prefixo `linkedin` — os posts do editor. Enquanto
 *   a spec "LinkedIn" de `CHANNEL_KEY_SPECS` não tiver gasto (armadilha 1),
 *   nunca é `pago`; se um dia tiver, `pago` casa antes (regra 1).
 */
export const REDE_UTM_CHANNELS: readonly string[] = ["import"];
export const REDE_UTM_SOURCES: readonly string[] = ["direct"];
/** Prefixo de `utm_source`/grupo que classifica como `rede` (ver acima). */
export const REDE_UTM_SOURCE_PREFIX = "linkedin";

/** `utm_source`/marcadores internos que nunca são aquisição real — mesma
 *  disciplina do item acima, valores medidos no snapshot de 30/08.
 *
 *  `eia-standalone` e `livros` NÃO entram mais aqui (#8244) — os dois são
 *  superfície de cadastro PRÓPRIA (formulário real do nosso site), não
 *  marcador interno/de sistema. A #7173 os colocou aqui a partir de uma
 *  amostra só de conta de teste na janela medida (30/08) — conta de teste
 *  continua saindo por `filterInternalAndTestSubscribers`/
 *  `TEST_ACCOUNT_PATTERNS` (`scripts/lib/cohorts.ts`), nunca por bloqueio da
 *  superfície inteira. Ver `SUPERFICIE_PROPRIA_UTM_SOURCES` abaixo. */
export const NAO_AQUISICAO_UTM_SOURCES: readonly string[] = [
  "internal",
  "seed-inbox",
  "invitation",
  "dm",
  "office.net",
  "qrscan.code",
];

/**
 * Catálogo NOMEADO de `utm_source` das superfícies de cadastro PRÓPRIAS do
 * projeto (#8244) — páginas nossas (livros, cursos, arquivo, hubs, jogo "É
 * IA?" standalone, apex) que a regra genérica (5, `organico` por qualquer
 * sinal positivo) já classificava certo por acaso, ou que a lista acima
 * classificava errado como `indeterminado`. Esta regra torna a decisão
 * EXPLÍCITA em vez de acidental — mesma disciplina de
 * `INICIATIVA_UTM_SOURCE_CATALOG` acima.
 *
 * Monta-se sempre a partir das constantes de `utm-registry.ts` (nunca
 * literal solto) — se um emissor mudar o `source` que grava, este catálogo
 * segue automaticamente, sem precisar de uma 2ª edição aqui.
 *
 * Classe = `organico`, não `iniciativa`: `iniciativa` é audiência de
 * PARCEIRO ou de outro produto nosso (Clarice, boost, SparkLoop);
 * `SUPERFICIE_PROPRIA_UTM_SOURCES` é tráfego que chegou numa página NOSSA
 * (mesma natureza do apex). O placar (`organico + iniciativa + rede`) sai igual
 * nas duas leituras — só muda o "orgânico estrito".
 */
export const SUPERFICIE_PROPRIA_UTM_SOURCES: readonly string[] = [
  LIVROS_INLINE_UTM.source,
  CURSOS_GATE_INLINE_UTM.source,
  ARQUIVO_INLINE_UTM.source,
  HUB_INLINE_UTM.source,
  EIA_STANDALONE_SOURCE,
  DIARIA_APEX_SOURCE,
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
 * nunca classificação silenciosa.
 *
 * Aceita `groups` opcional (default = as listas reais do módulo, chamada
 * sem argumento no load) exatamente pelo mesmo motivo de
 * `assertValidChannelKeySpecs(specs)` em `shared/channel-key-specs.ts`
 * aceitar `specs` como parâmetro em vez de ler `CHANNEL_KEY_SPECS` direto:
 * testável com fixture inválida sem precisar quebrar o import do módulo
 * real (molde de `test/cac.test.ts`). Cobre as 3 listas de `utm_source`
 * (`REATIVACAO_UTM_SOURCES`/`INICIATIVA_UTM_SOURCE_CATALOG`/
 * `NAO_AQUISICAO_UTM_SOURCES`) — as 2 listas de `utm_channel`
 * (`INICIATIVA_UTM_CHANNELS`/`NAO_AQUISICAO_UTM_CHANNELS`) não colidem hoje
 * e não têm nenhum valor em comum com as listas de source por construção
 * (namespaces disjuntos: um é `utm_channel`, outro é `utm_source`), então
 * ficam fora deste guard — se um dia um valor precisar aparecer nas duas
 * dimensões, é aí que este guard precisa crescer.
 *
 * @pure
 */
export function assertNoDuplicateClassKeys(
  groups: ReadonlyArray<{ keys: readonly string[]; cls: string }> = [
    { keys: REATIVACAO_UTM_SOURCES, cls: "reativacao" },
    { keys: INICIATIVA_UTM_SOURCE_CATALOG, cls: "iniciativa" },
    { keys: SUPERFICIE_PROPRIA_UTM_SOURCES, cls: "organico" },
    { keys: NAO_AQUISICAO_UTM_SOURCES, cls: "indeterminado" },
    { keys: REDE_UTM_SOURCES, cls: "rede" },
  ],
): void {
  const seen = new Map<string, string>();
  for (const group of groups) {
    for (const raw of group.keys) {
      const key = normalizeKey(raw);
      const prev = seen.get(key);
      if (prev && prev !== group.cls) {
        throw new Error(
          `[acquisition-class] chave "${key}" declarada em duas classes: "${prev}" e "${group.cls}" — ` +
            `classificação silenciosa não é aceitável, corrigir uma das listas.`,
        );
      }
      seen.set(key, group.cls);
    }
  }
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
 * Classifica UMA tupla de atribuição nas 6 classes exclusivas. Primeira
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
  if (medium !== "__none__" && PAID_UTM_MEDIA.includes(medium)) return "pago";

  // 2. reativacao — utm_source ∈ {brevo-diaria, sendinblue}.
  if (REATIVACAO_UTM_SOURCES.includes(source)) return "reativacao";

  // 3. iniciativa — sinal mecânico antes de catálogo.
  if (INICIATIVA_UTM_CHANNELS.includes(channel)) return "iniciativa";
  if (INICIATIVA_UTM_SOURCE_CATALOG.includes(source)) return "iniciativa";

  // 4. organico (explícito) — superfície de cadastro PRÓPRIA (#8244): livros,
  //    cursos, arquivo, hubs, jogo "É IA?" standalone, apex. Decidido ANTES da
  //    regra 5 genérica (que chegaria na mesma resposta por acaso) e ANTES de
  //    `indeterminado` (que classificava `livros`/`eia-standalone` errado até
  //    o #8244 — ver a nota em `NAO_AQUISICAO_UTM_SOURCES`).
  if (SUPERFICIE_PROPRIA_UTM_SOURCES.includes(source)) return "organico";

  // 5. indeterminado — cadastro que não é aquisição (api, fontes internas).
  //    Antes de `rede`: um `utm_source` interno nunca vira rede só porque o
  //    registro também traz `utm_channel=import`.
  if (NAO_AQUISICAO_UTM_CHANNELS.includes(channel)) return "indeterminado";
  if (NAO_AQUISICAO_UTM_SOURCES.includes(source)) return "indeterminado";

  // 6. rede (#10735) — rede pessoal do editor: utm_channel=import,
  //    utm_source=direct, ou prefixo "linkedin" (enquanto a spec LinkedIn não
  //    tiver gasto real — com gasto, a regra 1 casa antes). Ver
  //    `REDE_UTM_CHANNELS`.
  if (REDE_UTM_CHANNELS.includes(channel)) return "rede";
  if (REDE_UTM_SOURCES.includes(source)) return "rede";
  if (source.startsWith(REDE_UTM_SOURCE_PREFIX) || groupKey.startsWith(REDE_UTM_SOURCE_PREFIX)) return "rede";

  // 7. organico — qualquer outro sinal positivo de origem (source ou
  //    referring_site presentes e não capturados acima).
  if (groupKey !== "__none__") return "organico";

  // direct puro / utm_source vazio e sem referring_site: sem sinal positivo.
  return "indeterminado";
}
