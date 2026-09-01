/**
 * test/getarg-numeric-guard-4573.test.ts (#4573, ampliado no #6149)
 *
 * Fronteira lint-enforced (mesmo molde de `test/lib-boundary.test.ts`, #2747:
 * grep estrutural sobre os arquivos do repo, sem executar nada) contra o
 * padrão que já causou 3 incidentes de produção (ver docstring de
 * `getArg` em `scripts/lib/cli-args.ts`): `getArg` devolve `""` tanto quando a
 * flag está AUSENTE quanto quando está PRESENTE mas vazia/sem valor — passar
 * esse `""` direto pra `Number(...)`/`parseInt(...)`/`parseFloat(...)` sem
 * nenhuma proteção produz `0`/`NaN` em silêncio.
 *
 * Escopo desta issue (decisão do editor, comentário 260804): só barrar o
 * padrão NUMÉRICO desprotegido — não migrar os 118 call sites de `getArg`
 * existentes, nem barrar todo uso futuro de `getArg` em geral (esse último
 * ficou registrado na issue como direção futura, mas o mecanismo CONCRETO
 * pedido — e o único implementado aqui — é este grep).
 *
 * Allowlist: os 4 call sites já identificados no levantamento da issue como
 * "protegidos por acidente" pelo `||` (o `""` cai no branch falsy do `||` e
 * vira o default numérico declarado) — ficam de fora do escopo de migração
 * desta issue, mas não podem quebrar este teste. Qualquer OUTRA ocorrência
 * do padrão (nova ou pré-existente não catalogada) falha o teste — força a
 * migração pra `getIntArg` (que distingue ausente de inválido, #4497) ou uma
 * adição CONSCIENTE + justificada a esta allowlist.
 *
 * Não cobre `workers/` — `getArg`/`cli-args.ts` é um parser de CLI args
 * (`process.argv`), não usado em Workers (sem argv de shell no runtime
 * Cloudflare); confirmado por grep antes de escrever este teste.
 *
 * #6149 (achado real: #6144/PR #6145, `clarice-plan-wave.ts`) ampliou o guard
 * pra também pegar a variante DESACOPLADA — `const x = getArg(argv, ...)`
 * numa linha, verificada depois com `x !== undefined`/`x === undefined`
 * (sempre `true`/`false`, `getArg` nunca retorna `undefined` — a checagem é
 * um guard FALSO) ou passada pra `Number`/`parseInt`/`parseFloat` SEM
 * nenhuma proteção intermediária (`if (x)`, `x ? ... : ...`, `x === ""`,
 * `x &&`, etc — os mesmos formatos de proteção "por acidente" que já
 * justificam a allowlist do padrão inline acima, só que expressos como
 * controle de fluxo em vez de `||`). Ver `findDecoupledGetArgUsagesInSource`
 * abaixo — heurística de escopo por profundidade de chaves (não é um parser
 * real; suficiente pro caso concreto, mesmo espírito pragmático do grep
 * estrutural original).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS_DIR = join(ROOT, "scripts");

/** Lista .ts recursivamente sob um diretório (retorna [] se não existe). */
function tsFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: false })
    .map(String)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}

/** Padrão perigoso: Number/parseInt/parseFloat envolvendo getArg( diretamente. */
const DANGEROUS_RE = /\b(?:Number|parseInt|parseFloat)\(\s*getArg\(/g;

export interface DangerousMatch {
  /** Path relativo ao root do repo, POSIX (/ sempre, mesmo no Windows — allowlist estável entre SOs). */
  file: string;
  line: number;
}

/**
 * Substitui todo comentário de bloco (`/* ... *\/`, inclusive JSDoc `/** ... *\/`)
 * por espaços (preserva quebras de linha — cada `\n` interno vira `\n`, o
 * resto vira ` ` — pra números de linha do restante do arquivo não
 * desalinharem). Usado ANTES do scan de linha — várias docstrings do repo
 * citam o padrão perigoso em prosa histórica dentro de bloco JSDoc (ex: a
 * própria docstring `@deprecated` de `getArg`), sem ser código de verdade.
 */
function stripBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block
      .split("\n")
      .map((line) => " ".repeat(line.length))
      .join("\n"),
  );
}

