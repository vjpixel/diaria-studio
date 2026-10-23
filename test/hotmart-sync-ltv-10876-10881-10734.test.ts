/**
 * test/hotmart-sync-ltv-10876-10881-10734.test.ts
 *
 * #10876 item 1 — a rodada dos dias 1-7 do mês lê 93 dias (evento reenviado
 *   com `creation_date` antigo cai fora da janela de 35 dias).
 * #10876 item 2 — o sync grava JANELA A JANELA: num backfill, a falha da
 *   última janela não descarta as anteriores.
 * #10881 item 3 — chave inválida persistente no KV dá exit 3 uma vez só; nas
 *   rodadas seguintes vira aviso (estado `vendas.estado.json`).
 * #10734 4b — vendas Hotmart entram no ARPU/LTV (`ltv.ts`) como receita BRUTA
 *   do mês fechado, só quando o espelho cobre o mês inteiro.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";

import {
  diasPadraoDoSync,
  estadoPathDoEspelho,
  fundirCobertura,
  parseEstadoSync,
  periodoCoberto,
  planejarJanelas,
  registrarJanelaNoEstado,
  sincronizarEspelho,
  trechosCobertosDaJanela,
  type PerdasDaJanela,
  ESTADO_SYNC_VAZIO,
  SYNC_DIAS_PADRAO,
  SYNC_DIAS_VARREDURA,
  type JanelaConcluida,
  type RespostaVendas,
} from "../scripts/lib/hotmart-vendas-espelho.ts";
import { resolverPeriodoCli } from "../scripts/sync-hotmart-vendas.ts";
import { computeHotmartMonthRevenue, LTV_FONTE_HOTMART } from "../scripts/lib/ltv.ts";
import { loadHotmartMonthRevenue } from "../scripts/lib/hotmart-revenue-source.ts";
import { saldoLiquido, saldoReceita, type VendaRecord } from "../scripts/lib/shared/hotmart-vendas.ts";
import { computeLtvSection } from "../scripts/cac-report.ts";
import type { CacReport } from "../scripts/lib/cac.ts";
import { openDiariaSubscribersDb } from "../scripts/lib/diaria-subscribers-db.ts";

const ROOT = resolve(import.meta.dirname, "..");
const TOKEN = "token-10876";

function rec(over: Partial<VendaRecord> = {}): VendaRecord {
  return {
    v: 1,
    evento: "aprovada",
    evento_id: "ev-1",
    transacao: "HP0001",
    criado_em: "2026-09-10T12:00:00.000Z",
    criado_em_origem: "hotmart",
    dia: "2026-09-10",
    produto_id: 1,
    oferta: null,
    valor_liquido: 80,
    moeda_liquido: "BRL",
    valor_bruto: 100,
    moeda_bruto: "BRL",
    email_hash: null,
    src: null,
    sck: null,
    afiliado: false,
    ...over,
  };
}

const vazia: RespostaVendas = { registros: [], descartados: 0, ignoradosNoKv: 0 };
/** Go-live antigo: os testes anteriores ao #10991 não dependem do piso. */
const DESDE_ANTIGO = "2026-01-01";
const semPerda: PerdasDaJanela = { descartados: 0, ignoradosNoKv: 0, chavesIgnoradas: [] };

// ---------------------------------------------------------------------------
// #10876 item 1 — varredura mensal de 93 dias
// ---------------------------------------------------------------------------

