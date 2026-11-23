/**
 * #13856: resolver `{edition_url}` no `03-social.md` depois do selo (Stage 5/6,
 * `resolve-edition-url.ts --validate-social`) invalidava o selo do humanizador
 * (`social-humanizer-seal-fresh` voltava a acusar erro na edição 261123 sem
 * nenhuma mudança de redação).
 *
 * #13848: o social não tinha caminho oficial para "Clarice indisponível" no
 * Stage 4 — o `--write` saía `PROVA AUSENTE` e a única saída era
 * `--unproven-ok` com motivo livre. Agora `--record-clarice-pending` registra a
 * pendência (só sobre seção com prova do humanizador: o guard #11534 não relaxa),
 * o `--write` aceita, e `--provenance` + invariante `social-clarice-pending`
 * mostram no gate.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { STAGE_2_RULES } from "../scripts/lib/invariant-checks/stage-2.ts";
import { STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";
import { UnprovenSectionsError, checkSentinel, writeSentinel } from "../scripts/check-humanizer-social.ts";
import {
  emptyRunRecord,
  planClaricePending,
  planRunRecord,
  readRunRecord,
  writeRunRecord,
} from "../scripts/lib/humanizer-run-record.ts";
import { socialMatchesSealHash } from "../scripts/lib/humanizer-social-seal.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "check-humanizer-social.ts");
const URL = "https://diar.ia.br/p/anthropic-estreia-na-bolsa-e-levanta-us-119-5-bi";

const sealFresh = STAGE_4_RULES.find((r) => r.id === "social-humanizer-seal-fresh")!;
const claricePendingRule = STAGE_4_RULES.find((r) => r.id === "social-clarice-pending")!;
const provenanceRule = STAGE_2_RULES.find((r) => r.id === "social-humanizer-provenance-recorded")!;

// Forma da 261123: o placeholder só no `# Curto`, fora das seções selo-por-seção.
const SOCIAL =
  "# Social\n\n## d1\nTexto um.\n\n## d2\nTexto dois.\n\n## d3\nTexto três.\n\n" +
  "# Curto\n\n## d1\nCurto um.\nMais em {edition_url}\n\n## d2\nCurto dois.\nMais em {edition_url}\n";

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], { encoding: "utf8", cwd: ROOT });
}

function newEdition(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

/** Social humanizado + Clarice nas 3 seções e selado, com `{edition_url}` ainda literal. */
function sealedEdition(): string {
  const dir = newEdition("humanizer-13856-");
  const humanized = SOCIAL.replace("Texto um.", "Texto um h.").replace("Texto dois.", "Texto dois h.").replace("Texto três.", "Texto três h.");
  const final = humanized.replace("Texto um h.", "Texto um hc.").replace("Texto dois h.", "Texto dois hc.").replace("Texto três h.", "Texto três hc.");
  const h = planRunRecord(emptyRunRecord(), "humanizador", SOCIAL, humanized);
  const c = planRunRecord(h.record, "clarice", humanized, final);
  writeRunRecord(dir, c.record);
  writeFileSync(join(dir, "03-social.md"), final);
  writeSentinel(dir);
  return dir;
}

/** O que o `resolve-edition-url.ts --validate-social` faz: grava a URL e reescreve o social. */
function resolveEditionUrl(dir: string, url = URL): void {
  writeFileSync(join(dir, "_internal", "05-edition-url.txt"), url + "\n");
  const p = join(dir, "03-social.md");
  writeFileSync(p, readFileSync(p, "utf8").replaceAll("{edition_url}", url));
}