/**
 * Pura — varre `dir` recursivamente e devolve toda ocorrência do padrão
 * perigoso, IGNORANDO ocorrências dentro de comentário de bloco (`/* *\/`,
 * `/** *\/`) e de comentário de linha (`//`) — várias docstrings do repo
 * citam o padrão antigo em prosa histórica ("antes: Number(getArg(...)) || 0")
 * sem ser código de verdade. Heurística pra `//`: se aparece na linha ANTES
 * do início do match, é comentário.
 */
export function findDangerousGetArgUsages(dir: string): DangerousMatch[] {
  const found: DangerousMatch[] = [];
  for (const file of tsFilesUnder(dir)) {
    const rawSrc = readFileSync(file, "utf8");
    const src = stripBlockComments(rawSrc);
    const lines = src.split("\n");
    const relFile = file.slice(ROOT.length + 1).split("\\").join("/");
    lines.forEach((lineText, idx) => {
      DANGEROUS_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = DANGEROUS_RE.exec(lineText))) {
        const commentIdx = lineText.indexOf("//");
        if (commentIdx !== -1 && commentIdx < m.index) continue; // dentro de comentário de linha — não é código real
        found.push({ file: relFile, line: idx + 1 });
      }
    });
  }
  return found;
}

/**
 * Aproxima a profundidade de `{}` ANTES de cada linha, ignorando conteúdo de
 * string/template literal (regex sem suporte a template literal multi-linha
 * — heurística, não um parser) e comentário de linha. Usado só pra limitar o
 * alcance da busca da variante desacoplada ao "bloco que contém a
 * declaração" (tipicamente o corpo da função) — quando esse bloco fecha
 * (profundidade cai abaixo da profundidade da linha de declaração), a busca
 * para.
 */
function computeDepthBeforeEachLine(lines: string[]): number[] {
  const depthBefore: number[] = [];
  let depth = 0;
  for (const rawLine of lines) {
    depthBefore.push(depth);
    const commentIdx = rawLine.indexOf("//");
    const codePart = commentIdx === -1 ? rawLine : rawLine.slice(0, commentIdx);
    const stripped = codePart
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, "``");
    for (const ch of stripped) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
  }
  return depthBefore;
}

