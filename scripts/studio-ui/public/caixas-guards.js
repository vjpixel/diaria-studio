// caixas-guards.js (#3924) — lógica PURA do guard de conflito de save da
// seção "Caixas" (`caixas.html`/`caixas.js`). Mesmo padrão de
// revisao-guards.js (#3668/#3729): nenhuma exportação toca `document`/`fetch`
// — testável com fixtures puras, sem harness de DOM (#633).
//
// Mesmo mecanismo de mtime de studio-review.ts (#3729): o server responde
// 409 quando o mtime em disco diverge do `expectedModifiedAt` que o client
// viu no último GET — aqui o cenário típico é 2 abas/sessões do Studio
// editando a MESMA caixa (nenhum stage de pipeline escreve em
// `context/snippets/` automaticamente, ao contrário de `02-reviewed.md`).

/** Mensagem do `confirm()` disparado por `saveCurrentBox()` quando o server
 * responde 409 — nunca "Tem certeza?" genérico (R6 de
 * docs/studio-ui-ux-guidelines.md): descreve o risco real e as duas saídas
 * (sobrescrever com force, ou recarregar do disco). */
export const BOX_SAVE_CONFLICT_CONFIRM_MESSAGE =
  "Esta caixa foi modificada desde que você abriu o editor — provavelmente salva por outra aba/sessão do " +
  "Studio. Clique OK para SOBRESCREVER com a sua versão mesmo assim, ou Cancelar para RECARREGAR a versão " +
  "mais recente do disco (suas edições não salvas aqui serão perdidas).";

// ── #3928: arquivar (não deletar) + criar caixa nova ──────────────────────

/** Regex do slug de caixa — ESPELHA `BOX_SLUG_RE` de `studio-boxes.ts`
 * (`^[a-z0-9-]+\.md$`). Mantido em sincronia manualmente (o server é sempre a
 * autoridade final; esta cópia só dá feedback imediato na criação). */
export const BOX_SLUG_RE = /^[a-z0-9-]+\.md$/;

/** Mensagem do `confirm()` antes de ARQUIVAR — arquivar não deleta (o conteúdo
 * vai pra `context/snippets/_arquivo/` e pode ser restaurado), então o texto
 * deixa isso explícito (R6 de docs/studio-ui-ux-guidelines.md: nunca "Tem
 * certeza?" genérico). */
export function boxArchiveConfirmMessage(slug) {
  return (
    `Arquivar a caixa "${slug}"? Ela some da lista mas o conteúdo NÃO é deletado — ` +
    `vai para context/snippets/_arquivo/ e pode ser restaurada depois na seção "Arquivadas".`
  );
}

/** Valida (e normaliza) o slug digitado no formulário de "Nova caixa", PURO —
 * sem `document`/`fetch`, testável (#633). Normaliza: trim, e se não terminar
 * em `.md`, anexa `.md` (nicety comum). Retorna `{ ok, slug, error }`. O server
 * revalida via `isValidBoxSlug` (autoridade final); isto é só feedback local. */
export function validateNewBoxSlug(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { ok: false, slug: "", error: "Informe um nome de arquivo." };
  const slug = /\.md$/.test(trimmed) ? trimmed : `${trimmed}.md`;
  if (slug === "README.md") {
    return { ok: false, slug, error: "README.md é reservado (documentação do formato), não é uma caixa." };
  }
  if (!BOX_SLUG_RE.test(slug)) {
    return {
      ok: false,
      slug,
      error: "Use só minúsculas, dígitos e hífen (ex: minha-caixa). Sem espaços, acentos ou maiúsculas.",
    };
  }
  return { ok: true, slug, error: null };
}

// ── #3937: gestão de slots de divulgação ──────────────────────────────────

/** Posição de cada slot no layout (`stitch-newsletter.ts`) — texto fixo,
 * mostrado ao lado do seletor de cada slot na UI. */
export const SLOT_POSITION_LABEL = {
  slot1: "entre D1 e D2",
  slot2: "entre D2 e D3 (só materializa em edição de 3 destaques)",
  slot3: "depois do último destaque (D3, ou D2 se só houver 2)",
};

/** Mensagem do `confirm()` disparado por `saveSlots()` quando o server
 * responde 409 — mesmo texto/motivo do guard de conflito de save de 1 caixa
 * (`BOX_SAVE_CONFLICT_CONFIRM_MESSAGE`), mas nomeando o arquivo real que está
 * em jogo aqui: `platform.config.json` é o mais sensível desta tela (afeta
 * TODA edição), então o aviso é explícito sobre isso (R6 de
 * docs/studio-ui-ux-guidelines.md). */
export const SLOTS_SAVE_CONFLICT_CONFIRM_MESSAGE =
  "platform.config.json foi modificado desde que você abriu esta tela — provavelmente por outra aba/sessão do " +
  "Studio, ou uma edição manual do arquivo. Clique OK para SOBRESCREVER com a sua atribuição de slots mesmo " +
  "assim, ou Cancelar para RECARREGAR o estado mais recente do disco (suas mudanças não salvas aqui serão perdidas).";

/** Acha a primeira caixa atribuída a mais de um slot ao mesmo tempo (guard 2
 * do #3937), PURO — sem `document`/`fetch`, testável (#633). Ignora slots
 * vazios (`""`) — só compara slugs preenchidos entre si. Espelha
 * (client-side, feedback imediato) o mesmo guard que `saveBoxSlots`
 * (server, autoridade final) aplica antes de escrever. Retorna o slug
 * duplicado, ou `null` se não há conflito. */
export function findDuplicateSlotAssignment(slots) {
  const filled = [slots.slot1, slots.slot2, slots.slot3]
    .map((v) => String(v ?? "").trim())
    .filter((v) => v !== "");
  return filled.find((v, i) => filled.indexOf(v) !== i) ?? null;
}
