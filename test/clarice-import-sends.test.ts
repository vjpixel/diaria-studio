import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sendListName,
  toImportCsv,
  parseArgs,
  mergeSendsSummaryWithListIds,
  importOneSend,
} from "../scripts/clarice-import-sends.ts";
import { countRows, extractCsvEmails, type ImportRunClient } from "../scripts/clarice-import-waves.ts";
import { EDITOR_COPY_EMAIL, EDITOR_SEED_EMAILS } from "../scripts/lib/editor-copy.ts";

describe("sendListName", () => {
  it("nome determinístico: dNN zero-padded + dia planejado", () => {
    assert.equal(sendListName(1, "qua", "Jun/2026"), "Clarice Jun/2026 d01 (qua)");
    assert.equal(sendListName(21, "ter", "Jun/2026"), "Clarice Jun/2026 d21 (ter)");
  });
});

describe("toImportCsv", () => {
  it("reduz a email+NOME (descarta TIER) e normaliza header -> EMAIL", () => {
    const { csv, count } = toImportCsv("email,NOME,TIER\na@b.com,Ana,maio\nc@d.com,Caio,T2\n");
    assert.ok(csv.startsWith("EMAIL,NOME"), `header: ${csv.split("\n")[0]}`);
    assert.ok(!/TIER/.test(csv), "TIER não deve ir pro Brevo");
    assert.ok(csv.includes("a@b.com,Ana"));
    assert.equal(count, 2);
  });

  it("aceita variação 'E-mail' e trim no email", () => {
    const { csv, count } = toImportCsv("Nome,E-mail\nZé,  x@y.com \n");
    assert.equal(csv.split("\n")[0], "EMAIL,NOME");
    assert.ok(csv.includes("x@y.com"));
    assert.equal(count, 1);
  });

  // #2018: coluna NOME detectada por regex (/^nome$/i) — antes era literal "NOME".
  // Export do Drive com header "Nome" (capitalized) zerava silenciosamente todos
  // os nomes (r["NOME"] era undefined → ""). Regressão: este teste quebra se a
  // detecção voltar pra literal.
  it("#2018: 'Nome' (capitalized) é reconhecido como coluna NOME", () => {
    const { csv } = toImportCsv("E-mail,Nome,TIER\na@b.com,Pedro,T1\n");
    assert.ok(csv.includes("Pedro"), `NOME deve ser 'Pedro', mas csv='${csv}'`);
  });

  it("#2018: 'nome' (lowercase) é reconhecido como coluna NOME", () => {
    const { csv } = toImportCsv("email,nome\na@b.com,Luiza\n");
    assert.ok(csv.includes("Luiza"), `NOME deve ser 'Luiza', mas csv='${csv}'`);
  });

  it("#2018: NOME ausente resulta em string vazia, não undefined visível", () => {
    // Sem coluna NOME reconhecível — não deve lançar, só deixar vazio
    const { csv } = toImportCsv("email,OUTRA\na@b.com,X\n");
    // Linha deve ter email + campo vazio (não undefined/null literal)
    assert.ok(csv.includes("a@b.com,"), `linha deve ter email e campo vazio: '${csv}'`);
    assert.ok(!/undefined/.test(csv), "csv não deve conter 'undefined'");
  });

  // #3455: todo envio real criado a partir deste helper (dNN diário, e por
  // reuso em clarice-split-cells.ts, cada célula A/B/C) deve incluir o
  // editor como destinatário — regressão pro caso real (CSV que vai pro
  // Brevo /contacts/import).
  it("#3455: o CSV final inclui EDITOR_COPY_EMAIL, mas count reflete só contatos reais", () => {
    const { csv, count } = toImportCsv("email,NOME\na@b.com,Ana\nc@d.com,Caio\n");
    assert.ok(csv.includes(EDITOR_COPY_EMAIL), `csv deve incluir o editor: ${csv}`);
    assert.equal(count, 2, "count não deve contar a linha injetada do editor");
  });

  it("#3455: idempotente — se o editor já está na lista real, não duplica", () => {
    const { csv } = toImportCsv(`email,NOME\n${EDITOR_COPY_EMAIL},Pixel\na@b.com,Ana\n`);
    const occurrences = csv.split(EDITOR_COPY_EMAIL).length - 1;
    assert.equal(occurrences, 1, `email do editor não deve duplicar: ${csv}`);
  });

  // #4602: sentCount (usado na reconciliação pós-import de importOneSend) é
  // countRows(csv) — o CSV final já inclui a cópia do editor, então deve
  // exceder `count` (que reflete só os contatos reais).
  it("#4602: countRows(csv) > count quando o CSV final inclui a cópia do editor", () => {
    const { csv, count } = toImportCsv("email,NOME\na@b.com,Ana\nc@d.com,Caio\n");
    assert.ok(
      countRows(csv) > count,
      `sentCount (countRows(csv)=${countRows(csv)}) deve ser maior que count real (${count})`,
    );
  });
});

