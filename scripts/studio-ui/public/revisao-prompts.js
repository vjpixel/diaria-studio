// revisao-prompts.js (#3629) — lógica PURA de montagem dos prompts dos
// ganchos "Reescrever título" e "Regenerar imagem" do painel de revisão
// (`revisao.html`/`revisao.js`). Separado de propósito de `revisao.js`
// (mesmo padrão de `chat-hydration.js` vs. `chat-drawer.js`): nenhuma das
// duas funções abaixo toca `document`/`fetch` — só concatenam string a
// partir de `{aammdd, destaque, instrucao}` — então são testáveis com
// fixtures puras, sem DOM real (#633).
//
// Os cards NÃO chamam script/API diretamente (decisão do #3629, herdada do
// stub original em #3559): o botão só PRÉ-PREENCHE o textarea do chat
// drawer (`window.diariaStudioChat.prefillMessage`, ver chat-drawer.js) — o
// editor revisa/ajusta o prompt e manda quando quiser, na mesma sessão real
// (Claude Agent SDK) que já tem acesso de Edit/Bash (mesmas skills/MCPs do
// terminal, #3556).

/** Normaliza `destaque` pro rótulo usado nos prompts ("D1"/"D2"/"D3") — não
 * lança pra entrada fora do esperado, só ecoa em upper-case (fail-open: o
 * editor revisa o texto antes de mandar, então um rótulo estranho não é
 * destrutivo, só feio). */
function destaqueLabel(destaque) {
  return typeof destaque === "string" && destaque.trim() ? destaque.trim().toUpperCase() : "D1";
}

/** Monta o prompt do gancho "Reescrever título" — referencia a edição
 * (AAMMDD) + o destaque escolhido (D1/D2/D3) em `02-reviewed.md`, pede 2-3
 * opções de título alternativas ANTES de aplicar qualquer mudança, e injeta
 * a instrução livre do editor quando preenchida. */
export function buildRewriteTitlePrompt({ aammdd, destaque, instrucao }) {
  const label = destaqueLabel(destaque);
  const lines = [
    `Reescreva o título do ${label} da edição ${aammdd} (02-reviewed.md).`,
  ];
  const trimmedInstrucao = typeof instrucao === "string" ? instrucao.trim() : "";
  if (trimmedInstrucao) {
    lines.push(`Instrução do editor: ${trimmedInstrucao}`);
  }
  lines.push(
    "Mostre 2-3 opções de título alternativas (respeitando o limite de 52 caracteres) antes de aplicar qualquer uma — só edite o arquivo depois que eu escolher.",
  );
  return lines.join("\n");
}

/** Monta o prompt do gancho "Regenerar imagem" — referencia a edição +
 * destaque, cita o comando determinístico esperado
 * (`scripts/image-generate.ts --destaque {dN} --ratio 2x1 [--force]`) e pede
 * pra rodar (ajustando o prompt de imagem antes se a instrução livre do
 * editor pedir algo específico), confirmando o resultado ao final. */
export function buildRegenerateImagePrompt({ aammdd, destaque, instrucao }) {
  const slug = typeof destaque === "string" && destaque.trim() ? destaque.trim().toLowerCase() : "d1";
  const label = destaqueLabel(destaque);
  const lines = [
    `Regenere a imagem do ${label} da edição ${aammdd}.`,
  ];
  const trimmedInstrucao = typeof instrucao === "string" ? instrucao.trim() : "";
  if (trimmedInstrucao) {
    lines.push(`Instrução do editor: ${trimmedInstrucao}`);
    lines.push("Se a instrução pedir algo específico no visual, ajuste o prompt de imagem (editorial) antes de rodar o script.");
  }
  lines.push(
    `Rode \`npx tsx scripts/image-generate.ts --editorial <prompt.md> --out-dir data/editions/${aammdd}/ --destaque ${slug} --ratio 2x1 --force\` (ajustando o path do prompt editorial conforme necessário) e confirme o resultado ao final.`,
  );
  return lines.join("\n");
}
