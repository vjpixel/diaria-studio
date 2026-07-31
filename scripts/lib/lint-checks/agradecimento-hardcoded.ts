/**
 * lint-checks/agradecimento-hardcoded.ts (#4359)
 *
 * `context/snippets/agradecimento-apoiadores.md` deveria voltar ao
 * placeholder `{apoiadores}` assim que o nome do apoiador daquela edição
 * for consumido — o box de agradecimento é pensado pra aparecer numa ÚNICA
 * edição (a que efetivamente credita o apoiador novo), não persistir. Caso
 * real (#4359): o nome "Mônica Herculano" ficou hardcoded no arquivo por
 * pelo menos 2 edições consecutivas (260729→260730→260731) sem o editor
 * perceber — cada edição subsequente repetiu o mesmo agradecimento como se
 * fosse novo, sem nenhum sinal de alerta.
 *
 * Este guard é um LEMBRETE, não um detector de recorrência histórica — pure
 * e stateless (sem acesso a `data/editions/` passadas, sem saber quantas
 * edições atrás o nome foi injetado pela 1ª vez): dado o conteúdo ATUAL do
 * snippet (pós-strip do comentário HTML de header, mesma convenção de
 * `loadAgradecimentoSnippet`/`isAgradecimentoSnippetUsed`), reporta se o
 * placeholder `{apoiadores}` foi substituído por um nome real.
 *
 * `ok: false` NÃO significa erro de sintaxe — só "hoje este snippet vai
 * injetar um nome real no `02-reviewed.md`; se esse nome já foi creditado
 * numa edição anterior, resete o arquivo pro placeholder antes de rodar o
 * Stage 2 de novo". WARN-ONLY (mesmo espírito do #4076/snippet-staleness):
 * a decisão de resetar ou manter (ex: o apoiador é novo NESTA edição) cabe
 * ao editor — o guard só existe pra não deixar isso passar em silêncio por
 * múltiplas edições, como aconteceu no #4359.
 */

const PLACEHOLDER = "{apoiadores}";

export interface AgradecimentoHardcodedResult {
  /** `true` = arquivo vazio ou ainda no placeholder (nada a avisar). */
  ok: boolean;
  /** Melhor esforço pra extrair o nome hardcoded, usado na mensagem do
   * warning. `null` quando o conteúdo não bate no padrão esperado (ainda
   * assim `ok: false` — o placeholder está ausente, então é hardcoded). */
  name: string | null;
}

/** Strip do comentário HTML de header — mesma convenção de todos os snippets
 * (ver `readSnippetFile`/`readSnippetRaw` em snippet-loader.ts/snippet-staleness.ts). */
function stripHeaderComment(raw: string): string {
  return raw.replace(/<!--[\s\S]*?-->/g, "").trim();
}

/**
 * Pure — avalia o CONTEÚDO já lido do snippet (sem tocar filesystem). Mesmo
 * critério de "usado" que `isAgradecimentoSnippetUsed`
 * (lint-checks/snippet-staleness.ts) e `loadAgradecimentoSnippet`
 * (stitch-newsletter.ts): ausência do placeholder = nome real presente.
 */
export function checkAgradecimentoHardcoded(raw: string): AgradecimentoHardcodedResult {
  const body = stripHeaderComment(raw);
  if (!body) return { ok: true, name: null }; // vazio — nada a avisar (graceful, mesma postura de loadAgradecimentoSnippet)
  if (body.includes(PLACEHOLDER)) return { ok: true, name: null };
  // Melhor esforço pra extrair o nome hardcoded pra mensagem do warning —
  // convenção observada no conteúdo real: "...ao(s) novo(s) apoiador(es):
  // **Nome**." (negrito em volta do nome). Sem esse padrão, ainda reporta
  // `ok: false` (o placeholder está ausente de qualquer forma), só sem nome
  // extraído — nunca falha silenciosamente por não reconhecer a redação.
  const m =
    body.match(/apoiador(?:a)?(?:s)?:?\s*\*\*([^*]+)\*\*/i) ??
    body.match(/\*\*([^*]+)\*\*/);
  return { ok: false, name: m ? m[1].trim() : null };
}
