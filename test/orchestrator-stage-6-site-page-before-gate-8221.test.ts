/**
 * test/orchestrator-stage-6-site-page-before-gate-8221.test.ts (#8221, 17/09/2026)
 *
 * A issue #8221 perguntou se a publicação da página do site (`§6d-site`,
 * antes rodada DEPOIS do agendamento confirmado) deveria mover pra antes da
 * parada única do Stage 6 (§6c), igual ao guard de slug (§6b-slug, #8205).
 * O editor decidiu por escrito (comentário `decisao-editor` na issue,
 * 17/09/2026): mover TUDO — validação e publicação — pra antes do gate,
 * aceitando o trade-off de a página já estar publicada mesmo que o editor
 * responda `abortar`.
 *
 * Este arquivo trava, em código, que a decisão foi de fato implementada:
 *   1. Existe uma seção `§6b-site` (não `§6d-site`) e ela vem ANTES de §6c.
 *   2. A antiga `§6d-site` não existe mais como header — só uma nota curta
 *      de redirecionamento, pra quem procurar pelo nome antigo.
 *   3. `§6b-site` invoca `publish-edition-site-page.ts` +
 *      `reconcile-site-sitemap.ts` (o mesmo mecanismo de sempre, só que
 *      mais cedo).
 *   4. Falha em `§6b-site` vira aviso (`SITE_PUBLISH_OK === false`) dentro
 *      do template do gate único (§6c) — nunca um 2º gate/halt separado.
 *   5. `§6b-site` nunca espera resposta do editor (não é uma 2ª parada) —
 *      cobertura complementar ao teste geral de "exatamente 1 gate" em
 *      test/single-gate-test-email-review-8205.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STAGE_6 = resolve(ROOT, ".claude/agents/orchestrator-stage-6.md");

describe("orchestrator-stage-6.md — §6b-site (publicação do site) roda antes do gate (#8221)", () => {
  const stage6 = readFileSync(STAGE_6, "utf8");

  it("existe um header '### 6b-site.' e ele vem ANTES de '### 6c.'", () => {
    const siteIdx = stage6.indexOf("### 6b-site.");
    const gateIdx = stage6.indexOf("### 6c.");
    assert.ok(siteIdx !== -1, "§6b-site não encontrada");
    assert.ok(gateIdx !== -1, "§6c não encontrada");
    assert.ok(siteIdx < gateIdx, "§6b-site deve vir ANTES de §6c — decisão do editor, #8221");
  });

  it("'### 6d-site.' não existe mais como header de seção (só pode sobrar menção em prosa/nota)", () => {
    const matches = stage6.match(/^### 6d-site\./gm) ?? [];
    assert.equal(matches.length, 0, "§6d-site não deveria mais existir como seção própria — foi movida pra §6b-site");
  });

  it("§6b-site invoca publish-edition-site-page.ts e reconcile-site-sitemap.ts", () => {
    const siteIdx = stage6.indexOf("### 6b-site.");
    const gateIdx = stage6.indexOf("### 6c.");
    const section = stage6.slice(siteIdx, gateIdx);
    assert.match(section, /publish-edition-site-page\.ts/);
    assert.match(section, /reconcile-site-sitemap\.ts/);
  });

  it("§6b-site documenta o trade-off aceito pelo editor (página pode ir ao ar mesmo com 'abortar' depois)", () => {
    const siteIdx = stage6.indexOf("### 6b-site.");
    const gateIdx = stage6.indexOf("### 6c.");
    const section = stage6.slice(siteIdx, gateIdx);
    assert.match(section, /#8221/);
    assert.match(section, /abortar/);
  });

  it("§6b-site NÃO espera resposta do editor (não é uma 2ª parada)", () => {
    const siteIdx = stage6.indexOf("### 6b-site.");
    const gateIdx = stage6.indexOf("### 6c.");
    const section = stage6.slice(siteIdx, gateIdx);
    assert.ok(!section.includes("Aguardar resposta do editor"));
  });

  it("o template do gate (§6c) inclui o aviso de SITE_PUBLISH_OK === false", () => {
    const gateIdx = stage6.indexOf("### 6c.");
    const sixDIdx = stage6.indexOf("### 6d.");
    const section = stage6.slice(gateIdx, sixDIdx);
    assert.match(section, /SITE_PUBLISH_OK === false/);
  });

  it("a antiga seção §6d (Schedule Beehiiv, pós-gate) não publica mais a página do site — só referencia §6b-site", () => {
    const sixDIdx = stage6.indexOf("### 6d.");
    const sixDKitIdx = stage6.indexOf("### 6d-kit.");
    const sixD = stage6.slice(sixDIdx, sixDKitIdx);
    assert.ok(!/publish-edition-site-page\.ts/.test(sixD), "§6d não deveria mais chamar publish-edition-site-page.ts");
  });

  it("guardar o resultado como SITE_PUBLISH_OK está documentado em §6b-site", () => {
    const siteIdx = stage6.indexOf("### 6b-site.");
    const gateIdx = stage6.indexOf("### 6c.");
    const section = stage6.slice(siteIdx, gateIdx);
    assert.match(section, /SITE_PUBLISH_OK/);
  });
});
