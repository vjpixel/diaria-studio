/**
 * test/teste-2608-emenda.test.ts (#8238 — resíduo da Emenda 17/09, #8249)
 *
 * Regressão do defeito que sobrou depois do guard de 1fff3e28: a apuração de
 * 21/10 congelou o funil ACUMULADO (sem recorte de coorte, sem fases, sem
 * "sem sinal", sem razão detectável). Estes testes travam a régua da Emenda
 * em `scripts/lib/teste-2608-emenda.ts` e a ligação com `cac-report.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeEmendaArm,
  computeEmendaSection,
  evaluateEmendaVerdict,
  formatEmendaSectionMarkdown,
  parseEmendaGastoPorFase,
  resolveEmendaPhaseWindows,
  type EmendaArmResult,
  type EmendaRunStateInput,
} from "../scripts/lib/teste-2608-emenda.ts";
import { main as cacReportMain } from "../scripts/cac-report.ts";
import type { BeehiivBackupSubscriber } from "../scripts/lib/beehiiv-backup-snapshots.ts";
import type { SpendRow } from "../scripts/lib/aquisicao-spend.ts";

const G = "Google Ads (teste 2608)";
const M = "Meta Ads (teste 2608)";
const MS = "Microsoft Ads (teste 2608)";

/** Mesmo shape do `run-state.json` real (revisão 17/09 + encerramento 23/09). */
const RUN_STATE: EmendaRunStateInput = {
  d0: "2026-09-05",
  fim_janela: "2026-09-23",
  bracos: [G, MS, M],
  revisao: {
    pausa: {
      inicio: "2026-09-09T16:05:36-03:00",
      fim: "2026-09-17T00:16:00-03:00",
      inicio_por_braco: {
        [G]: "2026-09-09T16:05:49-03:00",
        [M]: "2026-09-09T16:05:36-03:00",
        [MS]: "2026-09-09T16:18:21-03:00",
      },
    } as never,
  },
};

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function sub(utm: string, createdIso: string, opts: Partial<{ status: string; received: number; clicked: number; email: string }> = {}): BeehiivBackupSubscriber {
  return {
    email: opts.email ?? `${utm}-${createdIso}-${Math.random()}@example.com`,
    status: opts.status ?? "active",
    created: sec(createdIso),
    utm_source: utm,
    utm_medium: "",
    utm_campaign: "",
    referring_site: "",
    stats: { total_received: opts.received ?? 25, total_unique_clicked: opts.clicked ?? 0 },
  } as BeehiivBackupSubscriber;
}
const leitor = (utm: string, iso: string) => sub(utm, iso, { received: 25, clicked: 5 });

const spend = (canal: string, mes: string, valor: number): SpendRow => ({ canal, mes, moeda: "BRL", valor, fonte: "teste" });

describe("resolveEmendaPhaseWindows", () => {
  it("1 pausa → pré-pausa até o início DO BRAÇO e pós-retomada até fim_janela 23h59 BRT", () => {
    const ms = resolveEmendaPhaseWindows(RUN_STATE, MS);
    assert.deepEqual(ms.map((f) => f.id), ["pre-pausa", "pos-retomada"]);
    assert.equal(ms[0].inicioMs, Date.parse("2026-09-05T00:00:00-03:00"));
    assert.equal(ms[0].fimExclusivoMs, Date.parse("2026-09-09T16:18:21-03:00"), "Microsoft pausou 13 min depois");
    assert.equal(ms[1].inicioMs, Date.parse("2026-09-17T00:16:00-03:00"));
    assert.equal(ms[1].fimExclusivoMs, Date.parse("2026-09-24T00:00:00-03:00"));
    const g = resolveEmendaPhaseWindows(RUN_STATE, G);
    assert.equal(g[0].fimExclusivoMs, Date.parse("2026-09-09T16:05:49-03:00"));
  });

  it("sem pausa → fase única 'janela'", () => {
    const f = resolveEmendaPhaseWindows({ ...RUN_STATE, revisao: undefined }, G);
    assert.equal(f.length, 1);
    assert.equal(f[0].id, "janela");
  });

  it("pausa com fim antes do início falha alto", () => {
    assert.throws(() =>
      resolveEmendaPhaseWindows({ ...RUN_STATE, revisao: { pausa: { inicio: "2026-09-10T00:00:00-03:00", fim: "2026-09-09T00:00:00-03:00" } } }, G),
    );
  });
});

