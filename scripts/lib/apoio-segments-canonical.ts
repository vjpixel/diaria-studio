/**
 * scripts/lib/apoio-segments-canonical.ts (#4436)
 *
 * Fonte única de verdade para as condições-ALVO dos 6 segmentos
 * `Apoio — {Amigo,Apoiador,Mantenedor,Patrono,Todos,Nenhum}` na Beehiiv.
 *
 * ## Por que isto existe
 *
 * Os 6 segmentos foram criados à mão em 260729 (#4273 parte 1) condicionando
 * em `subscriber_tag` — desenho refutado no mesmo dia (não existe escrita de
 * tag por assinante na API da Beehiiv, `PATCH .../subscriptions/{id}` com
 * `tags` responde 200 e ignora em silêncio). O mecanismo real é o custom
 * field `apoio_nivel` (id abaixo), escrito por
 * `scripts/sync-apoio-nivel-beehiiv.ts`. O desenho corrigido foi aplicado AO
 * VIVO pela UI da Beehiiv via Chrome em 260802 (#4436, autorização do
 * editor) — este módulo versiona no repo o que ficou salvo lá, pra que uma
 * futura mudança manual na UI seja detectável por drift check em vez de
 * silenciosamente divergir de novo (é exatamente o que aconteceu da 1ª vez).
 *
 * ## Formato do `where`
 *
 * As strings abaixo são EXATAMENTE o que `get_segment` (MCP Beehiiv) devolve
 * no campo `where` depois de salvo pela UI — não é uma sintaxe que nós
 * inventamos, é o dialeto de DSL que a própria Beehiiv normaliza ao persistir
 * a condição (custom field referenciado por ID, não por nome; operadores
 * `EXISTS`/`NOT EXISTS` em maiúsculas). Confirmado ao vivo em 260802 pra cada
 * um dos 6 segmentos (ver PR #4436 pra ANTES/DEPOIS completo).
 *
 * `isSegmentConverged` compara de forma tolerante a espaçamento e ORDEM das
 * cláusulas `AND` (a UI da Beehiiv não garante uma ordem estável ao
 * re-serializar — já observamos `status = 'active' AND custom_field(...)`
 * numa leitura e a ordem inversa em outra do mesmo tipo de condição) — nunca
 * comparação de string crua.
 */

/** Custom field `apoio_nivel` — criado manualmente pelo editor em 260729,
 * confirmado presente (#4273/#4436). Nenhum script deste repo cria o campo,
 * só lê/escreve o valor. */
export const APOIO_NIVEL_FIELD_ID = "e70e4347-a13e-4490-a641-4bfdd2aa37f7";

const FIELD = `custom_field('${APOIO_NIVEL_FIELD_ID}')`;

export interface CanonicalApoioSegment {
  /** Nome exato do segmento na Beehiiv — usado para casar contra `list_segments`/`get_segment`. */
  name: string;
  /** Condição-alvo, no dialeto que `get_segment` devolve (ver cabeçalho do módulo). */
  where: string;
}

/**
 * As 6 condições-alvo (#4436, corpo da issue + decisões do editor 260801/02):
 *   - 4 faixas: `apoio_nivel = '{nivel}' AND status = 'active'`.
 *   - Todos: união das 4 faixas — usa `EXISTS` em vez de 4 condições OR'd
 *     (equivalente, mais simples de auditar; `apoio_nivel` só assume um dos 4
 *     valores ou fica ausente, nunca outro string).
 *   - Nenhum: complemento exato de Todos (`NOT EXISTS`), restrito a ativos.
 */
export const APOIO_SEGMENTS_CANONICAL: readonly CanonicalApoioSegment[] = [
  { name: "Apoio — Amigo", where: `${FIELD} = 'amigo' AND status = 'active'` },
  { name: "Apoio — Apoiador", where: `${FIELD} = 'apoiador' AND status = 'active'` },
  { name: "Apoio — Mantenedor", where: `${FIELD} = 'mantenedor' AND status = 'active'` },
  { name: "Apoio — Patrono", where: `${FIELD} = 'patrono' AND status = 'active'` },
  { name: "Apoio — Todos", where: `status = 'active' AND ${FIELD} EXISTS` },
  { name: "Apoio — Nenhum", where: `status = 'active' AND ${FIELD} NOT EXISTS` },
] as const;

/**
 * Pure: normaliza uma cláusula `where` (só `AND` no topo — nenhum dos 6
 * segmentos usa `OR`/parênteses depois da correção de #4436) pra comparação
 * tolerante a espaçamento e ordem: cada sub-cláusula é trimada, espaços
 * internos colapsados, e a lista é ordenada antes de rejuntar. Não tenta
 * normalizar case de palavras-chave (`AND`/`EXISTS`) — a Beehiiv sempre
 * devolve maiúsculas, então isso seria over-engineering sem caso de uso real.
 */
