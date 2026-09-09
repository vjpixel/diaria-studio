/**
 * scripts/lib/worker-public-hosts.ts (#4777)
 *
 * Descobre, a partir de `workers/*​/wrangler.toml`, quais Workers do repo
 * têm um HOST PÚBLICO dedicado num domínio proxiado pela Cloudflare
 * (`[[routes]] pattern = "..." custom_domain = true`) — sem lista
 * hardcoded, mesmo padrão de descoberta de `discoverWorkers` em
 * `scripts/worker-drift-check.ts` (#4723), só que extraindo o HOST da rota
 * em vez do `name` publicado.
 *
 * Existe pro guard de `test/worker-robots-txt-guard-4777.test.ts`: todo
 * Worker novo num domínio proxiado pela Cloudflare nasce servindo o
 * robots.txt DEFAULT da plataforma (bloqueia 9 crawlers via `Disallow: /`)
 * sem que ninguém escolha isso — foi assim 3 vezes (#4546: cursos/livros/
 * arquivo; #4777: poll/artigo-mensal/artigos) antes de alguém notar. Sem
 * descoberta automática, o guard só protegeria os Workers já corrigidos —
 * o objetivo é que o QUARTO Worker com custom_domain novo falhe o teste até
 * ganhar seu próprio `/robots.txt`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface DiscoveredPublicHost {
  /** Nome do diretório sob workers/ (ex: "poll", "artigo-mensal"). */
  workerDir: string;
  /** Host declarado em `[[routes]] pattern = "..."` (ex: "eia.diar.ia.br"). */
  host: string;
}

/**
 * Casa dispatch de rota REAL para `/robots.txt` em código TS — não a
 * substring aparecendo solta num comentário ou string qualquer (#4782
 * achado 1: a versão anterior desta checagem usava `.includes("/robots.txt")`,
 * que um `// TODO: add /robots.txt` sem nenhuma rota de verdade também
 * casaria). Cobre o idioma usado (`pathname === "/robots.txt"` / `path ===
 * "/robots.txt"`) e o antecipado (`case "/robots.txt":`, ainda sem uso real
 * nos Workers deste repo — todos os 3 dinâmicos hoje despacham via `===`).
 */
const ROBOTS_ROUTE_DISPATCH_RE = /(?:===|case)\s*["']\/robots\.txt["']/;

/** `true` se `tsSource` contém um dispatch de rota real pra `/robots.txt`. */
export function hasRobotsRouteDispatch(tsSource: string): boolean {
  return ROBOTS_ROUTE_DISPATCH_RE.test(tsSource);
}

/**
 * Extrai todos os `pattern = "..."` de blocos `[[routes]]` que também têm
 * `custom_domain = true` no MESMO bloco (regex sobre texto, não um parser
 * TOML completo — mesmo racional de simplicidade de `parseWranglerTomlName`
 * em `scripts/lib/worker-drift-check.ts`: o formato usado por este repo é
 * regular o bastante, e um parser completo seria escopo maior do que o
 * guard precisa). Rotas SEM `custom_domain = true` (ex: Workers Routes
 * clássicas) são ignoradas de propósito — não são o padrão usado por
 * nenhum Worker deste repo hoje (ver histórico em `workers/artigos/wrangler.toml`
 * sobre por que a Route clássica foi abandonada).
 */
export function parseWranglerTomlCustomDomainHosts(tomlContent: string): string[] {
  const hosts: string[] = [];
  // Corta cada bloco no próximo header `[` de QUALQUER tipo (`[[routes]]`,
  // `[vars]`, `[[kv_namespaces]]`, ...), não só no próximo `[[routes]]`
  // (#4782 achado 3). Cortar só em `[[routes]]` deixava texto de uma seção
  // não relacionada (comentário, `[vars]`, etc.) vazando pro bloco anterior
  // — sem reprodução real hoje porque as rotas SEM `custom_domain = true`
  // nunca antecedem uma seção com essas palavras, mas é o mesmo tipo de
  // fronteira frágil de parser-sobre-texto que este módulo já tenta evitar
  // em `parseWranglerTomlName` (`scripts/lib/worker-drift-check.ts`).
  const blocks = tomlContent.split(/(?=^\s*\[)/m).filter((b) => /^\s*\[\[routes\]\]/.test(b));
  for (const block of blocks) {
    if (!/custom_domain\s*=\s*true/.test(block)) continue;
    const m = block.match(/pattern\s*=\s*"([^"]+)"/);
    if (m) hosts.push(m[1]);
  }
  return hosts;
}

/**
 * Varre `workers/*​/wrangler.toml` e retorna todos os hosts públicos
 * descobertos. Worker sem `wrangler.toml` (não deveria acontecer — todo
 * worker deste repo tem um) ou sem `[[routes]]`/`custom_domain = true`
 * (ex: `brevo-dashboard`, `diaria-dashboard`, `draft`, `linkedin-cron`,
 * `reativar` — só `workers_dev`, sem domínio de marca) é pulado, não é erro.
 */
export function discoverWorkerPublicHosts(workersDir: string): DiscoveredPublicHost[] {
  if (!existsSync(workersDir)) return [];
  const entries = readdirSync(workersDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  const discovered: DiscoveredPublicHost[] = [];

  for (const entry of entries) {
    const dir = entry.name;
    const tomlPath = join(workersDir, dir, "wrangler.toml");
    if (!existsSync(tomlPath)) continue;
    const hosts = parseWranglerTomlCustomDomainHosts(readFileSync(tomlPath, "utf8"));
    for (const host of hosts) discovered.push({ workerDir: dir, host });
  }

  return discovered;
}

/**
 * Varre `dir` recursivamente procurando algum `.ts` com dispatch de rota
 * real pra `/robots.txt` (`hasRobotsRouteDispatch`, achado #4782 item 1) —
 * usado pelo guard quando o Worker não é static-assets-only (sem
 * `public/robots.txt`, precisa de rota no script).
 */
export function anyTsFileHasRobotsRouteDispatch(dir: string): boolean {
  if (!existsSync(dir)) return false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (anyTsFileHasRobotsRouteDispatch(full)) return true;
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      if (hasRobotsRouteDispatch(readFileSync(full, "utf8"))) return true;
    }
  }
  return false;
}

