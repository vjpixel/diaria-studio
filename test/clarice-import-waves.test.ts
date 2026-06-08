import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  listNameFor,
  countRows,
  normalizeImportCsv,
  parseArgs,
  findExistingConflicts,
  WAVES,
} from "../scripts/clarice-import-waves.ts";

describe("listNameFor", () => {
  it("nome determinístico por wave + label", () => {
    assert.equal(listNameFor(WAVES[0], "Jun/2026"), "Clarice Jun/2026 W1 — T1 abriu");
    assert.equal(listNameFor(WAVES[2], "Jun/2026"), "Clarice Jun/2026 W3 — T2 parte1");
  });
});

describe("WAVES (proveniência no nome + W5 opcional)", () => {
  it("nomes wX-{ferramenta}-{tier}: T1 via Brevo, T2/maio via MV", () => {
    const byKey = Object.fromEntries(WAVES.map((w) => [w.key, w.file]));
    assert.equal(byKey.W1, "w1-brevo-export-t1-openers.csv");
    assert.equal(byKey.W2, "w2-brevo-export-t1-non-openers.csv");
    assert.equal(byKey.W3, "w3-mv-export-t2.csv");
    assert.equal(byKey.W4, "w4-mv-export-t2.csv");
    assert.equal(byKey.W5, "w5-mv-export-maio.csv");
  });
  it("W1–W4 obrigatórias; só W5 (cohort do ciclo) é opcional", () => {
    for (const w of WAVES) {
      assert.equal(!!w.optional, w.key === "W5", `${w.key} optional flag`);
    }
  });
});

describe("countRows", () => {
  it("desconta o header e linhas vazias", () => {
    assert.equal(countRows("email,NOME\na@x.com,Ana\nb@x.com,Bia\n"), 2);
    assert.equal(countRows("email,NOME\n"), 0);
    assert.equal(countRows("email,NOME\n\na@x.com,Ana\n\n"), 1);
  });

  it("não infla com newline embutido em campo quotado (era o bug do +1)", () => {
    // NOME com newline embutido → 1 só linha de dados, não 2.
    assert.equal(countRows('email,NOME\na@x.com,"Ana\nMaria"\n'), 1);
  });
});

describe("normalizeImportCsv", () => {
  it("converte o header de email pra EMAIL (Brevo identifica por ele)", () => {
    const out = normalizeImportCsv("email,NOME,OPEN_PROBABILITY\na@x.com,Ana,24\n");
    assert.ok(out.startsWith("EMAIL,NOME,OPEN_PROBABILITY"));
    assert.ok(out.includes("a@x.com,Ana,24"));
  });

  it("aceita variação 'E-mail' e preserva as demais colunas", () => {
    const out = normalizeImportCsv("E-mail,NOME,RECENCY_QUARTIL\na@x.com,Ana,Q1\n");
    assert.equal(out.split("\n")[0], "EMAIL,NOME,RECENCY_QUARTIL");
  });

  it("não toca em colunas que não são email", () => {
    const out = normalizeImportCsv("nome,sobrenome\nA,B\n");
    assert.equal(out.split("\n")[0], "nome,sobrenome");
  });

  it("CSV sem newline → retorna como veio", () => {
    assert.equal(normalizeImportCsv("email"), "email");
  });
});

describe("parseArgs", () => {
  it("default = dry-run, folder 1, label genérico", () => {
    const a = parseArgs([]);
    assert.equal(a.execute, false);
    assert.equal(a.folderId, 1);
    assert.equal(a.label, "edição atual");
  });

  it("--execute liga o modo real", () => {
    assert.equal(parseArgs(["--execute"]).execute, true);
  });

  it("--label e --folder-id", () => {
    const a = parseArgs(["--label", "Jun/2026", "--folder-id", "4"]);
    assert.equal(a.label, "Jun/2026");
    assert.equal(a.folderId, 4);
  });

  it("--folder-id inválido cai no default 1", () => {
    assert.equal(parseArgs(["--folder-id", "abc"]).folderId, 1);
    assert.equal(parseArgs(["--folder-id", "0"]).folderId, 1);
  });

  it("--label NÃO engole a flag seguinte (cai no default)", () => {
    // `--label --execute`: label não pode virar "--execute" (criaria listas
    // "Clarice --execute …" em produção). Cai no default genérico.
    const a = parseArgs(["--label", "--execute"]);
    assert.equal(a.label, "edição atual");
    assert.equal(a.execute, true);
  });
});

describe("findExistingConflicts (idempotência)", () => {
  const existing = [
    { id: 9, name: "Clarice Jun/2026 W1 — T1 abriu" },
    { id: 10, name: "Clarice Jun/2026 W2 — T1 nao-abriu" },
  ];

  it("detecta nomes planejados que já existem", () => {
    const c = findExistingConflicts(
      ["Clarice Jun/2026 W1 — T1 abriu", "Clarice Jun/2026 W3 — T2 parte1"],
      existing,
    );
    assert.deepEqual(c, [{ name: "Clarice Jun/2026 W1 — T1 abriu", id: 9 }]);
  });

  it("nenhum conflito → array vazio (label novo é seguro)", () => {
    const c = findExistingConflicts(["Clarice Jul/2026 W1 — T1 abriu"], existing);
    assert.deepEqual(c, []);
  });
});
