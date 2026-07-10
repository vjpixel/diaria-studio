/**
 * resolve-edition-url.ts (#2454, write-then-validate #3223, guard não-fatal #3277)
 *
 * Resolve a URL pública da edição a partir do slug do draft Beehiiv e grava
 * em `_internal/05-edition-url.txt` para consumo pelo publish-linkedin.ts e
 * publish-facebook.ts.
 *
 * Deve ser rodado APÓS o draft Beehiiv ser criado (beehiiv-playbook.md passo 8)
 * e ANTES do dispatch do social (publish-linkedin + publish-facebook).
 *
 * Fontes (ordem de precedência):
 *   1. --title        → deriveEditionUrl(title) via seoSlug (mesmo algoritmo de §4a-bis)
 *   2. --slug         → URL direta (quando o slug já foi derivado / corrigido)
 *   3. --edition-url  → URL literal (override manual, qualquer valor)
 *
 * Guard anti-placeholder (write-then-validate, #3223; não-fatal, #3277):
 *   Com --validate-social, lê 03-social.md, substitui {edition_url} pela URL
 *   resolvida e REESCREVE o arquivo (atômico) — só então roda
 *   findUnresolvedPlaceholders no conteúdo JÁ substituído.
 *
 *   Antes do #3223, o guard rodava sobre o 03-social.md ORIGINAL (nunca
 *   reescrito) — {edition_url} literal sempre presente por design (assim
 *   stitch-newsletter.ts/social-linkedin geram o arquivo), então o guard
 *   sempre falhava com exit 3 em qualquer edição normal.
 *
 *   #3277: um placeholder {snake_case} remanescente APÓS a substituição de
 *   {edition_url} é ambíguo — pode ser um bug real (writer/stitch esqueceu de
 *   resolver um placeholder), mas também pode ser prosa legítima citando um
 *   exemplo de prompt/campo de API entre chaves (plausível numa newsletter de
 *   IA — ex: {system_prompt}). Como as duas formas são sintaticamente
 *   idênticas, o guard não pode distinguir uma da outra de forma confiável —
 *   travar TODO o dispatch social (LinkedIn+Facebook+Instagram+Threads) da
 *   edição inteira por um falso positivo tem blast radius desproporcional ao
 *   risco. Por isso o guard deixou de ser fatal: ainda detecta e AVISA (stderr
 *   + `data/run-log.jsonl` via `logEvent`, nível warn — visível via
 *   `/diaria-log {edition} warn`), mas não bloqueia mais o dispatch (exit 0).
 *   {edition_url} continua sendo substituído normalmente antes do aviso.
 *
 * Uso:
 *   npx tsx scripts/resolve-edition-url.ts \
 *     --edition-dir data/editions/260623/ \
 *     --title "Título D1 da edição"
 *     [--validate-social]   # avisar (não bloquear) se sobrar placeholder em 03-social.md
 *
 *   npx tsx scripts/resolve-edition-url.ts \
 *     --edition-dir data/editions/260623/ \
 *     --slug "titulo-d1-da-edicao"
 *     [--validate-social]
 *
 *   npx tsx scripts/resolve-edition-url.ts \
 *     --edition-dir data/editions/260623/ \
 *     --edition-url "https://diar.ia.br/p/titulo-d1-da-edicao"
 *     [--validate-social]
 *
 * Exit codes:
 *   0 — URL gravada com sucesso. Com --validate-social, sempre 0 mesmo quando
 *       sobra placeholder não-resolvido em 03-social.md (#3277) — nesse caso
 *       um warning é impresso e persistido em data/run-log.jsonl, mas o
 *       dispatch social não é bloqueado.
 *   1 — Erro de input / arquivo ausente
 *   (3 — descontinuado em #3277; o guard anti-placeholder não é mais fatal.
 *        Mantido documentado aqui para quem procurar histórico de exit codes.)
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveEditionUrl,
  findUnresolvedPlaceholders,
  substituteEditionUrl,
  BEEHIIV_BASE_URL,
} from "./lib/edition-url.ts";
import { seoSlug } from "./lib/slug.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { parseArgs as parseArgsLib, isMainModule } from "./lib/cli-args.ts";
import { logEvent } from "./lib/run-log.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── CLI parser ────────────────────────────────────────────────────────────────
// #finding3: corrige crash quando --title (ou --slug / --edition-url) é seguido
// de outra flag em vez de um valor. A lógica anterior tratava a próxima flag como
// o valor da opção anterior (ex: --title --validate-social definia title="--validate-social").
// Agora: flags booleanas conhecidas são tratadas separadamente; qualquer argumento
// que começa com "--" não é consumido como valor de outra flag.

// #2834: --validate-social é flag booleana incondicional (sempre true quando
// presente, independente do que vem depois) — argv.includes preserva isso
// mesmo se o token seguinte pareceria um valor consumível. As demais flags
// (--title/--slug/--edition-url/--edition-dir) usam consumo condicional
// (só consome o próximo token se não começar com "--"), que é exatamente o
// comportamento canônico de parseArgs.
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const { values } = parseArgsLib(argv);
  const args: Record<string, string | boolean> = { ...values };
  if (argv.includes("--validate-social")) args["validate-social"] = true;
  return args;
}

/**
 * #3277 (code review, PR #3289): emite o warning não-fatal do guard
 * anti-placeholder — stderr + `data/run-log.jsonl` (nível warn, via
 * `logEvent`). Extraído de `main()` pra ser testável sem precisar spawnar o
 * CLI inteiro (#633) — mesmo padrão de `scripts/select-eia-edition.ts`
 * (`signalEiaFallback`).
 *
 * `rootDir` é repassado a `logEvent` (default `undefined` → `logEvent` cai
 * pro seu próprio default `process.cwd()`). `main()` SEMPRE passa `ROOT`
 * explicitamente (não confia em `process.cwd()`) — o resto do arquivo já
 * resolve `--edition-dir` contra `ROOT` pelo mesmo motivo (#2454), então
 * o log deve seguir a mesma âncora, cwd-independente. Tests injetam um
 * tmpdir aqui pra não gravar warns fabricados em `data/run-log.jsonl` de
 * produção — sem isso, `logEvent` caía no `process.cwd()` do processo
 * spawnado (= cwd do test runner, tipicamente a raiz real do repo),
 * poluindo o log operacional real com edições de teste fictícias
 * (achado empírico do code-review desta PR — dezenas de entries com
 * edition "260999" apareceram em data/run-log.jsonl real durante os testes).
 */
