import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  listNameFor,
  groupCellListNameFor,
  resolveListName,
  countRows,
  normalizeImportCsv,
  parseArgs,
  findExistingConflicts,
  buildPlan,
  loadWaveDefs,
  groupListsRegistryPath,
  appendGroupListsRegistry,
  type WaveDef,
  type GroupListEntry,
} from "../scripts/clarice-import-waves.ts";
import { buildSegmentArtifact, type SegmentRow } from "../scripts/clarice-build-segment.ts";
import { campaignNameFor } from "../scripts/clarice-schedule-group.ts";
import { parseAbcAudienceCampaign } from "../workers/brevo-dashboard/src/index.ts";
import { EDITOR_COPY_EMAIL } from "../scripts/lib/editor-copy.ts";

describe("loadWaveDefs (#2656/#2844)", () => {
  it("sem manifest → erro claro (rode clarice-build-waves-store)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wd-legacy-"));
    try {
      assert.throws(() => loadWaveDefs(dir), /waves-manifest\.json ausente/);
      assert.throws(() => loadWaveDefs(dir), /clarice-build-waves-store/);
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
