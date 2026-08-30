import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isGhPrCreateCommand,
  isRuntimeArtifactPath,
  isFixturePath,
  parseNameStatus,
  parseAddedLinesByFile,
  findDangerousDiffContent,
  buildDenyMessage,
  EMAIL_RE,
} from "../.claude/hooks/block-pr-create-pii-runtime-artifacts.mjs";

// #6753: guard mecânico contra `gh pr create` quando a branch carrega
// artefato de runtime versionado ou PII de assinante fora de fixture.
// Reconstitui o caso real (`scripts/_tmp_engagement_backup3/b29f6620_p1.json`,
// conteúdo SINTÉTICO — nunca PII real na fixture, conforme pedido no corpo
// da issue) e trava as duas direções: branch perigosa recusa, branch limpa
// passa.

describe("isGhPrCreateCommand (#6753)", () => {
  it("detecta 'gh pr create' standalone e com flags", () => {
    assert.equal(isGhPrCreateCommand("gh pr create --title x --body y"), true);
  });

  it("detecta em comando encadeado", () => {
    assert.equal(isGhPrCreateCommand("git push && gh pr create --title x"), true);
  });

  it("não detecta 'gh pr view'/'gh pr comment'/'gh pr merge'", () => {
    assert.equal(isGhPrCreateCommand("gh pr view 123"), false);
    assert.equal(isGhPrCreateCommand("gh pr comment 123 --body hi"), false);
    assert.equal(isGhPrCreateCommand("gh pr merge 123"), false);
  });

  it("não casa citação de 'gh pr create' dentro de uma string entre aspas", () => {
    assert.equal(isGhPrCreateCommand('echo "rodar gh pr create depois"'), false);
  });

  it("comando ausente/não-string → false (fail-open)", () => {
    assert.equal(isGhPrCreateCommand(undefined), false);
    assert.equal(isGhPrCreateCommand(null), false);
  });
});

describe("isRuntimeArtifactPath (#6753)", () => {
  it("detecta o path exato do incidente real", () => {
    assert.equal(
      isRuntimeArtifactPath("scripts/_tmp_engagement_backup3/b29f6620_p1.json"),
      true,
    );
  });

  it("detecta qualquer path sob data/", () => {
    assert.equal(isRuntimeArtifactPath("data/editions/260829/foo.json"), true);
  });

  it("detecta padrões de dump/cache/tmp", () => {
    assert.equal(isRuntimeArtifactPath("scripts/subscriber-dump.json"), true);
    assert.equal(isRuntimeArtifactPath("foo/.cache/bar.json"), true);
    assert.equal(isRuntimeArtifactPath("foo/bar.tmp"), true);
  });

  it("NÃO acusa path normal de código-fonte", () => {
    assert.equal(isRuntimeArtifactPath("scripts/lib/clarice-db.ts"), false);
    assert.equal(isRuntimeArtifactPath("test/block-staleness.test.ts"), false);
    assert.equal(isRuntimeArtifactPath("docs/installation.md"), false);
  });
});

describe("isFixturePath (#6753)", () => {
  it("reconhece test/**, *.test.ts, fixtures/, __fixtures__/", () => {
    assert.equal(isFixturePath("test/block-staleness.test.ts"), true);
    assert.equal(isFixturePath("scripts/lib/foo.test.ts"), true);
    assert.equal(isFixturePath("scripts/fixtures/emails.json"), true);
    assert.equal(isFixturePath("scripts/__fixtures__/emails.json"), true);
  });

  it("NÃO trata scripts/lib comum como fixture", () => {
    assert.equal(isFixturePath("scripts/lib/clarice-db.ts"), false);
    assert.equal(isFixturePath("platform.config.json"), false);
  });
});

describe("EMAIL_RE (#6753)", () => {
  it("detecta e-mail simples", () => {
    assert.equal(EMAIL_RE.test("contato: fulano@example.com"), true);
  });
  it("não detecta texto sem e-mail", () => {
    assert.equal(EMAIL_RE.test("nenhum email aqui"), false);
  });
});

describe("parseNameStatus (#6753)", () => {
  it("parseia added/modified/deleted", () => {
    const raw = "A\tscripts/_tmp_x/y.json\nM\tscripts/lib/foo.ts\nD\tscripts/old.ts\n";
    assert.deepEqual(parseNameStatus(raw), [
      { status: "A", path: "scripts/_tmp_x/y.json" },
      { status: "M", path: "scripts/lib/foo.ts" },
      { status: "D", path: "scripts/old.ts" },
    ]);
  });

  it("resolve rename pro path de DESTINO", () => {
    const raw = "R100\told/path.ts\tnew/path.ts\n";
    assert.deepEqual(parseNameStatus(raw), [{ status: "R100", path: "new/path.ts" }]);
  });

  it("texto vazio → []", () => {
    assert.deepEqual(parseNameStatus(""), []);
  });
});

