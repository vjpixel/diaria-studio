---
name: diaria-3-social
description: Roda apenas o Stage 3 (social writers paralelos + Clarice). Requer `02-reviewed.md`. Uso — `/diaria-3-social AAMMDD [--no-gate]`.
---

# /diaria-3-social

Executa o Stage 3 da pipeline Diar.ia: 2 social writers em paralelo (`social-linkedin` + `social-facebook`) → merge → humanize → Clarice → gate humano.

Self-contained — você (top-level Claude Code) executa todo o playbook aqui, sem delegar a um orchestrator subagente. (Workaround #207: runtime bloqueia `Agent` dentro de subagentes.)

## Argumentos

- `$1` = data da edição (`AAMMDD`, ex: `260423`). **Se não passar, perguntar explicitamente** ao usuário antes de prosseguir — nunca inferir a partir de `today()`. Sugerir hoje/ontem como atalhos mas exigir confirmação:
  > "Você não passou a data da edição. Qual edição você quer processar? hoje ({AAMMDD_hoje}) / ontem ({AAMMDD_ontem}) / outra (informe AAMMDD)"
- `--no-gate` (opcional) = pular o gate humano final, auto-aprovar. Drive sync continua normal.

## Placeholders

Os blocos Bash/Agent abaixo contêm placeholders que **você (top-level) deve substituir pelo valor real antes de executar**. Bash não interpreta `$1` automaticamente fora de funções — paths como `data/editions/$1/` viram `data/editions//` se rodados literais.

- `$1` → AAMMDD literal recebido (ex: `260423`). Aparece em paths, prompts de Agent, e comandos Bash.
- `{YYMM}` → primeiros 4 chars de `$1` (ex: `$1=260423` → `2604`). Aparece no path do Drive e no gate output.

Substituir antes de invocar `Bash`, antes de passar `prompt` pra `Agent`, e antes de emitir o gate output ao usuário.

## Pré-requisitos

- `data/editions/$1/02-reviewed.md` deve existir (Stage 2 completo). Se não, parar e instruir: rode `/diaria-2-escrever $1` antes.

## Resume

Se `data/editions/$1/03-social.md` já existir:
- Sem `--no-gate`: perguntar `"03-social.md já existe — regenerar (sim/não)?"`. Se "não", pular direto pro gate de aprovação.
- Com `--no-gate`: assumir que está OK e pular pro fim sem regenerar.

## Passo 1 — Drive sync pull (input)

Antes de gerar o social, puxar a versão mais recente de `02-reviewed.md` do Drive (caso o editor tenha editado direto no celular):

```bash
npx tsx scripts/drive-sync.ts --mode pull --edition-dir data/editions/$1/ --stage 3 --files 02-reviewed.md
```

Falha de sync = warning, **nunca bloqueia**. Continuar com a versão local.

## Passo 2 — Dispatch paralelo dos social writers

Em **uma única mensagem com 2 chamadas Agent paralelas**, disparar:

```
Agent({
  subagent_type: "social-linkedin",
  description: "Stage 3 LinkedIn writer",
  prompt: "Gera 3 posts de LinkedIn (um por destaque) a partir de data/editions/$1/02-reviewed.md. Output: data/editions/$1/_internal/03-linkedin.tmp.md com seções `## d1`, `## d2`, `## d3`. Seguir context/templates/social-linkedin.md."
})

Agent({
  subagent_type: "social-facebook",
  description: "Stage 3 Facebook writer",
  prompt: "Gera 3 posts de Facebook (um por destaque) a partir de data/editions/$1/02-reviewed.md. Output: data/editions/$1/_internal/03-facebook.tmp.md com seções `## d1`, `## d2`, `## d3`. Seguir context/templates/social-facebook.md."
})
```

Aguardar ambos retornarem antes do passo seguinte.

## Passo 3 — Merge tmp files em 03-social.md

```bash
node -e "
  const fs=require('fs');
  const dir='data/editions/$1/';
  const li=fs.readFileSync(dir+'_internal/03-linkedin.tmp.md','utf8').trim();
  const fb=fs.readFileSync(dir+'_internal/03-facebook.tmp.md','utf8').trim();
  fs.writeFileSync(dir+'03-social.md','# LinkedIn\n\n'+li+'\n\n# Facebook\n\n'+fb+'\n');
  fs.unlinkSync(dir+'_internal/03-linkedin.tmp.md');
  fs.unlinkSync(dir+'_internal/03-facebook.tmp.md');
"
```

## Passo 4 — Humanize (#176)

Pass determinístico in-place (sem Agent, sem LLM):

```bash
npx tsx scripts/humanize.ts \
  --in data/editions/$1/03-social.md \
  --out data/editions/$1/03-social.md \
  2> data/editions/$1/_internal/03-humanize-report.json
```

`humanize.ts` preserva URLs (#163). Falha **não bloqueia** — fallback usa o arquivo original. Se `removals_count > 0` ou `substitutions_count > 0`, anotar pra incluir no resumo do gate.

## Passo 5 — Clarice (inline, sem Agent)

1. Ler `data/editions/$1/03-social.md`.
2. Chamar `mcp__clarice__correct_text` passando o texto completo.
3. A ferramenta retorna sugestões — **aplicar todas** ao texto.
4. Sobrescrever `03-social.md` com o texto corrigido (não a lista de sugestões).
5. **Verificar integridade dos cabeçalhos**: as seções `# LinkedIn`, `# Facebook`, `## d1`, `## d2`, `## d3` ainda devem existir. Clarice deve mexer só em texto corrido. Se algum cabeçalho sumiu/mudou, restaurar via `Edit` antes de continuar.
6. Se `mcp__clarice__correct_text` falhar, **propagar o erro** — não silenciar.

## Passo 6 — Drive sync push (output)

```bash
npx tsx scripts/drive-sync.ts --mode push --edition-dir data/editions/$1/ --stage 3 --files 03-social.md,_internal/03-humanize-report.json
```

Anotar warnings (se houver) pra mencionar no gate. Falha não bloqueia.

## Passo 7 — Gate humano

**Se `--no-gate`:** pular este passo. Emitir `[AUTO] Stage 3 auto-approved` e finalizar.

**Caso contrário:** apresentar ao usuário:

```
Stage 3 — Social pronto.

📁 Arquivo: data/editions/$1/03-social.md
📁 Drive: Work/Startups/diar.ia/edicoes/{YYMM}/$1/03-social.md

[Resumo do humanize: X remoções, Y substituições, Z flags] (se houve mudanças)
[⚠️ Drive sync: N warning(s)] (se houve)

Posts:
- LinkedIn d1 / d2 / d3
- Facebook d1 / d2 / d3

Aprovar (sim) / pedir retry / editar manualmente?
```

Aguardar resposta. Se "sim", finalizar com sucesso. Se "retry", re-rodar Passo 2 em diante. Se "editar", instruir o usuário a editar o arquivo e retornar `sim`.

## Outputs

- `data/editions/$1/03-social.md` — final, com seções `# LinkedIn`/`# Facebook`, cada uma com `## d1`/`## d2`/`## d3`
- `data/editions/$1/_internal/03-humanize-report.json` — relatório do humanize

## Notas

- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
- Tab isolation não se aplica aqui (social writers não usam Chrome — só geram texto).
- Se o orchestrator subagent ainda existir em `.claude/agents/orchestrator.md`, ignorar — este skill não delega.
