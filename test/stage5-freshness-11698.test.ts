/**
 * #11698 — Etapa 5 sem coordenação entre hosts podia despachar estado defasado.
 *
 * Dois hosts são simulados com dois diretórios de edição; o "sync do OneDrive"
 * é uma cópia de arquivo, na ordem que o teste escolhe. Sem rede, sem relógio
 * real (o `now` da trava é injetado).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeOutputHashes, readSentinel, sentinelExists, sha256Hex, writeSentinel } from "../scripts/lib/pipeline-state.ts";
import { OUTPUT_HASHES_REQUIRED_SINCE, checkStage5Freshness } from "../scripts/lib/stage5-freshness.ts";
import { runStage5Freshness } from "../scripts/stage5-freshness.ts";
import { acquireEditionLock, readEditionLock, releaseEditionLock } from "../scripts/lib/edition-lock.ts";
import { assessStaleEdition } from "../scripts/lib/stale-edition-guard.ts";

const OUTPUTS = ["02-reviewed.md", "03-social.md"];
const URL = "https://diar.ia.br/p/titulo-do-d1";

function editionDir(prefix = "s5f-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

function put(dir: string, rel: string, content: string): void {
  writeFileSync(join(dir, rel), content, "utf8");
}

/** "Sync do OneDrive": copia um arquivo de um host para o outro. */
function sync(from: string, to: string, rel: string): void {
  mkdirSync(join(to, "_internal"), { recursive: true });
  copyFileSync(join(from, rel), join(to, rel));
}

/** Host A: edição pré-gate copiada para B, depois gate 4 ajusta os dois arquivos e grava o sentinel. */
function twoHostsAfterGate(): { a: string; b: string } {
  const a = editionDir("s5f-a-");
  const b = editionDir("s5f-b-");
  put(a, "02-reviewed.md", "# D1\nTexto pré-gate\n");
  put(a, "03-social.md", "## d1\nPost pré-gate {edition_url}\n");
  for (const rel of OUTPUTS) sync(a, b, rel);
  put(a, "02-reviewed.md", "# D1\nTexto APROVADO no gate\n");
  put(a, "03-social.md", "## d1\nPost aprovado. Mais em {edition_url}.\n");
  writeSentinel(a, 4, OUTPUTS);
  return { a, b };
}

describe("#11698 — sentinel grava o hash dos outputs", () => {
  it("output_hashes = sha256 do conteúdo no instante do write; output ausente fica fora", () => {
    const dir = editionDir();
    put(dir, "02-reviewed.md", "abc");
    writeSentinel(dir, 4, ["02-reviewed.md", "nao-existe.md"]);
    const s = readSentinel(dir, 4);
    assert.deepEqual(s?.output_hashes, { "02-reviewed.md": sha256Hex("abc") });
    assert.deepEqual(computeOutputHashes(dir, ["02-reviewed.md"]), { "02-reviewed.md": sha256Hex("abc") });
  });
});

describe("#11698 — frescor do conteúdo entre hosts (sync fora de ordem)", () => {
  it("sentinel chega antes da versão aprovada: cópia pré-gate que já existia no host é bloqueada pelo hash", () => {
    const { a, b } = twoHostsAfterGate();
    sync(a, b, "_internal/.step-4-done.json"); // só o sentinel chegou
    const r = checkStage5Freshness(b);
    assert.equal(r.ok, false);
    assert.deepEqual(
      r.problems.map((p) => [p.file, p.kind]),
      [["02-reviewed.md", "diverged"], ["03-social.md", "diverged"]],
    );
  });

  it("só um dos arquivos sincronizou: o outro segue bloqueando", () => {
    const { a, b } = twoHostsAfterGate();
    sync(a, b, "_internal/.step-4-done.json");
    sync(a, b, "02-reviewed.md");
    const r = checkStage5Freshness(b);
    assert.deepEqual(r.problems.map((p) => p.file), ["03-social.md"]);
  });

  it("tudo sincronizado: ok nos dois hosts", () => {
    const { a, b } = twoHostsAfterGate();
    for (const rel of [...OUTPUTS, "_internal/.step-4-done.json"]) sync(a, b, rel);
    const ok = { ok: true, verification: "verified", problems: [], warnings: [] };
    assert.deepEqual(checkStage5Freshness(a), ok);
    assert.deepEqual(checkStage5Freshness(b), ok);
  });
});

