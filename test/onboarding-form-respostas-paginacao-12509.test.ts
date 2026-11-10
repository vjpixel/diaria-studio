/**
 * test/onboarding-form-respostas-paginacao-12509.test.ts (#12509)
 *
 * `GET /api/respostas` fazia um `list` e um `get` por chave da lista inteira
 * numa invocação só. O Workers limita as operações de KV por invocação a 1000,
 * então o endpoint passava a falhar quando o número de chaves passasse disso
 * (e com ele a rodada de follow-up, o `--status` e o perfil de audiência).
 *
 * O KV falso daqui imita o Workers: `list` devolve no máximo `limit` chaves
 * (default 1000) com cursor, e cada invocação do Worker LANÇA ao passar de
 * 1000 operações. Com 1200 chaves, o código antigo estourava; o novo responde
 * uma página por invocação e `fetchAllFormResponses` junta todas.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FORM_RESPONSES_PAGE_SIZE,
  fetchAllFormResponses,
  formHistoryKey,
  formResponseKey,
  parseFormResponsesPage,
  readFormResponsesPage,
  type FormResponse,
} from "../scripts/lib/onboarding-form-contract.ts";
import worker, { type Env } from "../workers/onboarding-form/src/index.ts";

const KV_OPS_PER_INVOCATION = 1000;

/** KV falso com o teto de operações por invocação e a paginação do `list`. */
function fakeKv(entries: Map<string, string>) {
  let ops = 0;
  const stats = { maxOps: 0, lists: 0 };
  const count = () => {
    ops++;
    stats.maxOps = Math.max(stats.maxOps, ops);
    if (ops > KV_OPS_PER_INVOCATION) throw new Error("Too many API requests by single worker invocation");
  };
  const ns = {
    async list({ prefix, cursor, limit }: { prefix: string; cursor?: string; limit?: number }) {
      count();
      stats.lists++;
      const all = [...entries.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const end = Math.min(all.length, start + Math.min(limit ?? 1000, 1000));
      const keys = all.slice(start, end).map((name) => ({ name }));
      return end >= all.length ? { keys, list_complete: true as const } : { keys, list_complete: false as const, cursor: String(end) };
    },
    async get(k: string) {
      count();
      return entries.get(k) ?? null;
    },
    async put(k: string, v: string) {
      count();
      entries.set(k, v);
    },
  };
  return { ns, stats, resetInvocation: () => (ops = 0) };
}

function respEntries(n: number): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < n; i++) {
    const email = `p${String(i).padStart(5, "0")}@x.com`;
    m.set(formResponseKey(email), JSON.stringify({ email, submitted_at: "2026-11-09T00:00:00.000Z", answers: {} }));
  }
  return m;
}

function setup(entries: Map<string, string>) {
  const kv = fakeKv(entries);
  const env = { ONBOARDING_FORM: kv.ns as unknown as KVNamespace, RESPONSES_TOKEN: "tok" } as Env;
  // Cada chamada HTTP é uma invocação nova do Worker (o contador zera).
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    kv.resetInvocation();
    return worker.fetch(new Request(String(input), init), env);
  }) as typeof fetch;
  return { kv, env, fetchImpl };
}

const URL_RESP = "https://f.example/api/respostas";

