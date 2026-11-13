import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDivulgacaoGrid, unionShortsRegistryRaw } from "../scripts/divulgacao-slot-planner.ts";

const at = (time: string) => `2026-10-22T${time}:00-03:00`;
const noRemote = {
  loadQueue: async () => ({ items: [] }),
  loadFacebook: async () => [],
  loadBuffer: async () => [],
};

it("#12959: grade do vertical lê os registros dos timers do Instagram e do Threads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "divulgacao-12959-"));
  mkdirSync(join(dir, "_internal"));
  const write = (file: string, value: unknown) => writeFileSync(join(dir, "_internal", file), JSON.stringify(value));
  // O timer do Instagram e o do Threads agendaram no 300 e gravaram só no próprio registro.
  write("06-shorts-published.instagram-timer.json", { aammdd: "261022", entries: [{ destination: "instagram", at: at("08:00"), scheduled_at: at("10:00") }] });
  write("06-shorts-published.threads-timer.json", { aammdd: "261022", entries: [{ destination: "threads_profile", at: at("08:00"), scheduled_at: at("13:00") }] });
  write("06-shorts-published.linkedin-timer.json", { aammdd: "261022", entries: [{ destination: "linkedin_profile", at: at("08:00"), scheduled_at: at("16:00") }] });
  try {
    const grid = await loadDivulgacaoGrid({}, ["2026-10-22"], () => {}, { ...noRemote, editionDir: () => dir });
    const find = (account: string) => grid.filter((s) => s.account === account).map((s) => Date.parse(s.at));
    assert.deepEqual(find("instagram:diaria"), [Date.parse(at("10:00"))]);
    assert.deepEqual(find("threads:pessoal"), [Date.parse(at("13:00"))]);
    assert.deepEqual(find("linkedin:pessoal"), [Date.parse(at("16:00"))]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("#12959: registro ilegível vira aviso e não derruba os outros", async () => {
  const dir = mkdtempSync(join(tmpdir(), "divulgacao-12959-"));
  mkdirSync(join(dir, "_internal"));
  writeFileSync(join(dir, "_internal", "06-shorts-published.json"), "{ quebrado");
  writeFileSync(join(dir, "_internal", "06-shorts-published.instagram-timer.json"), JSON.stringify({ entries: [{ destination: "instagram", at: at("08:00"), scheduled_at: at("10:00") }] }));
  const warns: string[] = [];
  try {
    const grid = await loadDivulgacaoGrid({}, ["2026-10-22"], (m) => warns.push(m), { ...noRemote, editionDir: () => dir });
    assert.equal(grid.filter((s) => s.account === "instagram:diaria").length, 1);
    assert.ok(warns.some((w) => w.includes("06-shorts-published.json") && w.includes("ilegível")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("#12959: mesmo destino em dois arquivos fica com a entrada de `at` mais recente", () => {
  const merged = unionShortsRegistryRaw([
    { entries: [{ destination: "linkedin_profile", at: at("08:00"), scheduled_at: at("16:00") }] },
    undefined,
    { entries: [{ destination: "linkedin_profile", at: at("09:00"), scheduled_at: at("17:00") }, { nope: 1 }] },
  ]);
  assert.deepEqual(merged.entries.map((e) => e.scheduled_at), [at("17:00")]);
});
