#!/usr/bin/env npx tsx
/**
 * sorteio-cutoff.ts (#852 follow-up)
 *
 * Imprime o cutoff Gmail-query pra drain do sorteio em formato YYYY/MM/DD.
 *
 *   - Se há edição publicada no mês corrente: usa data da primeira edição.
 *   - Senão (início de mês sem edição ainda): usa primeiro dia do mês.
 *
 * Sempre BRT-aware (#716). Usado pelo Stage 0p e skill `/diaria-sorteio`.
 *
 * Uso:
 *   npx tsx scripts/sorteio-cutoff.ts
 *   # → "2026/05/04"
 *
 * Output: 1 linha string em stdout. Sempre exit 0 — nunca falha (helper
 * é puro, sem I/O remoto).
 */

import { resolveSorteioGmailCutoff } from "./lib/edition-utils.ts";

const cutoff = resolveSorteioGmailCutoff();
process.stdout.write(cutoff + "\n");
