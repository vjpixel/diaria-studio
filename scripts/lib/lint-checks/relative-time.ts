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

// #1866: o bloco ERRO INTENCIONAL legitimamente cita datas relativas como
// CONTEÚDO (o erro revelado pode ser justamente sobre uma data: "…dizia
// 'ontem, 1º de junho', o certo seria 'anteontem'"). Excluir o bloco do
// escopo do check (do header até o próximo `---`). Header tolera emoji opcional
// + bold opcional. Sem `\b` por causa do acento.
const ERRO_INTENCIONAL_HEADER_RE =
  /^\s*(?:\*\*)?\s*(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})?\s*ERRO\s+INTENCIONAL\b/iu;
const SEPARATOR_RE = /^\s*---\s*$/;

export function lintRelativeTime(md: string): RelativeTimeResult {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const matches: RelativeTimeMatch[] = [];

  let inErroIntencional = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // #1866: ao entrar no bloco ERRO INTENCIONAL, pular tudo até o `---` que o
    // fecha (inclusive header e separador). Renderer sempre emite o bloco
    // bracketado por `---` (insertOrUpdateSection).
    if (!inErroIntencional && ERRO_INTENCIONAL_HEADER_RE.test(line)) {
      inErroIntencional = true;
      continue;
    }
    if (inErroIntencional) {
      if (SEPARATOR_RE.test(line)) inErroIntencional = false;
      continue;
    }
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
