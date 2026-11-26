/**
 * #14128 — regressão do padrão `argv[argv.indexOf(k) + 1]` trocado por
 * `scripts/lib/cli-args.ts`. O padrão lia `undefined` com a flag no fim do
 * argv e lia a flag SEGUINTE como valor (`--envio --apply` → `Number("--apply")`,
 * `--transcript --newest` → caminho `"--newest"`, `--sitemap --check` →
 * sitemap `"--check"`). Agora os dois casos são erro com mensagem clara.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { resolveTranscriptPath } from "../scripts/lib/effective-model-probe.ts";
import { parseCtaAbArgs } from "../scripts/clarice-cta-ab-setup.ts";
import { parseSyncEiaArgs } from "../scripts/sync-eia-used.ts";
import { parseReconcileArgs } from "../scripts/reconcile-site-sitemap.ts";
import { DEFAULT_PAGES_DIR, DEFAULT_PUBLIC_DIR, DEFAULT_SITEMAP } from "../scripts/lib/site-sitemap-orphans.ts";

const deps = { findTranscript: (sid: string) => `/p/${sid}.jsonl`, newest: () => "/p/newest.jsonl" };

describe("effective-model-probe resolveTranscriptPath (#14128)", () => {
  it("forma válida segue igual", () => {
    assert.equal(resolveTranscriptPath(["--transcript", "/t.jsonl"], deps), "/t.jsonl");
    assert.equal(resolveTranscriptPath(["--session-id", "abc"], deps), "/p/abc.jsonl");
    assert.equal(resolveTranscriptPath(["--newest"], deps), "/p/newest.jsonl");
    assert.equal(resolveTranscriptPath([], deps), null);
  });
  it("--transcript no fim, sem valor → erro claro (antes: undefined e seguia)", () =>
    assert.throws(() => resolveTranscriptPath(["--transcript"], deps), /--transcript foi passado sem valor/));
  it("--transcript seguido de outra flag → erro (antes: caminho \"--newest\")", () =>
    assert.throws(() => resolveTranscriptPath(["--transcript", "--newest"], deps), /--transcript foi passado sem valor/));
  it("--session-id seguido de outra flag → erro (antes: procurava a sessão \"--expect-model\")", () =>
    assert.throws(
      () => resolveTranscriptPath(["--session-id", "--expect-model", "x"], deps),
      /--session-id foi passado sem valor/,
    ));
});

describe("clarice-cta-ab-setup parseCtaAbArgs (#14128)", () => {
  it("sem flags: dry-run de todos os envios", () => assert.deepEqual(parseCtaAbArgs([]), { apply: false, envio: undefined }));
  it("--apply --envio 8", () => assert.deepEqual(parseCtaAbArgs(["--apply", "--envio", "8"]), { apply: true, envio: 8 }));
  it("--envio=9 (sintaxe =)", () => assert.deepEqual(parseCtaAbArgs(["--envio=9"]), { apply: false, envio: 9 }));
  it("--envio no fim, sem valor → erro claro (antes: Number(undefined) = NaN)", () =>
    assert.throws(() => parseCtaAbArgs(["--envio"]), /--envio foi passado sem valor/));
  it("--envio seguido de --apply → erro, sem virar apply de todos (antes: Number(\"--apply\"))", () =>
    assert.throws(() => parseCtaAbArgs(["--envio", "--apply"]), /--envio foi passado sem valor/));
  it("--envio não inteiro → erro", () => assert.throws(() => parseCtaAbArgs(["--envio", "oito"]), /inteiro/));
});

describe("sync-eia-used parseSyncEiaArgs (#14128)", () => {
  it("forma do Stage 0", () =>
    assert.deepEqual(parseSyncEiaArgs(["--editions-dir", "data/editions/"]), { editionsDir: "data/editions/", dryRun: false }));
  it("sem flags → default do caller", () => assert.deepEqual(parseSyncEiaArgs([]), { editionsDir: undefined, dryRun: false }));
  it("--dry-run em qualquer posição", () =>
    assert.deepEqual(parseSyncEiaArgs(["--dry-run", "--editions-dir", "x"]), { editionsDir: "x", dryRun: true }));
  it("--editions-dir seguido de --dry-run → erro (antes: diretório \"--dry-run\" e o dry-run se perdia)", () =>
    assert.throws(() => parseSyncEiaArgs(["--editions-dir", "--dry-run"]), /--editions-dir foi passado sem valor/));
  it("--editions-dir no fim → erro", () =>
    assert.throws(() => parseSyncEiaArgs(["--editions-dir"]), /--editions-dir foi passado sem valor/));
});

describe("reconcile-site-sitemap parseReconcileArgs (#14128)", () => {
  it("defaults", () =>
    assert.deepEqual(parseReconcileArgs([]), {
      check: false,
      pagesDir: DEFAULT_PAGES_DIR,
      sitemapPath: DEFAULT_SITEMAP,
      homePath: join(DEFAULT_SITEMAP, "..", "index.html"),
      publicDir: DEFAULT_PUBLIC_DIR,
    }));
  it("--sitemap fora do default: home ao lado dele, sem varredura de landings", () => {
    const r = parseReconcileArgs(["--check", "--sitemap", "/tmp/x/sitemap.xml", "--pages-dir", "/tmp/x/p"]);
    assert.deepEqual(r, {
      check: true, pagesDir: "/tmp/x/p", sitemapPath: "/tmp/x/sitemap.xml", homePath: "/tmp/x/index.html", publicDir: null,
    });
  });
  it("--public-dir e --home explícitos vencem", () => {
    const r = parseReconcileArgs(["--sitemap", "/tmp/x/s.xml", "--public-dir", "/tmp/x", "--home", "/tmp/h.html"]);
    assert.equal(r.publicDir, "/tmp/x");
    assert.equal(r.homePath, "/tmp/h.html");
  });
  it("--sitemap seguido de --check → erro (antes: sitemap \"--check\")", () =>
    assert.throws(() => parseReconcileArgs(["--sitemap", "--check"]), /--sitemap foi passado sem valor/));
  it("--home no fim → erro (antes: caía no default e reescrevia a home de produção)", () =>
    assert.throws(() => parseReconcileArgs(["--sitemap", "/tmp/s.xml", "--home"]), /--home foi passado sem valor/));
  it("--public-dir sem valor → erro", () =>
    assert.throws(() => parseReconcileArgs(["--public-dir", "--check"]), /--public-dir foi passado sem valor/));
});