describe("computeEmendaArm — coorte recortada pelas fases", () => {
  it("cadastro na pausa, antes do D0 ou depois do fim da janela NÃO entra (o funil acumulado contava)", () => {
    const subs = [
      sub("google-ads", "2026-09-06T10:00:00-03:00"), // pré
      sub("google-ads", "2026-09-12T10:00:00-03:00"), // pausa
      sub("google-ads", "2026-09-04T23:00:00-03:00"), // antes do D0
      sub("google-ads", "2026-09-20T10:00:00-03:00"), // pós
      sub("google-ads", "2026-10-01T10:00:00-03:00"), // depois do fim
      sub("meta-ads", "2026-09-06T10:00:00-03:00"), // outro braço
    ];
    const arm = computeEmendaArm(subs, [spend(G, "2026-09", 300)], RUN_STATE, G);
    assert.deepEqual(arm.fases.map((f) => f.cadastros), [1, 1]);
    assert.equal(arm.cadastros, 2);
    assert.equal(arm.membros.length, 2);
  });

  it("gasto total soma só meses dentro da janela e lista o mês de fora (Meta 2026-10)", () => {
    const arm = computeEmendaArm([], [spend(M, "2026-09", 1435.51), spend(M, "2026-10", 8.3)], RUN_STATE, M);
    assert.equal(arm.gastoTotalBrl, 1435.51);
    assert.deepEqual(arm.mesesForaDaJanela, ["2026-10"]);
  });

  it("menos de 3 leitor-v1 → sem sinal, sem custo por leitor", () => {
    const subs = [leitor("microsoft-ads", "2026-09-06T10:00:00-03:00"), leitor("microsoft-ads", "2026-09-20T10:00:00-03:00")];
    const arm = computeEmendaArm(subs, [spend(MS, "2026-09", 835.97)], RUN_STATE, MS);
    assert.equal(arm.leitores, 2);
    assert.equal(arm.semSinal, true);
    assert.equal(arm.custoPorLeitor, null);
  });

  it("gasto por fase entra no custo por fase quando fornecido", () => {
    const subs = [leitor("google-ads", "2026-09-06T10:00:00-03:00"), leitor("google-ads", "2026-09-20T10:00:00-03:00")];
    const arm = computeEmendaArm(subs, [spend(G, "2026-09", 300)], RUN_STATE, G, { [G]: { "pre-pausa": 100, "pos-retomada": 200 } });
    assert.deepEqual(arm.fases.map((f) => f.custoPorLeitor), [100, 200]);
  });
});

function arm(braco: string, leitores: number, gasto: number, fases: Array<{ id: string; leitores: number; gasto: number | null }>, frac20 = 1): EmendaArmResult {
  const ativos = Math.max(leitores, 10);
  return {
    braco,
    fases: fases.map((f) => ({
      id: f.id,
      label: f.id,
      inicioMs: 0,
      fimExclusivoMs: 1,
      cadastros: f.leitores,
      ativos: f.leitores,
      leitores: f.leitores,
      ativosCom20Recebidas: f.leitores,
      gastoBrl: f.gasto,
      custoPorLeitor: f.gasto != null && f.leitores > 0 ? f.gasto / f.leitores : null,
      custoPorCadastro: null,
    })),
    cadastros: leitores,
    ativos,
    leitores,
    ativosCom20Recebidas: Math.round(ativos * frac20),
    gastoTotalBrl: gasto,
    mesesForaDaJanela: [],
    semSinal: leitores < 3,
    custoPorLeitor: leitores < 3 ? null : gasto / leitores,
    custoPorCadastro: null,
    membros: [],
  };
}

