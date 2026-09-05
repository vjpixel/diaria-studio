/**
 * scripts/lib/sensitive-path-guard.ts (#6277 item 1)
 *
 * Responde, de forma DETERMINÍSTICA, a pergunta "este diff toca caminho de
 * publicação/render público?" — a classe de mudança que o pipeline de review
 * do `hermes-diaria-continuo` demonstrou não conseguir revisar sozinho.
 *
 * ## Por que existe
 *
 * Em 260826 o contínuo mergeou o PR #6214 (guard do #6210) tocando
 * `scripts/lib/site-archive-pages.ts`. O PR passou pelo review independente da
 * skill — reviewer em modelo free, vendo SÓ o diff — e mesmo assim **quebrou a
 * geração do acervo público inteiro**: o guard novo rodava ANTES do sanitize
 * pré-existente que tratava exatamente o caso que ele rejeitava. Nenhum review
 * individual olha os dois juntos; só o review consolidado do overnight pegou
 * (hotfix `4b16a195`, issue #6255).
 *
 * A lição não é "o reviewer errou" — é que **review de diff isolado é cego a
 * interação com código pré-existente**, e no caminho de publicação/render
 * público o custo desse ponto cego é uma superfície pública quebrada, não um
 * teste vermelho. Então essa classe de PR precisa de um gate diferente.
 *
 * ## O que este módulo NÃO cobre (honestidade de escopo)
 *
 * A outra quebra do mesmo dia — PR #6237, master vermelho por teste não
 * atualizado (fix `eac20369`, #6261) — é de OUTRA classe: CI pega sozinho, não
 * precisa deste guard. Este módulo não tenta ser um detector universal de
 * "mudança arriscada"; ele responde uma pergunta estreita e verificável.
 *
 * Paths de config de RUNTIME do Hermes (`~/.hermes/config.yaml` e afins,
 * #6817 item 5) NÃO entram em `SENSITIVE_RULES` — vivem fora deste repo,
 * e o teste de higiene abaixo (`describe("cada regra casa com arquivo REAL
 * do repo")`) exige que toda regra case com um arquivo RASTREADO por `git
 * ls-files`; uma regra sobre `~/.hermes/...` nasceria morta por
 * construção. O critério análogo pra esses paths vive em
 * `scripts/lib/hermes-runtime-sensitive-paths.ts` — módulo irmão, reusa
 * `matchesGlob` (exportado abaixo), hygiene própria contra os paths reais.
 *
 * ## Contrato
 *
 * `isSensitivePath` e `classifyChangedPaths` são PUROS (recebem os paths, não
 * consultam git) — testáveis sem repo. O CLI é quem chama `git diff --name-only`.
 *
 * Uso:
 *   npx tsx scripts/lib/sensitive-path-guard.ts --base origin/master
 *   npx tsx scripts/lib/sensitive-path-guard.ts --files a.ts,b.ts
 *
 * Sempre exit 0 quando a pergunta pôde ser respondida (a resposta é o JSON,
 * não o exit code — mesmo padrão de `session-registry.ts is-claimed`). Exit 1
 * só quando não deu pra responder (git falhou, argumento inválido).
 */

import { execFileSync } from "node:child_process";
import { parseArgs, isMainModule } from "./cli-args.ts";

/**
 * Uma regra de path sensível: o prefixo/padrão e a razão pela qual mudanças
 * ali não podem ser mergeadas por review de diff isolado. A razão vai no
 * output do CLI de propósito — quem for barrado precisa saber POR QUE, senão
 * o guard vira burocracia que se contorna sem pensar.
 */
export interface SensitiveRule {
  /** Identificador curto e estável, usado no output. */
  readonly id: string;
  /**
   * Padrão casado contra o path relativo à raiz do repo (separador `/`).
   * Suporta apenas `*` (não cruza `/`), `**` (cruza `/`) e `{a,b}` — subconjunto
   * deliberado de glob, para a regra ser legível numa linha e não depender de
   * dependência externa.
   */
  readonly pattern: string;
  readonly reason: string;
}

