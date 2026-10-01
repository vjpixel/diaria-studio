import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  stripHtmlToText,
  checkEncoding,
  stripSectionHeaderEmojis,
} from "../scripts/lint-test-email-encoding.ts";

describe("stripHtmlToText (#1248)", () => {
  it("remove tags + decoda entities", () => {
    const html = "<p>R$84&nbsp;mil &amp; outras</p>";
    const t = stripHtmlToText(html);
    assert.match(t, /R\$84\s+mil\s*&\s*outras/);
  });

  it("remove <style> e <script>", () => {
    const html = "<style>p {color:red}</style><p>texto</p><script>alert(1)</script>";
    const t = stripHtmlToText(html);
    assert.doesNotMatch(t, /color:red/);
    assert.doesNotMatch(t, /alert/);
    assert.match(t, /texto/);
  });

  it("decoda numeric entities", () => {
    const html = "<p>&#225;rea</p>"; // á = 0xE1 = 225
    assert.match(stripHtmlToText(html), /área/);
  });

  it("decoda hex entities", () => {
    const html = "<p>&#xE3;</p>"; // ã = 0xE3
    assert.match(stripHtmlToText(html), /ã/);
  });
});

describe("checkEncoding (#1248)", () => {
  it("retorna [] quando todos os chars especiais aparecem no email", () => {
    const source = "Cobertura de IA com ênfase técnica e ação";
    const email = "Cobertura de IA com ênfase técnica e ação";
    assert.deepEqual(checkEncoding(source, email), []);
  });

  it("char_dropped quando char não aparece nem com substituto", () => {
    const source = "emoji 🎉 importante";
    const email = "emoji importante"; // emoji removido sem substituto
    const r = checkEncoding(source, email);
    assert.equal(r.length, 1);
    assert.equal(r[0].type, "char_dropped");
    assert.equal(r[0].char, "🎉");
  });

  it("char_substituted quando ASCII fallback presente", () => {
    const source = "publicação";
    const email = "publicacao"; // ç → c, ã → a
    const r = checkEncoding(source, email);
    // 2 substituições detectadas (ç→c, ã→a)
    assert.ok(r.length >= 1);
    for (const i of r) {
      assert.equal(i.type, "char_substituted");
      assert.ok(i.email_substitute);
    }
  });

  it("detecta drop de aspas tipográficas → ASCII", () => {
    const source = "ele disse “isso aqui”"; // smart quotes
    const email = 'ele disse "isso aqui"'; // ASCII quotes
    const r = checkEncoding(source, email);
    // pelo menos 1 char_substituted (smart quote → ASCII)
    assert.ok(r.length > 0);
  });

  it("contexto inclui ~20 chars antes/depois", () => {
    const source = "início aqui texto longo antes do char especial é aqui texto depois";
    const email = "inicio aqui texto longo antes do char especial e aqui texto depois";
    const r = checkEncoding(source, email);
    for (const i of r) {
      assert.ok(i.source_context.length > 0);
      assert.ok(i.source_context.length < 60);
    }
  });

  it("retorna codepoint hex no formato U+XXXX", () => {
    const source = "ação";
    const email = "acao";
    const r = checkEncoding(source, email);
    for (const i of r) {
      assert.match(i.codepoint, /^U\+[0-9A-F]{4,}$/);
    }
  });
});

