<!--
nome: Curadoria de Livros
alt: Prévia da página de curadoria de livros sobre IA da diar.ia.br (livros.diar.ia.br), com nota, resenha e filtros por idioma/nível/tema
Bloco canônico de DIVULGAÇÃO da curadoria de LIVROS. Fonte única do box de
divulgação slot 1 (D1/D2, #2978) diário entre D1 e D2 (default desde #2527 —
substituiu o bloco Clarice como padrão; decisão editorial do editor).
Curadoria própria (NÃO patrocinado) → o render NÃO adiciona o separador
"Divulgação" (ver isBoxDivulgacaoLivros em scripts/lib/newsletter-parse.ts —
discrimina pelo link livros.diar.ia.br, não por emoji). Auto-inserção/
cadência: #1938. Kill-switch pontual: --no-sponsor.

#3475: sem marcador emoji de abertura (📚) — o sistema de marcadores foi
removido; a detecção do box é 100% por posição/estrutura/link, nunca por
emoji (#3204/#3232).

O bloco Clarice continua disponível em
context/snippets/clarice-divulgacao.md para reuso (ex: mensal, ou troca
pontual do callout diário).

#4641: este parágrafo passou por Humanizador + mcp__clarice__correct_text em
260807 (mesmo padrão do Stage 2 da diária). Ao editar a prosa deste bloco no
futuro, repetir os dois passes antes de commitar — não é automático (o texto
é majoritariamente estático, editado por curadoria manual, não a cada build).
-->

**A diar.ia.br mantém uma curadoria de livros sobre IA, cada título com nota da Amazon, resenha e link de compra, e filtros por idioma, nível e tema. Encontre sua próxima leitura em segundos. [Confira a página de livros](https://livros.diar.ia.br).**
