import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listNameFor,
  countRows,
  normalizeImportCsv,
  parseArgs,
  findExistingConflicts,
  buildPlan,
  loadWaveDefs,
  WAVES,
} from "../scripts/clarice-import-waves.ts";

describe("loadWaveDefs (#2656)", () => {
  it("sem manifest → WAVES legado", () => {
    const dir = mkdtempSync(join(tmpdir(), "wd-legacy-"));
    try {
      assert.deepEqual(loadWaveDefs(dir), WAVES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("com waves-manifest.json → usa o manifest (store-driven)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wd-manifest-"));
    try {
      writeFileSync(
        join(dir, "waves-manifest.json"),
        JSON.stringify([
          { key: "W1", file: "w1-store.csv", desc: "re-envio (engajado)", count: 10 },
          { key: "W2", file: "w2-store.csv", desc: "1º envio (T01–T05)", count: 8 },
        ]),
      );
      const defs = loadWaveDefs(dir);
      assert.equal(defs.length, 2);
      assert.deepEqual(defs[0], { key: "W1", file: "w1-store.csv", desc: "re-envio (engajado)" });
      assert.equal(defs[1].file, "w2-store.csv");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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

describe("buildPlan — opcional pula, obrigatória explode", () => {
  const HEADER = "email,NOME\nfoo@bar.com,Foo\n";
  const tmpWaves = (files: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "clarice-waves-"));
    for (const f of files) writeFileSync(join(dir, f), HEADER, "utf8");
    return dir;
  };

  it("todas presentes → 5 planos (W1–W5)", () => {
    const dir = tmpWaves(WAVES.map((w) => w.file));
    try {
      assert.equal(buildPlan("L", "2605-06", dir).length, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("W5 (opcional) ausente → pula sem erro, 4 planos", () => {
    const dir = tmpWaves(WAVES.filter((w) => !w.optional).map((w) => w.file));
    try {
      const plans = buildPlan("L", "2605-06", dir);
      assert.equal(plans.length, 4);
      assert.ok(!plans.some((p) => p.wave.key === "W5"), "W5 não deve entrar no plano");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wave obrigatória (W3) ausente → throw (não importa parcial)", () => {
    const dir = tmpWaves(WAVES.filter((w) => w.key !== "W3").map((w) => w.file));
    try {
      assert.throws(() => buildPlan("L", "2605-06", dir), /wave faltando/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
