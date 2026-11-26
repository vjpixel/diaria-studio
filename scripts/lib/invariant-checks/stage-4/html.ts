/**
 * Invariantes do Stage 4 — HTML renderizado (warnings, tamanho, fixtures do Kit, atraso em relação ao reviewed) (#14057).
 *
 * Família extraída de `../stage-4.ts` (divisão sem mudança de lógica). O
 * registro `STAGE_4_RULES` e o reexport público continuam em `../stage-4.ts`:
 * importe sempre de lá.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { InvariantViolation } from "../types.ts";
import {
  evaluateNewsletterHtmlFreshnessOnDisk,
  NEWSLETTER_FINAL_HTML,
  type NewsletterHtmlFreshness,
} from "../../newsletter-html-freshness.ts"; // #10258
import { ROOT } from "./_shared.ts";

/**
 * #4673: `render-newsletter-html.ts` (via `renderHTML`/`getRenderWarnings`,
 * scripts/lib/newsletter-render-html.ts) emite eventos estruturados quando
 * conteúdo editorial/comercial some silenciosamente do render — caixa de
 * divulgação sem lacuna livre (`divulgacao_box_dropped_no_gap`, #4624),
 * bloco WhatsApp sem D1 (`whatsapp_share_no_d1`), divergência entre os dois
 * sinais que decidem "isto é D1" (`whatsapp_share_d1_mismatch`, desde #5152,
 * nunca deveria disparar, guard defensivo), e — desde #5794/#5817 — o
 * snippet `data/snippets/convite-amigo-whatsapp.md` ausente
 * (`convite_amigo_snippet_missing`, bloco "sempre presente" que sumiria de
 * TODA edição em silêncio sem este sinal). #5999 acrescenta
 * `convite_amigo_orphan_no_encerrar`: a caixa migrou pro TOPO de "Para
 * encerrar", então uma edição sem essa seção não tem onde embuti-la — cai no
 * fallback standalone (posição pré-#5999) em vez de sumir.
 * Antes deste check, ficavam só no `console.error` de qualquer terminal que
 * por acaso estava rodando o render — nunca chegavam no resumo consolidado
 * do gate que o editor de fato revisa antes de publicar. O CLI (§4b step 2
 * do orchestrator) grava esses eventos em `_internal/render-warnings.json` a
 * cada chamada (sempre — mesmo array vazio, pra nunca deixar warning STALE
 * de uma rodada anterior sobreviver). Warning-only, nunca bloqueia (mesmo
 * padrão de `image-crop-warn`/`card-4x5-upload-missing` acima) — a decisão
 * de como corrigir (reduzir caixas configuradas, promover/demover destaque)
 * é editorial, não mecânica.
 *
 * Se o arquivo não existe (edição pré-#4673, ou render ainda não rodou nesta
 * retomada), não é violação — o arquivo é escrito pelo pré-render, que roda
 * ANTES deste invariant no fluxo do Stage 4 (§4b step 2 → §4b step 5).
 */