/**
 * Concatena o conteúdo de todo `.ts` sob `dir` (recursivo) — usado pela
 * análise de branching por host abaixo, que precisa enxergar `const`s e
 * condicionais que podem estar espalhados por vários arquivos do mesmo
 * Worker (ex: a constante do host legado num módulo, o `if` que a testa em
 * `src/index.ts`).
 */
function collectAllTsSource(dir: string): string {
  if (!existsSync(dir)) return "";
  let out = "";
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out += collectAllTsSource(full);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out += "\n" + readFileSync(full, "utf8");
    }
  }
  return out;
}

/** Remove `https://`/`http://` e barra final — pra comparar host "puro" com
 *  valores de constante que às vezes trazem o protocolo (`RETROSPECTIVA_HOST
 *  = "https://retrospectiva.diar.ia.br"`) e às vezes não (`LEGACY_ANUAL_HOST
 *  = "anual.diar.ia.br"`). */
export function stripProtocol(hostOrUrl: string): string {
  return hostOrUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/**
 * Extrai declarações `const NOME = "valor"` (com ou sem `export`, com ou sem
 * anotação de tipo) de código TS — parser-sobre-texto deliberadamente
 * simples, mesmo racional de `parseWranglerTomlCustomDomainHosts` acima:
 * cobre o idioma real usado neste repo (`export const RETROSPECTIVA_HOST =
 * "https://retrospectiva.diar.ia.br";`), não tenta ser um parser TS
 * completo. Usado pra resolver o identificador de um host (`LEGACY_ANUAL_HOST`)
 * pro seu valor de string, tanto na condição (`url.host === LEGACY_ANUAL_HOST`)
 * quanto no alvo do redirect (`` Response.redirect(`${RETROSPECTIVA_HOST}...`) ``).
 */
export function extractStringConstants(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*[^=]+)?=\s*["'`]([^"'`]*)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) map.set(m[1], m[2]);
  return map;
}

function findMatchingBracket(source: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface IfBlock {
  condition: string;
  body: string;
}

/**
 * Acha todo `if (...) { ... }` cuja CONDIÇÃO menciona `url.host` — varredura
 * por balanceamento de parênteses/chaves, não regex de linha única (uma
 * condição pode ter `||` e o corpo pode ter múltiplas statements). `if` sem
 * bloco (`if (x) return y;`, sem `{`) é ignorado de propósito: não é o
 * padrão usado hoje em nenhum roteador de Worker deste repo — reconhecer só
 * o idioma real, não inventar cobertura.
 */
function findIfBlocksWithUrlHost(source: string): IfBlock[] {
  const result: IfBlock[] = [];
  const ifRe = /\bif\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = ifRe.exec(source))) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = findMatchingBracket(source, parenOpen, "(", ")");
    if (parenClose === -1) continue;
    const condition = source.slice(parenOpen + 1, parenClose);
    if (!/url\.host\b/.test(condition)) continue;
    let i = parenClose + 1;
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source[i] !== "{") continue;
    const braceClose = findMatchingBracket(source, i, "{", "}");
    if (braceClose === -1) continue;
    result.push({ condition, body: source.slice(i + 1, braceClose) });
  }
  return result;
}