describe("#11698 — retomada depois do §5c-2 (03-social.md com a URL resolvida)", () => {
  it("URL exata de 05-edition-url.txt volta a {edition_url}, inclusive seguida de pontuação", () => {
    const { a } = twoHostsAfterGate();
    put(a, "_internal/05-edition-url.txt", URL + "\n");
    put(a, "03-social.md", `## d1\nPost aprovado. Mais em ${URL}.\n`);
    assert.equal(checkStage5Freshness(a).ok, true);
  });

  it("sem 05-edition-url.txt, a versão resolvida não casa (fail-closed)", () => {
    const { a } = twoHostsAfterGate();
    put(a, "03-social.md", `## d1\nPost aprovado. Mais em ${URL}.\n`);
    assert.equal(checkStage5Freshness(a).ok, false);
  });

  it("outra mudança além da URL continua aparecendo", () => {
    const { a } = twoHostsAfterGate();
    put(a, "_internal/05-edition-url.txt", URL);
    put(a, "03-social.md", `## d1\nPost EDITADO. Mais em ${URL}.\n`);
    assert.equal(checkStage5Freshness(a).ok, false);
  });

  it("URL resolvida é prefixo de outro link próprio do texto: a reversão o corrompe e bloqueia (falha fechada)", () => {
    const dir = editionDir();
    put(dir, "02-reviewed.md", "x");
    put(dir, "03-social.md", `Mais em {edition_url} e ${URL}-parte-2\n`);
    writeSentinel(dir, 4, OUTPUTS);
    put(dir, "_internal/05-edition-url.txt", URL);
    put(dir, "03-social.md", `Mais em ${URL} e ${URL}-parte-2\n`);
    const r = checkStage5Freshness(dir);
    assert.deepEqual(r.problems.map((p) => [p.file, p.kind]), [["03-social.md", "diverged"]]);
  });

  it("02-reviewed.md não ganha a reversão de URL", () => {
    const dir = editionDir();
    put(dir, "02-reviewed.md", "Leia {edition_url}");
    put(dir, "03-social.md", "x");
    writeSentinel(dir, 4, OUTPUTS);
    put(dir, "_internal/05-edition-url.txt", URL);
    put(dir, "02-reviewed.md", `Leia ${URL}`);
    assert.equal(checkStage5Freshness(dir).ok, false);
  });
});

describe("#11698 — fail-closed nos casos degenerados", () => {
  it("sentinel ausente ou ilegível bloqueia", () => {
    const dir = editionDir();
    put(dir, "02-reviewed.md", "x");
    put(dir, "03-social.md", "x");
    assert.equal(checkStage5Freshness(dir).ok, false);
    put(dir, "_internal/.step-4-done.json", "{truncado");
    assert.equal(checkStage5Freshness(dir).problems[0].kind, "sentinel_unreadable");
  });

  it("outputs vazio no sentinel não tira 02-reviewed.md/03-social.md da conferência", () => {
    const dir = editionDir();
    put(dir, "02-reviewed.md", "x");
    put(dir, "_internal/.step-4-done.json", JSON.stringify({ step: 4, completed_at: "2026-11-01T00:00:00Z", outputs: [], output_hashes: {} }));
    const r = checkStage5Freshness(dir);
    assert.equal(r.ok, false);
    assert.deepEqual(
      r.problems.map((p) => [p.file, p.kind]),
      [["02-reviewed.md", "no_hash"], ["03-social.md", "absent"]],
    );
  });

  it("arquivo vazio e output_hashes inválido bloqueiam", () => {
    const dir = editionDir();
    put(dir, "02-reviewed.md", "");
    put(dir, "03-social.md", "x");
    put(dir, "_internal/.step-4-done.json", JSON.stringify({ step: 4, completed_at: "x", outputs: OUTPUTS, output_hashes: [] }));
    const r = checkStage5Freshness(dir);
    const kinds = r.problems.map((p) => p.kind);
    assert.ok(kinds.includes("sentinel_malformed"));
    assert.deepEqual(r.problems.find((p) => p.kind === "empty")?.file, "02-reviewed.md");
  });

  it("sentinel legado (sem output_hashes) passa com aviso", () => {
    const dir = editionDir();
    put(dir, "02-reviewed.md", "x");
    put(dir, "03-social.md", "y");
    put(dir, "_internal/.step-4-done.json", JSON.stringify({ step: 4, completed_at: "2026-11-01T00:00:00Z", outputs: OUTPUTS }));
    const r = checkStage5Freshness(dir);
    assert.equal(r.ok, true);
    assert.equal(r.verification, "unverified_legacy");
    assert.equal(r.warnings.length, 1);
    // Via CLI: exit 0 com aviso.
    assert.equal(runStage5Freshness(["check", "--edition-dir", dir]), 0);
  });

  it("sentinel SEM hash gravado depois do corte = código defasado: bloqueia (no_hash), também no CLI", () => {
    const dir = editionDir();
    put(dir, "02-reviewed.md", "x");
    put(dir, "03-social.md", "y");
    const after = new Date(Date.parse(OUTPUT_HASHES_REQUIRED_SINCE) + 3_600_000).toISOString();
    put(dir, "_internal/.step-4-done.json", JSON.stringify({ step: 4, completed_at: after, outputs: OUTPUTS }));
    const r = checkStage5Freshness(dir);
    assert.equal(r.ok, false);
    assert.deepEqual(r.problems.map((p) => p.kind), ["no_hash", "no_hash"]);
    assert.equal(runStage5Freshness(["check", "--edition-dir", dir]), 4);
    // completed_at ilegível sem hash também não vale como legado.
    put(dir, "_internal/.step-4-done.json", JSON.stringify({ step: 4, completed_at: "x", outputs: OUTPUTS }));
    assert.equal(checkStage5Freshness(dir).ok, false);
  });

  it("05-edition-url.txt presente mas inválido tem kind próprio", () => {
    const { a } = twoHostsAfterGate();
    put(a, "_internal/05-edition-url.txt", "diar.ia.br/p/sem-https");
    const r = checkStage5Freshness(a);
    assert.equal(r.ok, false);
    assert.deepEqual(r.problems.map((p) => [p.file, p.kind]), [["_internal/05-edition-url.txt", "edition_url_invalid"]]);
  });
});

