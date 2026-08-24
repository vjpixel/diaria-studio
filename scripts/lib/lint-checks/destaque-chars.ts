/**
 * lint-checks/destaque-chars.ts (#1737 item 2 — extraído de lint-newsletter-md.ts)
 *
 * Verifica que cada destaque atinge o mínimo (#914) e não passa do máximo
 * (#964) de chars. Char count exclui URLs (delegado a `parseHighlights` em
 * measure-highlights.ts) — mede só o body do destaque (parágrafos + "Por que
 * isso importa" + parágrafo de impacto).
 *
 * Mínimos/máximos editoriais (complementam o writer.md):
 *   D1 ≥ 900,  ≤ 1000
 *   D2 ≥ 900,  ≤ 1000
 *   D3 ≥ 900,  ≤ 1000
 *
 * Janela ÚNICA para os três destaques (#6061, pedido do editor 24/08/2026):
 * o tamanho de D1 deve ser igual ao de D2 e D3 — a hierarquia editorial
 * (manchete > segundas) não precisa de mais chars pra se expressar, e a
 * janela assimétrica antiga (D1 1000–1200) gerava D1 inflado artificialmente.
 * Histórico da motivação original dos pisos: em 260507 D1=999/D2=708/D3=679
 * (abaixo do piso — variação D1↔D3 = +47% no peso editorial); em 260508
 * D2=1409 (acima do teto) passou despercebido até o gate. Ambos os checks
 * são BLOQUEANTES de propósito: com max bloqueante o writer teria sido
 * re-disparado automaticamente em vez de só reportar.
 */

import { parseHighlights } from "../measure-highlights.ts"; // #914

export const DESTAQUE_MIN_CHARS = {
  1: 900,
  2: 900,
  3: 900,
} as const;

export const DESTAQUE_MAX_CHARS = {
  1: 1000,
  2: 1000,
  3: 1000,
} as const;

export interface DestaqueMinCharsError {
  destaque: number;
  category: string;
  chars: number;
  min: number;
}

export interface DestaqueMinCharsReport {
  ok: boolean;
  errors: DestaqueMinCharsError[];
  highlights: Array<{ destaque: number; category: string; chars: number; min: number }>;
}

export function checkDestaqueMinChars(md: string): DestaqueMinCharsReport {
  const measured = parseHighlights(md);
  const errors: DestaqueMinCharsError[] = [];
  const summary: DestaqueMinCharsReport["highlights"] = [];

  for (const h of measured.highlights) {
    const min =
      DESTAQUE_MIN_CHARS[h.number as 1 | 2 | 3] ?? DESTAQUE_MIN_CHARS[3];
    summary.push({
      destaque: h.number,
      category: h.category,
      chars: h.chars,
      min,
    });
    if (h.chars < min) {
      errors.push({
        destaque: h.number,
        category: h.category,
        chars: h.chars,
        min,
      });
    }
  }

  return { ok: errors.length === 0, errors, highlights: summary };
}

export interface DestaqueMaxCharsError {
  destaque: number;
  category: string;
  chars: number;
  max: number;
}

export interface DestaqueMaxCharsReport {
  ok: boolean;
  errors: DestaqueMaxCharsError[];
  highlights: Array<{ destaque: number; category: string; chars: number; max: number }>;
}

export function checkDestaqueMaxChars(md: string): DestaqueMaxCharsReport {
  const measured = parseHighlights(md);
  const errors: DestaqueMaxCharsError[] = [];
  const summary: DestaqueMaxCharsReport["highlights"] = [];

  for (const h of measured.highlights) {
    const max =
      DESTAQUE_MAX_CHARS[h.number as 1 | 2 | 3] ?? DESTAQUE_MAX_CHARS[3];
    summary.push({
      destaque: h.number,
      category: h.category,
      chars: h.chars,
      max,
    });
    if (h.chars > max) {
      errors.push({
        destaque: h.number,
        category: h.category,
        chars: h.chars,
        max,
      });
    }
  }

  return { ok: errors.length === 0, errors, highlights: summary };
}
