---
name: diaria-anual
description: Gera a retrospectiva ANUAL da diar.ia.br a partir das edições diárias de 12-13 meses — N temas variáveis (3-7), "o que mudou" e previsões derivadas só do período. Sai 2x por ano — no aniversário (agosto, cobre ago-jul, com bloco de aniversário) e em janeiro (cobre o ano civil). Uso — `/diaria-anual [--tipo aniversario|janeiro] [--desde YYMM] [--ate YYMM] [--no-gate]`. Etapas 0-5 espelhando a mensal, gate único na Etapa 4. Canal — base própria (Kit), envio EXTRA (a diária do dia sai normal). Sem Use Melhor, sem Radar, sem "É IA?" (#7569).
---

# /diaria-anual

Produz a edição **anual** da diar.ia.br: uma retrospectiva dos últimos 12 meses (13 na primeira rodada), escrita a partir das edições **diárias** publicadas no período.

## Argumentos

- `--tipo aniversario|janeiro` — define a janela default e se há bloco de aniversário.
  - `aniversario` → ago(N-1) a jul(N), **com** bloco de aniversário.
  - `janeiro` → jan(N-1) a dez(N-1), **sem** esse bloco.
  - Omitido: derivado do mês corrente (08 → `aniversario`, 01 → `janeiro`); em qualquer outro mês assume a rodada mais recente e **imprime banner** — nunca pergunta (#5321).
- `--desde YYMM` / `--ate YYMM` — sobrescrevem a janela. Vencem o default do tipo, inclusive um sozinho.
- `--no-gate` — pula o gate da Etapa 4.

**A janela pode não ter 12 meses.** A 1ª rodada cobre 13 (`--desde 2508 --ate 2608`, o primeiro ano inteiro do projeto: a primeira edição é de 27/08/2025). Todo texto que cite o período tem que usar o `label` da janela resolvida, nunca "os últimos 12 meses" fixo.

Diretório de trabalho: `data/annual/{AAAA}-{tipo}/` — o `AAAA` é o ano que a retrospectiva **fecha**, não o do envio (a rodada de janeiro/2027 cobre 2026 e mora em `2026-janeiro/`).

## O que a anual NÃO tem

Sem Use Melhor, sem Radar, sem "É IA?" (decisão do editor, 07/09/2026). Nenhuma etapa aqui chama `monthly-click-sections.ts`, `select-eia-edition.ts`, `eia-compose.ts` ou `close-poll.ts`. Se alguma dessas seções aparecer no draft, `lint-annual-draft.ts` reprova.

## Resume check

Cada etapa grava `_internal/.step-N-done.json` (mesmo formato da diária/mensal, `scripts/lib/pipeline-state.ts`). Antes de começar, checar de baixo para cima:

```bash
npx tsx scripts/pipeline-sentinel.ts assert --edition $SLUG --step N --dir "data/annual/$SLUG" --outputs "arquivo1,arquivo2"
```

- Etapa 5: `--outputs "_internal/05-published.json"` → pipeline concluído.
- Etapa 4: `--outputs "_internal/04-fact-check.json"` → pular pra 5.
- Etapa 3: `--outputs "04-d1-2x1.jpg"` → pular pra 4.
- Etapa 2: `--outputs "draft.md"` → pular pra 3.
- Etapa 1: `--outputs "prioritized.md"` → pular pra 2.

Ao fim de cada etapa (1, 2, 3 e 5 sem pausar; só a 4 pausa no gate):

```bash
npx tsx scripts/pipeline-sentinel.ts write --edition $SLUG --step N --dir "data/annual/$SLUG" --outputs "..."
```

---

## Etapa 0 — Preflight

- `context/templates/newsletter-anual.md` e `context/editorial-rules.md` existem e não são placeholder.
- O cache de edições cobre a janela: `data/beehiiv-cache/posts/` (histórico) e `data/kit-cache/broadcasts/` (do cutover de 04/09/2026 em diante). A Etapa 1 acusa mês vazio — **mês sem edição nenhuma é sinal de cache faltando, não de mês sem newsletter**.
- `publishing.newsletter.backend` para a Etapa 5 (hoje `"kit"`, #7388).

Sem gate, sem checkpoint.

---

## Etapa 1 — Coleta e análise

### 1a. Coleta

```bash
npx tsx scripts/collect-annual.ts --tipo $TIPO --desde $DESDE --ate $ATE
```

Resolve a janela, lê os dois caches, extrai os destaques de cada edição diária e agrupa por mês. Grava `_internal/raw-destaques.json` e `_internal/01-collect-report.json` (edições e destaques por mês + fonte usada).

O `$SLUG` sai daqui — o script o imprime no stdout (`slug`).

**Ler o relatório antes de seguir.** Um mês com `destaques_found: 0` significa cache faltando ou formato não reconhecido, e a retrospectiva sairia com um buraco. Medição de referência da 1ª rodada (07/09/2026): ~270 edições e ~670 destaques, com os 13 meses populados e cobertura de 60–100% por mês. **Esses números crescem** — o cache de edições continua recebendo arquivos novos —, então use-os como ordem de grandeza, não como valor esperado: o que importa é nenhum mês estar zerado.

### 1b. Scoring por mês

Disparar `scorer-monthly` (o mesmo agente da mensal — rubrico mecânico, sem julgamento holístico) **em paralelo, um por mês**, cada um recebendo só os destaques daquele mês. São 12-13 chamadas concorrentes; mandar os ~670 destaques num prompt só não cabe.

Cada instância devolve os destaques do seu mês com `score` (0–100). Fundir de volta em `_internal/raw-destaques.json`.

### 1c. Top-K por mês

```bash
npx tsx scripts/collect-annual.ts --tipo $TIPO --desde $DESDE --ate $ATE --select-top-k
```

Corta o top-K de **cada mês** (default `platform.config.json` → `annual.top_k_per_month`, hoje 10; `--top-k` sobrescreve), nunca globalmente: o mês de estreia tem 3 edições e o mês mais cheio tem 30+ — um corte global apagaria o começo da história. Grava `_internal/01-selected.json` **sem tocar no pool**, então trocar o K é re-rodar só este passo.

O script avisa se ainda houver destaque sem score — nesse caso o corte vira ordem de leitura em vez de mérito, e o passo 1b não rodou.

### 1d. Análise temática

Disparar `analyst-anual` via `Agent`:
- `raw_path = data/annual/$SLUG/_internal/01-selected.json`
- `out_path = data/annual/$SLUG/prioritized.md`
- `tipo`, `window_label`

Ele propõe **N temas (3–7) com justificativa do N**, o esboço do "o que mudou" e as previsões.

### Checkpoint

Sem gate. Banner:

```
Janela: {label} ({N} meses)
Temas propostos: {N} — {lista}
Destaques analisados: {N} de {total} coletados
Meses vazios: {nenhum|lista}

Etapa 1 concluída — seguindo para a Etapa 2 (Escrita). O editor revisa tudo no
gate consolidado da Etapa 4; para ajustar antes, edite prioritized.md e peça
"reroda a Etapa 1".
```

---

## Etapa 2 — Escrita

Disparar `writer-anual` via `Agent` com `prioritized_path`, `raw_path`, `report_path`, `out_path`, `tipo`, `window_label` e `counts`.

O `counts` (bloco de aniversário) é apurado aqui, nunca estimado:

```bash
node -e "
const r=require('./data/annual/$SLUG/_internal/01-collect-report.json');
const fs=require('fs');
const mensais=fs.readdirSync('data/monthly').filter(c=>fs.existsSync('data/monthly/'+c+'/draft.md')).length;
const especiais=fs.existsSync('data/artigo-especial')?fs.readdirSync('data/artigo-especial').length:0;
console.log(JSON.stringify({edicoes_diarias:r.editions_found,digests_mensais:mensais,artigos_especiais:especiais}));
"
```

Depois:

```bash
npx tsx scripts/lint-annual-draft.ts --slug $SLUG
npx tsx scripts/lint-density.ts --file data/annual/$SLUG/draft.md
```

Exit 1 do primeiro = falha crítica (label não reconhecido, N fora de 3–7, seção proibida, tema que sairia sem imagem). **Não seguir** — corrigir o draft e re-rodar.

Depois: `Skill("humanizador", ...)` in-place no `draft.md`, e Clarice (`mcp__clarice__correct_text` + `scripts/clarice-apply.ts`). Falha em qualquer um dos dois: warning, segue.

**Subject: default opção 1** (#5321). Gravar a linha completa em `_internal/02-chosen-subject.txt`. **Invariante do ASSUNTO:** qualquer passo posterior que mexa no `draft.md` usa `Edit`, nunca `Write` cego; se `Write` for inevitável, restaurar o assunto logo depois.

Banner com as 3 opções (marcando a assumida) e segue.

---

## Etapa 3 — Imagens

Uma imagem 2:1 por tema — **N variável, não 3**:

```bash
for P in data/annual/$SLUG/_internal/02-d*-prompt.md; do
  N=$(basename "$P" | sed -E 's/02-d([0-9]+)-prompt\.md/\1/')
  npx tsx scripts/image-generate.ts --editorial "$P" --out-dir data/annual/$SLUG/ --destaque "d$N" --ratio 2x1
done
```

Sem "É IA?". Prompt sem resolução em pixels e sem Noite Estrelada (regra invariável).

Subir as imagens e gravar `_internal/public-images.json` (URL pública → nome do arquivo local) — é o mapa que a Etapa 5 usa para achar `04-d{N}-2x1.jpg`.

---

## Etapa 4 — Revisão consolidada (gate único)

### 4a. Pré-render + preview local

```bash
npx tsx scripts/publish-annual-kit.ts --slug $SLUG --dry-run
npx tsx scripts/embed-images-base64.ts \
  --html data/annual/$SLUG/_internal/04-preview.html \
  --images data/annual/$SLUG/_internal/public-images.json \
  --edition-dir data/annual/$SLUG \
  --out data/annual/$SLUG/_internal/04-preview-embedded.html
```

Servir com `scripts/serve-preview.ts` no padrão stop-old → serve-new da mensal (`--port 0`, `--persist-to _internal/preview-server-url.json`, `run_in_background: true`), e persistir o `tabId` para o teardown.

### 4b. Lints

```bash
npx tsx scripts/lint-annual-draft.ts --slug $SLUG
npx tsx scripts/lint-density.ts --file data/annual/$SLUG/draft.md
```

### 4c. Fact-check

`fact-checker` em modo mensal sobre o `draft.md`, `out_path = _internal/04-fact-check.json`.

**As PREVISÕES ficam fora do fact-check** — elas são extrapolação declarada do próprio período, sem fonte externa a verificar. Dizer isso no resumo do gate, para não parecer que a verificação passou por elas.

### 4d. Resumo + gate humano

```
📋 Revisão consolidada — diar.ia.br Anual {window_label}

🌐 Preview completo (local): {preview_url}

Janela: {label} — {N} meses ({total} edições, {total} destaques coletados)
Temas: {N} — {lista dos títulos}
Justificativa do N (analyst-anual): {resumo de 1 linha}

Lint (lint-annual-draft.ts):
  Render: {N} <img> para {N} temas — OK
  Tema 1: {chars} / 2.000 {✓|⚠}
  ...
  O que mudou: {chars} / 1.800 {✓|⚠}
  Previsões: {chars} / 2.000 {✓|⚠}

Lint de densidade: {resumo}

Fact-check: {total} claims — {sustained} sustentados, {atenção} pedem atenção
  (as PREVISÕES não são verificadas: extrapolação do período, sem fonte externa)

[se editor_letter_pending]
⚠️ A CARTA DO EDITOR ainda é placeholder. O render a OMITE do e-mail — a edição
   de aniversário sairia sem ela. Escreva no draft.md antes de aprovar.

Confirma o N de {N} temas e aprova? sim / editar / retry
```

- `editar` → editor mexe no `draft.md`; re-rodar 4a→4c.
- `retry` → re-rodar 4a→4c com o mesmo draft.

Após `sim`: encerrar o preview (matar o PID e fechar a aba — excluindo sempre a porta 4174 do Studio, #3727) e gravar o checkpoint.

---

## Etapa 5 — Publicação

```bash
npx tsx scripts/publish-annual-kit.ts --slug $SLUG
npx tsx scripts/publish-annual-kit.ts --slug $SLUG --send-test
```

Cria o broadcast na base própria **como rascunho** (`send_at: null`) e dispara o test email por um broadcast descartável escopado à tag `diaria-test-email`. Idempotente: uma segunda invocação atualiza o mesmo `broadcast_id` em vez de criar um 2º rascunho.

O lint roda de novo aqui — o draft pode ter mudado depois do gate.

**O disparo real é ação humana.** Esta skill não agenda nem envia: o editor abre o rascunho no Kit e dispara. É envio **extra** — a edição diária do dia sai normalmente.

Banner final com `broadcast_id`, `public_url` e o lembrete de que o envio ainda não aconteceu.

---

## Fronteira de contexto

Esta skill não encadeia para nenhuma outra (#5578). Ao terminar a Etapa 5, escrever o sentinel, apresentar o resumo e parar.