describe("#11698 — CLI stage5-freshness.ts", () => {
  it("exit 4 defasado, 0 em dia, 2 uso inválido", () => {
    const { a, b } = twoHostsAfterGate();
    sync(a, b, "_internal/.step-4-done.json");
    assert.equal(runStage5Freshness(["check", "--edition-dir", b]), 4);
    assert.equal(runStage5Freshness(["check", "--edition-dir", a]), 0);
    assert.equal(runStage5Freshness(["check"]), 2);
  });

  it("erro de leitura (output virou diretório no meio do sync) vira exit 4, nunca exceção", () => {
    const dir = editionDir();
    mkdirSync(join(dir, "02-reviewed.md"));
    put(dir, "03-social.md", "x");
    writeSentinel(dir, 4, OUTPUTS);
    assert.equal(runStage5Freshness(["check", "--edition-dir", dir]), 4);
  });

  it("--force sai 0 e registra o override no run-log", () => {
    const { a, b } = twoHostsAfterGate();
    sync(a, b, "_internal/.step-4-done.json");
    const logRoot = mkdtempSync(join(tmpdir(), "s5f-log-"));
    assert.equal(runStage5Freshness(["check", "--edition-dir", b, "--force", "--edition", "261102"], { logRoot }), 0);
    const logPath = join(logRoot, "data", "run-log.jsonl");
    assert.ok(existsSync(logPath));
    const ev = JSON.parse(readFileSync(logPath, "utf8").trim().split("\n").pop()!);
    assert.equal(ev.message, "stage5_freshness_forced");
    assert.equal(ev.level, "warn");
    assert.equal(ev.edition, "261102");
    assert.equal(ev.details.problems.length, 2);
    assert.deepEqual(ev.details.kinds, ["diverged"]);
  });

  it("--force sem problemas sai 0 e NÃO grava evento", () => {
    const { a } = twoHostsAfterGate();
    const logRoot = mkdtempSync(join(tmpdir(), "s5f-log-"));
    assert.equal(runStage5Freshness(["check", "--edition-dir", a, "--force"], { logRoot }), 0);
    assert.equal(existsSync(join(logRoot, "data", "run-log.jsonl")), false);
  });
});