/**
 * Caminhos onde uma regressão sai direto para a superfície pública (site,
 * e-mail entregue, post publicado) sem nenhum teste vermelho no meio.
 *
 * Critério de inclusão — os três juntos, não qualquer um deles:
 * 1. o output do código é consumido por terceiro (leitor, crawler, plataforma);
 * 2. a falha é silenciosa no CI (não existe teste que a pegue por construção);
 * 3. a correção exige entender código pré-existente que o diff não mostra.
 *
 * Manter esta lista CURTA. Um guard que barra metade dos PRs é um guard que
 * será ignorado — e a cadência horária do contínuo depende de ele não virar
 * gargalo. Quando em dúvida, deixar de fora: o overnight ainda faz o review
 * consolidado por cima.
 */
export const SENSITIVE_RULES: readonly SensitiveRule[] = [
  {
    id: "publicadores",
    pattern: "scripts/publish-*.ts",
    reason:
      "dispatch real para Beehiiv/Brevo/LinkedIn/Facebook/Instagram — erro aqui vira post ou e-mail publicado errado, irreversível para terceiros",
  },
  {
    id: "acervo-publico",
    pattern: "scripts/lib/site-archive*.ts",
    reason:
      "geração das páginas públicas do acervo — foi exatamente aqui que o PR #6214 quebrou o acervo inteiro (hotfix #6255)",
  },
  {
    id: "render-newsletter",
    pattern: "scripts/render-newsletter-html.ts",
    reason: "HTML final da newsletter entregue por e-mail — falha só aparece na caixa do leitor",
  },
  {
    id: "stitch-newsletter",
    pattern: "scripts/stitch-newsletter.ts",
    reason:
      "montagem da newsletter (boxes de divulgação, ordem das seções) — invariantes de runtime que não têm cobertura de CI desde a migração de data/snippets/ (#5227)",
  },
  {
    id: "render-monthly",
    pattern: "scripts/render-monthly-*.ts",
    reason: "HTML do digest mensal entregue por e-mail (Beehiiv/Brevo/apoiadores)",
  },
  {
    id: "paginas-publicas",
    pattern: "scripts/lib/shared/{curadoria-page,entity-page}.ts",
    reason: "páginas públicas de curadoria servidas pelos Workers — quebra é visível para leitor e crawler",
  },
  {
    id: "email-shared",
    pattern: "scripts/lib/shared/{email-components,newsletter-styles}.ts",
    reason:
      "primitivas de e-mail compartilhadas entre diária e mensal — uma mudança aqui atinge os dois pipelines de entrega de uma vez",
  },
];

/**
 * Casa `path` contra um `pattern` do subconjunto de glob suportado:
 * `*` (não cruza `/`), `**` (cruza `/`) e `{a,b}` (alternativa literal).
 * Implementado por tradução para RegExp com escape do resto — nunca usa
 * `new RegExp` sobre input não escapado.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  let source = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i += 2;
        continue;
      }
      source += "[^/]*";
      i += 1;
      continue;
    }
    if (char === "{") {
      const close = pattern.indexOf("}", i);
      if (close === -1) {
        // `{` sem `}` é pattern malformado. Degradar para literal silenciosamente
        // faria uma regra inválida virar uma regra que "existe mas nunca casa" —
        // exatamente a falha silenciosa que este módulo existe pra evitar
        // (achado do review do #6277). Falhar alto: o teste de higiene que casa
        // cada regra contra arquivo real quebra o CI antes de chegar em produção.
        throw new Error(
          `sensitive-path-guard: pattern malformado "${pattern}" — "{" sem "}" correspondente. ` +
            "Uma regra que não compila nunca casa com nada, e um guard que nunca casa é um guard furado.",
        );
      }
      const alternatives = pattern
        .slice(i + 1, close)
        .split(",")
        .map((alt) => alt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      source += `(?:${alternatives.join("|")})`;
      i = close + 1;
      continue;
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  return new RegExp(`^${source}$`).test(path);
}

/** Regras que casam com `path` (vazio = path não é sensível). */
export function matchingRules(path: string): SensitiveRule[] {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return SENSITIVE_RULES.filter((rule) => matchesGlob(normalized, rule.pattern));
}

/** `true` quando `path` casa com QUALQUER regra sensível. */
export function isSensitivePath(path: string): boolean {
  return matchingRules(path).length > 0;
}

/** Uma regra que casou com um path, com a razão colada nela. */
export interface SensitiveMatch {
  readonly ruleId: string;
  readonly reason: string;
}

