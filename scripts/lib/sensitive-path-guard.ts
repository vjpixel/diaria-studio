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
  id: string;
  /**
   * Padrão casado contra o path relativo à raiz do repo (separador `/`).
   * Suporta apenas `*` (não cruza `/`) e `**` (cruza `/`) — subconjunto
   * deliberado de glob, para a regra ser legível numa linha e não depender de
   * dependência externa.
   */
  pattern: string;
  reason: string;
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
    pattern: "scripts/lib/{curadoria-page,entity-page}.ts",
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
      if (close !== -1) {
        const alternatives = pattern
          .slice(i + 1, close)
          .split(",")
          .map((alt) => alt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        source += `(?:${alternatives.join("|")})`;
        i = close + 1;
        continue;
      }
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

export interface SensitiveHit {
  path: string;
  ruleIds: string[];
  reasons: string[];
}

export interface SensitiveClassification {
  /** `true` quando ao menos um path do conjunto é sensível. */
  sensitive: boolean;
  hits: SensitiveHit[];
  /** Paths avaliados que NÃO casaram com nenhuma regra. */
  clean: string[];
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
      ruleIds: rules.map((r) => r.id),
      reasons: rules.map((r) => r.reason),
    });
  }
  return { sensitive: hits.length > 0, hits, clean };
}

/** Mensagem humana para o caso sensível — o que fazer, não só que foi barrado. */
export function formatVerdict(result: SensitiveClassification): string {
  if (!result.sensitive) {
    return `sensitive-path-guard: nenhum caminho sensível tocado (${result.clean.length} arquivo(s) avaliado(s)) — fluxo de merge normal.`;
  }
  const lines = result.hits.map((hit) => `  - ${hit.path} [${hit.ruleIds.join(", ")}]\n      ${hit.reasons[0]}`);
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
    const paths = values.files !== undefined ? values.files.split(",") : changedPathsFromGit(values.base ?? "origin/master");
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
