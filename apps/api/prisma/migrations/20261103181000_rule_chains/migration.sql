-- RULE CHAINS (2026-11-03): a ThingsBoard-style rule engine — chains of typed
-- nodes joined by labelled relations, one of them the ROOT every message enters.
-- Spec: docs/superpowers/specs/2026-11-03-rule-chains-design.md §5, §8
--
-- Hand-authored from `prisma migrate diff --from-schema-datasource
-- --to-schema-datamodel`; ONLY the four new tables, their indexes and their keys
-- are kept. Stripped, as on every migration here: the DROP of the partitioned
-- instrument_telemetry_history (Prisma cannot see it), the audit_trail
-- .chain_position / audit_chain_counter noise, the instrument_credentials FK
-- drop/re-add and the notification_rule_recipients index drop.
--
-- The chain DOCUMENT (`rule_chains.document`) is the source of truth (ruling
-- D-1). `rule_nodes` and `rule_node_connections` are its PROJECTION, deleted and
-- re-inserted with the document's node ids by the one save path; a node is keyed
-- by (chain, node id) because two chains may carry the same node ids.

-- CreateTable
CREATE TABLE "rule_chains" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(120) NOT NULL,
    "root" BOOLEAN NOT NULL DEFAULT false,
    "debug_mode" BOOLEAN NOT NULL DEFAULT false,
    "first_node_id" UUID,
    "document" JSONB NOT NULL,
    "re_enter_on_rule_node_writes" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_by" VARCHAR(255),
    "updated_by" VARCHAR(255),

    CONSTRAINT "rule_chains_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_nodes" (
    "chain_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "type" VARCHAR(128) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "config" JSONB NOT NULL,
    "debug_mode" VARCHAR(10) NOT NULL DEFAULT 'off',
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "index" INTEGER NOT NULL,

    CONSTRAINT "rule_nodes_pkey" PRIMARY KEY ("chain_id","id")
);

-- CreateTable
CREATE TABLE "rule_node_connections" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "chain_id" UUID NOT NULL,
    "from_node_id" UUID NOT NULL,
    "to_node_id" UUID NOT NULL,
    "relation" VARCHAR(128) NOT NULL,

    CONSTRAINT "rule_node_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Debug events: NOT a §11 record (swept by age, capped per node). NO key to
