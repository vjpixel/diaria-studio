/**
 * test/mark-linkedin-weekly-published-12745.test.ts (#12745)
 *
 * Cenário real da issue: o editor publicou à mão o ciclo 26w45 da semanal do
 * LinkedIn, `ln-26w45.json` não existia e o alarme de staleness seguia
 * reproduzindo. O registro manual tem que gravar o arquivo que o alarme
 * reconhece, sem estragar o `ln-{cycle}.json` escrito pelo render.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateLinkedinPublishedUrl,
  planManualPublicationRecord,
  isManualPublicationRecord,
} from "../scripts/lib/linkedin-weekly-manual-publish.ts";
import { main } from "../scripts/mark-linkedin-weekly-published.ts";
import {
  artifactExistsForCycle,
  artifactIsManualPublication,
  toAlarmFinding,
} from "../scripts/linkedin-weekly-staleness-alarm.ts";
import { evaluateLinkedinWeeklyStalenessAlarm } from "../scripts/lib/linkedin-weekly-staleness-alarm.ts";

const URL_OK = "https://www.linkedin.com/pulse/diaria-semanal-26w45-pixel/";
const NOW = new Date("2026-11-10T12:00:00.000Z");

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "mark-ln-12745-"));
}

function run(argv: string[], rootDir: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, { rootDir, now: NOW, log: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("validateLinkedinPublishedUrl", () => {
  it("aceita artigo em www.linkedin.com e lnkd.in", () => {
    assert.equal(validateLinkedinPublishedUrl(URL_OK).ok, true);
    assert.equal(validateLinkedinPublishedUrl("https://lnkd.in/abc123").ok, true);
  });
  it("recusa vazio, http, outro host, sufixo falso e a raiz", () => {
    for (const bad of ["", "http://www.linkedin.com/pulse/x", "https://example.com/pulse/x", "https://evillinkedin.com/x", "https://www.linkedin.com/", "nao-e-url"]) {
      assert.equal(validateLinkedinPublishedUrl(bad).ok, false, bad);
    }
  });
});

describe("planManualPublicationRecord", () => {
  it("arquivo ausente: cria o registro mínimo", () => {
    const plan = planManualPublicationRecord(null, { cycle: "26w45", url: URL_OK, now: NOW });
    assert.equal(plan.action, "create");
    assert.deepEqual(plan.action === "create" && plan.record, {
      cycle: "26w45",
      published_manually: true,
      published_url: URL_OK,
      marked_published_at: NOW.toISOString(),
    });
  });
  it("arquivo do render: completa e preserva os campos existentes", () => {
    const rendered = JSON.stringify({ cycle: "26w45", warnings: ["w"], coverImagePath: null, headlinesCount: 3 });
    const plan = planManualPublicationRecord(rendered, { cycle: "26w45", url: URL_OK, now: NOW });
    assert.equal(plan.action, "merge");
    if (plan.action !== "merge") return;
    assert.deepEqual(plan.record.warnings, ["w"]);
    assert.equal(plan.record.headlinesCount, 3);
    assert.equal(plan.record.published_manually, true);
  });
  it("mesma URL já registrada: noop", () => {
    const first = planManualPublicationRecord(null, { cycle: "26w45", url: URL_OK, now: NOW });
    assert.equal(first.action, "create");
    const raw = JSON.stringify(first.action === "create" ? first.record : {});
    assert.equal(planManualPublicationRecord(raw, { cycle: "26w45", url: URL_OK, now: NOW }).action, "noop");
  });
  it("URL diferente, cycle divergente ou JSON ilegível: conflict sem --force, sobrescreve com --force", () => {
    const other = JSON.stringify({ cycle: "26w45", published_manually: true, published_url: "https://www.linkedin.com/pulse/outra/" });
    assert.equal(planManualPublicationRecord(other, { cycle: "26w45", url: URL_OK, now: NOW }).action, "conflict");
    assert.equal(planManualPublicationRecord(other, { cycle: "26w45", url: URL_OK, now: NOW, force: true }).action, "merge");
    const wrongCycle = JSON.stringify({ cycle: "26w44" });
    assert.equal(planManualPublicationRecord(wrongCycle, { cycle: "26w45", url: URL_OK, now: NOW }).action, "conflict");
    assert.equal(planManualPublicationRecord("{quebrado", { cycle: "26w45", url: URL_OK, now: NOW }).action, "conflict");
    assert.equal(planManualPublicationRecord("{quebrado", { cycle: "26w45", url: URL_OK, now: NOW, force: true }).action, "create");
    assert.equal(planManualPublicationRecord("[]", { cycle: "26w45", url: URL_OK, now: NOW }).action, "conflict");
  });
});

describe("mark-linkedin-weekly-published.ts main + alarme (cenário 26w45)", () => {
  it("antes do registro o alarme dispara; depois, o mesmo ciclo sai ok e marcado como manual", () => {
    const root = tempRoot();
    try {
      assert.equal(artifactExistsForCycle("26w45", root), false);
      assert.equal(evaluateLinkedinWeeklyStalenessAlarm("26w45", false).verdict, "alarm-missing");

      const r = run(["--cycle", "26w45", "--url", URL_OK], root);
      assert.equal(r.code, 0, r.err);

      const exists = artifactExistsForCycle("26w45", root);
      assert.equal(exists, true);
      assert.equal(evaluateLinkedinWeeklyStalenessAlarm("26w45", exists).verdict, "ok");
      assert.equal(artifactIsManualPublication("26w45", root), true);

      const saved = JSON.parse(readFileSync(join(root, "data/weekly/26w45/ln-26w45.json"), "utf8"));
      assert.equal(saved.published_url, URL_OK);
      assert.equal(saved.marked_published_at, NOW.toISOString());

      // Reexecução idempotente.
      assert.equal(run(["--cycle", "26w45", "--url", URL_OK], root).code, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--dry-run não grava", () => {
    const root = tempRoot();
    try {
      const r = run(["--cycle", "26w45", "--url", URL_OK, "--dry-run"], root);
      assert.equal(r.code, 0);
      assert.equal(existsSync(join(root, "data/weekly/26w45/ln-26w45.json")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("argumentos inválidos e conflito saem 1 sem gravar", () => {
    const root = tempRoot();
    try {
      assert.equal(run(["--url", URL_OK], root).code, 1);
      assert.equal(run(["--cycle", "26w99", "--url", URL_OK], root).code, 1);
      assert.equal(run(["--cycle", "26w45", "--url", "https://example.com/x"], root).code, 1);
      assert.equal(run(["--cycle", "26w45", "--url", URL_OK, "--bogus"], root).code, 1);
      assert.equal(existsSync(join(root, "data/weekly/26w45")), false);

      const dir = join(root, "data/weekly/26w45");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "ln-26w45.json");
      writeFileSync(path, JSON.stringify({ cycle: "26w45", published_url: "https://www.linkedin.com/pulse/outra/" }));
      const before = readFileSync(path, "utf8");
      assert.equal(run(["--cycle", "26w45", "--url", URL_OK], root).code, 1);
      assert.equal(readFileSync(path, "utf8"), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("render sem registro manual não é lido como manual", () => {
    assert.equal(isManualPublicationRecord(JSON.stringify({ cycle: "26w45", warnings: [] })), false);
    assert.equal(isManualPublicationRecord("{quebrado"), false);
  });

  it("issue de alarme ensina o comando de registro manual", () => {
    assert.match(toAlarmFinding("26w45").body, /mark-linkedin-weekly-published\.ts --cycle 26w45 --url/);
  });
});
