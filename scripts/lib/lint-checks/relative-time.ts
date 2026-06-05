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

import { SECTION_EMOJI, sectionHeaderRegex } from "../section-naming.ts";

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
// 'ontem, 1º de junho', o certo seria 'anteontem'"). Excluir o bloco do escopo
// do check.
//
// Header ANCORADO via builder canônico (#1737) — linha inteira `(**)?ERRO
// INTENCIONAL(**)?`. Ancorar evita casar prosa que só COMEÇA com "Erro
// intencional…" (over-match que faria o skip engolir violações reais até o
// próximo separador). Reusa SECTION_EMOJI_PREFIX/bold do registry em vez de
// re-derivar emoji/bold à mão.
const ERRO_INTENCIONAL_HEADER_RE = sectionHeaderRegex(String.raw`ERRO\s+INTENCIONAL`, {
  bold: "optional",
  flags: "imu",
});
const SEPARATOR_RE = /^\s*---\s*$/;
// #1866: o bloco fecha no `---` OU na próxima seção (header com emoji). Sem o
// segundo caso, uma edição cujo `---` entre ERRO INTENCIONAL e a próxima seção
// foi removido (hand-edit no Drive) faria o skip ir até o EOF, engolindo
// violações reais em SORTEIO / PARA ENCERRAR (falso-negativo num lint que o
// gate confia). Espelha o `nextSepRe` do extractIntentionalErrorFromMd.
const NEXT_SECTION_HEADER_RE = new RegExp(String.raw`^\s*(?:\*\*)?${SECTION_EMOJI}`, "u");

export function lintRelativeTime(md: string): RelativeTimeResult {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const matches: RelativeTimeMatch[] = [];

  let inErroIntencional = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // #1866: ao entrar no bloco ERRO INTENCIONAL, pular tudo até o `---` ou a
    // próxima seção. Renderer emite o bloco bracketado por `---`; o fallback de
    // header-de-seção cobre edições onde o `---` de fechamento sumiu.
    if (!inErroIntencional && ERRO_INTENCIONAL_HEADER_RE.test(line)) {
      inErroIntencional = true;
      continue;
    }
    if (inErroIntencional) {
      if (SEPARATOR_RE.test(line)) {
        inErroIntencional = false;
        continue; // o `---` em si não tem conteúdo pra varrer.
      }
      if (NEXT_SECTION_HEADER_RE.test(line)) {
        inErroIntencional = false;
        // NÃO `continue`: a linha do próximo header (e tudo depois) volta a ser
        // varrida normalmente — cai no scan abaixo.
      } else {
        continue;
      }
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
