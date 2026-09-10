-- Registro do novo app no Portal Interno -- pura operacao de dados,
-- nenhuma mudanca de codigo no Portal (ver /opt/portal/app/auth.py e
-- db.py). Rodar contra o SQLite do Portal (backup antes, mesmo padrao
-- ja usado nas outras migracoes manuais deste projeto).
--
-- Ajustar icon/sort_order pra combinar com os outros cards antes de
-- rodar.
--
-- Acesso: usuario "admin" (id=1) e is_master=1 no Portal (conferido em
-- 03/09/2026, SELECT id, username, is_master FROM users) -- master ja
-- enxerga todo card com is_active=1 automaticamente, sem precisar de
-- linha em user_applications. Por isso este script NAO insere nada em
-- user_applications: nao criar usuario novo nem permissao explicita,
-- o pedido foi logar com o mesmo "admin" que ja acessa a tela de apps.
-- So repetir o INSERT comentado abaixo se um dia quiserem dar acesso a
-- um usuario nao-master (marketing/lari/lindo).

INSERT INTO applications (key, name, description, url, icon, sort_order, is_active)
VALUES (
  'erp_wake',
  'Integração ERP → Wake',
  'Sincronização de preço e estoque do ERP (CISS/PODER) para o Wake Commerce -- fixadores/parafusos.',
  'http://128.1.0.30:8083/',
  'refresh',    -- alinhado ao padrao dos outros cards: chart/boxes/clipboard (palavra unica, sem hifen)
  40,           -- proximo da sequencia 10/20/30 dos outros 3 cards
  1
);

-- Conceder acesso a um usuario nao-master especifico (repetir por
-- usuario, se necessario no futuro):
-- INSERT INTO user_applications (user_id, application_id)
-- SELECT <ID_DO_USUARIO>, id FROM applications WHERE key = 'erp_wake';
