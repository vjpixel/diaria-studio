/**
 * calc-next-edition-date.ts (#2068)
 *
 * CLI wrapper para nextEditionDate — invocado pelo runner PowerShell para
 * calcular AAMMDD = amanhã em America/Sao_Paulo.
 *
 * Uso: npx tsx scripts/overnight/calc-next-edition-date.ts
 * Saída: AAMMDD (ex: "260427"), sem newline final.
 */
import { nextEditionDate } from "../lib/next-edition-date.ts";
process.stdout.write(nextEditionDate());
