/** Regressão #11698: Stage 5 adquire edition-lock e é fail-closed com edição defasada. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkStage5Freshness, computeOutputHashes } from "../scripts/lib/stage5-freshness.ts";
import { acquireEditionLock } from "../scripts/lib/edition-lock.ts";

const DONE = Date.parse("2026-10-30T20:00:00Z");

function edition(opts: { skip?: string[]; sentinel?: boolean } = {}): string {
  const d = mkdtempSync(join(tmpdir(), "s5fresh-"));
  mkdirSync(join(d, "_internal"));
  const t = new Date(DONE - 60_000);
  for (const f of ["02-reviewed.md", "03-social.md", "06-public-images.json"]) {
    if (opts.skip?.includes(f)) continue;
    writeFileSync(join(d, f), "x");
    utimesSync(join(d, f), t, t);
  }
  if (opts.sentinel !== false) {
    writeFileSync(
      join(d, "_internal", ".step-4-done.json"),
      JSON.stringify({ outputs: ["02-reviewed.md", "03-social.md"], completed_at: new Date(DONE).toISOString() }),
    );
  }
  return d;
}

describe("checkStage5Freshness (#11698)", () => {
  it("edição consistente → ok", () => {
    assert.equal(checkStage5Freshness(edition()).ok, true);
  });
  it("sentinel chegou antes dos arquivos → fail-closed", () => {
    const r = checkStage5Freshness(edition({ skip: ["03-social.md"] }));
    assert.equal(r.ok, false);
    assert.match(r.problems.join(), /03-social\.md: ausente/);
  });
  it("sem sentinel → fail-closed", () => {
    assert.equal(checkStage5Freshness(edition({ sentinel: false })).ok, false);
  });
  it("output mais novo que o sentinel → fail-closed", () => {
    const d = edition();
    const t = new Date(DONE + 3600_000);
    utimesSync(join(d, "02-reviewed.md"), t, t);
    assert.match(checkStage5Freshness(d).problems.join(), /modificado após o sentinel/);
  });
  it("cópia de conflito do OneDrive → fail-closed", () => {
    const d = edition();
    writeFileSync(join(d, "02-reviewed-NEO.md"), "y");
    assert.match(checkStage5Freshness(d).problems.join(), /conflito/);
  });
  it("retomada: 06-public-images.json mais novo que o sentinel → ok", () => {
    const d = edition();
    const t = new Date(DONE + 3600_000);
    utimesSync(join(d, "06-public-images.json"), t, t);
    assert.equal(checkStage5Freshness(d).ok, true);
  });
  it("retomada: 03-social.md regravado pelo Stage 5 (mtime pós-sentinel) → ok (P1 review)", () => {
    const d = edition();
    const t = new Date(DONE + 3600_000);
    utimesSync(join(d, "03-social.md"), t, t);
    assert.equal(checkStage5Freshness(d).ok, true);
  });
  it("03-social.md vazio ainda bloqueia", () => {
    const d = edition();
    writeFileSync(join(d, "03-social.md"), "");
    assert.equal(checkStage5Freshness(d).ok, false);
  });
  it("--accept-newer: edição pós-gate liberada; ausente continua bloqueando", () => {
    const d = edition();
    const t = new Date(DONE + 3600_000);
    utimesSync(join(d, "02-reviewed.md"), t, t);
    assert.equal(checkStage5Freshness(d).ok, false);
    assert.equal(checkStage5Freshness(d, { acceptNewer: true }).ok, true);
    const e = edition({ skip: ["02-reviewed.md"] });
    assert.equal(checkStage5Freshness(e, { acceptNewer: true }).ok, false);
  });
  for (const name of [
    "02-reviewed-predator-safeBackup-0001.md",
    "02-reviewed-NEO-safeBackup-0001.md",
    "02-reviewed-neo.md",
    "02-reviewed.md.tmp",
    "02-reviewed-NEO.md",
  ]) {
    it(`conflito OneDrive real detectado: ${name} (P2 review)`, () => {
      const d = edition();
      writeFileSync(join(d, name), "y");
      assert.match(checkStage5Freshness(d).problems.join(), /conflito/);
    });
  }
  it("irmão legítimo 02-reviewed-final.md não é conflito", () => {
    const d = edition();
    writeFileSync(join(d, "02-reviewed-final.md"), "y");
    assert.equal(checkStage5Freshness(d).ok, true);
  });
  it("irmão legítimo 03-social-pre-humanizador.md não é conflito", () => {
    const d = edition();
    writeFileSync(join(d, "03-social-pre-humanizador.md"), "y");
    assert.equal(checkStage5Freshness(d).ok, true);
  });
  it("sentinel sem completed_at → fail-closed", () => {
    const d = edition();
    writeFileSync(join(d, "_internal", ".step-4-done.json"), JSON.stringify({ outputs: [] }));
    assert.equal(checkStage5Freshness(d).ok, false);
  });
  it("não altera arquivos", () => {
    const d = edition();
    checkStage5Freshness(d);
    assert.equal(readFileSync(join(d, "02-reviewed.md"), "utf8"), "x");
  });
});

describe("Stage 5 e edition-lock (#11698)", () => {
  it("segunda sessão recebe held_by_other no Stage 5", () => {
    const d = edition();
    acquireEditionLock(d, { sessionId: "A", stage: 5 });
    assert.equal(acquireEditionLock(d, { sessionId: "B", stage: 5 }).action, "held_by_other");
  });
  it("playbook do Stage 5 chama acquire e freshness", () => {
    const md = readFileSync(new URL("../.claude/agents/orchestrator-stage-5.md", import.meta.url), "utf8");
    assert.match(md, /edition-lock\.ts acquire --edition-dir \{EDITION_DIR\} --stage 5/);
    assert.match(md, /stage5-freshness\.ts/);
  });
});

describe("sha256 dos outputs no sentinel (#11698 P1)", () => {
  function hashed(): string {
    const d = edition();
    const outs = ["02-reviewed.md", "03-social.md"];
    writeFileSync(
      join(d, "_internal", ".step-4-done.json"),
      JSON.stringify({ outputs: outs, completed_at: new Date(DONE).toISOString(), output_hashes: computeOutputHashes(d, outs) }),
    );
    return d;
  }
  it("cópia pré-gate com mtime antigo (sentinel chegou antes) → bloqueia", () => {
    const d = hashed();
    writeFileSync(join(d, "02-reviewed.md"), "versao pre-gate");
    const t = new Date(DONE - 3600_000);
    utimesSync(join(d, "02-reviewed.md"), t, t);
    const r = checkStage5Freshness(d);
    assert.equal(r.ok, false);
    assert.match(r.problems.join(), /02-reviewed\.md: conteúdo difere/);
  });
  it("playbook libera --accept-newer para a mensagem real de sha256 e para a de mtime (#11698)", () => {
    const md = readFileSync(new URL("../.claude/agents/orchestrator-stage-5.md", import.meta.url), "utf8");
    const strip = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const d = hashed();
    writeFileSync(join(d, "02-reviewed.md"), "editado no Studio depois do gate");
    const shaMsg = checkStage5Freshness(d).problems[0].replace(/^[^:]+: /, "").replace(/ — .*$/, "");
    assert.match(shaMsg, /conteúdo difere do aprovado no gate 4 \(sha256\)/);
    assert.ok(strip(md).includes(strip(shaMsg)), `playbook não cobre: ${shaMsg}`);
    assert.match(md, /"modificado apos o sentinel"/);
  });
  it("conteúdo igual → ok, sem warning", () => {
    assert.deepEqual(checkStage5Freshness(hashed()), { ok: true, problems: [] });
  });
  it("03-social.md com {edition_url} resolvida pelo Stage 5 → ok (retomada)", () => {
    const d = edition();
    const outs = ["02-reviewed.md", "03-social.md"];
    writeFileSync(join(d, "03-social.md"), "leia {edition_url} agora");
    writeFileSync(
      join(d, "_internal", ".step-4-done.json"),
      JSON.stringify({ outputs: outs, completed_at: new Date(DONE).toISOString(), output_hashes: computeOutputHashes(d, outs) }),
    );
    writeFileSync(join(d, "03-social.md"), "leia https://diar.ia.br/p/abc-123 agora");
    assert.equal(checkStage5Freshness(d).ok, true);
  });
  it("03-social.md com {edition_url} seguido de pontuação, resolvida pelo Stage 5 → ok (P2 review)", () => {
    const d = edition();
    const outs = ["02-reviewed.md", "03-social.md"];
    writeFileSync(join(d, "03-social.md"), "em {edition_url}. Mas {edition_url}, veja ({edition_url}) e {edition_url}");
    writeFileSync(
      join(d, "_internal", ".step-4-done.json"),
      JSON.stringify({ outputs: outs, completed_at: new Date(DONE).toISOString(), output_hashes: computeOutputHashes(d, outs) }),
    );
    writeFileSync(
      join(d, "03-social.md"),
      "em https://diar.ia.br/p/abc-123. Mas https://diar.ia.br/p/abc-123, veja (https://diar.ia.br/p/abc-123) e https://diar.ia.br/p/abc-123",
    );
    assert.equal(checkStage5Freshness(d).ok, true);
  });
  it("03-social.md alterado de verdade (outra máquina/edição) → bloqueia; --accept-newer libera", () => {
    const d = hashed();
    writeFileSync(join(d, "03-social.md"), "texto diferente");
    assert.equal(checkStage5Freshness(d).ok, false);
    assert.equal(checkStage5Freshness(d, { acceptNewer: true }).ok, true);
  });
  it("sentinel antigo sem hashes → compat: ok com warning", () => {
    const r = checkStage5Freshness(edition());
    assert.equal(r.ok, true);
  });
  it("sentinel antigo sem hashes devolve warning explícito", () => {
    const d = edition();
    const r = checkStage5Freshness(d);
    assert.equal(r.ok, true);
    assert.match((r.warnings ?? []).join(), /sem output_hashes/);
  });
  it("outputs vazio/inválido: 02-reviewed e 03-social seguem vigiados", () => {
    const d = edition({ skip: ["02-reviewed.md"] });
    writeFileSync(join(d, "_internal", ".step-4-done.json"), JSON.stringify({ outputs: [], completed_at: new Date(DONE).toISOString() }));
    assert.match(checkStage5Freshness(d).problems.join(), /02-reviewed\.md: ausente/);
    writeFileSync(join(d, "_internal", ".step-4-done.json"), JSON.stringify({ outputs: "02-reviewed.md", completed_at: new Date(DONE).toISOString() }));
    assert.match(checkStage5Freshness(d).problems.join(), /outputs. inválido/);
  });
});

describe("CLI stage5-freshness fail-closed (#11698)", () => {
  const run = (...a: string[]) => spawnSync("npx", ["tsx", "scripts/stage5-freshness.ts", ...a], { encoding: "utf8" });
  it("edição defasada → exit 4", () => {
    assert.equal(run("--edition-dir", edition({ skip: ["03-social.md"] })).status, 4);
  });
  it("erro de leitura (edition-dir inexistente) → exit 4, não exceção", () => {
    const r = run("--edition-dir", "/nonexistent-dir-11698");
    assert.equal(r.status, 4);
    assert.match(r.stdout, /"ok":false/);
  });
  it("sem --edition-dir → exit 2 (playbook: qualquer exit != 0 é halt)", () => {
    assert.equal(run().status, 2);
  });
});
