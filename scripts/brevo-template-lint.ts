/**
 * brevo-template-lint.ts (#14357) — CLI do check da Brevo Template Language.
 *
 * Para envio avulso (HTML montado à mão e colado no painel da Brevo, ou
 * campanha editada fora dos scripts). Os scripts do repo já passam pelo
 * mesmo check sozinhos, dentro de `brevoPost`/`brevoPut`
 * (`scripts/lib/brevo-client.ts`).
 *
 * Uso:
 *   npx tsx scripts/brevo-template-lint.ts --html arquivo.html [--subject "..."] [--preview-text "..."]
 *   npx tsx scripts/brevo-template-lint.ts --text '{{ contact.NOME | capfirst }}'
 *
 * Exit: 0 = passa; 1 = BTL inválida (lista os problemas); 2 = uso/erro de leitura.
 * Não fala com a Brevo: só lê arquivo local.
 */

import { readFileSync } from "node:fs";
import { isMainModule, parseArgsSimple } from "./lib/cli-args.ts";
import {
  formatBrevoTemplateIssues,
  lintBrevoCampaignPayload,
  type BrevoTemplateIssue,
} from "./lib/brevo-template-lint.ts";

export function runLint(args: Record<string, string>): { code: number; output: string } {
  const payload: Record<string, string> = {};
  if (args.html) {
    try {
      payload.htmlContent = readFileSync(args.html, "utf8");
    } catch (e) {
      return { code: 2, output: `erro lendo ${args.html}: ${(e as Error).message}` };
    }
  }
  if (args.text !== undefined) payload.htmlContent = args.text;
  if (args.subject !== undefined) payload.subject = args.subject;
  if (args["preview-text"] !== undefined) payload.previewText = args["preview-text"];
  if (Object.keys(payload).length === 0) {
    return {
      code: 2,
      output: "uso: brevo-template-lint.ts --html arquivo.html | --text '...' [--subject '...'] [--preview-text '...']",
    };
  }
  const issues: BrevoTemplateIssue[] = lintBrevoCampaignPayload(payload);
  if (issues.length === 0) {
    return { code: 0, output: `ok — Brevo Template Language válida (${Object.keys(payload).join(", ")})` };
  }
  return {
    code: 1,
    output: `Brevo Template Language inválida (${issues.length} problema(s)); a campanha seria suspensa no disparo:\n${formatBrevoTemplateIssues(issues)}`,
  };
}

if (isMainModule(import.meta.url)) {
  const { code, output } = runLint(parseArgsSimple(process.argv.slice(2)));
  (code === 0 ? console.log : console.error)(output);
  process.exit(code);
}
