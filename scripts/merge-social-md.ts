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
 * #3991 (260724, reverte #3486): o texto de social passa a ser ÚNICO —
 * `social-linkedin`, `social-facebook` e `social-instagram` (3 agents, textos
 * DIFERENTES por canal) foram colapsados em 1 único agent `social-writer`,
 * que escreve `_internal/03-social.tmp.md` com o texto genérico (estilo
 * Instagram, sem qualquer CTA/linguagem de canal) + `## post_pixel`. O merge
 * grava isso como seção única `# Social` — substitui `# LinkedIn` / `# Facebook`
 * / `# Instagram`. Cada publisher (`publish-linkedin.ts`/`publish-facebook.ts`/
 * `publish-instagram.ts`) injeta sua própria linha de CTA no momento do
 * publish via `scripts/lib/social-cta-lines.ts` — NUNCA aqui. `social-linkedin.md`
 * /`social-facebook.md`/`social-instagram.md` permanecem no repo como
 * referência histórica, mas não são mais dispatchados no Stage 2.
 *
 * Compat com edições antigas: `03-social.md` no formato legado (3 headers de
 * plataforma, já publicado ou em progresso antes deste merge) não é
 * re-gerado — os lints/publishers mantêm fallback pro formato antigo onde
 * fizer sentido (ver `scripts/lib/social-lint-rules.ts`), mas este script só
 * sabe produzir o formato novo daqui em diante.
 *
 * #3992: também mescla `_internal/03-curto.tmp.md` (agent `social-curto`) em
 * `# Curto`, quando presente. Esse tmp é OPCIONAL — ausência não falha o
 * merge, só omite a seção (edições antigas continuam com o fallback de
 * `publish-threads.ts` pra `# Facebook`; `publish-twitter.ts`, #3994, não tem
 * fallback — sem `# Curto` ele pula com log, por decisão do editor). `# Curto`
 * é INDEPENDENTE desta unificação — texto curto Twitter/Threads, não afetado
 * pelo #3991.
 *
 * #3471: também injeta uma seção `## eia` dentro de `# Social` (entre os
 * destaques `## d1/d2/d3` e `## post_pixel`, posição pedida pelo editor) com
 * o post social do "É IA?" do dia, pronto pra publicação MANUAL. Lida
 * `01-eia.md` (raiz da edição — gerado por `eia-compose.ts`) e monta o bloco
 * de forma determinística (`extractEiaCreditLine` + `buildEiaSocialSection` +
 * `insertEiaSection`, todos exportados/testados). NUNCA lê o frontmatter
 * `eia_answer` (o gabarito) — só a linha de crédito, que já é pública. É
 * OPCIONAL: `01-eia.md` ausente ou num formato inesperado só omite a seção
 * (warn no stderr), nunca falha o merge.
 *
 * Uso:
 *   npx tsx scripts/merge-social-md.ts --edition-dir data/editions/260507/
 *
 * Exit codes:
 *   0 — merge OK + tmps deletados
 *   1 — tmp obrigatório (social-writer) ausente/vazio, comments mal-formados,
 *       ou falha de FS
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
  platform: "linkedin" | "facebook" | "instagram" | "curto" | "social",
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

/**
 * extractEiaCreditLine (#3471)
 *
 * Extrai a linha de crédito do "É IA?" do dia a partir do BODY de `01-eia.md`
 * — nunca do frontmatter YAML, que carrega `eia_answer` (A/B → real/ia, o
 * GABARITO do quiz). Vazar o gabarito no social estragaria o jogo pros
 * leitores que ainda não abriram a edição.
 *
 * Formato de `01-eia.md` (ver `eia-compose.ts` `buildEiaMd`):
 *   ---
 *   eia_answer:
 *     A: real|ia
 *     B: real|ia
 *   ---
 *
 *   **É IA?**
 *
 *   <linha de crédito>
 *
 *   [Resultado da última edição: ...]  (opcional, #107)
 *
 * Retorna a 1ª linha não-vazia após o header `**É IA?**`, ou `null` se o
 * arquivo não seguir o formato esperado (edição antiga/corrompida) — o
 * caller trata isso como "sem bloco social pra É IA? nesta edição", nunca
 * falha o merge por causa disso.
 */