describe("#12509 /api/respostas paginado", () => {
  it("1200 chaves: nenhuma invocação passa de 1000 operações de KV e todas as respostas chegam", async () => {
    const { kv, fetchImpl } = setup(respEntries(1200));
    const all = await fetchAllFormResponses(URL_RESP, "tok", { fetchImpl });
    assert.equal(all.length, 1200);
    assert.equal(new Set(all.map((r) => r.email)).size, 1200, "nenhuma resposta repetida entre páginas");
    assert.ok(kv.stats.maxOps <= KV_OPS_PER_INVOCATION, `pico de ${kv.stats.maxOps} operações numa invocação`);
    assert.equal(kv.stats.maxOps, FORM_RESPONSES_PAGE_SIZE + 1, "1 list + 1 get por chave da página");
    assert.equal(kv.stats.lists, Math.ceil(1200 / FORM_RESPONSES_PAGE_SIZE));
  });

  it("o KV falso discrimina: ler as 1200 numa invocação só (o código antigo) estoura o teto", async () => {
    const { kv } = setup(respEntries(1200));
    await assert.rejects(async () => {
      let cursor: string | undefined;
      do {
        const list = await kv.ns.list({ prefix: "resp:", cursor });
        for (const k of list.keys) await kv.ns.get(k.name);
        cursor = list.list_complete ? undefined : list.cursor;
      } while (cursor);
    }, /Too many API requests/);
  });

  it("a página traz next_cursor; a última, null; ?cursor= continua de onde parou", async () => {
    const { env } = setup(respEntries(FORM_RESPONSES_PAGE_SIZE + 3));
    const auth = { headers: { authorization: "Bearer tok" } };
    const p1 = (await (await worker.fetch(new Request(URL_RESP, auth), env)).json()) as { responses: FormResponse[]; next_cursor: string | null };
    assert.equal(p1.responses.length, FORM_RESPONSES_PAGE_SIZE);
    assert.equal(typeof p1.next_cursor, "string");
    const p2 = (await (await worker.fetch(new Request(`${URL_RESP}?cursor=${encodeURIComponent(p1.next_cursor!)}`, auth), env)).json()) as {
      responses: FormResponse[];
      next_cursor: string | null;
    };
    assert.equal(p2.responses.length, 3);
    assert.equal(p2.next_cursor, null);
  });

  it("segunda página do list DENTRO do teto: o cursor do KV é repassado como next_cursor", async () => {
    // Página do Worker menor que o total: o `list` volta com list_complete=false.
    const { ns } = fakeKv(respEntries(7));
    const page = await readFormResponsesPage(ns, "resp:", undefined, 5);
    assert.equal(page.responses.length, 5);
    assert.equal(page.next_cursor, "5");
    const last = await readFormResponsesPage(ns, "resp:", page.next_cursor!, 5);
    assert.equal(last.responses.length, 2);
    assert.equal(last.next_cursor, null);
  });

  it("?historico=1 também pagina", async () => {
    const m = new Map<string, string>();
    for (let i = 0; i < 1100; i++) {
      const at = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
      m.set(formHistoryKey("a@x.com", at), JSON.stringify({ email: "a@x.com", submitted_at: at, answers: {} }));
    }
    const { kv, fetchImpl } = setup(m);
    const all = await fetchAllFormResponses(`${URL_RESP}?historico=1`, "tok", { fetchImpl });
    assert.equal(all.length, 1100);
    assert.ok(kv.stats.maxOps <= KV_OPS_PER_INVOCATION);
  });

  it("valor ilegível é pulado sem derrubar a página", async () => {
    const m = respEntries(3);
    m.set(formResponseKey("zz@x.com"), "{lixo");
    const { fetchImpl } = setup(m);
    const all = await fetchAllFormResponses(URL_RESP, "tok", { fetchImpl });
    assert.equal(all.length, 3);
  });

  it("falha do KV: 503 com motivo explícito, e quem lê lança com o motivo (nunca lista parcial)", async () => {
    const kv = {
      async list() {
        throw new Error("Too many API requests by single worker invocation");
      },
      async get() {
        return null;
      },
    };
    const env = { ONBOARDING_FORM: kv as unknown as KVNamespace, RESPONSES_TOKEN: "tok" } as Env;
    const res = await worker.fetch(new Request(URL_RESP, { headers: { authorization: "Bearer tok" } }), env);
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string; reason: string };
    assert.equal(body.error, "kv_failure");
    assert.match(body.reason, /Too many API requests/);

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => worker.fetch(new Request(String(input), init), env)) as typeof fetch;
    await assert.rejects(fetchAllFormResponses(URL_RESP, "tok", { fetchImpl }), /HTTP 503 \(Too many API requests/);
  });

  it("falha no meio: a 2ª página falhando lança, as respostas da 1ª não voltam sozinhas", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      if (call === 1) return Response.json({ responses: [{ email: "a@x.com", submitted_at: "2026-11-09T00:00:00Z", answers: {} }], next_cursor: "c1" });
      return new Response("boom", { status: 500 });
    }) as typeof fetch;
    await assert.rejects(fetchAllFormResponses(URL_RESP, "tok", { fetchImpl }), /HTTP 500/);
  });

  it("cursor repetido ou páginas sem fim: lança em vez de laço infinito", async () => {
    const loop = (async () => Response.json({ responses: [], next_cursor: "mesmo" })) as typeof fetch;
    await assert.rejects(fetchAllFormResponses(URL_RESP, "tok", { fetchImpl: loop }), /repetido/);
    let n = 0;
    const endless = (async () => Response.json({ responses: [], next_cursor: `c${n++}` })) as typeof fetch;
    await assert.rejects(fetchAllFormResponses(URL_RESP, "tok", { fetchImpl: endless, maxPages: 5 }), /5 páginas/);
  });

  it("1ª chamada vai na URL configurada (sem cursor); as seguintes levam ?cursor=, preservando ?historico=1", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return Response.json(urls.length === 1 ? { responses: [], next_cursor: "a b" } : { responses: [] });
    }) as typeof fetch;
    await fetchAllFormResponses(`${URL_RESP}?historico=1`, "tok", { fetchImpl });
    assert.equal(urls[0], `${URL_RESP}?historico=1`);
    const second = new URL(urls[1]!);
    assert.equal(second.searchParams.get("historico"), "1");
    assert.equal(second.searchParams.get("cursor"), "a b");
  });

  it("payload: next_cursor só string não vazia, null ou ausente", () => {
    assert.equal(parseFormResponsesPage({ responses: [] }).next_cursor, null);
    assert.equal(parseFormResponsesPage({ responses: [], next_cursor: null }).next_cursor, null);
    assert.equal(parseFormResponsesPage({ responses: [], next_cursor: "x" }).next_cursor, "x");
    assert.throws(() => parseFormResponsesPage({ responses: [], next_cursor: 3 }), /next_cursor inválido/);
    assert.throws(() => parseFormResponsesPage({ responses: [], next_cursor: "" }), /next_cursor inválido/);
  });
});
