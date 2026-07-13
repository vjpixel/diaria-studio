/**
 * merge-social-md.ts (#870, #875)
 *
 * Substitui o node inline snippet antigo do orchestrator-stage-2 que mesclava
 * `_internal/03-linkedin.tmp.md` + `_internal/03-facebook.tmp.md` em
 * `03-social.md`. Adiciona:
 *
 * - Validação determinística de tmp files (existência + não-vazio) com erro
 *   acionável apontando qual agent falhou (#872 wiring).
 * - Strip de comentários HTML defensivo (#875): valida balanceamento de
 *   `<!--`/`-->` antes de aplicar a regex lazy. Comment não-fechado deixaria
 *   conteúdo de debug vazar no markdown publicável — preferimos abortar.
 * - try/catch ao redor de todas as ops de FS, mensagens de erro úteis em
 *   stderr (#870 — antes era node -e inline sem nenhum tratamento).
 *
 * Uso:
 *   npx tsx scripts/merge-social-md.ts --edition-dir data/editions/260507/
 *
 * Exit codes:
 *   0 — merge OK + tmps deletados
 *   1 — algum tmp ausente/vazio, comments mal-formados, ou falha de FS
 */

import {
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hashFromApprovedFile } from "./lib/social-source-hash.ts";
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Conta ocorrências não-sobrepostas de `needle` em `haystack`.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count++;
    pos = idx + needle.length;
  }
  return count;
}

export interface StripResult {
  stripped: string;
  warnings: string[];
}

/**
 * Remove comentários HTML do conteúdo. Defensivo (#875):
 *
 * - Valida balanceamento de `<!--` / `-->`. Se contagens diferem, lança
 *   erro — comment não-fechado vazaria conteúdo de debug no MD publicável.
 * - Strip via depth-aware scan, tratando nested `<!-- a <!-- b --> c -->`
 *   como um único bloco (a regex lazy `/<!--[\s\S]*?-->/g` quebraria isso).
 * - Após strip, se ainda restar `<!--` ou `-->` solto, lança erro (defesa
 *   contra inputs com counts batendo mas estrutura inválida).
 * - Colapsa ≥3 newlines em 2.
 */
export function stripHtmlComments(input: string): StripResult {
  const opens = countOccurrences(input, "<!--");
  const closes = countOccurrences(input, "-->");
  const warnings: string[] = [];

  if (opens !== closes) {
    throw new Error(
      `HTML comments mal-formados: ${opens} '<!--' vs ${closes} '-->'. ` +
        `Comment não-fechado deixaria conteúdo de debug vazar no MD publicável. ` +
        `Verifique os tmp files e re-rode os agents social.`,
    );
  }

  if (opens === 0) {
    return { stripped: input.replace(/\n{3,}/g, "\n\n"), warnings };
  }

  // Depth-aware scan: o nesting de `<!-- ... <!-- ... --> ... -->` exige tracking
  // de profundidade. A regex lazy padrão consumiria o `-->` interno,
  // deixando o externo solto.
  const out: string[] = [];
  let depth = 0;
  let i = 0;
  let nested = false;
  while (i < input.length) {
    if (input.startsWith("<!--", i)) {
      if (depth > 0) nested = true;
      depth++;
      i += 4;
      continue;
    }
    if (input.startsWith("-->", i) && depth > 0) {
      depth--;
      i += 3;
      continue;
    }
    if (depth === 0) {
      out.push(input[i]);
    }
    i++;
  }

  if (nested) {
    warnings.push(
      `stripHtmlComments: comment(s) nested detectado(s) — strip depth-aware aplicado.`,
    );
  }

  let stripped = out.join("");

  // Sanity check: depth zerou + counts batem ⇒ não deveria ter marker solto.
  if (stripped.includes("<!--") || stripped.includes("-->")) {
    throw new Error(
      `Após strip, marcadores de comment ainda presentes — input provavelmente ` +
        `mal-formado (counts batem mas estrutura é inválida). Conteúdo restante:\n${stripped.slice(0, 200)}`,
    );
  }

  stripped = stripped.replace(/\n{3,}/g, "\n\n");
  return { stripped, warnings };
}