describe("parseAddedLinesByFile (#6753)", () => {
  it("extrai só linhas + (sem o marcador +++) por arquivo", () => {
    const diff = [
      "diff --git a/foo.txt b/foo.txt",
      "index 000..111 100644",
      "--- a/foo.txt",
      "+++ b/foo.txt",
      "@@ -0,0 +1,2 @@",
      "+linha nova 1",
      "+linha nova 2",
    ].join("\n");
    const byFile = parseAddedLinesByFile(diff);
    assert.deepEqual(byFile.get("foo.txt"), ["linha nova 1", "linha nova 2"]);
  });

  it("arquivo novo criado do zero (--- /dev/null) tem todas as linhas como adicionadas", () => {
    const diff = [
      "diff --git a/dump.json b/dump.json",
      "new file mode 100644",
      "index 000..111",
      "--- /dev/null",
      "+++ b/dump.json",
      "@@ -0,0 +1,3 @@",
      "+{",
      '+  "email": "assinante.real@exemplo.com"',
      "+}",
    ].join("\n");
    const byFile = parseAddedLinesByFile(diff);
    assert.equal(byFile.get("dump.json").length, 3);
  });

  it("múltiplos arquivos no mesmo diff são segregados corretamente", () => {
    const diff = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1 +1 @@",
      "+conteudo A",
      "diff --git a/b.txt b/b.txt",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -1 +1 @@",
      "+conteudo B",
    ].join("\n");
    const byFile = parseAddedLinesByFile(diff);
    assert.deepEqual(byFile.get("a.txt"), ["conteudo A"]);
    assert.deepEqual(byFile.get("b.txt"), ["conteudo B"]);
  });
});

describe("findDangerousDiffContent (#6753) — reconstitui o incidente real", () => {
  it("branch com artefato de runtime tracked (status A) → finding runtime-artifact", () => {
    const nameStatus = [{ status: "A", path: "scripts/_tmp_engagement_backup3/b29f6620_p1.json" }];
    const addedLines = new Map([
      [
        "scripts/_tmp_engagement_backup3/b29f6620_p1.json",
        ['{ "email": "sintetico.fixture@exemplo-teste.invalid" }'],
      ],
    ]);
    const findings = findDangerousDiffContent(nameStatus, addedLines);
    const kinds = findings.map((f) => f.kind);
    assert.ok(kinds.includes("runtime-artifact"));
    assert.ok(kinds.includes("pii-email"));
  });

  it("branch LIMPA (só código normal, sem artefato/PII) → nenhum finding", () => {
    const nameStatus = [{ status: "M", path: "scripts/lib/brevo-diaria-store.ts" }];
    const addedLines = new Map([
      ["scripts/lib/brevo-diaria-store.ts", ["export function foo() { return 1; }"]],
    ]);
    assert.deepEqual(findDangerousDiffContent(nameStatus, addedLines), []);
  });

  it("e-mail adicionado em arquivo de FIXTURE declarado → não acusa", () => {
    const nameStatus = [{ status: "A", path: "test/fixtures/emails.json" }];
    const addedLines = new Map([
      ["test/fixtures/emails.json", ['{ "email": "fulano@example.com" }']],
    ]);
    assert.deepEqual(findDangerousDiffContent(nameStatus, addedLines), []);
  });

  it("e-mail adicionado em test/**.test.ts → não acusa", () => {
    const nameStatus = [{ status: "M", path: "test/some.test.ts" }];
    const addedLines = new Map([
      ["test/some.test.ts", ['assert.equal(x, "foo@bar.com");']],
    ]);
    assert.deepEqual(findDangerousDiffContent(nameStatus, addedLines), []);
  });

  it("modificação de arquivo já existente que JÁ TINHA e-mails, mas a linha ADICIONADA não introduz nenhum → não acusa", () => {
    // Simula platform.config.json: o arquivo tem dezenas de e-mails
    // pré-existentes, mas esta PR só adiciona uma linha sem e-mail.
    const nameStatus = [{ status: "M", path: "platform.config.json" }];
    const addedLines = new Map([["platform.config.json", ['"newsletter": "beehiiv"']]]);
    assert.deepEqual(findDangerousDiffContent(nameStatus, addedLines), []);
  });

  it("modificação que ADICIONA uma linha com e-mail novo fora de fixture → acusa", () => {
    const nameStatus = [{ status: "M", path: "scripts/lib/editor-copy.ts" }];
    const addedLines = new Map([
      ["scripts/lib/editor-copy.ts", ['export const NOTIFY = "novo.assinante@exemplo.com";']],
    ]);
    const findings = findDangerousDiffContent(nameStatus, addedLines);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "pii-email");
  });

  it("arquivo deletado (status D) nunca gera finding de runtime-artifact mesmo com path suspeito", () => {
    const nameStatus = [{ status: "D", path: "scripts/_tmp_old/x.json" }];
    assert.deepEqual(findDangerousDiffContent(nameStatus, new Map()), []);
  });
});

describe("buildDenyMessage (#6753)", () => {
  it("nunca imprime o e-mail em si — só path + contagem", () => {
    const msg = buildDenyMessage([
      { path: "a.json", kind: "pii-email", detail: "1 linha(s) adicionada(s) com padrão de e-mail" },
    ]);
    assert.ok(msg.includes("a.json"));
    assert.ok(!msg.includes("@"));
  });

  it("lista múltiplos findings", () => {
    const msg = buildDenyMessage([
      { path: "a.json", kind: "runtime-artifact", detail: "d1" },
      { path: "b.json", kind: "pii-email", detail: "d2" },
    ]);
    assert.ok(msg.includes("a.json"));
    assert.ok(msg.includes("b.json"));
  });
});
