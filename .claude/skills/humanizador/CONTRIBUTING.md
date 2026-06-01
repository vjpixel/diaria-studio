# Contribuindo

Convenções de manutenção do `humanizador`. Vale para qualquer editor (Claude Code, OpenCode, Warp etc.) e para contribuidores humanos.

## Fluxo de PR

- Branch dedicada → commit → push → PR pronta para review (não draft).
- Não commitar direto em `main` ou na branch default.
- Vale para qualquer mudança: feature, fix, doc, ajuste de CI.

## Versionamento

`SKILL.md` tem `version:` no frontmatter YAML; `README.md` tem uma seção "Histórico de versões". Os dois ficam sincronizados — o script `scripts/validate_skill.py` (rodado pelo CI) verifica a consistência.

Bump:

- **Patch** (`1.x.y → 1.x.y+1`): correção pontual sem mudança de capacidade.
- **Minor** (`1.x.0 → 1.x+1.0`): refino significativo de padrão existente, ou padrão novo.
- **Major** (`1.x.y → 2.0.0`): mudança estrutural que quebra interpretação de versões anteriores.

## Editando `SKILL.md`

- Preserve a formatação e indentação do YAML do frontmatter.
- Mantenha a numeração dos padrões estável; renumerar é invasivo (README e exemplos referenciam pela mesma numeração).
- Atualize o "Histórico de versões" do README quando subir versão.

### Forma das seções de padrão

O catálogo (`### N. Título`) tem três formas, escolhidas pelo conteúdo do padrão:

**Plana pura (default).** Padrões 1–19 e 21–26: parágrafos com rótulos em negrito (`**Problema:**`, `**Palavras a vigiar:**`, `**Antes:**`, `**Depois:**`). Use quando o padrão se descreve em ~10 linhas com um par antes/depois suficiente.

**Plana enriquecida.** Padrão #27 (capitalização de URLs): plana + lista de "Não mexer" + parágrafo de "Regra" explícita. Mesmo nível de heading (`###`), mas o padrão pede uma lista de itens preserváveis e/ou uma regra que merece destaque, sem precisar virar subseções.

**Expandida.** Padrão #20 (travessão): subseções com `####` e padrões viciosos rotulados como `**a)**`–`**f)**`, com diretriz operacional numerada. Use quando o padrão tem múltiplas variantes que precisam ser distinguidas separadamente, ou uma diretriz operacional em passos.

Para escolher:

- Cabe em ~10 linhas com um par antes/depois? → **plana pura**.
- Tem regra de "preservar/não mexer" ou lista de itens? → **plana enriquecida** (considere também se merece categoria nova, como "Preservação técnica").
- Tem múltiplas variantes a–f que precisam ser separadas, ou diretriz em passos? → **expandida**.

Não promova retroativamente seções existentes sem necessidade — o catálogo plano é fácil de varrer e quanto menos seções "especiais", melhor.

## Documentando correções não óbvias

Se você mexer no prompt para lidar com um modo de falha específico (ex.: reedição repetida ou uma mudança de tom inesperada), adicione uma nota curta no histórico de versões do `README.md` descrevendo o que foi corrigido e por quê.

## Rodando as checagens localmente

O workflow `.github/workflows/test.yml` roda em cada push/PR para `main`. Para rodar as mesmas checagens localmente antes de abrir o PR:

```bash
# 1. Validação do frontmatter de SKILL.md e consistência com README.md
pip install pyyaml
python3 scripts/validate_skill.py

# 2. Links internos (entre arquivos Markdown e âncoras de seção)
python3 scripts/check_internal_links.py

# 3. Lint de Markdown (precisa de Node)
npx --yes markdownlint-cli2 "**/*.md" "#node_modules"
```

Links externos são checados pelo job `external-links` no CI (`lychee`), que é não-bloqueante. Lychee é binário Rust e não está no npm; rodar local exige `cargo install lychee` ou `docker run lycheeverse/lychee`. Para a maioria dos casos vale só deixar o CI cuidar.

A config do markdownlint vive em `.markdownlint.jsonc`: por padrão é minimalista, focada em problemas estruturais (níveis de heading, fences sem linguagem, links vazios) em vez de estilo.

## Smoke test (comportamento da skill)

As checagens acima validam estrutura. Não validam **comportamento**: se a skill realmente reescreve texto AI-flavored em algo natural. Para isso existe `scripts/smoke_test.py`, que invoca a skill via Claude API com fixtures conhecidos e aplica assertions qualitativas (contagem de travessões, frases banidas, contagem de parágrafos etc.) sobre a saída.

```bash
pip install anthropic pyyaml
export ANTHROPIC_API_KEY=...
python3 scripts/smoke_test.py                 # roda todos os fixtures
python3 scripts/smoke_test.py --list          # lista sem rodar
python3 scripts/smoke_test.py --dry-run       # valida fixtures sem chamar API
python3 scripts/smoke_test.py --fixture travessao   # filtra por nome
python3 scripts/smoke_test.py --model claude-haiku-4-5-20251001   # mais barato
```

### Quando rodar

**Não roda em cada PR.** Custo de API + flakiness do LLM tornam isso ruidoso. Rode:

- Antes de cada bump minor/major.
- Quando suspeitar regressão de comportamento após mudança no SKILL.md.
- Manual via Actions → workflow `smoke test` → Run workflow (requer secret `ANTHROPIC_API_KEY` no repo).

### Adicionando fixtures

Cada caso é um par em `tests/fixtures/`:

- `<nome>.input.md` — texto AI-flavored.
- `<nome>.assertions.yml` — checagens qualitativas. Chaves suportadas: `travessoes_max`, `banned_phrases`, `required_paragraph_count_min`, `required_paragraph_count_max`, `min_chars`, `max_chars`. Comece com poucas e adicione conforme detectar falsos negativos.