describe("evaluateEmendaVerdict", () => {
  it("razão observada abaixo da detectável → sem diferença detectável", () => {
    const v = evaluateEmendaVerdict([arm(G, 60, 1147.77, []), arm(M, 50, 1435.51, [])]);
    assert.equal(v.kind, "sem-diferenca");
    assert.ok(v.razaoDetectavel != null && v.razaoObservada != null && v.razaoObservada <= v.razaoDetectavel);
    assert.equal(v.nReferencia, 50);
  });

  it("razão acima da detectável sem gasto por fase → indisponível, nenhum braço sai", () => {
    const fases = (l1: number, l2: number) => [{ id: "pre-pausa", leitores: l1, gasto: null }, { id: "pos-retomada", leitores: l2, gasto: null }];
    const v = evaluateEmendaVerdict([arm(G, 60, 600, fases(30, 30)), arm(M, 20, 2000, fases(10, 10))]);
    assert.equal(v.kind, "indisponivel");
    assert.match(v.texto, /--gasto-fases/);
  });

  it("razão acima da detectável e mais caro nas duas fases → sai o braço", () => {
    const v = evaluateEmendaVerdict([
      arm(G, 60, 600, [{ id: "pre-pausa", leitores: 30, gasto: 300 }, { id: "pos-retomada", leitores: 30, gasto: 300 }]),
      arm(M, 20, 2000, [{ id: "pre-pausa", leitores: 10, gasto: 1000 }, { id: "pos-retomada", leitores: 10, gasto: 1000 }]),
    ]);
    assert.equal(v.kind, "sai");
    assert.equal(v.maisCaro, M);
  });

  it("razão acima da detectável mas não é o mais caro numa fase → sem diferença", () => {
    const v = evaluateEmendaVerdict([
      arm(G, 60, 1300, [{ id: "pre-pausa", leitores: 5, gasto: 1000 }, { id: "pos-retomada", leitores: 55, gasto: 300 }]),
      arm(M, 20, 2000, [{ id: "pre-pausa", leitores: 10, gasto: 500 }, { id: "pos-retomada", leitores: 10, gasto: 1500 }]),
    ]);
    // custo total G 21,7 vs M 100 → razão ~4,6; mas na pré-pausa G (200) > M (50).
    assert.equal(v.kind, "sem-diferenca");
    assert.match(v.texto, /não é o mais caro em todas as fases/);
  });

  it("guard de pré-execução: fração com >=20 recebidas abaixo do piso suprime o veredito", () => {
    const v = evaluateEmendaVerdict([arm(G, 60, 600, [], 0.1), arm(M, 20, 2000, [], 0.1)]);
    assert.equal(v.kind, "indisponivel");
    assert.match(v.texto, /NÃO afirmado/);
  });

  it("menos de 2 braços com sinal → sem comparação", () => {
    const v = evaluateEmendaVerdict([arm(G, 60, 600, []), arm(MS, 1, 800, [])]);
    assert.equal(v.kind, "indisponivel");
    assert.deepEqual(v.semSinal, [MS]);
  });
});

describe("parseEmendaGastoPorFase", () => {
  it("aceita o shape e recusa valor negativo/não numérico", () => {
    assert.deepEqual(parseEmendaGastoPorFase({ [G]: { "pre-pausa": 1 } }), { [G]: { "pre-pausa": 1 } });
    assert.throws(() => parseEmendaGastoPorFase({ [G]: { "pre-pausa": -1 } }));
    assert.throws(() => parseEmendaGastoPorFase({ [G]: { "pre-pausa": "1" } }));
    assert.throws(() => parseEmendaGastoPorFase([]));
  });
});

