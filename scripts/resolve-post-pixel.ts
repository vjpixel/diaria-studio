/**
 * resolve-post-pixel.ts (#3052, reescopado na #9568)
 *
 * Texto (e imagem) do post PESSOAL do LinkedIn (vjpixel) pro lembrete
 * não-bloqueante do gate do Stage 6. Sem token do app pessoal o perfil é
 * postado À MÃO (o Worker `linkedin-cron` recusa `webhook_target=pixel` com
 * `action=post`); com token, `publish-linkedin-personal.ts` reusa este mesmo
 * texto e publica sozinho no slot (#9568) — ver `context/publishers/linkedin.md`.
 *
 * Duas fontes, na ordem:
 *   1. `## um` de `# Social` (#9568) — o 4º post do item USE MELHOR, MESMO
 *      texto que a página agenda. Só vale quando o plano do Stage 5
 *      (`planUseMelhorDispatch`) está `ready` — item re-conferido contra o
 *      `02-reviewed.md` final; senão imprime `(nao encontrado)` + motivo e
 *      sai 1 (o editor não deve postar no pessoal um texto que a página pulou).
 *   2. `## post_pixel` LEGADO (edições anteriores à #9568, standalone de D1,
 *      #1690) — só quando a edição não tem `## um`. Resolve `{outros_count}`
 *      + `{edition_url}` (com UTM `post-pixel`, #4295).
 *
 * Uso:
 *   npx tsx scripts/resolve-post-pixel.ts --edition-dir data/editions/260707            # texto
 *   npx tsx scripts/resolve-post-pixel.ts --edition-dir ... --image                    # arquivo de imagem
 *   npx tsx scripts/resolve-post-pixel.ts --edition-dir ... --json                     # {source,text,image,scheduled_at}
 *   npx tsx scripts/resolve-post-pixel.ts --edition-dir ... --edition-url https://diar.ia.br/p/slug   (só legado)
 *   --config <path>  config alternativo (teste); default platform.config.json do repo.
 *
 * `--image`: `04-um-carousel-cover-4x5.jpg` (fonte `um`, só com carimbo do
 * carrossel em dia) ou `04-d1-1x1.jpg` (legado). Arquivo inexistente na edição
 * → `(nao encontrado)` + exit 1.
 *
 * `--json`: `scheduled_at` vem da entry `linkedin`/`um` de
 * `06-social-published.json` (o horário REAL que a página agendou — pode ter
 * sido shiftado pelo past-slot guard), `null` se não houver.
 *
 * Exit codes:
 *   0 — resolvido.
 *   1 — nada a mostrar: 03-social.md ausente, nem `## um` nem `## post_pixel`,
 *       `## um` presente mas plano do 4º post não-pronto (motivo no stderr), ou
 *       imagem inexistente (`--image`). stdout = `(nao encontrado)`, pro gate
 *       exibir no lembrete. `--edition-dir` ausente é o único exit 1 sem esse
 *       fallback (erro de uso puro).
 *   2 — (só legado) outros_count não resolvido; `{outros_count}` fica literal.
 *       Não bloqueia o Stage 6 (#2153), mas o caller deve avisar o editor.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPlatformSection, extractPostPixelBlock } from "./lib/social-lint-rules.ts";
import { extractSection, extractDestaqueBlock } from "./lib/extract-section.ts"; // #3991 — resolve a seção nova `# Social`; #9568 — `## um`
import { resolveOutrosCountFromEditionDir } from "./lib/outros-count.ts";
import { BEEHIIV_BASE_URL, appendUtmToEditionUrl } from "./lib/edition-url.ts"; // #4295 — appendUtmToEditionUrl
import { LINKEDIN_POST_PIXEL_UTM } from "./lib/shared/utm-registry.ts"; // #4295
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { stripMarkdownEmphasis } from "./lib/strip-markdown-emphasis.ts"; // #9568 — LinkedIn não renderiza markdown
import { applyUseMelhorUtmToText, planUseMelhorDispatch, type UseMelhorDispatchPlan } from "./lib/use-melhor-dispatch.ts"; // #9568
import { readSocialPublished } from "./lib/social-published-store.ts"; // #9568 — horário real do 4º post
import { USE_MELHOR_POST_ID } from "./lib/use-melhor-post.ts"; // #9568
import { useMelhorSlideFilename } from "./lib/use-melhor-carousel.ts"; // #9568

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Substitui `{edition_url}` e `{outros_count}` literais pelo valor resolvido.
 * `null` para qualquer um dos dois deixa o placeholder correspondente intacto
 * (backward-compat + fail-soft — nunca lança).
 * Exportada pra testes unitários.
 */