export function checkRenderWarnings(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "render-warnings.json");
  if (!existsSync(path)) return [];
  let data: { warnings?: Array<{ event?: string; edition?: string; slot?: number }> };
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  const violations: InvariantViolation[] = [];
  for (const w of warnings) {
    if (w.event === "divulgacao_box_dropped_no_gap") {
      violations.push({
        rule: "divulgacao-box-dropped-no-gap",
        message:
          `Caixa de divulgação do slot ${w.slot ?? "?"} (platform.config.json → ` +
          `boxes_divulgacao) não coube em nenhuma lacuna livre desta edição — conteúdo ` +
          `COMERCIAL configurado não sairá publicado. Fix: reduzir o número de caixas ` +
          `configuradas para o número de lacunas disponíveis (D1/D2, D2/D3 + região ` +
          `pós-último-destaque), ou ajustar quais slots estão engajados.`,
        source_issue: "#4673",
        severity: "warning",
        file: path,
      });
    } else if (w.event === "whatsapp_share_no_d1") {
      violations.push({
        rule: "whatsapp-share-no-d1",
        message:
          `Bloco "Compartilhe no WhatsApp" não foi renderizado — a edição não tem D1 ` +
          `(nunca deveria acontecer dado o invariante de 2-3 destaques, mas o bloco ` +
          `depende de D1 pra existir). Fix: confirmar que 02-reviewed.md tem ao menos 1 ` +
          `destaque antes de publicar.`,
        source_issue: "#4673",
        severity: "warning",
        file: path,
      });
    } else if (w.event === "whatsapp_share_d1_mismatch") {
      violations.push({
        rule: "whatsapp-share-d1-mismatch",
        message:
          `Bloco "Compartilhe no WhatsApp" pode ter sumido do e-mail publicado — o ` +
          `render detectou que o 1º destaque no array (posição usada pra decidir ONDE ` +
          `injetar o bloco) não tem \`n === 1\` (usado pra decidir SE injeta). Os dois ` +
          `sinais deveriam sempre concordar; divergiram, e o bloco não foi incluído no ` +
          `D1. Fix: investigar por que o array de destaques não está na ordem 1, 2, 3 — ` +
          `provável bug no parsing/extração de 02-reviewed.md, não algo pra corrigir manualmente na edição.`,
        source_issue: "#5152",
        severity: "warning",
        file: path,
      });
    } else if (w.event === "convite_amigo_snippet_missing") {
      violations.push({
        rule: "convite-amigo-snippet-missing",
        message:
          `Bloco "Convide um amigo" não foi renderizado — data/snippets/convite-amigo-whatsapp.md ` +
          `ausente ou vazio (edição pós-#5794/#5817, deveria estar sempre presente). Fix: confirmar ` +
          `que o arquivo existe (não foi apagado/renomeado por engano no painel Caixas do Studio) ` +
          `antes de publicar.`,
        source_issue: "#5817",
        severity: "warning",
        file: path,
      });
    } else if (w.event === "convite_amigo_orphan_no_encerrar") {
      violations.push({
        rule: "convite-amigo-orphan-no-encerrar",
        message:
          `Bloco "Convide um amigo" renderizou no formato STANDALONE (posição pré-#5999) em vez ` +
          `de dentro de "Para encerrar" — esta edição não tem bloco "Para encerrar" ` +
          `(02-reviewed.md sem essa seção), então a caixa não tem onde entrar no topo dela ` +
          `(#5999). Fix: confirmar se a ausência de "Para encerrar" é intencional; se não for, ` +
          `adicionar a seção ao 02-reviewed.md.`,
        source_issue: "#5999",
        severity: "warning",
        file: path,
      });
    }
  }
  return violations;
}

/**
 * #5232: `_internal/newsletter-final.html` (o fragmento que vai pro corpo do
 * e-mail — não o post inteiro do Beehiiv, que soma template + CSS por cima)
 * ficou numa faixa estável de ~38-42KB por ~3 semanas (260722-260812) e deu
 * um salto pra 44.384 bytes (260813) e 47.607 bytes (260814) — perto o
 * bastante do limite de clipping do Gmail (~102KB no e-mail INTEIRO, não só
 * neste fragmento) pro Beehiiv já ter emitido o warning "Your post is large
 * and may get clipped by Gmail" no Stage 6 ao agendar a edição 260814.
 *
 * Antes deste check, o único sinal desse crescimento era esse warning manual
 * do Beehiiv — visto tarde (Stage 6, minutos antes do envio) e fácil de
 * ignorar como "não bloqueia mesmo". Este invariant roda no Stage 4 (o
 * fragmento já existe nesse ponto — pré-render já rodou antes dos invariants
 * do gate) e sinaliza ANTES do editor aprovar a revisão, com folga pra
 * investigar/cortar conteúdo se for o caso.
 *
 * `NEWSLETTER_HTML_SIZE_WARN_BYTES` (45.000 bytes) foi escolhido acima da
 * faixa histórica estável (~38-42KB) e abaixo do salto observado (44.384 /
 * 47.607) — pega o regression real sem alarmar a faixa normal. Ajustável
 * livremente; não é um limite físico, só o ponto onde vale a pena o editor
 * olhar.
 *
 * Warning, não error (mesmo padrão de `card-4x5-upload-missing`/
 * `image-crop-warn` acima) — decidir SE/O QUE cortar é editorial (#5232 item
 * 4, fora de escopo deste check), não algo que este invariant deva forçar.
 *
 * Arquivo ausente (pré-render ainda não rodou nesta retomada, ou edição
 * legada pré-#1694) → `[]`, nada a checar — mesmo padrão de
 * `checkRenderWarnings` acima.
 */
