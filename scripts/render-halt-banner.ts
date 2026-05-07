#!/usr/bin/env npx tsx
/**
 * render-halt-banner.ts (#737)
 *
 * Emite um banner vermelho de "PIPELINE PAROU" no stdout. Chamado pelo
 * orchestrator (top-level Claude Code) sempre que detectar uma parada
 * inesperada (MCP disconnect, subagent error, exception não-tratada,
 * ratelimit, loop verify→fix esgotado).
 *
 * Escopo: este script faz apenas o output. O orchestrator decide quando
 * invocá-lo seguindo as regras em CLAUDE.md (ex: "MCP indisponível =
 * fail-fast" #738) e nas specs por stage.
 *
 * Diferença vs gate banner: gate é pausa esperada (aprovação do editor),
 * halt é pausa inesperada (algo quebrou). Cor diferente, texto diferente,
 * action obrigatória pra dar caminho ao editor.
 *
 * Uso:
 *   npx tsx scripts/render-halt-banner.ts \
 *     --stage "2b — Clarice review" \
 *     --reason "mcp__clarice desconectado" \
 *     --action "reconecte e responda 'retry', ou 'abort' para abortar"
 *
 * Wraps em ANSI red quando stdout é TTY e NO_COLOR não está set. Em
 * Bash tool result do Claude Code, sempre não-TTY → output limpo. Em
 * terminal interativo, fica vermelho. Sino do terminal () emitido
 * no stderr quando TTY.
 */

import { renderHaltBanner } from "./lib/gate-banner.ts";

const RED_BG_WHITE_FG = "\x1b[41m\x1b[97m";
const RESET = "\x1b[0m";

function parseArgs(argv: string[]): { stage: string; reason: string; action: string } {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  if (!flags.stage || !flags.reason || !flags.action) {
    process.stderr.write(
      "Usage: render-halt-banner.ts --stage <stage> --reason <reason> --action <action>\n",
    );
    process.exit(2);
  }
  return { stage: flags.stage, reason: flags.reason, action: flags.action };
}

function shouldUseColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const banner = renderHaltBanner(opts);

  const colored = shouldUseColor() ? `${RED_BG_WHITE_FG}${banner}${RESET}` : banner;
  process.stdout.write(colored + "\n");

  // Audible bell on TTY (terminals that support it ring; others ignore).
  if (process.stdout.isTTY) {
    process.stderr.write("\x07");
  }
}

main();
