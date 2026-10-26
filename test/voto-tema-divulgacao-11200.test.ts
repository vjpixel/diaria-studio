import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildVotoBox, boxExpiry, updateVotoBox, validateVotoCopy, VOTO_BOX } from "../scripts/update-voto-tema-box.ts";
import { addNewVoters } from "../scripts/voto-tema-open.ts";
import { eleitorHash, type BallotTema } from "../workers/artigos/src/voto-tema-core.ts";
const input = { titulo: "Escolha", prazo: "2099-11-27T23:59:00-03:00", opcoes: [
  { n: 1, titulo: "Trabalho e IA", descricao: "A" }, { n: 2, titulo: "Educação", descricao: "B" },
] };
test("caixa usa cédula, níveis novos, UTM e validade conservadora em Brasília", () => {
  const box = buildVotoBox("9911", input);
  validateVotoCopy(box, input);
  assert.equal(boxExpiry(input.prazo), "2099-11-26");
  assert.equal(boxExpiry("2099-11-28T01:00:00Z"), "2099-11-26");
  assert.throws(() => validateVotoCopy(box + " R$25", input));
  assert.throws(() => validateVotoCopy(box.replace("Educação", "Outro tema"), input));
});
test("claim, reexecução, expiração e arquivamento preservam fallback e pin alheio", () => {
  const root = mkdtempSync(resolve(tmpdir(), "voto-box-"));
  try {
    const dir = resolve(root, "data/artigo-especial/votacao/9911");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "ballot.json"), JSON.stringify(input));
    writeFileSync(resolve(root, "platform.config.json"), JSON.stringify({ boxes_divulgacao: { slot1: "amazon.md", slot2: "outra.md" }, boxes_divulgacao_auto: { pinned_slots: [2] } }, null, 2));
    const copy = resolve(root, "copy.md");
    writeFileSync(copy, buildVotoBox("9911", input));
    const opts = { root, ciclo: "9911", copy, now: new Date("2099-11-26T12:00:00Z") };
    assert.match(updateVotoBox(opts), /AVISO/);
    assert.equal(existsSync(resolve(root, "data/snippets", VOTO_BOX)), false);
    updateVotoBox({ ...opts, push: true });
    updateVotoBox({ ...opts, push: true });
    assert.throws(() => updateVotoBox({ ...opts, ciclo: "9912", push: true }), /reivindicada/);
    assert.throws(() => updateVotoBox({ ...opts, now: new Date("2100-01-01") }), /encerrado/);
    updateVotoBox({ ...opts, archive: true, push: true });
    const config = JSON.parse(readFileSync(resolve(root, "platform.config.json"), "utf8"));
    assert.equal(config.boxes_divulgacao.slot1, "amazon.md");
    assert.deepEqual(config.boxes_divulgacao_auto.pinned_slots, [2]);
    assert.ok(existsSync(resolve(root, "data/snippets/_arquivo/9911-" + VOTO_BOX)));
    updateVotoBox({ ...opts, push: true });
    config.boxes_divulgacao.slot1 = "manual.md";
    config.boxes_divulgacao_auto.pinned_slots = [1, 2];
    writeFileSync(resolve(root, "platform.config.json"), JSON.stringify(config));
    updateVotoBox({ ...opts, archive: true, push: true });
    assert.deepEqual(JSON.parse(readFileSync(resolve(root, "platform.config.json"), "utf8")), config);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("incremental preserva cédula, não repatcheia antigos e é idempotente", async () => {
  let ballot: BallotTema = { ...input, eleitores: [await eleitorHash("old@example.com")], aberta_em: "2099-01-01" };
  const original = structuredClone(ballot);
  const prepared: string[] = [];
  const deps = {
    read: async () => structuredClone(ballot), closed: async () => false,
    members: async () => [{ id: 1, email: "old@example.com" }, { id: 2, email: "new@example.com" }],
    prepare: async (m: { email: string }) => { prepared.push(m.email); },
    write: async (b: BallotTema) => { ballot = b; }, now: () => new Date("2099-11-01"),
  };
  assert.equal(await addNewVoters(deps), 1);
  assert.deepEqual(prepared, ["new@example.com"]);
  assert.deepEqual({ ...ballot, eleitores: original.eleitores }, original);
  assert.equal(await addNewVoters(deps), 0);
  await assert.rejects(addNewVoters({ ...deps, closed: async () => true }), /fechado/);
  await assert.rejects(addNewVoters({ ...deps, now: () => new Date("2100-01-01") }), /fechado/);
});
test("falha de token, fechamento no meio e concorrência nunca gravam cédula", async () => {
  const ballot: BallotTema = { ...input, eleitores: [], aberta_em: "2099-01-01" };
  let writes = 0;
  let closed = false;
  const deps = {
    read: async () => structuredClone(ballot), closed: async () => closed,
    members: async () => [{ id: 1, email: "new@example.com" }],
    prepare: async () => { throw new Error("Kit indisponível"); },
    write: async () => { writes++; }, now: () => new Date("2099-11-01"),
  };
  await assert.rejects(addNewVoters(deps), /Kit indisponível/);
  await assert.rejects(addNewVoters({ ...deps, prepare: async () => { closed = true; } }), /fechado/);
  closed = false;
  let reads = 0;
  await assert.rejects(addNewVoters({ ...deps, prepare: async () => {}, read: async () => ++reads === 1 ? ballot : { ...ballot, fecha_em: "2099-11-01" } }), /mudou/);
  assert.equal(writes, 0);
});
