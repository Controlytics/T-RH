-- CreateEnum
CREATE TYPE "HierarchyLevel" AS ENUM ('COMPANY', 'SITE', 'PLANT', 'BUILDING', 'BLOCK', 'AREA', 'LINE');

-- CreateEnum
CREATE TYPE "TopicCategory" AS ENUM ('TELEMETRY', 'ATTRIBUTES', 'ALARM', 'COMMAND', 'RPC', 'HEARTBEAT', 'EVENT', 'STATUS', 'CONFIG', 'RESPONSE', 'SETTINGS', 'PUBLISH', 'SUBSCRIBE');

-- NOTE: the auto-generated candidate diff also included
--   ALTER TABLE "audit_trail" ALTER COLUMN "chain_position" DROP NOT NULL;
-- This is pre-existing baseline-vs-datamodel drift noise (schema.prisma models
-- chainPosition as BigInt? while the live baseline enforces NOT NULL via a
-- BIGSERIAL sequence — see apps/api/CLAUDE.md "Baseline = a pg_dump"). It is
-- unrelated to this task and audit_trail must not be touched, so it is
-- deliberately omitted here.

-- CreateTable
CREATE TABLE "hierarchy_nodes" (
    "id" TEXT NOT NULL,
    "parent_id" TEXT,
    "level" "HierarchyLevel" NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "hierarchy_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "protocols" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "capabilities" JSONB NOT NULL,

    CONSTRAINT "protocols_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "communication_profiles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "protocol_key" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "communication_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateways" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "gateway_type" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "hierarchy_node_id" TEXT NOT NULL,
    "communication_profile_id" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "gateways_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instruments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "instrument_type" TEXT NOT NULL,
    "manufacturer" TEXT,
    "model" TEXT,
    "serial_number" TEXT,
    "description" TEXT,
    "hierarchy_node_id" TEXT NOT NULL,
    "gateway_id" TEXT,
    "device_key" TEXT,
    "communication_profile_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "instruments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instrument_settings" (
    "instrument_id" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instrument_settings_pkey" PRIMARY KEY ("instrument_id")
);

