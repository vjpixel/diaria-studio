/**
 * #8548 item 2 — autenticação do remetente do e-mail de confirmação (DKIM,
 * SPF do Return-Path, DMARC), avaliada sobre registros DNS injetados.
 * Fixture "saudável" = o que o DNS de news.diar.ia.br respondia em 27/10/2026.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectSenderAuthDns,
  evaluateSenderAuth,
  parseTagList,
  type DnsLookup,
  type SenderAuthDns,
} from "../scripts/lib/confirmation-email-auth.ts";
import { exitCodeFor, renderSenderAuthReport } from "../scripts/confirmation-email-auth-report.ts";

const ok = <T,>(value: T): DnsLookup<T> => ({ kind: "ok", value });
const absent: DnsLookup<string[]> = { kind: "absent" };

const healthy = (): SenderAuthDns => ({
  domain: "news.diar.ia.br",
  dmarcTxt: ok(["v=DMARC1; p=reject; rua=mailto:pixel@diar.ia.br; ruf=mailto:pixel@diar.ia.br; fo=1"]),
  dkimCname: ok(["dkim.dm-3508147f.sg1.convertkit.com"]),
  dkimTxt: ok(["k=rsa; t=s; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzPEo5UFva3"]),
  returnPathCname: ok(["spf.dm-9ac7f2d6.sg1.convertkit.com"]),
  returnPathTxt: ok(["v=spf1 include:spf.kit.com ~all"]),
});

const status = (dns: SenderAuthDns, id: string) => evaluateSenderAuth(dns).checks.find((c) => c.id === id)!.status;

describe("evaluateSenderAuth (#8548 item 2)", () => {
  it("configuração medida em 27/10/2026 passa inteira", () => {
    const r = evaluateSenderAuth(healthy());
    assert.equal(r.veredito, "ok");
    assert.deepEqual(r.checks.map((c) => c.status), ["ok", "ok", "ok"]);
    assert.equal(exitCodeFor(r), 0);
  });

  it("DKIM ausente é falha e o exit code é 1", () => {
    const r = evaluateSenderAuth({ ...healthy(), dkimTxt: absent, dkimCname: absent });
    assert.equal(r.veredito, "falha");
    assert.equal(exitCodeFor(r), 1);
  });

  it("DKIM com p= vazio (chave revogada) é falha", () => {
    assert.equal(status({ ...healthy(), dkimTxt: ok(["v=DKIM1; k=rsa; p="]) }, "dkim"), "falha");
  });

  it("CNAME do DKIM fora do Kit é aviso", () => {
    assert.equal(status({ ...healthy(), dkimCname: ok(["dkim.outro-esp.example"]) }, "dkim"), "aviso");
  });

  it("Return-Path sem SPF é falha; dois v=spf1 é falha (permerror)", () => {
    assert.equal(status({ ...healthy(), returnPathTxt: absent, returnPathCname: absent }, "spf-return-path"), "falha");
    assert.equal(
      status({ ...healthy(), returnPathTxt: ok(["v=spf1 include:spf.kit.com ~all", "v=spf1 -all"]) }, "spf-return-path"),
      "falha",
    );
  });

  it("SPF do Return-Path sem o Kit é aviso", () => {
    assert.equal(status({ ...healthy(), returnPathTxt: ok(["v=spf1 include:_spf.mx.cloudflare.net ~all"]) }, "spf-return-path"), "aviso");
  });

  it("DMARC ausente é falha; aspf=s e falta de rua= são avisos", () => {
    assert.equal(status({ ...healthy(), dmarcTxt: absent }, "dmarc"), "falha");
    assert.equal(status({ ...healthy(), dmarcTxt: ok(["v=DMARC1; p=reject; aspf=s; rua=mailto:x@y"]) }, "dmarc"), "aviso");
    assert.equal(status({ ...healthy(), dmarcTxt: ok(["v=DMARC1; p=none"]) }, "dmarc"), "aviso");
  });

  it("DMARC com p= inválido ou duplicado é falha", () => {
    assert.equal(status({ ...healthy(), dmarcTxt: ok(["v=DMARC1; p=talvez; rua=mailto:x@y"]) }, "dmarc"), "falha");
    assert.equal(status({ ...healthy(), dmarcTxt: ok(["v=DMARC1; p=none", "v=DMARC1; p=reject"]) }, "dmarc"), "falha");
  });

  it("erro de consulta vira nao-verificavel (exit 2), nunca ausência", () => {
    const r = evaluateSenderAuth({ ...healthy(), dmarcTxt: { kind: "error", code: "ETIMEOUT" } });
    assert.equal(r.veredito, "nao-verificavel");
    assert.equal(exitCodeFor(r), 2);
  });

  it("falha vence nao-verificavel no veredito", () => {
    const r = evaluateSenderAuth({ ...healthy(), dmarcTxt: { kind: "error", code: "ETIMEOUT" }, dkimTxt: absent });
    assert.equal(r.veredito, "falha");
  });

  it("o relatório em texto lista os 3 registros e o veredito", () => {
    const txt = renderSenderAuthReport(evaluateSenderAuth(healthy()));
    assert.match(txt, /cka\._domainkey\.news\.diar\.ia\.br/);
    assert.match(txt, /ckespa\.news\.diar\.ia\.br/);
    assert.match(txt, /_dmarc\.news\.diar\.ia\.br/);
    assert.match(txt, /Veredito: ok/);
  });
});

describe("parseTagList", () => {
  it("lê tags com espaço e chave em maiúscula", () => {
    const t = parseTagList("v=DMARC1;  P=reject ; rua=mailto:a@b");
    assert.equal(t.get("p"), "reject");
    assert.equal(t.get("rua"), "mailto:a@b");
  });
});

describe("collectSenderAuthDns", () => {
  it("ENODATA/ENOTFOUND = absent; outro código = error; TXT em chunks é concatenado", async () => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    const dns = await collectSenderAuthDns("news.diar.ia.br", {
      resolveTxt: async (host) => {
        if (host === "_dmarc.news.diar.ia.br") throw err("ENODATA");
        if (host === "ckespa.news.diar.ia.br") throw err("ESERVFAIL");
        return [["k=rsa; p=AB", "CD"]];
      },
      resolveCname: async (host) => {
        if (host.startsWith("ckespa")) throw err("ENOTFOUND");
        return ["dkim.dm-1.sg1.convertkit.com"];
      },
    });
    assert.deepEqual(dns.dmarcTxt, { kind: "absent" });
    assert.deepEqual(dns.returnPathTxt, { kind: "error", code: "ESERVFAIL" });
    assert.deepEqual(dns.returnPathCname, { kind: "absent" });
    assert.deepEqual(dns.dkimTxt, { kind: "ok", value: ["k=rsa; p=ABCD"] });
  });
});
