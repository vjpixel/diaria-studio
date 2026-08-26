/**
 * test/kit-click-fields-6185.test.ts (#6185)
 *
 * O invariante que estes testes protegem: **array vazio NUNCA pode ser lido
 * como "o Kit não expõe cliques por link"**.
 *
 * As duas leituras de `clicks: []` levam a ações opostas — "ninguém clicou"
 * manda rodar de novo depois; "a plataforma não suporta" é achado de bloqueio
 * da migração inteira (#463). Confundi-las custaria ou uma conclusão errada
 * gravada numa issue, ou meses de trabalho barrados por engano.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  interpretClicksResponse,
  renderVeredicto,
  CAMPOS_DECLARADOS,
} from "../scripts/lib/kit-click-fields.ts";
import { verifyClickFields, type VerifyDeps } from "../scripts/kit-verify-click-fields.ts";

describe("#6185 interpretClicksResponse — array vazio é INCONCLUSIVO, nunca 'não suportado'", () => {
  it("clicks: [] ⇒ inconclusivo, e o motivo nega explicitamente a leitura errada", () => {
    const v = interpretClicksResponse({ clicks: [], totalClicks: 0, broadcastStatus: "completed" });
    assert.equal(v.status, "inconclusivo");
    if (v.status === "inconclusivo") {
      assert.match(v.motivo, /NÃO prova/, "precisa negar a leitura errada de forma explícita");
      assert.match(v.motivo, /NINGUÉM clicou/);
    }
  });

  it("nenhum caminho devolve um status que signifique 'plataforma não suporta'", () => {
    // Guard estrutural: se alguém adicionar esse status no futuro, este teste
    // obriga a pensar duas vezes.
    for (const clicks of [[], null, undefined, {}, "erro"]) {
      const v = interpretClicksResponse({ clicks });
      assert.ok(
        v.status === "inconclusivo" || v.status === "confirmado",
        `status inesperado: ${JSON.stringify(v.status)}`,
      );
    }
  });

  it("broadcast ainda agendado ⇒ o motivo diz que pode nem ter sido entregue", () => {
    const v = interpretClicksResponse({ clicks: [], totalClicks: 0, broadcastStatus: "scheduled" });
    assert.equal(v.status, "inconclusivo");
    if (v.status === "inconclusivo") assert.match(v.motivo, /nem ter sido entregue|scheduled/);
  });

  it("resposta que não é array ⇒ inconclusivo citando o shape, sem chutar", () => {
    const v = interpretClicksResponse({ clicks: { total: 3 } });
    assert.equal(v.status, "inconclusivo");
    if (v.status === "inconclusivo") assert.match(v.motivo, /não trouxe um array/);
  });
});

describe("#6185 interpretClicksResponse — com clique real, compara tipo vs realidade", () => {
  it("todos os campos declarados presentes ⇒ nenhum ausente", () => {
    const item = {
      url: "https://exemplo.com/a",
      unique_clicks: 3,
      click_to_delivery_rate: 0.6,
      click_to_open_rate: 0.75,
    };
    const v = interpretClicksResponse({ clicks: [item] });
    assert.equal(v.status, "confirmado");
    if (v.status === "confirmado") {
      assert.deepEqual(v.ausentes, []);
      assert.deepEqual(v.presentes.sort(), [...CAMPOS_DECLARADOS].sort());
      assert.deepEqual(v.inesperados, []);
    }
  });

  it("campo declarado que o Kit NÃO devolve aparece em `ausentes` — é o tipo mentindo", () => {
    // Cenário mais provável: os nomes foram supostos a partir da doc, não medidos.
    const v = interpretClicksResponse({ clicks: [{ url: "https://x.com", clicks: 5 }] });
    assert.equal(v.status, "confirmado");
    if (v.status === "confirmado") {
      assert.ok(v.ausentes.includes("unique_clicks"), "unique_clicks não veio: precisa ser reportado");
      assert.ok(v.inesperados.includes("clicks"), "o Kit devolveu 'clicks' e o tipo não conhece");
      assert.ok(v.presentes.includes("url"));
    }
  });

  it("a amostra bruta é preservada para virar fixture", () => {
    const item = { url: "https://x.com", total_clicks: 9 };
    const v = interpretClicksResponse({ clicks: [item] });
    if (v.status === "confirmado") assert.deepEqual(v.amostra, item);
  });
});

describe("#6185 renderVeredicto", () => {
  it("no inconclusivo, diz que a #6185 segue bloqueada POR FALTA DE DADO", () => {
    const out = renderVeredicto(interpretClicksResponse({ clicks: [], totalClicks: 0 }), 1);
    assert.match(out, /INCONCLUSIVO/);
    assert.match(out, /falta de dado, não por limitação/);
  });

  it("com divergência de tipo, manda ajustar ANTES de consumidor depender", () => {
    const out = renderVeredicto(interpretClicksResponse({ clicks: [{ url: "u" }] }), 1);
    assert.match(out, /DIVERGE/);
    assert.match(out, /AUSENTES/);
  });
});

describe("#6185 verifyClickFields — exit codes distinguem 'sem clique' de 'falhou'", () => {
  function deps(over: Partial<VerifyDeps> = {}): { d: VerifyDeps; linhas: string[] } {
    const linhas: string[] = [];
    return {
      linhas,
      d: {
        fetchClicks: async () => ({ clicks: [] }),
        fetchStats: async () => ({ total_clicks: 0, status: "completed" }),
        log: (l) => void linhas.push(l),
        ...over,
      },
    };
  }

  it("sem clique ⇒ code 2 (não é erro, é 'volte depois')", async () => {
    const { d } = deps();
    const r = await verifyClickFields(1, d);
    assert.equal(r.code, 2);
  });

  it("com clique ⇒ code 0", async () => {
    const { d } = deps({ fetchClicks: async () => ({ clicks: [{ url: "u", unique_clicks: 1 }] }) });
    const r = await verifyClickFields(1, d);
    assert.equal(r.code, 0);
  });

  it("REGRESSÃO #6162: o 2 NÃO colapsa em 0 — códigos distintos, ações opostas", async () => {
    const { d } = deps();
    const r = await verifyClickFields(1, d);
    assert.notEqual(r.code, 0, "'ninguém clicou' não pode ser reportado como confirmação");
  });

  it("falha da API de clicks ⇒ code 3, distinto do 2", async () => {
    const { d } = deps({
      fetchClicks: async () => {
        throw new Error("500 upstream");
      },
    });
    const r = await verifyClickFields(1, d);
    assert.equal(r.code, 3);
    if (r.code === 3) assert.match(r.reason, /500 upstream/);
  });

  it("stats indisponível NÃO derruba a sonda — só empobrece o diagnóstico", async () => {
    // O dado principal vem de /clicks; stats é contexto. Abortar aqui trocaria
    // uma resposta boa por nenhuma.
    const { d, linhas } = deps({
      fetchStats: async () => {
        throw new Error("429");
      },
      fetchClicks: async () => ({ clicks: [{ url: "u", unique_clicks: 2 }] }),
    });
    const r = await verifyClickFields(1, d);
    assert.equal(r.code, 0, "clicks respondeu: a pergunta principal foi respondida");
    assert.ok(linhas.some((l) => /aviso: stats indisponível/.test(l)));
  });
});
