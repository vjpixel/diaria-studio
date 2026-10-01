/**
 * campaign-reply-subjects.ts (#9313)
 *
 * Coleta os ASSUNTOS de campanhas enviadas com reply-to de campanha
 * (`CAMPAIGN_REPLY_TO_ADDRESSES` em `newsletter-reply-addresses.ts`) —
 * usado por `filter-subscriber-replies.ts` pra aceitar uma thread
 * endereçada a esse reply-to SÓ quando o assunto dela (sem `Re:`) casa o assunto de uma
 * campanha nossa. `pixel@` também recebe correspondência pessoal do editor,
 * então aceitar o endereço incondicionalmente reabriria o falso positivo do
 * #8997; descartá-lo incondicionalmente (o que o #9186 fazia) some com as
 * respostas dos assinantes da Brevo diária/onboarding.
 *
 * Fontes (todas fail-soft — ausente/corrompido → contribui nada, nunca lança;
 * `data/` não existe em clone fresco/CI):
 *   - Brevo diária: `{edição}/_internal/brevo-diaria-published.json` →
 *     `subject` (gravado por `publish-daily-brevo.ts`), das últimas
 *     `maxEditions` edições.
 *   - Onboarding Brevo: `{snippets_dir}/onboarding-{1,2,3}.md` → `assunto:`
 *     (mesmo parser de `onboarding-welcome-run.ts`).
 * Outros canais com reply-to `pixel@` (ex.: Clarice News mensal) entram via
 * `--campaign-subjects <json>` no CLI do filtro.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { enumerateEditionDirs } from "./find-current-edition.ts";
import { parseOnboardingSnippet } from "./onboarding-state.ts";

/** Janela default — replies chegam dias depois do envio; 30 edições cobre com folga a janela de 14d da query. */
export const DEFAULT_MAX_EDITIONS = 30;

/** Assuntos da Brevo diária das `maxEditions` edições mais recentes em `editionsRoot`. */
export function collectBrevoDiariaSubjects(editionsRoot: string, maxEditions = DEFAULT_MAX_EDITIONS): string[] {
  const dirs = enumerateEditionDirs(editionsRoot);
  const recent = [...dirs.keys()].sort((a, b) => b.localeCompare(a)).slice(0, maxEditions);
  const out: string[] = [];
  for (const aammdd of recent) {
    const dir = dirs.get(aammdd);
    if (!dir) continue;
    const path = join(dir, "_internal", "brevo-diaria-published.json");
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { subject?: unknown };
      if (typeof parsed.subject === "string" && parsed.subject.trim()) out.push(parsed.subject);
    } catch {
      // corrompido → ignora (fail-soft; o filtro só perde essa edição)
    }
  }
  return out;
}

/** Assuntos dos 3 e-mails de onboarding Brevo (`onboarding-{1,2,3}.md`). */
export function collectOnboardingSubjects(snippetsDir: string): string[] {
  const out: string[] = [];
  for (const n of [1, 2, 3]) {
    const path = join(snippetsDir, `onboarding-${n}.md`);
    if (!existsSync(path)) continue;
    try {
      const snip = parseOnboardingSnippet(readFileSync(path, "utf8"), n);
      if (snip?.assunto && snip.assunto.trim()) out.push(snip.assunto);
    } catch {
      // ilegível → ignora
    }
  }
  return out;
}
