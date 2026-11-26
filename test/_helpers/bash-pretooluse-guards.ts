/**
 * Guards que de fato rodam a cada Bash (#14045).
 *
 * Desde o #14045 os 16 guards de PreToolUse/Bash não estão mais um a um em
 * `.claude/settings.json`: o settings registra só o despachante
 * (`pretooluse-bash-dispatch.mjs`), que roda a lista `GUARDS` dele. Os testes
 * que travam "o guard X está armado" leem por aqui, que junta as duas fontes:
 * script registrado direto no grupo `matcher: "Bash"` e guard da lista do
 * despachante (só quando o despachante está registrado nesse grupo).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GUARDS } from "../../.claude/hooks/pretooluse-bash-dispatch.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
export const DISPATCHER_FILE = "pretooluse-bash-dispatch.mjs";

interface HookGroup {
  matcher?: string;
  hooks?: Array<{ args?: string[] }>;
}

/** Nomes de arquivo dos scripts registrados direto nos grupos PreToolUse `matcher: "Bash"`. */
export function directBashPreToolUseScripts(): string[] {
  const settings = JSON.parse(readFileSync(join(ROOT, ".claude", "settings.json"), "utf8")) as {
    hooks?: { PreToolUse?: HookGroup[] };
  };
  return (settings.hooks?.PreToolUse ?? [])
    .filter((g) => g.matcher === "Bash")
    .flatMap((g) => g.hooks ?? [])
    .flatMap((h) => h.args ?? [])
    .map((a) => a.split("/").pop() ?? a);
}

/** Nomes de arquivo de todo guard que roda a cada Bash: os diretos + os do despachante. */
export function armedBashPreToolUseGuards(): string[] {
  const direct = directBashPreToolUseScripts();
  const viaDispatcher = direct.includes(DISPATCHER_FILE) ? GUARDS.map((g) => g.file) : [];
  return [...direct, ...viaDispatcher];
}
