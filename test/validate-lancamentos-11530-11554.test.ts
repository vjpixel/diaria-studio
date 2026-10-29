import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateLancamentos,
  validateLancamentosFromApproved,
  demoteNotATool,
  hasProductSignal,
  isVerifiedTool,
  isUnverifiedNewsletterExtract,
  isAllowlistPathPattern,
  loadToolAllowlist,
  loadExtractConfirmedList,
} from "../scripts/validate-lancamentos.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Caso real da edição 261029: slug sem nome de produto, título com "now".
const REPLIT_URL = "https://replit.com/blog/anyone-can-bring-ideas-to-company-codebase";
const REPLIT_TITLE = "Anyone can now bring their ideas into the company codebase";

describe("#11530 post oficial de blog com verbo de disponibilidade no título", () => {
  it("caso Replit 261029 é ferramenta verificada sem allowlist", () => {
    assert.ok(hasProductSignal(REPLIT_URL, REPLIT_TITLE));
    assert.ok(isVerifiedTool(REPLIT_URL, REPLIT_TITLE, []));
  });

  it("modo MD (gate da Etapa 4) não acusa not_a_tool no caso Replit", () => {
    const md = ["**🚀 LANÇAMENTOS**", "", `**[${REPLIT_TITLE}](${REPLIT_URL})**`, "", "---"].join("\n");
    const r = validateLancamentos(md, []);
    assert.equal(r.not_a_tool.length, 0);
    assert.equal(r.status, "ok");
  });

  it("modo approved não rebaixa o caso Replit pra RADAR", () => {
    const approved = { lancamento: [{ url: REPLIT_URL, title: REPLIT_TITLE }], radar: [] };
    assert.equal(validateLancamentosFromApproved(approved, []).not_a_tool.length, 0);
    assert.equal(demoteNotATool(approved, []).demoted.length, 0);
  });

  it("mesmo slug SEM título continua not_a_tool (o sinal vem do título)", () => {
    assert.ok(!isVerifiedTool(REPLIT_URL, undefined, []));
  });

  it("verbo de disponibilidade fora de caminho de blog/news não basta", () => {
    assert.ok(!isVerifiedTool("https://replit.com/anyone-can-bring-ideas", REPLIT_TITLE, []));
  });

  it("caminho de blog sem verbo de disponibilidade no título não basta", () => {
    assert.ok(
      !isVerifiedTool(REPLIT_URL, "Anyone can bring their ideas into the company codebase", []),
    );
  });

  it("aceita changelog/news e verbo em português", () => {
    assert.ok(isVerifiedTool("https://exemplo.com/changelog/cloud-workspaces", "Já disponível para todos", []));
    assert.ok(isVerifiedTool("https://exemplo.com/news/x", "Agora você pode compartilhar sessões", []));
  });

  it("governança continua vencendo mesmo com verbo de disponibilidade", () => {
    assert.ok(
      !isVerifiedTool("https://openai.com/blog/public-policy-agenda", "Our policy agenda is now available", []),
    );
  });
});

describe("#11554 allowlist: padrão de caminho vs URL específica", () => {
  it("classifica as entradas", () => {
    assert.equal(isAllowlistPathPattern("replit.com/blog/"), true);
    assert.equal(isAllowlistPathPattern("blog.replit.com/"), true);
    assert.equal(isAllowlistPathPattern("replit.com"), true);
    assert.equal(isAllowlistPathPattern("cohere.com/blog/transcribe-arabic"), false);
  });

  const extract = {
    url: "https://replit.com/blog/some-unrelated-post",
    title: "Assunto do e-mail da newsletter",
    flag: "newsletter_extracted",
    verify_verdict: "uncertain",
  };

  it("allowlist de ferramenta (padrão de caminho) NÃO libera extrato de newsletter", () => {
    const { demoted } = demoteNotATool({ lancamento: [extract], radar: [] }, ["replit.com/blog/"]);
    assert.equal(demoted.length, 1);
    const summary = validateLancamentosFromApproved({ lancamento: [extract], radar: [] }, ["replit.com/blog/"]);
    assert.equal(summary.unverified_extract.length, 1);
  });

  it("allowlist de ferramenta (URL específica) também NÃO libera extrato", () => {
    // Regressão do #11554 item 1: a allowlist responde só "é ferramenta?".
    const allow = ["replit.com/blog/some-unrelated-post"];
    const { demoted } = demoteNotATool({ lancamento: [extract], radar: [] }, allow);
    assert.equal(demoted.length, 1);
    const summary = validateLancamentosFromApproved({ lancamento: [extract], radar: [] }, allow);
    assert.equal(summary.unverified_extract.length, 1);
  });

  it("lista de extrato confirmado libera a URL específica (#9292)", () => {
    const confirmed = ["replit.com/blog/some-unrelated-post"];
    assert.equal(isUnverifiedNewsletterExtract(extract, confirmed), false);
    // As duas perguntas respondidas, cada uma pela sua lista.
    const { demoted } = demoteNotATool({ lancamento: [extract], radar: [] }, ["replit.com/blog/"], confirmed);
    assert.equal(demoted.length, 0);
  });

  it("lista de extrato confirmado ignora padrão de caminho", () => {
    assert.equal(isUnverifiedNewsletterExtract(extract, ["replit.com/blog/"]), true);
    assert.equal(isUnverifiedNewsletterExtract(extract, ["replit.com"]), true);
  });

  it("lista real de extrato confirmado carrega sem padrões nem comentários", () => {
    for (const a of loadExtractConfirmedList(ROOT)) {
      assert.ok(!/\s/.test(a), `entrada com espaço (comentário vazou?): ${a}`);
      assert.ok(!isAllowlistPathPattern(a), `padrão de caminho na lista: ${a}`);
    }
  });

  it("allowlist real cobre o caminho atual replit.com/blog/", () => {
    assert.ok(loadToolAllowlist(ROOT).includes("replit.com/blog/"));
  });

  it("padrão de caminho continua respondendo 'é ferramenta'", () => {
    assert.ok(isVerifiedTool("https://replit.com/blog/qualquer-coisa", undefined, ["replit.com/blog/"]));
  });

  it("allowlist real cobre links antigos de blog.replit.com", () => {
    const allow = loadToolAllowlist(ROOT);
    assert.ok(allow.includes("blog.replit.com/"));
    assert.ok(isVerifiedTool("https://blog.replit.com/some-old-post", undefined, allow));
  });

  it("comentários do cabeçalho não viram entradas", () => {
    for (const a of loadToolAllowlist(ROOT)) {
      assert.ok(!/\s/.test(a), `entrada com espaço (comentário vazou?): ${a}`);
    }
  });
});
