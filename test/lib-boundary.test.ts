/**
 * test/lib-boundary.test.ts (#2747)
 *
 * Fronteira lint-enforced entre código genérico/diária/mensal DENTRO do
 * monorepo (sem separar repo). Regras (as 3 direções proibidas):
 *
 *   1. `scripts/lib/shared/**` NÃO importa de `scripts/lib/diaria/**` nem de
 *      `scripts/lib/mensal/**` — shared é a base; dependência invertida
 *      significa que o módulo não é genérico de verdade.
 *   2. `scripts/lib/diaria/**` NÃO importa de `scripts/lib/mensal/**`.
 *   3. `scripts/lib/mensal/**` NÃO importa de `scripts/lib/diaria/**`.
 *      (2/3: fluxo cruzado só passando por shared/ — o forcing function que
 *      motivaria um repo separado, mas o erro custa `git mv`, não pacote.)
 *   4. `scripts/lib/**` (QUALQUER arquivo, incluindo a raiz não-classificada)
 *      NÃO importa de `scripts/studio-ui/**` (#5899). Direção única —
 *      `studio-ui/` importar de `lib/` é o fluxo normal; o INVERSO é sinal
 *      de que lógica de negócio vazou pro código de servidor HTTP, quando
 *      deveria estar em `lib/`, reusável por CLI e Studio.
 *   4b. O resto de `scripts/` (CLIs de topo e subpastas fora de `studio-ui/`)
 *      também NÃO importa `scripts/studio-ui/**` (#14000), salvo a allowlist
 *      explícita do próprio teste, que só encolhe.
 *
 * Arquivos na RAIZ de `scripts/lib/` estão fora das regras 1-3: são o legado
 * não-classificado (implicitamente diária ou genérico-ainda-não-movido) e
 * migram sob demanda — quando um deles for importado por shared/, é sinal de
 * que deve ser movido pra shared/ (a falha da regra 1 força essa decisão).
 * A regra 4 é a exceção declarada: ela vale pra raiz também, porque "lib não
 * importa de studio-ui" independe de classificação de domínio.
 *
 * Regras 5-7 têm dívida medida no dia em que entraram, então valem contra uma
 * baseline CONGELADA (`test/fixtures/lib-boundary-baseline.json`) que só
 * encolhe: par novo reprova, e par da baseline que deixou de existir também
 * reprova até sair do arquivo (a lista acompanha o estado real).
 *
 *   5. `scripts/lib/**` NÃO importa CLI de topo `scripts/*.ts` (#14001).
 *      Lógica que lib precisa de um CLI mora em lib; o CLI vira casca fina.
 *   6. Fecho TRANSITIVO (#13998): os pares proibidos das regras 1-3 (mais
 *      metrics/ e anual/) valem também passando pela raiz de lib, por CLIs de
 *      topo ou por qualquer outro `.ts` do repo — `mensal/x.ts` que importa
 *      `raiz.ts` que importa `diaria/y.ts` é o mesmo cruzamento da regra 3.
 *   7. `scripts/**` NÃO importa `workers/{nome}/src/**` (#13994). A mão única
 *      é Worker → `scripts/lib/shared/`. `test/` fica fora: os testes dos
 *      Workers moram lá e importam o `src` legitimamente.
 *
 * Scan estático de specifiers de import — sem executar os módulos.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname, sep, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = join(ROOT, "scripts", "lib");

const DOMAINS = ["shared", "diaria", "mensal", "metrics", "anual"] as const;
type Domain = (typeof DOMAINS)[number];

/** Lista .ts recursivamente sob um diretório (retorna [] se não existe). */
function tsFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: false })
    .map(String)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}

/** Extrai specifiers de import estático, re-export e import() dinâmico. */
function importSpecifiers(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  const re = /(?:from|import\s*\()\s*['"]([^'"]+)['"]/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[1]);
  return out;
}

/** Domínio (shared/diaria/mensal) de um path absoluto sob scripts/lib, ou null. */
function domainOf(absPath: string): Domain | null {
  for (const d of DOMAINS) {
    if (absPath.startsWith(join(LIB, d) + sep)) return d;
  }
  return null;
}