export function warnUnresolvedPlaceholders(
  unresolved: string[],
  editionId: string | null,
  editionUrl: string,
  socialMdPath: string,
  rootDir?: string,
): void {
  const logHint = editionId
    ? `\`/diaria-log ${editionId} warn\``
    : `\`/diaria-log\` filtrando por agent "resolve-edition-url" (edição não detectada a partir de --edition-dir)`;
  console.warn(`AVISO (#3277 guard anti-placeholder — não-fatal): 03-social.md contém possíveis placeholders não-resolvidos mesmo APÓS a substituição de {edition_url}:
  ${unresolved.join(", ")}

O dispatch social NÃO foi bloqueado — isso pode ser um bug real (writer/stitch esqueceu de resolver
um placeholder) OU prosa legítima citando um exemplo de prompt/campo de API entre chaves (comum em
conteúdo sobre IA). Revisão humana recomendada — ver ${logHint}.
  → {edition_url} já foi substituído por este script (gravado: ${editionUrl}).
  → o(s) placeholder(s) acima não é {edition_url} — se for um bug, verificar origem (writer-destaque/social-linkedin/social-facebook/stitch-newsletter).`);
  logEvent(
    {
      edition: editionId,
      stage: 5,
      agent: "resolve-edition-url",
      level: "warn",
      message: `guard anti-placeholder (#3277): placeholder(s) não-resolvido(s) em 03-social.md, dispatch NÃO bloqueado — revisão humana recomendada`,
      details: { unresolved, edition_url: editionUrl, social_md_path: socialMdPath },
    },
    rootDir,
  );
}

// ── CLI guard ─────────────────────────────────────────────────────────────────
// Prevent accidental execution when imported from tests
if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2));
}