/** `const|let|var X = getArg(...)` numa linha, sem `||` de proteção imediata. */
const DECOUPLED_DECL_RE = /\b(?:const|let|var)\s+(\w+)\s*=\s*getArg\(/g;

/**
 * Padrões que, se aparecerem numa linha ANTERIOR (ou antes, na mesma linha,
 * da ocorrência de `Number/parseInt/parseFloat`), mostram que a variável já
 * passou por proteção real contra o sentinela `""` — os mesmos formatos que
 * já justificam a allowlist do padrão inline (só que como controle de fluxo,
 * não `||`): `if (x)`/`if (!x)` truthy/falsy, `x ? ... : ...` ternário,
 * `x &&` short-circuit, ou comparação explícita contra string literal
 * (`x === ""`, `x !== "none"`, etc — cobre o `raw === "" || raw === "none"`
 * do `clarice-hour-test.ts`).
 */
function buildProtectedRe(varName: string): RegExp {
  return new RegExp(
    `\\b${varName}\\s*\\?` +
      `|if\\s*\\(\\s*${varName}\\s*\\)` +
      `|if\\s*\\(\\s*!\\s*${varName}\\b` +
      `|\\b${varName}\\s*&&` +
      `|\\b${varName}\\s*(?:===|!==|==|!=)\\s*["'][^"']*["']`,
  );
}

/**
 * Pura — varre UMA fonte já sem comentário de bloco (mesma convenção de
 * `findDangerousGetArgUsages`) atrás da variante DESACOPLADA (#6149,
 * ocorrência real: #6144/PR #6145): uma variável atribuída de
 * `getArg(argv, ...)` numa linha (sem `||` imediato — já protegida, fora de
 * escopo) que depois, dentro do mesmo bloco (heurística de profundidade de
 * `{}` acima):
 *
 *   (a) é comparada com `=== undefined`/`!== undefined` — SEMPRE errado,
 *       `getArg` nunca retorna `undefined`; não existe proteção que torne
 *       essa comparação legítima, então é sinalizado incondicionalmente;
 *   (b) é passada pra `Number`/`parseInt`/`parseFloat` sem nenhuma das
 *       proteções de `buildProtectedRe` tê-la precedido no bloco — se uma
 *       proteção real (truthy/ternário/comparação a string) aparece ANTES da
 *       chamada numérica, essa ocorrência é ignorada (é o formato "protegido
 *       por acidente" de controle de fluxo, equivalente ao `||` do padrão
 *       inline).
 *
 * Exportada (não só a wrapper de diretório) pra permitir o teste de mutação
 * alimentar uma fixture sintética sem precisar de arquivo em disco.
 */
export function findDecoupledGetArgUsagesInSource(src: string, relFile: string): DangerousMatch[] {
  const found: DangerousMatch[] = [];
  const lines = src.split("\n");
  const depthBefore = computeDepthBeforeEachLine(lines);

  lines.forEach((lineText, idx) => {
    DECOUPLED_DECL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DECOUPLED_DECL_RE.exec(lineText))) {
      const commentIdx = lineText.indexOf("//");
      if (commentIdx !== -1 && commentIdx < m.index) continue;
      if (lineText.includes("||")) continue; // protegido por `||` na própria declaração — fora de escopo aqui

      const varName = m[1];
      const declDepth = depthBefore[idx];
      let scopeEnd = lines.length;
      for (let j = idx + 1; j < lines.length; j++) {
        if (depthBefore[j] < declDepth) {
          scopeEnd = j;
          break;
        }
      }

      const undefRe = new RegExp(`\\b${varName}\\s*(?:!==|===)\\s*undefined\\b`, "g");
      const numericRe = new RegExp(`\\b(?:Number|parseInt|parseFloat)\\(\\s*${varName}\\b`, "g");
      const protectedRe = buildProtectedRe(varName);

      let protectedSoFar = false;
      for (let k = idx + 1; k < scopeEnd; k++) {
        const usageLine = lines[k];
        const usageCommentIdx = usageLine.indexOf("//");
        const codePart = usageCommentIdx === -1 ? usageLine : usageLine.slice(0, usageCommentIdx);

        undefRe.lastIndex = 0;
        while (undefRe.exec(codePart)) {
          found.push({ file: relFile, line: k + 1 });
        }

        numericRe.lastIndex = 0;
        let nm: RegExpExecArray | null;
        while ((nm = numericRe.exec(codePart))) {
          const before = codePart.slice(0, nm.index);
          if (protectedSoFar || protectedRe.test(before)) continue;
          found.push({ file: relFile, line: k + 1 });
        }

        if (protectedRe.test(codePart)) protectedSoFar = true;
      }
    }
  });

  return found;
}

/** Wrapper de diretório — mesma convenção de `findDangerousGetArgUsages`. */
export function findDecoupledGetArgUsages(dir: string): DangerousMatch[] {
  const found: DangerousMatch[] = [];
  for (const file of tsFilesUnder(dir)) {
    const rawSrc = readFileSync(file, "utf8");
    const src = stripBlockComments(rawSrc);
    const relFile = file.slice(ROOT.length + 1).split("\\").join("/");
    found.push(...findDecoupledGetArgUsagesInSource(src, relFile));
  }
  return found;
}

