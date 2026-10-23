import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDivulgacaoGrid, planDivulgacao } from "../scripts/divulgacao-slot-planner.ts";
import { gridFromWorkerQueue } from "../scripts/lib/social-slot-planner.ts";
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

it("grade de divulgação reúne stores, fila e collab, sem Facebook/X diretos", async () => {
  const dir = mkdtempSync(join(tmpdir(), "divulgacao-grid-"));
  mkdirSync(join(dir, "_internal"));
  const write = (file: string, value: unknown) => writeFileSync(join(dir, "_internal", file), JSON.stringify(value));
  write("06-social-published.json", { posts: ["linkedin", "facebook", "twitter"].map((platform) => ({ platform, status: "scheduled", scheduled_at: at("11:00") })) });
  write("06-shorts-published.json", { entries: [{ destination: "instagram", scheduled_at: at("09:00") }] });
  write("06-linkedin-personal.json", { status: "armed", scheduled_at: at("15:00") });
  try {
    const grid = await loadDivulgacaoGrid({ publishing: { shorts: { instagram_author_page: "vjpixel", instagram_collaborators: ["diar.ia.br"] } } }, ["2026-10-22"], () => {}, {
      editionDir: (date) => { assert.equal(date, "261022"); return dir; },
      loadQueue: async () => ({ items: [{ channel: "linkedin", scheduled_at: at("11:00") }, { channel: "threads", scheduled_at: at("19:00") }] }),
    });
    assert.equal(grid.filter((s) => s.account === "linkedin:diaria").length, 1);
    assert.ok(grid.some((s) => s.account === "linkedin:pessoal"));
    assert.ok(grid.some((s) => s.account === "threads:diaria"));
    assert.deepEqual(grid.find((s) => s.account === "instagram:vjpixel")?.alsoAccounts, ["instagram:diaria"]);
    assert.ok(!grid.some((s) => /^(facebook|twitter):/.test(s.account)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