function main(argv: string[]): void {
  const args = parseArgs(argv);

  const editionDirRaw = args["edition-dir"] as string | undefined;
  if (!editionDirRaw || typeof editionDirRaw !== "string") {
    console.error("Erro: --edition-dir é obrigatório.");
    process.exit(1);
  }
  const editionDir = resolve(ROOT, editionDirRaw);
  const internalDir = resolve(editionDir, "_internal");

  if (!existsSync(editionDir)) {
    console.error(`Erro: edition-dir não existe: ${editionDir}`);
    process.exit(1);
  }

  mkdirSync(internalDir, { recursive: true });

  // ── Resolver a URL ────────────────────────────────────────────────────────

  const titleArg = typeof args["title"] === "string" ? args["title"] : undefined;
  const slugArg = typeof args["slug"] === "string" ? args["slug"] : undefined;
  const editionUrlArg = typeof args["edition-url"] === "string" ? args["edition-url"] : undefined;

  let editionUrl: string;

  if (titleArg) {
    editionUrl = deriveEditionUrl(titleArg);
    console.log(`#2454: edition_url derivada do título → ${editionUrl}`);
    console.log(`       (slug: "${seoSlug(titleArg)}")`);
  } else if (slugArg) {
    editionUrl = `${BEEHIIV_BASE_URL}/p/${slugArg}`;
    console.log(`#2454: edition_url via slug → ${editionUrl}`);
  } else if (editionUrlArg) {
    editionUrl = editionUrlArg;
    console.log(`#2454: edition_url via override literal → ${editionUrl}`);
  } else {
    console.error(
      "Erro: uma das flags é obrigatória: --title <título> | --slug <slug> | --edition-url <url>\n" +
      "  --title é preferível (mesmo algoritmo seoSlug do playbook §4a-bis).",
    );
    process.exit(1);
  }

  // Validação mínima de formato
  if (!editionUrl.startsWith("https://")) {
    console.error(`Erro: URL derivada deve ser HTTPS: ${editionUrl}`);
    process.exit(1);
  }

  // ── Gravar 05-edition-url.txt (write atômico) ─────────────────────────────
  // #finding2: write atômico (tmp + rename) — garante que o arquivo é ou a versão
  // anterior completa ou a nova, nunca parcial (kill mid-write, crash, OOM).

  const outPath = resolve(internalDir, "05-edition-url.txt");
  writeFileAtomic(outPath, editionUrl, { encoding: "utf8" });
  console.log(`#2454: gravado → ${outPath}`);

  // ── Write-then-validate (--validate-social, #3223) ────────────────────────
  // Reescreve 03-social.md substituindo {edition_url} pela URL resolvida ANTES
  // de rodar o guard anti-placeholder — sem isso, findUnresolvedPlaceholders
  // rodava sobre o arquivo ORIGINAL (nunca tocado), que sempre contém
  // {edition_url} literal por design (assim stitch-newsletter.ts/social-linkedin
  // geram o arquivo), fazendo o guard falhar com exit 3 em toda edição normal.

  if (args["validate-social"]) {
    const socialMdPath = resolve(editionDir, "03-social.md");
    if (!existsSync(socialMdPath)) {
      console.error(
        `Erro (--validate-social): 03-social.md não encontrado em ${editionDir}. ` +
        `Rode a Etapa 2 primeiro.`,
      );
      process.exit(1);
    }
    const socialMd = readFileSync(socialMdPath, "utf8");
    const substituted = substituteEditionUrl(socialMd, editionUrl);
    if (substituted !== socialMd) {
      writeFileAtomic(socialMdPath, substituted, { encoding: "utf8" });
      console.log(`#3223: 03-social.md reescrito — {edition_url} substituído por ${editionUrl}`);
    }

    const unresolved = findUnresolvedPlaceholders(substituted);
    if (unresolved.length > 0) {
      // #3277: não-fatal. Um placeholder {snake_case} remanescente é ambíguo
      // (bug real vs. prosa citando um exemplo entre chaves) — avisar em vez
      // de travar o dispatch social da edição inteira num falso positivo.
      // Ver docstring de warnUnresolvedPlaceholders() pro porquê do rootDir.
      //
      // #3277 code-review finding: a confirmação "OK" da escrita é emitida
      // AQUI (não incondicionalmente no fim da função) — ela é verdadeira (o
      // arquivo FOI gravado com sucesso) — e então retornamos logo após o
      // AVISO, sem cair no "OK" final abaixo. Isso garante duas coisas ao
      // mesmo tempo: (a) o AVISO é a ÚLTIMA linha do output quando presente
      // (mais visível pra quem lê só a cauda do stdout), e (b) "OK" nunca é
      // impresso incondicionalmente antes de um exit(1) mais adiante (bug
      // encontrado pelo próprio code-review desta PR numa iteração anterior
      // deste fix: mover o "OK" pra logo após o write fazia ele imprimir
      // mesmo quando --validate-social ia abortar com exit(1) por
      // 03-social.md ausente — essa checagem já passou nesse ponto do fluxo,
      // então aqui "OK" é sempre verdadeiro).
      console.log(`OK: edition_url="${editionUrl}" gravada em ${outPath}`);
      const editionId = basename(editionDir).match(/^\d{6}/)?.[0] ?? null;
      warnUnresolvedPlaceholders(unresolved, editionId, editionUrl, socialMdPath, ROOT);
      return;
    }
    console.log(`#3223: guard anti-placeholder OK — nenhum placeholder não-resolvido em 03-social.md.`);
  }

  // Sucesso (sem --validate-social, OU --validate-social sem placeholder pendente)
  console.log(`OK: edition_url="${editionUrl}" gravada em ${outPath}`);
}