/**
 * Allowlist EXPLÍCITA (#4573) — os 4 call sites já catalogados como
 * protegidos por acidente pelo `||` no levantamento da issue. Fora de escopo
 * migrar agora; não devem quebrar este teste. Qualquer entrada nova aqui
 * precisa de justificativa equivalente (grep confirma que o `||` realmente
 * protege o caso `""`).
 */
const ALLOWLIST: readonly DangerousMatch[] = [
  // scripts/clarice-sync-brevo.ts:446 (--concurrency) foi MIGRADA pra
  // getIntArg no #5431 (guard #4573 pegou a ocorrência nova introduzida pela
  // paralelização do catch-up de opens) — "se sumiu, ótimo, remova a
  // entrada" (comentário original desta allowlist).
  { file: "scripts/clarice-engagement-cohorts.ts", line: 562 }, // #4451 cutover formalize: docstring novo (+10 linhas) deslocou 552→562
  // #4451 follow-up (fleet review #4479 achado 4): a entrada da linha 648
  // (--refetch-window-days) foi MIGRADA pra getIntArg neste PR — "se sumiu,
  // ótimo, remova a entrada" (comentário original desta allowlist). Só
  // --concurrency (abaixo) continua no padrão antigo, fora de escopo aqui —
  // linha deslocada de 639→671→684→707→772→776→801→790 (fix do achado 7/sends_count>0
  // no #4451, o docstring de cutover formalize, #5015 — flag --push +
  // pushCohortsToKV — #5946, que exportou `loadCampaignCache` com um
  // docstring novo (+4 linhas) acima dela — #6814, que adicionou
  // `deliveredAt`/`sentDate` acima dela — e o review da PR #6887, que
  // removeu `collectDeliveredEmails` (código morto, -11 linhas)).
  { file: "scripts/clarice-engagement-cohorts-v2.ts", line: 790 },
] as const;

function isAllowlisted(m: DangerousMatch): boolean {
  return ALLOWLIST.some((a) => a.file === m.file && a.line === m.line);
}

describe("guard estrutural: Number/parseInt/parseFloat(getArg(...)) sem proteção (#4573)", () => {
  it("scripts/ não introduz NENHUMA ocorrência nova do padrão perigoso fora da allowlist", () => {
    const found = findDangerousGetArgUsages(SCRIPTS_DIR);
    const unlisted = found.filter((m) => !isAllowlisted(m));
    assert.deepEqual(
      unlisted,
      [],
      `Number/parseInt/parseFloat(getArg(...)) sem proteção fora da allowlist — migre pra getIntArg ` +
        `(distingue ausente de inválido, #4497) ou adicione à ALLOWLIST em test/getarg-numeric-guard-4573.test.ts ` +
        `com justificativa (o \`||\` protege de verdade o caso ""):\n  ${unlisted.map((m) => `${m.file}:${m.line}`).join("\n  ")}`,
    );
  });

  it("sanity: a allowlist inteira ainda é encontrada pelo scan (senão o regex/heurística de comentário quebrou e o guard ficou cego)", () => {
    const found = findDangerousGetArgUsages(SCRIPTS_DIR);
    for (const allowed of ALLOWLIST) {
      assert.ok(
        found.some((m) => m.file === allowed.file && m.line === allowed.line),
        `allowlist espera achar ${allowed.file}:${allowed.line} — se o código mudou de linha, atualize a allowlist; se sumiu, ótimo, remova a entrada`,
      );
    }
  });

  it("sanity: comentário de LINHA (//) que cita o padrão em prosa (histórico) NÃO conta como violação", () => {
    // Confirma que a heurística de comentário funciona de verdade (não é só
    // sorte de nenhum comentário existir hoje) — o arquivo abaixo cita o
    // padrão antigo em comentário `//`, sem ser código real. (#4759: o 2º
    // exemplo original era scripts/clarice-build-waves-store.ts, removido
    // nessa issue — a asserção ficaria vazia/vácua com o arquivo ausente.)
    const found = findDangerousGetArgUsages(SCRIPTS_DIR);
    assert.ok(
      !found.some((m) => m.file === "scripts/cohort-order-dryrun.ts"),
      "comentário histórico em cohort-order-dryrun.ts não deveria contar",
    );
  });

  it("sanity: comentário de BLOCO/JSDoc que cita o padrão em prosa NÃO conta — ex: a própria docstring @deprecated de getArg", () => {
    // scripts/lib/cli-args.ts tem a docstring @deprecated de getArg (#4573)
    // citando literalmente "Number(getArg(...))"/"parseInt(getArg(...))" em
    // prosa — sem stripBlockComments, o próprio guard se auto-violaria.
    const found = findDangerousGetArgUsages(SCRIPTS_DIR);
    assert.ok(
      !found.some((m) => m.file === "scripts/lib/cli-args.ts"),
      "docstring JSDoc de getArg (block comment) não deveria contar como violação",
    );
  });
});