export function normalizeWhereClause(where: string): string {
  return where
    .split(/\s+AND\s+/i)
    .map((clause) => clause.trim().replace(/\s+/g, " "))
    .filter((clause) => clause.length > 0)
    .sort()
    .join(" AND ");
}

/** Pure: `true` se as duas cláusulas são equivalentes módulo espaçamento/ordem. */
export function isSegmentConverged(liveWhere: string, canonicalWhere: string): boolean {
  return normalizeWhereClause(liveWhere) === normalizeWhereClause(canonicalWhere);
}

export interface SegmentDriftEntry {
  name: string;
  /** `where` lido ao vivo da Beehiiv (`get_segment`), ou `null` se o segmento
   * não foi encontrado na lista live (nome não bate — reportar como drift). */
  live: string | null;
  canonical: string;
  converged: boolean;
}

/**
 * Pure: compara o `where` de cada segmento CANÔNICO contra o estado ao vivo
 * (`liveSegments`, tipicamente montado a partir de `list_segments` +
 * `get_segment` no passo 1 da skill `/diaria-apoios-sync`). Segmento canônico
 * sem correspondente em `liveSegments` (nome não encontrado) conta como
 * divergente — nunca assume convergência por ausência de dado.
 */
export function computeSegmentDrift(
  liveSegments: ReadonlyArray<{ name: string; where: string }>,
  canonical: ReadonlyArray<CanonicalApoioSegment> = APOIO_SEGMENTS_CANONICAL,
): SegmentDriftEntry[] {
  return canonical.map((c) => {
    const live = liveSegments.find((s) => s.name === c.name);
    return {
      name: c.name,
      live: live ? live.where : null,
      canonical: c.where,
      converged: live ? isSegmentConverged(live.where, c.where) : false,
    };
  });
}

/** Pure: `true` se TODOS os 6 segmentos estão convergidos — atalho pro passo
 * 1 da skill decidir "prosseguir direto" vs "instruir correção pela UI". */
export function allSegmentsConverged(drift: readonly SegmentDriftEntry[]): boolean {
  return drift.every((d) => d.converged);
}

// ---------------------------------------------------------------------------
// Gate de num_members pós-refresh (#4485 item 1 — Passo 4 da skill)
// ---------------------------------------------------------------------------
//
// Verificado ao vivo em 260802 (#4485): mudar o VALOR de um custom field
// (`--push` de `sync-apoio-nivel-beehiiv.ts`) não recalcula os 6 segmentos
// sozinho — a Beehiiv só reprocessa quando a CONDIÇÃO do segmento é salva.
// `Apoio — Todos` chegou a mostrar `total: 0` mesmo com 16 assinantes com
// nível recém-gravado — não era contador defasado, a pertinência real
// estava vazia. O botão "Refresh segment" (aba Overview) resolve, mas nem
// sempre pega na 1ª tentativa (4 de 6 pegaram no re-save, 2 precisaram de 2ª
// tentativa) — por isso o Passo 4 da skill precisa de um GATE de verdade
// depois do refresh, não só "cliquei e segui em frente".

export interface SegmentMemberCounts {
  amigo: number;
  apoiador: number;
  mantenedor: number;
  patrono: number;
  todos: number;
  nenhum: number;
}

export interface SegmentCountGateResult {
  /** `true` quando os 2 checks abaixo baterem — refresh confirmado em TODOS
   * os 6 segmentos. */
  ok: boolean;
  sumOfTiers: number;
  todos: number;
  nenhum: number;
  activeBase: number;
  /** `amigo + apoiador + mantenedor + patrono === todos`. */
  tiersMatchTodos: boolean;
  /** `todos + nenhum === activeBase`. */
  totalMatchesActiveBase: boolean;
}

/**
 * Pure: gate do Passo 4 da skill `/diaria-apoios-sync` (#4485 item 1) —
 * depois do "Refresh segment" manual em cada um dos 6 segmentos, confirma
 * que a releitura de `num_members` reconcilia: soma das 4 faixas === Todos,
 * e Todos + Nenhum === base ativa total. Se qualquer um dos dois checks
 * falhar, o refresh não pegou em algum segmento — repetir nele antes de
 * declarar sucesso (nunca aceitar "a tela mostrou que salvou").
 */
export function evaluateSegmentCountGate(counts: SegmentMemberCounts, activeBase: number): SegmentCountGateResult {
  const sumOfTiers = counts.amigo + counts.apoiador + counts.mantenedor + counts.patrono;
  const tiersMatchTodos = sumOfTiers === counts.todos;
  const totalMatchesActiveBase = counts.todos + counts.nenhum === activeBase;
  return {
    ok: tiersMatchTodos && totalMatchesActiveBase,
    sumOfTiers,
    todos: counts.todos,
    nenhum: counts.nenhum,
    activeBase,
    tiersMatchTodos,
    totalMatchesActiveBase,
  };
}