/**
 * stripLeadingPlatformHeader (#3424)
 *
 * `main()` abaixo prepende `# LinkedIn`/`# Facebook` incondicionalmente ao
 * conteúdo recebido de cada tmp file. Se o agent (`social-linkedin` /
 * `social-facebook`) já escreveu esse mesmo header no início do seu próprio
 * tmp file, o merge produzia 2 headers idênticos em sequência — root cause
 * confirmado do incidente #3388 (edição 260713): `extractPlatformSection`
 * (scripts/lib/social-lint-rules.ts) para no PRÓXIMO `# ` top-level, então o
 * conteúdo real ficava "fora" da seção capturada.
 *
 * `lintPlatformHeadersUnique` (scripts/lib/social-lint-rules.ts, #3388) só
 * DETECTA a duplicata depois do fato. Esta função torna o merge
 * estruturalmente imune à classe de bug: remove um header de plataforma
 * pré-existente do INÍCIO do conteúdo (mesma linha reconhecida por
 * `lintPlatformHeadersUnique` — `^# LinkedIn\s*$` / `^# Facebook\s*$`,
 * case-insensitive, whitespace tolerado) antes do header canônico ser
 * prependado. Só remove se o header for a primeira linha não-vazia — um
 * header solto no meio/fim do texto (não é o que este bug produz) não é
 * tocado.
 */
export function stripLeadingPlatformHeader(
  content: string,
  platform: "linkedin" | "facebook",
): string {
  const platTitle = platform.charAt(0).toUpperCase() + platform.slice(1);
  const headerRe = new RegExp(`^# ${platTitle}\\s*$`, "i");
  const lines = content.split("\n");

  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length || !headerRe.test(lines[i])) return content;

  i++; // pular a linha do header
  while (i < lines.length && lines[i].trim() === "") i++;
  return lines.slice(i).join("\n");
}

interface TmpCheck {
  agent: string;
  path: string;
}

function readTmpOrFail(check: TmpCheck): string {
  if (!existsSync(check.path)) {
    console.error(
      `merge-social-md: FALHOU — tmp file ausente para agent '${check.agent}':\n` +
        `  ${check.path}\n\n` +
        `Agent '${check.agent}' provavelmente falhou silenciosamente. ` +
        `Re-rodar: /diaria-2-escrita {AAMMDD} social`,
    );
    process.exit(1);
  }
  if (statSync(check.path).size === 0) {
    console.error(
      `merge-social-md: FALHOU — tmp file vazio (0 bytes) para agent '${check.agent}':\n` +
        `  ${check.path}\n\n` +
        `Agent '${check.agent}' retornou sem escrever conteúdo. ` +
        `Re-rodar: /diaria-2-escrita {AAMMDD} social`,
    );
    process.exit(1);
  }
  try {
    return readFileSync(check.path, "utf8");
  } catch (err) {
    console.error(
      `merge-social-md: FALHOU — erro lendo tmp file para agent '${check.agent}':\n` +
        `  ${check.path}\n  ${(err as Error).message}`,
    );
    process.exit(1);
  }
}