describe("parseArgs", () => {
  it("defaults: dry-run, label Jun/2026, folder 1, only null", () => {
    const a = parseArgs([]);
    assert.equal(a.execute, false);
    assert.equal(a.label, "Jun/2026");
    assert.equal(a.folderId, 1);
    assert.equal(a.only, null);
  });

  it("--execute, --label, --folder-id, --only", () => {
    const a = parseArgs(["--execute", "--label", "Mai→Jun", "--folder-id", "4", "--only", "1,2,3"]);
    assert.equal(a.execute, true);
    assert.equal(a.label, "Mai→Jun");
    assert.equal(a.folderId, 4);
    assert.deepEqual(a.only, [1, 2, 3]);
  });

  it("--label não engole a flag seguinte", () => {
    const a = parseArgs(["--label", "--execute"]);
    assert.equal(a.label, "Jun/2026");
    assert.equal(a.execute, true);
  });

  it("--folder-id inválido cai no default 1", () => {
    assert.equal(parseArgs(["--folder-id", "abc"]).folderId, 1);
    assert.equal(parseArgs(["--folder-id", "0"]).folderId, 1);
  });
});

// Regressão #2007 (Fix 1): roundtrip import→sends-summary→schedule.
// clarice-import-sends deve gravar {n → listId} em sends-summary.json após --execute,
// caso contrário clarice-schedule-sends não encontra listId e S2/S3 --create falha.
// Se mergeSendsSummaryWithListIds for revertida (ex: remover a injeção de listId),
// todos estes testes quebram, cumprindo a regra #633.
describe("mergeSendsSummaryWithListIds (roundtrip import→summary #2007)", () => {
  const makeSummary = (sends: { n: number; [k: string]: unknown }[]) => ({ sends });

  it("injeta listId nos sends correspondentes", () => {
    const summary = makeSummary([
      { n: 8, file: "d08-17jun.csv", day: "ter", week: 2, planned: 1900, actual: 1898, comp: {} },
      { n: 9, file: "d09-18jun.csv", day: "qua", week: 2, planned: 1900, actual: 1899, comp: {} },
    ]);
    const results = [
      { n: 8, listId: 4201, processId: "pid-1", count: 1898 },
      { n: 9, listId: 4202, processId: "pid-2", count: 1899 },
    ];
    const merged = mergeSendsSummaryWithListIds(summary, results);
    assert.equal(merged.sends[0].listId, 4201, "d08 deve ter listId=4201");
    assert.equal(merged.sends[1].listId, 4202, "d09 deve ter listId=4202");
  });

  it("preserva todos os campos existentes (file, day, week, comp) — merge cirúrgico", () => {
    const comp = { T2: 500, T3: 1398 };
    const summary = makeSummary([
      { n: 8, file: "d08-17jun.csv", day: "ter", week: 2, planned: 1900, actual: 1898, comp },
    ]);
    const merged = mergeSendsSummaryWithListIds(summary, [{ n: 8, listId: 9999, processId: "x", count: 1898 }]);
    const s = merged.sends[0];
    assert.equal(s.file, "d08-17jun.csv", "file preservado");
    assert.equal(s.day, "ter", "day preservado");
    assert.equal(s.week, 2, "week preservado");
    assert.equal(s.planned, 1900, "planned preservado");
    assert.equal(s.actual, 1898, "actual preservado");
    assert.deepEqual(s.comp, comp, "comp preservado");
    assert.equal(s.listId, 9999, "listId injetado");
  });

  it("não injeta listId em sends sem resultado correspondente", () => {
    const summary = makeSummary([
      { n: 8, file: "d08.csv", day: "ter", week: 2 },
      { n: 9, file: "d09.csv", day: "qua", week: 2 },
    ]);
    // Só d08 foi importada
    const merged = mergeSendsSummaryWithListIds(summary, [{ n: 8, listId: 4201, processId: "x", count: 10 }]);
    assert.equal(merged.sends[0].listId, 4201, "d08 tem listId");
    assert.ok(!("listId" in merged.sends[1]), "d09 não deve ter listId injetado");
  });

  it("idempotente: reimportar send já com listId atualiza para o novo valor", () => {
    const summary = makeSummary([{ n: 8, file: "d08.csv", day: "ter", week: 2, listId: 4201 }]);
    const merged = mergeSendsSummaryWithListIds(summary, [{ n: 8, listId: 9999, processId: "x", count: 10 }]);
    assert.equal(merged.sends[0].listId, 9999, "listId atualizado para novo valor");
  });

  it("lista vazia de resultados não altera sends", () => {
    const summary = makeSummary([{ n: 8, file: "d08.csv", day: "ter", week: 2 }]);
    const merged = mergeSendsSummaryWithListIds(summary, []);
    assert.deepEqual(merged.sends, summary.sends);
  });
});