/** Escapa metacaracteres de regex — usado pra casar um host literal
 *  (`"anual.diar.ia.br"`) dentro de uma condição, já que o host tem `.`. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve o argumento de `Response.redirect(ARG)` pro host de DESTINO, se
 * reconhecível. Cobre os dois idiomas usados hoje: interpolação de
 * identificador (`` `${RETROSPECTIVA_HOST}${resto}` ``, resolvido via
 * `consts`) e literal direto (`"https://outro.host/..."`). Qualquer outra
 * forma (concatenação por `+`, identificador não-const, chamada de função
 * que monta a URL) devolve `null` — o caller trata isso como "não deu pra
 * confirmar", nunca como "não redireciona".
 */
function resolveRedirectTarget(arg: string, consts: Map<string, string>): string | null {
  const identMatch = /\$\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\}/.exec(arg);
  if (identMatch) {
    const value = consts.get(identMatch[1]);
    return value ? stripProtocol(value) : null;
  }
  const literalMatch = /^\s*["'`](https?:\/\/[^"'`]+)["'`]/.exec(arg);
  if (literalMatch) return stripProtocol(literalMatch[1]);
  return null;
}

export type HostBranchAnalysis =
  /** `host` nunca aparece numa condição `url.host === ...` neste código —
   *  trata-se do host "canônico" implícito, que alcança o roteamento normal
   *  do Worker sem ramificação nenhuma (o caso comum: worker de host único). */
  | { kind: "no-branch" }
  /** Achado o padrão redirect-tudo: `if (url.host === <este host>) { ...
   *  return Response.redirect(<alvo resolvido>); }`, incondicional em
   *  relação ao path (a condição não testa `url.pathname`). */
  | { kind: "redirect-target"; targetHost: string }
  /** `host` aparece numa condição `url.host === ...`, mas o guard não
   *  reconheceu o padrão com confiança (redirect condicionado também por
   *  path, alvo não resolvível, ou branch que não termina em redirect) —
   *  sinal explícito de "não sei", nunca tratado como "está tudo bem". */
  | { kind: "unresolvable-branch"; reason: string };

/**
 * Analisa se/como `host` é tratado por ramificação explícita em `url.host`
 * dentro de `source` (tipicamente a concatenação de todo `src/` de um
 * Worker, via `collectAllTsSource`). Núcleo do guard host-aware do #7733:
 * sem isto, `anyTsFileHasRobotsRouteDispatch` (dir-wide) não distingue "este
 * host serve robots.txt" de "este host redireciona pra outro que serve".
 */
export function analyzeHostBranching(source: string, host: string): HostBranchAnalysis {
  const consts = extractStringConstants(source);
  const hostIdentNames = [...consts.entries()].filter(([, v]) => stripProtocol(v) === host).map(([k]) => k);

  const blocks = findIfBlocksWithUrlHost(source);
  let sawHostMention = false;

  for (const { condition, body } of blocks) {
    const matchesThisHost =
      hostIdentNames.some((name) => new RegExp(`url\\.host\\s*===\\s*${escapeRegExp(name)}\\b`).test(condition)) ||
      new RegExp(`url\\.host\\s*===\\s*["'\`]${escapeRegExp(host)}["'\`]`).test(condition);
    if (!matchesThisHost) continue;
    sawHostMention = true;

    // Condição também testa o path (`url.pathname === ...` no mesmo `if`):
    // não é "redirect-tudo", é um redirect PARCIAL — não dá pra assumir que
    // `/robots.txt` especificamente cai nesse ramo. Continua procurando
    // outro bloco (pode haver mais de um `if` mencionando o mesmo host).
    if (/url\.pathname\b/.test(condition)) continue;

    const redirectMatch = /return\s+Response\.redirect\(([\s\S]*?)\);/.exec(body);
    if (!redirectMatch) continue; // este bloco não é o formato redirect-tudo — segue procurando

    const target = resolveRedirectTarget(redirectMatch[1], consts);
    if (!target) {
      return {
        kind: "unresolvable-branch",
        reason: `achou "if (url.host === ...) { ... return Response.redirect(...) }" pra ${host}, mas não deu pra resolver o host de destino do redirect (não é interpolação de const conhecida nem literal http(s) direto)`,
      };
    }
    return { kind: "redirect-target", targetHost: target };
  }

  if (sawHostMention) {
    return {
      kind: "unresolvable-branch",
      reason: `${host} aparece em alguma condição "url.host === ..." mas nenhum bloco casa o padrão redirect-tudo reconhecido (redirect condicionado também por url.pathname, ou bloco sem "return Response.redirect(...)")`,
    };
  }
  return { kind: "no-branch" };
}

