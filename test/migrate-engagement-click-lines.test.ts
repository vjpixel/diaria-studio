/**
 * migrate-engagement-click-lines.test.ts (#7460)
 *
 * Cobre a parte pura (`planFileMigration`) e o fluxo de arquivo completo (via
 * `child_process`, rodando o script de verdade sobre um `--out-dir` tmp) —
 * fixture modelada no achado real do #7181: 6 arquivos com linhas classe B
 * misturadas ao engagement canônico.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { planFileMigration, isEngagementJsonlFile } from "../scripts/migrate-engagement-click-lines.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "../scripts/migrate-engagement-click-lines.ts");

const CANONICAL = {
  subscriber_id: "7bfa5666-27a9-4b14-8d1d-2a461af241b6",
  email: "pedro@x.com",
  status: "opened",
  timestamp: "2025-09-09T12:00:33Z",
  total_clicked: 0,
  total_opened: 1,
};

const CLICK_LINE = {
  subscription_id: "sub_d0620b3e",
  email: "eduacquarone@gmail.com",
  url: "https://eia.diar.ia.br/vote?choice=B",
  url_hash: "7989819519831038341",
  clicked_at: "2026-08-29T15:01:40Z",
};

describe("isEngagementJsonlFile", () => {
  it("aceita post_<qualquercoisa>.jsonl", () => {
    assert.equal(isEngagementJsonlFile("post_048a8526-76ef-4956-ae5d-4cb42ae758b4.jsonl"), true);
  });
  it("rejeita manifest.json e arquivos que não começam com post_", () => {
    assert.equal(isEngagementJsonlFile("manifest.json"), false);
    assert.equal(isEngagementJsonlFile("readme.md"), false);
    assert.equal(isEngagementJsonlFile("post_x.json"), false, "extensão errada");
  });
});

describe("planFileMigration — puro", () => {
  it("null quando não há linha classe B (nada a migrar)", () => {
    const plan = planFileMigration("post_1", [CANONICAL, CANONICAL]);
    assert.equal(plan, null);
  });

  it("separa click-identity de canônica; conta garbage separadamente", () => {
    const plan = planFileMigration("post_1", [CANONICAL, CLICK_LINE, { subscriber_id: "s1" }]);
    assert.ok(plan);
    assert.equal(plan!.keep.length, 1);
    assert.deepEqual(plan!.keep[0], CANONICAL);
    assert.equal(plan!.clickLines.length, 1);
    assert.deepEqual(plan!.clickLines[0], CLICK_LINE);
    assert.equal(plan!.garbageLines.length, 1);
  });

  it("garbage SEM nenhuma linha classe B ainda é reportado, nunca silenciado (#7460 finding 2)", () => {
    // Antes do fix: `clickLines.length === 0` retornava `null` incondicionalmente,
    // então um arquivo só com stub/malformado (zero linha B) nunca somava em
    // totalGarbage nem disparava o aviso — contradizendo o cabeçalho do script.
    const plan = planFileMigration("post_1", [CANONICAL, { subscriber_id: "s1" }]);
    assert.ok(plan, "não deve ser null — há garbage a reportar");
    assert.equal(plan!.clickLines.length, 0);
    assert.equal(plan!.garbageLines.length, 1);
    assert.deepEqual(plan!.garbageLines[0], { subscriber_id: "s1" });
    assert.deepEqual(plan!.keep, [CANONICAL, { subscriber_id: "s1" }], "arquivo intocado — keep é rawLines inteiro, sem descartar o garbage");
  });
});

describe("migrate-engagement-click-lines.ts — fluxo de arquivo completo (reproduz o achado do #7181)", () => {
  function setupFixture() {
    const dir = mkdtempSync(join(tmpdir(), "migrate-engagement-"));
    const outDir = resolve(dir, "subscriber-engagement");
    mkdirSync(outDir, { recursive: true });
    // post_A: 2 canônicas + 2 classe B misturadas (reproduz o achado real).
    writeFileSync(
      resolve(outDir, "post_A.jsonl"),
      [CANONICAL, CLICK_LINE, { ...CANONICAL, subscriber_id: "outro" }, { ...CLICK_LINE, url_hash: "2" }]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    // post_B: só canônica, nenhuma linha B — não deve ser tocado.
    writeFileSync(resolve(outDir, "post_B.jsonl"), JSON.stringify(CANONICAL) + "\n");
    writeFileSync(
      resolve(outDir, "manifest.json"),
      JSON.stringify({
        generated_at: "2026-01-01T00:00:00Z",
        posts: [
          { post_id: "post_A", status: "ok", count: 4 },
          { post_id: "post_B", status: "ok", count: 1 },
        ],
      }),
    );
    return { outDir };
  }

  it("--dry-run não toca nenhum arquivo, só reporta o plano", () => {
    const { outDir } = setupFixture();
    const before = readFileSync(resolve(outDir, "post_A.jsonl"), "utf8");
    execFileSync(process.execPath, ["--import", "tsx", SCRIPT, "--out-dir", outDir, "--dry-run"], { encoding: "utf8" });
    const after = readFileSync(resolve(outDir, "post_A.jsonl"), "utf8");
    assert.equal(after, before, "--dry-run não altera o arquivo");
    assert.ok(!existsSync(resolve(outDir, "..", "click-subscribers")), "--dry-run não cria o diretório de destino");
  });

  it("migra de verdade: post_A perde as 2 linhas B, post_B fica intocado, click-subscribers recebe as 2 linhas", () => {
    const { outDir } = setupFixture();
    const stdout = execFileSync(process.execPath, ["--import", "tsx", SCRIPT, "--out-dir", outDir], { encoding: "utf8" });
    const report = JSON.parse(stdout);
    assert.equal(report.files_touched, 1, "só post_A tinha linha classe B");
    assert.equal(report.total_click_lines_routed, 2);
    assert.equal(report.total_garbage_lines_found, 0);

    const postALines = readFileSync(resolve(outDir, "post_A.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(postALines.length, 2, "só as 2 linhas canônicas sobraram");
    assert.ok(postALines.every((l) => !("clicked_at" in l)), "nenhuma linha B sobrou no engagement");

    const postBLines = readFileSync(resolve(outDir, "post_B.jsonl"), "utf8").trim().split("\n");
    assert.equal(postBLines.length, 1, "post_B não foi tocado");

    const clickPath = resolve(outDir, "..", "click-subscribers", "post_A.jsonl");
    assert.ok(existsSync(clickPath));
    const clickLines = readFileSync(clickPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(clickLines.length, 2);

    const manifest = JSON.parse(readFileSync(resolve(outDir, "manifest.json"), "utf8"));
    const entryA = manifest.posts.find((p: { post_id: string }) => p.post_id === "post_A");
    assert.equal(entryA.count, 2, "manifest.count corrigido pro novo total (2, não mais 4)");
    const entryB = manifest.posts.find((p: { post_id: string }) => p.post_id === "post_B");
    assert.equal(entryB.count, 1, "manifest de post_B intocado");
  });

  it("arquivo só-garbage (zero linha classe B) reporta o aviso de stub/malformado e não é reescrito (#7460 finding 2)", () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-engagement-"));
    const outDir = resolve(dir, "subscriber-engagement");
    mkdirSync(outDir, { recursive: true });
    // post_C: 1 canônica + 1 stub — ZERO linha classe B.
    const before = [CANONICAL, { subscriber_id: "s1" }].map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(resolve(outDir, "post_C.jsonl"), before);

    const stdout = execFileSync(process.execPath, ["--import", "tsx", SCRIPT, "--out-dir", outDir], { encoding: "utf8" });
    const report = JSON.parse(stdout);
    assert.equal(report.total_garbage_lines_found, 1, "garbage contado mesmo sem linha classe B");
    assert.equal(report.total_click_lines_routed, 0);

    const after = readFileSync(resolve(outDir, "post_C.jsonl"), "utf8");
    assert.equal(after, before, "arquivo só-garbage não é reescrito — nada a rotear");
  });

  it("idempotente — rodar 2x não duplica as linhas roteadas", () => {
    const { outDir } = setupFixture();
    execFileSync(process.execPath, ["--import", "tsx", SCRIPT, "--out-dir", outDir], { encoding: "utf8" });
    const secondRun = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", SCRIPT, "--out-dir", outDir], { encoding: "utf8" }));
    assert.equal(secondRun.files_touched, 0, "nada mais a migrar na 2ª rodada");

    const clickPath = resolve(outDir, "..", "click-subscribers", "post_A.jsonl");
    const clickLines = readFileSync(clickPath, "utf8").trim().split("\n");
    assert.equal(clickLines.length, 2, "sem duplicação");
  });
});
