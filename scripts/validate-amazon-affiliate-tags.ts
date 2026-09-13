/**
 * validate-amazon-affiliate-tags.ts (#8059)
 *
 * Guard/lint da issue #8059 item 4: link Amazon sem `tag=`, com o ID de
 * OUTRA audiência (ex: link `claricenews-20` num render pra diar.ia.br, ou
 * vice-versa), ou um encurtador (`amzn.to`/`link.amazon`) cuja tag não dá
 * pra verificar/reescrever, reprovam o gate.
 *
 * Mesmo contrato de `scripts/validate-domain-diversity.ts`/
 * `validate-lancamentos.ts`: lê um arquivo texto/MD/HTML, roda o lint puro
 * (`findAmazonAffiliateTagIssues`, `scripts/lib/amazon-affiliate.ts`) contra
 * a audiência informada, imprime JSON, exit 1 se houver issue.
 *
 * Uso:
 *   npx tsx scripts/validate-amazon-affiliate-tags.ts <file> --audience diaria
 *   npx tsx scripts/validate-amazon-affiliate-tags.ts <file> --audience clarice
 *
 * Integração:
 *   - Stage 4 da diária: `--audience diaria` contra `02-reviewed.md` — ver
 *     `.claude/agents/orchestrator-stage-4.md` §4c.2.
 *   - Etapa 4 do mensal: `--audience diaria` contra `draft.md` — ver
 *     `.claude/skills/diaria-mensal/SKILL.md` §4c-3 (o `cloudflare-preview.html`
 *     gerado por essa etapa é o MESMO HTML reusado pelos envios Clarice
 *     abaixo, então o guard aqui pega o link problemático ANTES de o HTML
 *     nascer, não só do lado do envio).
 *   - Envio Clarice: não roda este CLI — `assertNoAmazonAffiliateTagIssues`
 *     (mesma lógica de lint desta função, `scripts/lib/amazon-affiliate.ts`)
 *     é chamada diretamente logo após `rewriteAmazonAffiliateTagsInText`, nos
 *     5 scripts que reusam `cloudflare-preview.html` como conteúdo Clarice
 *     (`clarice-schedule-group.ts`, `-sends.ts`, `-ramp.ts`,
 *     `clarice-reapply-scheduled-html.ts`, `clarice-cta-ab-setup.ts`) —
 *     confirma que a reescrita converteu todo link de produto antes de
 *     qualquer create/schedule/sendNow/PUT.
 *
 * Exit codes:
 *   0  Nenhum link Amazon problemático
 *   1  ≥1 issue (missing_tag / wrong_tag / shortener_untaggable)
 *   2  Erro de leitura/uso
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import {
  findAmazonAffiliateTagIssues,
  type AmazonAudience,
  type AmazonAffiliateTagIssue,
} from "./lib/amazon-affiliate.ts";

export interface AmazonAffiliateTagReport {
  ok: boolean;
  audience: AmazonAudience;
  issues: AmazonAffiliateTagIssue[];
}

/** @pure */
export function validateAmazonAffiliateTags(
  content: string,
  audience: AmazonAudience,
): AmazonAffiliateTagReport {
  const issues = findAmazonAffiliateTagIssues(content, audience);
  return { ok: issues.length === 0, audience, issues };
}

function main(): void {
  const { values, positional } = parseCliArgs(process.argv.slice(2));
  const fileArg = values["file"] ?? positional[0];
  const audience = values["audience"];
  if (!fileArg || (audience !== "diaria" && audience !== "clarice")) {
    console.error("Uso: validate-amazon-affiliate-tags.ts <file> --audience diaria|clarice");
    process.exit(2);
  }
  const filePath = resolve(fileArg);
  if (!existsSync(filePath)) {
    console.error(`Arquivo não existe: ${filePath}`);
    process.exit(2);
  }

  const content = readFileSync(filePath, "utf8");
  const report = validateAmazonAffiliateTags(content, audience);
  console.log(JSON.stringify(report, null, 2));

  if (!report.ok) {
    console.error(`\n❌ ${report.issues.length} link(s) Amazon problemático(s) pra audiência "${audience}":`);
    for (const i of report.issues) {
      const detail =
        i.issue === "wrong_tag"
          ? `tag encontrada "${i.found_tag}", esperada "${i.expected_tag}"`
          : i.issue === "missing_tag"
            ? `sem tag= (esperada "${i.expected_tag}")`
            : `encurtador — tag não verificável/reescrevível, trocar por link longo (amazon.com.br/dp/{ASIN}?tag=${i.expected_tag})`;
      console.error(`  [${i.issue}] ${i.url} — ${detail}`);
    }
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
