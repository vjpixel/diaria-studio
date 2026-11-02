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
import { stripPrevResultLine } from "./monthly-render.ts";

// A função pura mora em monthly-render.ts (sem node:*), que também a aplica em
// `parseEiaLegend` como defesa para cópia manual. Re-exportada aqui por compat.
export { stripPrevResultLine };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [src, dest] = process.argv.slice(2);
  if (!src || !dest) {
    console.error("uso: monthly-eia-copy.ts <01-eia.md diário> <01-eia.md do ciclo>");
    process.exit(2);
  }
  writeFileSync(dest, stripPrevResultLine(readFileSync(src, "utf8")));
}