/** Violações de fronteira de um domínio: imports relativos que caem em domínio proibido. */
function violations(fromDomain: Domain, forbidden: Domain[]): string[] {
  const found: string[] = [];
  for (const file of tsFilesUnder(join(LIB, fromDomain))) {
    for (const spec of importSpecifiers(file)) {
      if (!spec.startsWith(".")) continue; // node:/npm — fora da regra
      const target = resolve(dirname(file), spec);
      const d = domainOf(target);
      if (d && forbidden.includes(d)) {
        found.push(`${file.slice(ROOT.length + 1)} -> ${spec} (${fromDomain} não pode importar de ${d}/)`);
      }
    }
  }
  return found;
}

describe("fronteira scripts/lib shared/diaria/mensal (#2747)", () => {
  it("shared/ não importa de diaria/, mensal/ nem anual/", () => {
    const v = violations("shared", ["diaria", "mensal", "anual"]);
    assert.deepEqual(v, [], `shared/ importando domínio específico:\n  ${v.join("\n  ")}`);
  });

  it("diaria/ não importa de mensal/", () => {
    const v = violations("diaria", ["mensal"]);
    assert.deepEqual(v, [], `cruzamento diaria->mensal (passe por shared/):\n  ${v.join("\n  ")}`);
  });

  it("mensal/ não importa de diaria/", () => {
    const v = violations("mensal", ["diaria"]);
    assert.deepEqual(v, [], `cruzamento mensal->diaria (passe por shared/):\n  ${v.join("\n  ")}`);
  });

  it("metrics/ não importa de diaria/ nem mensal/ (#7175 F3)", () => {
    // scripts/lib/metrics/ é domínio novo desde #7175 — mesma regra de
    // shared/: cruzamento só via shared/, nunca import direto de
    // diaria/mensal.
    const v = violations("metrics", ["diaria", "mensal"]);
    assert.deepEqual(v, [], `metrics/ importando domínio específico (passe por shared/):\n  ${v.join("\n  ")}`);
  });

  it("anual/ não importa de diaria/ nem mensal/ (#7569)", () => {
    // scripts/lib/anual/ é domínio novo desde #7569 (edição anual). Mesma
    // regra de metrics/: a anual reusa a mensal SÓ via shared/ — o que ela
    // precisar de lá (conversão de HTML publicado pra pseudo-markdown, por
    // exemplo) migra pra shared/ com `git mv`, não vira import cruzado.
    const v = violations("anual", ["diaria", "mensal"]);
    assert.deepEqual(v, [], `anual/ importando domínio específico (passe por shared/):\n  ${v.join("\n  ")}`);
  });

  it("sanity: a estrutura existe e o scan enxerga os módulos movidos", () => {
    // Se alguém achatar a estrutura de volta, este teste deixa de proteger —
    // falhar aqui avisa que o scan ficou vazio (silêncio ≠ fronteira ok).
    assert.ok(tsFilesUnder(join(LIB, "shared")).length >= 2, "shared/ tem os módulos base");
    assert.ok(tsFilesUnder(join(LIB, "mensal")).length >= 3, "mensal/ tem os monthly-*");
  });
});