-- rule_nodes on purpose — the projection is re-inserted on every save, so a key
-- would either wipe the history (CASCADE) or block the save (RESTRICT).
CREATE TABLE "rule_node_debug_events" (
    "id" BIGSERIAL NOT NULL,
    "chain_id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "direction" VARCHAR(3) NOT NULL,
    "relation" VARCHAR(128),
    "msg_id" VARCHAR(64) NOT NULL,
    "msg_type" VARCHAR(255) NOT NULL,
    "originator_type" VARCHAR(20) NOT NULL,
    "originator_id" VARCHAR(255) NOT NULL,
    "data" JSONB NOT NULL,
    "metadata" JSONB NOT NULL,
    "error" TEXT,

    CONSTRAINT "rule_node_debug_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rule_chains_name_key" ON "rule_chains"("name");

-- CreateIndex
CREATE INDEX "rule_node_connections_chain_id_from_node_id_idx" ON "rule_node_connections"("chain_id", "from_node_id");

-- CreateIndex
CREATE INDEX "rule_node_debug_events_node_id_ts_idx" ON "rule_node_debug_events"("node_id", "ts" DESC);

-- CreateIndex
CREATE INDEX "rule_node_debug_events_chain_id_ts_idx" ON "rule_node_debug_events"("chain_id", "ts" DESC);

-- AddForeignKey
ALTER TABLE "rule_nodes" ADD CONSTRAINT "rule_nodes_chain_id_fkey" FOREIGN KEY ("chain_id") REFERENCES "rule_chains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_node_connections" ADD CONSTRAINT "rule_node_connections_chain_id_fkey" FOREIGN KEY ("chain_id") REFERENCES "rule_chains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_node_connections" ADD CONSTRAINT "rule_node_connections_chain_id_from_node_id_fkey" FOREIGN KEY ("chain_id", "from_node_id") REFERENCES "rule_nodes"("chain_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_node_connections" ADD CONSTRAINT "rule_node_connections_chain_id_to_node_id_fkey" FOREIGN KEY ("chain_id", "to_node_id") REFERENCES "rule_nodes"("chain_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_node_debug_events" ADD CONSTRAINT "rule_node_debug_events_chain_id_fkey" FOREIGN KEY ("chain_id") REFERENCES "rule_chains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- NOT expressible in schema.prisma (documented on the models):
--
-- EXACTLY ONE root chain. `POST /api/rule-chains/:id/root` unsets the old root
-- BEFORE setting the new one, in one transaction under an advisory lock; this
-- index is the invariant behind that rule (a unique index is checked per row,
-- so the reverse order would fail).
CREATE UNIQUE INDEX "rule_chains_one_root" ON "rule_chains"("root") WHERE "root";

-- One OPEN rule-created alarm per instrument per alarm TYPE (the third such
-- partial index on alarms, after alarms_active_instrument_limit_unique and
-- alarms_active_inactivity_unique). A Create alarm node that fires again updates
-- the open alarm, as ThingsBoard does; two engine workers cannot both open it.
-- Verified 2026-11-03 before writing: 0 alarms with source = 'RULE' in
-- compliance_core_db and in compliance_core_db_test (alarm rules were removed
-- 2026-08-31), so the index cannot fail to build. Uses only existing enum
-- values; CUSTOM is added by 20261103180000_alarm_metric_custom.
CREATE UNIQUE INDEX "alarms_active_rule_type_unique" ON "alarms"("instrument_id", (("rule_snapshot" ->> 'alarmType'))) WHERE "state" = 'ACTIVE' AND "source" = 'RULE';

-- THE SHIPPED ROOT CHAIN (spec §5), inserted only when no chain exists:
-- ThingsBoard's default — Message Type Switch → `Post telemetry` → Save
-- Timeseries · `Post attributes` → Save Attributes · `Other` → Log Other. Four
-- nodes (the Input is the chain's firstNodeId, not a node; ruling T1-3).
--
-- Generated from `defaultRootChainDocument()` (@digilog/shared
-- rule-chain-document.ts) — JSON.stringify, single quotes doubled, a plain
-- '...' literal (the Log node's script carries backslashes, which a plain
-- literal keeps as written). The node ids are that function's FIXED ids; the
-- chain id b1a7e000-0000-4000-8000-000000000000 is fixed too
-- (`SEEDED_ROOT_CHAIN_ID` in modules/rule-engine/service.ts).
-- `src/e2e/rule-chains.e2e.test.ts` compares the seeded row and its
-- projection with the function, so the two cannot drift silently.
--
-- No audit row: a migration cannot write the hash-chained trail. created_by /
-- updated_by are NULL — the shipped chain was written by no user.
INSERT INTO "rule_chains" ("id", "name", "root", "debug_mode", "first_node_id", "document", "re_enter_on_rule_node_writes", "created_at", "updated_at", "created_by", "updated_by")
SELECT 'b1a7e000-0000-4000-8000-000000000000'::uuid, 'Root Rule Chain', true, false, 'b1a7e000-0000-4000-8000-000000000001'::uuid,
       '{"version":1,"firstNodeId":"b1a7e000-0000-4000-8000-000000000001","nodes":[{"id":"b1a7e000-0000-4000-8000-000000000001","type":"tb:filter:message-type-switch","name":"Message Type Switch","debugMode":"off","config":{"version":0},"x":566,"y":302},{"id":"b1a7e000-0000-4000-8000-000000000002","type":"tb:action:save-timeseries","name":"Save Timeseries","debugMode":"off","config":{"defaultTTL":0,"useServerTs":false,"skipLatestPersistence":false,"processingSettings":{"type":"ON_EVERY_MESSAGE"}},"x":999,"y":271},{"id":"b1a7e000-0000-4000-8000-000000000003","type":"tb:action:save-attributes","name":"Save Attributes","debugMode":"off","config":{"processingSettings":{"type":"ON_EVERY_MESSAGE"},"scope":"CLIENT_SCOPE","notifyDevice":false,"sendAttributesUpdatedNotification":false,"updateAttributesOnlyOnValueChange":true},"x":1000,"y":167},{"id":"b1a7e000-0000-4000-8000-000000000004","type":"tb:action:log","name":"Log Other","debugMode":"off","config":{"scriptLang":"JS","jsScript":"return ''\\nIncoming message:\\n'' + JSON.stringify(msg) + ''\\nIncoming metadata:\\n'' + JSON.stringify(metadata);"},"x":1000,"y":494}],"connections":[{"from":"b1a7e000-0000-4000-8000-000000000001","to":"b1a7e000-0000-4000-8000-000000000002","relation":"Post telemetry"},{"from":"b1a7e000-0000-4000-8000-000000000001","to":"b1a7e000-0000-4000-8000-000000000003","relation":"Post attributes"},{"from":"b1a7e000-0000-4000-8000-000000000001","to":"b1a7e000-0000-4000-8000-000000000004","relation":"Other"}]}'::jsonb,
       false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL
WHERE NOT EXISTS (SELECT 1 FROM "rule_chains");

INSERT INTO "rule_nodes" ("chain_id", "id", "type", "name", "config", "debug_mode", "x", "y", "index")
SELECT 'b1a7e000-0000-4000-8000-000000000000'::uuid, v.id::uuid, v.type, v.name, v.config::jsonb, v.debug_mode, v.x, v.y, v.idx
FROM (VALUES
  ('b1a7e000-0000-4000-8000-000000000001', 'tb:filter:message-type-switch', 'Message Type Switch', '{"version":0}', 'off', 566.0::double precision, 302.0::double precision, 0),
  ('b1a7e000-0000-4000-8000-000000000002', 'tb:action:save-timeseries', 'Save Timeseries', '{"defaultTTL":0,"useServerTs":false,"skipLatestPersistence":false,"processingSettings":{"type":"ON_EVERY_MESSAGE"}}', 'off', 999.0::double precision, 271.0::double precision, 1),
  ('b1a7e000-0000-4000-8000-000000000003', 'tb:action:save-attributes', 'Save Attributes', '{"processingSettings":{"type":"ON_EVERY_MESSAGE"},"scope":"CLIENT_SCOPE","notifyDevice":false,"sendAttributesUpdatedNotification":false,"updateAttributesOnlyOnValueChange":true}', 'off', 1000.0::double precision, 167.0::double precision, 2),
  ('b1a7e000-0000-4000-8000-000000000004', 'tb:action:log', 'Log Other', '{"scriptLang":"JS","jsScript":"return ''\\nIncoming message:\\n'' + JSON.stringify(msg) + ''\\nIncoming metadata:\\n'' + JSON.stringify(metadata);"}', 'off', 1000.0::double precision, 494.0::double precision, 3)
) AS v (id, type, name, config, debug_mode, x, y, idx)
WHERE EXISTS (SELECT 1 FROM "rule_chains" WHERE "id" = 'b1a7e000-0000-4000-8000-000000000000'::uuid)
  AND NOT EXISTS (SELECT 1 FROM "rule_nodes" WHERE "chain_id" = 'b1a7e000-0000-4000-8000-000000000000'::uuid);

INSERT INTO "rule_node_connections" ("chain_id", "from_node_id", "to_node_id", "relation")
SELECT 'b1a7e000-0000-4000-8000-000000000000'::uuid, v.from_id::uuid, v.to_id::uuid, v.relation
FROM (VALUES
  ('b1a7e000-0000-4000-8000-000000000001', 'b1a7e000-0000-4000-8000-000000000002', 'Post telemetry'),
  ('b1a7e000-0000-4000-8000-000000000001', 'b1a7e000-0000-4000-8000-000000000003', 'Post attributes'),
  ('b1a7e000-0000-4000-8000-000000000001', 'b1a7e000-0000-4000-8000-000000000004', 'Other')
) AS v (from_id, to_id, relation)
WHERE EXISTS (SELECT 1 FROM "rule_nodes" WHERE "chain_id" = 'b1a7e000-0000-4000-8000-000000000000'::uuid)
  AND NOT EXISTS (SELECT 1 FROM "rule_node_connections" WHERE "chain_id" = 'b1a7e000-0000-4000-8000-000000000000'::uuid);