/**
 * Allowlist do padrão DESACOPLADO — vazia hoje. A única ocorrência real
 * encontrada ao ampliar o guard (`scripts/clarice-mv-ondemand.ts`, mesmo bug
 * de raiz do #6144 num 2º call site de `--target-volume`, achado ao vivo
 * rodando este scan contra `scripts/` durante o #6149) foi corrigida no
 * mesmo PR reusando `parseTargetVolumeArg` — não precisou de allowlist.
 * Qualquer entrada futura aqui precisa da mesma justificativa do ALLOWLIST
 * acima (grep confirma que a proteção de controle de fluxo é real).
 */
const DECOUPLED_ALLOWLIST: readonly DangerousMatch[] = [] as const;

function isDecoupledAllowlisted(m: DangerousMatch): boolean {
  return DECOUPLED_ALLOWLIST.some((a) => a.file === m.file && a.line === m.line);
}

describe("guard estrutural: getArg(...) desacoplado sem proteção (#6149)", () => {
  it("scripts/ não introduz NENHUMA ocorrência do padrão desacoplado fora da allowlist", () => {
    const found = findDecoupledGetArgUsages(SCRIPTS_DIR);
    const unlisted = found.filter((m) => !isDecoupledAllowlisted(m));
    assert.deepEqual(
      unlisted,
      [],
      `getArg(...) desacoplado numa variável, depois checada com ===/!== undefined ou passada ` +
        `pra Number/parseInt/parseFloat sem proteção real (if/ternário/comparação a string) — migre ` +
        `pra getIntArg (#4497) ou adicione à DECOUPLED_ALLOWLIST em test/getarg-numeric-guard-4573.test.ts ` +
        `com justificativa:\n  ${unlisted.map((m) => `${m.file}:${m.line}`).join("\n  ")}`,
    );
  });

  it("mutação: reproduz o padrão exato do #6144/#6145 (fixture sintética) e confirma que o guard pega", () => {
    // `clarice-plan-wave.ts` ANTES do fix (#6145) — `getArg` nunca retorna
    // `undefined`, então o `!== undefined` é sempre `true` e `Number("")` vira
    // `0` em silêncio. Este é exatamente o padrão que o regex de LINHA ÚNICA
    // original (`DANGEROUS_RE`) não pega, porque `Number(` não é seguido
    // diretamente de `getArg(` — há uma variável intermediária.
    const fixture = [
      "export async function main(argv: string[]): Promise<void> {",
      '  const targetVolumeArg = getArg(argv, "target-volume");',
      "  let targetVolume: number | undefined;",
      "  if (targetVolumeArg !== undefined) {",
      "    targetVolume = Number(targetVolumeArg);",
      "    if (!Number.isInteger(targetVolume) || targetVolume <= 0) {",
      '      console.error("invalid");',
      "      process.exit(1);",
      "    }",
      "  }",
      "}",
    ].join("\n");

    const found = findDecoupledGetArgUsagesInSource(fixture, "fixture/mutation-6144.ts");
    assert.ok(
      found.some((m) => m.line === 4),
      `esperava flagar a linha 4 (targetVolumeArg !== undefined) — achou: ${JSON.stringify(found)}`,
    );
    assert.ok(
      found.some((m) => m.line === 5),
      `esperava flagar a linha 5 (Number(targetVolumeArg) sem proteção) — achou: ${JSON.stringify(found)}`,
    );
  });

  it("sanity: variável desacoplada protegida por `||` na própria declaração não conta (fora de escopo, mesmo critério do padrão inline)", () => {
    const fixture = [
      "export function main(argv: string[]): void {",
      '  const limitArg = getArg(argv, "limit") || "10";',
      "  const limit = Number(limitArg);",
      "}",
    ].join("\n");
    const found = findDecoupledGetArgUsagesInSource(fixture, "fixture/protected-fallback.ts");
    assert.deepEqual(found, [], "declaração com || imediato não deveria ser reportada");
  });

  it("sanity: variável protegida por `if (x)` truthy antes do Number(x) não conta (protegida por acidente, mesmo espírito do || do padrão inline)", () => {
    const fixture = [
      "export function main(argv: string[]): void {",
      '  const budgetArg = getArg(argv, "budget");',
      "  let budget = 0;",
      "  if (budgetArg) {",
      "    budget = Number(budgetArg);",
      "  }",
      "}",
    ].join("\n");
    const found = findDecoupledGetArgUsagesInSource(fixture, "fixture/protected-truthy-if.ts");
    assert.deepEqual(found, [], "if (budgetArg) antes de Number(budgetArg) protege — não deveria reportar");
  });

  it("sanity: variável protegida por ternário `x ? Number(x) : default` não conta", () => {
    const fixture = [
      "export function main(argv: string[]): void {",
      '  const toleranceArg = getArg(argv, "tolerance");',
      "  const toleranceRatio = toleranceArg ? Number(toleranceArg) : 0.02;",
      "}",
    ].join("\n");
    const found = findDecoupledGetArgUsagesInSource(fixture, "fixture/protected-ternary.ts");
    assert.deepEqual(found, [], "ternário toleranceArg ? Number(toleranceArg) : ... protege — não deveria reportar");
  });

  it("sanity: variável protegida por comparação explícita a string vazia não conta", () => {
    const fixture = [
      "export function main(argv: string[]): void {",
      '  const maxAddRaw = getArg(argv, "max-add");',
      '  if (maxAddRaw === "") {',
      "    throw new Error('missing');",
      "  }",
      "  const maxAdd = Number(maxAddRaw);",
      "}",
    ].join("\n");
    const found = findDecoupledGetArgUsagesInSource(fixture, "fixture/protected-empty-check.ts");
    assert.deepEqual(found, [], 'maxAddRaw === "" antes de Number(maxAddRaw) protege — não deveria reportar');
  });

  it("sanity: escopo não vaza pra outra função — variável de mesmo nome, protegida em uma função e desprotegida em outra, só reporta a desprotegida", () => {
    const fixture = [
      "export function safe(argv: string[]): number {",
      '  const raw = getArg(argv, "n");',
      "  if (raw) {",
      "    return Number(raw);",
      "  }",
      "  return 0;",
      "}",
      "",
      "export function unsafe(argv: string[]): number {",
      '  const raw = getArg(argv, "n");',
      "  return Number(raw);",
      "}",
    ].join("\n");
    const found = findDecoupledGetArgUsagesInSource(fixture, "fixture/scope-boundary.ts");
    assert.deepEqual(
      found.map((m) => m.line),
      [11],
      `esperava só a linha 11 (unsafe) — achou: ${JSON.stringify(found)}`,
    );
  });
});