describe("fronteira scripts/lib → scripts/studio-ui (#5899)", () => {
  const STUDIO_UI = join(ROOT, "scripts", "studio-ui");

  /** Violações da regra 4: QUALQUER .ts sob scripts/lib/ (domínios + raiz)
   * importando de scripts/studio-ui/. Reusa os mesmos helpers das regras
   * 1-3; o alvo é detectado por path resolvido, não por domainOf (studio-ui
   * não é um domínio de lib/). */
  function studioUiViolations(): string[] {
    const found: string[] = [];
    const allLibFiles = [
      ...tsFilesUnder(LIB), // inclui a raiz de lib/ — readdirSync recursive
    ];
    for (const file of allLibFiles) {
      for (const spec of importSpecifiers(file)) {
        if (!spec.startsWith(".")) continue; // node:/npm — fora da regra
        const target = resolve(dirname(file), spec);
        if (target.startsWith(STUDIO_UI + sep)) {
          found.push(`${file.slice(ROOT.length + 1)} -> ${spec} (lib não importa de studio-ui/)`);
        }
      }
    }
    return found;
  }

  it("nenhum arquivo de scripts/lib/** importa de scripts/studio-ui/**", () => {
    const v = studioUiViolations();
    assert.deepEqual(
      v,
      [],
      `lógica de negócio vazou pro servidor HTTP (mova pra lib/, reusável por CLI e Studio):\n  ${v.join("\n  ")}`,
    );
  });

  it("sanity: o scan enxerga os dois lados da fronteira", () => {
    assert.ok(tsFilesUnder(STUDIO_UI).length >= 5, "studio-ui/ tem os módulos do servidor");
    assert.ok(tsFilesUnder(LIB).length >= 10, "lib/ tem arquivos pra varrer");
  });

  /**
   * Regra 4b (#14000): nenhum `.ts` de `scripts/` FORA de `studio-ui/` (CLIs de
   * topo, `overnight/`, ...) importa `scripts/studio-ui/**`. O Studio é folha:
   * CLI agendado que registra relatório ou lê o painel Apoios não pode quebrar
   * por mudança no servidor. `scripts/lib/**` já é coberto pela regra 4 acima.
   * Os pares em `STUDIO_UI_IMPORT_ALLOWLIST` são a dívida conhecida no dia em
   * que a regra entrou; a lista só encolhe (par sumido também reprova).
   */
  const STUDIO_UI_IMPORT_ALLOWLIST = [
    "scripts/form-results-artifact.ts -> scripts/studio-ui/studio-onboarding-form.ts",
    "scripts/studio-snapshot-push.ts -> scripts/studio-ui/studio-state.ts",
  ];

  function scriptsToStudioUiPairs(): string[] {
    const found = new Set<string>();
    for (const file of tsFilesUnder(join(ROOT, "scripts"))) {
      if (file.startsWith(STUDIO_UI + sep) || file.startsWith(LIB + sep)) continue;
      for (const spec of importSpecifiers(file)) {
        if (!spec.startsWith(".")) continue;
        const target = resolve(dirname(file), spec);
        if (target.startsWith(STUDIO_UI + sep)) {
          found.add(`${relative(ROOT, file).split(sep).join("/")} -> ${relative(ROOT, target).split(sep).join("/")}`);
        }
      }
    }
    return [...found].sort();
  }

  it("regra 4b: scripts/ fora de studio-ui/ não importa scripts/studio-ui/** fora da allowlist (#14000)", () => {
    const current = scriptsToStudioUiPairs();
    const added = current.filter((p) => !STUDIO_UI_IMPORT_ALLOWLIST.includes(p));
    const stale = STUDIO_UI_IMPORT_ALLOWLIST.filter((p) => !current.includes(p));
    assert.deepEqual(
      added,
      [],
      `CLI importando o servidor do Studio (#14000). Mova o núcleo sem HTTP para scripts/lib/ ` +
        `(como reports-registry.ts e apoios-data.ts) e importe de lá. Não acrescente o par à allowlist. ` +
        `Pares novos:\n  ${added.join("\n  ")}`,
    );
    assert.deepEqual(
      stale,
      [],
      `Pares da allowlist que não existem mais: remova-os de STUDIO_UI_IMPORT_ALLOWLIST ` +
        `(a lista só encolhe):\n  ${stale.join("\n  ")}`,
    );
  });
});

// ─── Regras 5-7: dívida medida, baseline congelada que só encolhe ──────────

const SCRIPTS = join(ROOT, "scripts");
const WORKERS = join(ROOT, "workers");
const BASELINE_PATH = join(ROOT, "test", "fixtures", "lib-boundary-baseline.json");
const BASELINE_REL = "test/fixtures/lib-boundary-baseline.json";

type Baseline = {
  libImportsTopLevelCli: string[];
  crossDomainTransitive: string[];
  scriptsImportWorkersSrc: string[];
};

function loadBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

/** Path relativo à raiz do repo, sempre com `/` (a baseline é a mesma no Windows). */
function repoRel(abs: string): string {
  return relative(ROOT, abs).split(sep).join("/");
}

/** Resolve um specifier relativo para o `.ts` que existe no disco (`.js` →
 * `.ts`, sem extensão → `.ts` ou `/index.ts`), ou null. */
