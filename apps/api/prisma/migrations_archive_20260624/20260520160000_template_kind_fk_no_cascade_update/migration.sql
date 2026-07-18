-- May 16 H12 fix (2026-05-20): asset_templates.template_kind FK was
-- ON UPDATE CASCADE. A direct SQL `UPDATE template_kinds SET code='NEW'
-- WHERE code='OLD'` would silently rewrite the template_kind column on
-- every asset_template row that referenced the old code. Filter Management
-- looks up by template_kind, so the silent rewrite would either break
-- resolution (new code doesn't match anything UI expects) or rebind
-- assets to the wrong category.
--
-- Change to ON UPDATE RESTRICT: explicit row migration is now required.
-- Admin UI never exposed the rename path, but DB-level operators / scripts
-- could trigger it.

ALTER TABLE asset_templates
  DROP CONSTRAINT IF EXISTS asset_templates_template_kind_fkey;

ALTER TABLE asset_templates
  ADD CONSTRAINT asset_templates_template_kind_fkey
  FOREIGN KEY (template_kind)
  REFERENCES template_kinds(code)
  ON DELETE RESTRICT
  ON UPDATE RESTRICT;
