import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  listNameFor,
  groupCellListNameFor,
  isGroupCellWave,
  resolveListName,
  countRows,
  normalizeImportCsv,
  parseArgs,
  findExistingConflicts,
  buildPlan,
  loadWaveDefs,
  groupListsRegistryPath,
  appendGroupListsRegistry,
  resolveRegistryKey,
  validateProcessId,
  importOneWave,
  makeRealImportRunClient,
  extractCsvEmails,
  findMissingContacts,
  type WaveDef,
  type GroupListEntry,
  type ImportRunClient,
} from "../scripts/clarice-import-waves.ts";
import { buildSegmentArtifact, type SegmentRow } from "../scripts/clarice-build-segment.ts";
import { campaignNameFor } from "../scripts/clarice-schedule-group.ts";
import { parseAbcAudienceCampaign } from "../workers/brevo-dashboard/src/index.ts";
import { EDITOR_COPY_EMAIL } from "../scripts/lib/editor-copy.ts";

describe("loadWaveDefs (#2656/#2844)", () => {
  it("sem manifest → erro claro (#4759: aponta pro grupo nomeado, não pro produtor aposentado)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wd-legacy-"));
    try {
      assert.throws(() => loadWaveDefs(dir), /waves-manifest\.json ausente/);
      assert.throws(() => loadWaveDefs(dir), /clarice-build-segment\.ts --cycle \.\.\. --group ramp-warm/);
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

  it("manifest malformado / não-array / sem campos → erro claro (não cryptic)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wd-bad-"));
    try {
      writeFileSync(join(dir, "waves-manifest.json"), "{ not json");
      assert.throws(() => loadWaveDefs(dir), /inválido/);
      writeFileSync(join(dir, "waves-manifest.json"), JSON.stringify({ key: "W1" }));
      assert.throws(() => loadWaveDefs(dir), /array de waves/);
      writeFileSync(join(dir, "waves-manifest.json"), JSON.stringify([{ key: "W1", desc: "x" }]));
      assert.throws(() => loadWaveDefs(dir), /entrada 0 inválida/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("build store interrompido (w*-store.csv sem manifest) → mesmo erro claro, não fallback legado", () => {
    const dir = mkdtempSync(join(tmpdir(), "wd-interrupted-"));
    try {
      writeFileSync(join(dir, "w1-store.csv"), "email,NOME\na@x.com,A\n");
      assert.throws(() => loadWaveDefs(dir), /waves-manifest\.json ausente/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #4766: `loadWaveDefs` recebe `group` (o mesmo `string | null` tipado que
  // `buildPlan` já tinha no escopo) em vez de um filename pré-formatado —
  // este teste exercita o parâmetro DIRETO (sem passar por `buildPlan`),
  // provando que `{group}-manifest.json` é lido e a mensagem de erro do
  // grupo (não a da rampa) é a que sai quando `group` está presente.
  it("com group → lê {group}-manifest.json (#4766: parâmetro tipado, não filename pré-formatado)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wd-group-"));
    try {
      writeFileSync(
        join(dir, "engajados-manifest.json"),
        JSON.stringify([{ key: "engajados", file: "engajados.csv", desc: "Engajados (retenção)" }]),
      );
      const defs = loadWaveDefs(dir, "engajados");
      assert.equal(defs.length, 1);
      assert.equal(defs[0].key, "engajados");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("com group + manifest ausente → erro claro aponta pro comando build-segment genérico, não pro ramp-warm", () => {
    const dir = mkdtempSync(join(tmpdir(), "wd-group-missing-"));
    try {
      assert.throws(() => loadWaveDefs(dir, "engajados"), /engajados-manifest\.json ausente/);
      assert.throws(() => loadWaveDefs(dir, "engajados"), /clarice-build-segment\.ts --cycle \.\.\. --group \.\.\./);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildPlan via manifest (#2656)", () => {
  it("lê as waves do manifest + conta contatos", () => {
    const dir = mkdtempSync(join(tmpdir(), "bp-manifest-"));
    try {
      writeFileSync(
        join(dir, "waves-manifest.json"),
        JSON.stringify([{ key: "W1", file: "w1-store.csv", desc: "re-envio (engajado)" }]),
      );
      writeFileSync(join(dir, "w1-store.csv"), "email,NOME\na@x.com,Ana\nb@x.com,Bia\n");
      const plans = buildPlan("Jun/2026", "2606-07", dir);
      assert.equal(plans.length, 1);
      assert.equal(plans[0].wave.key, "W1");
      assert.equal(plans[0].count, 2, "count reflete só os contatos reais, não a linha do editor");
      assert.equal(plans[0].listName, "Clarice Jun/2026 W1 — re-envio (engajado)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #3455: toda wave criada deve incluir o editor como destinatário — regressão
  // pro caso real (o CSV que de fato vai pro Brevo /contacts/import).
  it("#3455: o CSV final da wave inclui EDITOR_COPY_EMAIL", () => {
    const dir = mkdtempSync(join(tmpdir(), "bp-editor-copy-"));
    try {
      writeFileSync(
        join(dir, "waves-manifest.json"),
        JSON.stringify([{ key: "W1", file: "w1-store.csv", desc: "re-envio (engajado)" }]),
      );
      writeFileSync(join(dir, "w1-store.csv"), "email,NOME\na@x.com,Ana\nb@x.com,Bia\n");
      const plans = buildPlan("Jun/2026", "2606-07", dir);
      assert.ok(
        plans[0].csv.includes(EDITOR_COPY_EMAIL),
        `csv da wave deve incluir o editor: ${plans[0].csv}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("listNameFor", () => {
  it("nome determinístico por wave + label", () => {
    const w1: WaveDef = { key: "W1", file: "w1-store.csv", desc: "re-envio (engajado)" };
    const w3: WaveDef = { key: "W3", file: "w3-store.csv", desc: "1º envio (T06+)" };
    assert.equal(listNameFor(w1, "Jun/2026"), "Clarice Jun/2026 W1 — re-envio (engajado)");
    assert.equal(listNameFor(w3, "Jun/2026"), "Clarice Jun/2026 W3 — 1º envio (T06+)");
  });
});

// #4449 item 3 / #4471: até o #4449, o nome da LISTA do braço COM CÉLULA do
// fluxo --group era digitado à mão (raiz da mesma classe de bug já vista em
// #3081 → #3128 → #4447). O #4449 criou `groupCellListNameFor` mas nunca a
// ligou ao ponto real de criação da lista (`buildPlan`/`main()` deste
// arquivo, que sempre chamava `listNameFor` incondicionalmente) — #4471
// fecha o gap via `resolveListName`. Movido de test/clarice-schedule-group.test.ts
// pra aqui (#4471) — mora junto do código que agora efetivamente a usa.
describe("groupCellListNameFor (#4449 item 3 — gerador determinístico do nome de LISTA do --group)", () => {
  it("gera o formato 'Clarice {cycle} {key} — célula {X}' esperado por parseAbcAudienceCampaign", () => {
    assert.equal(
      groupCellListNameFor("2607-08", "d1-sab01-A"),
      "Clarice 2607-08 d1-sab01-A — célula A",
    );
  });

  it("célula derivada do sufixo do key pras 3 letras (B e C também)", () => {
    assert.equal(groupCellListNameFor("2607-08", "d2-dom02-B"), "Clarice 2607-08 d2-dom02-B — célula B");
    assert.equal(groupCellListNameFor("2607-08", "d1-sab01-C"), "Clarice 2607-08 d1-sab01-C — célula C");
  });

  it("key sem sufixo -A/-B/-C (ex: grupo sem célula) → lança em vez de gerar nome enganoso", () => {
    assert.throws(() => groupCellListNameFor("2607-08", "d1-sab01-interno"));
  });

  it("round-trip isolado (paridade gerador + parser): campaignNameFor + groupCellListNameFor recuperam ciclo/célula corretos via parseAbcAudienceCampaign, pras 3 células", () => {
    const cycle = "2607-08";
    for (const cell of ["A", "B", "C"] as const) {
      const key = `d1-sab01-${cell}`;
      const campaignName = campaignNameFor(cycle, key);
      const listName = groupCellListNameFor(cycle, key);
      const parsed = parseAbcAudienceCampaign(campaignName, listName);
      assert.deepEqual(
        parsed,
        { cycle, cell, audience: "warm" },
        `round-trip falhou pra célula ${cell}: campaignName="${campaignName}" listName="${listName}"`,
      );
    }
  });
});

// #4471: `resolveListName` é o ponto de decisão que `buildPlan` de fato
// chama — testar SÓ `groupCellListNameFor` isolada (acima) não prova que o
// fluxo real a usa; isso já era verdade antes do #4471 (a função existia e
// tinha teste, mas `buildPlan` nunca a chamava). Estes testes cobrem
// `resolveListName` diretamente + (no describe seguinte) o e2e via
// `buildPlan` inteiro.
describe("resolveListName (#4471 — ponto de decisão entre os dois formatos, usado por buildPlan)", () => {
  it("--group + key com célula (-A/-B/-C) → usa groupCellListNameFor", () => {
    const wave: WaveDef = { key: "d1-sab01-A", file: "d1-sab01-A.csv", desc: "célula A" };
    assert.equal(
      resolveListName(wave, "ignorado", "2607-08", "d1-sab01-A"),
      "Clarice 2607-08 d1-sab01-A — célula A",
    );
  });

  it("--group sem célula (ex: engajados) → mantém listNameFor (não regride #2916)", () => {
    const wave: WaveDef = { key: "engajados", file: "engajados.csv", desc: "Engajados (retenção)" };
    assert.equal(
      resolveListName(wave, "Retenção Jun/2026", "2606-07", "engajados"),
      "Clarice Retenção Jun/2026 engajados — Engajados (retenção)",
    );
  });

  it("sem --group (rampa waves/) → mantém listNameFor mesmo que o key coincidisse com sufixo -A/-B/-C (defensivo, gate duplo)", () => {
    const wave: WaveDef = { key: "W1-A", file: "w1-a.csv", desc: "T1 abriu" };
    assert.equal(
      resolveListName(wave, "Jun/2026", "2606-07", null),
      "Clarice Jun/2026 W1-A — T1 abriu",
      "group=null nunca deve cair no formato de célula, mesmo com sufixo coincidente",
    );
  });
});

// #4762: `isGroupCellWave` foi extraído de dentro de `resolveListName` pra
// ser o único ponto de decisão "isto é célula A/B/C do --group?" — reusado
// por `buildPlan` (grava em `Plan.hasCell`) e propagado até
// `resolveRegistryKey`, em vez deste re-derivar a mesma heurística sozinho
// (achado do fleet review da PR #4758 sobre a #4753). Os 3 casos abaixo
// espelham exatamente os 3 casos de `resolveListName` acima — mesmo gate,
// função extraída.
describe("isGroupCellWave (#4762 — gate único, reusado por resolveListName e buildPlan/resolveRegistryKey)", () => {
  it("group ativo + sufixo -A/-B/-C (case-insensitive) → true", () => {
    assert.equal(isGroupCellWave("d1-sab01-A", "d1-sab01-A"), true);
    assert.equal(isGroupCellWave("d1-sab01-A", "d1-sab01-a"), true);
    assert.equal(isGroupCellWave("d1-sab01-A", "d1-sab01-B"), true);
    assert.equal(isGroupCellWave("d1-sab01-A", "d1-sab01-c"), true);
  });

  it("group ativo, sem sufixo de célula → false", () => {
    assert.equal(isGroupCellWave("engajados", "engajados"), false);
  });

  it("group null (rampa) → SEMPRE false, mesmo com sufixo coincidente — gate duplo defensivo", () => {
    assert.equal(isGroupCellWave(null, "W1-A"), false);
  });
});

// #2844/260702: o cohort fixo W1–W5 (WAVES) era exclusivo do fallback legado,
// removido com clarice-build-waves.ts. Waves store-driven são inteiramente
// dinâmicas (manifest lista só o que de fato foi gerado) — sem shape fixo pra
// testar aqui.
describe("buildPlan — manifest-driven: obrigatória ausente explode", () => {
  const SAMPLE: WaveDef[] = [
    { key: "W1", file: "w1-store.csv", desc: "re-envio (engajado)" },
    { key: "W2", file: "w2-store.csv", desc: "1º envio (T01–T05)" },
    { key: "W3", file: "w3-store.csv", desc: "1º envio (T06+)" },
  ];
  const HEADER = "email,NOME\nfoo@bar.com,Foo\n";
  const tmpWaves = (waves: WaveDef[], filesToWrite: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "clarice-waves-"));
    writeFileSync(join(dir, "waves-manifest.json"), JSON.stringify(waves), "utf8");
    for (const f of filesToWrite) writeFileSync(join(dir, f), HEADER, "utf8");
    return dir;
  };

  it("todas as waves do manifest com CSV presente → 1 plano por wave", () => {
    const dir = tmpWaves(SAMPLE, SAMPLE.map((w) => w.file));
    try {
      assert.equal(buildPlan("L", "2605-06", dir).length, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wave do manifest sem CSV correspondente → throw (não importa parcial)", () => {
    const dir = tmpWaves(SAMPLE, SAMPLE.filter((w) => w.key !== "W3").map((w) => w.file));
    try {
      assert.throws(() => buildPlan("L", "2605-06", dir), /wave faltando/);
      // #4759: sem --group (modo rampa órfão), a mensagem aponta pro sucessor
      // vivo — não pro clarice-build-waves-store.ts removido. Regex mais
      // solto acima passaria mesmo se a mensagem regredisse a citar o script
      // aposentado; este mirra o padrão já usado em loadWaveDefs (#4759).
      assert.throws(() => buildPlan("L", "2605-06", dir), /clarice-build-segment\.ts --cycle .* --group ramp-warm/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #2916 — e2e: output de clarice-build-segment.ts (segments/{group}-manifest.json)
// é de fato LIDO por clarice-import-waves.ts via --group (não fica órfão).
// ---------------------------------------------------------------------------

describe("buildPlan --group (#2916 — grupos nomeados de #2885 deixam de ser órfãos)", () => {
  function row(p: Partial<SegmentRow> & { email: string }): SegmentRow {
    return {
      name: "Fulano Sobrenome",
      tier: null,
      cohort: null,
      priority_points: 0,
      send_eligible: 1,
      ineligible_reason: null,
      sends_count: 0,
      opens_count: 0,
      last_sent_at: null,
      mv_bucket: null,
      ...p,
    };
  }

  it("e2e: clarice-build-segment escreve o manifest+CSV do grupo, clarice-import-waves --group lê o MESMO manifest e resolve os contatos", () => {
    const dir = mkdtempSync(join(tmpdir(), "segments-e2e-"));
    try {
      // --- 1. build-segment (real, mesma função que o CLI usa) ---
      const rows: SegmentRow[] = [
        row({ email: "a@x.com", sends_count: 3, priority_points: 60, name: "Ana Costa" }),
        row({ email: "b@x.com", sends_count: 2, priority_points: 20, name: "Beatriz Silva" }),
        row({ email: "fresh@x.com", sends_count: 0, priority_points: 999 }), // não é engajados
      ];
      const { csv, manifestEntry } = buildSegmentArtifact(rows, "engajados", 0);
      writeFileSync(join(dir, manifestEntry.file), csv, "utf8");
      writeFileSync(join(dir, "engajados-manifest.json"), JSON.stringify([manifestEntry], null, 2), "utf8");

      // --- 2. import-waves --group engajados (dir injetado = segments/ do build acima) ---
      const plans = buildPlan("Retenção Jun/2026", "2606-07", dir, "engajados");

      assert.equal(plans.length, 1, "o import LÊ o manifest escrito pelo build-segment — antes (#2916) ninguém lia segments/");
      assert.equal(plans[0].wave.key, "engajados");
      assert.equal(plans[0].wave.file, "engajados.csv");
      assert.equal(plans[0].count, 2, "resolve os 2 contatos reais do grupo (a@x.com, b@x.com — fresh@x.com fora)");
      assert.equal(plans[0].listName, "Clarice Retenção Jun/2026 engajados — Engajados (retenção)");
      assert.equal(plans[0].hasCell, false, "#4762: grupo sem sufixo -A/-B/-C não é célula");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem --group (default): continua lendo waves-manifest.json — comportamento pré-#2916 intocado", () => {
    const dir = mkdtempSync(join(tmpdir(), "waves-default-"));
    try {
      writeFileSync(
        join(dir, "waves-manifest.json"),
        JSON.stringify([{ key: "W1", file: "w1-store.csv", desc: "re-envio (engajado)" }]),
      );
      writeFileSync(join(dir, "w1-store.csv"), "email,NOME\na@x.com,Ana\n");
      const plans = buildPlan("Jun/2026", "2606-07", dir); // group omitido
      assert.equal(plans.length, 1);
      assert.equal(plans[0].wave.key, "W1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--group com manifest ausente → erro claro apontando pro comando build-segment (não 'órfão silencioso')", () => {
    const dir = mkdtempSync(join(tmpdir(), "segments-missing-"));
    try {
      assert.throws(
        () => buildPlan("L", "2606-07", dir, "engajados"),
        /engajados-manifest\.json ausente/,
      );
      assert.throws(
        () => buildPlan("L", "2606-07", dir, "engajados"),
        /clarice-build-segment/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #4471 — regressão real: o gap descrito na issue era exatamente que
  // `groupCellListNameFor` tinha teste isolado (round-trip contra
  // parseAbcAudienceCampaign) mas NUNCA era chamada pelo fluxo real de
  // criação de lista (`buildPlan`, que sempre usava `listNameFor`,
  // incompatível com o parser pro braço com célula). Este teste exercita o
  // caminho INTEIRO — manifest do grupo (mesmo shape que
  // clarice-build-segment.ts escreveria pra um teste A/B/C ad-hoc) →
  // buildPlan → listName — e confirma que o nome resultante é o que
  // parseAbcAudienceCampaign de fato espera, pras 3 células.
  it("e2e (#4471): buildPlan --group com key de célula (-A/-B/-C) gera listName que parseAbcAudienceCampaign reconhece corretamente", () => {
    const cycle = "2607-08";
    for (const cell of ["A", "B", "C"] as const) {
      const groupKey = `d1-sab01-${cell}`;
      const dir = mkdtempSync(join(tmpdir(), `abc-cell-e2e-${cell}-`));
      try {
        writeFileSync(
          join(dir, `${groupKey}-manifest.json`),
          JSON.stringify([{ key: groupKey, file: `${groupKey}.csv`, desc: `célula ${cell}` }]),
        );
        writeFileSync(join(dir, `${groupKey}.csv`), "email,NOME\na@x.com,Ana\n");

        const plans = buildPlan("Rótulo ignorado no braço com célula", cycle, dir, groupKey);
        assert.equal(plans.length, 1);
        assert.equal(plans[0].hasCell, true, "#4762: wave.key com sufixo de célula + group ativo");
        const listName = plans[0].listName;

        // A campanha real (clarice-schedule-group.ts::campaignNameFor) usa o
        // MESMO groupKey como --key — reproduz aqui o par campanha+lista que
        // o pipeline real produziria antes de chamar parseAbcAudienceCampaign.
        const campaignName = campaignNameFor(cycle, groupKey);
        const parsed = parseAbcAudienceCampaign(campaignName, listName);
        assert.deepEqual(
          parsed,
          { cycle, cell, audience: "warm" },
          `buildPlan produziu um listName que o parser não reconhece: campaignName="${campaignName}" listName="${listName}"`,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
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

describe("extractCsvEmails (#4720)", () => {
  it("extrai a coluna EMAIL, normalizada trim+lowercase", () => {
    assert.deepEqual(
      extractCsvEmails("EMAIL,NOME\nA@X.com,Ana\n b@x.com ,Bia\n"),
      ["a@x.com", "b@x.com"],
    );
  });

  it("aceita header minúsculo 'email' também", () => {
    assert.deepEqual(extractCsvEmails("email,NOME\na@x.com,Ana\n"), ["a@x.com"]);
  });

  it("linha vazia/sem email não entra", () => {
    assert.deepEqual(extractCsvEmails("EMAIL,NOME\n\na@x.com,Ana\n,Sem email\n"), ["a@x.com"]);
  });
});

describe("findMissingContacts (#4720)", () => {
  it("nomeia quem está no CSV mas não veio na paginação da lista real", () => {
    assert.deepEqual(
      findMissingContacts(["a@x.com", "b@x.com", "c@x.com"], ["a@x.com", "c@x.com"]),
      ["b@x.com"],
    );
  });

  it("normaliza trim+lowercase nos dois lados antes de comparar", () => {
    assert.deepEqual(
      findMissingContacts(["A@X.com"], [" a@x.com "]),
      [],
    );
  });

  it("nenhum faltando → array vazio", () => {
    assert.deepEqual(findMissingContacts(["a@x.com"], ["a@x.com", "b@x.com"]), []);
  });

  it("não repete o mesmo e-mail duas vezes mesmo se ele aparece 2× no esperado", () => {
    assert.deepEqual(findMissingContacts(["a@x.com", "a@x.com"], []), ["a@x.com"]);
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

  it("#4753: --key ausente → campaignKey undefined (comportamento original preservado)", () => {
    assert.equal(parseArgs(["--cycle", "2607-08", "--group", "novos"]).campaignKey, undefined);
  });

  it("#4753: --key presente → campaignKey recebe o valor (key de CAMPANHA, não de grupo)", () => {
    const a = parseArgs(["--cycle", "2607-08", "--group", "novos", "--key", "novos-260807"]);
    assert.equal(a.campaignKey, "novos-260807");
  });
});

// ---------------------------------------------------------------------------
// #4753 — clarice-import-waves.ts gravava `key: wave.key` (nome ESTÁTICO do
// grupo, ex: "novos") em toda entrada de {group}-lists.json pra grupos sem
// célula A/B/C — mas clarice-schedule-group.ts --key recebe a key de
// CAMPANHA (`novos-{AAMMDD}`, data-based). A partir da 2ª lista registrada no
// mesmo ciclo, --key não batia com nada e o script abortava (só workaround
// era --list-index). resolveRegistryKey é o fix: grava a key de campanha
// (--key desta invocação) em vez do nome estático, quando informada.
// ---------------------------------------------------------------------------

describe("resolveRegistryKey (#4753, sinal de célula EXPLÍCITO desde #4762)", () => {
  it("sem campaignKey → mantém waveKey (comportamento original, ramp-warm/engajados/etc nunca passam --key)", () => {
    assert.equal(resolveRegistryKey("novos", false), "novos");
    assert.equal(resolveRegistryKey("ramp-warm", false, undefined), "ramp-warm");
  });

  it("com campaignKey + hasCell=false → sobrescreve pra campaignKey", () => {
    assert.equal(resolveRegistryKey("novos", false, "novos-260807"), "novos-260807");
  });

  it("com campaignKey + hasCell=true → mantém waveKey (célula já é key distinta por construção)", () => {
    assert.equal(resolveRegistryKey("d4-ter04-A", true, "novos-260807"), "d4-ter04-A");
    assert.equal(resolveRegistryKey("d4-ter04-B", true, "novos-260807"), "d4-ter04-B");
    assert.equal(resolveRegistryKey("d4-ter04-c", true, "novos-260807"), "d4-ter04-c");
  });

  // #4762: achado do fleet review da PR #4758 sobre a #4753 — antes,
  // `resolveRegistryKey` re-derivava "isto é célula?" fazendo regex direto
  // em `waveKey`, sem o gate em `group` que a função irmã `resolveListName`
  // já carregava (documentado no describe de `isGroupCellWave` acima, que
  // agora é o ÚNICO lugar onde essa regex vive). Com `hasCell` como sinal
  // explícito, a FORMA da string deixa de decidir qualquer coisa aqui — a
  // prova é que um `waveKey` terminado em "-a" com `hasCell=false` (o valor
  // que um grupo sem sufixo real de célula sempre produz) ainda sobrescreve
  // normalmente, em vez de ser tratado como célula pela forma da string.
  it("hasCell explícito — a forma da string não decide mais nada aqui (waveKey termina em -a, mas hasCell=false)", () => {
    assert.equal(resolveRegistryKey("grupo-a", false, "novos-260807"), "novos-260807");
  });

  // `--key ""` degrada pra "sem override" via `values["key"] || undefined` —
  // mesmo padrão de `clarice-schedule-group.ts`. Travado pra que uma mudança
  // futura no parse não transforme string vazia numa key literal vazia gravada
  // no registro, que não resolveria nunca.
  it("campaignKey vazia é tratada como ausente, não como key literal", () => {
    assert.equal(resolveRegistryKey("novos", false, ""), "novos");
  });
});

// ---------------------------------------------------------------------------
// #3228 — registro de listas Brevo criadas por grupo nomeado (fecha o gap
// entre --group --execute e clarice-schedule-group.ts, que precisa resolver
// "qual lista pertence a este grupo neste ciclo" sem o editor copiar o
// listId do stdout manualmente).
// ---------------------------------------------------------------------------

describe("groupListsRegistryPath (#3228)", () => {
  it("caminho determinístico dentro do segmentsDir", () => {
    const expected = ["fake", "segments", "ramp-warm-lists.json"].join(sep);
    assert.ok(
      groupListsRegistryPath(`${sep}fake${sep}segments`, "ramp-warm").endsWith(expected),
      `esperado terminar em ${expected}`,
    );
  });
});

describe("appendGroupListsRegistry (#3228)", () => {
  it("1ª invocação: cria o arquivo com a(s) entrada(s) passada(s)", () => {
    const dir = mkdtempSync(join(tmpdir(), "group-registry-1st-"));
    try {
      const entries: GroupListEntry[] = [
        { listId: 69, listName: "Clarice Ramp Jul/2026 ramp-warm", count: 6403, importedAt: "2026-07-10T12:00:00.000Z" },
      ];
      appendGroupListsRegistry(dir, "2606-07", "ramp-warm", entries);

      const file = groupListsRegistryPath(dir, "ramp-warm");
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(parsed.cycle, "2606-07");
      assert.equal(parsed.group, "ramp-warm");
      assert.deepEqual(parsed.lists, entries);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invocações subsequentes ACUMULAM (não sobrescrevem) — caso real: mesmo grupo, 3 budgets diferentes no mesmo ciclo", () => {
    const dir = mkdtempSync(join(tmpdir(), "group-registry-accum-"));
    try {
      appendGroupListsRegistry(dir, "2606-07", "ramp-warm", [
        { listId: 69, listName: "lista 1", count: 6403, importedAt: "2026-07-10T12:00:00.000Z" },
      ]);
      appendGroupListsRegistry(dir, "2606-07", "ramp-warm", [
        { listId: 70, listName: "lista 2", count: 7043, importedAt: "2026-07-10T13:00:00.000Z" },
      ]);
      appendGroupListsRegistry(dir, "2606-07", "ramp-warm", [
        { listId: 71, listName: "lista 3", count: 7748, importedAt: "2026-07-10T14:00:00.000Z" },
      ]);

      const parsed = JSON.parse(readFileSync(groupListsRegistryPath(dir, "ramp-warm"), "utf8"));
      assert.equal(parsed.lists.length, 3, "as 3 invocações devem se acumular, não sobrescrever");
      assert.deepEqual(parsed.lists.map((l: GroupListEntry) => l.listId), [69, 70, 71]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("JSON corrompido pré-existente → recomeça do zero (não trava o import)", () => {
    const dir = mkdtempSync(join(tmpdir(), "group-registry-corrupt-"));
    try {
      writeFileSync(groupListsRegistryPath(dir, "engajados"), "{ not json", "utf8");
      appendGroupListsRegistry(dir, "2606-07", "engajados", [
        { listId: 5, listName: "lista nova", count: 100, importedAt: "2026-07-10T12:00:00.000Z" },
      ]);
      const parsed = JSON.parse(readFileSync(groupListsRegistryPath(dir, "engajados"), "utf8"));
      assert.equal(parsed.lists.length, 1, "deve conter só a entrada nova, sem lançar por causa do JSON corrompido");
      assert.equal(parsed.lists[0].listId, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dois grupos diferentes no mesmo ciclo → arquivos separados, sem colisão", () => {
    const dir = mkdtempSync(join(tmpdir(), "group-registry-two-groups-"));
    try {
      appendGroupListsRegistry(dir, "2606-07", "engajados", [
        { listId: 10, listName: "engajados list", count: 500, importedAt: "2026-07-10T12:00:00.000Z" },
      ]);
      appendGroupListsRegistry(dir, "2606-07", "reativacao", [
        { listId: 20, listName: "reativacao list", count: 300, importedAt: "2026-07-10T12:05:00.000Z" },
      ]);

      const engajados = JSON.parse(readFileSync(groupListsRegistryPath(dir, "engajados"), "utf8"));
      const reativacao = JSON.parse(readFileSync(groupListsRegistryPath(dir, "reativacao"), "utf8"));
      assert.equal(engajados.lists.length, 1);
      assert.equal(engajados.lists[0].listId, 10);
      assert.equal(reativacao.lists.length, 1);
      assert.equal(reativacao.lists[0].listId, 20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #4577 — clarice-import-waves declarava sucesso só por a Brevo ter aceitado
// o POST /contacts/import, sem NUNCA confirmar que o processo assíncrono
// tinha terminado, nem que a lista de fato recebeu todos os contatos do CSV
// enviado. Um contato (a15276@aecampo.pt) foi perdido em silêncio: o
// processo terminou 'completed', mas a lista ficou com menos contatos que o
// CSV — só a reconciliação contra a contagem confirmada da Brevo pega isso.
// ---------------------------------------------------------------------------

describe("validateProcessId (#4577 item 1)", () => {
  it("número finito → aceita", () => {
    assert.equal(validateProcessId(42), 42);
  });

  it("string não-vazia → aceita", () => {
    assert.equal(validateProcessId("abc-123"), "abc-123");
  });

  it("ausente/null/undefined → lança", () => {
    assert.throws(() => validateProcessId(undefined), /processId ausente\/inválido/);
    assert.throws(() => validateProcessId(null), /processId ausente\/inválido/);
  });

  it("string vazia/em branco → lança", () => {
    assert.throws(() => validateProcessId(""), /processId ausente\/inválido/);
    assert.throws(() => validateProcessId("   "), /processId ausente\/inválido/);
  });

  it("NaN/Infinity → lança (não é um processId usável)", () => {
    assert.throws(() => validateProcessId(NaN));
    assert.throws(() => validateProcessId(Infinity));
  });
});

describe("importOneWave (#4577 — confirma o processo assíncrono + reconcilia contagem)", () => {
  const wave: WaveDef = { key: "W1", file: "w1-store.csv", desc: "re-envio (engajado)" };
  const plan = {
    wave,
    listName: "Clarice Jun/2026 W1 — re-envio (engajado)",
    csv: "EMAIL,NOME\na@x.com,Ana\nb@x.com,Bia\nvjpixel@gmail.com,Pixel (editor)\n",
    sentCount: 3, // 2 contatos reais + 1 cópia do editor
  };
  const noSleep = { sleep: async () => {}, intervalMs: 0 };

  function makeFakeClient(overrides: Partial<ImportRunClient> = {}): ImportRunClient {
    return {
      createList: async () => ({ id: 99 }),
      importCsv: async () => ({ processId: "proc-1" }),
      pollProcess: async () => ({ status: "completed" }),
      getListInfo: async () => ({ totalSubscribers: plan.sentCount }),
      // #4720: default devolve TODOS os e-mails do plano — só sobrescrito
      // pelos testes que exercitam o diff de contato perdido.
      listContactEmails: async () => ["a@x.com", "b@x.com", "vjpixel@gmail.com"],
      ...overrides,
    };
  }

  // Cenário (a) da issue: processo que termina 'failed' → rejeita (o
  // chamador real, main(), propaga isso como exit ≠ 0).
  it("(a) processo termina 'failed' → rejeita, nunca declara sucesso", async () => {
    const client = makeFakeClient({ pollProcess: async () => ({ status: "failed" }) });
    await assert.rejects(
      () => importOneWave(client, plan, { folderId: 1, poll: noSleep }),
      /falhou/,
    );
  });

  // Cenário (b) da issue: processo 'completed', mas a lista confirma MENOS
  // contatos que o CSV enviado (o caso real do a15276@aecampo.pt — o
  // processo relata sucesso, a linha simplesmente não entrou). É esta
  // checagem — não o poll — que detecta o caso real.
  it("(b) completed com contagem confirmada MENOR que o CSV enviado → aborta nomeando a lista e o delta", async () => {
    const client = makeFakeClient({ getListInfo: async () => ({ totalSubscribers: plan.sentCount - 1 }) });
    await assert.rejects(
      () => importOneWave(client, plan, { folderId: 1, poll: noSleep }),
      (err: Error) => {
        assert.match(err.message, /lista #99/);
        assert.match(err.message, /1 contato\(s\) perdido/);
        assert.match(err.message, /Brevo confirma 2/);
        assert.match(err.message, /CSV enviado tinha 3/);
        return true;
      },
    );
  });

  // #4720: a divergência de contagem sozinha só dizia "1 contato perdido" —
  // o operador tinha que paginar a lista e diffar à mão pra saber QUEM.
  describe("#4720 — diagnóstico automático do contato perdido + comando de limpeza", () => {
    it("nomeia o e-mail que faltou na lista (diff CSV × membros reais)", async () => {
      // b@x.com está no CSV mas NÃO voltou na paginação da lista real.
      const client = makeFakeClient({
        getListInfo: async () => ({ totalSubscribers: plan.sentCount - 1 }),
        listContactEmails: async () => ["a@x.com", "vjpixel@gmail.com"],
      });
      await assert.rejects(
        () => importOneWave(client, plan, { folderId: 1, poll: noSleep }),
        (err: Error) => {
          assert.match(err.message, /Contato\(s\) identificado\(s\): b@x\.com/);
          return true;
        },
      );
    });

    it("imprime o comando curl DELETE exato pra limpar a lista órfã (bash E PowerShell), nunca apaga sozinho", async () => {
      const client = makeFakeClient({
        getListInfo: async () => ({ totalSubscribers: plan.sentCount - 1 }),
        listContactEmails: async () => ["a@x.com", "vjpixel@gmail.com"],
      });
      await assert.rejects(
        () => importOneWave(client, plan, { folderId: 1, poll: noSleep }),
        (err: Error) => {
          assert.match(err.message, /curl -X DELETE "https:\/\/api\.brevo\.com\/v3\/contacts\/lists\/99"/);
          assert.match(err.message, /-H "api-key: \$BREVO_CLARICE_API_KEY"/);
          // #4720 self-review: $VAR só expande em bash — em PowerShell (shell
          // primário deste projeto) viraria header vazio, silenciosamente.
          assert.match(err.message, /curl\.exe -X DELETE/);
          assert.match(err.message, /-H "api-key: \$env:BREVO_CLARICE_API_KEY"/);
          return true;
        },
      );
    });

    it("diff que não acha ninguém faltando ainda assim não esconde o erro original", async () => {
      // Caso raro/defensivo: a lista real tem todo mundo do CSV mas
      // totalSubscribers ainda diverge (ex: paginação capturou um estado
      // intermediário) — a mensagem reporta a ambiguidade, não finge certeza.
      const client = makeFakeClient({
        getListInfo: async () => ({ totalSubscribers: plan.sentCount - 1 }),
        listContactEmails: async () => ["a@x.com", "b@x.com", "vjpixel@gmail.com"],
      });
      await assert.rejects(
        () => importOneWave(client, plan, { folderId: 1, poll: noSleep }),
        (err: Error) => {
          assert.match(err.message, /não identificou o e-mail exato/);
          return true;
        },
      );
    });

    it("diagnóstico automático que FALHA nunca engole o erro original de reconciliação", async () => {
      const client = makeFakeClient({
        getListInfo: async () => ({ totalSubscribers: plan.sentCount - 1 }),
        listContactEmails: async () => {
          throw new Error("Brevo API 500 em /contacts/lists/99/contacts");
        },
      });
      await assert.rejects(
        () => importOneWave(client, plan, { folderId: 1, poll: noSleep }),
        (err: Error) => {
          assert.match(err.message, /1 contato\(s\) perdido/);
          assert.match(err.message, /diagnóstico automático do contato falhou/);
          assert.match(err.message, /Brevo API 500/);
          return true;
        },
      );
    });
  });

  it("(c) caso feliz — completed com contagem batendo → resolve com a contagem CONFIRMADA (não a enviada)", async () => {
    const client = makeFakeClient();
    const result = await importOneWave(client, plan, { folderId: 1, poll: noSleep, now: () => "2026-08-04T12:00:00.000Z" });
    assert.deepEqual(result, {
      wave: "W1",
      listId: 99,
      listName: plan.listName,
      count: 3, // #4577 item 4: grava a contagem CONFIRMADA pela Brevo
      sentCount: 3,
      importedAt: "2026-08-04T12:00:00.000Z",
    });
  });

  it("contagem confirmada MAIOR que o CSV enviado (lista pré-existia com outros contatos) → não é tratado como perda, resolve normalmente", async () => {
    const client = makeFakeClient({ getListInfo: async () => ({ totalSubscribers: plan.sentCount + 5 }) });
    const result = await importOneWave(client, plan, { folderId: 1, poll: noSleep });
    assert.equal(result.count, plan.sentCount + 5);
  });

  // #4764 — caso real: montando a onda d8 do ciclo 2607-08, o import
  // reconciliou 1915 confirmados contra 1916 enviados. O contato
  // (m.afonso1208@gmail.com) tinha blacklist GLOBAL na conta Brevo — nunca
  // receberia o e-mail de qualquer forma, apagar/recriar a lista não
  // resolveria nada. `getListInfo` já trazia `totalBlacklisted: 1` na mesma
  // resposta; antes desta issue o código não usava o campo e tratava como
  // o mesmo drop silencioso do #4577/#4720.
  describe("#4764 — distingue blacklist administrativo de perda real", () => {
    it("delta === totalBlacklisted → supressão esperada, NÃO aborta, resolve com a contagem confirmada", async () => {
      const client = makeFakeClient({
        getListInfo: async () => ({ totalSubscribers: plan.sentCount - 1, totalBlacklisted: 1 }),
      });
      const result = await importOneWave(client, plan, { folderId: 1, poll: noSleep, now: () => "2026-08-07T09:00:00.000Z" });
      assert.deepEqual(result, {
        wave: "W1",
        listId: 99,
        listName: plan.listName,
        count: plan.sentCount - 1,
        sentCount: plan.sentCount,
        importedAt: "2026-08-07T09:00:00.000Z",
      });
    });

    it("delta === totalBlacklisted → loga a supressão como informação, não como erro", async () => {
      const logs: string[] = [];
      const client = makeFakeClient({
        getListInfo: async () => ({ totalSubscribers: plan.sentCount - 1, totalBlacklisted: 1 }),
      });
      await importOneWave(client, plan, { folderId: 1, poll: noSleep, log: (m) => logs.push(m) });
      const joined = logs.join("\n");
      assert.match(joined, /suprimido\(s\) por blacklist administrativo/);
      assert.match(joined, /não é perda/);
    });

    it("delta > totalBlacklisted (perda parcial real, ALÉM da blacklist) → ainda aborta", async () => {
      // 2 perdidos no total, só 1 é blacklist — o outro é o drop silencioso
      // real que #4577/#4720 existem pra pegar; não pode ser mascarado.
      const client = makeFakeClient({
        getListInfo: async () => ({ totalSubscribers: plan.sentCount - 2, totalBlacklisted: 1 }),
      });
      await assert.rejects(
        () => importOneWave(client, plan, { folderId: 1, poll: noSleep }),
        /2 contato\(s\) perdido/,
      );
    });

    it("totalBlacklisted ausente na resposta (fake antigo / campo faltando) → comportamento anterior preservado, aborta", async () => {
      const client = makeFakeClient({ getListInfo: async () => ({ totalSubscribers: plan.sentCount - 1 }) });
      await assert.rejects(
        () => importOneWave(client, plan, { folderId: 1, poll: noSleep }),
        /perdido\(s\) em/,
      );
    });

    it("totalBlacklisted === 0 (campo presente, mas ninguém suprimido) → delta não bate com 0, aborta normalmente", async () => {
      const client = makeFakeClient({
        getListInfo: async () => ({ totalSubscribers: plan.sentCount - 1, totalBlacklisted: 0 }),
      });
      await assert.rejects(
        () => importOneWave(client, plan, { folderId: 1, poll: noSleep }),
        /perdido\(s\) em/,
      );
    });
  });
});

// #4577 item 1: `makeRealImportRunClient` (o transporte REAL, usado só por
// `main()`) é onde `validateProcessId` de fato entra em jogo — antes desta
// issue, a resposta de `POST /contacts/import` era lida como `{ processId?:
// unknown }` e nunca validada; um `processId` ausente/malformado seguia
// adiante como se nada tivesse acontecido. Mocka `fetch` global (mesmo
// padrão de test/brevo-send-now-4347.test.ts) pra provar a validação
// realmente ACONTECE no ponto de entrada real, não só na função pura isolada.
describe("makeRealImportRunClient().importCsv (#4577 item 1 — validação real do processId)", () => {
  function jsonRes(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }

  it("POST /contacts/import sem processId no corpo → rejeita (não segue como se tivesse disparado)", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => jsonRes(200, {})) as typeof fetch;
    try {
      const client = makeRealImportRunClient("fake-key");
      await assert.rejects(
        () => client.importCsv(99, "EMAIL\na@x.com\n"),
        /processId ausente\/inválido/,
      );
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("POST /contacts/import com processId válido → resolve com ele", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => jsonRes(200, { processId: 4242 })) as typeof fetch;
    try {
      const client = makeRealImportRunClient("fake-key");
      const { processId } = await client.importCsv(99, "EMAIL\na@x.com\n");
      assert.equal(processId, 4242);
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe("buildPlan — sentCount inclui as cópias do editor (#4577)", () => {
  it("sentCount = contatos reais + linhas de cópia do editor (count fica só com os reais)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bp-sentcount-"));
    try {
      writeFileSync(
        join(dir, "waves-manifest.json"),
        JSON.stringify([{ key: "W1", file: "w1-store.csv", desc: "re-envio (engajado)" }]),
      );
      writeFileSync(join(dir, "w1-store.csv"), "email,NOME\na@x.com,Ana\nb@x.com,Bia\n");
      const plans = buildPlan("Jun/2026", "2606-07", dir) as unknown as { count: number; sentCount: number }[];
      assert.equal(plans[0].count, 2, "count continua só os contatos reais (#3455)");
      assert.ok(
        plans[0].sentCount > plans[0].count,
        `sentCount (${plans[0].sentCount}) deve ser MAIOR que count (${plans[0].count}) — inclui as cópias do editor`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