export function extractEiaCreditLine(eiaMd: string): string | null {
  const withoutFrontmatter = eiaMd.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const lines = withoutFrontmatter.replace(/\r\n/g, "\n").split("\n");
  let seenHeader = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!seenHeader) {
      if (/^\*\*É IA\?\*\*$/i.test(line)) seenHeader = true;
      continue;
    }
    if (line.length === 0) continue;
    return line;
  }
  return null;
}

/**
 * buildEiaSocialSection (#3471)
 *
 * Monta a seção `## eia` do "É IA?" do dia pro `03-social.md` — texto
 * copy-paste pronto pra publicação MANUAL nas redes (pedido do editor,
 * issue #3471: "só disponibilizar o artefato pronto pra copiar/postar").
 *
 * Template-based (mesma filosofia de `eia-compose.ts`: "credit line e SD
 * prompt são template-based, não natural-language poetry" — editor pode
 * polir no gate se quiser). Passa pelo humanizador/Clarice igual ao resto
 * de `03-social.md` (roda in-place no arquivo inteiro, #1072), então o tom
 * final ainda é calibrado — este template é só o ponto de partida.
 *
 * NUNCA inclui o gabarito (`eia_answer`) — só a linha de crédito, que já é
 * pública (mesmo texto que aparece pro leitor em `01-eia.md`/na newsletter).
 *
 * Publicação continua manual por construção, sem guard extra necessário:
 * `publish-linkedin.ts` só itera destaques `["d1","d2","d3"]` e trata
 * `post_pixel` como caso manual à parte (#1690) — a seção `## eia` nunca
 * entra em nenhum desses loops, logo nunca é dispatchada automaticamente.
 */
export function buildEiaSocialSection(creditLine: string): string {
  const body = [
    "É IA? 🧐",
    "",
    "Duas imagens no post: uma é foto real, a outra foi gerada por inteligência artificial. Veja se consegue diferenciar antes de conferir a resposta.",
    "",
    creditLine,
    "",
    "Vote respondendo o quiz na edição da newsletter em diar.ia.br e confira o resultado na edição seguinte.",
    "",
    "Imagens para o post: 01-eia-A.jpg (opção A) e 01-eia-B.jpg (opção B).",
  ].join("\n");
  return `## eia\n\n<!-- destaque: eia -->\n\n${body}\n`;
}

/**
 * insertEiaSection (#3471)
 *
 * Insere a seção `## eia` dentro do conteúdo LinkedIn já processado (header
 * de plataforma `# LinkedIn` já removido pelo caller), na posição pedida
 * pelo editor (issue #3471, comentário 260714): imediatamente ANTES de
 * `## post_pixel` — ou seja, depois dos posts dos destaques (`## d1/d2/d3`
 * + comments), antes do post pessoal standalone do Pixel.
 *
 * Sem `## post_pixel` no conteúdo (edição antiga, ou campo não gerado por
 * algum motivo), acrescenta a seção ao final — nunca descarta o bloco.
 */
