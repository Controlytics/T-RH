-- CreateIndex
CREATE INDEX "cleaning_cycles_status_idx" ON "cleaning_cycles"("status");

-- CreateIndex
CREATE INDEX "data_streams_source_idx" ON "data_streams"("source");

-- CreateIndex
CREATE INDEX "organizations_parent_org_id_idx" ON "organizations"("parent_org_id");

-- AddForeignKey
ALTER TABLE "template_assignments" ADD CONSTRAINT "template_assignments_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "asset_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_assignments" ADD CONSTRAINT "template_assignments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_assignments" ADD CONSTRAINT "template_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_assignments" ADD CONSTRAINT "entity_assignments_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "asset_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_assignments" ADD CONSTRAINT "entity_assignments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_assignments" ADD CONSTRAINT "entity_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