export type HostRobotsVerdict =
  /** Host alcança o roteamento normal do Worker (sem ramificação por host),
   *  e o Worker serve robots.txt próprio (public/robots.txt válido OU
   *  dispatch de rota em src/). */
  | { kind: "ok-direct" }
  /** Host redireciona incondicionalmente (todo path, `/robots.txt`
   *  inclusive) pra `targetHost` — verificado que `targetHost` é outro host
   *  declarado pelo MESMO workerDir (irmão em `siblingHosts`) e que o
   *  workerDir serve robots.txt próprio (senão o redirect levaria a lugar
   *  nenhum, ou a um destino que este guard não tem como confirmar). */
  | { kind: "ok-redirect"; targetHost: string }
  /** Host alcança o roteamento normal (sem ramificação), mas o Worker NÃO
   *  serve robots.txt próprio — nasceu servindo o default da Cloudflare
   *  (#4546/#4777). Falha real, mesma classe de antes deste guard existir. */
  | { kind: "missing" }
  /** O guard não conseguiu determinar o comportamento deste host com
   *  confiança — NUNCA tratado como "ok" (regra do #7733: falhar alto e
   *  nomear o motivo é preferível a passar em silêncio por não ter
   *  entendido o roteamento). */
  | { kind: "cannot-verify"; reason: string };

/**
 * Classifica como `host` (dentro de `workerDir`) é tratado pra fins de
 * `/robots.txt` — o núcleo host-aware do guard (#7733). Só responde sobre
 * ROTEAMENTO (a request deste host alcança algum handler de robots.txt?);
 * a checagem de CONTEÚDO de `public/robots.txt` (`robotsTxtAllowsGeneralCrawling`)
 * continua no lado do teste, como antes (#4782 achado 2) — a separação
 * evita que esta função precise conhecer a política de conteúdo.
 *
 * `siblingHosts` (opcional): todos os hosts declarados por `workerDir`
 * (`custom_domain = true`, incluindo o próprio `host`) — quando fornecido,
 * um redirect-tudo só vira `ok-redirect` se o alvo resolvido for de fato um
 * DESSES hosts (não basta o workerDir ter ALGUM handler em algum lugar; o
 * redirect precisa apontar pra um host que o próprio Worker declara e
 * serve). Omitido (chamadores que não têm a lista à mão, ex: testes
 * unitários isolados) cai pro critério mais fraco de antes: só "o workerDir
 * tem handling em algum lugar" — ainda estrito o bastante pra nunca dar
 * `ok` num alvo não-resolvível.
 */
export function classifyHostRobotsHandling(
  workersDir: string,
  workerDir: string,
  host: string,
  siblingHosts?: string[],
): HostRobotsVerdict {
  const dirPath = join(workersDir, workerDir);
  const publicRobots = join(dirPath, "public", "robots.txt");
  const srcDir = join(dirPath, "src");

  const ownHandlingExists = existsSync(publicRobots) || anyTsFileHasRobotsRouteDispatch(srcDir);
  const allSource = collectAllTsSource(srcDir);
  const branching = analyzeHostBranching(allSource, host);

  if (branching.kind === "unresolvable-branch") {
    return { kind: "cannot-verify", reason: branching.reason };
  }

  if (branching.kind === "redirect-target") {
    if (siblingHosts && !siblingHosts.includes(branching.targetHost)) {
      return {
        kind: "cannot-verify",
        reason:
          `${host} redireciona (padrão redirect-tudo) para "${branching.targetHost}", que não é nenhum dos hosts ` +
          `declarados por workers/${workerDir} (${siblingHosts.join(", ")}) — não dá pra confirmar que o destino ` +
          `serve robots.txt sem sair do escopo deste Worker`,
      };
    }
    if (!ownHandlingExists) {
      return {
        kind: "cannot-verify",
        reason:
          `${host} redireciona (padrão redirect-tudo) para "${branching.targetHost}", mas workers/${workerDir} ` +
          `não tem public/robots.txt nem dispatch de rota — não dá pra confirmar que o destino serve robots.txt`,
      };
    }
    return { kind: "ok-redirect", targetHost: branching.targetHost };
  }

  // branching.kind === "no-branch": host alcança o roteamento normal.
  return ownHandlingExists ? { kind: "ok-direct" } : { kind: "missing" };
}
