/**
 * test/check-invariants-stage-6.test.ts (#4574)
 *
 * Cobertura dedicada do Stage 6 (#1007 Fase 1, `scripts/lib/invariant-checks/stage-6.ts`)
 * — nenhum teste direto existia antes desta PR (`check-invariants-stage.test.ts`
 * cobre stages 0-5). Foco principal: a regra nova `whatsapp-slug-guard-ok`
 * (#4570 fechado com backstop determinístico em #4574) — sem ela, o guard
 * GATE-BLOCKING de slug do bloco WhatsApp dependia 100% de um agente LLM ler
 * e seguir a prosa do orchestrator, sem nenhuma verificação em código de que
 * o guard rodou, rodou corretamente, ou passou (achado convergente
 * pr-test-analyzer + silent-failure-hunter no review consolidado da PR #4574).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STAGE_6_RULES,
  checkStep5Sentinel,
  checkScheduledAt,
  checkEditionReport,
  checkWhatsappSlugGuard,
  checkStep6Sentinel,
  checkSitePagePublished,
  checkSitePagePrMerged,
  buildKitDraftStaleMessage,
  buildKitDraftRefreshInstructions,
  readKitDiariaState,
  isBrevoDiariaActiveForEdition,
} from "../scripts/lib/invariant-checks/stage-6.ts";
import { getRulesForStage } from "../scripts/lib/invariant-checks/index.ts";

function makeFixtureEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-invariants-stage6-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

describe("STAGE_6_RULES registry (#4574)", () => {
  it("contém a entry whatsapp-slug-guard-ok, stage 6, source_issue #4574", () => {
    const entry = STAGE_6_RULES.find((r) => r.id === "whatsapp-slug-guard-ok");
    assert.ok(entry !== undefined, "STAGE_6_RULES deve conter 'whatsapp-slug-guard-ok'");
    assert.equal(entry!.stage, 6);
    assert.equal(entry!.source_issue, "#4574");
  });

  it("getRulesForStage(6) inclui whatsapp-slug-guard-ok junto das demais 5 regras pré-existentes", () => {
    const rules = getRulesForStage(6);
    const ids = rules.map((r) => r.id);
    assert.ok(ids.includes("step-5-sentinel-exists"));
    assert.ok(ids.includes("scheduled-at-present"));
    assert.ok(ids.includes("edition-report-exists"));
    assert.ok(ids.includes("whatsapp-slug-guard-ok"));
    assert.ok(ids.includes("step-6-sentinel-exists"));
    assert.ok(ids.includes("site-page-published"));
    assert.ok(ids.includes("site-sitemap-no-orphans"));
    assert.ok(ids.includes("sync-code-ran"));
    assert.ok(ids.includes("kit-draft-fresh"));
    assert.ok(ids.includes("site-page-pr-merged"));
    assert.equal(ids.length, 10, `esperava 10 regras no Stage 6, achei: ${JSON.stringify(ids)}`);
  });

  it("contém a entry site-page-published, stage 6, source_issue #7578 (GATE-BLOCKING desde a decisão do editor de 07/09/2026)", () => {
    const entry = STAGE_6_RULES.find((r) => r.id === "site-page-published");
    assert.ok(entry !== undefined, "STAGE_6_RULES deve conter 'site-page-published'");
    assert.equal(entry!.stage, 6);
    assert.equal(entry!.source_issue, "#7578");
  });
});

describe("checkWhatsappSlugGuard (#4574)", () => {
  let fixture: string;

  beforeEach(() => {
    fixture = makeFixtureEdition();
  });

  it("falha quando whatsapp-slug-check.json ausente — guard não rodou (silêncio ≠ passou)", () => {
    const v = checkWhatsappSlugGuard(fixture, "beehiiv");
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "whatsapp-slug-guard-ok");
    assert.equal(v[0].severity, "error");
    assert.equal(v[0].source_issue, "#4574");
    assert.match(v[0].message, /não rodou/);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("passa quando whatsapp-slug-check.json existe com ok:true", () => {
    writeFileSync(
      join(fixture, "_internal", "whatsapp-slug-check.json"),
      JSON.stringify({
        ok: true,
        expectedSlug: "titulo-do-d1",
        actualSlug: "titulo-do-d1",
        checkedAt: new Date().toISOString(),
      }),
    );
    const v = checkWhatsappSlugGuard(fixture, "beehiiv");
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("falha quando whatsapp-slug-check.json existe com ok:false (guard rodou e detectou divergência)", () => {
    writeFileSync(
      join(fixture, "_internal", "whatsapp-slug-check.json"),
      JSON.stringify({
        ok: false,
        expectedSlug: "hacker-chines-usa-deepseek",
        actualSlug: "hacker-chin-s-usa-deepseek",
        checkedAt: new Date().toISOString(),
      }),
    );
    const v = checkWhatsappSlugGuard(fixture, "beehiiv");
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "whatsapp-slug-guard-ok");
    assert.equal(v[0].severity, "error");
    assert.match(v[0].message, /hacker-chines-usa-deepseek/);
    assert.match(v[0].message, /hacker-chin-s-usa-deepseek/);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("falha quando o arquivo existe mas não é JSON parseável", () => {
    writeFileSync(join(fixture, "_internal", "whatsapp-slug-check.json"), "{ not valid json");
    const v = checkWhatsappSlugGuard(fixture, "beehiiv");
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "whatsapp-slug-guard-parseable");
    assert.equal(v[0].severity, "error");
    rmSync(fixture, { recursive: true, force: true });
  });

  it("falha quando ok está ausente do JSON (shape inesperado — não confundir com true)", () => {
    writeFileSync(
      join(fixture, "_internal", "whatsapp-slug-check.json"),
      JSON.stringify({ expectedSlug: "foo" }),
    );
    const v = checkWhatsappSlugGuard(fixture, "beehiiv");
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "whatsapp-slug-guard-ok");
    rmSync(fixture, { recursive: true, force: true });
  });

  // #7388 (achado ao vivo, edição 260904): backend "kit" pula esta checagem
  // inteira — §6d do orchestrator-stage-6.md documenta que o problema de
  // slug da UI da Beehiiv não tem equivalente no Kit. Sem este skip, o
  // check bloqueava o Stage 6 de TODA edição desde a migração de backend em
  // #7388, mesmo com o arquivo nunca devendo existir nesse caminho.
  it("backend kit: passa mesmo com whatsapp-slug-check.json ausente (checagem não se aplica)", () => {
    const v = checkWhatsappSlugGuard(fixture, "kit");
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });
});

describe("demais regras do Stage 6 — cobertura básica (nenhum teste direto existia antes do #4574)", () => {
  let fixture: string;

  beforeEach(() => {
    fixture = makeFixtureEdition();
  });

  it("checkStep5Sentinel falha quando .step-5-done.json ausente", () => {
    const v = checkStep5Sentinel(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "step-5-sentinel-exists");
    rmSync(fixture, { recursive: true, force: true });
  });

  it("checkStep5Sentinel passa quando presente", () => {
    writeFileSync(join(fixture, "_internal", ".step-5-done.json"), JSON.stringify({ done: true }));
    const v = checkStep5Sentinel(fixture);
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("checkScheduledAt falha quando 05-published.json ausente", () => {
    const v = checkScheduledAt(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "scheduled-at-present");
    rmSync(fixture, { recursive: true, force: true });
  });

  it("checkScheduledAt falha quando 05-published.json não tem scheduled_at nem status=published", () => {
    writeFileSync(join(fixture, "_internal", "05-published.json"), JSON.stringify({ post_id: "x" }));
    const v = checkScheduledAt(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "scheduled-at-present");
    rmSync(fixture, { recursive: true, force: true });
  });

  // #6114 (switchover, 26/08/2026): este caso passava `backend` implícito e
  // lia `platform.config.json` REAL — verde só enquanto o default do repo
  // fosse "beehiiv". Virar a chave pro Kit quebrou o teste sem que nada em
  // `checkScheduledAt` mudasse, que é a definição de teste acoplado à forma do
  // ambiente (#6222). Agora injeta o backend, como os casos "kit"/"beehiiv
  // explícito" abaixo já faziam.
  it("checkScheduledAt passa com scheduled_at presente (backend beehiiv)", () => {
    writeFileSync(
      join(fixture, "_internal", "05-published.json"),
      JSON.stringify({ scheduled_at: "2026-08-05T09:00:00Z" }),
    );
    const v = checkScheduledAt(fixture, "beehiiv");
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  // #464 (achado do review, PR #6096): antes desta PR, checkScheduledAt só
  // olhava pra 05-published.json — bloqueava severity=error TODA edição
  // com backend "kit" (que nunca escreve esse arquivo), independente do
  // Schedule do Kit ter funcionado ou não. `backendOverride` (2º arg, só
  // pra teste — produção sempre lê platform.config.json de verdade).
  it("backend kit: falha quando newsletter-kit-published.json ausente (não olha mais 05-published.json)", () => {
    const v = checkScheduledAt(fixture, "kit");
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "scheduled-at-present");
    assert.match(v[0].message, /newsletter-kit-published\.json/);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("backend kit: falha quando newsletter-kit-published.json não tem scheduled_at nem status=scheduled", () => {
    writeFileSync(join(fixture, "_internal", "newsletter-kit-published.json"), JSON.stringify({ broadcast_id: 42, status: "draft" }));
    const v = checkScheduledAt(fixture, "kit");
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "scheduled-at-present");
    rmSync(fixture, { recursive: true, force: true });
  });

  it("backend kit: falha quando status='published' (status Kit do caminho feliz é 'scheduled', não 'published' como Beehiiv)", () => {
    writeFileSync(join(fixture, "_internal", "newsletter-kit-published.json"), JSON.stringify({ broadcast_id: 42, status: "published" }));
    const v = checkScheduledAt(fixture, "kit");
    assert.equal(v.length, 1, "status='published' não é um status Kit válido — só 'scheduled' ou scheduled_at presente");
    rmSync(fixture, { recursive: true, force: true });
  });

  it("backend kit: passa com scheduled_at presente", () => {
    writeFileSync(
      join(fixture, "_internal", "newsletter-kit-published.json"),
      JSON.stringify({ broadcast_id: 42, scheduled_at: "2026-08-26T09:00:00Z" }),
    );
    const v = checkScheduledAt(fixture, "kit");
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("backend kit: passa com status='scheduled' mesmo sem scheduled_at (idempotência do #6096 já cobre o caso real)", () => {
    writeFileSync(join(fixture, "_internal", "newsletter-kit-published.json"), JSON.stringify({ broadcast_id: 42, status: "scheduled" }));
    const v = checkScheduledAt(fixture, "kit");
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  // #6114: era "comportamento idêntico ao default (sem override)". Depois que
  // o caso acima passou a injetar "beehiiv", os dois viraram o MESMO teste —
  // e o que este afirmava (paridade com o default implícito) deixou de ser
  // verificável sem ler o config real, que é justamente o acoplamento removido.
  it("backend beehiiv explícito: 05-published.json com scheduled_at basta", () => {
    writeFileSync(join(fixture, "_internal", "05-published.json"), JSON.stringify({ status: "published" }));
    const v = checkScheduledAt(fixture, "beehiiv");
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("checkEditionReport falha quando edition-report.html ausente", () => {
    const v = checkEditionReport(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "edition-report-exists");
    rmSync(fixture, { recursive: true, force: true });
  });

  it("checkStep6Sentinel falha quando .step-6-done.json ausente", () => {
    const v = checkStep6Sentinel(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "step-6-sentinel-exists");
    rmSync(fixture, { recursive: true, force: true });
  });
});

describe("checkSitePagePublished (#7283) — REGRESSÃO: fail-soft do §6d-site precisa ficar VISÍVEL", () => {
  let fixture: string;

  beforeEach(() => {
    fixture = makeFixtureEdition();
  });

  // #7578 inverteu a direção desta asserção, e o motivo precisa ficar no
  // teste: o `warning` original era fail-soft deliberado (#6202, site
  // acessório ao envio), mas o próprio nome deste teste registrava que
  // "ninguém percebeu por 4 edições". Depois disso o silêncio custou mais 12
  // dias de acervo parado (#7578). Decisão do editor em 07/09/2026: travar o
  // gate. O fail-soft do SCRIPT continua — quem passou a bloquear é o gate.
  it("REGRESSÃO #7578: error (não mais warning) quando site-page-published.json ausente — o passo nunca rodou, e o warning já provou que ninguém lê (#7283/#7266)", () => {
    const v = checkSitePagePublished(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "site-page-published");
    assert.equal(v[0].severity, "error", "decisão do editor 07/09/2026 (#7578) — o gate 6 trava até a página existir");
    assert.equal(v[0].source_issue, "#7578");
    assert.match(v[0].message, /não rodou/);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("REGRESSÃO #7578: error quando published:false (commit/push/gh pr create falhou) — o caso real do incidente de 260904", () => {
    writeFileSync(
      join(fixture, "_internal", "site-page-published.json"),
      JSON.stringify({
        code: 3,
        slug: "gates-propoe-empregos-so-para-humanos",
        published: false,
        reason: "checkout não está sincronizado com origin/master",
        checked_at: new Date().toISOString(),
      }),
    );
    const v = checkSitePagePublished(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "site-page-published");
    assert.equal(v[0].severity, "error");
    assert.match(v[0].message, /gates-propoe-empregos-so-para-humanos/);
    assert.match(v[0].message, /checkout não está sincronizado/);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("#10160: published:true + merged:false não é mais assunto desta regra — virou site-page-pr-merged", () => {
    writeFileSync(
      join(fixture, "_internal", "site-page-published.json"),
      JSON.stringify({ code: 0, slug: "abc", published: true, merged: false }),
    );
    assert.deepEqual(checkSitePagePublished(fixture), []);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("passa (0 violations) quando published:true — página escrita, branch pushada, PR aberto/reusado", () => {
    writeFileSync(
      join(fixture, "_internal", "site-page-published.json"),
      JSON.stringify({
        code: 0,
        slug: "titulo-da-edicao",
        published: true,
        prUrl: "https://github.com/vjpixel/diaria-studio/pull/1",
        checked_at: new Date().toISOString(),
      }),
    );
    const v = checkSitePagePublished(fixture);
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("passa (0 violations) quando code:2 — nada a publicar ainda, não é falha de publish", () => {
    writeFileSync(
      join(fixture, "_internal", "site-page-published.json"),
      JSON.stringify({ code: 2, published: false, reason: "nada a publicar ainda", checked_at: new Date().toISOString() }),
    );
    const v = checkSitePagePublished(fixture);
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  // Estado DESCONHECIDO segue a mesma direção segura do artefato ausente
  // (#7578): não dá para afirmar que a página foi publicada.
  it("error quando o arquivo existe mas não é JSON parseável", () => {
    writeFileSync(join(fixture, "_internal", "site-page-published.json"), "{ not valid json");
    const v = checkSitePagePublished(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "site-page-published-parseable");
    assert.equal(v[0].severity, "error");
    rmSync(fixture, { recursive: true, force: true });
  });
});

describe("checkSitePagePrMerged (#10160) — a Etapa 6 não termina com o PR do site aberto", () => {
  let fixture: string;
  beforeEach(() => {
    fixture = makeFixtureEdition();
  });
  const writeState = (state: Record<string, unknown>) =>
    writeFileSync(join(fixture, "_internal", "site-page-published.json"), JSON.stringify(state));
  const openPr = {
    code: 0,
    slug: "abc",
    published: true,
    prUrl: "https://github.com/vjpixel/diaria-studio/pull/9415",
    prNumber: 9415,
    status: "open",
    merged: false,
    mergeBlocker: "BLOQUEIO: CI não convergiu em 0ms — PR #9415 aberto",
  };

  it("REGRESSÃO #10160: PR OPEN → error bloqueante (recusa o sentinel do Stage 6)", () => {
    writeState(openPr);
    const v = checkSitePagePrMerged(fixture, () => "OPEN");
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "site-page-pr-merged");
    assert.equal(v[0].severity, "error");
    assert.equal(v[0].source_issue, "#10160");
    assert.match(v[0].message, /OPEN/);
    assert.match(v[0].message, /check-site-page-pr-gate\.ts/);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("PR MERGED ao vivo (state defasado) → 0 violations, consultando a URL registrada", () => {
    writeState(openPr);
    const asked: string[] = [];
    const v = checkSitePagePrMerged(fixture, (url) => {
      asked.push(url);
      return "MERGED";
    });
    assert.deepEqual(asked, ["https://github.com/vjpixel/diaria-studio/pull/9415"]);
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("merged:true gravado → 0 violations sem consultar o gh", () => {
    writeState({ ...openPr, merged: true, status: "merged" });
    const v = checkSitePagePrMerged(fixture, () => {
      throw new Error("não deveria consultar");
    });
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("PR CLOSED sem merge → error", () => {
    writeState(openPr);
    const v = checkSitePagePrMerged(fixture, () => "CLOSED");
    assert.equal(v.length, 1);
    assert.match(v[0].message, /CLOSED/);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("gh falha (null ou lança) → error: estado desconhecido nunca vira mergeado (#573)", () => {
    writeState(openPr);
    for (const fetcher of [() => null, () => { throw new Error("gh: command not found"); }]) {
      const v = checkSitePagePrMerged(fixture, fetcher);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "error");
      assert.match(v[0].message, /DESCONHECIDO/);
    }
    rmSync(fixture, { recursive: true, force: true });
  });

  it("merged:false sem prUrl (PR não identificado) → error, sem consultar o gh", () => {
    writeState({ code: 0, slug: "abc", published: true, merged: false });
    let called = false;
    const v = checkSitePagePrMerged(fixture, () => {
      called = true;
      return "MERGED";
    });
    assert.equal(called, false);
    assert.equal(v.length, 1);
    assert.match(v[0].message, /site-publish\/abc/);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("fora do escopo (já é site-page-published ou legado): ausente, ilegível, code 2, published:false, sem merged nem prUrl", () => {
    const never = () => {
      throw new Error("não deveria consultar");
    };
    assert.deepEqual(checkSitePagePrMerged(fixture, never), []);
    writeFileSync(join(fixture, "_internal", "site-page-published.json"), "{ not json");
    assert.deepEqual(checkSitePagePrMerged(fixture, never), []);
    writeState({ code: 2, published: false });
    assert.deepEqual(checkSitePagePrMerged(fixture, never), []);
    writeState({ code: 3, published: false, prUrl: openPr.prUrl });
    assert.deepEqual(checkSitePagePrMerged(fixture, never), []);
    writeState({ code: 0, published: true, slug: "abc" });
    assert.deepEqual(checkSitePagePrMerged(fixture, never), []);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("registrada no Stage 6 sem postDispatchOnly — é ela que trava o pipeline-sentinel write --step 6", () => {
    const entry = STAGE_6_RULES.find((r) => r.id === "site-page-pr-merged");
    assert.ok(entry, "STAGE_6_RULES deve conter site-page-pr-merged");
    assert.equal(entry!.stage, 6);
    assert.ok(!entry!.postDispatchOnly, "postDispatchOnly tiraria a regra do write do sentinel (phase pre-dispatch)");
    assert.ok(getRulesForStage(6, { phase: "pre-dispatch" }).some((r) => r.id === "site-page-pr-merged"));
  });
});

describe("kit-draft-fresh — mensagem nomeia todo canal ativo (#9442)", () => {
  const base = { what: "02-reviewed.md", when: "2026-10-02T10:00:00Z", editionDir: "data/editions/261002" };

  it("Brevo diária desligada → só o re-run do Kit", () => {
    const msg = buildKitDraftStaleMessage({ ...base, brevoDiariaEnabled: false });
    assert.ok(msg.includes("npx tsx scripts/publish-newsletter-kit.ts data/editions/261002 --send-test"));
    assert.ok(!msg.includes("publish-daily-brevo.ts"), "sem brevo_diaria não manda rodar a Brevo");
    assert.match(msg, /02-reviewed\.md/);
  });

  it("Brevo diária ligada → Kit E Brevo diária, com o comando exato da Brevo", () => {
    const msg = buildKitDraftStaleMessage({ ...base, brevoDiariaEnabled: true });
    assert.ok(msg.includes("npx tsx scripts/publish-newsletter-kit.ts data/editions/261002 --send-test"));
    assert.ok(
      msg.includes("npx tsx scripts/publish-daily-brevo.ts data/editions/261002 --i-reviewed-the-copy --send-test"),
      "comando copiável da Brevo diária com a flag obrigatória --i-reviewed-the-copy",
    );
    assert.match(msg, /Brevo diária/);
    assert.ok(!msg.includes("--force"), "--force criaria campanha duplicada — nunca sugerir");
  });
});

// #10411: desde o #10395 o caminho preferido de novo teste é o Send test da UI
// sobre o rascunho real; a mensagem só sugeria `--send-test` (que cria o
// broadcast descartável que o #10395 quis eliminar e troca test_mode).
describe("kit-draft-fresh — correção aponta pro teste pela UI, --send-test só fallback (#10411)", () => {
  const base = { what: "02-reviewed.md", when: "2026-10-02T10:00:00Z", editionDir: "data/editions/261002" };

  it("com e sem Brevo diária: preferido --draft-only-for-ui-test + Send test + --mark-ui-test-sent, antes do --send-test", () => {
    for (const brevo of [false, true]) {
      const msg = buildKitDraftStaleMessage({ ...base, brevoDiariaEnabled: brevo });
      const pref = msg.indexOf("npx tsx scripts/publish-newsletter-kit.ts data/editions/261002 --draft-only-for-ui-test");
      const mark = msg.indexOf("npx tsx scripts/publish-newsletter-kit.ts data/editions/261002 --mark-ui-test-sent --at");
      const fallback = msg.indexOf("npx tsx scripts/publish-newsletter-kit.ts data/editions/261002 --send-test");
      assert.ok(pref >= 0 && mark > pref, "caminho da UI presente e na ordem");
      assert.ok(fallback > mark, "--send-test aparece só depois, como fallback");
      assert.match(msg, /Send test email/);
      assert.match(msg, /nunca Send\/Schedule\/Continue/);
      assert.match(msg, /fallback só sem Chrome/);
    }
  });

  it("buildKitDraftRefreshInstructions usa o path real da edição", () => {
    const s = buildKitDraftRefreshInstructions("data/editions/2610/261018");
    assert.ok(s.includes("publish-newsletter-kit.ts data/editions/2610/261018 --draft-only-for-ui-test"));
    assert.ok(!s.includes("{EDITION_DIR}"));
  });
});

describe("kit-draft-fresh — Kit diária nomeada quando o estado existe (#9445)", () => {
  const base = { what: "02-reviewed.md", when: "2026-10-02T10:00:00Z", editionDir: "data/editions/261002" };

  it("sem estado da Kit diária → não menciona o canal", () => {
    for (const brevo of [false, true]) {
      const msg = buildKitDraftStaleMessage({ ...base, brevoDiariaEnabled: brevo, kitDiaria: null });
      assert.ok(!msg.includes("kit-diaria-stage5-dispatch.ts"));
    }
  });

  it("com estado → comando exato + apagar broadcast e estado (re-run sozinho é no-op)", () => {
    for (const brevo of [false, true]) {
      const msg = buildKitDraftStaleMessage({ ...base, brevoDiariaEnabled: brevo, kitDiaria: { broadcastId: 777 } });
      assert.ok(msg.includes("`npx tsx scripts/kit-diaria-stage5-dispatch.ts data/editions/261002`"));
      assert.ok(!msg.includes("kit-diaria-stage5-dispatch.ts data/editions/261002 --send-test"), "--send-test não grava estado — nunca é o comando de recriação");
      assert.ok(msg.includes("data/editions/261002/_internal/kit-diaria-published.json"));
      assert.match(msg, /broadcast 777/);
      assert.match(msg, /Kit diária/);
      assert.ok(msg.includes("publish-newsletter-kit.ts"), "Kit principal continua nomeado");
    }
  });

  it("readKitDiariaState lê o broadcast_id do arquivo da edição", () => {
    const dir = mkdtempSync(join(tmpdir(), "kd-9445-"));
    assert.equal(readKitDiariaState(dir), null);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "kit-diaria-published.json"), JSON.stringify({ broadcast_id: 42 }));
    assert.deepEqual(readKitDiariaState(dir), { broadcastId: 42 });
    writeFileSync(join(dir, "_internal", "kit-diaria-published.json"), "{quebrado");
    assert.deepEqual(readKitDiariaState(dir), { broadcastId: null });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("isBrevoDiariaActiveForEdition (#9442, review PR #9444)", () => {
  it("só conta como ativa se o publisher gravou brevo-diaria-published.json nesta edição (--skip brevo → não manda rodar)", () => {
    const dir = makeFixtureEdition();
    try {
      assert.equal(isBrevoDiariaActiveForEdition(dir), false, "config com brevo_diaria não basta — sem estado, canal foi pulado");
      writeFileSync(join(dir, "_internal", "brevo-diaria-published.json"), JSON.stringify({ campaign_id: 42, status: "draft" }));
      assert.equal(isBrevoDiariaActiveForEdition(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
