import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBufferQueueForGrid, loadDivulgacaoGrid, loadFacebookScheduledForGrid, planDivulgacao } from "../scripts/divulgacao-slot-planner.ts";
import { gridFromBufferPosts, gridFromFacebookScheduledPosts, gridFromWorkerQueue } from "../scripts/lib/social-slot-planner.ts";
const now = Date.parse("2026-10-21T00:00:00Z");
const at = (time: string) => `2026-10-22T${time}:00-03:00`;
it("divulgação respeita Stage 5 e collab, distribui pedidos novos sem alterar a grade", () => {
  const grid = gridFromWorkerQueue({ items: [
    ...["07:00", "11:00", "15:00", "19:00"].map((t) => ({ channel: "linkedin", scheduled_at: at(t) })),
    { channel: "instagram", ig_account: "vjpixel", collaborators: ["diar.ia.br"], scheduled_at: at("09:00") },
  ] });
  const before = JSON.stringify(grid);
  const requests = [
    { key: "pagina", account: "linkedin:diaria", preferredAt: at("09:00") },
    { key: "ig1", account: "instagram:diaria", preferredAt: at("09:00") },
    { key: "ig2", account: "instagram:diaria", preferredAt: at("12:15") },
    { key: "threads", account: "threads:diaria", preferredAt: at("09:00") },
  ];
  const decisions = planDivulgacao(grid, requests, now);
  const all = [...grid];
  for (const d of decisions) {
    for (const s of all.filter((s) => s.account === d.account || s.alsoAccounts?.includes(d.account))) {
      assert.ok(Math.abs(Date.parse(s.at) - Date.parse(d.at)) >= 120 * 60_000);
    }
    assert.match(d.at, /^2026-10-22T.*-03:00$/);
    assert.ok(d.premise);
    all.push(d);
  }
  assert.equal(JSON.stringify(grid), before);
});
it("sem slot de 2h aborta em vez de empilhar ou mudar o dia", () => {
  const grid = Array.from({ length: 17 }, (_, i) => ({ account: "linkedin:diaria", at: at(`${String(i + 6).padStart(2, "0")}:00`) }));
  assert.throws(() => planDivulgacao(grid, [{ key: "p", account: "linkedin:diaria", preferredAt: at("09:00") }], now), /sem slot seguro/);
  assert.throws(() => planDivulgacao([], [{ key: "p", account: "linkedin:diaria", preferredAt: at("09:00") }], Date.parse("2026-10-23T00:00:00-03:00")), /sem slot seguro/);
});

