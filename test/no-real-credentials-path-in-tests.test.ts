/**
 * test/no-real-credentials-path-in-tests.test.ts (#4344)
 *
 * Regressão: `test/drive-sync.test.ts`, `test/drive-helpers.test.ts` e
 * `test/inbox-drain.test.ts` escreviam credenciais OAuth FAKE diretamente no
 * path REAL de `data/.credentials.json` (gitignored, compartilhado via
 * OneDrive entre máquinas) em `beforeEach`/`afterEach`, contando com um dance
 * de "salvar conteúdo original → sobrescrever com fake → restaurar" que só é
 * seguro se NADA mais tocar o mesmo arquivo durante a janela do teste.
 *
 * `node --test` roda arquivos de teste em paralelo (múltiplos processos) —
 * se outro processo de teste (ou uma sessão real na mesma máquina) tocasse o
 * arquivo durante essa janela, ou se a run fosse morta entre o `beforeEach` e
 * o `afterEach` (timeout, Ctrl-C), o arquivo REAL ficava permanentemente
 * corrompido com o conteúdo fake — sem nenhum erro visível na hora, porque os
 * testes em si passam (testam contra o fake que acabaram de escrever).
 * Aconteceu de verdade em 260730 (#4344): `data/.credentials.json` da máquina
 * do editor virou `{"client_id":"fake",...}` e quebrou Drive sync,
 * inbox-drain e upload de imagens sociais até re-autenticação manual.
 *
 * O fix (#4344) trocou os 3 arquivos acima pra escrever o fake num dir
 * temporário próprio (`mkdtempSync`) e apontar `google-auth.ts` pra lá via
 * `CREDENTIALS_PATH_TEST_OVERRIDE_ENV` (env var, resolvido dinamicamente a
 * cada chamada dentro do módulo — nunca um `const` capturado no import).
 *
 * Este teste é a rede ESTÁTICA e GENÉRICA (mesmo padrão de
 * `test/scheduled-task-registration.test.ts`, #3764): varre TODO
 * `test/*.test.ts` (não uma lista fixa) e reprova qualquer `writeFileSync`
 * que aponte pro path literal de `data/.credentials.json` fora de um dir
 * `mkdtempSync`'d — assim um arquivo de teste FUTURO não reabre a mesma
 * classe de bug (e o gap não fica restrito aos 3 arquivos corrigidos agora,
 * do jeito que #3764 achou o mesmo bug do #3560/#3757 intocado em outros 2
 * scripts que a lista fixa original não cobria).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = join(ROOT, "test");
// Este próprio arquivo cita os padrões ofensores (em regex e em prosa) pra
// documentar o que procura — exclui-se do próprio scan pra não se auto-acusar.
const SELF = resolve(fileURLToPath(import.meta.url));

/** Lista .test.ts recursivamente sob test/ (mesmo padrão de ps1FilesUnder em scheduled-task-registration.test.ts). */
function testFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...testFilesUnder(full));
    else if (name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Remove comentários `//` e `/* *\/` pra não confundir o scan com prosa/exemplos. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * Acha variáveis declaradas apontando pro path REAL de `data/.credentials.json`
 * (ex: `const CREDS_PATH = resolve(ROOT, "data", ".credentials.json");`).
 * A declaração em si não é a violação — só usá-la como alvo de `writeFileSync` é.
 */
function realCredentialsPathVarNames(source: string): string[] {
  const re =
    /(?:const|let)\s+(\w+)\s*=\s*(?:resolve|join)\([^;]*?["'`]data["'`][^;]*?\.credentials\.json[^;]*?\)/g;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) names.push(m[1]);
  return names;
}

describe("nenhum test/*.test.ts escreve fake creds no data/.credentials.json REAL (#4344)", () => {
  const files = testFilesUnder(TEST_DIR).filter((f) => resolve(f) !== SELF);

  it("sanity: encontrou vários arquivos test/*.test.ts (senão o scan está quebrado)", () => {
    assert.ok(
      files.length > 5,
      `esperava vários .test.ts sob ${TEST_DIR}, achou ${files.length} — este teste deixaria de proteger silenciosamente.`,
    );
  });

  for (const file of files) {
    const rel = file.slice(ROOT.length + 1).replaceAll("\\", "/");
    const rawSource = readFileSync(file, "utf8");
    const source = stripComments(rawSource);

    it(`${rel}: nunca escreve em data/.credentials.json REAL via writeFileSync`, () => {
      const offenders: string[] = [];
      let m: RegExpExecArray | null;

      // 1. Construção inline: writeFileSync(resolve(ROOT, "data", ".credentials.json"), ...)
      const inlineRe =
        /writeFileSync\(\s*(?:resolve|join)\([^)]*?["'`]data["'`][^)]*?\.credentials\.json[^)]*?\)/g;
      while ((m = inlineRe.exec(source))) offenders.push(m[0]);

      // 2. Literal puro: writeFileSync("data/.credentials.json", ...) ou "data\.credentials.json"
      const literalRe = /writeFileSync\(\s*["'`][^"'`]*data[\\/]\.credentials\.json["'`]/g;
      while ((m = literalRe.exec(source))) offenders.push(m[0]);

      // 3. Via variável declarada com o path real (ex: const CREDS_PATH = resolve(...))
      for (const varName of realCredentialsPathVarNames(source)) {
        const varRe = new RegExp(`writeFileSync\\(\\s*${varName}\\b`, "g");
        while ((m = varRe.exec(source))) offenders.push(m[0]);
      }

      assert.deepEqual(
        offenders,
        [],
        `escrita direta em data/.credentials.json REAL detectada em ${rel} — use ` +
          `mkdtempSync + CREDENTIALS_PATH_TEST_OVERRIDE_ENV (scripts/google-auth.ts) em vez ` +
          `disso (ver test/drive-sync.test.ts pro padrão, #4344). Ofensores:\n${offenders.join("\n")}`,
      );
    });
  }
});

/**
 * Generalização do guard acima (#4396, segue #4369) — `test/inbox-drain.test.ts`
 * isolou 3 paths reais adicionais em dirs `mkdtempSync` (`platform.config.json`
 * na raiz do repo — git-tracked! — e `data/inbox-cursor.json`/`data/inbox.md`),
 * mas sem rede estática genérica equivalente à de `data/.credentials.json`
 * acima. Um arquivo de teste FUTURO poderia reintroduzir a mesma classe de bug
 * (#4344) contra qualquer um desses 3 paths sem que ninguém notasse.
 *
 * O regex de `data/.credentials.json` é moldado especificamente pra essa
 * estrutura (sempre sob `data/`) — `platform.config.json` mora na raiz do
 * repo, então generalizar limpo exige um padrão por nome de arquivo, não uma
 * extensão direta do regex existente (ver corpo da issue #4396).
 */
interface RealPathTarget {
  /** Nome legível do path real, usado nas mensagens de erro/nomes de teste. */
  label: string;
  /** `writeFileSync(resolve(...)/join(...))` construído inline com o path real. */
  inlineRe: RegExp;
  /** `writeFileSync("literal/do/path/real")`. */
  literalRe: RegExp;
  /** `const X = resolve(...)` apontando pro path real — variável usada depois em `writeFileSync(X, ...)`. */
  varDeclRe: RegExp;
  /** Dica de como isolar corretamente (env var de override + mkdtempSync), citada no assert. */
  guidance: string;
}

// Nota (#4396): diferente de `data/.credentials.json` acima (onde o literal
// "data" na chamada resolve/join já distingue path real de dir fake, porque
// fixtures fake nunca usam esse literal), `platform.config.json` mora na raiz
// do repo — SEM segmento distintivo — e vários testes legítimos (ex:
// test/studio-integrations.test.ts) criam um dir fake via `mkdtempSync` e
// escrevem `join(root, "platform.config.json")`/`join(root, "data", "inbox-cursor.json")`
// dentro dele, usando a variável local (lowercase) `root`. Detectado ao vivo:
// generalizar sem ancorar em algo mais específico gerou falso-positivo maciço
// contra esse padrão legítimo. A convenção do repo (confirmada por grep em
// ~35 arquivos test/*.test.ts, ex: test/inbox-drain.test.ts:77,
// test/drive-sync.test.ts:36) é usar SEMPRE o identificador exato `ROOT`
// (maiúsculo) pro path real do repo — nunca pra um dir `mkdtempSync` fake.
// Os padrões abaixo exigem esse identificador exato como argumento de
// resolve/join — `join(root, ...)` (minúsculo, fake) nunca casa.
// Fatores comuns dos 4 gaps identificados no #4403 (regex casava só 3 formas
// específicas de chamada e deixava escapar outras 4 formas de escrever o
// mesmo path real):
//   1. Segmento combinado numa string só — `resolve(ROOT, "data/inbox-cursor.json")`
//      em vez de 2 segmentos `resolve(ROOT, "data", "inbox-cursor.json")`.
//      Fechado abaixo: as 2 targets sob `data/` ganham uma alternativa que
//      casa a string combinada (com `/` OU `\`) além da forma 2-segmentos.
//   2. `path.resolve(ROOT, ...)`/`path.join(ROOT, ...)` (namespace-qualified)
//      — o regex exigia `resolve(`/`join(` imediatamente após `writeFileSync(`;
//      um prefixo `path.` quebrava a adjacência. Fechado abaixo: prefixo
//      `(?:path\.)?` opcional antes de `resolve|join` nas 3 targets (inline e
//      varDecl) — não afeta o discriminador ROOT/root (o prefixo `path.` não
//      muda a exigência do identificador exato `ROOT` logo em seguida).
//   3. Concatenação de string (`ROOT + "/data/..."`) e 4. path real sem citar
//      `ROOT` (`resolve(__dirname, "..", "data", "...")`) ficam FORA DE
//      ESCOPO aqui — exigiriam parse de AST pra fechar sem estourar
//      falso-positivo (ver corpo do #4403).
const REAL_PATH_TARGETS: RealPathTarget[] = [
  {
    label: "platform.config.json",
    inlineRe:
      /writeFileSync\(\s*(?:path\.)?(?:resolve|join)\(\s*ROOT\b[^)]*?["'`]platform\.config\.json["'`][^)]*?\)/g,
    literalRe: /writeFileSync\(\s*["'`][^"'`]*platform\.config\.json["'`]/g,
    varDeclRe:
      /(?:const|let)\s+(\w+)\s*=\s*(?:path\.)?(?:resolve|join)\(\s*ROOT\b[^;]*?["'`]platform\.config\.json["'`][^;]*?\)/g,
    guidance:
      "use CONFIG_PATH_TEST_OVERRIDE_ENV (scripts/inbox-drain.ts) + mkdtempSync em vez de " +
      "escrever no platform.config.json real (raiz do repo, git-tracked!) — ver " +
      "test/inbox-drain.test.ts pro padrão, #4369/#4396.",
  },
  {
    label: "data/inbox-cursor.json",
    inlineRe:
      /writeFileSync\(\s*(?:path\.)?(?:resolve|join)\(\s*ROOT\b[^)]*?(?:["'`]data["'`][^)]*?inbox-cursor\.json|["'`]data[\\/]inbox-cursor\.json["'`])[^)]*?\)/g,
    literalRe: /writeFileSync\(\s*["'`][^"'`]*data[\\/]inbox-cursor\.json["'`]/g,
    varDeclRe:
      /(?:const|let)\s+(\w+)\s*=\s*(?:path\.)?(?:resolve|join)\(\s*ROOT\b[^;]*?(?:["'`]data["'`][^;]*?inbox-cursor\.json|["'`]data[\\/]inbox-cursor\.json["'`])[^;]*?\)/g,
    guidance:
      "use INBOX_CURSOR_PATH_TEST_OVERRIDE_ENV (scripts/inbox-drain.ts) + mkdtempSync em vez " +
      "de escrever no data/inbox-cursor.json real — ver test/inbox-drain.test.ts pro padrão, " +
      "#4369/#4396.",
  },
  {
    label: "data/inbox.md",
    inlineRe:
      /writeFileSync\(\s*(?:path\.)?(?:resolve|join)\(\s*ROOT\b[^)]*?(?:["'`]data["'`][^)]*?inbox\.md|["'`]data[\\/]inbox\.md["'`])[^)]*?\)/g,
    literalRe: /writeFileSync\(\s*["'`][^"'`]*data[\\/]inbox\.md["'`]/g,
    varDeclRe:
      /(?:const|let)\s+(\w+)\s*=\s*(?:path\.)?(?:resolve|join)\(\s*ROOT\b[^;]*?(?:["'`]data["'`][^;]*?inbox\.md|["'`]data[\\/]inbox\.md["'`])[^;]*?\)/g,
    guidance:
      "use INBOX_MD_PATH_TEST_OVERRIDE_ENV (scripts/inbox-drain.ts) + mkdtempSync em vez de " +
      "escrever no data/inbox.md real — ver test/inbox-drain.test.ts pro padrão, #4369/#4396.",
  },
];

/** Acha ofensores (inline / literal / via variável) de `target` em `source` já sem comentários. */
function findOffendersForTarget(source: string, target: RealPathTarget): string[] {
  const offenders: string[] = [];
  let m: RegExpExecArray | null;

  const inlineRe = new RegExp(target.inlineRe.source, target.inlineRe.flags);
  while ((m = inlineRe.exec(source))) offenders.push(m[0]);

  const literalRe = new RegExp(target.literalRe.source, target.literalRe.flags);
  while ((m = literalRe.exec(source))) offenders.push(m[0]);

  const varDeclRe = new RegExp(target.varDeclRe.source, target.varDeclRe.flags);
  const varNames: string[] = [];
  let vm: RegExpExecArray | null;
  while ((vm = varDeclRe.exec(source))) varNames.push(vm[1]);
  for (const varName of varNames) {
    const varRe = new RegExp(`writeFileSync\\(\\s*${varName}\\b`, "g");
    while ((m = varRe.exec(source))) offenders.push(m[0]);
  }

  return offenders;
}

describe("nenhum test/*.test.ts escreve fake conteúdo em platform.config.json/data/inbox-cursor.json/data/inbox.md REAIS (#4396, segue #4344/#4369)", () => {
  const files = testFilesUnder(TEST_DIR).filter((f) => resolve(f) !== SELF);

  it("sanity: encontrou vários arquivos test/*.test.ts (senão o scan está quebrado)", () => {
    assert.ok(
      files.length > 5,
      `esperava vários .test.ts sob ${TEST_DIR}, achou ${files.length} — este teste deixaria de proteger silenciosamente.`,
    );
  });

  for (const target of REAL_PATH_TARGETS) {
    for (const file of files) {
      const rel = file.slice(ROOT.length + 1).replaceAll("\\", "/");
      const rawSource = readFileSync(file, "utf8");
      const source = stripComments(rawSource);

      it(`${rel}: nunca escreve em ${target.label} REAL via writeFileSync`, () => {
        const offenders = findOffendersForTarget(source, target);
        assert.deepEqual(
          offenders,
          [],
          `escrita direta em ${target.label} REAL detectada em ${rel} — ${target.guidance} ` +
            `Ofensores:\n${offenders.join("\n")}`,
        );
      });
    }
  }
});

describe("fixtures inline: o guard genérico (#4396) pega arquivo de teste FICTÍCIO ofensor", () => {
  for (const target of REAL_PATH_TARGETS) {
    it(`${target.label}: construção inline writeFileSync(resolve(...)) é detectada`, () => {
      const fakeSource =
        target.label === "platform.config.json"
          ? `writeFileSync(resolve(ROOT, "platform.config.json"), JSON.stringify({}), "utf8");`
          : target.label === "data/inbox-cursor.json"
            ? `writeFileSync(resolve(ROOT, "data", "inbox-cursor.json"), "{}", "utf8");`
            : `writeFileSync(resolve(ROOT, "data", "inbox.md"), "conteudo", "utf8");`;

      const offenders = findOffendersForTarget(fakeSource, target);
      assert.ok(
        offenders.length > 0,
        `esperava que o guard pegasse construção inline pra ${target.label}, mas não achou nada em: ${fakeSource}`,
      );
    });

    it(`${target.label}: literal writeFileSync("...") é detectado`, () => {
      const fakeSource =
        target.label === "platform.config.json"
          ? `writeFileSync("platform.config.json", "{}", "utf8");`
          : target.label === "data/inbox-cursor.json"
            ? `writeFileSync("data/inbox-cursor.json", "{}", "utf8");`
            : `writeFileSync("data/inbox.md", "conteudo", "utf8");`;

      const offenders = findOffendersForTarget(fakeSource, target);
      assert.ok(
        offenders.length > 0,
        `esperava que o guard pegasse literal pra ${target.label}, mas não achou nada em: ${fakeSource}`,
      );
    });

    it(`${target.label}: escrita via variável declarada com o path real é detectada`, () => {
      const fakeSource =
        target.label === "platform.config.json"
          ? `const CONFIG_PATH = resolve(ROOT, "platform.config.json");\nwriteFileSync(CONFIG_PATH, "{}", "utf8");`
          : target.label === "data/inbox-cursor.json"
            ? `const CURSOR_PATH = resolve(ROOT, "data", "inbox-cursor.json");\nwriteFileSync(CURSOR_PATH, "{}", "utf8");`
            : `const INBOX_MD_PATH = resolve(ROOT, "data", "inbox.md");\nwriteFileSync(INBOX_MD_PATH, "conteudo", "utf8");`;

      const offenders = findOffendersForTarget(fakeSource, target);
      assert.ok(
        offenders.length > 0,
        `esperava que o guard pegasse escrita via variável pra ${target.label}, mas não achou nada em: ${fakeSource}`,
      );
    });
  }

  it("negativo: padrão real de test/inbox-drain.test.ts (fake dir via mkdtempSync) NÃO é flagado", () => {
    // Reproduz o padrão legítimo usado em test/inbox-drain.test.ts: o path real
    // nunca é construído com resolve/join do REPO ROOT — é só um nome de
    // arquivo dentro do dir fake, via função helper (fakeConfigPath() etc.).
    const legitSource = `
      const fakeInboxDir = mkdtempSync(join(tmpdir(), "inbox-drain-paths-"));
      function fakeConfigPath() { return join(fakeInboxDir, "platform.config.json"); }
      function fakeCursorPath() { return join(fakeInboxDir, "inbox-cursor.json"); }
      function fakeInboxMdPath() { return join(fakeInboxDir, "inbox.md"); }
      writeFileSync(fakeConfigPath(), JSON.stringify({}), "utf8");
      writeFileSync(fakeCursorPath(), JSON.stringify({ last_drain_iso: null }), "utf8");
      writeFileSync(fakeInboxMdPath(), "conteudo", "utf8");
    `;

    for (const target of REAL_PATH_TARGETS) {
      const offenders = findOffendersForTarget(legitSource, target);
      assert.deepEqual(
        offenders,
        [],
        `padrão legítimo (mkdtempSync + helper) foi falso-positivo pra ${target.label}: ${offenders.join("\n")}`,
      );
    }
  });
});

describe("fixtures inline: gap 1 do #4403 — segmento 'data/arquivo' combinado numa string só é detectado", () => {
  // Só as 2 targets sob `data/` têm esse gap — `platform.config.json` mora na
  // raiz do repo (já é 1 segmento só, forma já coberta antes do #4403).
  const targetsWithDataPrefix = REAL_PATH_TARGETS.filter((t) => t.label !== "platform.config.json");

  for (const target of targetsWithDataPrefix) {
    const combinedSuffix = target.label === "data/inbox-cursor.json" ? "inbox-cursor.json" : "inbox.md";

    it(`${target.label}: writeFileSync(resolve(ROOT, "data/${combinedSuffix}"), ...) — string combinada com "/" é detectada`, () => {
      const fakeSource = `writeFileSync(resolve(ROOT, "data/${combinedSuffix}"), "conteudo", "utf8");`;
      const offenders = findOffendersForTarget(fakeSource, target);
      assert.ok(
        offenders.length > 0,
        `esperava que o guard pegasse a string combinada pra ${target.label}, mas não achou nada em: ${fakeSource}`,
      );
    });

    it(`${target.label}: writeFileSync(join(ROOT, "data\\${combinedSuffix}"), ...) — string combinada com barra invertida é detectada`, () => {
      // Uma só barra invertida em runtime exige 2 caracteres `\` no source
      // (escape de template literal) — `\\` aqui vira 1 `\` no valor de fakeSource.
      const fakeSource = `writeFileSync(join(ROOT, "data\\${combinedSuffix}"), "conteudo", "utf8");`;
      const offenders = findOffendersForTarget(fakeSource, target);
      assert.ok(
        offenders.length > 0,
        `esperava que o guard pegasse a string combinada (barra invertida) pra ${target.label}, mas não achou nada em: ${fakeSource}`,
      );
    });

    it(`${target.label}: escrita via variável declarada com string combinada é detectada`, () => {
      const fakeSource = `const P = resolve(ROOT, "data/${combinedSuffix}");\nwriteFileSync(P, "conteudo", "utf8");`;
      const offenders = findOffendersForTarget(fakeSource, target);
      assert.ok(
        offenders.length > 0,
        `esperava que o guard pegasse escrita via variável com string combinada pra ${target.label}, mas não achou nada em: ${fakeSource}`,
      );
    });

    it(`${target.label}: forma 2-segmentos original continua detectada (sem regressão)`, () => {
      const fakeSource = `writeFileSync(resolve(ROOT, "data", "${combinedSuffix}"), "conteudo", "utf8");`;
      const offenders = findOffendersForTarget(fakeSource, target);
      assert.ok(
        offenders.length > 0,
        `regressão: a forma 2-segmentos parou de ser detectada pra ${target.label} em: ${fakeSource}`,
      );
    });
  }
});

describe("fixtures inline: gap 2 do #4403 — path.resolve/path.join namespace-qualified é detectado", () => {
  for (const target of REAL_PATH_TARGETS) {
    const literalArg =
      target.label === "platform.config.json"
        ? `"platform.config.json"`
        : target.label === "data/inbox-cursor.json"
          ? `"data", "inbox-cursor.json"`
          : `"data", "inbox.md"`;

    it(`${target.label}: writeFileSync(path.resolve(ROOT, ...)) é detectado`, () => {
      const fakeSource = `writeFileSync(path.resolve(ROOT, ${literalArg}), "conteudo", "utf8");`;
      const offenders = findOffendersForTarget(fakeSource, target);
      assert.ok(
        offenders.length > 0,
        `esperava que o guard pegasse path.resolve(ROOT, ...) pra ${target.label}, mas não achou nada em: ${fakeSource}`,
      );
    });

    it(`${target.label}: writeFileSync(path.join(ROOT, ...)) é detectado`, () => {
      const fakeSource = `writeFileSync(path.join(ROOT, ${literalArg}), "conteudo", "utf8");`;
      const offenders = findOffendersForTarget(fakeSource, target);
      assert.ok(
        offenders.length > 0,
        `esperava que o guard pegasse path.join(ROOT, ...) pra ${target.label}, mas não achou nada em: ${fakeSource}`,
      );
    });

    it(`${target.label}: escrita via variável declarada com path.resolve(ROOT, ...) é detectada`, () => {
      const fakeSource = `const P = path.resolve(ROOT, ${literalArg});\nwriteFileSync(P, "conteudo", "utf8");`;
      const offenders = findOffendersForTarget(fakeSource, target);
      assert.ok(
        offenders.length > 0,
        `esperava que o guard pegasse variável de path.resolve(ROOT, ...) pra ${target.label}, mas não achou nada em: ${fakeSource}`,
      );
    });
  }

  it("negativo: path.join(root, ...) minúsculo (dir fake) continua NÃO flagado (#4396 preservado)", () => {
    // Confirma que adicionar suporte a `path.resolve`/`path.join` (gap 2) não
    // reabriu o falso-positivo que o #4396 já tinha evitado — o discriminador
    // continua sendo o identificador exato `ROOT` (maiúsculo), não a presença
    // de `path.`.
    const legitSource = `
      const root = mkdtempSync(join(tmpdir(), "fake-root-"));
      writeFileSync(path.join(root, "platform.config.json"), "{}", "utf8");
      writeFileSync(path.join(root, "data", "inbox-cursor.json"), "{}", "utf8");
      writeFileSync(path.resolve(root, "data", "inbox.md"), "conteudo", "utf8");
    `;

    for (const target of REAL_PATH_TARGETS) {
      const offenders = findOffendersForTarget(legitSource, target);
      assert.deepEqual(
        offenders,
        [],
        `path.join/resolve(root minúsculo, ...) foi falso-positivo pra ${target.label}: ${offenders.join("\n")}`,
      );
    }
  });
});
