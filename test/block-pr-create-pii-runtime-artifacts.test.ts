import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isGhPrCreateCommand,
  containsShellWrappedGhPrCreate,
  isRuntimeArtifactPath,
  isFixturePath,
  parseNameStatus,
  parseAddedLinesByFile,
  findDangerousDiffContent,
  buildDenyMessage,
  EMAIL_RE,
  isAllowlistedEmailLine,
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

  // Fleet review pós-PR #6776, finding 1: `stripQuotedSpans` removia o
  // argumento de `bash -c "..."`/`sh -c "..."`, deixando um `gh pr create`
  // REAL (não uma citação) passar despercebido.
  it("#6776-finding-1: detecta gh pr create embrulhado em bash -c/sh -c/zsh -c", () => {
    assert.equal(isGhPrCreateCommand('bash -c "gh pr create --title x --body y"'), true);
    assert.equal(isGhPrCreateCommand("sh -c 'gh pr create --title x'"), true);
    assert.equal(isGhPrCreateCommand('zsh -c "gh pr create --title x"'), true);
    assert.equal(isGhPrCreateCommand('bash --command="gh pr create --title x"'), true);
  });

  it("#6776-finding-1: citação pura (sem interpretador -c) continua não-detectada", () => {
    assert.equal(isGhPrCreateCommand('echo "gh pr create seria bloqueado aqui"'), false);
  });
});