describe("#10876 item 1: varredura mensal de 93 dias", () => {
  it("dias 1-7 do mês (Brasília) usam 93 dias; do dia 8 em diante, 35", () => {
    assert.equal(diasPadraoDoSync(Date.UTC(2026, 10, 1, 12)), SYNC_DIAS_VARREDURA);
    assert.equal(diasPadraoDoSync(Date.UTC(2026, 10, 7, 12)), SYNC_DIAS_VARREDURA);
    assert.equal(diasPadraoDoSync(Date.UTC(2026, 10, 8, 12)), SYNC_DIAS_PADRAO);
    // 02:00 UTC de 08/11 ainda é 07/11 em Brasília.
    assert.equal(diasPadraoDoSync(Date.UTC(2026, 10, 8, 2)), SYNC_DIAS_VARREDURA);
    assert.equal(SYNC_DIAS_VARREDURA, 93);
  });

  it("todo mês tem um sábado nos dias 1-7 (a task semanal faz a varredura uma vez por mês)", () => {
    for (let m = 0; m < 24; m++) {
      const temSabado = [1, 2, 3, 4, 5, 6, 7].some((d) => new Date(Date.UTC(2026, m, d)).getUTCDay() === 6);
      assert.ok(temSabado, `mês ${m}`);
    }
  });

  it("sem período explícito, a rodada do dia 3 lê 93 dias em uma janela; com --dias, respeita", () => {
    const now = Date.UTC(2026, 10, 3, 15);
    const { periodo, janelas } = resolverPeriodoCli({ nowMs: now });
    assert.deepEqual(periodo, { de: "2026-08-03", ate: "2026-11-03" });
    assert.equal(janelas.length, 1);
    assert.equal(resolverPeriodoCli({ nowMs: now, dias: 10 }).periodo.de, "2026-10-25");
    assert.equal(resolverPeriodoCli({ nowMs: Date.UTC(2026, 10, 20, 15) }).periodo.de, "2026-10-17");
  });
});

// ---------------------------------------------------------------------------
// #10876 item 2 — grava por janela
// ---------------------------------------------------------------------------

describe("#10876 item 2: o sync grava janela a janela", () => {
  it("erro na 3ª janela: as 2 primeiras já foram entregues para gravar", async () => {
    const janelas = planejarJanelas("2026-01-01", "2026-09-01");
    assert.equal(janelas.length, 3);
    const gravado: JanelaConcluida[] = [];
    let arquivo = "";
    await assert.rejects(
      sincronizarEspelho({
        janelas,
        textoAtual: "",
        buscarJanela: async (de) => {
          if (de === janelas[2]!.de) throw new Error("HTTP 502");
          return { ...vazia, registros: [rec({ transacao: `T-${de}`, dia: de, criado_em: `${de}T12:00:00.000Z` })] };
        },
        aoConcluirJanela: (j) => {
          gravado.push(j);
          arquivo += j.acrescentar;
        },
      }),
      /502/,
    );
    assert.equal(gravado.length, 2);
    assert.equal(arquivo.trim().split("\n").length, 2);
    assert.deepEqual(gravado.map((j) => j.janela), janelas.slice(0, 2));
  });

  it("mesmo evento em duas janelas entra uma vez só; o texto da 2ª janela emenda no da 1ª", async () => {
    const janelas = planejarJanelas("2026-01-01", "2026-06-01");
    const partes: string[] = [];
    const r = await sincronizarEspelho({
      janelas,
      textoAtual: JSON.stringify(rec({ transacao: "VELHA" })), // sem \n no fim
      buscarJanela: async () => ({ ...vazia, registros: [rec({ transacao: "X" })] }),
      aoConcluirJanela: (j) => partes.push(j.acrescentar),
    });
    assert.equal(r.novos.length, 1);
    assert.equal(r.jaPresentes, 1);
    assert.equal(partes[0], `\n${JSON.stringify(rec({ transacao: "X" }))}\n`);
    assert.equal(partes[1], "");
  });
});

// ---------------------------------------------------------------------------
// #10881 item 3 — chave inválida persistente
// ---------------------------------------------------------------------------

