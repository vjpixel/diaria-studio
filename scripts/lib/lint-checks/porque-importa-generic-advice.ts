/**
 * lint-checks/porque-importa-generic-advice.ts (#9382)
 *
 * WARN-ONLY: flagra, no parágrafo "Por que isso importa:" dos destaques, o
 * fechamento de conselho genérico a um público corporativo coletivo —
 * "Equipes/Empresas/Plataformas que X devem/precisam Y". Medição da #9382
 * (67 edições, 260630→261001): 7 de 8 frases nesse formato foram cortadas ou
 * reescritas pelo editor, contra 32% de reescrita da base do "Por que importa".
 *
 * Warn-only de propósito (direção da issue): mede a frequência antes de
 * pensar em bloquear. A ação sugerida ao editor/writer é trocar pela
 * consequência concreta do fato, uma ação datada pro leitor ("Quem … precisa
 * … até novembro" fica — não casa aqui, sujeito é "Quem") ou um ângulo Brasil.
 *
 * Desenho do padrão (validado só-leitura contra `data/editions/`):
 * - o sujeito coletivo precisa ABRIR a frase (início de parágrafo ou após
 *   `.!?`) — "empresas que já usam voz da OpenAI devem herdar a melhoria"
 *   no meio de uma frase é previsão, não conselho, e não casa;
 * - verbo de obrigação no presente/futuro (`devem`, `precisam`, `precisarão`,
 *   `têm/terão que|de`) dentro da mesma frase — "deveriam" (contrafactual,
 *   "filtros que deveriam coibir") fica de fora.
 */

export const GENERIC_ADVICE_PATTERN =
  /(?:^|[.!?]\s+)((?:Equipes|Empresas|Plataformas|Organizações|Companhias|Times|Gestores|Desenvolvedores|Companies)\b[^.!?]{0,160}?\b(?:devem|precisam|precisarão|t[êe]m (?:que|de)|terão (?:que|de))\b[^.!?]*[.!?]?)/g;

export interface GenericAdviceWarning {
  /** Linha (1-based) do parágrafo onde a frase aparece. */
  line: number;
  /** Frase casada (até 200 chars). */
  sentence: string;
}

export interface GenericAdviceReport {
  ok: boolean;
  warnings: GenericAdviceWarning[];
}

const HEADER_RE = /^\s*Por que isso importa:\s*(.*)$/i;

/**
 * Varre os parágrafos "Por que isso importa:" de `md`. O conteúdo é a
 * eventual cauda na mesma linha do rótulo + o primeiro parágrafo não-vazio
 * seguinte (até a próxima linha em branco).
 */
export function checkPorqueImportaGenericAdvice(md: string): GenericAdviceReport {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const warnings: GenericAdviceWarning[] = [];

  const scan = (text: string, line: number) => {
    const re = new RegExp(GENERIC_ADVICE_PATTERN.source, GENERIC_ADVICE_PATTERN.flags);
    for (const m of text.matchAll(re)) {
      warnings.push({ line, sentence: m[1].trim().slice(0, 200) });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const h = HEADER_RE.exec(lines[i]);
    if (!h) continue;
    if (h[1].trim()) scan(h[1].trim(), i + 1);
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    const start = j;
    const para: string[] = [];
    while (j < lines.length && lines[j].trim() && !HEADER_RE.test(lines[j])) {
      para.push(lines[j].trim());
      j++;
    }
    if (para.length && !h[1].trim()) scan(para.join(" "), start + 1);
  }

  return { ok: warnings.length === 0, warnings };
}
