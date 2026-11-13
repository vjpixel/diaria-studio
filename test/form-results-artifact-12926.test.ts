import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { renderFormResultsArtifact, writeFormResultsArtifact } from "../scripts/form-results-artifact.ts";
import { buildFormPartialResults } from "../scripts/lib/onboarding-form-partial-results.ts";
import { FORM_VERSION, FORM_CONVERSA_SIM } from "../scripts/lib/onboarding-form-contract.ts";

const snapshot = {
  available: true as const, storeLido: false, geradoEm: "2026-11-13T01:02:03.000Z",
  ...buildFormPartialResults([
    { email: "private@example.com", submitted_at: "2026-11-12T12:00:00Z", form_version: FORM_VERSION, answers: { relato_falha: "<script>alert(1)</script> contato outra@example.com", conversa: FORM_CONVERSA_SIM } },
    { email: "second@example.com", submitted_at: "2026-11-12T13:00:00Z", form_version: FORM_VERSION, answers: { relato_falha: "Um relato sobre Nome Terceiro" } },
  ]),
};
it("HTML completo com data da foto, contagens, barras e textos seguros, sem contatos", () => {
  const html = renderFormResultsArtifact(snapshot, ["nome terceiro"]);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /2026-11-13T01:02:03.000Z/);
  assert.match(html, /2 respondentes/);
  assert.match(html, /Toparam conversar: 1/);
  assert.match(html, /<meter/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|@|Nome Terceiro/);
  assert.match(html, /1 relatos omitidos/);
  assert.match(html, /Store do onboarding não lido/);
});
it("omite vários filtros e recusa filtros vazios ou leitura indisponível", () => {
  const html = renderFormResultsArtifact(snapshot, ["nome terceiro", "CONTATO"]);
  assert.match(html, /2 relatos omitidos/);
  assert.match(html, /Nenhuma resposta aberta para exibir/);
  assert.throws(() => renderFormResultsArtifact(snapshot, [" "]), /Filtro de relato vazio/);
  assert.throws(() => renderFormResultsArtifact({ available: false, motivo: "Worker fora", geradoEm: snapshot.geradoEm }), /Worker fora/);
});
it("sem respostas não produz NaN nem Infinity", () => {
  const html = renderFormResultsArtifact({ available: true, geradoEm: snapshot.geradoEm, storeLido: false, ...buildFormPartialResults([]) });
  assert.match(html, /0 respondentes/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});
it("gera arquivo da leitura fresca e preserva arquivo anterior quando o Worker falha", async () => {
  const root = mkdtempSync(join(tmpdir(), "artifact-12926-"));
  try {
    writeFileSync(join(root, "platform.config.json"), JSON.stringify({ onboarding: { followup: { form_responses_url: "https://example.com/api/respostas" } } }));
    const output = join(root, "out", "results.html");
    let calls = 0;
    await writeFormResultsArtifact(root, output, [], { fetchResponses: async () => { calls++; return []; }, now: () => new Date(snapshot.geradoEm) });
    const html = readFileSync(output, "utf8");
    assert.equal(calls, 1);
    assert.match(html, /0 respondentes/);
    assert.match(html, /2026-11-13T01:02:03.000Z/);
    await assert.rejects(writeFormResultsArtifact(root, output, [], { fetchResponses: async () => { throw new Error("HTTP 503"); } }), /HTTP 503/);
    assert.equal(readFileSync(output, "utf8"), html);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("CLI help e flags inválidas saem sem buscar respostas ou gravar", () => {
  const script = "scripts/form-results-artifact.ts";
  const help = execFileSync(process.execPath, ["--import", "tsx", script, "--help"], { encoding: "utf8" });
  assert.match(help, /--exclude-open-text/);
  for (const argv of [["--output"], ["--bogus"], ["--exclude-open-text="]]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", script, ...argv], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /Artefato gravado/);
  }
});
