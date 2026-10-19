/**
 * #9648 — o texto-fonte que cada writer-destaque recebeu no Stage 2 tem de
 * ficar auditável depois de uma troca no Stage 4.
 *
 * 1. `refresh-destaque-sources.ts --record-writer-inputs` (passo 0 do Stage 2)
 *    grava `_internal/02-writer-inputs.json` com URL, source_text_path,
 *    sha256, bytes e status por destaque + cópia congelada do texto.
 * 2. Uma troca no Stage 4 (o mesmo script SEM a flag, que apaga e regrava
 *    manifest.json + d{N}.txt) não altera o registro nem a cópia.
 * 3. `collect-edition-signals` acusa (warning) destaque sem texto-fonte ou
 *    com texto truncado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { WRITER_INPUTS_LOG_PREFIX, refreshDestaqueSources } from "../scripts/refresh-destaque-sources.ts";
import {
  MIN_SOURCE_TEXT_BYTES,
  WRITER_INPUTS_CUTOVER_EDITION,
  WRITER_INPUTS_FILE,
  buildWriterInputsRecord,
  checkWriterInputSnapshots,
  findWriterInputGaps,
  readWriterInputsRecord,
  writeWriterInputsRecord,
} from "../scripts/lib/writer-inputs-record.ts";
import { collectSignals, signalsFromWriterInputs } from "../scripts/collect-edition-signals.ts";

const LONG = "x".repeat(MIN_SOURCE_TEXT_BYTES + 500);

/** Página com corpo longo por padrão; `short`/`blocked` mapeiam URL → resposta. */
function fakeFetch(opts: { short?: string[]; blocked?: string[]; tag?: string } = {}): typeof fetch {
  return (async (input: string | URL) => {
    const u = String(input);
    if (opts.blocked?.includes(u)) return new Response("no", { status: 451 });
    const body = opts.short?.includes(u) ? `<p>teaser ${u}</p>` : `<p>${opts.tag ?? ""}TEXTO DE ${u} ${LONG}</p>`;
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
}

function setup(urls: string[], approvedName = "01-approved-capped.json"): string {
  const ed = mkdtempSync(join(tmpdir(), "writer-inputs-9648-"));
  mkdirSync(join(ed, "_internal"), { recursive: true });
  writeApproved(ed, urls, approvedName);
  return ed;
}

function writeApproved(ed: string, urls: string[], name = "01-approved.json"): void {
  const approved = { highlights: urls.map((url, i) => ({ rank: i + 1, url, article: { url, title: `t${i}` } })) };
  writeFileSync(join(ed, "_internal", name), JSON.stringify(approved), "utf8");
}

const recordPath = (ed: string) => join(ed, "_internal", WRITER_INPUTS_FILE);

describe("02-writer-inputs.json (#9648)", () => {
  it("Stage 2 grava URL, source_text_path, sha256, bytes, status e cópia do texto por destaque", async () => {
    const urls = ["https://ex.com/a", "https://ex.com/b", "https://ex.com/c"];
    const ed = setup(urls);
    try {
      const r = await refreshDestaqueSources(ed, {
        fetchImpl: fakeFetch(),
        approvedPath: join(ed, "_internal", "01-approved-capped.json"),
        recordWriterInputs: true,
        now: new Date("2026-10-04T23:59:00Z"),
      });
      assert.equal(r.writer_inputs?.path, recordPath(ed));
      assert.deepEqual(r.writer_inputs?.gaps, []);
      const rec = JSON.parse(readFileSync(recordPath(ed), "utf8"));
      assert.equal(rec.schema_version, 1);
      assert.equal(rec.recorded_at, "2026-10-04T23:59:00.000Z");
      assert.equal(rec.approved_path, "_internal/01-approved-capped.json");
      assert.equal(rec.min_source_text_bytes, MIN_SOURCE_TEXT_BYTES);
      assert.equal(rec.highlight_count, 3);
      assert.equal(rec.history, undefined, "1ª gravação não tem histórico");
      assert.equal(rec.destaques.length, 3);
      for (const [i, d] of rec.destaques.entries()) {
        const src = readFileSync(join(ed, "_internal", "fact-check-sources", `d${i + 1}.txt`));
        assert.equal(d.destaque, i + 1);
        assert.equal(d.url, urls[i]);
        assert.equal(d.source_text_path, `_internal/fact-check-sources/d${i + 1}.txt`);
        const sha = createHash("sha256").update(src).digest("hex");
        assert.equal(d.snapshot_path, `_internal/02-writer-inputs/d${i + 1}-${sha.slice(0, 12)}.txt`);
        assert.equal(d.bytes, src.length);
        assert.equal(d.sha256, sha);
        assert.equal(d.status, "ok");
        assert.equal(d.error, null);
        assert.deepEqual(readFileSync(join(ed, d.snapshot_path)), src);
      }
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("troca no Stage 4 (refresh SEM a flag regrava manifest + d{N}.txt) não altera o registro nem a cópia", async () => {
    const ed = setup(["https://ex.com/a", "https://ex.com/b", "https://ex.com/c"], "01-approved.json");
    try {
      await refreshDestaqueSources(ed, { fetchImpl: fakeFetch(), recordWriterInputs: true });
      const before = readFileSync(recordPath(ed), "utf8");
      const snap2 = join(ed, JSON.parse(before).destaques[1].snapshot_path);
      const snapBefore = readFileSync(snap2, "utf8");

      // Editor troca D2 no gate 4 → manifest.json e d{1,2,3}.txt são apagados e re-baixados.
      writeApproved(ed, ["https://ex.com/a", "https://ex.com/NOVO", "https://ex.com/c"]);
      const r = await refreshDestaqueSources(ed, { fetchImpl: fakeFetch({ tag: "v2 " }) });
      assert.equal(r.refetched, true);
      assert.equal(r.writer_inputs, undefined);
      assert.match(readFileSync(join(ed, "_internal", "fact-check-sources", "d2.txt"), "utf8"), /NOVO/);
      const manifest = JSON.parse(readFileSync(join(ed, "_internal", "fact-check-sources", "manifest.json"), "utf8"));
      assert.equal(manifest[1].url, "https://ex.com/NOVO");

      assert.equal(readFileSync(recordPath(ed), "utf8"), before, "registro do Stage 2 intocado");
      assert.equal(readFileSync(snap2, "utf8"), snapBefore);
      assert.match(snapBefore, /ex\.com\/b/);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("texto ausente (fonte bloqueada) e truncado viram gaps e signal writer_source_text_gap", async () => {
    const urls = ["https://ex.com/a", "https://ex.com/paywall", "https://ex.com/bloqueado"];
    const ed = setup(urls, "01-approved.json");
    try {
      const r = await refreshDestaqueSources(ed, {
        fetchImpl: fakeFetch({ short: ["https://ex.com/paywall"], blocked: ["https://ex.com/bloqueado"] }),
        recordWriterInputs: true,
      });
      const gaps = r.writer_inputs!.gaps;
      assert.deepEqual(
        gaps.map((g) => [g.destaque, g.status]),
        [
          [2, "short"],
          [3, "missing"],
        ],
      );
      const rec = JSON.parse(readFileSync(recordPath(ed), "utf8"));
      assert.equal(rec.destaques[2].source_text_path, null);
      assert.equal(rec.destaques[2].sha256, null);
      assert.match(rec.destaques[2].error, /451/);
      assert.equal(rec.destaques[2].snapshot_path, null);
      assert.ok(!readdirSync(join(ed, "_internal", "02-writer-inputs")).some((f) => f.startsWith("d3")));

      const sigs = signalsFromWriterInputs(readWriterInputsRecord(ed));
      assert.equal(sigs.length, 1);
      assert.equal(sigs[0].kind, "writer_source_text_gap");
      assert.equal(sigs[0].severity, "medium", "texto ausente pesa mais que truncado");
      assert.match(sigs[0].title, /D2 \(\d+ bytes\)/);
      assert.match(sigs[0].title, /D3 \(sem texto\)/);

      // Integrado ao collectSignals (o que o auto-reporter consome).
      const draft = collectSignals({ rootDir: ed, editionDir: ed, edition: "261005" });
      assert.equal(draft.signals.filter((s) => s.kind === "writer_source_text_gap").length, 1);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("só truncado = severity low; tudo ok ou registro ausente = sem signal; corrompido = low", () => {
    const ed = mkdtempSync(join(tmpdir(), "writer-inputs-9648-"));
    try {
      mkdirSync(join(ed, "_internal"), { recursive: true });
      assert.deepEqual(signalsFromWriterInputs(readWriterInputsRecord(ed)), [], "edição pré-#9648");

      const txt = join(ed, "_internal", "d1.txt");
      writeFileSync(txt, "curto");
      const rec = buildWriterInputsRecord(ed, [{ destaque: 1, url: "https://ex.com/a", path: txt }]);
      assert.equal(rec.destaques[0].status, "short");
      assert.equal(findWriterInputGaps(rec).length, 1);
      assert.equal(signalsFromWriterInputs({ kind: "ok", record: rec })[0].severity, "low");

      writeFileSync(txt, LONG);
      const ok = buildWriterInputsRecord(ed, [{ destaque: 1, url: "https://ex.com/a", path: txt }]);
      assert.deepEqual(signalsFromWriterInputs({ kind: "ok", record: ok }), []);

      // path listado mas sumido do disco = writer não leu nada = missing.
      const gone = buildWriterInputsRecord(ed, [{ destaque: 1, url: "https://ex.com/a", path: join(ed, "nao-existe.txt") }]);
      assert.equal(gone.destaques[0].status, "missing");
      assert.match(gone.destaques[0].error ?? "", /ilegível/);

      writeFileSync(recordPath(ed), "{nao json");
      const corrupt = signalsFromWriterInputs(readWriterInputsRecord(ed));
      assert.equal(corrupt.length, 1);
      assert.equal(corrupt[0].severity, "low");
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("CLI --record-writer-inputs grava 02-writer-inputs.json (cache semeado, sem rede)", async () => {
    const urls = ["https://ex.com/a", "https://ex.com/b", "https://ex.com/c"];
    const ed = setup(urls);
    const approvedPath = join(ed, "_internal", "01-approved-capped.json");
    try {
      // Semeia o cache in-process; o subprocesso reusa (URLs batem) sem tocar a rede.
      await refreshDestaqueSources(ed, { fetchImpl: fakeFetch(), approvedPath });
      assert.equal(existsSync(recordPath(ed)), false, "sem a flag, nada de registro");
      const script = join(import.meta.dirname, "..", "scripts", "refresh-destaque-sources.ts");
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", script, "--edition-dir", ed, "--approved", approvedPath, "--record-writer-inputs"],
        { encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.refetched, false, "cache semeado reusado");
      assert.equal(out.writer_inputs.path, recordPath(ed));
      assert.equal(existsSync(recordPath(ed)), true);
      const rec = JSON.parse(readFileSync(recordPath(ed), "utf8"));
      assert.equal(rec.destaques.length, 3);
      assert.ok(rec.destaques.every((d: { status: string }) => d.status === "ok"));
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("guard textual: flag só no passo 0 do Stage 2, nunca no Stage 4 nem nos next_steps das trocas", () => {
    const root = join(import.meta.dirname, "..");
    const read = (p: string) => readFileSync(join(root, p), "utf8");
    const stage2 = read(".claude/agents/orchestrator-stage-2.md");
    const passo0 = stage2.slice(stage2.indexOf("**0. Baixar as fontes dos destaques"), stage2.indexOf("**0b."));
    assert.ok(passo0.length > 0, "passo 0 do Stage 2 localizado");
    assert.match(passo0, /refresh-destaque-sources\.ts [^\n]*--record-writer-inputs/);
    // Causa das edições 261007–261009 sem registro: a skill /diaria-2-escrita é
    // quem executa o Stage 2 (inclusive headless) e não tinha o passo 0.
    const skill = read(".claude/skills/diaria-2-escrita/SKILL.md");
    assert.match(skill, /refresh-destaque-sources\.ts [^\n]*--record-writer-inputs/, "SKILL.md de /diaria-2-escrita precisa do passo 0 com a flag");
    assert.ok(
      skill.indexOf("--record-writer-inputs") < skill.indexOf('subagent_type: "writer-destaque"'),
      "passo 0 vem ANTES do dispatch dos writer-destaque",
    );
    assert.ok((skill.match(/source_text_path=\{path do passo 0/g) ?? []).length >= 3, "D1, D2 e D3 recebem source_text_path");
    assert.ok(
      skill.indexOf("--record-writer-inputs") < skill.indexOf("### Se `$2` está ausente"),
      "passo 0 vem antes do branch por $2 (newsletter/social também baixam)",
    );
    for (const p of [
      ".claude/agents/orchestrator-stage-4.md",
      "scripts/swap-destaque.ts",
      "scripts/swap-destaques.ts",
      "scripts/promote-to-destaque.ts",
    ]) {
      assert.doesNotMatch(read(p), /record-writer-inputs/, `${p} não pode passar a flag (sobrescreveria o registro do Stage 2)`);
    }
  });

  it("fail-soft: falha ao gravar o registro preserva sources/failed, preenche writer_inputs_error e grava warn no run-log", async () => {
    const root = mkdtempSync(join(tmpdir(), "writer-inputs-9648-root-"));
    const ed = join(root, "data", "editions", "2610", "261010");
    mkdirSync(join(ed, "_internal"), { recursive: true });
    const urls = ["https://ex.com/a", "https://ex.com/b"];
    writeApproved(ed, urls, "01-approved-capped.json");
    const approvedPath = join(ed, "_internal", "01-approved-capped.json");
    try {
      const baseline = await refreshDestaqueSources(ed, { fetchImpl: fakeFetch({ blocked: [urls[1]] }), approvedPath });
      // Arquivo no lugar do diretório das cópias: mkdirSync lança EEXIST/ENOTDIR.
      // (Diretório no lugar do JSON não serve mais: registro ilegível é
      // renomeado pra `.corrupt-*` e o novo é gravado.)
      writeFileSync(join(ed, "_internal", "02-writer-inputs"), "não sou diretório");
      const r = await refreshDestaqueSources(ed, {
        fetchImpl: fakeFetch({ blocked: [urls[1]] }),
        approvedPath,
        recordWriterInputs: true,
        runLogRootDir: root,
      });
      assert.deepEqual(r.sources, baseline.sources);
      assert.deepEqual(r.failed, [2]);
      assert.equal(r.writer_inputs, undefined);
      assert.match(r.writer_inputs_error ?? "", /EEXIST|ENOTDIR|not a directory|file already exists/i);

      const events = readFileSync(join(root, "data", "run-log.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      assert.equal(events.length, 1);
      assert.equal(events[0].level, "warn");
      assert.equal(events[0].edition, "261010");
      assert.equal(events[0].stage, 2);
      assert.ok(events[0].message.startsWith(WRITER_INPUTS_LOG_PREFIX));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("registro ausente pós-cutover com fontes baixadas = signal low; pré-cutover ou sem manifest = nada", async () => {
    const root = mkdtempSync(join(tmpdir(), "writer-inputs-9648-root-"));
    try {
      const mk = async (edition: string, seed: boolean) => {
        const ed = join(root, "data", "editions", edition.slice(0, 4), edition);
        mkdirSync(join(ed, "_internal"), { recursive: true });
        writeApproved(ed, ["https://ex.com/a"], "01-approved.json");
        if (seed) await refreshDestaqueSources(ed, { fetchImpl: fakeFetch() });
        return ed;
      };
      const gapKinds = (ed: string) =>
        collectSignals({ rootDir: root, editionDir: ed }).signals.filter((s) => s.kind === "writer_source_text_gap");

      const post = await mk(WRITER_INPUTS_CUTOVER_EDITION, true);
      const sigs = gapKinds(post);
      assert.equal(sigs.length, 1);
      assert.equal(sigs[0].severity, "low");
      assert.match(sigs[0].title, /ausente/);

      assert.deepEqual(gapKinds(await mk("261001", true)), [], "pré-cutover = edição antiga");
      assert.deepEqual(gapKinds(await mk("261020", false)), [], "sem manifest = Stage 2 nem baixou fontes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("02-writer-inputs.json — imutável + check de auditabilidade (#9648, resíduo itens 1 e 2)", () => {
  it("re-record COM a flag depois de troca no Stage 4 empilha a gravação anterior em history[] e preserva a cópia antiga", async () => {
    const ed = setup(["https://ex.com/a", "https://ex.com/b", "https://ex.com/c"], "01-approved.json");
    try {
      await refreshDestaqueSources(ed, { fetchImpl: fakeFetch(), recordWriterInputs: true, now: new Date("2026-10-18T10:00:00Z") });
      const first = JSON.parse(readFileSync(recordPath(ed), "utf8"));
      const oldSnap = join(ed, first.destaques[1].snapshot_path);
      const oldText = readFileSync(oldSnap, "utf8");

      // Troca no Stage 4 e depois um re-run do passo 0 do Stage 2 (ex.: `/diaria-2-escrita social`).
      writeApproved(ed, ["https://ex.com/a", "https://ex.com/NOVO", "https://ex.com/c"]);
      await refreshDestaqueSources(ed, {
        fetchImpl: fakeFetch({ tag: "v2 " }),
        recordWriterInputs: true,
        now: new Date("2026-10-18T12:00:00Z"),
      });

      const rec = JSON.parse(readFileSync(recordPath(ed), "utf8"));
      assert.equal(rec.recorded_at, "2026-10-18T12:00:00.000Z");
      assert.equal(rec.destaques[1].url, "https://ex.com/NOVO");
      assert.equal(rec.history.length, 1, "gravação do Stage 2 original preservada");
      assert.equal(rec.history[0].recorded_at, "2026-10-18T10:00:00.000Z");
      assert.equal(rec.history[0].destaques[1].url, "https://ex.com/b");
      assert.equal(rec.history[0].schema_version, undefined);
      assert.equal(readFileSync(oldSnap, "utf8"), oldText, "cópia do texto antigo intocada");
      assert.notEqual(rec.destaques[1].snapshot_path, first.destaques[1].snapshot_path);
      assert.deepEqual(checkWriterInputSnapshots(ed, rec), []);

      // 3ª gravação: a cadeia cresce, nunca encolhe.
      writeApproved(ed, ["https://ex.com/a", "https://ex.com/NOVO2", "https://ex.com/c"]);
      await refreshDestaqueSources(ed, { fetchImpl: fakeFetch(), recordWriterInputs: true, now: new Date("2026-10-18T13:00:00Z") });
      const rec3 = JSON.parse(readFileSync(recordPath(ed), "utf8"));
      assert.deepEqual(
        rec3.history.map((h: { recorded_at: string }) => h.recorded_at),
        ["2026-10-18T10:00:00.000Z", "2026-10-18T12:00:00.000Z"],
      );
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("re-record com os mesmos insumos é no-op (mantém recorded_at original, sem history)", async () => {
    const ed = setup(["https://ex.com/a", "https://ex.com/b"], "01-approved.json");
    try {
      await refreshDestaqueSources(ed, { fetchImpl: fakeFetch(), recordWriterInputs: true, now: new Date("2026-10-18T10:00:00Z") });
      const before = readFileSync(recordPath(ed), "utf8");
      await refreshDestaqueSources(ed, { fetchImpl: fakeFetch(), recordWriterInputs: true, now: new Date("2026-10-18T11:00:00Z") });
      assert.equal(readFileSync(recordPath(ed), "utf8"), before);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("registro anterior corrompido é preservado ao lado, nunca sobrescrito", () => {
    const ed = mkdtempSync(join(tmpdir(), "writer-inputs-9648-"));
    try {
      mkdirSync(join(ed, "_internal"), { recursive: true });
      writeFileSync(recordPath(ed), "{nao json");
      const txt = join(ed, "_internal", "src.txt");
      writeFileSync(txt, LONG);
      const rec = buildWriterInputsRecord(ed, [{ destaque: 1, url: "https://ex.com/a", path: txt }], {
        now: new Date("2026-10-18T10:00:00Z"),
      });
      writeWriterInputsRecord(ed, rec);
      const kept = readdirSync(join(ed, "_internal")).filter((f) => f.startsWith("02-writer-inputs.corrupt-"));
      assert.equal(kept.length, 1);
      assert.equal(readFileSync(join(ed, "_internal", kept[0]), "utf8"), "{nao json");
      assert.equal(readWriterInputsRecord(ed).kind, "ok");
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("check: destaque do approved sem entrada no registro vira gap `unrecorded`", () => {
    const ed = mkdtempSync(join(tmpdir(), "writer-inputs-9648-"));
    try {
      mkdirSync(join(ed, "_internal"), { recursive: true });
      const txt = join(ed, "_internal", "src.txt");
      writeFileSync(txt, LONG);
      const rec = buildWriterInputsRecord(ed, [{ destaque: 1, url: "https://ex.com/a", path: txt }], { highlightCount: 3 });
      assert.deepEqual(
        findWriterInputGaps(rec).map((g) => [g.destaque, g.status]),
        [
          [2, "unrecorded"],
          [3, "unrecorded"],
        ],
      );
      const sigs = signalsFromWriterInputs({ kind: "ok", record: rec });
      assert.equal(sigs.length, 1);
      assert.match(sigs[0].title, /D2 \(sem registro\)/);
      // Registro legado (sem highlight_count) não inventa gap.
      const { highlight_count: _hc, ...legacy } = rec;
      assert.deepEqual(findWriterInputGaps(legacy), []);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("check: cópia congelada apagada ou alterada vira signal de registro não auditável", async () => {
    const ed = setup(["https://ex.com/a", "https://ex.com/b", "https://ex.com/c"], "01-approved.json");
    try {
      await refreshDestaqueSources(ed, { fetchImpl: fakeFetch(), recordWriterInputs: true });
      const rec = JSON.parse(readFileSync(recordPath(ed), "utf8"));
      unlinkSync(join(ed, rec.destaques[0].snapshot_path));
      writeFileSync(join(ed, rec.destaques[2].snapshot_path), "adulterado");
      assert.deepEqual(
        checkWriterInputSnapshots(ed, rec).map((i) => [i.destaque, i.problem]),
        [
          [1, "snapshot-ausente"],
          [3, "hash-divergente"],
        ],
      );
      const sigs = collectSignals({ rootDir: ed, editionDir: ed, edition: "261019" }).signals.filter(
        (s) => s.kind === "writer_source_text_gap",
      );
      assert.equal(sigs.length, 1);
      assert.match(sigs[0].title, /não auditável: D1 \(cópia ausente\), D3 \(hash divergente\)/);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("check: registro ausente pós-cutover acusa mesmo com fact-check-sources/ esvaziado, se o Stage 2 escreveu os destaques", () => {
    const root = mkdtempSync(join(tmpdir(), "writer-inputs-9648-root-"));
    try {
      const ed = join(root, "data", "editions", "2610", "261016");
      mkdirSync(join(ed, "_internal", "fact-check-sources"), { recursive: true });
      const gaps = () =>
        collectSignals({ rootDir: root, editionDir: ed }).signals.filter((s) => s.kind === "writer_source_text_gap");
      assert.deepEqual(gaps(), [], "sem manifest e sem drafts = Stage 2 não rodou");
      writeFileSync(join(ed, "_internal", "02-d1-draft.md"), "**DESTAQUE 1 | X**\n");
      const sigs = gaps();
      assert.equal(sigs.length, 1);
      assert.match(sigs[0].title, /ausente/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
