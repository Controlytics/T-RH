-- CreateTable
CREATE TABLE "admin_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_type" VARCHAR(30) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "requester_name" VARCHAR(100) NOT NULL,
    "requester_employee_id" VARCHAR(50),
    "requester_email" VARCHAR(100),
    "request_data" JSONB NOT NULL DEFAULT '{}',
    "remarks" VARCHAR(500),
    "admin_remarks" VARCHAR(500),
    "processed_by" VARCHAR(100),
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,

    CONSTRAINT "admin_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_requests_status_idx" ON "admin_requests"("status");

-- CreateIndex
CREATE INDEX "admin_requests_request_type_idx" ON "admin_requests"("request_type");

-- CreateIndex
CREATE INDEX "admin_requests_requested_at_idx" ON "admin_requests"("requested_at" DESC);

-- CreateIndex
CREATE INDEX "cleaning_cycles_filter_id_status_started_at_idx" ON "cleaning_cycles"("filter_id", "status", "started_at" DESC);

-- CreateIndex
CREATE INDEX "filter_events_filter_id_cycle_id_event_type_idx" ON "filter_events"("filter_id", "cycle_id", "event_type");

-- CreateIndex
CREATE INDEX "filter_events_filter_id_performed_at_idx" ON "filter_events"("filter_id", "performed_at" DESC);

-- CreateIndex
CREATE INDEX "notification_rules_is_active_priority_idx" ON "notification_rules"("is_active", "priority" DESC);
