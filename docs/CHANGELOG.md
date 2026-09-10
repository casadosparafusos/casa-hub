# CHANGELOG — documentação

## v5 — 10/09/2026

Consolidação completa após auditoria do repositório público.

Mudanças:
- PRICE_RULES tornou explícita a variação por UNIT;
- CENTO = preço CISS/100;
- fixador varejo = +20%;
- >=100 = -20% sobre o varejo;
- PC/UN = preço CISS por peça;
- KG = preço/kg × kg/caixa;
- estoque CENTO = ×100 e 10%;
- estoque PC/UN = 1:1;
- estoque KG = floor(kg/kgCaixa);
- criado INVENTORY_RULES;
- criado UI_UX_REQUIREMENTS;
- criado REPO_WORKFLOW;
- prompt Claude atualizado para auditoria runtime antes de writes.