describe("containsShellWrappedGhPrCreate (#6776 finding 1)", () => {
  it("true só quando HÁ interpretador -c/--command E gh pr create dentro", () => {
    assert.equal(containsShellWrappedGhPrCreate('bash -c "gh pr create --title x"'), true);
    assert.equal(containsShellWrappedGhPrCreate('bash -c "echo hi"'), false);
    assert.equal(containsShellWrappedGhPrCreate("gh pr create --title x"), false);
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

  // Fleet review pós-PR #6776, finding 2: o padrão anterior de "dump" era
  // substring livre e colidia com um arquivo real do repo.
  it("#6776-finding-2: NÃO acusa scripts/dump-worker-logs.ts (arquivo real do repo, 'dump' é prefixo)", () => {
    assert.equal(isRuntimeArtifactPath("scripts/dump-worker-logs.ts"), false);
  });

  it("#6776-finding-2: ainda acusa 'dump' como sufixo de arquivo ou diretório inteiro", () => {
    assert.equal(isRuntimeArtifactPath("scripts/engagement-dump.json"), true);
    assert.equal(isRuntimeArtifactPath("scripts/engagement_dump.json"), true);
    assert.equal(isRuntimeArtifactPath("scripts/dump/data.json"), true);
    assert.equal(isRuntimeArtifactPath("dump.json"), true);
  });

  // Fleet review pós-PR #6776, finding 3: a forma DIRETÓRIO de "-backup"
  // já era coberta; faltava a forma ARQUIVO bare (sem diretório dedicado).
  it("#6776-finding-3: acusa arquivo bare *-backup.ext / *_backups.ext (sem diretório dedicado)", () => {
    assert.equal(isRuntimeArtifactPath("scripts/subscribers-backup.json"), true);
    assert.equal(isRuntimeArtifactPath("scripts/subscribers_backups.csv"), true);
  });

  it("#6776-finding-3: NÃO acusa arquivo cujo nome só começa com 'backup-' (prefixo, não sufixo)", () => {
    assert.equal(isRuntimeArtifactPath("scripts/lib/backup-strategy.ts"), false);
  });

  // #6971 — Direção 3 ("parar de usar o checkout como área de rascunho entre
  // sessões"): estes são os nomes de arquivo REAIS achados soltos na raiz do
  // checkout compartilhado no `git status` da rodada 01-02/09/2026, mais o
  // nome exato do arquivo do incidente de origem da issue. Não bloqueiam a
  // ESCRITA (nenhum hook cobre isso — ver docblock do #6971 em
  // block-unsafe-shared-checkout-ops.mjs), mas barram que virem parte da PR.
  it("#6971: acusa arquivo bare *_tmp.ext (sufixo — forma que o prefixo _tmp_ não cobria)", () => {
    assert.equal(isRuntimeArtifactPath("all_issues_tmp.json"), true);
    assert.equal(isRuntimeArtifactPath("rest_issues_tmp.json"), true);
  });

  it("#6971: acusa scratch-*.ext solto na raiz (scratch-drift.ts, achado ao vivo)", () => {
    assert.equal(isRuntimeArtifactPath("scratch-drift.ts"), true);
    assert.equal(isRuntimeArtifactPath("scratch_notes.md"), true);
  });

  it("#6971: acusa .prNNNN-review.md — nome exato do arquivo apagado no incidente de origem", () => {
    assert.equal(isRuntimeArtifactPath(".pr6950-review.md"), true);
    assert.equal(isRuntimeArtifactPath(".pr123-review.md"), true);
  });

  it("#6971: acusa _prbody*/_commitmsg* — corpo de PR/commit rascunhado em arquivo solto", () => {
    assert.equal(isRuntimeArtifactPath("_prbody.md"), true);
    assert.equal(isRuntimeArtifactPath("_commitmsg.txt"), true);
  });

  it("#6971: NÃO acusa arquivo de código-fonte real cujo nome só contém 'scratch'/'tmp' como parte de outra palavra", () => {
    assert.equal(isRuntimeArtifactPath("scripts/lib/scratchpad-cleanup.ts"), false); // "scratch" sem -/_/. logo depois
    assert.equal(isRuntimeArtifactPath("scripts/lib/tmpdir-helper.ts"), false); // "tmp" sem "_" antes / "." logo depois
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

// ─── #7217: allowlist de placeholder / domínio reservado ───────────────────
//
// Achado ao vivo (#7101/#7102/#7103, 02/09/2026): `seu@email.com` é o
// `placeholder=` do campo de e-mail do formulário de inscrição, embutido no
// HTML de TODA página de hub gerada. Como esses arquivos são gerados,
// qualquer regen desloca linhas e faz o placeholder contar como "linha
// adicionada" — o guard barrava a PR inteira por uma string que já estava em
// master. Não era falso positivo pontual: era bloqueio PERMANENTE de toda PR
// de regen de hub.
//
// A allowlist é de LITERAIS (mais domínios reservados por RFC 2606), nunca de
// path nem de padrão — os testes abaixo travam justamente que um e-mail real
// continua sendo pego, inclusive na mesma linha de um permitido.

describe("isAllowlistedEmailLine (#7217)", () => {
  it("linha só com o placeholder do formulário -> permitida", () => {
    const line = '  <input type="email" name="email" placeholder="seu@email.com" aria-label="E-mail">';
    assert.equal(isAllowlistedEmailLine(line), true);
  });

  it("REGRESSÃO: e-mail REAL na MESMA linha do placeholder -> continua barrada", () => {
    // O caso que decide se a allowlist enfraquece o guard ou não.
    const line = '<input placeholder="seu@email.com"> <!-- contato: fulano.real@gmail.com -->';
    assert.equal(isAllowlistedEmailLine(line), false);
  });

  it("REGRESSÃO: domínio reservado (.invalid/.test/example.com) NÃO é dispensado", () => {
    // A 1ª versão desta allowlist dispensava domínio reservado por RFC 2606
    // e derrubou o teste de reconstituição do incidente (#6753), cuja
    // fixture usa `@exemplo-teste.invalid` pra não versionar PII real: o
    // guard PRECISA continuar acusando ali, porque no incidente verdadeiro
    // aqueles endereços eram reais. Regra por domínio cegaria o guard pro
    // próprio formato que ele existe pra pegar.
    assert.equal(isAllowlistedEmailLine("sintetico.fixture@exemplo-teste.invalid"), false);
    assert.equal(isAllowlistedEmailLine("const exemplo = 'qualquer.coisa@example.com';"), false);
    assert.equal(isAllowlistedEmailLine("y@bar.test"), false);
  });

  it("e-mail em domínio REAL não entra, mesmo parecendo de teste", () => {
    // Endereço "de teste" em domínio real é PII em potencial — o caminho
    // certo pra isso é path de fixture (`isFixturePath`), não a allowlist.
    assert.equal(isAllowlistedEmailLine("teste123@gmail.com"), false);
    assert.equal(isAllowlistedEmailLine("qa@diar.ia.br"), false);
  });

  it("linha sem e-mail nenhum -> permitida (não é o caso de uso, mas não pode lançar)", () => {
    assert.equal(isAllowlistedEmailLine("const x = 1;"), true);
    assert.equal(isAllowlistedEmailLine(""), true);
  });

  it("entrada não-string nunca lança", () => {
    assert.equal(isAllowlistedEmailLine(undefined), false);
    assert.equal(isAllowlistedEmailLine(null), false);
  });
});

describe("findDangerousDiffContent com allowlist (#7217)", () => {
  it("REGRESSÃO do caso real: hub gerado com só o placeholder NÃO gera finding", () => {
    const nameStatus = [{ status: "M", path: "workers/arquivo/src/hubs/anthropic-claude.generated.ts" }];
    const addedLines = new Map([
      [
        "workers/arquivo/src/hubs/anthropic-claude.generated.ts",
        ['  <label class=\\"cta-field\\"><input type=\\"email\\" placeholder=\\"seu@email.com\\" ...>'],
      ],
    ]);
    assert.deepEqual(findDangerousDiffContent(nameStatus, addedLines), []);
  });

  it("o mesmo arquivo com e-mail REAL continua gerando finding pii-email", () => {
    const nameStatus = [{ status: "M", path: "workers/arquivo/src/hubs/anthropic-claude.generated.ts" }];
    const addedLines = new Map([
      [
        "workers/arquivo/src/hubs/anthropic-claude.generated.ts",
        ['placeholder=\\"seu@email.com\\"', 'const assinante = "pessoa.real@gmail.com";'],
      ],
    ]);
    const findings = findDangerousDiffContent(nameStatus, addedLines);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "pii-email");
    // Conta 1 linha, não 2 — a do placeholder foi dispensada.
    assert.match(findings[0].detail, /^1 linha/);
  });
});

describe("isAllowlistedEmailLine — contrabando por substring (#7244, review da PR #7245)", () => {
  // O review perguntou se dá pra esconder e-mail real ao redor do literal
  // permitido. Dá NÃO, porque o match de `EMAIL_RE` é do TOKEN INTEIRO e
  // guloso: `notseu@email.com` casa inteiro e não bate nenhum literal, então
  // nada é removido e a linha segue barrada. Isso funciona hoje por
  // propriedade do `EMAIL_RE`, não por código desta allowlist — e é
  // exatamente por isso que precisa de teste: afrouxar o local-part de
  // `EMAIL_RE` no futuro reabriria o bypass sem nada acusar.
  it("prefixo colado no literal permitido -> continua barrado", () => {
    assert.equal(isAllowlistedEmailLine("notseu@email.com"), false);
    assert.equal(isAllowlistedEmailLine("jose.seu@email.com"), false);
  });

  it("sufixo de domínio colado no literal permitido -> continua barrado", () => {
    assert.equal(isAllowlistedEmailLine("seu@email.com.br"), false);
    assert.equal(isAllowlistedEmailLine("seu@email.computador.org"), false);
  });

  it("sub-endereçamento (+tag) no literal permitido -> continua barrado", () => {
    assert.equal(isAllowlistedEmailLine("x+seu@email.com"), false);
  });

  it("o literal EXATO segue permitido, inclusive com caixa diferente", () => {
    assert.equal(isAllowlistedEmailLine("seu@email.com"), true);
    assert.equal(isAllowlistedEmailLine("SEU@EMAIL.COM"), true);
  });
});