it("grade de divulgação reúne stores, fila, collab, Facebook agendado e fila do X no Buffer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "divulgacao-grid-"));
  mkdirSync(join(dir, "_internal"));
  const write = (file: string, value: unknown) => writeFileSync(join(dir, "_internal", file), JSON.stringify(value));
  write("06-social-published.json", { posts: ["linkedin", "facebook", "twitter"].map((platform) => ({ platform, status: "scheduled", scheduled_at: at("11:00") })) });
  write("06-shorts-published.json", { entries: [{ destination: "instagram", scheduled_at: at("09:00") }] });
  write("06-linkedin-personal.json", { status: "armed", scheduled_at: at("15:00") });
  let range: { start: string; end: string } | null = null;
  try {
    const grid = await loadDivulgacaoGrid({ publishing: { shorts: { instagram_author_page: "vjpixel", instagram_collaborators: ["diar.ia.br"] } } }, ["2026-10-22"], () => {}, {
      editionDir: (date) => { assert.equal(date, "261022"); return dir; },
      loadQueue: async () => ({ items: [{ channel: "linkedin", scheduled_at: at("11:00") }, { channel: "threads", scheduled_at: at("19:00") }] }),
      // O post diário das 11:00 aparece no store E na Graph/Buffer: conta uma vez só.
      loadFacebook: async () => [{ account: "facebook:diaria", at: at("11:00") }, { account: "facebook:diaria", at: at("18:00") }],
      loadBuffer: async (r) => { range = r; return [{ account: "twitter:diaria", at: at("11:00") }, { account: "twitter:diaria", at: at("20:00") }]; },
    });
    assert.equal(grid.filter((s) => s.account === "linkedin:diaria").length, 1);
    assert.ok(grid.some((s) => s.account === "linkedin:pessoal"));
    assert.ok(grid.some((s) => s.account === "threads:diaria"));
    assert.deepEqual(grid.find((s) => s.account === "instagram:vjpixel")?.alsoAccounts, ["instagram:diaria"]);
    assert.equal(grid.filter((s) => s.account === "facebook:diaria").length, 2);
    assert.equal(grid.filter((s) => s.account === "twitter:diaria").length, 2);
    assert.deepEqual(range, { start: "2026-10-22T03:00:00.000Z", end: "2026-10-23T03:00:00.000Z" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("adaptadores: Graph scheduled_posts (segundos Unix) e Buffer posts (só X agendado)", () => {
  const t = Date.parse(at("18:00")) / 1000;
  assert.deepEqual(gridFromFacebookScheduledPosts({ data: [{ id: "1", scheduled_publish_time: t }, { id: "2" }] }, "memelab").map((s) => [s.account, Date.parse(s.at)]),
    [["facebook:memelab", t * 1000]]);
  assert.deepEqual(gridFromFacebookScheduledPosts({ error: { message: "x" } }), []);
  const node = (o: Record<string, unknown>) => ({ node: { channelService: "twitter", status: "scheduled", dueAt: at("20:00"), ...o } });
  const slots = gridFromBufferPosts({ data: { posts: { edges: [node({}), node({ status: "sent" }), node({ status: "draft" }), node({ channelService: "linkedin" }), node({ dueAt: null }), node({ status: "sending" })] } } });
  assert.equal(slots.length, 2);
  assert.ok(slots.every((s) => s.account === "twitter:diaria"));
  assert.deepEqual(gridFromBufferPosts({ errors: [{ message: "boom" }] }), []);
});

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

it("Facebook: página que falha vira aviso e não derruba as outras", async () => {
  const warns: string[] = [];
  const urls: string[] = [];
  const fetchFn = (async (url: string) => {
    urls.push(url);
    if (url.includes("/222/")) return jsonRes({ error: { message: "token expirado" } });
    return jsonRes({ data: [{ id: "1", scheduled_publish_time: Date.parse(at("18:00")) / 1000 }] });
  }) as typeof fetch;
  const grid = await loadFacebookScheduledForGrid(
    [{ slug: "diaria", pageId: "111", token: "a" }, { slug: "memelab", pageId: "222", token: "b" }], "v25.0", fetchFn, (m) => warns.push(m));
  assert.deepEqual(grid.map((s) => s.account), ["facebook:diaria"]);
  assert.equal(urls.length, 2);
  assert.ok(urls[0].startsWith("https://graph.facebook.com/v25.0/111/scheduled_posts?"));
  assert.match(warns.join(), /Facebook memelab \(token expirado\)/);
});

it("Buffer: sem token avisa sem chamar a rede; organização + posts; erro GraphQL é fail-soft", async () => {
  const range = { start: "2026-10-22T03:00:00.000Z", end: "2026-10-23T03:00:00.000Z" };
  const warns: string[] = [];
  let calls = 0;
  const never = (async () => { calls++; throw new Error("não devia chamar"); }) as typeof fetch;
  assert.deepEqual(await loadBufferQueueForGrid("", "ch1", range, never, (m) => warns.push(m)), []);
  assert.equal(calls, 0);
  assert.match(warns.join(), /BUFFER_ACCESS_TOKEN ausente/);

  const bodies: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const ok = (async (_url: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body));
    bodies.push(b);
    if (b.query.includes("GridChannel")) return jsonRes({ data: { channel: { organizationId: "org9" } } });
    return jsonRes({ data: { posts: { edges: [{ node: { channelService: "twitter", status: "scheduled", dueAt: at("20:00") } }] } } });
  }) as typeof fetch;
  const grid = await loadBufferQueueForGrid("tok", "ch1", range, ok, () => {});
  assert.deepEqual(grid.map((s) => s.account), ["twitter:diaria"]);
  assert.deepEqual(bodies[1].variables, { org: "org9", ch: ["ch1"], start: range.start, end: range.end });

  const warns2: string[] = [];
  const bad = (async () => jsonRes({ errors: [{ message: "Unauthorized" }] })) as typeof fetch;
  assert.deepEqual(await loadBufferQueueForGrid("tok", "ch1", range, bad, (m) => warns2.push(m)), []);
  assert.match(warns2.join(), /Buffer \(Unauthorized\)/);
});

it("Facebook em várias páginas: o horário respeita a grade de todas (alsoAccounts)", () => {
  // diaria livre às 09:00, mas memelab já tem post às 09:00: o post lógico sai nas duas, então não pode cair ali.
  const grid = [{ account: "facebook:memelab", at: at("09:00") }];
  const [d] = planDivulgacao(grid, [{ key: "facebook:d1", account: "facebook:diaria", alsoAccounts: ["facebook:memelab"], preferredAt: at("09:00") }], now);
  assert.ok(Math.abs(Date.parse(d.at) - Date.parse(at("09:00"))) >= 120 * 60_000);
  const [solo] = planDivulgacao(grid, [{ key: "facebook:d1", account: "facebook:diaria", preferredAt: at("09:00") }], now);
  assert.equal(Date.parse(solo.at), Date.parse(at("09:00")));
});
