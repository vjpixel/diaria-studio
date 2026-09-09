/**
 * test/retrospectiva-path-7658.test.ts (#7658)
 *
 * Trava o classificador de path de `retrospectiva.diar.ia.br` — o módulo que
 * decide, a partir da URL, QUAL retrospectiva é e QUAL gate se aplica.
 *
 * O que justifica um teste denso pra 3 regexes: este é o ponto onde `/AAMM` e
 * `/AAAA` colidem (os dois são 4 dígitos), e um erro de classificação não dá
 * 404 — dá o gate ERRADO. Classificar `/2607` como anual serviria o recap
 * pago de Mantenedor a qualquer cadastrado; classificar `/2026` como mensal
 * trancaria a retrospectiva anual, que é isca de cadastro, atrás de apoio.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRetrospectivaPath,
  mensalPathFromCycle,
  anualPathFromSlug,
} from "../scripts/lib/shared/retrospectiva-path.ts";
import { annualSlug } from "../scripts/lib/anual/annual-paths.ts";

describe("#7658 — classifyRetrospectivaPath: mensal (/AAMM)", () => {
  it("2607 -> julho de 2026, gate de apoio Mantenedor", () => {
    assert.deepEqual(classifyRetrospectivaPath("/2607"), {
      kind: "mensal",
      ano: 2026,
      mes: 7,
      slug: "2607",
      gate: "apoio-mantenedor",
    });
  });

  it("aceita os 12 meses (01..12)", () => {
    for (let mes = 1; mes <= 12; mes++) {
      const slug = `26${String(mes).padStart(2, "0")}`;
      const r = classifyRetrospectivaPath(`/${slug}`);
      assert.equal(r?.kind, "mensal", `${slug} devia ser mensal`);
      assert.equal(r?.kind === "mensal" ? r.mes : null, mes);
    }
  });

  it("tolera barras nas pontas e caixa alta", () => {
    assert.equal(classifyRetrospectivaPath("/2607/")?.slug, "2607");
    assert.equal(classifyRetrospectivaPath("2607")?.slug, "2607");
  });
});

describe("#7658 — classifyRetrospectivaPath: anual (/AAAA)", () => {
  it("2026 -> anual, gate de cadastro", () => {
    assert.deepEqual(classifyRetrospectivaPath("/2026"), {
      kind: "anual",
      ano: 2026,
      slug: "2026",
      gate: "cadastro",
    });
  });

  it("2600 e 2613..2699 são ano (nenhum é mês válido)", () => {
    for (const slug of ["2600", "2613", "2650", "2699"]) {
      assert.equal(classifyRetrospectivaPath(`/${slug}`)?.kind, "anual", `${slug} devia ser anual`);
    }
  });
});

describe("#7658 — a colisão /AAMM × /AAAA é resolvida por intervalo, e o custo é conhecido", () => {
  it("2601 é lido como JANEIRO/2026, nunca como o ano 2601", () => {
    // É a colisão que a regra deliberadamente não resolve. Documentada aqui
    // como comportamento esperado: se um dia alguém precisar do ano 2601,
    // vai encontrar este teste antes de encontrar o bug.
    const r = classifyRetrospectivaPath("/2601");
    assert.equal(r?.kind, "mensal");
    assert.equal(r?.kind === "mensal" ? r.mes : null, 1);
    assert.equal(r?.kind === "mensal" ? r.ano : null, 2026);
  });

  it("anos plausíveis do produto (2025..2035) que NÃO terminam em 01-12 classificam como anual", () => {
    for (const ano of [2025, 2026, 2027, 2030, 2035]) {
      const doisUltimos = ano % 100;
      if (doisUltimos >= 1 && doisUltimos <= 12) continue; // 2601..2612 são o caso acima
      assert.equal(classifyRetrospectivaPath(`/${ano}`)?.kind, "anual", `${ano} devia ser anual`);
    }
  });
});

describe("#7658 — classifyRetrospectivaPath: aniversário (/aniversarioAAAA)", () => {
  it("aniversario2026 -> aniversário de 2026, gate de cadastro", () => {
    assert.deepEqual(classifyRetrospectivaPath("/aniversario2026"), {
      kind: "aniversario",
      ano: 2026,
      slug: "aniversario2026",
      gate: "cadastro",
    });
  });

  it("prefixo próprio evita a colisão com /AAAA (não passa pela regra de intervalo)", () => {
    assert.equal(classifyRetrospectivaPath("/aniversario2601")?.kind, "aniversario");
  });
});

describe("#7658 — classifyRetrospectivaPath: o que NÃO classifica", () => {
  it("path vazio, lixo, formato do ciclo antigo e slug antigo do anual -> null", () => {
    for (const p of ["", "/", "/abc", "/26071", "/260", "/2607-08", "/2026-aniversario", "/aniversario26"]) {
      assert.equal(classifyRetrospectivaPath(p), null, `${JSON.stringify(p)} não devia classificar`);
    }
  });

  it("nunca chuta um formato — servir a retrospectiva errada é pior que 404", () => {
    // Guard de intenção: se um dia alguém adicionar um fallback "se não casou,
    // assume anual", este teste quebra.
    assert.equal(classifyRetrospectivaPath("/qualquer-coisa"), null);
  });
});

describe("#7658 — mensalPathFromCycle: ciclo do repo -> path", () => {
  it("2607-08 -> 2607 (mês de CONTEÚDO, não o de envio)", () => {
    assert.equal(mensalPathFromCycle("2607-08"), "2607");
  });

  it("ciclo de dezembro/janeiro (2612-01) -> 2612", () => {
    assert.equal(mensalPathFromCycle("2612-01"), "2612");
  });

  it("formato inválido -> null", () => {
    for (const c of ["2607", "26-08", "260708", "abcd-ef", ""]) {
      assert.equal(mensalPathFromCycle(c), null, `${JSON.stringify(c)} não devia virar path`);
    }
  });

  it("mês fora de 01-12 -> null (não inventa path pra ciclo corrompido)", () => {
    assert.equal(mensalPathFromCycle("2613-08"), null);
    assert.equal(mensalPathFromCycle("2600-08"), null);
  });

  it("round-trip: o path gerado classifica de volta como o mesmo mês", () => {
    const path = mensalPathFromCycle("2607-08")!;
    const r = classifyRetrospectivaPath(`/${path}`);
    assert.equal(r?.kind, "mensal");
    assert.equal(r?.kind === "mensal" ? r.mes : null, 7);
  });
});

describe("#7658 — anualPathFromSlug: slug do repo -> path", () => {
  it("2026-aniversario -> aniversario2026", () => {
    assert.equal(anualPathFromSlug("2026-aniversario"), "aniversario2026");
  });

  it("aceita o slug acentuado também", () => {
    assert.equal(anualPathFromSlug("2026-aniversário"), "aniversario2026");
  });

  it("2026-janeiro -> 2026 — IDENTIDADE: o slug do repo já é o ano coberto", () => {
    // Regressão do achado do review: a 1ª versão subtraía 1 ano, assumindo
    // que o slug carregava o ano de PUBLICAÇÃO. Devolvia 2025 pra 2026-janeiro
    // — um ano que existe e classifica como anual, ou seja, redirect pra
    // retrospectiva errada sem 404 nenhum pra denunciar.
    assert.equal(anualPathFromSlug("2026-janeiro"), "2026");
  });

  it("slug desconhecido -> null", () => {
    for (const s of ["2026", "janeiro-2027", "2026-agosto", ""]) {
      assert.equal(anualPathFromSlug(s), null, `${JSON.stringify(s)} não devia virar path`);
    }
  });

  it("round-trip: os dois formatos voltam com o kind certo", () => {
    assert.equal(classifyRetrospectivaPath(`/${anualPathFromSlug("2026-aniversario")}`)?.kind, "aniversario");
    assert.equal(classifyRetrospectivaPath(`/${anualPathFromSlug("2027-janeiro")}`)?.kind, "anual");
  });
});

describe("#7658 — o tradutor está amarrado ao gerador REAL de slug", () => {
  // A lacuna que deixou o bug do ano passar no primeiro commit: os testes
  // validavam `anualPathFromSlug` contra um formato de slug HIPOTÉTICO
  // ("2027-janeiro"), nunca contra o que a pipeline de fato produz. Aqui o
  // slug vem de `annualSlug`, a mesma função que a `/diaria-anual` usa pra
  // nomear o diretório da edição — se um dia ela mudar de formato, quebra
  // aqui em vez de virar redirect silencioso pro ano errado.
  it("annualSlug(2026, 'janeiro') -> path 2026 (o ano que a retrospectiva FECHA)", () => {
    const slug = annualSlug(2026, "janeiro");
    assert.equal(slug, "2026-janeiro");
    assert.equal(anualPathFromSlug(slug), "2026");
  });

  it("annualSlug(2026, 'aniversario') -> path aniversario2026", () => {
    const slug = annualSlug(2026, "aniversario");
    assert.equal(slug, "2026-aniversario");
    assert.equal(anualPathFromSlug(slug), "aniversario2026");
  });

  it("todo slug gerado pelos 2 tipos traduz e classifica com o kind certo", () => {
    for (const ano of [2026, 2027, 2030]) {
      const janeiro = anualPathFromSlug(annualSlug(ano, "janeiro"));
      assert.ok(janeiro, `janeiro/${ano} devia traduzir`);
      assert.equal(classifyRetrospectivaPath(`/${janeiro}`)?.kind, "anual");

      const aniversario = anualPathFromSlug(annualSlug(ano, "aniversario"));
      assert.ok(aniversario, `aniversario/${ano} devia traduzir`);
      assert.equal(classifyRetrospectivaPath(`/${aniversario}`)?.kind, "aniversario");
    }
  });
});