-- CreateTable
CREATE TABLE "instrument_topics" (
    "id" TEXT NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "category" "TopicCategory" NOT NULL,
    "custom_topic" TEXT,
    "qos" INTEGER NOT NULL DEFAULT 1,
    "retain" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "instrument_topics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hierarchy_nodes_level_idx" ON "hierarchy_nodes"("level");

-- CreateIndex
CREATE UNIQUE INDEX "hierarchy_nodes_parent_id_slug_key" ON "hierarchy_nodes"("parent_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "communication_profiles_name_key" ON "communication_profiles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "gateways_code_key" ON "gateways"("code");

-- CreateIndex
CREATE INDEX "gateways_hierarchy_node_id_idx" ON "gateways"("hierarchy_node_id");

-- CreateIndex
CREATE UNIQUE INDEX "gateways_hierarchy_node_id_slug_key" ON "gateways"("hierarchy_node_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "instruments_code_key" ON "instruments"("code");

-- CreateIndex
CREATE INDEX "instruments_gateway_id_idx" ON "instruments"("gateway_id");

-- CreateIndex
CREATE UNIQUE INDEX "instruments_gateway_id_device_key_key" ON "instruments"("gateway_id", "device_key");

-- CreateIndex
CREATE UNIQUE INDEX "instruments_hierarchy_node_id_slug_key" ON "instruments"("hierarchy_node_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "instrument_topics_instrument_id_category_key" ON "instrument_topics"("instrument_id", "category");

-- AddForeignKey
ALTER TABLE "hierarchy_nodes" ADD CONSTRAINT "hierarchy_nodes_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "hierarchy_nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_profiles" ADD CONSTRAINT "communication_profiles_protocol_key_fkey" FOREIGN KEY ("protocol_key") REFERENCES "protocols"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateways" ADD CONSTRAINT "gateways_hierarchy_node_id_fkey" FOREIGN KEY ("hierarchy_node_id") REFERENCES "hierarchy_nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateways" ADD CONSTRAINT "gateways_communication_profile_id_fkey" FOREIGN KEY ("communication_profile_id") REFERENCES "communication_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_hierarchy_node_id_fkey" FOREIGN KEY ("hierarchy_node_id") REFERENCES "hierarchy_nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_gateway_id_fkey" FOREIGN KEY ("gateway_id") REFERENCES "gateways"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_communication_profile_id_fkey" FOREIGN KEY ("communication_profile_id") REFERENCES "communication_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instrument_settings" ADD CONSTRAINT "instrument_settings_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instrument_topics" ADD CONSTRAINT "instrument_topics_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instruments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ltree materialised path. Not in schema.prisma: Prisma maps ltree to
-- Unsupported(), which would make HierarchyNode unselectable in the client.
-- Read/written only via hierarchy.repository.ts.
ALTER TABLE "hierarchy_nodes" ADD COLUMN "path" ltree;
CREATE INDEX "hierarchy_nodes_path_gist_idx" ON "hierarchy_nodes" USING GIST ("path");
CREATE INDEX "hierarchy_nodes_path_btree_idx" ON "hierarchy_nodes" USING BTREE ("path");

-- An instrument must be reachable: either it hangs off a gateway (and inherits
-- that gateway's profile), or it communicates independently and must carry its
-- own profile. Prisma cannot express a conditional NOT NULL.
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_reachable_chk"
  CHECK ("gateway_id" IS NOT NULL OR "communication_profile_id" IS NOT NULL);

-- Seed the protocol registry. All 18 rows ship disabled: P1 ships no protocol
-- adapters, and an enabled protocol with no adapter behind it would be a lie
-- in the UI. OPC-DA is deliberately absent (COM/DCOM, no viable Node
-- implementation).
INSERT INTO "protocols" ("key","name","is_enabled","capabilities") VALUES
  ('mqtt','MQTT',            false, '{"publish":true,"subscribe":true,"poll":false,"write":true}'),
  ('mqtts','MQTT over TLS',  false, '{"publish":true,"subscribe":true,"poll":false,"write":true}'),
  ('http','HTTP',            false, '{"publish":true,"subscribe":false,"poll":true,"write":true}'),
  ('https','HTTPS',          false, '{"publish":true,"subscribe":false,"poll":true,"write":true}'),
  ('websocket','WebSocket',  false, '{"publish":true,"subscribe":true,"poll":false,"write":true}'),
  ('wss','Secure WebSocket', false, '{"publish":true,"subscribe":true,"poll":false,"write":true}'),
  ('tcp','TCP/IP',           false, '{"publish":true,"subscribe":true,"poll":false,"write":true}'),
  ('udp','UDP',              false, '{"publish":true,"subscribe":true,"poll":false,"write":false}'),
  ('serial','Serial Port',   false, '{"publish":true,"subscribe":true,"poll":true,"write":true}'),
  ('modbus-tcp','Modbus TCP',false, '{"publish":false,"subscribe":false,"poll":true,"write":true}'),
  ('modbus-rtu','Modbus RTU',false, '{"publish":false,"subscribe":false,"poll":true,"write":true}'),
  ('opcua','OPC-UA',         false, '{"publish":false,"subscribe":true,"poll":true,"write":true}'),
  ('kafka','Kafka',          false, '{"publish":true,"subscribe":true,"poll":false,"write":false}'),
  ('amqp','AMQP',            false, '{"publish":true,"subscribe":true,"poll":false,"write":false}'),
  ('azure-iot','Azure IoT Hub', false,'{"publish":true,"subscribe":true,"poll":false,"write":true}'),
  ('aws-iot','AWS IoT Core', false, '{"publish":true,"subscribe":true,"poll":false,"write":true}'),
  ('webhook','Webhook',      false, '{"publish":true,"subscribe":false,"poll":false,"write":false}'),
  ('rest','REST API',        false, '{"publish":true,"subscribe":false,"poll":true,"write":true}')
ON CONFLICT ("key") DO NOTHING;
