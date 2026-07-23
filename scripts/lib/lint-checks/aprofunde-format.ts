/**
 * lint-checks/aprofunde-format.ts (#3920)
 *
 * Valida o bloco "Aprofunde:" dos destaques (fontes do cluster same-story).
 *
 * Regras:
 *   - O bloco é OPCIONAL — só presente quando o destaque tem cluster_sources.
 *     Destaque sem "Aprofunde:" nunca dispara erro.
 *   - Quando presente, deve vir DEPOIS de "Por que isso importa:".
 *   - Deve ter ≥1 item bem-formado: `* [Título](URL) - Fonte` (bullet `*`/`-`,
 *     inline-link, separador + fonte opcional).
 *   - Toda linha não-vazia do bloco deve casar o formato de item; lixo entre os
 *     itens (parágrafo solto, título sem link) é erro.
 *
 * Espelha o parser real (`parseAprofundeItems` em extract-destaques.ts) —
 * reusa as MESMAS regexes pra não divergir do que o render de fato consome.
 */

import {
  APROFUNDE_HEADER_RE,
  APROFUNDE_ITEM_RE,
} from "../../extract-destaques.ts";

const DESTAQUE_HEADER_RE = /^(?:\*\*)?DESTAQUE\s+([123])\s*\|/;
const WHY_RE = /^Por que isso importa:/i;

export interface AprofundeFormatError {
  destaque: number | null;
  line: number;
  type: "malformed_item" | "empty_block" | "before_why";
  excerpt: string;
}

export interface AprofundeFormatReport {
  ok: boolean;
  errors: AprofundeFormatError[];
}

export function checkAprofundeFormat(md: string): AprofundeFormatReport {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const errors: AprofundeFormatError[] = [];

  let currentDestaque: number | null = null;
  let sawWhy = false;
  let inAprofunde = false;
  let aprofundeItemCount = 0;
  let aprofundeHeaderLine = 0;

  const closeBlock = () => {
    if (inAprofunde && aprofundeItemCount === 0) {
      errors.push({
        destaque: currentDestaque,
        line: aprofundeHeaderLine,
        type: "empty_block",
        excerpt: "Aprofunde:",
      });
    }
    inAprofunde = false;
    aprofundeItemCount = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();

    const dHeader = t.match(DESTAQUE_HEADER_RE);
    if (dHeader) {
      closeBlock();
      currentDestaque = parseInt(dHeader[1], 10);
      sawWhy = false;
      continue;
    }
    if (t === "---") {
      closeBlock();
      continue;
    }
    // seção secundária (LANÇAMENTOS/RADAR/... começam com **emoji NOME**) fecha
    // qualquer bloco de destaque aberto.
    if (/^\*\*[^*]+\*\*$/.test(t) && !APROFUNDE_HEADER_RE.test(t) && currentDestaque !== null && inAprofunde) {
      closeBlock();
      currentDestaque = null;
      continue;
    }

    if (WHY_RE.test(t)) {
      sawWhy = true;
      continue;
    }

    if (APROFUNDE_HEADER_RE.test(t)) {
      // Aprofunde só faz sentido dentro de um destaque e após o "Por que importa".
      if (currentDestaque !== null && !sawWhy) {
        errors.push({
          destaque: currentDestaque,
          line: i + 1,
          type: "before_why",
          excerpt: t,
        });
      }
      inAprofunde = true;
      aprofundeItemCount = 0;
      aprofundeHeaderLine = i + 1;
      continue;
    }

    if (inAprofunde) {
      if (t === "") continue;
      if (APROFUNDE_ITEM_RE.test(t)) {
        aprofundeItemCount++;
      } else {
        errors.push({
          destaque: currentDestaque,
          line: i + 1,
          type: "malformed_item",
          excerpt: t.slice(0, 100),
        });
      }
    }
  }
  closeBlock();

  return { ok: errors.length === 0, errors };
}