describe("#10881 item 3: chave inválida conhecida não repete o alarme", () => {
  it("só chave fora do conjunto conhecido conta como nova; chave sem nome conta sempre", async () => {
    const r = await sincronizarEspelho({
      janelas: planejarJanelas("2026-10-01", "2026-10-02"),
      textoAtual: "",
      chavesInvalidasConhecidas: new Set(["k-velha"]),
      buscarJanela: async () => ({ registros: [], descartados: 0, ignoradosNoKv: 3, chavesIgnoradas: ["k-velha", "k-nova"] }),
    });
    assert.equal(r.ignoradosNoKv, 3);
    assert.equal(r.ignoradosNoKvNovos, 2);
    assert.deepEqual(r.chavesIgnoradasNovas, ["k-nova"]);
  });

  it("estado: funde cobertura contígua, acumula chaves, ilegível lança", () => {
    let e = registrarJanelaNoEstado(ESTADO_SYNC_VAZIO, [{ de: "2026-09-01", ate: "2026-09-30" }], ["b"], "t1");
    e = registrarJanelaNoEstado(e, [{ de: "2026-10-01", ate: "2026-10-22" }], ["a", "b"], "t2");
    assert.deepEqual(e.cobertura, [{ de: "2026-09-01", ate: "2026-10-22" }]);
    assert.deepEqual(e.chaves_invalidas_conhecidas, ["a", "b"]);
    assert.deepEqual(parseEstadoSync(JSON.stringify(e)), e);
    assert.deepEqual(parseEstadoSync(null), ESTADO_SYNC_VAZIO);
    assert.throws(() => parseEstadoSync("{quebrado"), /ilegível/);
    assert.throws(() => parseEstadoSync(JSON.stringify({ cobertura: [{ de: "x" }], chaves_invalidas_conhecidas: [] })), /ilegível/);
    assert.deepEqual(fundirCobertura([{ de: "2026-01-10", ate: "2026-01-20" }, { de: "2026-01-01", ate: "2026-01-05" }]), [
      { de: "2026-01-01", ate: "2026-01-05" },
      { de: "2026-01-10", ate: "2026-01-20" },
    ]);
    assert.equal(estadoPathDoEspelho("/x/hotmart/vendas.jsonl"), "/x/hotmart/vendas.estado.json");
  });

  it("#10892 review: a cobertura para em ONTEM (Brasília) — o dia da rodada nunca conta como lido por inteiro", () => {
    // Sábado 31/10/2026, 04:30 BRT (07:30Z): a varredura lê outubro até a hora da rodada.
    const sab0430 = Date.parse("2026-10-31T07:30:00Z");
    const outubro = { de: "2026-10-01", ate: "2026-10-31" };
    assert.deepEqual(trechosCobertosDaJanela(outubro, semPerda, sab0430, DESDE_ANTIGO), [{ de: "2026-10-01", ate: "2026-10-30" }]);
    const e = registrarJanelaNoEstado(ESTADO_SYNC_VAZIO, trechosCobertosDaJanela(outubro, semPerda, sab0430, DESDE_ANTIGO), [], "t");
    assert.equal(periodoCoberto(e.cobertura, "2026-10-01", "2026-10-31"), false, "outubro não pode sair coberto no próprio dia 31");
    // A rodada seguinte (01/11) lê o dia 31 inteiro e fecha o mês.
    const e2 = registrarJanelaNoEstado(e, trechosCobertosDaJanela({ de: "2026-10-03", ate: "2026-11-01" }, semPerda, Date.parse("2026-11-01T07:30:00Z"), DESDE_ANTIGO), [], "t2");
    assert.equal(periodoCoberto(e2.cobertura, "2026-10-01", "2026-10-31"), true);
    // 23:30 BRT do dia 31 = 02:30Z do dia 1: o "hoje" é Brasília, não UTC.
    assert.deepEqual(trechosCobertosDaJanela(outubro, semPerda, Date.parse("2026-11-01T02:30:00Z"), DESDE_ANTIGO), [{ de: "2026-10-01", ate: "2026-10-30" }]);
    // Janela só de hoje: nada a registrar, mas as chaves inválidas seguem acumulando.
    assert.deepEqual(trechosCobertosDaJanela({ de: "2026-10-31", ate: "2026-10-31" }, semPerda, sab0430, DESDE_ANTIGO), []);
    const e3 = registrarJanelaNoEstado(ESTADO_SYNC_VAZIO, [], ["k"], "t3");
    assert.deepEqual(e3.cobertura, []);
    assert.deepEqual(e3.chaves_invalidas_conhecidas, ["k"]);
    // Janela com registro fora do formato: venda faltando, não conta como coberta.
    assert.deepEqual(trechosCobertosDaJanela({ de: "2026-09-01", ate: "2026-09-30" }, { ...semPerda, descartados: 1 }, sab0430, DESDE_ANTIGO), []);
  });

  it("#10909: chave inválida no KV, mesmo já conhecida, tira o dia dela da cobertura — o mês sai sem dado, nunca a menos", () => {
    const agora = Date.parse("2026-10-22T07:30:00Z");
    const janela = { de: "2026-08-20", ate: "2026-10-21" };
    const chave = "hotmart:venda:2026-09-15:RUIM:aprovada";
    const perdas: PerdasDaJanela = { descartados: 0, ignoradosNoKv: 1, chavesIgnoradas: [chave] };
    const trechos = trechosCobertosDaJanela(janela, perdas, agora, DESDE_ANTIGO);
    assert.deepEqual(trechos, [
      { de: "2026-08-20", ate: "2026-09-14" },
      { de: "2026-09-16", ate: "2026-10-21" },
    ]);
    // Cenário da issue: a 2ª rodada já conhece a chave (sem alarme), mas a perda continua.
    let e = registrarJanelaNoEstado(ESTADO_SYNC_VAZIO, trechos, [chave], "t1");
    e = registrarJanelaNoEstado(e, trechosCobertosDaJanela(janela, perdas, agora, DESDE_ANTIGO), [], "t2");
    assert.equal(periodoCoberto(e.cobertura, "2026-09-01", "2026-09-30"), false);
    assert.equal(periodoCoberto(e.cobertura, "2026-10-01", "2026-10-21"), true, "outro mês da janela não é penalizado");
    const set = computeHotmartMonthRevenue({ vendasDesde: DESDE_ANTIGO, registros: [rec()], cobertura: e.cobertura, month: "2026-09" });
    assert.equal(set.valorBrl, null, "setembro não pode sair com receita a menos e motivo null");
    assert.ok(set.motivo);
    // Dia no limite da janela e chaves repetidas.
    assert.deepEqual(
      trechosCobertosDaJanela({ de: "2026-10-01", ate: "2026-10-03" }, { descartados: 0, ignoradosNoKv: 2, chavesIgnoradas: ["hotmart:venda:2026-10-01:A:aprovada", "hotmart:venda:2026-10-03:B:aprovada"] }, agora, DESDE_ANTIGO),
      [{ de: "2026-10-02", ate: "2026-10-02" }],
    );
    // Sem saber o dia, a janela inteira fica de fora.
    assert.deepEqual(trechosCobertosDaJanela(janela, { descartados: 0, ignoradosNoKv: 1, chavesIgnoradas: [] }, agora, DESDE_ANTIGO), [], "chave sem nome");
    assert.deepEqual(trechosCobertosDaJanela(janela, { descartados: 0, ignoradosNoKv: 1, chavesIgnoradas: ["hotmart:venda:x"] }, agora, DESDE_ANTIGO), [], "chave fora do formato");
    assert.deepEqual(
      trechosCobertosDaJanela(janela, { descartados: 0, ignoradosNoKv: 1, chavesIgnoradas: ["hotmart:venda:2026-07-01:A:aprovada"] }, agora, DESDE_ANTIGO),
      [],
      "dia fora da janela",
    );
    assert.deepEqual(
      trechosCobertosDaJanela(janela, { descartados: 0, ignoradosNoKv: 1, chavesIgnoradas: ["hotmart:venda:2026-09-31:A:aprovada"] }, agora, DESDE_ANTIGO),
      [],
      "dia inexistente (Date.parse aceita 31/09)",
    );
  });

  it("#10909: sincronizarEspelho entrega a aoConcluirJanela TODAS as chaves ignoradas da janela, conhecidas inclusive", async () => {
    const vistas: JanelaConcluida[] = [];
    await sincronizarEspelho({
      janelas: planejarJanelas("2026-10-01", "2026-10-02"),
      textoAtual: "",
      chavesInvalidasConhecidas: new Set(["hotmart:venda:2026-10-01:VELHA:aprovada"]),
      buscarJanela: async () => ({ registros: [], descartados: 0, ignoradosNoKv: 1, chavesIgnoradas: ["hotmart:venda:2026-10-01:VELHA:aprovada"] }),
      aoConcluirJanela: (j) => vistas.push(j),
    });
    assert.equal(vistas.length, 1);
    assert.deepEqual(vistas[0]!.chavesIgnoradasNovas, []);
    assert.equal(vistas[0]!.ignoradosNoKv, 1);
    assert.deepEqual(vistas[0]!.chavesIgnoradas, ["hotmart:venda:2026-10-01:VELHA:aprovada"]);
  });
});

