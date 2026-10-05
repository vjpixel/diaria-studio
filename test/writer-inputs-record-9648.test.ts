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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { refreshDestaqueSources } from "../scripts/refresh-destaque-sources.ts";
import {
  MIN_SOURCE_TEXT_BYTES,
  WRITER_INPUTS_FILE,
  buildWriterInputsRecord,
  findWriterInputGaps,
  readWriterInputsRecord,
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
      assert.equal(rec.destaques.length, 3);
      for (const [i, d] of rec.destaques.entries()) {
        const src = readFileSync(join(ed, "_internal", "fact-check-sources", `d${i + 1}.txt`));
        assert.equal(d.destaque, i + 1);
        assert.equal(d.url, urls[i]);
        assert.equal(d.source_text_path, `_internal/fact-check-sources/d${i + 1}.txt`);
        assert.equal(d.snapshot_path, `_internal/02-writer-inputs/d${i + 1}.txt`);
        assert.equal(d.bytes, src.length);
        assert.equal(d.sha256, createHash("sha256").update(src).digest("hex"));
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
      const snapBefore = readFileSync(join(ed, "_internal", "02-writer-inputs", "d2.txt"), "utf8");

      // Editor troca D2 no gate 4 → manifest.json e d{1,2,3}.txt são apagados e re-baixados.
      writeApproved(ed, ["https://ex.com/a", "https://ex.com/NOVO", "https://ex.com/c"]);
      const r = await refreshDestaqueSources(ed, { fetchImpl: fakeFetch({ tag: "v2 " }) });
      assert.equal(r.refetched, true);
      assert.equal(r.writer_inputs, undefined);
      assert.match(readFileSync(join(ed, "_internal", "fact-check-sources", "d2.txt"), "utf8"), /NOVO/);
      const manifest = JSON.parse(readFileSync(join(ed, "_internal", "fact-check-sources", "manifest.json"), "utf8"));
      assert.equal(manifest[1].url, "https://ex.com/NOVO");

      assert.equal(readFileSync(recordPath(ed), "utf8"), before, "registro do Stage 2 intocado");
      assert.equal(readFileSync(join(ed, "_internal", "02-writer-inputs", "d2.txt"), "utf8"), snapBefore);
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
      assert.equal(existsSync(join(ed, "_internal", "02-writer-inputs", "d3.txt")), false);

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
});
