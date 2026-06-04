/**
 * lint-checks/why-matters-format.ts (#1737 item 2 — extraído de lint-newsletter-md.ts)
 *
 * Verifica formato do parágrafo "Por que isso importa:" (#701, editorial-rules:35).
 *
 * Regra: "O parágrafo de 'Por que isso importa' vai direto ao impacto —
 * nunca começa com 'Para [audiência],' ou endereça o leitor explicitamente."
 *
 * Detecta tanto formato inline ("Por que isso importa: Para X,...") quanto
 * em linha separada (próxima linha não-vazia começando com "Para X,").
 */

export interface WhyMattersError {
  line: number;
  text: string;
}

export interface WhyMattersReport {
  ok: boolean;
  errors: WhyMattersError[];
}

const WHY_MATTERS_BAD_START_RE = /^Para\s+[a-záéíóúâêôãõç]/i;

export function checkWhyMattersFormat(md: string): WhyMattersReport {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const errors: WhyMattersError[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^Por que isso importa:\s*(.*)$/i);
    if (!m) continue;
    const inlineRest = m[1].trim();
    if (inlineRest) {
      // Forma inline: "Por que isso importa: Para X,..."
      if (WHY_MATTERS_BAD_START_RE.test(inlineRest)) {
        errors.push({ line: i + 1, text: inlineRest.slice(0, 80) });
      }
      continue;
    }
    // Forma multi-linha: próxima linha não-vazia
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t === "") continue;
      if (WHY_MATTERS_BAD_START_RE.test(t)) {
        errors.push({ line: j + 1, text: t.slice(0, 80) });
      }
      break;
    }
  }

  return { ok: errors.length === 0, errors };
}