export interface SensitiveHit {
  readonly path: string;
  /**
   * Regras que casaram, id e razão PAREADOS no mesmo objeto — não dois arrays
   * paralelos. O formato anterior (`ruleIds[]` + `reasons[]`) já tinha
   * produzido perda de informação no próprio consumidor: `formatVerdict`
   * listava todos os ids mas imprimia só `reasons[0]`, então um path que
   * casasse com 2 regras mostrava metade do motivo (achado do review do
   * #6277). Com o par junto, "imprimir todas as razões" é o que sai natural.
   */
  readonly matches: readonly SensitiveMatch[];
}

export interface SensitiveClassification {
  /**
   * DERIVADO de `hits.length > 0`, nunca uma verdade independente — existe só
   * porque o consumidor é `jq`/agente lendo JSON, para quem `.sensitive` é
   * mais legível que `.hits | length > 0`. Há um único produtor
   * (`classifyChangedPaths`) e ele deriva o campo na hora de construir; nunca
   * setar este campo à mão em outro lugar.
   */
  readonly sensitive: boolean;
  readonly hits: readonly SensitiveHit[];
  /** Paths avaliados que NÃO casaram com nenhuma regra. */
  readonly clean: readonly string[];
}

/**
 * Classifica um conjunto de paths alterados. PURO — não consulta git, não lê
 * disco. Paths vazios/whitespace são ignorados (saída comum de `git diff`).
 */
export function classifyChangedPaths(paths: readonly string[]): SensitiveClassification {
  const hits: SensitiveHit[] = [];
  const clean: string[] = [];
  for (const raw of paths) {
    const path = raw.trim();
    if (!path) continue;
    const rules = matchingRules(path);
    if (rules.length === 0) {
      clean.push(path);
      continue;
    }
    hits.push({
      path,
      matches: rules.map((r) => ({ ruleId: r.id, reason: r.reason })),
    });
  }
  // `sensitive` é derivado aqui, no ÚNICO produtor — ver docstring do campo.
  return { sensitive: hits.length > 0, hits, clean };
}

/** Mensagem humana para o caso sensível — o que fazer, não só que foi barrado. */
export function formatVerdict(result: SensitiveClassification): string {
  if (!result.sensitive) {
    return `sensitive-path-guard: nenhum caminho sensível tocado (${result.clean.length} arquivo(s) avaliado(s)) — fluxo de merge normal.`;
  }
  const lines = result.hits.map((hit) => {
    const ids = hit.matches.map((m) => m.ruleId).join(", ");
    // TODAS as razões, não só a primeira: um path pode casar com mais de uma
    // regra e cada razão diz uma coisa diferente sobre por que ele é sensível.
    const reasons = hit.matches.map((m) => `      ${m.reason}`).join("\n");
    return `  - ${hit.path} [${ids}]\n${reasons}`;
  });
  return (
    `sensitive-path-guard: ${result.hits.length} caminho(s) SENSÍVEL(is) tocado(s):\n${lines.join("\n")}\n` +
    "\nEste PR NÃO pode ser mergeado pelo pipeline de review de diff isolado do contínuo (#6277).\n" +
    "Encaminhar para review consolidado (overnight) ou sessão com o editor antes do merge."
  );
}

function changedPathsFromGit(base: string): string[] {
  const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" });
  return out.split("\n");
}

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  try {
    let paths: string[];
    if (values.files !== undefined) {
      if (values.base !== undefined) {
        throw new Error(
          "--files e --base são mutuamente exclusivos — passar os dois esconde qual venceu. " +
            "Escolha um: --files para uma lista explícita, --base para derivar do git.",
        );
      }
      // `--files ""` NÃO é "zero arquivos mudaram": é um pipeline que falhou e
      // passou string vazia. Tratar como conjunto vazio faria o guard responder
      // "sensitive: false" com confiança sobre um diff que ele nunca viu — o
      // fail-open exato que este módulo existe pra impedir (review do #6277).
      if (values.files.trim() === "") {
        throw new Error(
          '--files veio vazio. Isso quase sempre é um pipeline que falhou a montante, não "zero arquivos mudaram" — ' +
            "e responder que nada é sensível sobre um diff não visto é pior que não responder. " +
            "Se a intenção é mesmo avaliar zero arquivos, não chame o guard.",
        );
      }
      paths = values.files.split(",");
    } else {
      paths = changedPathsFromGit(values.base ?? "origin/master");
    }
    const result = classifyChangedPaths(paths);
    if (flags.has("json")) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      process.stdout.write(formatVerdict(result) + "\n");
    }
  } catch (e) {
    process.stderr.write(`sensitive-path-guard: erro — ${(e as Error).message}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
