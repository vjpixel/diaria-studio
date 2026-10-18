/**
 * kit-test-broadcast.ts (#10395, caminho 5 da avaliação da #10307)
 *
 * Fonte única da pergunta "este broadcast do Kit é um envio de TESTE, não uma
 * edição?". Até aqui cada consumidor de `list_broadcasts`/cache Kit respondia
 * por conta própria — `title.startsWith("[teste]")` (`generate-hub-sources.ts`,
 * #8699), piso de `recipients` (`click-window-resolution.ts`, #7637), título
 * começando com `[` (`annual-collect.ts`), nada (`reconcile-send-audiences.ts`
 * pegava o broadcast `completed` mais recente, que pode ser o test-send de 1
 * destinatário).
 *
 * **Por que o problema existe:** a API v4 do Kit não tem endpoint de teste. O
 * fallback `publish-newsletter-kit.ts --send-test` cria um broadcast SEPARADO e
 * descartável, escopado à tag `diaria-test-email`, que vira `completed` e não
 * pode mais ser apagado (422). O caminho preferido desde o #10395 (Send test
 * da UI, via Claude in Chrome) não cria broadcast nenhum; este helper existe
 * pro fallback (servidor `300`, Chrome indisponível) e pro histórico já
 * acumulado.
 *
 * **Três sinais, qualquer um basta (OR):**
 * 1. `id` registrado em `test_broadcast_ids` de algum
 *    `_internal/newsletter-kit-published.json` — o mais forte, mas só existe
 *    pra quem tem a edição em disco;
 * 2. assunto (ou `title`, que no cache unificado É o `subject` do Kit —
 *    `normalizeKitBroadcast`) começando com `[teste]` ou `[teste-…]` — o
 *    prefixo que o `--send-test` grava;
 * 3. `subscriber_filter` restrito SÓ a tag(s) de teste (ids resolvidos em
 *    runtime por `resolveTestSendTagId`, nunca hardcoded — o id é por conta).
 *
 * Nenhum sinal olha `public` (a medição do #7637 derrubou: edição real da rampa
 * saiu `public: false`) nem `recipients` (quem quiser o piso continua com o
 * dele — este helper soma, não substitui).
 */

/** Prefixo de assunto que `publish-newsletter-kit.ts --send-test` grava. */
export const KIT_TEST_SUBJECT_PREFIX = "[teste]";

/**
 * `[teste]` e as variantes de probe já vistas no cache (`[teste-464]`).
 * Não casa `[testemunho]` nem "teste" sem colchete no meio do assunto.
 */
const TEST_SUBJECT_RE = /^\s*\[teste(?:\]|-[^\]]*\])/i;

/** Campos que algum produtor (resumo REST, detalhe, cache unificado) tem. */
export interface KitBroadcastIdentity {
  id?: number | string | null;
  subject?: string | null;
  /** No cache unificado, `title` do Kit = `subject` (`normalizeKitBroadcast`). */
  title?: string | null;
  subscriber_filter?: unknown;
}

export interface KitTestBroadcastSignals {
  /** Ids de `test_broadcast_ids` de `newsletter-kit-published.json`. */
  testBroadcastIds?: Iterable<number | string>;
  /** Id(s) da tag `diaria-test-email` (por conta, resolvido em runtime). */
  testTagIds?: Iterable<number>;
}

/** @pure */
export function hasKitTestSubjectPrefix(subject: string | null | undefined): boolean {
  return typeof subject === "string" && TEST_SUBJECT_RE.test(subject);
}

/**
 * `true` só quando o filtro tem ao menos uma condição e TODAS são `tag` com
 * ids exclusivamente de teste. Filtro vazio (`[]` = base inteira, #6126) ou
 * qualquer condição fora disso → `false`.
 *
 * @pure
 */
export function filterTargetsOnlyTestTags(filter: unknown, testTagIds: Iterable<number>): boolean {
  const allowed = new Set(testTagIds);
  if (allowed.size === 0 || !Array.isArray(filter) || filter.length === 0) return false;
  let conditions = 0;
  for (const group of filter) {
    if (typeof group !== "object" || group === null) return false;
    const all = (group as { all?: unknown }).all;
    if (!Array.isArray(all) || all.length === 0) return false;
    for (const cond of all) {
      if (typeof cond !== "object" || cond === null) return false;
      const { type, ids } = cond as { type?: unknown; ids?: unknown };
      if (type !== "tag" || !Array.isArray(ids) || ids.length === 0) return false;
      if (!ids.every((id) => typeof id === "number" && allowed.has(id))) return false;
      conditions++;
    }
  }
  return conditions > 0;
}

/**
 * `true` quando o broadcast é envio de teste por qualquer um dos três sinais
 * (ver docstring do módulo).
 *
 * @pure
 */
export function isKitTestBroadcast(b: KitBroadcastIdentity, signals: KitTestBroadcastSignals = {}): boolean {
  if (b.id !== undefined && b.id !== null && signals.testBroadcastIds) {
    const target = String(b.id);
    for (const id of signals.testBroadcastIds) if (String(id) === target) return true;
  }
  if (hasKitTestSubjectPrefix(b.subject) || hasKitTestSubjectPrefix(b.title)) return true;
  if (signals.testTagIds && filterTargetsOnlyTestTags(b.subscriber_filter, signals.testTagIds)) return true;
  return false;
}
