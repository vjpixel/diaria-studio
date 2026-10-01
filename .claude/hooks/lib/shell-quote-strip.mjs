// Tokenizer compartilhado pelos hooks Bash (#9318): remove o CONTEÚDO de spans
// entre aspas preservando tudo fora deles (inclusive newlines reais).
// Antes vivia duplicado em 9 hooks e o #9214 corrigiu só 3 cópias — a fonte
// única evita a divergência. Regras:
// - `\x` fora de aspas é literal (`don\'t`), não abre span (#9197);
// - `\<newline>` é continuação de linha: some, sem virar separador (#9214/#9318);
// - `$'...'` (ANSI-C) aceita `\'` como escape interno (#9214/#9318);
// - aspa simples sem escape; aspa dupla respeita `\"`;
// - aspa não fechada trata o resto da string como dentro do span.
export function stripQuotedSpans(command) {
  let result = "";
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i];
    if (ch === "\\" && i + 1 < n) {
      if (command[i + 1] !== "\n") result += command.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "$" && command[i + 1] === "'") {
      let j = i + 2;
      while (j < n && command[j] !== "'") {
        if (command[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < n && command[j] !== "'") j++;
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n && command[j] !== '"') {
        if (command[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

/**
 * Fim (exclusivo) de um span ANSI-C `$'...'` que começa em `start`, ou -1 se
 * não houver um ali ou ele não fechar.
 */
export function ansiCQuoteEnd(text, start) {
  if (text[start] !== "$" || text[start + 1] !== "'") return -1;
  let j = start + 2;
  while (j < text.length) {
    if (text[j] === "\\") {
      j += 2;
      continue;
    }
    if (text[j] === "'") return j + 1;
    j++;
  }
  return -1;
}
