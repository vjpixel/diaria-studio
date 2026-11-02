#!/usr/bin/env node
/**
 * scripts/diagnose-claude-auth.ts (#11887)
 *
 * Diagnóstico manual do método de auth do CLI `claude` neste host, sem expor
 * segredo. Mostra o veredito de `claude auth status` em DOIS ambientes:
 *
 *   - `cru`: o do shell que rodou o script (o que uma sessão interativa vê);
 *   - `filho`: o mesmo depois de `claudeCliEnv` (o que os runners agendados
 *     entregam ao `claude -p`, #5608/#6714).
 *
 * e a evidência de onde pode estar uma fonte de auth da API (nomes de var,
 * presença de `primaryApiKey`/`apiKeyHelper`/`env` nos arquivos de config).
 * Nunca imprime valor de key, token, e-mail ou org.
 *
 * O guard que roda sozinho é o preflight de `run-nightly-chain.ts` e
 * `run-scheduled-edicao.ts` (`scripts/lib/claude-auth-method.ts`); este CLI é
 * para investigar quando ele alarmar. Não roda `/login` nem altera nada.
 *
 * Uso: npx tsx scripts/diagnose-claude-auth.ts [--json]
 * Exit: 0 assinatura nos dois ambientes; 1 algum ambiente fora da assinatura
 * ou sem sessão; 2 não verificável (binário ausente, saída inesperada).
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { resolveClaudeBin } from "./lib/resolve-claude-bin.ts";
import { claudeCliEnv } from "./overnight/run-scheduled-edicao.ts";
import {
  authBlocksRun,
  checkClaudeAuthMethod,
  collectClaudeAuthEvidence,
  formatClaudeAuthEvidence,
  type ClaudeAuthResult,
} from "./lib/claude-auth-method.ts";

export function diagnoseExitCode(results: ReadonlyArray<ClaudeAuthResult>): number {
  if (results.some(authBlocksRun)) return 1;
  if (results.some((r) => r.status === "unknown")) return 2;
  return 0;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const { flags } = parseArgs(argv);
  const repoRootAbs = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let bin: string;
  try {
    bin = resolveClaudeBin();
  } catch (e) {
    console.error(`binário claude não encontrado: ${(e as Error).message}`);
    return 2;
  }
  const raw = checkClaudeAuthMethod(bin, process.env);
  const child = checkClaudeAuthMethod(bin, claudeCliEnv(process.env));
  const evidence = collectClaudeAuthEvidence({ env: process.env, repoRootAbs });
  const code = diagnoseExitCode([raw, child]);
  if (flags.has("json")) {
    console.log(JSON.stringify({ bin, cru: raw, filho: child, evidence, exit: code }, null, 2));
  } else {
    console.log(`binário: ${bin}`);
    console.log(`ambiente cru:   ${raw.status} — ${raw.message}`);
    console.log(`ambiente filho: ${child.status} — ${child.message}`);
    console.log(formatClaudeAuthEvidence(evidence));
  }
  return code;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}