export function substitutePostPixelPlaceholders(
  text: string,
  editionUrl: string | null,
  outrosCount: number | null,
): string {
  let out = text;
  if (editionUrl !== null) out = out.replaceAll("{edition_url}", editionUrl);
  if (outrosCount !== null) out = out.replaceAll("{outros_count}", String(outrosCount));
  return out;
}

/**
 * Extrai o texto bruto (não resolvido) do `## post_pixel` de um `03-social.md`
 * completo. #3991: tenta a seção nova `# Social` antes de cair no fallback
 * legado `# LinkedIn` (edições publicadas antes deste merge). Retorna `null`
 * se nenhuma das duas existir, ou se o bloco post_pixel não existir (schema
 * pré-#1690 ou edição sem D1... não deveria acontecer, mas fail-soft de
 * qualquer forma). Exportada pra testes unitários.
 */
export function extractPostPixelText(socialMd: string): string | null {
  const section = extractSection(socialMd, "Social") ?? extractPlatformSection(socialMd, "linkedin");
  if (!section) return null;
  const block = extractPostPixelBlock(section);
  if (!block) return null;
  return block.text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

/**
 * #9568: texto do post PESSOAL do LinkedIn (vjpixel). Desde a #9568 o post
 * pessoal é o MESMO texto do 4º post (item USE MELHOR, `## um` de `# Social`)
 * que a página publica — o `## post_pixel` (standalone de D1, #1690) deixou de
 * ser gerado. Prefere `## um`; edição antiga sem `## um` cai no `## post_pixel`
 * legado (nunca quebra o parse de edição já publicada). O perfil pessoal segue
 * MANUAL: o Worker `linkedin-cron` recusa `webhook_target=pixel` + `action=post`
 * e a API direta tem um autor só (a página).
 */
export function extractPersonalPostText(
  socialMd: string,
): { source: "um" | "post_pixel"; text: string } | null {
  const social = extractSection(socialMd, "Social");
  const um = social ? extractDestaqueBlock(social, USE_MELHOR_POST_ID) : null;
  if (um && um.trim()) {
    return { source: "um", text: applyUseMelhorUtmToText(stripMarkdownEmphasis(um.trim())) };
  }
  const legacy = extractPostPixelText(socialMd);
  return legacy === null ? null : { source: "post_pixel", text: legacy };
}

/** #9568: imagem sugerida pro lembrete do post pessoal, conforme a fonte do texto. */
export function personalPostImageFile(source: "um" | "post_pixel"): string {
  return source === "um" ? useMelhorSlideFilename("cover") : "04-d1-1x1.jpg";
}

export type PersonalPostResolution =
  | { ok: true; source: "um" | "post_pixel"; text: string; image: string | null; scheduledAt: string | null }
  | { ok: false; reason: string };

/**
 * #9568: decide o post pessoal a partir do texto já extraído + plano do 4º
 * post. Pure (o caller injeta `fileExists` e o horário lido do store).
 * `## um` só sai com plano `ready`; o caminho legado não depende do plano.
 */
export function resolvePersonalPost(input: {
  personal: ReturnType<typeof extractPersonalPostText>;
  plan: UseMelhorDispatchPlan;
  fileExists: (name: string) => boolean;
  scheduledAt: string | null;
}): PersonalPostResolution {
  const { personal, plan } = input;
  if (!personal) return { ok: false, reason: "nem '## um' nem '## post_pixel' em '# Social'" };
  if (personal.source === "um" && plan.status !== "ready") {
    return { ok: false, reason: `4º post (USE MELHOR) não sai nesta edição — ${plan.reason}` };
  }
  const imageName = personalPostImageFile(personal.source);
  const imageOk =
    (personal.source === "post_pixel" || (plan.status === "ready" && plan.slots !== null)) &&
    input.fileExists(imageName);
  return {
    ok: true,
    source: personal.source,
    text: personal.text,
    image: imageOk ? imageName : null,
    scheduledAt: personal.source === "um" ? input.scheduledAt : null,
  };
}

/** Horário que a PÁGINA agendou pro 4º post (entry linkedin/um, `06-social-published.json`).
 * Exportada pra `publish-linkedin-personal.ts` (#9568 — mesmo horário no perfil pessoal). */
export function readUseMelhorScheduledAt(editionDir: string): string | null {
  for (const p of [resolve(editionDir, "_internal", "06-social-published.json"), resolve(editionDir, "06-social-published.json")]) {
    if (!existsSync(p)) continue;
    try {
      const entry = readSocialPublished(p).posts.find(
        (e) => e.platform === "linkedin" && e.destaque === USE_MELHOR_POST_ID && (e.status === "scheduled" || e.status === "draft"),
      );
      return entry?.scheduled_at ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

function main(): void {
  const { values } = parseArgs(process.argv.slice(2));
  const editionDirRaw = values["edition-dir"];
  if (!editionDirRaw) {
    console.error(
      "Erro: --edition-dir obrigatório.\n" +
        "Uso: npx tsx scripts/resolve-post-pixel.ts --edition-dir data/editions/260707 [--edition-url <url>]",
    );
    process.exit(1);
  }
  const editionDir = resolve(ROOT, editionDirRaw);

  // #3052 self-review: exit 1 abaixo ainda imprime '(nao encontrado)' em
  // stdout — mesma semântica do node -e original que este script substitui.
  // Sem isso, `POST_PIXEL_TEXT="$(...)"` capturaria string vazia em vez do
  // fallback literal que o gate do Stage 6 espera exibir (orchestrator-stage-6.md).
  const socialMdPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialMdPath)) {
    console.error(`Erro: 03-social.md não encontrado em ${editionDir}. Rode a Etapa 2 primeiro.`);
    console.log("(nao encontrado)");
    process.exit(1);
  }
  const socialMd = readFileSync(socialMdPath, "utf8");

  // #9568: post pessoal = `## um` (Use Melhor, só com plano ready) quando a
  // seção existe; `## post_pixel` só em edição antiga.
  const personal = extractPersonalPostText(socialMd);
  const wantsImage = process.argv.includes("--image");
  const wantsJson = process.argv.includes("--json");
  if (personal?.source === "um" || wantsImage || wantsJson) {
    let config: unknown = null;
    try {
      config = JSON.parse(readFileSync(values["config"] ? resolve(values["config"]) : resolve(ROOT, "platform.config.json"), "utf8"));
    } catch (e) {
      console.error(`#9568: platform.config.json ilegível — ${(e as Error).message}`);
    }
    const plan = personal?.source === "um"
      ? planUseMelhorDispatch(editionDir, config)
      : ({ status: "off", reason: "edição legada" } as const);
    const r = resolvePersonalPost({
      personal,
      plan,
      fileExists: (name) => existsSync(resolve(editionDir, name)),
      scheduledAt: readUseMelhorScheduledAt(editionDir),
    });
    if (!r.ok) {
      console.error(`#9568: post pessoal indisponível — ${r.reason}`);
      console.log(wantsJson ? JSON.stringify({ ok: false, reason: r.reason }) : "(nao encontrado)");
      process.exit(1);
    }
    if (wantsJson) {
      console.log(JSON.stringify({ ok: true, source: r.source, text: r.text, image: r.image, scheduled_at: r.scheduledAt }, null, 2));
      process.exit(0);
    }
    if (wantsImage) {
      if (!r.image) {
        console.error(`#9568: imagem do post pessoal inexistente/defasada (${personalPostImageFile(r.source)})`);
        console.log("(nao encontrado)");
        process.exit(1);
      }
      console.log(r.image);
      process.exit(0);
    }
    if (r.source === "um") {
      console.error("#9568: post pessoal = texto do 4º post (## um, Use Melhor) — mesmo texto da página.");
      console.log(r.text);
      process.exit(0);
    }
    // legado + nem --image nem --json: segue o caminho antigo abaixo (resolve placeholders).
  }

  const rawText = extractPostPixelText(socialMd);
  if (rawText === null) {
    console.error(
      `Erro: seção '## post_pixel' não encontrada em 03-social.md (${socialMdPath}). ` +
        "Schema pré-#1690 ou seção Social/LinkedIn ausente.",
    );
    console.log("(nao encontrado)");
    process.exit(1);
  }

  // edition_url: --edition-url flag > _internal/05-edition-url.txt > fallback
  // raiz (com warn) — mesma precedência de publish-linkedin.ts (#595).
  const editionUrlFlag = values["edition-url"] || undefined;
  let editionUrl: string;
  if (editionUrlFlag) {
    editionUrl = editionUrlFlag;
    console.error(`#3052: edition_url via flag → ${editionUrl}`);
  } else {
    const editionUrlFile = resolve(editionDir, "_internal", "05-edition-url.txt");
    if (existsSync(editionUrlFile)) {
      editionUrl = readFileSync(editionUrlFile, "utf8").trim();
      console.error(`#3052: edition_url via 05-edition-url.txt → ${editionUrl}`);
    } else {
      editionUrl = BEEHIIV_BASE_URL;
      console.warn(
        `#3052: edition_url não encontrado (sem --edition-url nem 05-edition-url.txt) — fallback ${editionUrl}. ` +
          "post_pixel vai apontar pra raiz da newsletter em vez do post específico.",
      );
    }
  }

  const outrosCountValue = resolveOutrosCountFromEditionDir(editionDir);
  let exitCode = 0;
  if (outrosCountValue === null) {
    console.error(
      "#3052: AVISO — outros_count não pôde ser resolvido (nenhum approved JSON legível em " +
        resolve(editionDir, "_internal") +
        "). '{outros_count}' permanece literal no texto abaixo — editor deve preencher " +
        "manualmente antes de postar (não bloqueia o gate, #2153).",
    );
    exitCode = 2;
  }

  // #4295: UTM per-channel (utm_source=linkedin, campaign=post-pixel) anexado
  // à URL ANTES de substituir no texto — post_pixel é 100% manual (Claude in
  // Chrome, nunca passa por publish-linkedin.ts), então esta resolução é o
  // ÚNICO ponto do código que alimenta o copy-paste do editor.
  //
  // Self-review (#4295): `editionUrl` vazio (arquivo `05-edition-url.txt`
  // existente mas vazio/só-whitespace) faria `new URL("")` lançar dentro de
  // `appendUtmToEditionUrl` sem try/catch ao redor, derrubando o script —
  // antes desta PR, uma editionUrl vazia era tolerada (virava uma substituição
  // vazia). Guard `if (editionUrl)` preserva esse comportamento tolerante,
  // mesmo padrão já usado em prep-twitter-posts.ts/publish-threads.ts.
  const taggedEditionUrl = editionUrl ? appendUtmToEditionUrl(editionUrl, LINKEDIN_POST_PIXEL_UTM) : editionUrl;
  const resolved = substitutePostPixelPlaceholders(rawText, taggedEditionUrl, outrosCountValue);
  console.log(resolved);

  process.exit(exitCode);
}

if (isMainModule(import.meta.url)) {
  main();
}