describe("#11698 — Etapa 5 em dois hosts com a trava da edição", () => {
  const T0 = Date.parse("2026-11-02T09:00:00Z");

  function guard(dir: string, host: string, now: number) {
    const steps = [1, 2, 3, 4, 5, 6].filter((n) => sentinelExists(dir, n));
    return assessStaleEdition({ step: 5, sentinelSteps: steps, lock: readEditionLock(dir), localHost: host, now });
  }

  it("A no meio da Etapa 5: B vê a trava pelo guard e não consegue adquirir", () => {
    const { a, b } = twoHostsAfterGate();
    for (const rel of [...OUTPUTS, "_internal/.step-4-done.json"]) sync(a, b, rel);
    const d = acquireEditionLock(a, { sessionId: "sess-a", stage: 5, host: "neo", now: T0 });
    assert.equal(d.action, "acquired");
    sync(a, b, "_internal/edition-lock.json");
    const v = guard(b, "300", T0 + 60_000);
    assert.equal(v.ok, false);
    assert.equal(v.signals[0].kind, "remote_lock");
    const db = acquireEditionLock(b, { sessionId: "sess-b", stage: 5, host: "300", now: T0 + 60_000 });
    assert.equal(db.action, "held_by_other");
  });

  it("A concluiu: tombstone chega antes do sentinel 5 → B bloqueia; depois do sentinel → B livre", () => {
    const { a, b } = twoHostsAfterGate();
    for (const rel of [...OUTPUTS, "_internal/.step-4-done.json"]) sync(a, b, rel);
    acquireEditionLock(a, { sessionId: "sess-a", stage: 5, host: "neo", now: T0 });
    put(a, "_internal/newsletter-kit-published.json", "{}");
    writeSentinel(a, 5, ["_internal/newsletter-kit-published.json"]);
    assert.equal(releaseEditionLock(a, { sessionId: "sess-a", completedStage: 5, host: "neo", now: T0 + 600_000 }), "released");
    sync(a, b, "_internal/edition-lock.json");
    const before = guard(b, "300", T0 + 700_000);
    assert.equal(before.ok, false);
    assert.equal(before.signals[0].kind, "remote_completed");
    sync(a, b, "_internal/newsletter-kit-published.json");
    sync(a, b, "_internal/.step-5-done.json");
    assert.equal(guard(b, "300", T0 + 800_000).ok, true);
  });

  it("A soltou a Etapa 5 num halt: B vê o tombstone de interrupção dentro da janela", () => {
    const { a, b } = twoHostsAfterGate();
    acquireEditionLock(a, { sessionId: "sess-a", stage: 5, host: "neo", now: T0 });
    releaseEditionLock(a, { sessionId: "sess-a", host: "neo", now: T0 + 60_000 });
    sync(a, b, "_internal/edition-lock.json");
    const v = guard(b, "300", T0 + 120_000);
    assert.equal(v.ok, false);
    assert.equal(v.signals[0].kind, "remote_interrupted");
    // Na mesma máquina, o retry re-adquire normalmente.
    assert.equal(acquireEditionLock(a, { sessionId: "sess-a2", stage: 5, host: "neo", now: T0 + 120_000 }).action, "acquired");
  });
});

describe("#11698 — playbook do Stage 5 chama guard, frescor, trava e release", () => {
  const md = readFileSync(join(import.meta.dirname, "..", ".claude", "agents", "orchestrator-stage-5.md"), "utf8");
  const at = (needle: string): number => {
    const i = md.indexOf(needle);
    assert.ok(i >= 0, `playbook sem: ${needle}`);
    return i;
  };

  it("guard → frescor → acquire, todos antes do primeiro write (status running)", () => {
    const g = at("stale-edition-guard.ts check --edition-dir {EDITION_DIR} --step 5");
    const f = at("stage5-freshness.ts check --edition-dir {EDITION_DIR}");
    const l = at("edition-lock.ts acquire --edition-dir {EDITION_DIR} --stage 5");
    const running = at("update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 5 --status running");
    assert.ok(g < f && f < l && l < running);
  });

  it("acquire renovado antes do dispatch e release com --complete-stage 5 depois do sentinel", () => {
    const acquire = "edition-lock.ts acquire --edition-dir {EDITION_DIR} --stage 5";
    for (const heading of ["### 5c. Dispatch newsletter", "### 5f. Loop de review", "### 5h. Escrever sentinel"]) {
      const h = at(heading);
      const next = md.indexOf("\n### ", h + 1);
      const i = md.indexOf(acquire, h);
      assert.ok(i > h && i < next, `renovação da trava ausente em ${heading}`);
    }
    at("exit 3/4 = halt SEM liberar");
    const sentinel = at("--edition {AAMMDD} --step 5");
    assert.ok(at("edition-lock.ts release --edition-dir {EDITION_DIR} --complete-stage 5") > sentinel);
  });

  it("release simples documentado para os halts depois do acquire, e fail-closed explícito", () => {
    at("edition-lock.ts release --edition-dir {EDITION_DIR}` (exit != 0 e log-only)");
    at("Fail-closed: qualquer exit != 0 dos tres e halt");
  });
});
