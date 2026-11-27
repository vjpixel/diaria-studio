import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkSentinel, writeSentinel, resealSurgical } from "../scripts/check-humanizer-social.ts";
import { emptyRunRecord, planRunRecord, planClaricePending, writeRunRecord, readRunRecord } from "../scripts/lib/humanizer-run-record.ts";

it("#13929 reseals a gate edit with previous snapshot, preserves pending Clarice and rejects rewrites without mutation", () => {
  const dir = mkdtempSync(join(tmpdir(), "reseal-13929-"));
  const internal = join(dir, "_internal");
  const pre = "# Social\n## d1\nUma notícia sobre ferramentas que ajudam equipes a revisar documentos com cuidado antes de publicar suas decisões.\n\n## d1-cards\nPrimeiro parágrafo com fatos.\n\nSegundo parágrafo.\n\nTerceiro parágrafo.\n";
  const run = (reason = "editor corrigiu verbo") => spawnSync(process.execPath, ["--import", "tsx", "scripts/check-humanizer-social.ts", "--reseal-surgical", "--edition-dir", dir, "--reason", reason], { encoding: "utf8" });
  try {
    mkdirSync(internal);
    writeFileSync(join(dir, "03-social.md"), pre);
    writeFileSync(join(internal, "01-approved.json"), '{"highlights":[]}');
    // #13933: run sem mudança não prova o humanizador nem com nota — o registro sai de uma passada real (rascunho → pre).
    const draft = pre.replace("Uma notícia sobre", "Notícia de").replace("Primeiro parágrafo", "Parágrafo um");
    let record = planRunRecord(emptyRunRecord(), "humanizador", draft, pre).record;
    assert.ok(record.humanizador.length >= 2, "seed: as duas seções provadas pelo humanizador");
    record = planClaricePending(record, pre, "clarice_unavailable", { detail: "API indisponível" }).record;
    writeRunRecord(dir, record);
    writeSentinel(dir);
    writeFileSync(join(internal, "03-social-post-humanizador.md"), pre);
    const post = pre.replace("ajudam", "auxiliam");
    writeFileSync(join(dir, "03-social.md"), post);
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).changed_sections, ["main_d1"]);
    assert.equal(checkSentinel(dir).ok, true);
    assert.equal(readFileSync(join(internal, "03-social-post-humanizador.md"), "utf8"), post);
    assert.ok(readFileSync(join(internal, ".social-source-hash.json"), "utf8"));
    assert.equal(readRunRecord(dir).runs.at(-2)?.note, "reseal-surgical: editor corrigiu verbo");
    assert.equal(readRunRecord(dir).clarice_pending?.at(-1)?.detail, "API indisponível");
    const state = () => Object.fromEntries(readdirSync(internal).map((n) => [n, readFileSync(join(internal, n), "utf8")]));
    const saved = state();
    for (const content of [post.replace("Uma notícia", "Uma história completamente reescrita e com novos fatos muito diferentes"), post + "\n## um\nNovo post\n", post.replace("# Social", "# Outra coisa")]) {
      writeFileSync(join(dir, "03-social.md"), content);
      assert.equal(run().status, 1);
      assert.deepEqual(state(), saved);
    }
    writeFileSync(join(dir, "03-social.md"), post.replace("auxiliam", "ajudam"));
    assert.equal(run(" ").status, 1);
    assert.deepEqual(state(), saved);
    writeFileSync(join(internal, "03-social-post-humanizador.md"), pre);
    const badSnapshotState = state();
    assert.throws(() => resealSurgical(dir, "editor corrigiu verbo"), /snapshot anterior/);
    assert.deepEqual(state(), badSnapshotState);
    writeFileSync(join(internal, "03-social-post-humanizador.md"), post);
    rmSync(join(internal, "01-approved.json"));
    const missingApprovedState = state();
    assert.throws(() => resealSurgical(dir, "editor corrigiu verbo"), /01-approved/);
    assert.deepEqual(state(), missingApprovedState);
    writeFileSync(join(internal, "01-approved.json"), '{"highlights":[]}');
    // A previous Clarice success does not grant proof for newly edited wording.
    const complete = readRunRecord(dir);
    complete.clarice_pending = [];
    complete.clarice = [...complete.humanizador];
    writeRunRecord(dir, complete);
    const beforeRefusal = state();
    writeFileSync(join(dir, "03-social.md"), post.replace("auxiliam", "apoiam"));
    assert.equal(run().status, 1);
    assert.deepEqual(state(), beforeRefusal);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