describe("formatEmendaSectionMarkdown", () => {
  it("mostra fases, 'sem sinal' e o veredito", () => {
    const subs = [
      ...Array.from({ length: 4 }, (_, i) => leitor("google-ads", `2026-09-0${6 + (i % 2)}T10:00:00-03:00`)),
      leitor("microsoft-ads", "2026-09-06T10:00:00-03:00"),
    ];
    const s = computeEmendaSection(subs, [spend(G, "2026-09", 400), spend(MS, "2026-09", 800)], RUN_STATE, { runStatePath: "rs.json", corte: "2026-10-21" });
    const md = formatEmendaSectionMarkdown(s).join("\n");
    assert.match(md, /Apuração do teste 2608/);
    assert.match(md, /pré-pausa/);
    assert.match(md, /pós-retomada/);
    assert.match(md, /sem sinal/);
    assert.match(md, /\*\*Veredito:\*\*/);
  });
});

describe("cac-report --apuracao-2608 (integração com store fixture)", () => {
  it("exige --fonte store", async () => {
    const exitBefore = process.exitCode;
    process.exitCode = undefined;
    const r = await cacReportMain(["--fonte", "beehiiv", "--apuracao-2608", "x.json", "--no-register"]);
    const code = process.exitCode;
    process.exitCode = exitBefore;
    assert.equal(r, null);
    assert.equal(code, 1);
  });

  it("anexa a seção recortada por fase e grava o extrato da coorte ao lado do run-state", async () => {
    const { openDiariaSubscribersDb, ensureSubscriber, upsertSubscription } = await import("../scripts/lib/diaria-subscribers-db.ts");
    const root = mkdtempSync(join(tmpdir(), "cac-report-8238-emenda-"));
    try {
      const spendPath = join(root, "spend.csv");
      writeFileSync(spendPath, "canal,mes,moeda,valor,fonte\nGoogle Ads (teste 2608),2026-09,BRL,500.57,teste\n", "utf8");
      const storeDir = join(root, "data", "diaria-subscribers");
      mkdirSync(storeDir, { recursive: true });
      const storePath = join(storeDir, "diaria-subscribers.db");
      const db = openDiariaSubscribersDb(storePath);
      const add = (n: number, entered: string) => {
        const id = ensureSubscriber(db, "kit", `kit-${n}`, `l${n}@example.com`, entered);
        upsertSubscription(db, id, "kit", { status: "active", enteredAt: entered, exitedAt: null, source: "kit", utmSource: "google-ads" }, entered);
      };
      add(1, "2026-09-06T13:00:00.000Z"); // pré-pausa
      add(2, "2026-09-12T13:00:00.000Z"); // dentro da pausa — fora da coorte
      add(3, "2026-09-20T13:00:00.000Z"); // pós-retomada
      add(4, "2026-10-05T13:00:00.000Z"); // depois do fim da janela — fora
      db.close();

      const tdir = join(root, "teste-2608");
      mkdirSync(tdir, { recursive: true });
      const rsPath = join(tdir, "run-state.json");
      writeFileSync(rsPath, JSON.stringify(RUN_STATE));

      const exitBefore = process.exitCode;
      process.exitCode = undefined;
      const origLog = console.log;
      let out = "";
      console.log = (s: string) => { out += s; };
      let report;
      try {
        report = await cacReportMain(
          [
            "--fonte", "store", "--snapshot", "2026-10-21", "--spend", spendPath,
            "--origem", join(root, "origem-inexistente.json"), "--store-db", storePath,
            "--no-kit", "--no-store-leitores", "--no-ltv", "--apuracao-2608", rsPath,
          ],
          root,
        );
      } finally {
        console.log = origLog;
      }
      const code = process.exitCode;
      process.exitCode = exitBefore;
      assert.ok(report, `cac-report deveria ter rodado (exit ${code})`);
      assert.match(out, /Apuração do teste 2608/);

      const md = readFileSync(join(root, "data", "aquisicao", "cac-reports", "2026-10-21--store.md"), "utf8");
      assert.match(md, /\| \*\*Google Ads \(teste 2608\)\*\* \| total \| — \| 2 \|/, "só os 2 cadastros dentro das fases entram");

      const extrato = join(tdir, "apuracao-2026-10-21--store-coorte.jsonl");
      assert.ok(existsSync(extrato));
      const linhas = readFileSync(extrato, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.deepEqual(linhas.map((l) => l.fase).sort(), ["pos-retomada", "pre-pausa"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