// ---------------------------------------------------------------------------
// #4602 — mesmo padrão do #4577 (clarice-import-waves.ts): clarice-import-sends
// disparava o import assíncrono e declarava sucesso sem NUNCA confirmar que o
// processo tinha terminado, nem reconciliar a contagem de contatos ingeridos
// contra o CSV enviado. importOneSend fecha esse gap reusando o poller
// genérico (pollProcessUntilTerminal) + o ImportRunClient genérico (ambos já
// extraídos de clarice-import-waves.ts no #4577) — mesmos 3 cenários de
// regressão da issue original, adaptados à estrutura Plan{n, day} deste
// arquivo em vez de Plan{wave}.
// ---------------------------------------------------------------------------

describe("importOneSend (#4602 — confirma o processo assíncrono + reconcilia contagem)", () => {
  const plan = {
    n: 1,
    day: "qua",
    listName: "Clarice Jun/2026 d01 (qua)",
    csv: `EMAIL,NOME\na@x.com,Ana\nb@x.com,Bia\n${EDITOR_COPY_EMAIL},Pixel (editor)\n`,
    sentCount: 3, // 2 contatos reais + 1 cópia do editor
  };
  const noSleep = { sleep: async () => {}, intervalMs: 0 };

  function makeFakeClient(overrides: Partial<ImportRunClient> = {}): ImportRunClient {
    return {
      createList: async () => ({ id: 55 }),
      importCsv: async () => ({ processId: "proc-9" }),
      pollProcess: async () => ({ status: "completed" }),
      getListInfo: async () => ({ totalSubscribers: plan.sentCount }),
      // #14366: default devolve TODOS os e-mails do plano — sobrescrito pelos
      // testes que exercitam o diff (leitor real perdido / só a cópia do editor).
      listContactEmails: async () => ["a@x.com", "b@x.com", EDITOR_COPY_EMAIL],
      ...overrides,
    };
  }

  // Cenário (a) da issue: processo que termina 'failed' → rejeita (main()
  // propaga isso como exit ≠ 0, antes de gravar listId em sends-summary.json).
  it("(a) processo termina 'failed' → rejeita, nunca declara sucesso", async () => {
    const client = makeFakeClient({ pollProcess: async () => ({ status: "failed" }) });
    await assert.rejects(
      () => importOneSend(client, plan, { folderId: 1, poll: noSleep }),
      /falhou/,
    );
  });

  // Cenário (b) da issue: processo 'completed', mas a lista confirma MENOS
  // contatos que o CSV enviado — o mesmo caso real do #4577
  // (a15276@aecampo.pt) poderia acontecer em qualquer envio dNN da rampa
  // diária, não só nas waves.
  it("(b) completed com contagem confirmada MENOR que o CSV enviado → aborta nomeando a lista e o delta", async () => {
    // #14366: a lista real mostra o leitor b@x.com ausente — com todos os
    // leitores presentes e delta <= nº de cópias do editor, o delta é só da
    // cópia de conferência e o import segue (describe #14366 abaixo).
    const client = makeFakeClient({
      getListInfo: async () => ({ totalSubscribers: plan.sentCount - 1 }),
      listContactEmails: async () => ["a@x.com", EDITOR_COPY_EMAIL],
    });
    await assert.rejects(
      () => importOneSend(client, plan, { folderId: 1, poll: noSleep }),
      (err: Error) => {
        assert.match(err.message, /lista #55/);
        assert.match(err.message, /1 contato\(s\) perdido/);
        assert.match(err.message, /Brevo confirma 2/);
        assert.match(err.message, /CSV enviado tinha 3/);
        assert.match(err.message, /Contato\(s\) identificado\(s\): b@x\.com\./);
        return true;
      },
    );
  });

  // Cenário (c) da issue: caso feliz — o registro final reflete a contagem
  // CONFIRMADA pela Brevo, não a enviada.
  it("(c) caso feliz — completed com contagem batendo → resolve com a contagem CONFIRMADA (não a enviada)", async () => {
    const client = makeFakeClient();
    const result = await importOneSend(client, plan, {
      folderId: 1,
      poll: noSleep,
      now: () => "2026-08-04T12:00:00.000Z",
    });
    assert.deepEqual(result, {
      n: 1,
      listId: 55,
      listName: plan.listName,
      count: 3, // #4602: grava a contagem CONFIRMADA pela Brevo
      sentCount: 3,
      importedAt: "2026-08-04T12:00:00.000Z",
    });
  });

  it("contagem confirmada MAIOR que o CSV enviado (lista pré-existia com outros contatos) → não é tratado como perda, resolve normalmente", async () => {
    const client = makeFakeClient({ getListInfo: async () => ({ totalSubscribers: plan.sentCount + 5 }) });
    const result = await importOneSend(client, plan, { folderId: 1, poll: noSleep });
    assert.equal(result.count, plan.sentCount + 5);
  });

  // #14366 — follow-up do #14337: a mesma tolerância que `importOneWave`
  // ganhou, agora nos envios dNN. CSV real de envio passa por `toImportCsv`,
  // que injeta TODAS as cópias do editor (EDITOR_SEED_EMAILS).
  describe("#14366 — delta só das cópias do editor não aborta; leitor real perdido continua abortando", () => {
    const readers = Array.from({ length: 5 }, (_, i) => `leitor${i}@x.com`);
    const { csv } = toImportCsv(`email,NOME\n${readers.map((e, i) => `${e},L${i}`).join("\n")}\n`);
    const sendPlan = { n: 3, listName: "Clarice Jun/2026 d03 (sex)", csv, sentCount: countRows(csv) };
    const seeds = EDITOR_SEED_EMAILS.map((s) => s.toLowerCase());

    it("pré-condição: o CSV carrega os 5 leitores + todas as cópias do editor", () => {
      const emails = extractCsvEmails(csv);
      assert.equal(sendPlan.sentCount, readers.length + seeds.length);
      for (const s of seeds) assert.ok(emails.includes(s));
    });

    it("(a) cópias do editor fora da lista, todos os leitores presentes → não aborta, avisa nomeando as cópias", async () => {
      const logs: string[] = [];
      const client = makeFakeClient({
        getListInfo: async () => ({ totalSubscribers: readers.length }),
        listContactEmails: async () => readers,
      });
      const result = await importOneSend(client, sendPlan, { folderId: 1, poll: noSleep, log: (m) => logs.push(m) });
      assert.equal(result.count, readers.length);
      assert.equal(result.sentCount, sendPlan.sentCount);
      const joined = logs.join("\n");
      assert.match(joined, new RegExp(`${seeds.length} cópia\\(s\\) do editor não entraram`));
      assert.match(joined, /Todos os 5 leitor\(es\) reais/);
      for (const s of seeds) assert.ok(joined.includes(s));
    });

    it("(a') todo e-mail do CSV aparece como membro, contagem só sem as cópias → não aborta", async () => {
      const logs: string[] = [];
      const client = makeFakeClient({
        getListInfo: async () => ({ totalSubscribers: readers.length }),
        listContactEmails: async () => extractCsvEmails(csv),
      });
      const result = await importOneSend(client, sendPlan, { folderId: 1, poll: noSleep, log: (m) => logs.push(m) });
      assert.equal(result.count, readers.length);
      assert.match(logs.join("\n"), /fora da contagem de inscritos/);
    });

    it("(b) um leitor real perdido (delta cabe nas cópias) → continua abortando e nomeia o leitor", async () => {
      const client = makeFakeClient({
        getListInfo: async () => ({ totalSubscribers: sendPlan.sentCount - 1 }),
        listContactEmails: async () => [...readers.slice(1), ...seeds],
      });
      await assert.rejects(
        () => importOneSend(client, sendPlan, { folderId: 1, poll: noSleep }),
        (err: Error) => {
          assert.match(err.message, /lista #55/);
          assert.match(err.message, /perdido\(s\) em/);
          assert.ok(err.message.includes(readers[0]), err.message);
          return true;
        },
      );
    });

    it("(c) delta maior que o nº de cópias do editor → aborta mesmo com o diff limpo", async () => {
      const client = makeFakeClient({
        getListInfo: async () => ({ totalSubscribers: sendPlan.sentCount - seeds.length - 1 }),
        listContactEmails: async () => extractCsvEmails(csv),
      });
      await assert.rejects(() => importOneSend(client, sendPlan, { folderId: 1, poll: noSleep }), /perdido\(s\) em/);
    });

    // #14406 — CSV com as cópias do editor e 1 leitor real em blacklist
    // global: o leitor é membro da lista (passa no diff) e fica fora da
    // contagem. Sem o check do #4764 o delta 1 era atribuído à cópia do editor.
    it("#14406: 1 leitor em blacklist (delta === totalBlacklisted) → supressão do #4764, nunca culpa a cópia do editor", async () => {
      const logs: string[] = [];
      const client = makeFakeClient({
        getListInfo: async () => ({ totalSubscribers: sendPlan.sentCount - 1, totalBlacklisted: 1 }),
        listContactEmails: async () => extractCsvEmails(csv),
      });
      const result = await importOneSend(client, sendPlan, { folderId: 1, poll: noSleep, log: (m) => logs.push(m) });
      assert.equal(result.count, sendPlan.sentCount - 1);
      const joined = logs.join("\n");
      assert.match(joined, /suprimido\(s\) por blacklist administrativo/);
      assert.doesNotMatch(joined, /cópia\(s\) do editor/);
    });

    it("#14406: delta sem seed fora da lista e sem bater a blacklist → segue, mas com causa não identificada", async () => {
      const logs: string[] = [];
      const client = makeFakeClient({
        getListInfo: async () => ({ totalSubscribers: sendPlan.sentCount - 1, totalBlacklisted: 0 }),
        listContactEmails: async () => extractCsvEmails(csv),
      });
      await importOneSend(client, sendPlan, { folderId: 1, poll: noSleep, log: (m) => logs.push(m) });
      const joined = logs.join("\n");
      assert.match(joined, /causa NÃO identificada/);
      assert.match(joined, /reporta 0 contato\(s\) da lista em blacklist/);
      assert.doesNotMatch(joined, /não deve chegar/);
    });

    it("(d) diff indisponível (paginação falha) → aborta, nunca assume que os leitores entraram", async () => {
      const client = makeFakeClient({
        getListInfo: async () => ({ totalSubscribers: readers.length }),
        listContactEmails: async () => {
          throw new Error("HTTP 500");
        },
      });
      await assert.rejects(
        () => importOneSend(client, sendPlan, { folderId: 1, poll: noSleep }),
        /diagnóstico automático do contato falhou: HTTP 500/,
      );
    });
  });
});