describe("#13856: {edition_url} resolvido depois do selo não invalida o selo do humanizador", () => {
  it("cenário 261123: selo fresco depois da resolução da URL (invariante sem erro)", () => {
    const dir = sealedEdition();
    try {
      resolveEditionUrl(dir);
      assert.ok(readFileSync(join(dir, "03-social.md"), "utf8").includes(`Mais em ${URL}`));
      assert.deepEqual(checkSentinel(dir), { ok: true });
      assert.deepEqual(sealFresh.run(dir), []);
      const r = runCli(["--check", "--edition-dir", dir]);
      assert.equal(r.status, 0, r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--write sem --bypass-reason depois da resolução passa (não é edição pós-humanização)", () => {
    const dir = sealedEdition();
    try {
      resolveEditionUrl(dir);
      assert.doesNotThrow(() => writeSentinel(dir));
      assert.deepEqual(checkSentinel(dir), { ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fail-closed: sem _internal/05-edition-url.txt a URL resolvida continua divergindo", () => {
    const dir = sealedEdition();
    try {
      const p = join(dir, "03-social.md");
      writeFileSync(p, readFileSync(p, "utf8").replaceAll("{edition_url}", URL));
      const res = checkSentinel(dir);
      assert.equal(res.ok, false);
      assert.equal(sealFresh.run(dir)[0]?.severity, "error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mudança de redação junto com a URL resolvida continua acusando", () => {
    const dir = sealedEdition();
    try {
      resolveEditionUrl(dir);
      const p = join(dir, "03-social.md");
      writeFileSync(p, readFileSync(p, "utf8").replace("Curto um.", "Curto um reescrito."));
      assert.equal(checkSentinel(dir).ok, false);
      assert.equal(sealFresh.run(dir).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("URL de destino do marcador de transição (#11751) também é revertida", () => {
    const dir = sealedEdition();
    try {
      const other = "https://diar.ia.br/p/outro-slug";
      writeFileSync(join(dir, "_internal", "05-edition-url.txt"), URL + "\n");
      writeFileSync(join(dir, "_internal", "05-edition-url.transition.json"), JSON.stringify({ to: other }) + "\n");
      const p = join(dir, "03-social.md");
      writeFileSync(p, readFileSync(p, "utf8").replaceAll("{edition_url}", other));
      assert.deepEqual(checkSentinel(dir), { ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("socialMatchesSealHash: só a URL exata da edição é revertida", () => {
    const sealed = "a {edition_url} b";
    const h = createHash("sha256").update(sealed).digest("hex");
    assert.equal(socialMatchesSealHash(h, `a ${URL} b`, [URL]), true);
    assert.equal(socialMatchesSealHash(h, "a https://diar.ia.br/p/outra b", [URL]), false);
    assert.equal(socialMatchesSealHash(h, `a ${URL} b`, []), false);
  });
});

/** Selo do Stage 2 nas 3 seções; no gate o D3 é reescrito e humanizado, e a Clarice cai. */
function d3RewrittenWithoutClarice(): string {
  const dir = sealedEdition();
  const p = join(dir, "03-social.md");
  const before = readFileSync(p, "utf8");
  const edited = before.replace("Texto três hc.", "Texto três reescrito no gate.");
  const humanized = edited.replace("Texto três reescrito no gate.", "Texto três reescrito e humanizado.");
  const h = planRunRecord(readRunRecord(dir), "humanizador", edited, humanized, ["main_d3"]);
  writeRunRecord(dir, h.record);
  writeFileSync(p, humanized);
  return dir;
}

describe("#13848: caminho oficial para 'Clarice indisponível' no social do Stage 4", () => {
  it("sem pendência: --write --bypass-reason segue PROVA AUSENTE (exit 4) — o guard não relaxou", () => {
    const dir = d3RewrittenWithoutClarice();
    try {
      assert.throws(() => writeSentinel(dir, "ajuste D3 no gate"), (e: unknown) => {
        assert.ok(e instanceof UnprovenSectionsError);
        assert.deepEqual(e.sections, ["main_d3"]);
        return true;
      });
      const r = runCli(["--write", "--bypass-reason", "ajuste D3 no gate", "--edition-dir", dir]);
      assert.equal(r.status, 4, r.stderr);
      assert.match(r.stderr, /--record-clarice-pending/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("regressão do --write com Clarice pendente: registra, sela, mostra no --provenance e no gate", () => {
    const dir = d3RewrittenWithoutClarice();
    try {
      const rec = runCli([
        "--record-clarice-pending", "--reason", "clarice_unavailable",
        "--detail", "REST exit 3, timeout de 60s", "--sections", "d3", "--edition-dir", dir,
      ]);
      assert.equal(rec.status, 0, rec.stderr);
      assert.deepEqual(JSON.parse(rec.stdout.trim().split("\n").pop()!).recorded, ["main_d3"]);

      const w = runCli(["--write", "--bypass-reason", "ajuste D3 no gate", "--edition-dir", dir]);
      assert.equal(w.status, 0, w.stderr);
      const out = JSON.parse(w.stdout.trim().split("\n").pop()!);
      assert.deepEqual(out.clarice_pending_sections, ["main_d3"]);
      assert.equal(out.unproven_sections, undefined, "não é --unproven-ok");

      const prov = runCli(["--provenance", "--edition-dir", dir]);
      assert.equal(prov.status, 0, prov.stderr);
      assert.match(prov.stderr, /main_d3: humanizador sim · Clarice PENDENTE \(clarice_unavailable: REST exit 3, timeout de 60s\)/);
      assert.match(prov.stderr, /main_d1: humanizador sim · Clarice sim/);
      assert.deepEqual(JSON.parse(prov.stdout.trim()).clarice_pending_sections, ["main_d3"]);

      assert.deepEqual(sealFresh.run(dir), []);
      const gate = claricePendingRule.run(dir);
      assert.equal(gate.length, 1);
      assert.equal(gate[0].severity, "warning");
      assert.match(gate[0].message, /main_d3: Clarice não rodou no social \(clarice_unavailable: REST exit 3, timeout de 60s\)/);

      const s2 = provenanceRule.run(dir).filter((v) => v.message.startsWith("main_d3"));
      assert.equal(s2.length, 1);
      assert.equal(s2[0].severity, "warning", "pendência registrada não é erro no Stage 2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("seção sem prova do humanizador não recebe pendência (exit 1, nada gravado)", () => {
    const dir = sealedEdition();
    try {
      const p = join(dir, "03-social.md");
      writeFileSync(p, readFileSync(p, "utf8").replace("Texto dois hc.", "Texto dois editado sem humanizador."));
      const before = readFileSync(join(dir, "_internal", ".humanizer-run.json"), "utf8");
      const r = runCli(["--record-clarice-pending", "--reason", "clarice_unavailable", "--sections", "d2", "--edition-dir", dir]);
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /sem prova do humanizador/);
      assert.equal(readFileSync(join(dir, "_internal", ".humanizer-run.json"), "utf8"), before, "registro intocado");
      assert.throws(() => writeSentinel(dir, "editei o D2"), UnprovenSectionsError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("motivo fora do vocabulário é recusado (não vira --unproven-ok com motivo livre)", () => {
    const dir = d3RewrittenWithoutClarice();
    try {
      const r = runCli(["--record-clarice-pending", "--reason", "deu ruim", "--edition-dir", dir]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /clarice_unavailable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Clarice de volta: --record-run --step clarice troca a pendência pela prova", () => {
    const dir = d3RewrittenWithoutClarice();
    try {
      const p = join(dir, "03-social.md");
      const humanized = readFileSync(p, "utf8");
      const plan = planClaricePending(readRunRecord(dir), humanized, "clarice_unavailable");
      assert.deepEqual(plan.recorded, ["main_d3"]);
      writeRunRecord(dir, plan.record);
      writeSentinel(dir, "ajuste D3 no gate");
      assert.equal(claricePendingRule.run(dir).length, 1);

      const corrected = humanized.replace("Texto três reescrito e humanizado.", "Texto três reescrito e humanizado, revisado.");
      const c = planRunRecord(readRunRecord(dir), "clarice", humanized, corrected, ["main_d3"]);
      writeRunRecord(dir, c.record);
      writeFileSync(p, corrected);
      writeSentinel(dir, "Clarice voltou e rodou no D3");
      assert.deepEqual(claricePendingRule.run(dir), []);
      assert.deepEqual(sealFresh.run(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