export function insertEiaSection(linkedinBody: string, eiaSection: string): string {
  const body = linkedinBody.replace(/\r\n/g, "\n");
  const ppHeaderRe = /\n## post_pixel\b/i;
  const m = ppHeaderRe.exec(body);
  if (!m) {
    return `${body.trimEnd()}\n\n${eiaSection.trim()}\n`;
  }
  const before = body.slice(0, m.index);
  const after = body.slice(m.index); // começa com "\n## post_pixel..."
  return `${before.trimEnd()}\n\n${eiaSection.trim()}\n${after}`;
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

/**
 * readOptionalTmp (#3486, generalizado #3992/#3991)
 *
 * Análogo a `readTmpOrFail`, mas pra tmps OPCIONAIS: se ausente ou vazio,
 * retorna `null` (warn no stderr) em vez de `process.exit(1)`. Usado hoje só
 * pelo tmp do `social-curto` (`# Curto`) — uma edição sem `03-curto.tmp.md`
 * (ex: worktree/teste antigo, ou o agent ainda não foi disparado) não deve
 * quebrar o merge; `03-social.md` simplesmente sai sem `# Curto` (os
 * publishers de Threads/Twitter/X têm seus próprios fallbacks, ver
 * `publish-threads.ts`/`publish-twitter.ts`).
 */
function readOptionalTmp(check: TmpCheck): string | null {
  if (!existsSync(check.path)) return null;
  if (statSync(check.path).size === 0) {
    console.error(
      `merge-social-md: warn — tmp file vazio (0 bytes) para agent opcional '${check.agent}' — ` +
        `pulando seção: ${check.path}`,
    );
    return null;
  }
  try {
    return readFileSync(check.path, "utf8");
  } catch (err) {
    console.error(
      `merge-social-md: warn — erro lendo tmp opcional para agent '${check.agent}': ${(err as Error).message}`,
    );
    return null;
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
  // #3991: agent único `social-writer` substitui social-linkedin/facebook/
  // instagram — 1 texto genérico por destaque + `## post_pixel`, sem CTA de
  // canal. Único tmp FATAL do merge.
  const socialTmp: TmpCheck = {
    agent: "social-writer",
    path: resolve(editionDir, "_internal/03-social.tmp.md"),
  };
  // #3992: tmp OPCIONAL — social-curto (texto único Twitter/Threads);
  // ausência não falha o merge, independente do #3991.
  const curtoTmp: TmpCheck = {
    agent: "social-curto",
    path: resolve(editionDir, "_internal/03-curto.tmp.md"),
  };

  const socialRaw = readTmpOrFail(socialTmp);
  const curtoRaw = readOptionalTmp(curtoTmp);

  let socialStripped: string;
  let curtoStripped: string | null = null;
  try {
    const soc = stripHtmlComments(socialRaw);
    socialStripped = soc.stripped.trim();
    const warnings = [...soc.warnings];
    if (curtoRaw !== null) {
      const curto = stripHtmlComments(curtoRaw);
      curtoStripped = curto.stripped.trim();
      warnings.push(...curto.warnings);
    }
    for (const w of warnings) {
      console.error(`merge-social-md: warn — ${w}`);
    }
  } catch (err) {
    console.error(`merge-social-md: FALHOU — ${(err as Error).message}`);
    process.exit(1);
  }

  // #3424 (aplicado ao formato #3991): strip de header pré-existente ANTES
  // do header canônico ser prependado abaixo — impede duplicação na fonte,
  // em vez de só deixar `lintPlatformHeadersUnique` (#3388) detectar depois
  // do fato.
  const socialAfterHeaderStrip = stripLeadingPlatformHeader(socialStripped, "social");
  if (socialAfterHeaderStrip !== socialStripped) {
    console.error(
      `merge-social-md: warn — tmp file de Social já continha o header "# Social" — removido antes do merge (#3424).`,
    );
  }
  socialStripped = socialAfterHeaderStrip.trim();

  // #3471: seção "## eia" — best-effort, opcional. `01-eia.md` (ou o legacy
  // `01-eai.md` pré-#428) mora na RAIZ da edição, não em `_internal/` — lido
  // aqui, não em `editionDirArg`, porque o merge roda com `--edition-dir`
  // apontando pro root da edição já. Nunca falha o merge por causa disso:
  // 01-eia.md pode ainda não existir (eia-compose roda em background bash
  // desde o Stage 1, #1111) ou pode estar num formato inesperado — nesses
  // casos, `03-social.md` sai igual ao formato pré-#3471, sem a seção.
  const eiaMdPath = existsSync(resolve(editionDir, "01-eia.md"))
    ? resolve(editionDir, "01-eia.md")
    : existsSync(resolve(editionDir, "01-eai.md"))
      ? resolve(editionDir, "01-eai.md")
      : null;
  if (eiaMdPath) {
    try {
      const eiaRaw = readFileSync(eiaMdPath, "utf8");
      const creditLine = extractEiaCreditLine(eiaRaw);
      if (creditLine) {
        const eiaSection = buildEiaSocialSection(creditLine);
        socialStripped = insertEiaSection(socialStripped, eiaSection).trim();
        console.error(`merge-social-md: info — seção '## eia' incluída (#3471) a partir de ${eiaMdPath}`);
      } else {
        console.error(
          `merge-social-md: warn — ${eiaMdPath} encontrado mas linha de crédito não extraída (formato inesperado) — pulando seção '## eia' (#3471).`,
        );
      }
    } catch (err) {
      console.error(
        `merge-social-md: warn — falha lendo ${eiaMdPath} para seção '## eia' (não-fatal, #3471): ${(err as Error).message}`,
      );
    }
  } else {
    console.error(`merge-social-md: info — 01-eia.md ausente em ${editionDir} — seção '## eia' não incluída (#3471).`);
  }

  // #3992: mesmo strip de header pré-existente, aplicado ao Curto quando o
  // tmp opcional estiver presente.
  if (curtoStripped !== null) {
    const curtoAfterHeaderStrip = stripLeadingPlatformHeader(curtoStripped, "curto");
    if (curtoAfterHeaderStrip !== curtoStripped) {
      console.error(
        `merge-social-md: warn — tmp file de Curto já continha o header "# Curto" — removido antes do merge (#3424).`,
      );
    }
    curtoStripped = curtoAfterHeaderStrip.trim();
  }

  // #3991: seção única `# Social` — substitui `# LinkedIn`/`# Facebook`/
  // `# Instagram`. Banner explica que a linha de CTA por canal é injetada só
  // no publish (nunca aparece aqui) e que `post_pixel` continua manual.
  const socialHeader =
    `# Social\n\n> **Texto único (#3991)** — o mesmo corpo + hashtags vai para LinkedIn, ` +
    `Facebook e Instagram. Cada publisher injeta sua própria linha de CTA/canal no momento ` +
    `do publish (\`scripts/lib/social-cta-lines.ts\`) — esta seção nunca contém CTA de canal. ` +
    `\`post_pixel\` é publicado manualmente no feed pessoal via Claude in Chrome (#1690).\n`;
  // #3992: seção `# Curto` só entra quando o tmp opcional existe — texto único
  // compartilhado por Twitter/X (publish-twitter.ts, #3994) e Threads
  // (publish-threads.ts, que passa a preferir esta seção ao fallback Facebook).
  // Independente do #3991 — não muda.
  const curtoSection = curtoStripped !== null ? `\n\n# Curto\n\n${curtoStripped}` : "";
  const merged = `${socialHeader}\n${socialStripped}${curtoSection}\n`;
  const outPath = resolve(editionDir, "03-social.md");

  try {
    writeFileSync(outPath, merged, "utf8");
  } catch (err) {
    console.error(
      `merge-social-md: FALHOU — erro gravando ${outPath}:\n  ${(err as Error).message}`,
    );
    process.exit(1);
  }

  // Deletar tmps só após sucesso na escrita do output final. Curto só entra
  // na lista se de fato foi lido (existsSync) — evita tentar unlink de um
  // arquivo que nunca existiu.
  const tmpsToDelete = [socialTmp];
  if (curtoRaw !== null) tmpsToDelete.push(curtoTmp);
  for (const tmp of tmpsToDelete) {
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
