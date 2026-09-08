/**
 * click-window-resolution.ts (#7637)
 *
 * Resolução "qual post do cache representa a edição do dia X" — a peça que
 * as DUAS skills semanais (`/diaria-linkedin-semanal` via
 * `weekly-linkedin-clicks.ts`, `/diaria-instagram-semanal` via
 * `weekly-instagram-select.ts`) usam pra cruzar candidatos de
 * `02-reviewed.md` com cliques reais.
 *
 * **Por que existe:** até o #7637 cada um dos dois módulos carregava a SUA
 * cópia byte-a-byte de `matchPostsToWindow`/`aammddFromEpochSeconds`, sem
 * razão declarada em nenhum dos dois. O #6185 (leitura unificada
 * Beehiiv+Kit) já tinha precisado ser aplicado duas vezes, em paralelo, "no
 * mesmo PR" — e o defeito que o #7637 corrigiu estava, previsivelmente, nas
 * duas. Os dois módulos re-exportam daqui, então todo caller existente
 * continua importando do mesmo lugar de sempre.
 *
 * **O que NÃO mora aqui:** a leitura de cliques por link
 * (`clickCountsForUrl`) e o manifest de enriquecimento via MCP
 * (`identify*PostsNeedingClicks`) continuam em cada módulo — o primeiro
 * porque o shape de `stats.clicks` diverge entre os dois (ver
 * `ClickWindowPostBase` abaixo), o segundo porque é Beehiiv-only de
 * propósito (o Kit é REST comum, sem enriquecimento assíncrono a esperar).
 */

import type { EditionOrigin } from "./edition-cache-reader.ts";

/**
 * Campos que a RESOLUÇÃO por data precisa — deliberadamente sem `stats`.
 * `matchPostsToWindow` nunca lê cliques; quem lê são as funções de ranking
 * de cada módulo, e o shape de `stats.clicks` diverge entre eles
 * (`weekly-linkedin-clicks.ts` usa `ClickCacheRow` de
 * `click-cache-completeness.ts`; `weekly-instagram-select.ts` declara um
 * shape próprio mais estreito). Cada módulo estende esta interface com o
 * `stats` que é dele — e `UnifiedCachedPost`
 * (`scripts/lib/shared/edition-cache-reader.ts`) satisfaz as duas
 * estruturalmente, sem cast.
 */
export interface ClickWindowPostBase {
  status?: string;
  publish_date?: number | null; // epoch seconds
  /**
   * Origem da edição (#7637). Só o caminho unificado preenche
   * (`UnifiedCachedPost.origin`); o caminho Beehiiv-only (`BeehiivCachePost`,
   * usado pelos manifests de enriquecimento via MCP) deixa `undefined` e o
   * desempate por origem vira no-op — ver `matchPostsToWindow`.
   */
  origin?: EditionOrigin;
  /**
   * Tamanho da entrega (#6186 — `KitBroadcastStats.recipients`, passthrough
   * do Beehiiv do outro lado). É ISTO que separa test-send de edição real,
   * **não** `public` — ver `MIN_REAL_DELIVERY_RECIPIENTS`.
   */
  stats?: { email?: { recipients?: number } };
}