function resolveExistingTs(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, base.replace(/\.m?js$/, ".ts"), `${base}.ts`, join(base, "index.ts")];
  for (const c of candidates) {
    if (c.endsWith(".ts") && existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/**
 * Compara o estado atual com a baseline congelada. `added` = par que não está
 * na baseline (violação nova); `stale` = par da baseline que não existe mais
 * (precisa sair do arquivo, para a baseline só encolher).
 */
function diffAgainstBaseline(current: string[], baseline: string[]): { added: string[]; stale: string[] } {
  const cur = new Set(current);
  const base = new Set(baseline);
  return {
    added: [...cur].filter((p) => !base.has(p)).sort(),
    stale: [...base].filter((p) => !cur.has(p)).sort(),
  };
}

function staleMessage(key: keyof Baseline, stale: string[]): string {
  return (
    `Pares da baseline que não existem mais. Remova-os de ${BASELINE_REL}, chave "${key}" ` +
    `(a baseline só encolhe; isso é progresso, não regressão):\n  ${stale.join("\n  ")}`
  );
}

/** Regra 5: pares `lib/arquivo.ts -> scripts/cli.ts` (CLI direto em `scripts/`). */
function libToTopLevelCliPairs(): string[] {
  const found = new Set<string>();
  for (const file of tsFilesUnder(LIB)) {
    for (const spec of importSpecifiers(file)) {
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec).replace(/\.m?js$/, ".ts");
      if (dirname(target) === SCRIPTS) found.add(`${repoRel(file)} -> ${repoRel(target)}`);
    }
  }
  return [...found].sort();
}

/** Regra 7: pares `scripts/**.ts -> workers/{nome}/src/**`. */
function scriptsToWorkersSrcPairs(): string[] {
  const found = new Set<string>();
  for (const file of tsFilesUnder(SCRIPTS)) {
    for (const spec of importSpecifiers(file)) {
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec);
      const parts = relative(WORKERS, target).split(sep);
      if (parts[0] !== ".." && parts.length >= 3 && parts[1] === "src") {
        found.add(`${repoRel(file)} -> ${repoRel(target)}`);
      }
    }
  }
  return [...found].sort();
}

/** Pares proibidos das regras 1-3 (+ metrics/anual), reusados no fecho transitivo. */
const FORBIDDEN: Record<Domain, Domain[]> = {
  shared: ["diaria", "mensal", "anual"],
  diaria: ["mensal"],
  mensal: ["diaria"],
  metrics: ["diaria", "mensal"],
  anual: ["diaria", "mensal"],
};

/**
 * Regra 6: para cada arquivo de um domínio, BFS pelos imports relativos de
 * qualquer `.ts` do repo; o 1º arquivo de domínio proibido alcançado em cada
 * ramo vira o par `origem ~> alvo` (a busca não atravessa o domínio proibido:
 * o par marca a porta de entrada). `chains` guarda um caminho de exemplo por
 * par, para a mensagem de erro dizer onde cortar.
 */
function crossDomainTransitive(): { pairs: string[]; chains: Map<string, string[]> } {
  const specCache = new Map<string, string[]>();
  const specsOf = (f: string): string[] => {
    let s = specCache.get(f);
    if (!s) {
      s = importSpecifiers(f);
      specCache.set(f, s);
    }
    return s;
  };
  const pairs = new Set<string>();
  const chains = new Map<string, string[]>();
  for (const fromDomain of DOMAINS) {
    const forbidden = FORBIDDEN[fromDomain];
    for (const src of tsFilesUnder(join(LIB, fromDomain))) {
      const parent = new Map<string, string | null>([[src, null]]);
      const queue = [src];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const spec of specsOf(cur)) {
          const target = resolveExistingTs(cur, spec);
          if (!target || parent.has(target)) continue;
          parent.set(target, cur);
          const d = domainOf(target);
          if (d && forbidden.includes(d)) {
            const key = `${repoRel(src)} ~> ${repoRel(target)}`;
            pairs.add(key);
            const chain: string[] = [];
            for (let p: string | null = target; p; p = parent.get(p) ?? null) chain.unshift(repoRel(p));
            chains.set(key, chain);
            continue;
          }
          queue.push(target);
        }
      }
    }
  }
  return { pairs: [...pairs].sort(), chains };
}

