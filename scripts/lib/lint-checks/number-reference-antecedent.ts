/**
 * lint-checks/number-reference-antecedent.ts (#11196)
 *
 * WARN-ONLY: flagra referência anafórica a um número que não foi dado antes
 * no mesmo bloco. Caso real (edição 261020, D3): o corpo dizia "Uma em cada
 * três empresas..." e, um parágrafo depois, "Os 33% mostram esse avanço de
 * forma direta" — o leitor nunca tinha visto "33%"; o artigo definido trata
 * o número como já conhecido.
 *
 * Duas formas cobertas:
 *
 *   1. Artigo definido/demonstrativo + percentual usado como sujeito:
 *      "Os 33% mostram...", "Esses 40% ...", "Os 12 por cento ...".
 *      Exigência: o mesmo número (com %/por cento) aparece ANTES no bloco.
 *      Partitivo logo depois ("Os 33% das empresas", "os 10% de ...") define
 *      o número no próprio sintagma — não é anáfora, não sinaliza.
 *
 *   2. Demonstrativo + contagem + substantivo de número: "Esses três números",
 *      "Estes 2 dados", "Essas duas cifras". Exigência: o bloco já trouxe pelo
 *      menos essa quantidade de números (dígitos) antes.
 *
 * "Bloco" = trecho entre separadores `---` (ou cabeçalhos `#`), que no
 * `02-reviewed.md` corresponde a um destaque ou a uma seção. O título do
 * destaque entra no bloco, então número dado no título conta como antecedente.
 *
 * Heurística deliberadamente estreita (só percentual na forma 1, só
 * demonstrativo na forma 2): "Os 500 maiores bancos" ou "As 3 empresas
 * citadas" introduzem o número no próprio sintagma e são frequentes — por
 * isso número sem % não entra na forma 1. Warn-only: o texto no gate pode já
 * ser do editor (#7401).
 */

export interface NumberReferenceWarning {
  /** Linha (1-based) onde a referência aparece. */
  line: number;
  /** Trecho casado (ex.: "Os 33%"). */
  match: string;
  /** Explicação curta do que faltou antes. */
  reason: string;
}

export interface NumberReferenceReport {
  ok: boolean;
  warnings: NumberReferenceWarning[];
}

const DETERMINER =
  "(?:os|as|esses|essas|estes|estas|esse|essa|este|esta|aqueles|aquelas|aquele|aquela)";

/** Forma 1: determinante + N% (ou "N por cento"), sem partitivo em seguida. */
const PCT_REF_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])${DETERMINER}\\s+(\\d+(?:[.,]\\d+)?)\\s*(?:%|por\\s+cento)(?!\\s+(?:de|dos|das|do|da)(?![\\p{L}\\p{N}_]))`,
  "giu",
);

const COUNT_WORDS: Record<string, number> = {
  dois: 2,
  duas: 2,
  "três": 3,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
};

/** Forma 2: demonstrativo + contagem + substantivo de número. */
const COUNT_REF_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:esses|essas|estes|estas)\\s+(\\d+|dois|duas|tr[êe]s|quatro|cinco|seis)\\s+(?:n[úu]meros|dados|cifras|percentuais|porcentagens|[íi]ndices|valores)(?![\\p{L}\\p{N}_])`,
  "giu",
);

const NUMBER_TOKEN_RE = /\d+(?:[.,]\d+)*/g;

function normalizeNumber(n: string): string {
  return n.replace(",", ".");
}

/** O percentual `num` aparece em `text` (como "N%" ou "N por cento")? */
function hasPercent(text: string, num: string): boolean {
  const variants = [num, num.replace(".", ","), num.replace(",", ".")];
  return variants.some((v) => {
    const esc = v.replace(/[.]/g, "\\.");
    return new RegExp(`(?<![\\d.,])${esc}\\s*(?:%|por\\s+cento)`, "iu").test(text);
  });
}

function isBlockBoundary(line: string): boolean {
  const t = line.trim();
  return /^-{3,}$/.test(t) || /^#{1,6}\s/.test(t);
}

export function checkNumberReferenceAntecedent(md: string): NumberReferenceReport {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const warnings: NumberReferenceWarning[] = [];

  // Texto acumulado do bloco atual, até (exclusive) a linha corrente.
  let blockText = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlockBoundary(line)) {
      blockText = "";
      continue;
    }

    for (const m of line.matchAll(PCT_REF_RE)) {
      const before = blockText + line.slice(0, m.index);
      const num = normalizeNumber(m[1]);
      if (!hasPercent(before, num)) {
        warnings.push({
          line: i + 1,
          match: m[0],
          reason: `"${m[0]}" trata ${m[1]}% como já citado, mas o número não aparece antes no bloco`,
        });
      }
    }

    for (const m of line.matchAll(COUNT_REF_RE)) {
      const before = blockText + line.slice(0, m.index);
      const raw = m[1].toLowerCase();
      const needed = /^\d+$/.test(raw) ? Number(raw) : (COUNT_WORDS[raw] ?? 2);
      const found = (before.match(NUMBER_TOKEN_RE) ?? []).length;
      if (found < needed) {
        warnings.push({
          line: i + 1,
          match: m[0],
          reason: `"${m[0]}" remete a ${needed} números, mas o bloco só trouxe ${found} antes`,
        });
      }
    }

    // Alvo de link markdown não é texto lido: "r-40-mil" na URL não é antecedente.
    blockText += line.replace(/\]\([^)]*\)/g, "]") + "\n";
  }

  return { ok: warnings.length === 0, warnings };
}