/** Pure: `epoch seconds` → `AAMMDD` local. */
export function aammddFromEpochSeconds(epochSec: number): string {
  const d = new Date(epochSec * 1000);
  const yy = String(d.getFullYear() % 100).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/**
 * Precedência de origem no desempate da mesma data (#7637). Número MAIOR
 * vence. Kit acima de Beehiiv porque a migração de envio fechou em
 * 04/09/2026 (#7388/#7386, Beehiiv 317→0 ativos): a partir dali todo post
 * Beehiiv da janela é arquivo público de um canal que não entrega e-mail
 * nenhum, e os cliques das duas origens NÃO são comparáveis (medido na
 * janela `26w36`, 08/09/2026: 24 vs 38 linhas de clique no mesmo dia).
 * Origem ausente (`undefined`, caminho Beehiiv-only) cai no piso e o
 * desempate volta a ser só por `publish_date` — comportamento pré-#7637
 * preservado pra esse caminho.
 */
const ORIGIN_PRECEDENCE: Record<EditionOrigin, number> = { kit: 2, beehiiv: 1 };

function originRank(post: ClickWindowPostBase): number {
  return post.origin === undefined ? 0 : ORIGIN_PRECEDENCE[post.origin];
}

/**
 * Piso de entrega abaixo do qual um broadcast é test-send, não edição
 * (#7637). O `review-test-email` do Stage 5 dispara pro
 * `publishing.newsletter.test_email` — 1 destinatário (medido: o `[teste]`
 * de 260904 saiu com `recipients: 1`, contra 630 da edição real do mesmo
 * dia). O piso é 10 e não 2 de propósito: é uma FAIXA vazia, não uma
 * fronteira apertada — nenhuma edição real da diária jamais teve menos de
 * dezenas de destinatários (a menor onda da rampa Kit teve 280), e um
 * test-send pra 2-3 endereços continua sendo teste.
 *
 * **Por que não `public` (a tentativa que a medição derrubou):** `public:
 * false` NÃO significa "não é edição real". Medido na janela `26w36`: as
 * edições 260831–260903, todas reais e entregues a 280 pessoas na rampa
 * Kit, saíram `public: false` — filtrar por esse campo apagaria a semana
 * inteira. O `/diaria-mensal-apoiadores` inclusive exige `public: false`
 * num envio real de propósito (recompensa paga não vai pra web). O campo
 * discrimina "publicado na web", não "é edição".
 */
export const MIN_REAL_DELIVERY_RECIPIENTS = 10;

/**
 * Pure: `true` quando a entrega é grande o bastante pra ser edição, não
 * test-send.
 *
 * **`recipients` ausente NÃO significa a mesma coisa nas duas origens** —
 * por isso a checagem é origin-aware (achado do review da PR #7638,
 * verificado contra `normalizeKitBroadcast`):
 *
 * - **Kit sem NENHUMA agregação** (`stats.email` inteiro ausente): fica de
 *   fora. `normalizeKitBroadcast` popula os 4 campos de `stats.email`
 *   juntos, sob o mesmo gate `hasOpens` — então `email` ausente quer dizer
 *   que `kit-sync.ts` rodou antes de a Kit agregar as stats do envio.
 *   "Ausente" aí é **não sei**, e num broadcast que pode ser o test-send do
 *   `review-test-email` deixar entrar reabre exatamente o buraco que o
 *   #7637 fechou. Fora do mapa, a data cai no warning
 *   `editionsMissingClickData` que os dois callers já emitem — a falha
 *   BARULHENTA: o editor re-roda `kit-sync.ts` e a data volta.
 * - **Kit COM agregação mas sem `recipients`**: entra. Há evidência de que
 *   a Kit já fechou as stats; um `recipients` faltando aí é lacuna de campo
 *   (fixture, cache de versão anterior do normalizador), não corrida.
 * - **Beehiiv / origem ausente**: entra sempre. Aqui "ausente" quer dizer
 *   *cache velho, escrito antes de o campo existir* — não há corrida de
 *   agregação a perder (medido em 08/09/2026: `recipients` presente em
 *   265/265 posts do cache Beehiiv). Excluir por ausência apagaria o
 *   caminho Beehiiv-only (manifest de enriquecimento via MCP) inteiro.
 */
function isRealDelivery(post: ClickWindowPostBase): boolean {
  const recipients = post.stats?.email?.recipients;
  if (recipients === undefined) return post.origin !== "kit" || post.stats?.email !== undefined;
  return recipients >= MIN_REAL_DELIVERY_RECIPIENTS;
}

/**
 * Pure: mapa `AAMMDD → post` pros posts cacheados cujo `publish_date` cai
 * numa das datas de `windowDates` e `status === "confirmed"`.
 *
 * **Test-send nunca entra (#7637).** Um test-send do loop
 * `review-test-email` disparado DEPOIS da edição ganhava a vaga da data no
 * critério antigo (só `publish_date`), e a semana inteira passava a ranquear
 * pelos cliques do teste. Medido na janela `26w36`: o `[teste]` de 260904 só
 * perdeu porque saiu às 04:08 contra 09:02 do real. Discriminador é
 * `recipients`, ver `MIN_REAL_DELIVERY_RECIPIENTS`.
 *
 * **Desempate da mesma data, em ordem (#7637):** (1) origem, por
 * `ORIGIN_PRECEDENCE` — Kit vence Beehiiv, ver docstring acima; (2)
 * `publish_date` mais recente, dentro da mesma origem. Antes do #7637 só
 * existia (2), então em qualquer data com post nas DUAS origens o vencedor
 * era acidente de horário, não o canal que de fato entregou.
 */
export function matchPostsToWindow<T extends ClickWindowPostBase>(
  posts: T[],
  windowDates: string[],
): Map<string, T> {
  const windowSet = new Set(windowDates);
  const out = new Map<string, T>();
  for (const post of posts) {
    if (post.status !== "confirmed" || !post.publish_date) continue;
    if (!isRealDelivery(post)) continue;
    const date = aammddFromEpochSeconds(post.publish_date);
    if (!windowSet.has(date)) continue;
    const existing = out.get(date);
    if (!existing) {
      out.set(date, post);
      continue;
    }
    const existingRank = originRank(existing);
    const postRank = originRank(post);
    if (postRank !== existingRank) {
      if (postRank > existingRank) out.set(date, post);
      continue;
    }
    if ((existing.publish_date ?? 0) < post.publish_date) out.set(date, post);
  }
  return out;
}

/**
 * Data (AAMMDD) da 1ª edição enviada só pelo Kit —
 * `publishing.newsletter.backend` virou `"kit"` em 04/09/2026 (#7388) e a
 * base migrou em bloco (#7386, Beehiiv 317→0 ativos). A partir daqui um
 * post Beehiiv na janela é arquivo público de um canal que não entrega
 * e-mail: se ele vence a vaga da data, o ranking está contando clique de
 * ninguém.
 */
export const KIT_SEND_CUTOVER_AAMMDD = "260904";

/**
 * Pure (#7637): datas da janela que resolveram pra um post de origem
 * `beehiiv` mesmo sendo de/depois do cutover de envio — sinal de que o Kit
 * não tem post cacheado pra esse dia (`kit-sync.ts` não rodou, broadcast
 * ainda `scheduled`, `public:false`), e NÃO de que a Beehiiv "venceu" o
 * desempate: `matchPostsToWindow` já prefere Kit quando os dois existem.
 * Barulho em vez de número silenciosamente errado.
 */
export function detectPostCutoverBeehiivDates<T extends ClickWindowPostBase>(
  windowPosts: Map<string, T>,
): string[] {
  const out: string[] = [];
  for (const [date, post] of windowPosts) {
    if (date >= KIT_SEND_CUTOVER_AAMMDD && post.origin === "beehiiv") out.push(date);
  }
  return out.sort();
}

/**
 * Pure (#7637): datas em que as DUAS origens tiveram entrega real — a janela
 * de rampa Kit (~260817–260903), em que a mesma edição saiu pra base Beehiiv
 * legada E pro cohort Kit. `matchPostsToWindow` fica com o lado Kit (o maior
 * e mais representativo: em 260903, 129 aberturas contra 53), então metade
 * do sinal daquele dia não entra no ranking.
 *
 * **Não é bug — é o preço de não somar.** Somar as duas origens exigiria
 * casar linha de clique por URL entre vocabulários que não são
 * equivalentes: a Beehiiv distingue clique verificado de bruto
 * (bot-filtering), o Kit não tem esse conceito (#6185), então o total
 * somado seria uma métrica que nenhum dos dois lados reporta. A janela de
 * envio duplo já fechou (#7388) e não volta; o warning existe pra o editor
 * saber, ao auditar uma seleção DESSE período, que o número é de um canal
 * só. Fora dessa janela a lista sai sempre vazia.
 */
export function detectDualOriginDates<T extends ClickWindowPostBase>(
  posts: T[],
  windowDates: string[],
): string[] {
  const seen = new Map<string, Set<string>>();
  for (const post of posts) {
    if (post.status !== "confirmed" || !post.publish_date) continue;
    if (!isRealDelivery(post)) continue;
    if (post.origin === undefined) continue;
    const date = aammddFromEpochSeconds(post.publish_date);
    if (!windowDates.includes(date)) continue;
    if (!seen.has(date)) seen.set(date, new Set());
    seen.get(date)!.add(post.origin);
  }
  return [...seen.entries()].filter(([, origins]) => origins.size > 1).map(([date]) => date).sort();
}