describe("fronteiras com baseline congelada (regras 5-7)", () => {
  const baseline = loadBaseline();

  it("diffAgainstBaseline: par novo é violação, par sumido é stale (lógica do ratchet)", () => {
    const r = diffAgainstBaseline(["a -> x", "b -> y"], ["b -> y", "c -> z"]);
    assert.deepEqual(r.added, ["a -> x"]);
    assert.deepEqual(r.stale, ["c -> z"]);
    assert.deepEqual(diffAgainstBaseline(["a"], ["a"]), { added: [], stale: [] });
  });

  it("baseline tem as 3 chaves, ordenadas e sem duplicata (diff legível em PR)", () => {
    for (const key of ["libImportsTopLevelCli", "crossDomainTransitive", "scriptsImportWorkersSrc"] as const) {
      const list = baseline[key];
      assert.ok(Array.isArray(list), `${BASELINE_REL} sem a chave "${key}"`);
      assert.deepEqual(list, [...new Set(list)].sort(), `"${key}" deve vir ordenada e sem duplicata`);
    }
  });

  it("regra 5: scripts/lib/** não importa CLI de topo scripts/*.ts fora da baseline (#14001)", () => {
    const current = libToTopLevelCliPairs();
    const { added, stale } = diffAgainstBaseline(current, baseline.libImportsTopLevelCli);
    assert.deepEqual(
      added,
      [],
      `scripts/lib/** importando CLI de topo (#14001). Mova a função que você precisa para um módulo em ` +
        `scripts/lib/ (o CLI passa a importar/reexportar de lá e fica só com parse de argumentos e main) ` +
        `e importe o módulo de lib. Não acrescente o par à baseline. Pares novos:\n  ${added.join("\n  ")}`,
    );
    assert.deepEqual(stale, [], staleMessage("libImportsTopLevelCli", stale));
  });

  it("regra 6: domínio de lib não alcança domínio proibido por caminho transitivo fora da baseline (#13998)", () => {
    const { pairs, chains } = crossDomainTransitive();
    const { added, stale } = diffAgainstBaseline(pairs, baseline.crossDomainTransitive);
    const explained = added.map((p) => `${p}\n      via ${(chains.get(p) ?? []).join(" -> ")}`);
    assert.deepEqual(
      added,
      [],
      `Cruzamento de domínio por caminho transitivo (#13998; mesmos pares proibidos das regras 1-3). ` +
        `Corte a cadeia no elo que puxa o domínio proibido: mova o que a origem precisa para ` +
        `scripts/lib/shared/ (ou para um módulo-folha sem esses imports). Não acrescente o par à baseline. ` +
        `Pares novos:\n  ${explained.join("\n  ")}`,
    );
    assert.deepEqual(stale, [], staleMessage("crossDomainTransitive", stale));
  });

  it("regra 7: scripts/** não importa workers/*/src fora da baseline (#13994)", () => {
    const current = scriptsToWorkersSrcPairs();
    const { added, stale } = diffAgainstBaseline(current, baseline.scriptsImportWorkersSrc);
    assert.deepEqual(
      added,
      [],
      `scripts/ importando código de Worker (#13994). A mão única é Worker -> scripts/lib/shared/: mova o ` +
        `núcleo compartilhado para scripts/lib/shared/, faça o Worker importar de lá (listando o arquivo no ` +
        `paths do deploy, ver test/workers-deploy-workflow-coverage.test.ts) e importe de shared/. ` +
        `Não acrescente o par à baseline. Pares novos:\n  ${added.join("\n  ")}`,
    );
    assert.deepEqual(stale, [], staleMessage("scriptsImportWorkersSrc", stale));
  });

  it("sanity: os scans das regras 5-7 enxergam a dívida medida (silêncio ≠ fronteira ok)", () => {
    // Se o scan quebrar (regex, resolução de path) e devolver vazio, o
    // stale acusaria tudo — mas este teste diz a causa provável primeiro.
    // Quando a dívida de uma regra zerar (baseline vazia), o scan vazio é o
    // estado certo e a checagem dela deixa de valer.
    const scans = [
      ["regra 5", libToTopLevelCliPairs(), baseline.libImportsTopLevelCli],
      ["regra 6", crossDomainTransitive().pairs, baseline.crossDomainTransitive],
      ["regra 7", scriptsToWorkersSrcPairs(), baseline.scriptsImportWorkersSrc],
    ] as const;
    for (const [name, current, base] of scans) {
      if (base.length > 0) assert.ok(current.length > 0, `scan da ${name} vazio com baseline não vazia`);
    }
  });
});