export const NEWSLETTER_HTML_SIZE_WARN_BYTES = 45_000;

export function checkNewsletterHtmlSize(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "newsletter-final.html");
  if (!existsSync(path)) return [];
  const bytes = statSync(path).size;
  if (bytes <= NEWSLETTER_HTML_SIZE_WARN_BYTES) return [];
  const kb = (bytes / 1024).toFixed(1);
  const thresholdKb = (NEWSLETTER_HTML_SIZE_WARN_BYTES / 1024).toFixed(1);
  return [
    {
      rule: "newsletter-html-size",
      message:
        `_internal/newsletter-final.html tem ${bytes} bytes (${kb} KB), acima do ` +
        `threshold de ${NEWSLETTER_HTML_SIZE_WARN_BYTES} bytes (${thresholdKb} KB). ` +
        `A faixa histórica estável (260722-260812) era ~38-42KB — acima disso é sinal ` +
        `de crescimento real do conteúdo, não ruído. Perto o bastante do limite de ` +
        `clipping do Gmail (~102KB no e-mail inteiro) pro Beehiiv já ter avisado no ` +
        `Stage 6 em edições anteriores (#5232). Investigar a origem do crescimento ` +
        `(boxes de divulgação extra, conteúdo editorial mais longo) antes de aprovar — ` +
        `cortar conteúdo é decisão editorial, este check só avisa.`,
      source_issue: "#5232",
      severity: "warning",
      file: path,
    },
  ];
}

/**
 * #6506 — o e-mail renderizado pelo Kit passa de 102 KB (limite de clipping
 * do Gmail: acima disso o Gmail corta a mensagem e mostra "[Mensagem
 * cortada]"). O pixel de abertura do Kit fica no FIM do corpo (abaixo do
 * corte), então uma edição que estoure 102 KB tem abertura Gmail
 * SUBCONTADA — o número vira um piso, não a taxa real, e essa taxa alimenta
 * a decisão de rampa (#6505).
 *
 * O Kit é o canal real de envio (#11225), então `severity: error` bloqueia o
 * gate: a consequência (abertura subcontada) só apareceria semanas depois numa
 * análise de rampa.
 */
export const KIT_HTML_SIZE_ERROR_BYTES = 102 * 1024;

export function checkKitHtmlSize(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "_internal", "newsletter-final-kit.html");
  if (!existsSync(path)) return [];
  const bytes = statSync(path).size;
  if (bytes <= KIT_HTML_SIZE_ERROR_BYTES) return [];
  const kb = (bytes / 1024).toFixed(1);
  return [
    {
      rule: "kit-html-too-large",
      message:
        `_internal/newsletter-final-kit.html tem ${bytes} bytes (${kb} KB), acima do ` +
        `limite de clipping do Gmail (102 KB, #6506). O pixel de abertura do Kit fica ` +
        `no FIM do corpo — abaixo do corte — então a abertura Gmail desta edição sairia ` +
        `SUBCONTADA, e essa taxa alimenta a decisão de rampa ` +
        `(#6505). Cortar conteúdo (boxes de divulgação, texto de destaque) é decisão ` +
        `editorial. Este check BLOQUEIA o gate até isso acontecer.`,
      source_issue: "#6506",
      severity: "error",
      file: path,
    },
  ];
}

