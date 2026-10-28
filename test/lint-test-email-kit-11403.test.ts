/**
 * #11403 — falsos positivos do lint do e-mail de teste no backend Kit.
 *
 * Fixture: o e-mail de teste REAL da 261028 como o Gmail devolveu (fallback
 * `--send-test`), com o token de assinante, o prefixo da conta e o endereço
 * do destinatário trocados por valores fictícios (o voto do É IA? foi
 * re-codificado em base64url com `leitor@example.com`). Nada mais mudou.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeSubject,
  checkSubject,
  checkKitVoteMergeTag,
  runLints,
} from "../scripts/lint-test-email.ts";
import {
  extractEmailStructure,
  extractMdStructure,
  compareStructure,
} from "../scripts/lint-test-email-structure.ts";
import { decodeKitClickUrl, isKitClickUrl } from "../scripts/lib/kit-click-url.ts";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/kit-delivered-test-email-11403");
const KIT_EMAIL = readFileSync(resolve(DIR, "test-email-261028.html"), "utf8");
const SOURCE_MD = readFileSync(resolve(DIR, "02-reviewed-261028.md"), "utf8");
const TITLE = "OpenAI lança GPT-6.1 Terra pela metade do preço";

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const kitLink = (dest: string) =>
  `https://0f1x7ure.click.kit-mail3.com/fixturetoken/abc123/${b64url(dest)}`;

describe("normalizeSubject — prefixo do Kit (#11403)", () => {
  it("remove '[teste] ' minúsculo do Kit", () => {
    assert.equal(normalizeSubject(`[teste] ${TITLE}`), TITLE);
  });
  it("remove '[TESTE] ' em qualquer caixa", () => {
    assert.equal(normalizeSubject(`[Teste]   ${TITLE}`), TITLE);
  });
  it("segue removendo o '[TEST] ' da Beehiiv", () => {
    assert.equal(normalizeSubject(`[TEST] [TEST] ${TITLE}`), TITLE);
  });
  it("não remove colchete que não é prefixo de teste", () => {
    assert.equal(normalizeSubject(`[testes] ${TITLE}`), `[testes] ${TITLE}`);
  });
  it("checkSubject: '[teste] {título}' do Kit não é subject_mismatch", () => {
    assert.equal(checkSubject(`[teste] ${TITLE}`, TITLE), null);
  });
  it("checkSubject: título errado atrás do '[teste] ' continua blocker", () => {
    const issue = checkSubject("[teste] Outro título", TITLE);
    assert.equal(issue?.category, "subject_mismatch");
  });
});

describe("extractEmailStructure — HTML entregue pelo Kit (#11403)", () => {
  const email = extractEmailStructure(KIT_EMAIL);

  it("lê os 3 destaques na ordem", () => {
    assert.deepEqual(email.destaques, [
      TITLE,
      "Apple solta a nova Siri em português no iOS 27.2",
      "Modelo da OpenAI fugiu para a internet no treino",
    ]);
  });

  it("conta itens por seção (RADAR 4, USE MELHOR 3)", () => {
    assert.deepEqual(email.sections, [
      { name: "RADAR", item_count: 4 },
      { name: "USE MELHOR", item_count: 3 },
    ]);
  });

  it("kicker '● LANÇAMENTO' do destaque não vira seção LANÇAMENTOS fantasma", () => {
    assert.equal(email.sections.some((s) => s.name === "LANÇAMENTOS"), false);
  });

  it("estrutura bate com o source da 261028 (zero achados)", () => {
    const source = extractMdStructure(SOURCE_MD);
    assert.equal(source.destaques.length, 3);
    assert.deepEqual(compareStructure(source, email), []);
  });

  it("destaque faltando no e-mail agora vira destaque_count_mismatch", () => {
    const start = KIT_EMAIL.indexOf("<!-- Destaque 3 -->");
    const end = KIT_EMAIL.indexOf("<!-- ", start + 10);
    assert.ok(start > 0 && end > start);
    const cut = KIT_EMAIL.slice(0, start) + KIT_EMAIL.slice(end);
    const issues = compareStructure(extractMdStructure(SOURCE_MD), extractEmailStructure(cut));
    assert.equal(issues.some((i) => i.type === "destaque_count_mismatch"), true);
  });

  it("HTML sem `class=\"headline\"` (header de seção seguido de outro `<h2>`): nenhum header vira kicker", () => {
    // Formato mínimo do #8635: `<h2>📡 RADAR</h2>` seguido do item e do próximo
    // header `<h2>` — antes da correção, o `<h2>` seguinte fazia o RADAR ser
    // descartado como kicker de destaque (section_missing falso).
    const html =
      "<html><body><h2>📡 RADAR</h2><a href='https://a.com/1'>Item um</a>" +
      "<h2>🛠️ USE MELHOR</h2><a href='https://b.com/1'>Tutorial</a></body></html>";
    const snap = extractEmailStructure(html);
    assert.deepEqual(snap.sections.map((s) => s.name), ["RADAR", "USE MELHOR"]);
    assert.deepEqual(snap.destaques, []);
  });

  it("seção realmente ausente continua acusada (RADAR removido)", () => {
    // O espaço entre o ponto e o nome é U+00A0 no HTML entregue (`&nbsp;` decodificado).
    const html = KIT_EMAIL.replace(/<span style="color:#00A0A0;">●<\/span>\s*RADAR/, "");
    assert.notEqual(html, KIT_EMAIL);
    const issues = compareStructure(extractMdStructure(SOURCE_MD), extractEmailStructure(html));
    assert.equal(issues.some((i) => i.type === "section_missing" && i.section === "RADAR"), true);
  });
});

describe("decodeKitClickUrl (#11403)", () => {
  it("decodifica o destino em base64url do último segmento", () => {
    const dest = "https://openai.com/index/introducing-gpt-6-1-terra/";
    assert.equal(decodeKitClickUrl(kitLink(dest)), dest);
  });
  it("URL fora do Kit → null", () => {
    assert.equal(isKitClickUrl("https://example.com/a"), false);
    assert.equal(decodeKitClickUrl("https://example.com/YWJj"), null);
  });
  it("segmento que não decodifica pra URL → null", () => {
    assert.equal(decodeKitClickUrl("https://x.click.kit-mail3.com/t/i/naoeurl"), null);
  });
  it("no e-mail real, o voto do É IA? decodifica com a merge tag expandida", () => {
    const hrefs = [...KIT_EMAIL.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    const votes = hrefs.map((h) => decodeKitClickUrl(h)).filter((d) => d && /\/vote\//.test(d));
    assert.deepEqual(votes.sort(), [
      "https://eia.diar.ia.br/vote/261028/A?email=leitor%40example.com",
      "https://eia.diar.ia.br/vote/261028/B?email=leitor%40example.com",
    ]);
  });
});

describe("checkKitVoteMergeTag (#11403)", () => {
  it("e-mail real do Kit com a tag expandida → sem achado", () => {
    assert.equal(checkKitVoteMergeTag(KIT_EMAIL), null);
  });
  it("tag Liquid literal no voto embrulhado pelo Kit → blocker", () => {
    const html = `<a href="${kitLink("https://eia.diar.ia.br/vote/261028/A?email={{ subscriber.email_address }}")}">A</a>`;
    const issue = checkKitVoteMergeTag(html);
    assert.equal(issue?.type, "blocker");
    assert.equal(issue?.category, "vote_merge_tag_unresolved");
  });
  it("tag percent-encoded no voto → blocker", () => {
    const html = `<a href="${kitLink("https://eia.diar.ia.br/vote/261028/B?email=%7B%7B%20subscriber.email_address%20%7D%7D")}">B</a>`;
    assert.equal(checkKitVoteMergeTag(html)?.category, "vote_merge_tag_unresolved");
  });
  it("email vazio no voto → blocker", () => {
    const html = `<a href="${kitLink("https://eia.diar.ia.br/vote/261028/A?email=")}">A</a>`;
    assert.equal(checkKitVoteMergeTag(html)?.type, "blocker");
  });
  it("voto NÃO embrulhado pelo Kit (Beehiiv) é ignorado — coberto pelo link-tracking (#6608)", () => {
    const html = `<a href="https://eia.diar.ia.br/vote/261028/A?email={{email}}">A</a>`;
    assert.equal(checkKitVoteMergeTag(html), null);
  });
  it("runLints no e-mail real do Kit com subject '[teste] …' → zero blockers", () => {
    const r = runLints(KIT_EMAIL, SOURCE_MD, "261028", [], {
      received: `[teste] ${TITLE}`,
      expected: TITLE,
    });
    assert.equal(r.issues.filter((i) => i.category === "subject_mismatch").length, 0);
    assert.equal(r.issues.filter((i) => i.category === "vote_merge_tag_unresolved").length, 0);
  });
});
