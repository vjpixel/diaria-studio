/**
 * test/fetch-test-email.test.ts (#9886)
 *
 * O §5f passo 0 do Stage 5 passou a buscar o e-mail de teste por
 * `scripts/fetch-test-email.ts` (Gmail REST, sem MCP) em vez de o top-level
 * chamar `get_thread` e gravar ~100 KB de HTML com Write. Cobre: queries por
 * ESP, escolha da parte HTML, parte entregue como anexo, timeout, falha de API
 * vira `gmail_api_unavailable` (nunca exceção) e o resumo não carrega o corpo.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildTestEmailQueries,
  EXIT_BY_STATUS,
  fetchTestEmail,
  findBodyPart,
  parseSentAfter,
  pickLatestMessage,
  type FetchDeps,
} from "../scripts/fetch-test-email.ts";
import { makeEditionDir } from "./_helpers/make-edition-dir.ts";

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

function thread(html: string, opts: { asAttachment?: boolean; sizeEstimate?: number } = {}) {
  return {
    id: "t1",
    messages: [
      {
        id: "m-old",
        internalDate: "1000",
        payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: "velho" }], body: { data: b64url("x") } },
      },
      {
        id: "m1",
        internalDate: String(Date.UTC(2026, 9, 8, 22, 0)),
        sizeEstimate: opts.sizeEstimate ?? 50_000,
        payload: {
          mimeType: "multipart/alternative",
          headers: [{ name: "Subject", value: "[teste] Título da edição" }],
          parts: [
            { mimeType: "text/plain", body: { data: b64url("versão texto") } },
            opts.asAttachment
              ? { mimeType: "text/html", body: { attachmentId: "att1", size: Buffer.byteLength(html) } }
              : { mimeType: "text/html", body: { data: b64url(html), size: Buffer.byteLength(html) } },
          ],
        },
      },
    ],
  };
}

function deps(routes: Record<string, unknown>, calls: string[] = []): FetchDeps {
  let t = 0;
  return {
    gmailGet: async (path) => {
      calls.push(path);
      for (const [prefix, value] of Object.entries(routes)) {
        if (path.startsWith(prefix)) {
          if (value instanceof Error) throw value;
          return typeof value === "function" ? (value as (p: string) => unknown)(path) : value;
        }
      }
      throw new Error(`rota não mockada: ${path}`);
    },
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
  };
}

describe("buildTestEmailQueries (#9886)", () => {
  it("Kit e Beehiiv usam o prefixo/remetente do test-send, com fallback sem prefixo", () => {
    assert.deepEqual(buildTestEmailQueries("kit", 'O "agente" voltou'), [
      'subject:"[teste] O agente voltou" from:news.diar.ia.br newer_than:1d',
      'subject:"O agente voltou" from:news.diar.ia.br newer_than:1d',
    ]);
    assert.match(buildTestEmailQueries("beehiiv", "X")[0], /^subject:"\[TEST\] X" from:beehiiv\.com/);
  });
});

describe("findBodyPart (#9886)", () => {
  it("prefere text/html e ignora anexo com filename", () => {
    const p = findBodyPart({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/html", filename: "anexo.html", body: { data: "zz" } },
        { mimeType: "multipart/alternative", parts: [
          { mimeType: "text/plain", body: { data: "aa" } },
          { mimeType: "text/html", body: { data: "bb" } },
        ] },
      ],
    });
    assert.equal(p?.mimeType, "text/html");
    assert.equal(p?.data, "bb");
  });
});

describe("fetchTestEmail (#9886)", () => {
  it("achou: grava o corpo HTML + lint de tamanho e o resumo não carrega o corpo", async () => {
    const dir = makeEditionDir("fetch-test-email-");
    try {
      writeFileSync(resolve(dir, "_internal", "newsletter-final-kit.html"), "<p>local</p>");
      const html = "<html><body>" + "x".repeat(2000) + "</body></html>";
      const calls: string[] = [];
      const s = await fetchTestEmail(
        { editionDir: dir, platform: "kit", title: "Título da edição" },
        deps({ "threads?": { threads: [{ id: "t1" }] }, "threads/t1": thread(html) }, calls),
      );
      assert.equal(s.status, "found");
      assert.equal(EXIT_BY_STATUS[s.status], 0);
      assert.equal(s.email_subject, "[teste] Título da edição");
      assert.equal(s.message_id, "m1", "usa a mensagem mais recente da thread");
      assert.equal(s.body_mime, "text/html");
      assert.equal(readFileSync(s.email_file!, "utf8"), html);
      assert.equal(s.lint_size?.delivered_source, "gmail_html_part");
      assert.equal(s.lint_size?.delivered_bytes, Buffer.byteLength(html));
      const lint = JSON.parse(readFileSync(s.lint_size_file!, "utf8"));
      assert.equal(lint.local_html_bytes, Buffer.byteLength("<p>local</p>"));
      assert.ok(!JSON.stringify(s).includes("x".repeat(200)), "o corpo nunca vai pro resumo");
      assert.match(decodeURIComponent(calls[0]), /\[teste\]/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("parte HTML entregue como anexo é buscada em messages/{id}/attachments", async () => {
    const dir = makeEditionDir("fetch-test-email-");
    try {
      const html = "<p>grande</p>";
      const s = await fetchTestEmail(
        { editionDir: dir, platform: "kit", title: "T" },
        deps({
          "threads?": { threads: [{ id: "t1" }] },
          "threads/t1": thread(html, { asAttachment: true }),
          "messages/m1/attachments/att1": { data: b64url(html) },
        }),
      );
      assert.equal(s.status, "found");
      assert.equal(readFileSync(s.email_file!, "utf8"), html);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("acima do corte do Gmail o lint acusa over_limit pela parte HTML (não pelo teto sizeEstimate)", async () => {
    const dir = makeEditionDir("fetch-test-email-");
    try {
      const html = "y".repeat(110 * 1024);
      const s = await fetchTestEmail(
        { editionDir: dir, platform: "kit", title: "T" },
        deps({ "threads?": { threads: [{ id: "t1" }] }, "threads/t1": thread(html, { sizeEstimate: 130_000 }) }),
      );
      assert.equal(s.lint_size?.over_limit, true);
      assert.deepEqual(s.lint_size?.issues, ["warning: delivered_size_over_clip"]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("não achou no prazo → not_found_timeout (exit 3), sem corpo gravado; tentou as 2 queries", async () => {
    const dir = makeEditionDir("fetch-test-email-");
    try {
      const calls: string[] = [];
      const s = await fetchTestEmail(
        { editionDir: dir, platform: "kit", title: "T", timeoutSeconds: 10, pollSeconds: 5 },
        deps({ "threads?": { threads: [] } }, calls),
      );
      assert.equal(s.status, "not_found_timeout");
      assert.equal(EXIT_BY_STATUS[s.status], 3);
      assert.equal(existsSync(resolve(dir, "_internal", ".email-body.tmp")), false);
      assert.ok(calls.length >= 4, `polling repetiu as 2 queries (${calls.length} chamadas)`);
      assert.ok(calls.some((c) => !decodeURIComponent(c).includes("[teste]")), "fallback sem prefixo");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("erro de credencial/API → gmail_api_unavailable (exit 4), nunca exceção", async () => {
    const dir = makeEditionDir("fetch-test-email-");
    try {
      const s = await fetchTestEmail(
        { editionDir: dir, platform: "beehiiv", title: "T" },
        deps({ "threads?": new Error("Credenciais não encontradas") }),
      );
      assert.equal(s.status, "gmail_api_unavailable");
      assert.equal(EXIT_BY_STATUS[s.status], 4);
      assert.match(s.error ?? "", /Credenciais/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #9901: reexecução no mesmo dia — o teste anterior já está na caixa e o novo
// demora. Sem âncora o script devolvia o corpo antigo; com `sentAfterMs` ele
// ignora mensagem anterior ao envio e continua o polling até o prazo.
// ---------------------------------------------------------------------------

describe("fetchTestEmail --sent-after (#9901)", () => {
  const SENT = Date.UTC(2026, 9, 8, 22, 30);
  const msgAt = (id: string, at: number, html: string) => ({
    id,
    internalDate: String(at),
    payload: {
      mimeType: "text/html",
      headers: [{ name: "Subject", value: `[teste] ${id}` }],
      body: { data: b64url(html), size: Buffer.byteLength(html) },
    },
  });

  it("REGRESSÃO: e-mail antigo primeiro na caixa, novo chega num poll seguinte → lê o novo", async () => {
    const dir = makeEditionDir("fetch-test-email-9901-");
    try {
      const oldMsg = msgAt("m-antigo", SENT - 60 * 60_000, "<p>antigo</p>");
      const newMsg = msgAt("m-novo", SENT + 40_000, "<p>novo</p>");
      let listCalls = 0;
      const s = await fetchTestEmail(
        { editionDir: dir, platform: "kit", title: "T", waitSeconds: 0, timeoutSeconds: 30, pollSeconds: 5, sentAfterMs: SENT },
        deps({
          // Mesmo assunto → mesma thread; o novo só aparece depois do 1º ciclo de polling.
          "threads?": () => {
            listCalls++;
            return { threads: [{ id: "t1" }] };
          },
          "threads/t1": () => ({ id: "t1", messages: listCalls > 2 ? [oldMsg, newMsg] : [oldMsg] }),
        }),
      );
      assert.equal(s.status, "found");
      assert.equal(s.message_id, "m-novo");
      assert.equal(readFileSync(s.email_file!, "utf8"), "<p>novo</p>");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("só o antigo até o prazo → not_found_timeout, nunca o corpo velho", async () => {
    const dir = makeEditionDir("fetch-test-email-9901-");
    try {
      const s = await fetchTestEmail(
        { editionDir: dir, platform: "beehiiv", title: "T", waitSeconds: 0, timeoutSeconds: 10, sentAfterMs: SENT },
        deps({
          "threads?": { threads: [{ id: "t1" }] },
          "threads/t1": { id: "t1", messages: [msgAt("m-antigo", SENT - 10 * 60_000, "<p>antigo</p>")] },
        }),
      );
      assert.equal(s.status, "not_found_timeout");
      assert.equal(existsSync(resolve(dir, "_internal", ".email-body.tmp")), false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("novo em OUTRA thread, abaixo da antiga na lista → acha olhando a 2ª thread", async () => {
    const dir = makeEditionDir("fetch-test-email-9901-");
    try {
      const s = await fetchTestEmail(
        { editionDir: dir, platform: "kit", title: "T", waitSeconds: 0, sentAfterMs: SENT },
        deps({
          "threads?": { threads: [{ id: "t-velha" }, { id: "t-nova" }] },
          "threads/t-velha": { id: "t-velha", messages: [msgAt("m-antigo", SENT - 60_000, "<p>antigo</p>")] },
          "threads/t-nova": { id: "t-nova", messages: [msgAt("m-novo", SENT + 1_000, "<p>novo</p>")] },
        }),
      );
      assert.equal(s.message_id, "m-novo");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("pickLatestMessage respeita o corte; parseSentAfter valida ISO", () => {
    const ms = [{ internalDate: "100" }, { internalDate: "300" }, { internalDate: "200" }];
    assert.equal(pickLatestMessage(ms, null)?.internalDate, "300");
    assert.equal(pickLatestMessage(ms, 250)?.internalDate, "300");
    assert.equal(pickLatestMessage(ms, 301), null);
    assert.equal(parseSentAfter(undefined), undefined);
    assert.equal(parseSentAfter("2026-10-08T22:30:00Z"), SENT);
    assert.throws(() => parseSentAfter("ontem"), /--sent-after inválido/);
  });
});