function main(): void {
  const args = parseArgsSimple(process.argv.slice(2));
  const editionDirArg = args["edition-dir"];
  if (!editionDirArg) {
    console.error("Erro: --edition-dir obrigatório.");
    process.exit(1);
  }

  const editionDir = resolve(ROOT, editionDirArg);
  const linkedinTmp: TmpCheck = {
    agent: "social-linkedin",
    path: resolve(editionDir, "_internal/03-linkedin.tmp.md"),
  };
  const facebookTmp: TmpCheck = {
    agent: "social-facebook",
    path: resolve(editionDir, "_internal/03-facebook.tmp.md"),
  };

  const liRaw = readTmpOrFail(linkedinTmp);
  const fbRaw = readTmpOrFail(facebookTmp);

  let liStripped: string;
  let fbStripped: string;
  try {
    const li = stripHtmlComments(liRaw);
    const fb = stripHtmlComments(fbRaw);
    liStripped = li.stripped.trim();
    fbStripped = fb.stripped.trim();
    for (const w of [...li.warnings, ...fb.warnings]) {
      console.error(`merge-social-md: warn — ${w}`);
    }
  } catch (err) {
    console.error(`merge-social-md: FALHOU — ${(err as Error).message}`);
    process.exit(1);
  }

  // #3424: strip de header de plataforma pré-existente ANTES do header
  // canônico ser prependado abaixo — impede a duplicação na fonte, em vez de
  // só deixar `lintPlatformHeadersUnique` (#3388) detectar depois do fato.
  const liAfterHeaderStrip = stripLeadingPlatformHeader(liStripped, "linkedin");
  if (liAfterHeaderStrip !== liStripped) {
    console.error(
      `merge-social-md: warn — tmp file de LinkedIn já continha o header "# LinkedIn" — removido antes do merge (#3424).`,
    );
  }
  liStripped = liAfterHeaderStrip.trim();

  const fbAfterHeaderStrip = stripLeadingPlatformHeader(fbStripped, "facebook");
  if (fbAfterHeaderStrip !== fbStripped) {
    console.error(
      `merge-social-md: warn — tmp file de Facebook já continha o header "# Facebook" — removido antes do merge (#3424).`,
    );
  }
  fbStripped = fbAfterHeaderStrip.trim();

  // #1075 + #1310: AMBOS comment_diaria e comment_pixel são postagem manual.
  // Make.com LinkedIn module não suporta Create Comment nem em company page
  // (descoberto em 2026-05-15 após semanas de Make rejection emails) nem em
  // conta pessoal. publish-linkedin.ts agora skipa comments por default
  // (#1310 inverteu o flag). Banner explica que só o main é automatizado.
  const linkedinHeader = `# LinkedIn\n\n> **Postagem semi-automática (#1310 atualizou #1075):** \`main\` agenda via Worker→Make. \`comment_diaria\` (T+3min, company page) E \`comment_pixel\` (T+8min, conta pessoal) precisam ser postados manualmente — Make.com não suporta Create Comment em nenhum dos dois alvos. Copy-paste dos textos abaixo.\n`;
  const merged = `${linkedinHeader}\n${liStripped}\n\n# Facebook\n\n${fbStripped}\n`;
  const outPath = resolve(editionDir, "03-social.md");

  try {
    writeFileSync(outPath, merged, "utf8");
  } catch (err) {
    console.error(
      `merge-social-md: FALHOU — erro gravando ${outPath}:\n  ${(err as Error).message}`,
    );
    process.exit(1);
  }

  // Deletar tmps só após sucesso na escrita do output final.
  for (const tmp of [linkedinTmp, facebookTmp]) {
    try {
      unlinkSync(tmp.path);
    } catch (err) {
      console.error(
        `merge-social-md: warn — falha deletando ${tmp.path}: ${(err as Error).message}`,
      );
    }
  }

  // #1413: gravar hash dos highlights aprovados quando social.md foi
  // gerado. Stage 4 invariant rule (checkSocialHashFresh) compara hash
  // atual contra esse cached pra detectar reestrutura pós-Stage 2.
  // Best-effort: se approved.json não existir (test fixture), skip
  // silenciosamente — caller decide se isso é OK.
  const approvedPath = resolve(editionDir, "_internal/01-approved.json");
  if (existsSync(approvedPath)) {
    try {
      const hash = hashFromApprovedFile(approvedPath);
      const hashPath = resolve(editionDir, "_internal/.social-source-hash.json");
      writeFileSync(
        hashPath,
        JSON.stringify({ hash, generated_at: new Date().toISOString() }, null, 2) + "\n",
        "utf8",
      );
    } catch (err) {
      console.error(
        `merge-social-md: warn — falha gravando social-source-hash: ${(err as Error).message}`,
      );
    }
  }

  console.log(`merge-social-md: OK — ${outPath}`);
}

if (isMainModule(import.meta.url)) {
  main();
}