/**
 * #6336: audita a base Kit de produção por assinante ATIVO cujo e-mail bate
 * padrão de fixture de teste (`ana@example.com` e vizinhos — ver docstring
 * de `scripts/lib/kit-fixture-patterns.ts`). Achado ao vivo 26/08/2026: uma
 * verificação manual de funil (poll/cursos/reativar) deixou 13 resíduos
 * desse tipo, 2 deles `active` — receberiam a próxima edição pelo Kit, e
 * `example.com` é domínio reservado (RFC 2606): hard bounce garantido.
 *
 * O trabalho de rede (paginar `/v4/subscribers`, comparar padrões) mora em
 * `scripts/audit-kit-fixtures.ts` — este check só invoca esse script via
 * `spawnSync` (mesmo padrão de `runCheck` em `stage-2.ts`, necessário porque
 * `InvariantRule.run` é síncrono e a chamada à API do Kit é assíncrona) e
 * traduz o exit code em violation:
 *
 *   - `0` → limpo, `[]`.
 *   - `1` → fixture(s) ATIVO(s) na base real — `error` (gate-blocking:
 *     publicar sem agir manda a próxima edição pro fixture, hard bounce
 *     certo).
 *   - `2` (`KIT_API_KEY` ausente, ou API do Kit indisponível) → `warning`,
 *     não `error`. O Kit é o backend principal de newsletter desde o
 *     #11225, mas exigir a credencial aqui bloquearia o Stage 4 em
 *     qualquer ambiente sem Kit configurado (CI, clone fresco, sessão
 *     cloud) por causa de uma auditoria auxiliar, que não é o envio. Mesma
 *     disciplina fail-soft de integração opcional já usada no repo (ex:
 *     `data/` ausente em `studio-boxes.ts`).
 *   - qualquer outro exit code (script crashou) → `error`, mesma severidade
 *     de "achei o problema" — um crash inesperado não deveria degradar pra
 *     silêncio.
 *
 * `env` é explícito no `spawnSync` (mesmo padrão de `checkGeminiModelValid`
 * em `stage-0.ts`) e injetável — default `process.env` em produção. Existe
 * pra permitir que o teste (`test/stage-4-kit-fixture-audit-invariant.test.ts`)
 * force o cenário "sem KIT_API_KEY" de forma hermética: apagar a var só do
 * `process.env` do processo PAI não bastava (achado #6387) porque
 * `audit-kit-fixtures.ts` chama `loadProjectEnv()`, que recarrega `.env` do
 * disco e populava a var de novo no filho a partir da máquina real — o teste
 * ficava fazendo fetch de verdade contra a base Kit de produção sempre que
 * `KIT_API_KEY` estivesse setada no `.env` local. A correção passa um objeto
 * `env` explícito com `KIT_API_KEY: ""` (presente, vazio) — `dotenv`
 * (`override:false`, `hasOwnProperty`) só preenche uma var AUSENTE do
 * target; uma var presente mas vazia não é sobrescrita, então
 * `resolveKitConfig` a trata como ausente (string vazia é falsy) sem o
 * subprocesso jamais reidratar a credencial real.
 */
