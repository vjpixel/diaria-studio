/**
 * truncate-at-boundary.ts (#2065)
 *
 * Helper para truncar strings sem cortar no meio de uma palavra.
 *
 * Estratégia:
 *   1. Prefere terminar no final da última frase completa que caiba em `max`
 *      (regex `/[.!?](\s|$)/`).
 *   2. Fallback: corta no último espaço antes de `max` e appenda `…`.
 *   3. Nunca corta no meio de uma palavra.
 *
 * Se o texto inteiro cabe em `max`, retorna sem modificar (sem `…`).
 * O resultado retornado nunca ultrapassa `max` caracteres.
 */
export function truncateAtBoundary(text: string, max: number): string {
  if (text.length <= max) return text;

  // Reservar 1 char para o `…` nos caminhos fallback (word-boundary + hard).
  // O caminho sentence-end não usa `…`, então pode usar o limite completo.
  const candidate = text.slice(0, max);

  // 1. Tentar cortar no fim de uma frase completa que caiba em `max`
  //    Procura o último terminador de frase (.!?) seguido de espaço ou fim-de-string.
  {
    let lastIdx = -1;
    const re = /[.!?](?=\s|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(candidate)) !== null) {
      lastIdx = m.index + 1; // inclui o próprio terminador
    }
    if (lastIdx > 0) {
      return text.slice(0, lastIdx).trimEnd();
    }
  }

  // 2. Fallback: cortar no último espaço antes de `max - 1` (deixa 1 char pra `…`)
  const safeCandidate = text.slice(0, max - 1);
  const lastSpace = safeCandidate.lastIndexOf(" ");
  if (lastSpace > 0) {
    return text.slice(0, lastSpace).trimEnd() + "…";
  }

  // 3. Sem espaço: cortar no limite hard (caso extremo — palavra única gigante)
  //    Já garantimos `max - 1` chars + 1 char de `…` = `max` chars total.
  return safeCandidate.trimEnd() + "…";
}
