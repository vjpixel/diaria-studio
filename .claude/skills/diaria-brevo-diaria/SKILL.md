---
name: diaria-brevo-diaria
description: Empacota o envio da edição diária pelo canal Brevo próprio do editor (segmento Pending da Beehiiv — reativação, `platform.config.json` → `brevo_diaria`). Skill manual e separada do fluxo 0-5 de `/diaria-edicao` (Beehiiv continua sendo o canal principal automático) — o editor decide quando disparar este canal extra. Uso — `/diaria-brevo-diaria AAMMDD`.
---

# /diaria-brevo-diaria

Empacota `scripts/publish-daily-brevo.ts` (#4266) — hoje só invocável manualmente
via CLI — no mesmo padrão de skill manual já usado por `/diaria-mensal-apoiadores`:
preview obrigatório, gate humano explícito, e nunca agenda/envia sozinho (#4580).

**Canal Pending, não o canal principal.** O envio-padrão da edição (Beehiiv,
lista completa de assinantes confirmados) continua saindo pelo fluxo normal de
`/diaria-edicao`/`/diaria-5-publicacao`. Este canal é um EXTRA: gente que se
inscreveu na Beehiiv mas nunca confirmou o double opt-in (segmento Pending),
migrada pra uma lista Brevo própria do editor como via alternativa de
reativação (#4266/#4476). Rodar esta skill não substitui nem depende do envio
Beehiiv da mesma edição — são canais paralelos e independentes.

## Argumentos

- `AAMMDD` — **obrigatório, sempre explícito**, nunca inferir a partir de
  `today()` (mesma disciplina do CLAUDE.md — "Data da edição é sempre
  explícita"). Se o usuário não passar a data, perguntar com sugestão de
  hoje/ontem como atalho, mas exigir confirmação antes de prosseguir.

## Pré-requisito: localizar o diretório da edição

As pastas de edição são NESTED por mês — `data/editions/{AAMM}/{AAMMDD}`, não
`data/editions/{AAMMDD}` (achado ao vivo registrado no comentário 2026-08-04 da
issue #4580, execução manual da edição 260804). Resolva o path com o helper
canônico em vez de montar a string à mão:

```bash
npx tsx -e "import { editionDir } from './scripts/lib/edition-paths.ts'; console.log(editionDir('AAMMDD'))"
```

(substitua `AAMMDD` pelo argumento recebido). Use o resultado como
`<edition-dir>` nos passos abaixo. Se o diretório não existir, informe o
editor e pare — não há o que publicar.

## Passo 1 — Preview (`--dry-run`, sempre primeiro)

```bash
npx tsx scripts/publish-daily-brevo.ts <edition-dir> --dry-run
```

Mostra ao editor, a partir do stderr do script:

- **Assunto** (`Assunto: ...`) e **preview text** (`Preview: ...`).
- **Warnings de imagem não resolvida** (`warn: N placeholder(s) de imagem sem
  URL: ...`) — se aparecer, avise explicitamente antes do gate do Passo 2; o
  editor pode preferir corrigir `06-public-images.json` antes de prosseguir.
- O HTML completo fica escrito em
  `<edition-dir>/_internal/newsletter-final-brevo.html` — mencione o path pro
  editor poder abrir e ler o corpo renderizado, inclusive o bloco de intro
  obrigatório do segmento Pending (`context/snippets/brevo-diaria-pending-intro.md`
  — ver disclaimer no próprio arquivo, ainda rascunho).

Se o script abortar antes disso (assunto vazio, `brevo_diaria` ausente em
`platform.config.json`, etc. — ver exit codes no cabeçalho do script), relate o
erro tal como impresso e pare — não tente contornar.

## Passo 2 — Gate humano explícito

**Nunca pule este passo, mesmo com `--dry-run` limpo.** Apresente ao editor:

- Assunto e preview text do Passo 1.
- Qualquer warning de imagem.
- Lembrete explícito: `--i-reviewed-the-copy` é a confirmação de que ele
  revisou `context/snippets/brevo-diaria-pending-intro.md` (o bloco de intro
  ainda é rascunho, por decisão registrada no próprio arquivo/#4266) — não é
  só uma flag de "prossiga", é uma checagem de compliance sobre ESTE texto
  específico.

Só prossiga pro Passo 3 com confirmação explícita ("sim", "pode mandar",
equivalente). Resposta ambígua ou ausência de resposta → não prossiga, pergunte
de novo (mesma disciplina do #3938 pra gates interativos).

## Passo 2.5 — Evaluate antes do envio (opcional, considerar)

`scripts/evaluate-brevo-diaria.ts --push` reavalia promoção/supressão dos
contatos `in_brevo` por taxa de abertura ANTES desta campanha nova sair — a
task agendada que faria isso automaticamente (`Diaria-Brevo-Diaria-Evaluate`,
05:30 BRT, #4534) ainda não foi armada em produção segundo o CLAUDE.md.
Sugerir ao editor rodar:

```bash
npx tsx scripts/evaluate-brevo-diaria.ts --push
```

antes do Passo 3, especialmente se fizer tempo desde a última avaliação —
evita que quem já deveria ter sido promovido/suprimido receba mais um envio
Pending. **Não é obrigatório** (a skill não bloqueia sem isso) — é uma
sugestão que a skill deve fazer explicitamente, não decidir sozinha. Igual ao
guard de publicação geral: nunca chamar isso com dados reais fora de uma
sessão onde o editor pediu.

## Passo 3 — Criar a campanha (rascunho)

Só depois da confirmação explícita do Passo 2:

```bash
npx tsx scripts/publish-daily-brevo.ts <edition-dir> --i-reviewed-the-copy
```

A campanha sai **sempre como rascunho** — o script nunca agenda nem envia
sozinho (mesma cautela do publisher mensal, `publish-monthly.ts`). Reporte ao
editor:

- **Campaign id** (`campanha criada: id=N ...`, impresso no stderr).
- Lembrete explícito: **schedule/send final é ação manual no painel Brevo**
  (`app.brevo.com`) — esta skill não faz isso, e não existe flag
  `--schedule-at`/`--send-now` em `publish-daily-brevo.ts` hoje.
- Se o editor quiser mandar um e-mail de teste antes de agendar: **gap
  conhecido** — `publish-daily-brevo.ts` não tem `--send-test` (diferente de
  `publish-monthly.ts`, que já tem essa flag). O caminho hoje é chamar a API
  Brevo direto (`POST /emailCampaigns/{id}/sendTest {emailTo: [...]}`) ou pela
  UI do painel — não inventar um mecanismo novo aqui, só informar a lacuna
  (ver comentário 2026-08-04 da issue #4580 — fechar esse gap é unidade de
  trabalho separada, não desta skill).

## Fora de escopo desta skill

- Corrigir o gate de lote em `selectContactsForBackfill`
  (`sync-pending-to-brevo.ts`) — issue #4632, separada.
- Adicionar `--send-test` a `publish-daily-brevo.ts` — gap conhecido (ver
  Passo 3), não fechado aqui.
- Agendar ou disparar a campanha de fato — sempre ação manual do editor no
  painel Brevo, nunca automatizada por esta skill (guard de publicação,
  invariante do CLAUDE.md).
