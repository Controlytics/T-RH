-- CreateTable
CREATE TABLE "equipment_groups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(255) NOT NULL,
    "block_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "equipment_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipment_group_instruments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "group_id" UUID NOT NULL,
    "description" VARCHAR(255) NOT NULL,
    "stage_key" VARCHAR(100) NOT NULL,
    "serial_number" VARCHAR(100) NOT NULL,
    "instrument_id" VARCHAR(100) NOT NULL,
    "uom" VARCHAR(50) NOT NULL,
    "instrument_min" DOUBLE PRECISION NOT NULL,
    "instrument_max" DOUBLE PRECISION NOT NULL,
    "operating_min" DOUBLE PRECISION NOT NULL,
    "operating_max" DOUBLE PRECISION NOT NULL,
    "least_count" DOUBLE PRECISION NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "equipment_group_instruments_pkey" PRIMARY KEY ("id")
);

-- Add equipmentGroupId to cleaning_cycles
ALTER TABLE "cleaning_cycles" ADD COLUMN "equipment_group_id" UUID;

-- CreateIndex
CREATE INDEX "equipment_groups_block_id_idx" ON "equipment_groups"("block_id");
CREATE INDEX "equipment_groups_organization_id_is_active_idx" ON "equipment_groups"("organization_id", "is_active");
CREATE INDEX "equipment_group_instruments_group_id_sort_order_idx" ON "equipment_group_instruments"("group_id", "sort_order");

-- AddForeignKey
ALTER TABLE "equipment_groups" ADD CONSTRAINT "equipment_groups_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "asset_instances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_group_instruments" ADD CONSTRAINT "equipment_group_instruments_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "equipment_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cleaning_cycles" ADD CONSTRAINT "cleaning_cycles_equipment_group_id_fkey" FOREIGN KEY ("equipment_group_id") REFERENCES "equipment_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