describe("checkEncoding — emoji de kicker e sequências de emoji (#9115)", () => {
  it("regressão 260930: `**🙋🏼‍♀️ PARA ENCERRAR**` no source vs HTML sem o emoji → zero issues", () => {
    const source = "Texto do corpo.\n\n---\n\n**🙋🏼‍♀️ PARA ENCERRAR**\n\nObrigado por ler.";
    const email = "Texto do corpo. Para encerrar Obrigado por ler.";
    assert.deepEqual(checkEncoding(source, email), []);
  });

  it("categoria do DESTAQUE e headers 🛠️/📡/🎁 sem emoji no HTML → zero issues", () => {
    const source = [
      "**DESTAQUE 1 | ⚠️ SEGURANÇA**",
      "**DESTAQUE 3 | 🇧🇷 BRASIL**",
      "**🛠️ USE MELHOR**",
      "**📡 RADAR**",
      "**🎁 SORTEIO**",
    ].join("\n\n");
    const email = "SEGURANÇA BRASIL Use melhor Radar Sorteio";
    assert.deepEqual(checkEncoding(source, email), []);
  });

  it("emoji no CORPO que some continua acusado — como UMA unidade, não ZWJ/♀ soltos", () => {
    const source = "**🎁 SORTEIO**\n\nA equipe comemorou 🙋🏼‍♀️ o resultado.";
    const email = "Sorteio A equipe comemorou o resultado.";
    const r = checkEncoding(source, email);
    assert.equal(r.length, 1);
    assert.equal(r[0].type, "char_dropped");
    assert.equal(r[0].char, "🙋🏼‍♀️");
    assert.equal(r[0].codepoint, "U+1F64B");
    assert.equal(r[0].sequence, "U+1F64B U+1F3FC U+200D U+2640 U+FE0F");
  });

  it("negrito de corpo com emoji (não caixa alta) não é kicker — drop acusado", () => {
    const r = checkEncoding("**🔥 Uma frase em negrito no corpo**", "Uma frase em negrito no corpo");
    assert.equal(r.length, 1);
    assert.equal(r[0].char, "🔥");
  });

  it("bandeira dropada no corpo é acusada como unidade (não 2 regional indicators)", () => {
    const r = checkEncoding("Feito no 🇧🇷 hoje", "Feito no hoje");
    assert.equal(r.length, 1);
    assert.equal(r[0].char, "🇧🇷");
    assert.equal(r[0].sequence, "U+1F1E7 U+1F1F7");
  });

  it("2 spans em negrito na mesma linha não viram kicker — emoji dropado é acusado", () => {
    const r = checkEncoding("**🔥 FOO** E **BAR**", "FOO E BAR");
    assert.equal(r.length, 1);
    assert.equal(r[0].char, "🔥");
  });

  it("negrito de corpo em CAIXA ALTA que não é nome de seção — drop acusado", () => {
    const r = checkEncoding("**⚠️ ATENÇÃO: PRAZO ENCERRA HOJE**", "ATENÇÃO: PRAZO ENCERRA HOJE");
    assert.equal(r.length, 1);
    assert.equal(r[0].char, "⚠️");
  });

  it("header de seção em Title Case também é kicker → zero issues", () => {
    assert.deepEqual(checkEncoding("**📡 Radar**\n\n**🙋🏼‍♀️ Para encerrar**", "Radar Para encerrar"), []);
  });

  it("keycap (1️⃣) é tratado como emoji — 1 issue com o grapheme inteiro", () => {
    const r = checkEncoding("a 1️⃣ b", "a 1 b");
    assert.equal(r.length, 1);
    assert.equal(r[0].char, "1️⃣");
  });

  it("`sequence` ausente para caractere de 1 codepoint (acento)", () => {
    const r = checkEncoding("ação", "acao");
    assert.ok(r.length > 0);
    for (const i of r) assert.equal(i.sequence, undefined);
  });

  it("emoji preservado sem VS16 no email não é drop (⚠️ vs ⚠)", () => {
    assert.deepEqual(checkEncoding("atenção ⚠️ aqui", "atenção ⚠ aqui"), []);
  });
});

describe("stripSectionHeaderEmojis (#9115)", () => {
  it("usa stripKickerEmoji do renderer: tira o emoji do header e da categoria", () => {
    assert.equal(stripSectionHeaderEmojis("**🙋🏼‍♀️ PARA ENCERRAR**"), "**PARA ENCERRAR**");
    assert.equal(stripSectionHeaderEmojis("**DESTAQUE 2 | 🚀 LANÇAMENTO**"), "**DESTAQUE 2 | LANÇAMENTO**");
  });

  it("não toca link em negrito nem linha de corpo", () => {
    const md = "**[Título do link](https://x.com)**\nTexto 🎉 solto";
    assert.equal(stripSectionHeaderEmojis(md), md);
  });

  it("tira o marcador 🎉 de abertura de box de celebração (#9279)", () => {
    assert.equal(stripSectionHeaderEmojis("🎉 Campeões do mês"), "Campeões do mês");
    assert.equal(stripSectionHeaderEmojis("🎉️ Campeões"), "Campeões");
  });
});

describe("checkEncoding — marcador de celebração (#9279)", () => {
  it("🎉 inicial removido pelo renderer não é char_dropped", () => {
    assert.deepEqual(checkEncoding("🎉 Campeões do mês\n\nação", "Campeões do mês ação"), []);
  });

  it("🎉 no meio do texto ausente do email continua acusado", () => {
    const r = checkEncoding("Parabéns 🎉 a todos", "Parabéns a todos");
    assert.equal(r.length, 1);
    assert.equal(r[0].char, "🎉");
  });
});
