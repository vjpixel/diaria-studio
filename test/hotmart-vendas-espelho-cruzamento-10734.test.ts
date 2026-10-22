/**
 * test/hotmart-vendas-espelho-cruzamento-10734.test.ts (#10734, itens 4a e 4c)
 *
 * 4c — espelho das vendas do KV em `data/hotmart/vendas.jsonl`: janelas de
 * até 93 dias, idempotência por transação + evento (rodar de novo não
 * acrescenta nada; reembolso da mesma transação é linha nova), append-only,
 * e o CLI de ponta a ponta contra o Worker `site` real atrás de um servidor
 * HTTP local.
 *
 * 4a — cruzamento com o store: o hash que o cruzamento calcula sobre o e-mail
 * do store é o MESMO que o Worker grava (`buildVendaRecord` e o webhook de
 * verdade); casamento com assinante ativo, ex-assinante, fora da base e venda
 * sem e-mail; nenhum e-mail em claro no relatório.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";

import {
  chaveEspelho,
  lerEspelho,
  mesclarEspelho,
  parseRespostaVendas,
  periodoPadrao,
  planejarJanelas,
  sincronizarEspelho,
  textoParaAcrescentar,
  JANELA_MAX_DIAS,
  type RespostaVendas,
} from "../scripts/lib/hotmart-vendas-espelho.ts";
import {
  cruzarVendas,
  hashEmailComoWorker,
  indexarAssinantesPorHash,
} from "../scripts/lib/hotmart-vendas-cruzamento.ts";
import { buildVendaRecord, HOTMART_VENDAS_PATH, type VendaRecord } from "../scripts/lib/shared/hotmart-vendas.ts";
import { ABANDONOS_MAX_DIAS, HOTMART_WEBHOOK_PATH } from "../scripts/lib/shared/hotmart-abandono.ts";
import worker from "../workers/site/src/index.ts";
import type { Env } from "../workers/site/src/index.ts";

const ROOT = resolve(import.meta.dirname, "..");
const HOTTOK = "hottok-de-teste";
const VENDAS_TOKEN = "token-de-vendas-espelho";

function rec(over: Partial<VendaRecord> = {}): VendaRecord {
  return {
    v: 1,
    evento: "aprovada",
    evento_id: "ev-1",
    transacao: "HP0001",
    criado_em: "2026-10-20T12:00:00.000Z",
    criado_em_origem: "hotmart",
    dia: "2026-10-20",
    produto_id: 123,
    oferta: "of1",
    valor_liquido: 100,
    moeda_liquido: "BRL",
    valor_bruto: 110,
    moeda_bruto: "BRL",
    email_hash: "a".repeat(64),
    src: null,
    sck: null,
    afiliado: false,
    ...over,
  };
}

function payload(event: string, transacao: string, email: string | null, creation: number) {
  return {
    id: `id-${transacao}-${event}`,
    creation_date: creation,
    event,
    version: "2.0.0",
    data: {
      product: { id: 8576469, name: "Curso" },
      affiliates: [],
      buyer: email === null ? {} : { email, name: "Nome Comprador" },
      commissions: [{ value: 90, source: "PRODUCER", currency_value: "BRL" }],
      purchase: { transaction: transacao, price: { value: 100, currency_value: "BRL" }, offer: { code: "of1" }, origin: { src: "meta" } },
    },
  };
}

describe("#10734 4c planejarJanelas / periodoPadrao", () => {
  it("o teto de janela é o mesmo da rota (resolvePeriodo)", () => {
    assert.equal(JANELA_MAX_DIAS, ABANDONOS_MAX_DIAS);
  });

  it("quebra um período longo em janelas contíguas, sem buraco nem sobreposição", () => {
    const j = planejarJanelas("2026-01-01", "2026-07-19", 93);
    assert.deepEqual(j, [
      { de: "2026-01-01", ate: "2026-04-03" },
      { de: "2026-04-04", ate: "2026-07-05" },
      { de: "2026-07-06", ate: "2026-07-19" },
    ]);
    assert.deepEqual(planejarJanelas("2026-10-22", "2026-10-22"), [{ de: "2026-10-22", ate: "2026-10-22" }]);
  });

  it("recusa data inexistente e período invertido", () => {
    assert.throws(() => planejarJanelas("2026-02-30", "2026-03-01"), /inexistente/);
    assert.throws(() => planejarJanelas("2026-03-02", "2026-03-01"), /invertido/);
    assert.throws(() => planejarJanelas("20261001", "2026-10-02"), /inválido/);
  });

  it("período padrão termina hoje em Brasília, inclusive", () => {
    // 22/10 01h UTC = 21/10 22h em Brasília
    assert.deepEqual(periodoPadrao(Date.UTC(2026, 9, 22, 1, 0), 35), { de: "2026-09-17", ate: "2026-10-21" });
    assert.deepEqual(periodoPadrao(Date.UTC(2026, 9, 22, 15, 0), 1), { de: "2026-10-22", ate: "2026-10-22" });
  });
});

describe("#10734 4c espelho: leitura, mescla e idempotência", () => {
  it("lê JSONL com CRLF e conta linha inválida sem lançar", () => {
    const texto = `${JSON.stringify(rec())}\r\nnão é json\r\n\r\n${JSON.stringify({ evento: "outro" })}\n${JSON.stringify(rec({ transacao: "HP0002" }))}`;
    const { registros, invalidas } = lerEspelho(texto);
    assert.deepEqual(registros.map((r) => r.transacao), ["HP0001", "HP0002"]);
    assert.equal(invalidas, 2);
  });

  it("chave é transação + evento: o reembolso da mesma compra é linha nova, o reenvio não", () => {
    const aprov = rec();
    const reemb = rec({ evento: "reembolsada", evento_id: "ev-2", criado_em: "2026-10-25T00:00:00.000Z", dia: "2026-10-24" });
    assert.notEqual(chaveEspelho(aprov), chaveEspelho(reemb));
    const { novos, jaPresentes } = mesclarEspelho([aprov], [aprov, reemb, { ...aprov, evento_id: "ev-reenvio" }]);
    assert.deepEqual(novos, [reemb]);
    assert.equal(jaPresentes, 2);
  });

  it("repetição dentro do lote fica só na mais antiga", () => {
    const tarde = rec({ criado_em: "2026-10-21T00:00:00.000Z", dia: "2026-10-20", evento_id: "tarde" });
    const cedo = rec({ criado_em: "2026-10-19T00:00:00.000Z", dia: "2026-10-18", evento_id: "cedo" });
    assert.deepEqual(mesclarEspelho([], [tarde, cedo]).novos.map((r) => r.evento_id), ["cedo"]);
  });

  it("acrescenta quebra de linha antes quando o arquivo não termina em uma", () => {
    const linha = JSON.stringify(rec());
    assert.equal(textoParaAcrescentar([], "x"), "");
    assert.equal(textoParaAcrescentar([rec()], ""), `${linha}\n`);
    assert.equal(textoParaAcrescentar([rec()], "antiga\n"), `${linha}\n`);
    assert.equal(textoParaAcrescentar([rec()], "antiga"), `\n${linha}\n`);
  });

  it("sync rodado duas vezes sobre o mesmo KV não acrescenta nada na 2ª", async () => {
    const kv: RespostaVendas = { registros: [rec(), rec({ transacao: "HP0002", evento_id: "ev-3" })], descartados: 0, ignoradosNoKv: 0 };
    const buscarJanela = async () => kv;
    const janelas = planejarJanelas("2026-10-01", "2026-10-22");
    const r1 = await sincronizarEspelho({ janelas, buscarJanela, textoAtual: "" });
    assert.equal(r1.novos.length, 2);
    const arquivo = r1.acrescentar;
    const r2 = await sincronizarEspelho({ janelas, buscarJanela, textoAtual: arquivo });
    assert.equal(r2.novos.length, 0);
    assert.equal(r2.jaPresentes, 2);
    assert.equal(r2.acrescentar, "");
  });

  it("linha já espelhada nunca é reescrita, mesmo que o KV devolva outra versão", async () => {
    const original = JSON.stringify(rec({ valor_liquido: 100 })) + "\n";
    const r = await sincronizarEspelho({
      janelas: [{ de: "2026-10-20", ate: "2026-10-20" }],
      buscarJanela: async () => ({ registros: [rec({ valor_liquido: 999 })], descartados: 0, ignoradosNoKv: 0 }),
      textoAtual: original,
    });
    assert.equal(r.acrescentar, "");
  });

  it("falha numa janela sobe (não vira 'sem vendas')", async () => {
    await assert.rejects(
      sincronizarEspelho({
        janelas: planejarJanelas("2026-01-01", "2026-06-30"),
        buscarJanela: async (de) => {
          if (de !== "2026-01-01") throw new Error("HTTP 502");
          return { registros: [], descartados: 0, ignoradosNoKv: 0 };
        },
        textoAtual: "",
      }),
      /502/,
    );
  });

  it("resposta da rota: recusa ok:false e corta campo fora da allowlist", () => {
    assert.throws(() => parseRespostaVendas({ ok: false, error: "unauthorized" }), /unauthorized/);
    assert.throws(() => parseRespostaVendas({ ok: true }), /inválida/);
    const r = parseRespostaVendas({ ok: true, registros: [{ ...rec(), email: "x@y.com" }, { lixo: 1 }], ignorados: ["k1"] });
    assert.equal(r.registros.length, 1);
    assert.equal("email" in r.registros[0]!, false);
    assert.equal(r.descartados, 1);
    assert.equal(r.ignoradosNoKv, 1);
  });
});

describe("#10734 4a hash do e-mail idêntico ao do Worker", () => {
  it("hashEmailComoWorker(e-mail do store) === email_hash de buildVendaRecord", async () => {
    const built = await buildVendaRecord(payload("PURCHASE_APPROVED", "HP1", "  Fulano.Silva@Exemplo.COM ", Date.UTC(2026, 9, 20)), Date.UTC(2026, 9, 21), "b".repeat(64));
    assert.ok(built.ok);
    if (!built.ok) return;
    assert.equal(built.record.email_hash, await hashEmailComoWorker("fulano.silva@exemplo.com"));
    assert.equal(built.record.email_hash, await hashEmailComoWorker("FULANO.SILVA@exemplo.com"));
    assert.notEqual(built.record.email_hash, await hashEmailComoWorker("fulanosilva@exemplo.com"));
  });

  it("e-mail sem forma de e-mail dá null, como no Worker", async () => {
    assert.equal(await hashEmailComoWorker("sem-arroba"), null);
    assert.equal(await hashEmailComoWorker(null), null);
  });
});

describe("#10734 4a cruzarVendas", () => {
  it("separa assinante ativo, ex-assinante, fora da base e sem e-mail, sem e-mail em claro", async () => {
    const indice = await indexarAssinantesPorHash([
      { subscriberId: 7, emails: ["Ativo@Exemplo.com"], ativo: true, origem: "linkedin" },
      // mesma pessoa partida em 2 subscribers (store ainda não fundiu): ativo em um basta
      { subscriberId: 3, emails: ["outro@exemplo.com", "ativo@exemplo.com"], ativo: false, origem: null },
      { subscriberId: 9, emails: ["ex@exemplo.com", null, "não-é-email"], ativo: false, origem: null },
    ]);
    const h = async (e: string) => (await hashEmailComoWorker(e))!;
    const vendas = [
      rec({ transacao: "T1", email_hash: await h("ativo@exemplo.com") }),
      rec({ transacao: "T1", evento: "reembolsada", evento_id: "r1", email_hash: await h("ativo@exemplo.com") }),
      rec({ transacao: "T2", email_hash: await h("ex@exemplo.com") }),
      rec({ transacao: "T3", email_hash: await h("desconhecido@exemplo.com") }),
      rec({ transacao: "T4", email_hash: await h("desconhecido@exemplo.com") }),
      rec({ transacao: "T5", email_hash: null }),
    ];
    const r = cruzarVendas(vendas, indice);
    assert.equal(r.totalEventos, 6);
    assert.deepEqual(r.aprovadas, {
      "assinante-ativo": { eventos: 1, compradores: 1 },
      "ex-assinante": { eventos: 1, compradores: 1 },
      "fora-da-base": { eventos: 2, compradores: 1 },
      "sem-email": { eventos: 1, compradores: 1 },
    });
    assert.equal(r.todos["assinante-ativo"].eventos, 2);
    const t1 = r.vendas.find((v) => v.transacao === "T1" && v.evento === "aprovada")!;
    assert.equal(t1.subscriber_id, 3);
    assert.equal(t1.origem_assinante, "linkedin");
    assert.equal(r.vendas.find((v) => v.transacao === "T3")!.subscriber_id, null);
    assert.deepEqual(r.aprovadasPorOrigem, [
      { origem: "(sem origem no store)", eventos: 1 },
      { origem: "linkedin", eventos: 1 },
    ]);
    const json = JSON.stringify(r);
    assert.ok(!json.includes("@"), "relatório não pode levar e-mail");
    assert.ok(!json.includes(await h("ativo@exemplo.com")), "relatório não pode levar o hash");
  });
});

// ---------------------------------------------------------------------------
// Ponta a ponta: webhook real do Worker → KV falso → rota GET real atrás de
// um servidor HTTP local → CLI `sync-hotmart-vendas.ts` → arquivo.
// ---------------------------------------------------------------------------

function fakeKv() {
  const store = new Map<string, { value: string; metadata: unknown }>();
  return {
    store,
    async put(key: string, value: string, opts?: { metadata?: unknown }) {
      store.set(key, { value, metadata: opts?.metadata });
    },
    async get(key: string) {
      return store.get(key)?.value ?? null;
    },
    async list(opts: { prefix?: string }) {
      const names = [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
      return { keys: names.map((name) => ({ name, metadata: store.get(name)?.metadata ?? null })), list_complete: true };
    },
  };
}

function envWith(kv: ReturnType<typeof fakeKv>): Env {
  return {
    ASSETS: { fetch: async () => new Response("asset", { status: 404 }) } as unknown as Env["ASSETS"],
    POLL: { get: async () => null } as unknown as Env["POLL"],
    CURSOS_SUBSCRIBERS: kv as unknown as KVNamespace,
    HOTMART_HOTTOK: HOTTOK,
    HOTMART_VENDAS_TOKEN: VENDAS_TOKEN,
  } as Env;
}

function runSync(args: string[], baseUrl: string): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/sync-hotmart-vendas.ts", "--base-url", baseUrl, ...args], {
      cwd: ROOT,
      env: { ...process.env, HOTMART_VENDAS_TOKEN: VENDAS_TOKEN },
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => done({ code, out }));
  });
}

describe("#10734 4c CLI sync-hotmart-vendas de ponta a ponta", () => {
  it("espelha as vendas da rota real e é idempotente na 2ª rodada", { timeout: 60_000 }, async () => {
    const kv = fakeKv();
    const env = envWith(kv);
    const email = "Comprador@Exemplo.com";
    const dia20 = Date.UTC(2026, 9, 20, 15, 0);
    for (const p of [
      payload("PURCHASE_APPROVED", "HPA", email, dia20),
      payload("PURCHASE_APPROVED", "HPB", null, dia20),
      payload("PURCHASE_REFUNDED", "HPA", email, Date.UTC(2026, 9, 21, 15, 0)),
    ]) {
      const res = await worker.fetch(
        new Request(`https://diar.ia.br${HOTMART_WEBHOOK_PATH}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-HOTMART-HOTTOK": HOTTOK },
          body: JSON.stringify(p),
        }),
        env,
      );
      assert.equal(res.status, 200);
    }

    let auths: Array<string | undefined> = [];
    const server = createServer(async (req: IncomingMessage, res) => {
      auths.push(req.headers.authorization);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const r = await worker.fetch(new Request(`https://diar.ia.br${req.url}`, { headers }), env);
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(await r.text());
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = mkdtempSync(join(tmpdir(), "hotmart-vendas-espelho-"));
    const out = join(dir, "vendas.jsonl");
    try {
      const r1 = await runSync(["--de", "2026-10-19", "--ate", "2026-10-22", "--out", out], base);
      assert.equal(r1.code, 0, r1.out);
      const linhas1 = readFileSync(out, "utf8").trim().split("\n");
      assert.equal(linhas1.length, 3);
      assert.ok(!r1.out.includes(VENDAS_TOKEN), "token não pode aparecer no log");
      assert.ok(auths.every((a) => a === `Bearer ${VENDAS_TOKEN}`));
      const espelho = lerEspelho(readFileSync(out, "utf8"));
      const aprov = espelho.registros.find((x) => x.transacao === "HPA" && x.evento === "aprovada")!;
      // o hash espelhado é o mesmo que o cruzamento calcula sobre o e-mail do store
      assert.equal(aprov.email_hash, await hashEmailComoWorker("comprador@exemplo.com"));
      assert.ok(!readFileSync(out, "utf8").toLowerCase().includes("comprador@exemplo.com"));

      auths = [];
      const r2 = await runSync(["--de", "2026-10-19", "--ate", "2026-10-22", "--out", out], base);
      assert.equal(r2.code, 0, r2.out);
      assert.match(r2.out, /0 novo\(s\), 3 já no espelho/);
      assert.equal(readFileSync(out, "utf8").trim().split("\n").length, 3);

      // --dry-run não grava nem quando há novidade
      writeFileSync(out, "");
      const r3 = await runSync(["--de", "2026-10-19", "--ate", "2026-10-22", "--out", out, "--dry-run"], base);
      assert.equal(r3.code, 0, r3.out);
      assert.equal(readFileSync(out, "utf8"), "");
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("token errado: exit 1 e nada gravado", { timeout: 60_000 }, async () => {
    const env = { ...envWith(fakeKv()), HOTMART_VENDAS_TOKEN: "outro-token" } as Env;
    const server = createServer(async (req, res) => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const r = await worker.fetch(new Request(`https://diar.ia.br${req.url}`, { headers }), env);
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(await r.text());
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = mkdtempSync(join(tmpdir(), "hotmart-vendas-espelho-"));
    const out = join(dir, "vendas.jsonl");
    try {
      const r = await runSync(["--dias", "3", "--out", out], base);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /HTTP 401/);
      assert.throws(() => readFileSync(out));
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a URL da janela usa a rota do Worker", async () => {
    const { urlDaJanela } = await import("../scripts/sync-hotmart-vendas.ts");
    assert.equal(urlDaJanela("https://diar.ia.br", "2026-10-01", "2026-10-02"), `https://diar.ia.br${HOTMART_VENDAS_PATH}?de=2026-10-01&ate=2026-10-02`);
  });
});