export function checkKitFixtureAudit(
  _editionDir: string,
  env: NodeJS.ProcessEnv = process.env,
): InvariantViolation[] {
  const scriptPath = resolve(ROOT, "scripts", "audit-kit-fixtures.ts");
  const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], { encoding: "utf8", env });
  const stdout = (result.stdout || "").trim();
  const stderr = (result.stderr || "").trim();

  if (result.status === 0) return [];

  if (result.status === 2) {
    return [
      {
        rule: "kit-fixture-audit-unavailable",
        message:
          `audit-kit-fixtures.ts não pôde rodar (KIT_API_KEY ausente ou API do Kit ` +
          `indisponível): ${(stderr || stdout).slice(0, 400)}. Verificação de fixture ` +
          `ativo na base Kit pulada nesta edição — reconfigurar a credencial e rodar ` +
          `manualmente (npx tsx scripts/audit-kit-fixtures.ts) quando possível.`,
        source_issue: "#6336",
        severity: "warning",
        file: scriptPath,
      },
    ];
  }

  return [
    {
      rule: "kit-fixture-audit",
      message:
        `Assinante(s) de fixture de teste ATIVO(s) na base Kit de PRODUÇÃO — ` +
        `receberia(m) a próxima edição real (domínios como example.com são reservados ` +
        `RFC 2606, hard bounce garantido). ${(stdout || stderr).slice(0, 800)} ` +
        `Fix: cancelar o(s) assinante(s) via API/dashboard Kit antes de publicar. ` +
        `Prevenção: verificação ao vivo de funil (poll/cursos/reativar) usa sempre ` +
        `vjpixel+probe-{issue}-{data}@gmail.com, nunca um fixture de test/*.test.ts — ` +
        `e cancelar o probe ao fim da verificação é parte do rollout, não um passo ` +
        `opcional (ver docstring de scripts/audit-kit-fixtures.ts, #6336).`,
      source_issue: "#6336",
      severity: "error",
      file: scriptPath,
    },
  ];
}

/**
 * #10245 — `_internal/newsletter-final.html` não pode ficar atrás de
 * `02-reviewed.md`. O replant do erro intencional (e qualquer edição do gate 4)
 * regrava o reviewed sem re-renderizar o HTML; Stage 5 publicava a página do
 * site e o broadcast Kit com insumos defasados. HTML ausente não acusa (o
 * pré-render é outra regra).
 *
 * #10258 — `error` (era warning): `pipeline-sentinel.ts write --step 4` recusa.
 * Pra não bloquear por toque sem mudança de conteúdo, mtime defasado só vira
 * violação quando o carimbo de proveniência do render
 * (`_internal/newsletter-render-source.json`) não registra o sha256 atual do
 * reviewed — critério completo em `scripts/lib/newsletter-html-freshness.ts`.
 * `evaluate`: override pra teste.
 */
export function checkNewsletterHtmlNotBehindReviewed(
  editionDir: string,
  evaluate: (editionDir: string) => NewsletterHtmlFreshness = evaluateNewsletterHtmlFreshnessOnDisk,
): InvariantViolation[] {
  const result = evaluate(editionDir);
  if (!result.stale) return [];
  const why =
    result.reason === "stamp-mismatch"
      ? "o conteúdo de 02-reviewed.md mudou desde o último render"
      : result.reason === "stamp-newer-than-html"
        ? "o render mais recente não chegou ao newsletter-final.html (substitute-image-urls.ts não rodou depois)"
        : "sem carimbo de render pra provar que o conteúdo é o mesmo";
  return [
    {
      rule: "newsletter-html-not-behind-reviewed",
      message:
        // #10268: stamp-mismatch também dispara com o HTML mais novo (lag 0).
        `${NEWSLETTER_FINAL_HTML} não reflete 02-reviewed.md` +
        (result.lagMinutes > 0 ? ` (HTML anterior em ${result.lagMinutes} min)` : "") +
        ` — ${why}; ` +
        `a página do site e o broadcast sairiam com o texto antigo. Re-renderizar: render-newsletter-html.ts + ` +
        `substitute-image-urls.ts + render-kit-html-preview.ts antes do sentinel.`,
      source_issue: "#10245",
      severity: "error", // #10258
      file: resolve(editionDir, NEWSLETTER_FINAL_HTML),
    },
  ];
}
