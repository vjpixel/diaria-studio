/**
 * scripts/lib/apoio-segments-canonical-kit.ts (#6049)
 *
 * Fonte única de verdade dos 6 segmentos `Apoio — {Amigo,Apoiador,Mantenedor,
 * Patrono,Todos,Nenhum}` no Kit — espelho de `apoio-segments-canonical.ts`
 * (Beehiiv), mas com um desenho DIFERENTE: o Kit não expõe a condição do
 * segmento via API em lugar nenhum (nem REST, nem MCP `list_segments`, que só
 * devolve `id`+`name`), então não existe um `get_segment`/`where` pra
 * comparar contra um canônico — o padrão `isSegmentConverged` da Beehiiv NÃO
 * é portável.
 *
 * ## Achado que trava o drift-check no estilo Beehiiv (260824)
 *
 * `GET /v4/subscribers?segment_id=X` **ignora silenciosamente** o parâmetro —
 * `pagination.total_count` bate com o total da conta inteira (585),
 * independente do `segment_id` passado. Confirmado ao vivo com os 6
 * segmentos reais desta conta. Não há endpoint que devolva "quem está no
 * segmento X" nem "qual é a condição do segmento X".
 *
 * Consequência: os 6 segmentos abaixo são, na prática, metadados de
 * conveniência pra navegação na UI do editor (criados uma vez à mão, mesmo
 * padrão do #4436 na Beehiiv) — não um alvo programaticamente auditável. Um
 * futuro sync/drift-check pro Kit precisa recomputar pertencimento
 * DIRETAMENTE do valor do custom field `apoio_nivel` (via
 * `mcp__kit__filter_subscribers` ou `GET /v4/subscribers?...&fields=...`,
 * como o import do #6047 já faz), nunca tentar ler de volta a definição do
 * segmento em si.
 *
 * ## Criados e verificados ao vivo em 260824
 *
 * Os 6 segmentos foram criados na UI do Kit (`Custom field: apoio_nivel`,
 * ver `KIT_APOIO_NIVEL_FIELD_ID`/`KIT_APOIO_NIVEL_FIELD_KEY` abaixo) e cada
 * contagem foi conferida no momento da criação contra o import do #6047
 * (4 patrono + 6 mantenedor + 9 apoiador + 3 amigo = 22; 585 - 22 = 563
 * nenhum). Os IDs abaixo são os reais desta conta — únicos por conta Kit,
 * não recriar o segmento achando que o ID vai bater numa conta nova.
 */

import type { ApoioNivel } from "../sync-apoio-nivel-beehiiv.ts";

/** Custom field `apoio_nivel` — criado pelo import do #6047 (não por este
 *  módulo). Nenhum script deste arquivo cria o campo, só referencia o id/key
 *  pra quem for escrever/ler o valor via `mcp__kit__*` ou REST direto. */
export const KIT_APOIO_NIVEL_FIELD_ID = 1347084;
export const KIT_APOIO_NIVEL_FIELD_KEY = "apoio_nivel";

/** Reexportado pra quem importar só este módulo não precisar saber que o
 *  tipo canônico vive em `sync-apoio-nivel-beehiiv.ts` (mesmos 4 valores,
 *  fonte única — nunca redeclarar essa union aqui). */
export type { ApoioNivel };

export interface CanonicalApoioSegmentKit {
  /** Nome exato do segmento no Kit — usado pra casar contra `list_segments`. */
  name: string;
  /** ID real do segmento nesta conta Kit (`mcp__kit__list_segments`, 260824).
   *  Segmento-específico da conta — não portável entre contas/ambientes. */
  id: number;
  /** Nível que este segmento representa, ou `null` pros dois segmentos de
   *  união/complemento (Todos/Nenhum, que não mapeiam pra um nível único). */
  nivel: ApoioNivel | null;
}

export const APOIO_SEGMENTS_CANONICAL_KIT: readonly CanonicalApoioSegmentKit[] = [
  { name: "Apoio — Amigo", id: 584168, nivel: "amigo" },
  { name: "Apoio — Apoiador", id: 584167, nivel: "apoiador" },
  { name: "Apoio — Mantenedor", id: 584164, nivel: "mantenedor" },
  { name: "Apoio — Patrono", id: 584151, nivel: "patrono" },
  { name: "Apoio — Todos", id: 584155, nivel: null },
  { name: "Apoio — Nenhum", id: 584158, nivel: null },
] as const;

/** Pure: dado um valor bruto de `apoio_nivel` (como vem do custom field —
 *  string, `null`/`undefined` quando ausente), devolve os nomes de segmento
 *  Kit aos quais ele PERTENCE, segundo a mesma regra usada pra criar os
 *  segmentos (Is Exactly / Has any value). Não faz chamada de rede — é a
 *  peça reutilizável pra um futuro script comparar "quem deveria estar onde"
 *  contra o valor real do custom field, já que o Kit não permite ler a
 *  pertinência do segmento de volta. */
export function expectedKitSegmentsFor(apoioNivelValue: string | null | undefined): string[] {
  const value = apoioNivelValue?.trim() || null;
  const segments: string[] = [];
  if (value === null) {
    segments.push("Apoio — Nenhum");
    return segments;
  }
  segments.push("Apoio — Todos");
  const tierEntry = APOIO_SEGMENTS_CANONICAL_KIT.find((s) => s.nivel === value);
  if (tierEntry) segments.push(tierEntry.name);
  return segments;
}
