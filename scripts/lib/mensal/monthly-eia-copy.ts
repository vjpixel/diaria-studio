/**
 * monthly-eia-copy.ts (#11790)
 *
 * A Etapa 3 mensal reusa o `01-eia.md` da edição diária. Esse arquivo traz
 * "Resultado da última edição: X%" da edição ANTERIOR à diária, que contradiz
 * o resultado do ciclo mensal; a cópia remove a linha (o mensal injeta a sua
 * em render, #2948).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Pure: remove as linhas "Resultado da última edição: ..." do 01-eia.md. */
export function stripPrevResultLine(eiaMd: string): string {
  const re = /^\s*Resultado da última edição:/i;
  const lines = eiaMd.split(/(?<=\n)/);
  if (!lines.some((l) => re.test(l))) return eiaMd; // preserva CRLF/bytes
  return lines.filter((l) => !re.test(l)).join("");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [src, dest] = process.argv.slice(2);
  if (!src || !dest) {
    console.error("uso: monthly-eia-copy.ts <01-eia.md diário> <01-eia.md do ciclo>");
    process.exit(2);
  }
  writeFileSync(dest, stripPrevResultLine(readFileSync(src, "utf8")));
}
