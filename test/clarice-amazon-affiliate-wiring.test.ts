/**
 * test/clarice-amazon-affiliate-wiring.test.ts (#8059 achado do review, PR
 * #8076 — 3 revisores independentes confirmaram o mesmo gap: só
 * `clarice-schedule-group.ts` verificava o resultado da reescrita de tag
 * Amazon antes de qualquer disparo; os outros 4 scripts que reusam
 * `cloudflare-preview.html` como conteúdo Clarice só chamavam a reescrita,
 * sem confirmar que ela converteu TUDO.)
 *
 * `clarice-cta-ab-setup.ts` não tem nenhum teste dedicado hoje
 * (`test/clarice-cta-ab-split.test.ts` testa outro módulo, o split
 * A/B/QA) — este arquivo cobre especificamente a integração da tag de
 * afiliado Amazon nos 5 scripts, via inspeção de fonte (mesmo padrão leve
 * usado alhures no repo pra travar convenção sem precisar montar o
 * ambiente completo de cada script — rede, `resolveMonthlyDir`,
 * `BREVO_CLARICE_API_KEY`, etc.). Regressão real que este teste pega: um
 * dos 5 scripts perder a chamada de `assertNoAmazonAffiliateTagIssues`
 * (ex: num refactor futuro que só preserva `rewriteAmazonAffiliateTagsInText`)
 * volta a deixar link Amazon com tag errada passar em silêncio pro envio.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SCRIPTS_REUSING_CLOUDFLARE_PREVIEW_HTML = [
  "scripts/clarice-schedule-group.ts",
  "scripts/clarice-schedule-sends.ts",
  "scripts/clarice-schedule-ramp.ts",
  "scripts/clarice-reapply-scheduled-html.ts",
  "scripts/clarice-cta-ab-setup.ts",
];

describe("os 5 scripts que reusam cloudflare-preview.html pro envio Clarice reescrevem E verificam a tag Amazon (#8059)", () => {
  for (const relPath of SCRIPTS_REUSING_CLOUDFLARE_PREVIEW_HTML) {
    it(`${relPath} importa e chama rewriteAmazonAffiliateTagsInText + assertNoAmazonAffiliateTagIssues`, () => {
      const src = readFileSync(resolve(ROOT, relPath), "utf8");
      assert.match(
        src,
        /import\s*\{[^}]*rewriteAmazonAffiliateTagsInText[^}]*assertNoAmazonAffiliateTagIssues[^}]*\}\s*from\s*"\.\/lib\/amazon-affiliate\.ts"/,
        `${relPath}: import de rewriteAmazonAffiliateTagsInText + assertNoAmazonAffiliateTagIssues ausente/incompleto`,
      );
      assert.match(
        src,
        /rewriteAmazonAffiliateTagsInText\(/,
        `${relPath}: não chama rewriteAmazonAffiliateTagsInText`,
      );
      assert.match(
        src,
        /assertNoAmazonAffiliateTagIssues\(/,
        `${relPath}: não chama assertNoAmazonAffiliateTagIssues — guard ausente (o achado original desta issue)`,
      );

      // A chamada do guard precisa vir DEPOIS da reescrita no texto do
      // arquivo — verificar não só presença, mas ORDEM (chamar o guard
      // sobre o HTML ainda não-reescrito não pegaria nada).
      const rewriteIdx = src.indexOf("rewriteAmazonAffiliateTagsInText(");
      const guardIdx = src.indexOf("assertNoAmazonAffiliateTagIssues(");
      assert.ok(
        rewriteIdx >= 0 && guardIdx > rewriteIdx,
        `${relPath}: assertNoAmazonAffiliateTagIssues precisa vir DEPOIS de rewriteAmazonAffiliateTagsInText no arquivo`,
      );
    });
  }
});
