/**
 * lint-checks/relative-time.ts (#1737 item 2 — extraído de lint-newsletter-md.ts)
 *
 * Detecta referências temporais relativas banidas no MD da newsletter (#747).
 *
 * Edições publicam D+1: "hoje" / "ontem" / "esta semana" são ambíguos no
 * momento da leitura.
 *
 * Retorna array de matches com contexto (trecho da linha).
 *
 * NÃO confundir com `scripts/lint-social-md.ts`, que tem o SEU próprio
 * `lintRelativeTime`/`RELATIVE_TIME_RE` — intencionalmente diferente (regra do
 * canal social: boundary `(?<![\w-])`, cobre `há N dias/semanas`, `próxima
 * semana`, skip de aspas). Esta é a regra da NEWSLETTER. Unificar as duas é uma
 * decisão à parte (não faz parte do #1737 item 2, que só quebra o lint-newsletter).
 */

export interface RelativeTimeMatch {
  word: string;
  context: string;
  line: number;
}

export interface RelativeTimeResult {
  ok: boolean;
  matches: RelativeTimeMatch[];
}

// Nota: \b não funciona com caracteres Unicode (ã, ê, etc.) — usamos
// lookahead/lookbehind em vez de \b para cobrir amanhã, mês, etc.
const RELATIVE_TIME_RE =
  /(?<!\w)(hoje|ontem|amanhã|agora mesmo|esta semana|na semana passada|na próxima semana|este mês|mês passado|recentemente|há pouco|acabou de|nesta (?:segunda|terça|quarta|quinta|sexta|sábado|domingo))(?!\w)/gi;

export function lintRelativeTime(md: string): RelativeTimeResult {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const matches: RelativeTimeMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    // Reset lastIndex (g flag) between lines
    RELATIVE_TIME_RE.lastIndex = 0;
    while ((m = RELATIVE_TIME_RE.exec(line)) !== null) {
      matches.push({
        word: m[1],
        context: line.slice(Math.max(0, m.index - 20), m.index + m[1].length + 20).trim(),
        line: i + 1,
      });
    }
  }

  return {
    ok: matches.length === 0,
    matches,
  };
}