function runSync(args: string[], baseUrl: string): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/sync-hotmart-vendas.ts", "--base-url", baseUrl, ...args], {
      cwd: ROOT,
      env: { ...process.env, HOTMART_VENDAS_TOKEN: TOKEN },
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => done({ code, out }));
  });
}

async function servidor(responder: (url: URL) => { status: number; body: unknown }): Promise<{ base: string; fechar: () => void }> {
  const server = createServer((req, res) => {
    const { status, body } = responder(new URL(req.url ?? "/", "http://x"));
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    fechar: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

describe("CLI sync-hotmart-vendas: gravação por janela e alarme único (#10876, #10881)", () => {
  it("backfill de 2 janelas com 502 na 2ª: exit 1, a 1ª fica no espelho e na cobertura", { timeout: 60_000 }, async () => {
    const { base, fechar } = await servidor((u) =>
      u.searchParams.get("de") === "2026-01-01"
        ? { status: 200, body: { ok: true, registros: [rec({ transacao: "JAN", dia: "2026-01-05", criado_em: "2026-01-05T12:00:00.000Z" })] } }
        : { status: 502, body: { ok: false, error: "bad_gateway" } },
    );
    const dir = mkdtempSync(join(tmpdir(), "hotmart-10876-"));
    const out = join(dir, "vendas.jsonl");
    try {
      const r = await runSync(["--de", "2026-01-01", "--ate", "2026-05-01", "--out", out, "--vendas-desde", DESDE_ANTIGO], base);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /falhou depois de 1 janela/);
      assert.match(readFileSync(out, "utf8"), /"transacao":"JAN"/);
      const estado = parseEstadoSync(readFileSync(estadoPathDoEspelho(out), "utf8"));
      assert.deepEqual(estado.cobertura, [{ de: "2026-01-01", ate: "2026-04-03" }]);
      assert.ok(!existsSync(`${out}.lock`));
    } finally {
      fechar();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mesma chave inválida em 2 rodadas: exit 3 e depois exit 0; chave nova volta a dar 3", { timeout: 60_000 }, async () => {
    let ignorados = ["hotmart:venda:2026-10-20:RUIM:aprovada"];
    const { base, fechar } = await servidor(() => ({ status: 200, body: { ok: true, registros: [rec()], ignorados } }));
    const dir = mkdtempSync(join(tmpdir(), "hotmart-10881-"));
    const out = join(dir, "vendas.jsonl");
    const args = ["--de", "2026-10-20", "--ate", "2026-10-20", "--out", out];
    try {
      const r1 = await runSync(args, base);
      assert.equal(r1.code, 3, r1.out);
      const r2 = await runSync(args, base);
      assert.equal(r2.code, 0, r2.out);
      assert.match(r2.out, /já avisada/);
      // #10909: a chave já avisada não vira alarme, mas o dia dela segue fora da cobertura.
      assert.deepEqual(parseEstadoSync(readFileSync(estadoPathDoEspelho(out), "utf8")).cobertura, []);
      ignorados = [...ignorados, "hotmart:venda:2026-10-20:OUTRA:aprovada"];
      const r3 = await runSync(args, base);
      assert.equal(r3.code, 3, r3.out);
      assert.match(r3.out, /1 chave\(s\) inválida\(s\) NOVA/);
    } finally {
      fechar();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--dry-run não grava espelho nem estado", { timeout: 60_000 }, async () => {
    const { base, fechar } = await servidor(() => ({ status: 200, body: { ok: true, registros: [rec()] } }));
    const dir = mkdtempSync(join(tmpdir(), "hotmart-10876-dry-"));
    const out = join(dir, "vendas.jsonl");
    try {
      const r = await runSync(["--de", "2026-10-20", "--ate", "2026-10-20", "--out", out, "--dry-run"], base);
      assert.equal(r.code, 0, r.out);
      assert.ok(!existsSync(out));
      assert.ok(!existsSync(estadoPathDoEspelho(out)));
    } finally {
      fechar();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #10734 4b — Hotmart no ARPU/LTV
// ---------------------------------------------------------------------------

const SETEMBRO = [{ de: "2026-08-20", ate: "2026-10-21" }];

describe("#10734 4b: computeHotmartMonthRevenue", () => {
  it("mês fora da cobertura: null com motivo, nunca 0", () => {
    const r = computeHotmartMonthRevenue({ vendasDesde: DESDE_ANTIGO, registros: [rec()], cobertura: [{ de: "2026-09-05", ate: "2026-10-21" }], month: "2026-09" });
    assert.equal(r.valorBrl, null);
    // #10991: cobertura parcial do mês sai rotulada PISO (valor dos dias cobertos fora da soma).
    assert.match(r.motivo!, /^PISO — espelho Hotmart cobre só 2026-09-05\.\.2026-09-30 de 2026-09-01\.\.2026-09-30/);
    const nada = computeHotmartMonthRevenue({ vendasDesde: DESDE_ANTIGO, registros: [rec()], cobertura: [{ de: "2026-10-01", ate: "2026-10-21" }], month: "2026-09" });
    assert.equal(nada.valorBrl, null);
    assert.equal(nada.pisoBrl, null);
    assert.match(nada.motivo!, /não cobre 2026-09-01\.\.2026-09-30/);
    assert.equal(periodoCoberto([], "2026-09-01", "2026-09-30"), false);
  });

  it("mês coberto sem venda é R$ 0 legítimo", () => {
    const r = computeHotmartMonthRevenue({ vendasDesde: DESDE_ANTIGO, registros: [], cobertura: SETEMBRO, month: "2026-09" });
    assert.equal(r.valorBrl, 0);
    assert.equal(r.motivo, null);
  });

  it("soma o BRUTO do mês; reembolso subtrai no mês em que chegou; uma reversão por transação", () => {
    const registros = [
      rec({ transacao: "A", valor_bruto: 100 }),
      rec({ transacao: "B", evento_id: "b", valor_bruto: 50, dia: "2026-09-20" }),
      rec({ transacao: "B", evento: "reembolsada", evento_id: "b-r", valor_bruto: 50, valor_liquido: null, dia: "2026-09-25" }),
      rec({ transacao: "B", evento: "chargeback", evento_id: "b-c", valor_bruto: 50, dia: "2026-09-26" }),
      rec({ transacao: "C", evento: "cancelada", evento_id: "c", valor_bruto: 999 }),
      // Reembolso de A só em outubro: não sai de setembro.
      rec({ transacao: "A", evento: "reembolsada", evento_id: "a-r", dia: "2026-10-02" }),
      // Venda de agosto: fora do mês.
      rec({ transacao: "D", evento_id: "d", dia: "2026-08-31" }),
    ];
    const r = computeHotmartMonthRevenue({ vendasDesde: DESDE_ANTIGO, registros, cobertura: SETEMBRO, month: "2026-09" });
    assert.equal(r.valorBrl, 100);
    assert.equal(r.aprovadas, 2);
    assert.equal(r.estornos, 1);
  });

  it("evento sem valor bruto ou em outra moeda deixa o mês sem dado", () => {
    assert.equal(computeHotmartMonthRevenue({ vendasDesde: DESDE_ANTIGO, registros: [rec({ valor_bruto: null })], cobertura: SETEMBRO, month: "2026-09" }).valorBrl, null);
    const usd = computeHotmartMonthRevenue({ vendasDesde: DESDE_ANTIGO, registros: [rec(), rec({ transacao: "U", moeda_bruto: "USD" })], cobertura: SETEMBRO, month: "2026-09" });
    assert.equal(usd.valorBrl, null);
    assert.match(usd.motivo!, /USD/);
  });

  it("saldoLiquido segue igual (Worker); saldoReceita bruto usa valor_bruto", () => {
    const rs = [rec()];
    assert.equal(saldoLiquido(rs).porMoeda[0]!.liquido, 80);
    assert.equal(saldoReceita(rs, "bruto").porMoeda[0]!.liquido, 100);
  });
});

function escreverEspelho(root: string, registros: VendaRecord[], cobertura: { de: string; ate: string }[] | null): void {
  const dir = join(root, "data", "hotmart");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "platform.config.json"), JSON.stringify({ hotmart: { vendas_desde: DESDE_ANTIGO } }));
  writeFileSync(join(dir, "vendas.jsonl"), registros.map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (cobertura) {
    writeFileSync(join(dir, "vendas.estado.json"), JSON.stringify({ v: 1, cobertura, chaves_invalidas_conhecidas: [], atualizado_em: "x" }));
  }
}

describe("#10734 4b: loadHotmartMonthRevenue (I/O fail-soft)", () => {
  it("sem estado: null; com estado: lê o espelho; estado ilegível: null com motivo", () => {
    const root = mkdtempSync(join(tmpdir(), "hotmart-ltv-"));
    try {
      assert.equal(loadHotmartMonthRevenue(root, "2026-09").valorBrl, null);
      escreverEspelho(root, [rec({ valor_bruto: 120 })], null);
      assert.match(loadHotmartMonthRevenue(root, "2026-09").motivo!, /estado do sync Hotmart ausente/);
      escreverEspelho(root, [rec({ valor_bruto: 120 })], SETEMBRO);
      assert.equal(loadHotmartMonthRevenue(root, "2026-09").valorBrl, 120);
      // #10892 review: linha inválida no espelho = venda que a soma não vê → null, nunca valor a menos.
      writeFileSync(join(root, "data", "hotmart", "vendas.jsonl"), readFileSync(join(root, "data", "hotmart", "vendas.jsonl"), "utf8") + "{nao-e-venda}\n");
      const comInvalida = loadHotmartMonthRevenue(root, "2026-09");
      assert.equal(comInvalida.valorBrl, null);
      assert.match(comInvalida.motivo!, /inválida/);
      escreverEspelho(root, [rec({ valor_bruto: 120 })], SETEMBRO);
      writeFileSync(join(root, "data", "hotmart", "vendas.estado.json"), "{quebrado");
      const ruim = loadHotmartMonthRevenue(root, "2026-09");
      assert.equal(ruim.valorBrl, null);
      assert.match(ruim.motivo!, /ilegível/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#10734 4b: cac-report soma a Hotmart ao ARPU quando o mês está coberto", () => {
  const NOW = new Date("2026-10-21T12:00:00Z");
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

  function montar(root: string): { backupRoot: string; dbPath: string } {
    const backupRoot = join(root, "beehiiv-backup");
    mkdirSync(join(backupRoot, "2026-10-18"), { recursive: true });
    writeFileSync(join(backupRoot, "2026-10-18", "subscribers.jsonl"), JSON.stringify({ email: "v@x.com", status: "inactive", created: 1 }) + "\n");
    const apoia = join(root, "data", "apoia-se", "diaria");
    mkdirSync(apoia, { recursive: true });
    writeFileSync(join(apoia, "2026-09.json"), JSON.stringify({ "a@x.com": { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 30 } }));
    mkdirSync(join(root, "data", "ltv"), { recursive: true });
    writeFileSync(join(root, "data", "ltv", "amazon-revenue.json"), JSON.stringify({ valorMensalBrl: 10, atualizadoEm: "2026-10-01" }));
    const dbPath = join(root, "store.db");
    const db = openDiariaSubscribersDb(dbPath);
    try {
      const ts = NOW.toISOString();
      ["a@x.com", "b@x.com", "c@x.com", "d@x.com"].forEach((email, i) => {
        const id = Number(db.prepare("INSERT INTO subscriber (created_at, updated_at) VALUES (?, ?)").run(ts, ts).lastInsertRowid);
        db.prepare("INSERT INTO identity_alias (subscriber_id, platform, external_id, email, created_at) VALUES (?, 'kit', ?, ?, ?)").run(id, `e${i}`, email, ts);
        db.prepare(
          "INSERT INTO subscription (subscriber_id, platform, status, entered_at, exited_at, source, updated_at) VALUES (?, 'kit', 'active', ?, NULL, NULL, ?)",
        ).run(id, daysAgo(60), ts);
      });
    } finally {
      db.close();
    }
    return { backupRoot, dbPath };
  }

  it("mês coberto: hotmart vira fonte com dado e entra na soma; sem estado, continua sem dado", () => {
    const root = mkdtempSync(join(tmpdir(), "cac-ltv-hotmart-"));
    try {
      const { backupRoot, dbPath } = montar(root);
      const semEstado = computeLtvSection({ rows: [] } as unknown as CacReport, backupRoot, "2026-10-21", root, () => NOW, {}, { storeDbPath: dbPath });
      assert.ok(semEstado.applied);
      if (!semEstado.applied) return;
      assert.deepEqual(semEstado.fontesSemDado, [LTV_FONTE_HOTMART]);
      assert.ok(Math.abs(semEstado.arpuMensalBrl! - 10) < 1e-9); // (30 + 10) / 4

      escreverEspelho(root, [rec({ valor_bruto: 40 })], SETEMBRO);
      const comEstado = computeLtvSection({ rows: [] } as unknown as CacReport, backupRoot, "2026-10-21", root, () => NOW, {}, { storeDbPath: dbPath });
      assert.ok(comEstado.applied);
      if (!comEstado.applied) return;
      assert.equal(comEstado.fontesSemDado?.length ?? 0, 0, JSON.stringify(comEstado.fontesSemDado));
      assert.ok(Math.abs(comEstado.arpuMensalBrl! - 20) < 1e-9); // (30 + 10 + 40) / 4
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
