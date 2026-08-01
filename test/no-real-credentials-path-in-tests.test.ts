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
 *
 * Generalizado em #4396 pra mais 3 paths reais (`platform.config.json`,
 * `data/inbox-cursor.json`, `data/inbox.md`) via `REAL_PATH_TARGETS`
 * data-driven, abaixo. Até o #4417 esse mecanismo genérico convivia com um
 * SEGUNDO mecanismo hand-rolled, algoritmicamente idêntico, dedicado só a
 * `data/.credentials.json` — órfão de quando este teste cobria um único
 * alvo. O #4417 unificou os dois: `data/.credentials.json` virou o 4º
 * `RealPathTarget` (ver o comentário dedicado junto da entrada dele, mais
 * abaixo) e o regex hand-rolled foi removido.
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
 * Um path real que `test/*.test.ts` nunca pode escrever diretamente (fora de
 * um dir `mkdtempSync`'d). Cada alvo define 3 formas de regex que juntas
 * cobrem: construção inline (`writeFileSync(resolve(...))`), literal puro
 * (`writeFileSync("path/literal")`) e via variável declarada antes
 * (`const P = resolve(...); writeFileSync(P, ...)`).
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

// Nota (#4396): `platform.config.json`, `data/inbox-cursor.json` e
// `data/inbox.md` (os 3 primeiros elementos de REAL_PATH_TARGETS, abaixo)
// usam o discriminador `ROOT`/`root` — `platform.config.json` mora na raiz do
// repo, SEM segmento distintivo — e vários testes legítimos (ex:
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
//   3. Concatenação de string (`ROOT + "/data/..."`) fica FORA DE ESCOPO
//      aqui, mas por razão distinta do gap 4 abaixo: provavelmente seria
//      fechável com o mesmo padrão de extensão de regex usado nos gaps 1/2
//      acima, se uma forma canônica de concatenação aparecesse no código de
//      produção do repo — não fechado aqui só porque hoje esse estilo não é
//      usado (mesma razão dada no corpo do #4403), não por limitação
//      estrutural do regex.
//   4. Path real sem citar `ROOT` (`resolve(__dirname, "..", "data", "...")`)
//      é estruturalmente inatingível por regex: sem o identificador `ROOT`
//      no source não há discriminador léxico entre path real e dir fake —
//      fechar isso exigiria parse de AST (rastrear o valor efetivo da
//      variável) pra não estourar falso-positivo.
//
// Nota adicional (#4417): `CREDENTIALS_TARGET` (definido logo abaixo, antes
// do array) é o ÚNICO RealPathTarget que não usa esse discriminador
// ROOT/root — ver o comentário dedicado junto da própria constante pra
// explicar por quê. Por causa dessa diferença de design, os describes de
// gap 1/2/interação mais abaixo neste arquivo (que testam especificamente
// o discriminador ROOT) iteram sobre `ROOT_BASED_TARGETS` em vez de
// `REAL_PATH_TARGETS` diretamente — o motivo exato (não é sobre
// falso-positivo nos testes negativos — esses continuariam passando
// trivialmente) está no comentário junto da declaração de
// `ROOT_BASED_TARGETS`, logo após o array.
// 4º RealPathTarget — data/.credentials.json (#4344, migrado pra cá em
// #4417 a partir de um mecanismo hand-rolled paralelo e algoritmicamente
// idêntico a findOffendersForTarget, abaixo — findCredentialsOffenders +
// CREDENTIALS_INLINE_RE/CREDENTIALS_LITERAL_RE/CREDENTIALS_VAR_DECL_RE,
// que existiam só porque este era o único alvo antes do #4396 generalizar
// pros outros 3 abaixo).
//
// Diferente deles, este alvo NUNCA exigiu o discriminador `ROOT`/`root` —
// e o #4417 preservou essa omissão de propósito ao migrar (a interface
// RealPathTarget já suporta isso nativamente: inlineRe/varDeclRe abaixo
// simplesmente não têm o `\s*ROOT\b` que os 3 abaixo têm). A combinação
// léxica "data" + ".credentials.json" já é específica o suficiente —
// nenhum padrão legítimo do repo usa esse par: o padrão real de dir fake é
// `join(fakeCredsDir, ".credentials.json")`, SEM segmento "data" (ver
// test/drive-sync.test.ts, test/drive-helpers.test.ts,
// test/inbox-drain.test.ts). Adicionar uma exigência de ROOT aqui
// enfraqueceria o guard mais crítico do arquivo (path do incidente de
// produção #4344, P1 — credenciais OAuth reais sobrescritas) sem fechar
// nenhum falso-positivo conhecido — decisão original em #4415, reafirmada
// aqui: fora de escopo mudar esse comportamento só porque o mecanismo virou
// data-driven.
//
// Definido como constante nomeada (diferente dos outros 3 abaixo, que são
// literais inline no array) e referenciado tanto no array quanto em
// ROOT_BASED_TARGETS por identidade de objeto — evita comparação por
// string de label, que seria frágil: um rename futuro do label desincroni-
// zaria ROOT_BASED_TARGETS em SILÊNCIO (o filtro simplesmente pararia de
// excluir o alvo certo, sem erro), enquanto um lookup por identidade não
// tem esse modo de falha.
const CREDENTIALS_TARGET: RealPathTarget = {
  label: "data/.credentials.json",
  inlineRe:
    /writeFileSync\(\s*(?:path\.)?(?:resolve|join)\([^)]*?(?:["'`]data["'`][^)]*?\.credentials\.json|["'`]data[\\/]\.credentials\.json["'`])[^)]*?\)/g,
  literalRe: /writeFileSync\(\s*["'`][^"'`]*data[\\/]\.credentials\.json["'`]/g,
  varDeclRe:
    /(?:const|let)\s+(\w+)\s*=\s*(?:path\.)?(?:resolve|join)\([^;]*?(?:["'`]data["'`][^;]*?\.credentials\.json|["'`]data[\\/]\.credentials\.json["'`])[^;]*?\)/g,
  guidance:
    "use mkdtempSync + CREDENTIALS_PATH_TEST_OVERRIDE_ENV (scripts/google-auth.ts) em vez de " +
    "escrever no data/.credentials.json real — ver test/drive-sync.test.ts pro padrão, #4344.",
};

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
  CREDENTIALS_TARGET,
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

// CREDENTIALS_TARGET (data/.credentials.json) não usa o discriminador
// ROOT/root (ver comentário junto da constante, acima) — os describes de
// gap 1/2/interação mais abaixo testam justamente esse discriminador, então
// iteram sobre este subconjunto (os 3 targets que de fato o exigem) em vez
// de REAL_PATH_TARGETS inteiro. O motivo NÃO é falso-positivo nos testes
// negativos ("ROOT minúsculo não deveria ser flagado") — esses continuariam
// passando trivialmente pra CREDENTIALS_TARGET, já que os fixtures
// negativos nunca citam ".credentials.json". O motivo real: os testes de
// CONSTRUÇÃO POSITIVA de fixture nesses describes usam ternários
// (`target.label === "..." ? ... : ...`) com branch só pros 3 targets
// originais — sem esse filtro, CREDENTIALS_TARGET cairia no branch "else"
// e receberia uma fixture que não bate com o regex de credentials,
// quebrando a asserção positiva (`offenders.length > 0`).
const ROOT_BASED_TARGETS = REAL_PATH_TARGETS.filter((t) => t !== CREDENTIALS_TARGET);

describe("nenhum test/*.test.ts escreve fake conteúdo nos paths REAIS listados em REAL_PATH_TARGETS (#4344/#4396, unificado em #4417)", () => {
  const files = testFilesUnder(TEST_DIR).filter((f) => resolve(f) !== SELF);

  it("sanity: encontrou vários arquivos test/*.test.ts (senão o scan está quebrado)", () => {
    assert.ok(
      files.length > 5,
      `esperava vários .test.ts sob ${TEST_DIR}, achou ${files.length} — este teste deixaria de proteger silenciosamente.`,
    );
  });

  it(
    "sanity: REAL_PATH_TARGETS inclui CREDENTIALS_TARGET (senão data/.credentials.json some da " +
      "varredura real, #4344)",
    () => {
      // A unificação do #4417 trocou o safety-net antigo (comparação por
      // string-label com .find()+throw) por comparação de identidade de
      // objeto em ROOT_BASED_TARGETS (`t !== CREDENTIALS_TARGET`) — mais
      // robusto contra rename, mas sem nenhum runtime-guard equivalente
      // protegendo a composição do próprio array REAL_PATH_TARGETS. Verificado
      // ao vivo (fleet review #4383): remover só a linha `CREDENTIALS_TARGET,`
      // do array faz a suíte cair de 3293 pra 2482 testes, todos os 2482
      // restantes passam — o guard do #4344 pararia de proteger
      // data/.credentials.json SILENCIOSAMENTE (zero teste vermelho). Este
      // teste é a rede que falha alto e explícito nesse cenário.
      assert.ok(
        REAL_PATH_TARGETS.includes(CREDENTIALS_TARGET),
        "CREDENTIALS_TARGET precisa estar em REAL_PATH_TARGETS — a unificação do #4417 depende " +
          "disso pra manter a rede estática do #4344 ativa.",
      );
    },
  );

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

describe("fixtures inline: gap 1 do #4415 — segmento 'data/.credentials.json' combinado numa string só é detectado (mesmo padrão do #4403/#4414)", () => {
  it('writeFileSync(resolve(ROOT, "data/.credentials.json"), ...) — string combinada com "/" é detectada', () => {
    const fakeSource = `writeFileSync(resolve(ROOT, "data/.credentials.json"), "{}", "utf8");`;
    const offenders = findOffendersForTarget(fakeSource, CREDENTIALS_TARGET);
    assert.ok(
      offenders.length > 0,
      `esperava que o guard pegasse a string combinada, mas não achou nada em: ${fakeSource}`,
    );
  });

  it('writeFileSync(join(ROOT, "data\\.credentials.json"), ...) — string combinada com barra invertida é detectada', () => {
    // Uma só barra invertida em runtime exige 2 caracteres `\` no source
    // (escape de template literal) — `\\` aqui vira 1 `\` no valor de fakeSource.
    const fakeSource = `writeFileSync(join(ROOT, "data\\.credentials.json"), "{}", "utf8");`;
    const offenders = findOffendersForTarget(fakeSource, CREDENTIALS_TARGET);
    assert.ok(
      offenders.length > 0,
      `esperava que o guard pegasse a string combinada (barra invertida), mas não achou nada em: ${fakeSource}`,
    );
  });

  it("escrita via variável declarada com string combinada é detectada", () => {
    const fakeSource = `const P = resolve(ROOT, "data/.credentials.json");\nwriteFileSync(P, "{}", "utf8");`;
    const offenders = findOffendersForTarget(fakeSource, CREDENTIALS_TARGET);
    assert.ok(
      offenders.length > 0,
      `esperava que o guard pegasse escrita via variável com string combinada, mas não achou nada em: ${fakeSource}`,
    );
  });

  it("forma 2-segmentos original continua detectada (sem regressão)", () => {
    const fakeSource = `writeFileSync(resolve(ROOT, "data", ".credentials.json"), "{}", "utf8");`;
    const offenders = findOffendersForTarget(fakeSource, CREDENTIALS_TARGET);
    assert.ok(
      offenders.length > 0,
      `regressão: a forma 2-segmentos parou de ser detectada em: ${fakeSource}`,
    );
  });

  it('negativo: padrão real de dir fake join(fakeCredsDir, ".credentials.json") — SEM segmento "data" — não é flagado', () => {
    // Este guard não usa discriminador ROOT/root (ver comentário junto da
    // entrada de data/.credentials.json em REAL_PATH_TARGETS, acima) — o
    // discriminador real é a exigência do segmento literal "data" combinado
    // com ".credentials.json". O padrão legítimo usado em
    // test/drive-sync.test.ts, test/drive-helpers.test.ts e
    // test/inbox-drain.test.ts nunca aninha um segmento "data" dentro do dir
    // fake (fakeCredsDir JÁ representa o dir onde o arquivo fake fica) —
    // confirma que estender pro gap 1 não introduziu falso-positivo nesse
    // padrão real. Este arquivo já sofreu um falso-positivo maciço numa
    // generalização anterior de um guard irmão (ver o comentário "Nota
    // (#4396)" logo antes de REAL_PATH_TARGETS, acima) — exatamente a classe
    // de regressão que este negativo pega cedo.
    const legitSource = `
      const fakeCredsDir = mkdtempSync(join(tmpdir(), "creds-"));
      writeFileSync(join(fakeCredsDir, ".credentials.json"), JSON.stringify(FAKE_CREDS), "utf8");
    `;
    const offenders = findOffendersForTarget(legitSource, CREDENTIALS_TARGET);
    assert.deepEqual(
      offenders,
      [],
      `padrão legítimo (mkdtempSync + fakeCredsDir, sem segmento "data") foi falso-positivo: ${offenders.join("\n")}`,
    );
  });
});

describe("fixtures inline: gap 2 do #4415 — path.resolve/path.join namespace-qualified é detectado (mesmo padrão do #4403/#4414)", () => {
  it('writeFileSync(path.resolve(ROOT, "data", ".credentials.json")) é detectado', () => {
    const fakeSource = `writeFileSync(path.resolve(ROOT, "data", ".credentials.json"), "{}", "utf8");`;
    const offenders = findOffendersForTarget(fakeSource, CREDENTIALS_TARGET);
    assert.ok(
      offenders.length > 0,
      `esperava que o guard pegasse path.resolve(ROOT, ...), mas não achou nada em: ${fakeSource}`,
    );
  });

  it('writeFileSync(path.join(ROOT, "data", ".credentials.json")) é detectado', () => {
    const fakeSource = `writeFileSync(path.join(ROOT, "data", ".credentials.json"), "{}", "utf8");`;
    const offenders = findOffendersForTarget(fakeSource, CREDENTIALS_TARGET);
    assert.ok(
      offenders.length > 0,
      `esperava que o guard pegasse path.join(ROOT, ...), mas não achou nada em: ${fakeSource}`,
    );
  });

  it("escrita via variável declarada com path.resolve(ROOT, ...) é detectada", () => {
    const fakeSource = `const P = path.resolve(ROOT, "data", ".credentials.json");\nwriteFileSync(P, "{}", "utf8");`;
    const offenders = findOffendersForTarget(fakeSource, CREDENTIALS_TARGET);
    assert.ok(
      offenders.length > 0,
      `esperava que o guard pegasse variável de path.resolve(ROOT, ...), mas não achou nada em: ${fakeSource}`,
    );
  });

  it('negativo: path.join(fakeCredsDir, ".credentials.json") — padrão legítimo SEM segmento "data" — continua não flagado', () => {
    const legitSource = `
      const fakeCredsDir = mkdtempSync(join(tmpdir(), "creds-"));
      writeFileSync(path.join(fakeCredsDir, ".credentials.json"), JSON.stringify(FAKE_CREDS), "utf8");
    `;
    const offenders = findOffendersForTarget(legitSource, CREDENTIALS_TARGET);
    assert.deepEqual(
      offenders,
      [],
      `path.join(fakeCredsDir, ...) sem segmento "data" foi falso-positivo: ${offenders.join("\n")}`,
    );
  });
});

describe("fixtures inline: interação gap 1 + gap 2 do #4415 — as duas alternâncias compõem no mesmo regex", () => {
  // Espelha o describe equivalente do #4403/#4414 pros outros 3 alvos —
  // confirma que a alternância do gap 1 (segmento combinado) e o prefixo
  // opcional do gap 2 (`path.`) compõem aditivamente, não só isoladamente.
  it('writeFileSync(path.resolve(ROOT, "data/.credentials.json"), ...) é detectado', () => {
    const fakeSource = `writeFileSync(path.resolve(ROOT, "data/.credentials.json"), "{}", "utf8");`;
    const offenders = findOffendersForTarget(fakeSource, CREDENTIALS_TARGET);
    assert.ok(
      offenders.length > 0,
      `esperava que o guard pegasse a composição gap1+gap2 (path.resolve), mas não achou nada em: ${fakeSource}`,
    );
  });

  it('writeFileSync(path.join(ROOT, "data/.credentials.json"), ...) é detectado', () => {
    const fakeSource = `writeFileSync(path.join(ROOT, "data/.credentials.json"), "{}", "utf8");`;
    const offenders = findOffendersForTarget(fakeSource, CREDENTIALS_TARGET);
    assert.ok(
      offenders.length > 0,
      `esperava que o guard pegasse a composição gap1+gap2 (path.join), mas não achou nada em: ${fakeSource}`,
    );
  });

  it('escrita via variável declarada com path.resolve(ROOT, "data/.credentials.json") é detectada', () => {
    const fakeSource = `const P = path.resolve(ROOT, "data/.credentials.json");\nwriteFileSync(P, "{}", "utf8");`;
    const offenders = findOffendersForTarget(fakeSource, CREDENTIALS_TARGET);
    assert.ok(
      offenders.length > 0,
      `esperava que o guard pegasse variável da composição gap1+gap2, mas não achou nada em: ${fakeSource}`,
    );
  });
});

describe("fixtures inline: o guard genérico (#4396) pega arquivo de teste FICTÍCIO ofensor", () => {
  for (const target of ROOT_BASED_TARGETS) {
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

    for (const target of ROOT_BASED_TARGETS) {
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
  const targetsWithDataPrefix = ROOT_BASED_TARGETS.filter((t) => t.label !== "platform.config.json");

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

    it(`${target.label}: negativo — resolve(root, "data/${combinedSuffix}") com root minúsculo (dir fake) NÃO é flagado`, () => {
      // Confirma que a alternância de string combinada (gap 1) preserva o
      // discriminador ROOT/root — só existia negativo pra forma 2-segmentos
      // (ver o teste negativo dentro do describe "gap 2 do #4403", abaixo)
      // antes deste teste. Este arquivo já sofreu um falso-positivo maciço
      // (~35 arquivos de teste) numa generalização anterior deste mesmo guard
      // (ver o comentário "Nota (#4396)" logo antes de REAL_PATH_TARGETS,
      // acima) — exatamente a classe de regressão que este negativo pega cedo.
      const fakeSource = `const root = mkdtempSync(join(tmpdir(), "fake-root-"));\nwriteFileSync(resolve(root, "data/${combinedSuffix}"), "conteudo", "utf8");`;
      const offenders = findOffendersForTarget(fakeSource, target);
      assert.deepEqual(
        offenders,
        [],
        `string combinada com root minúsculo (dir fake) foi falso-positivo pra ${target.label}: ${offenders.join("\n")}`,
      );
    });
  }
});

describe("fixtures inline: gap 2 do #4403 — path.resolve/path.join namespace-qualified é detectado", () => {
  for (const target of ROOT_BASED_TARGETS) {
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

    for (const target of ROOT_BASED_TARGETS) {
      const offenders = findOffendersForTarget(legitSource, target);
      assert.deepEqual(
        offenders,
        [],
        `path.join/resolve(root minúsculo, ...) foi falso-positivo pra ${target.label}: ${offenders.join("\n")}`,
      );
    }
  });
});

describe("fixtures inline: interação gap 1 + gap 2 do #4403 — as duas alternâncias compõem no mesmo regex", () => {
  // Nenhuma fixture acima exercita as duas formas simultaneamente (segmento
  // combinado numa string só + prefixo `path.` namespace-qualified). Funciona
  // hoje porque as 2 alternâncias (gap 1 no grupo `data/...`, gap 2 no prefixo
  // `(?:path\.)?`) são independentes e compõem aditivamente no mesmo regex —
  // mas sem teste dedicado, uma edição isolada futura numa das alternâncias
  // poderia quebrar a composição sem que nenhum teste existente notasse
  // (cada describe acima só varia uma dimensão por vez).
  const targetsWithDataPrefix = ROOT_BASED_TARGETS.filter((t) => t.label !== "platform.config.json");

  for (const target of targetsWithDataPrefix) {
    const combinedSuffix = target.label === "data/inbox-cursor.json" ? "inbox-cursor.json" : "inbox.md";

    it(`${target.label}: writeFileSync(path.resolve(ROOT, "data/${combinedSuffix}"), ...) é detectado`, () => {
      const fakeSource = `writeFileSync(path.resolve(ROOT, "data/${combinedSuffix}"), "conteudo", "utf8");`;
      const offenders = findOffendersForTarget(fakeSource, target);
      assert.ok(
        offenders.length > 0,
        `esperava que o guard pegasse a composição gap1+gap2 (path.resolve) pra ${target.label}, mas não achou nada em: ${fakeSource}`,
      );
    });

    it(`${target.label}: writeFileSync(path.join(ROOT, "data/${combinedSuffix}"), ...) é detectado`, () => {
      const fakeSource = `writeFileSync(path.join(ROOT, "data/${combinedSuffix}"), "conteudo", "utf8");`;
      const offenders = findOffendersForTarget(fakeSource, target);
      assert.ok(
        offenders.length > 0,
        `esperava que o guard pegasse a composição gap1+gap2 (path.join) pra ${target.label}, mas não achou nada em: ${fakeSource}`,
      );
    });

    it(`${target.label}: escrita via variável declarada com path.resolve(ROOT, "data/${combinedSuffix}") é detectada`, () => {
      const fakeSource = `const P = path.resolve(ROOT, "data/${combinedSuffix}");\nwriteFileSync(P, "conteudo", "utf8");`;
      const offenders = findOffendersForTarget(fakeSource, target);
      assert.ok(
        offenders.length > 0,
        `esperava que o guard pegasse variável da composição gap1+gap2 pra ${target.label}, mas não achou nada em: ${fakeSource}`,
      );
    });
  }
});
