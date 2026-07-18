-- Baseline migration — full PUBLIC-schema snapshot of digilog_db (2026-06-25).
--
-- This repo historically used 'prisma db push', so the prior migrations/ folder was
-- an incomplete, non-replayable record (replacement_schedules / deviations /
-- quality_notifications and the deviation_number_seq / qnn_seq sequences had no
-- migration at all). This baseline is a pg_dump --schema-only of the live public
-- schema so 'prisma migrate deploy' can rebuild the COMPLETE app schema on a fresh
-- DB, including the triggers, functions, manual sequences and partial unique index
-- that schema.prisma cannot express. Prior migrations archived under
-- prisma/migrations_archive_20260624/. The job-queue schema is created by
-- graphile-worker itself at runtime, so it is intentionally excluded.
--
-- NOTE: 'prisma migrate dev' will report drift against the raw objects (expected);
-- they are managed out-of-band via prisma/sql invariants.

--
-- PostgreSQL database dump
--


-- Dumped from database version 18.3
-- Dumped by pg_dump version 18.3

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;
COMMENT ON SCHEMA public IS '';


--
-- Name: AssigneeType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."AssigneeType" AS ENUM (
    'USER',
    'ROLE'
);


--
-- Name: NotificationChannel; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."NotificationChannel" AS ENUM (
    'EMAIL',
    'SMS',
    'IN_APP',
    'TELEGRAM',
    'WHATSAPP',
    'SLACK'
);


--
-- Name: NotificationDeliveryStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."NotificationDeliveryStatus" AS ENUM (
    'PENDING',
    'SENT',
    'DELIVERED',
    'FAILED',
    'RETRYING'
);


--
-- Name: NotificationEventType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."NotificationEventType" AS ENUM (
    'DEVICE_ONLINE',
    'DEVICE_OFFLINE',
    'DEVICE_INACTIVITY',
    'USER_LOGIN',
    'USER_CREATED',
    'USER_LOCKED',
    'CHECKLIST_SUBMITTED',
    'CHECKLIST_APPROVED',
    'CHECKLIST_REJECTED',
    'SYSTEM_ERROR'
);


--
-- Name: NotificationType; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."NotificationType" AS ENUM (
    'ACCOUNT_LOCKED',
    'ACCOUNT_DISABLED',
    'ACCOUNT_ENABLED',
    'PASSWORD_RESET_REQUEST',
    'PASSWORD_RESET_APPROVED',
    'PASSWORD_RESET_REJECTED',
    'USER_CREATED',
    'USER_UPDATED',
    'ROLE_CHANGED',
    'USER_CREATION_REQUEST_SUBMITTED',
    'USER_CREATION_REQUEST_APPROVED',
    'USER_CREATION_REQUEST_REJECTED',
    'DEVICE_ONLINE',
    'DEVICE_OFFLINE',
    'DEVICE_INACTIVITY',
    'USER_LOGIN',
    'USER_LOCKED',
    'CHECKLIST_SUBMITTED',
    'CHECKLIST_APPROVED',
    'CHECKLIST_REJECTED',
    'SYSTEM_ERROR',
    'PM_OVERDUE',
    'PM_OVERDUE_COMPLETED',
    'PM_SCHEDULE_QNN',
    'GUEST_CLEANING_REQUEST',
    'REPORT_REVIEW_REQUESTED',
    'REPORT_REVIEW_APPROVED',
    'REPORT_REVIEW_REJECTED',
    'STAGE_APPROVAL_REQUESTED',
    'STAGE_APPROVAL_APPROVED',
    'STAGE_APPROVAL_REJECTED'
);


--
-- Name: ReportStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ReportStatus" AS ENUM (
    'DRAFT',
    'PENDING_SIGNATURE',
    'SIGNED',
    'REJECTED',
    'EXPIRED'
);


--
-- Name: ReportTemplateStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."ReportTemplateStatus" AS ENUM (
    'ACTIVE',
    'ARCHIVED',
    'DRAFT'
);


--
-- Name: UserStatus; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public."UserStatus" AS ENUM (
    'ENABLED',
    'DISABLED',
    'LOCKED',
    'EXPIRED'
);


--
-- Name: block_change_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.block_change_status AS ENUM (
    'PENDING',
    'APPROVED',
    'REJECTED',
    'EXPIRED'
);


--
-- Name: block_restriction; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.block_restriction AS ENUM (
    'OWN_BLOCK_ONLY',
    'ANY_BLOCK',
    'SPECIFIC_BLOCKS'
);


--
-- Name: checklist_question_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.checklist_question_type AS ENUM (
    'YES_NO',
    'PASS_FAIL',
    'YES_NO_NA',
    'TEXT',
    'NUMERIC',
    'DROPDOWN',
    'MULTI_SELECT',
    'DATE_TIME',
    'PHOTO',
    'SIGNATURE',
    'CALCULATED',
    'CONDITIONAL'
);


--
-- Name: cleaning_cycle_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.cleaning_cycle_status AS ENUM (
    'IN_PROGRESS',
    'COMPLETED',
    'TERMINATED'
);


--
-- Name: cleaning_profile_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.cleaning_profile_status AS ENUM (
    'DRAFT',
    'ACTIVE',
    'ARCHIVED'
);


--
-- Name: cleaning_stage_approval_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.cleaning_stage_approval_status AS ENUM (
    'PENDING',
    'APPROVED',
    'REJECTED'
);


--
-- Name: deviation_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.deviation_status AS ENUM (
    'OPEN',
    'ACKNOWLEDGED',
    'CLOSED'
);


--
-- Name: filter_event_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.filter_event_type AS ENUM (
    'STATE_TRANSITION',
    'PARAMETER_CAPTURE',
    'CHECKLIST_COMPLETED',
    'BYPASS_DEVIATION',
    'EQUIPMENT_LINKED',
    'REMARK_ADDED',
    'APPROVAL_GRANTED',
    'SCRIPT_EXECUTED',
    'CYCLE_STARTED',
    'CYCLE_COMPLETED',
    'CYCLE_TERMINATED'
);


--
-- Name: filter_set_label; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.filter_set_label AS ENUM (
    'SET_A',
    'SET_B'
);


--
-- Name: pipeline_flow_mode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pipeline_flow_mode AS ENUM (
    'STRICT',
    'BYPASS_ENABLED'
);


--
-- Name: pipeline_node_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pipeline_node_type AS ENUM (
    'STAGE',
    'START',
    'END',
    'CHECKLIST',
    'REMARKS',
    'DURATION_INTERLOCK',
    'PARAM_CAPTURE',
    'CUSTOM_SCRIPT',
    'APPROVAL',
    'EQUIPMENT_LINK'
);


--
-- Name: pm_entry_approval_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pm_entry_approval_status AS ENUM (
    'PENDING',
    'APPROVED',
    'REJECTED',
    'PENDING_REVIEW',
    'PENDING_APPROVAL'
);


--
-- Name: pm_execution_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pm_execution_status AS ENUM (
    'SCHEDULED',
    'IN_PROGRESS',
    'COMPLETED',
    'OVERDUE',
    'MISSED'
);


--
-- Name: pm_schedule_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.pm_schedule_status AS ENUM (
    'DRAFT',
    'ACTIVE',
    'ARCHIVED'
);


--
-- Name: relationship_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.relationship_type_enum AS ENUM (
    'CONTAINS',
    'CONTAINED_IN',
    'CONNECTED_TO',
    'FEEDS',
    'FED_BY',
    'DEPENDS_ON',
    'DEPENDED_ON_BY',
    'BACKS_UP',
    'BACKED_UP_BY',
    'MONITORS',
    'MONITORED_BY',
    'CUSTOM'
);


--
-- Name: replacement_entry_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.replacement_entry_status AS ENUM (
    'PENDING',
    'DUE',
    'IN_PROGRESS',
    'COMPLETED',
    'MISSED'
);


--
-- Name: report_review_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.report_review_status AS ENUM (
    'PENDING_REVIEW',
    'PENDING_APPROVAL',
    'APPROVED',
    'REJECTED'
);


--
-- Name: block_audit_trail_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.block_audit_trail_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'audit_trail rows are immutable. Use the admin delete endpoint which temporarily disables this trigger under audit.'
    USING ERRCODE = 'restrict_violation';
END;
$$;


--
-- Name: check_asset_relationship_pair(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_asset_relationship_pair() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  inv_type relationship_type_enum;
  pair_exists BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    inv_type := inverse_relationship_type(NEW.relationship_type);
    SELECT EXISTS (
      SELECT 1 FROM asset_relationships
      WHERE source_asset_id = NEW.target_asset_id
        AND target_asset_id = NEW.source_asset_id
        AND relationship_type = inv_type
    ) INTO pair_exists;
    IF NOT pair_exists THEN
      RAISE EXCEPTION 'AssetRelationship bidirectional pair invariant violated: (% -> % via %) requires inverse (% -> % via %)',
        NEW.source_asset_id, NEW.target_asset_id, NEW.relationship_type,
        NEW.target_asset_id, NEW.source_asset_id, inv_type
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    inv_type := inverse_relationship_type(OLD.relationship_type);
    SELECT EXISTS (
      SELECT 1 FROM asset_relationships
      WHERE source_asset_id = OLD.target_asset_id
        AND target_asset_id = OLD.source_asset_id
        AND relationship_type = inv_type
    ) INTO pair_exists;
    IF pair_exists THEN
      RAISE EXCEPTION 'Cannot delete AssetRelationship without its inverse pair: (% -> % via %) inverse (% -> % via %) still present',
        OLD.source_asset_id, OLD.target_asset_id, OLD.relationship_type,
        OLD.target_asset_id, OLD.source_asset_id, inv_type
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: check_filter_event_consistency(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_filter_event_consistency() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  cycle_filter_id UUID;
BEGIN
  IF NEW.cycle_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT filter_id INTO cycle_filter_id FROM cleaning_cycles WHERE id = NEW.cycle_id;
  IF cycle_filter_id IS NULL THEN
    RAISE EXCEPTION 'FilterEvent references non-existent cycle %', NEW.cycle_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF cycle_filter_id <> NEW.filter_id THEN
    RAISE EXCEPTION 'FilterEvent.filter_id (%) does not match cycle.filter_id (%) for cycle %',
      NEW.filter_id, cycle_filter_id, NEW.cycle_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: fn_mirror_asset_instance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_mirror_asset_instance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_kind TEXT;
  v_parent_kind TEXT;
  v_block_id UUID;
  v_area_id UUID;
  v_ahu_id UUID;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN COALESCE(NEW, OLD); END IF;

  IF TG_OP = 'DELETE' THEN
    SELECT template_kind INTO v_kind FROM asset_templates WHERE id = OLD.template_id;
    DELETE FROM blocks  WHERE id = OLD.id;
    DELETE FROM areas   WHERE id = OLD.id;
    DELETE FROM ahus    WHERE id = OLD.id;
    DELETE FROM filters WHERE id = OLD.id;
    RETURN OLD;
  END IF;

  SELECT template_kind INTO v_kind FROM asset_templates WHERE id = NEW.template_id;

  IF NEW.parent_id IS NOT NULL THEN
    SELECT t.template_kind INTO v_parent_kind
    FROM asset_instances i
    JOIN asset_templates t ON i.template_id = t.id
    WHERE i.id = NEW.parent_id;
  END IF;

  IF v_kind = 'BLOCK' THEN
    DELETE FROM areas WHERE id = NEW.id;
    DELETE FROM ahus WHERE id = NEW.id;
    DELETE FROM filters WHERE id = NEW.id;
    INSERT INTO blocks (id, name, description, status, attributes, custom_attributes,
                        is_active, created_at, updated_at, created_by, updated_by)
    VALUES (NEW.id, NEW.name, NEW.description, NEW.status, NEW.attributes, NEW.custom_attributes,
            NEW.is_active, NEW.created_at, NEW.updated_at, NEW.created_by, NEW.updated_by)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name, description = EXCLUDED.description, status = EXCLUDED.status,
      attributes = EXCLUDED.attributes, custom_attributes = EXCLUDED.custom_attributes,
      is_active = EXCLUDED.is_active, updated_at = EXCLUDED.updated_at,
      updated_by = EXCLUDED.updated_by;

  ELSIF v_kind = 'AREA' THEN
    DELETE FROM blocks WHERE id = NEW.id;
    DELETE FROM ahus WHERE id = NEW.id;
    DELETE FROM filters WHERE id = NEW.id;
    v_block_id := CASE WHEN v_parent_kind = 'BLOCK' THEN NEW.parent_id ELSE NULL END;
    INSERT INTO areas (id, block_id, name, description, status, attributes, custom_attributes,
                       is_active, created_at, updated_at, created_by, updated_by)
    VALUES (NEW.id, v_block_id, NEW.name, NEW.description, NEW.status, NEW.attributes,
            NEW.custom_attributes, NEW.is_active, NEW.created_at, NEW.updated_at,
            NEW.created_by, NEW.updated_by)
    ON CONFLICT (id) DO UPDATE SET
      block_id = EXCLUDED.block_id, name = EXCLUDED.name, description = EXCLUDED.description,
      status = EXCLUDED.status, attributes = EXCLUDED.attributes,
      custom_attributes = EXCLUDED.custom_attributes, is_active = EXCLUDED.is_active,
      updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;

  ELSIF v_kind = 'AHU' THEN
    DELETE FROM blocks WHERE id = NEW.id;
    DELETE FROM areas WHERE id = NEW.id;
    DELETE FROM filters WHERE id = NEW.id;
    v_area_id := CASE WHEN v_parent_kind = 'AREA' THEN NEW.parent_id ELSE NULL END;
    v_block_id := CASE WHEN v_parent_kind = 'BLOCK' THEN NEW.parent_id ELSE NULL END;
    INSERT INTO ahus (id, area_id, block_id, name, description, status, attributes,
                      custom_attributes, is_active, created_at, updated_at, created_by, updated_by)
    VALUES (NEW.id, v_area_id, v_block_id, NEW.name, NEW.description, NEW.status,
            NEW.attributes, NEW.custom_attributes, NEW.is_active, NEW.created_at,
            NEW.updated_at, NEW.created_by, NEW.updated_by)
    ON CONFLICT (id) DO UPDATE SET
      area_id = EXCLUDED.area_id, block_id = EXCLUDED.block_id, name = EXCLUDED.name,
      description = EXCLUDED.description, status = EXCLUDED.status,
      attributes = EXCLUDED.attributes, custom_attributes = EXCLUDED.custom_attributes,
      is_active = EXCLUDED.is_active, updated_at = EXCLUDED.updated_at,
      updated_by = EXCLUDED.updated_by;

  ELSIF v_kind = 'FILTER' THEN
    DELETE FROM blocks WHERE id = NEW.id;
    DELETE FROM areas WHERE id = NEW.id;
    DELETE FROM ahus WHERE id = NEW.id;
    v_ahu_id := CASE WHEN v_parent_kind = 'AHU' THEN NEW.parent_id ELSE NULL END;
    INSERT INTO filters (id, ahu_id, name, description, status, attributes, custom_attributes,
                         is_active, created_at, updated_at, created_by, updated_by)
    VALUES (NEW.id, v_ahu_id, NEW.name, NEW.description, NEW.status, NEW.attributes,
            NEW.custom_attributes, NEW.is_active, NEW.created_at, NEW.updated_at,
            NEW.created_by, NEW.updated_by)
    ON CONFLICT (id) DO UPDATE SET
      ahu_id = EXCLUDED.ahu_id, name = EXCLUDED.name, description = EXCLUDED.description,
      status = EXCLUDED.status, attributes = EXCLUDED.attributes,
      custom_attributes = EXCLUDED.custom_attributes, is_active = EXCLUDED.is_active,
      updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;

  ELSE
    DELETE FROM blocks WHERE id = NEW.id;
    DELETE FROM areas WHERE id = NEW.id;
    DELETE FROM ahus WHERE id = NEW.id;
    DELETE FROM filters WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: fn_mirror_typed_to_asset_instance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fn_mirror_typed_to_asset_instance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_tmpl UUID;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'DELETE' THEN
    DELETE FROM asset_instances WHERE id = OLD.id;
    RETURN OLD;
  END IF;
  SELECT id INTO v_tmpl FROM asset_templates
    WHERE template_kind = 'FILTER' AND is_active = true
    ORDER BY created_at ASC LIMIT 1;
  IF v_tmpl IS NULL THEN
    RAISE EXCEPTION 'No active FILTER asset_template to mirror filter % into asset_instances', NEW.id;
  END IF;
  INSERT INTO asset_instances
    (id, name, description, template_id, template_version, status, attributes,
     telemetry_config, custom_attributes, parent_id, is_active,
     created_at, updated_at, created_by, updated_by)
  VALUES
    (NEW.id, NEW.name, NEW.description, v_tmpl, 1, NEW.status, NEW.attributes,
     '{}'::jsonb, NEW.custom_attributes, NEW.ahu_id, NEW.is_active,
     NEW.created_at, NEW.updated_at, NEW.created_by, NEW.updated_by)
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name, description = EXCLUDED.description, status = EXCLUDED.status,
    attributes = EXCLUDED.attributes, custom_attributes = EXCLUDED.custom_attributes,
    parent_id = EXCLUDED.parent_id, is_active = EXCLUDED.is_active,
    updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
  RETURN NEW;
END;
$$;


--
-- Name: inverse_relationship_type(public.relationship_type_enum); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.inverse_relationship_type(rt public.relationship_type_enum) RETURNS public.relationship_type_enum
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
  RETURN CASE rt
    WHEN 'CONTAINS' THEN 'CONTAINED_IN'
    WHEN 'CONTAINED_IN' THEN 'CONTAINS'
    WHEN 'CONNECTED_TO' THEN 'CONNECTED_TO'
    WHEN 'FEEDS' THEN 'FED_BY'
    WHEN 'FED_BY' THEN 'FEEDS'
    WHEN 'DEPENDS_ON' THEN 'DEPENDED_ON_BY'
    WHEN 'DEPENDED_ON_BY' THEN 'DEPENDS_ON'
    WHEN 'BACKS_UP' THEN 'BACKED_UP_BY'
    WHEN 'BACKED_UP_BY' THEN 'BACKS_UP'
    WHEN 'MONITORS' THEN 'MONITORED_BY'
    WHEN 'MONITORED_BY' THEN 'MONITORS'
    WHEN 'CUSTOM' THEN 'CUSTOM'
  END::relationship_type_enum;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_type character varying(30) NOT NULL,
    status character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    requester_name character varying(100) NOT NULL,
    requester_employee_id character varying(50),
    requester_email character varying(100),
    request_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    remarks character varying(500),
    admin_remarks character varying(500),
    processed_by character varying(100),
    requested_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    processed_at timestamp with time zone
);


--
-- Name: ahus; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ahus (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    area_id uuid,
    name character varying(255) NOT NULL,
    description text,
    status character varying(50) DEFAULT 'Active'::character varying NOT NULL,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    custom_attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    created_by character varying(50),
    updated_by character varying(50),
    block_id uuid
);


--
-- Name: areas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.areas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    block_id uuid,
    name character varying(255) NOT NULL,
    description text,
    status character varying(50) DEFAULT 'Active'::character varying NOT NULL,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    custom_attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    created_by character varying(50),
    updated_by character varying(50)
);


--
-- Name: asset_identifiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_identifiers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    asset_id uuid NOT NULL,
    identifier_type character varying(20) NOT NULL,
    identifier_value character varying(255) NOT NULL,
    label character varying(100),
    is_primary boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    created_by character varying(50),
    updated_by character varying(50)
);


--
-- Name: asset_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_instances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    template_id uuid NOT NULL,
    template_version integer DEFAULT 1 NOT NULL,
    status character varying(50) DEFAULT 'Active'::character varying NOT NULL,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    telemetry_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    custom_attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    parent_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    created_by character varying(50),
    updated_by character varying(50)
);


--
-- Name: asset_relationships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_relationships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_asset_id uuid NOT NULL,
    target_asset_id uuid NOT NULL,
    relationship_type public.relationship_type_enum NOT NULL,
    custom_label character varying(100),
    notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    created_by character varying(50),
    updated_by character varying(50)
);


--
-- Name: asset_template_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_template_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_id uuid NOT NULL,
    version_number integer NOT NULL,
    snapshot jsonb NOT NULL,
    change_notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by character varying(50)
);


--
-- Name: asset_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(100) NOT NULL,
    description character varying(500),
    category character varying(50) DEFAULT 'General'::character varying NOT NULL,
    icon character varying(50) DEFAULT 'box'::character varying NOT NULL,
    template_kind character varying(50) DEFAULT 'OTHER'::character varying NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    attribute_schema jsonb DEFAULT '[]'::jsonb NOT NULL,
    telemetry_schema jsonb DEFAULT '[]'::jsonb NOT NULL,
    expected_identifiers jsonb DEFAULT '[]'::jsonb NOT NULL,
    expected_relationships jsonb DEFAULT '[]'::jsonb NOT NULL,
    status_lifecycle jsonb DEFAULT '[]'::jsonb NOT NULL,
    checklist_schema jsonb DEFAULT '[]'::jsonb NOT NULL,
    max_parent_connections integer DEFAULT 1 NOT NULL,
    max_connections integer DEFAULT 10 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    created_by character varying(50),
    updated_by character varying(50),
    data_ingestion_enabled boolean DEFAULT false NOT NULL,
    transport_type character varying(20),
    credential_type character varying(20) DEFAULT 'TOKEN'::character varying,
    inactivity_timeout integer DEFAULT 60 NOT NULL,
    default_max_data_rate integer DEFAULT 600 NOT NULL,
    auto_provision boolean DEFAULT true NOT NULL
);


--
-- Name: audit_trail; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_trail (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "timestamp" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    user_id character varying(100),
    user_name character varying(100),
    user_role character varying(20),
    action character varying(100) NOT NULL,
    target_type character varying(50),
    target_id character varying(255),
    before_value jsonb,
    after_value jsonb,
    reason text,
    ip_address character varying(45),
    user_agent text,
    session_id character varying(100),
    checksum character varying(64) NOT NULL,
    signature_meaning character varying(255),
    previous_checksum character varying(64),
    chain_position bigint,
    redacted_at timestamp with time zone,
    redacted_by character varying(100),
    redaction_reason text
);


--
-- Name: audit_trail_chain_position_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_trail_chain_position_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_trail_chain_position_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_trail_chain_position_seq OWNED BY public.audit_trail.chain_position;


--
-- Name: block_change_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.block_change_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    filter_id uuid NOT NULL,
    filter_name character varying(255) NOT NULL,
    from_block_id uuid NOT NULL,
    from_block_name character varying(255) NOT NULL,
    to_block_id uuid NOT NULL,
    to_block_name character varying(255) NOT NULL,
    reason text,
    status public.block_change_status DEFAULT 'PENDING'::public.block_change_status NOT NULL,
    requested_by uuid NOT NULL,
    requested_by_name character varying(255) NOT NULL,
    processed_by uuid,
    processed_by_name character varying(255),
    processed_comment text,
    processed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    status character varying(50) DEFAULT 'Active'::character varying NOT NULL,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    custom_attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    created_by character varying(50),
    updated_by character varying(50)
);


--
-- Name: checklist_profile_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.checklist_profile_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    version_number integer NOT NULL,
    snapshot jsonb NOT NULL,
    change_notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by uuid
);


--
-- Name: checklist_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.checklist_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    version integer DEFAULT 1 NOT NULL
);


--
-- Name: checklist_questions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.checklist_questions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    question text NOT NULL,
    question_type public.checklist_question_type DEFAULT 'YES_NO'::public.checklist_question_type NOT NULL,
    required boolean DEFAULT false NOT NULL,
    section character varying(255),
    description text,
    options jsonb DEFAULT '[]'::jsonb NOT NULL,
    validation jsonb DEFAULT '{}'::jsonb NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: checklist_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.checklist_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    checklist_id character varying(255) NOT NULL,
    entity_id uuid NOT NULL,
    template_id uuid NOT NULL,
    current_step character varying(30) DEFAULT 'SUBMITTED'::character varying NOT NULL,
    current_sequence integer DEFAULT 1 NOT NULL,
    performed_by character varying(50) NOT NULL,
    performed_at timestamp with time zone NOT NULL,
    performed_signature_id uuid,
    checked_by character varying(50),
    checked_at timestamp with time zone,
    checked_remarks text,
    checked_signature_id uuid,
    verified_by character varying(50),
    verified_at timestamp with time zone,
    verified_remarks text,
    verified_signature_id uuid,
    rejected_by character varying(50),
    rejected_at timestamp with time zone,
    rejection_reason text,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: cleaning_cycles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cleaning_cycles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cycle_code character varying(100) NOT NULL,
    filter_id uuid NOT NULL,
    profile_id uuid NOT NULL,
    profile_version integer NOT NULL,
    sequence_number integer NOT NULL,
    status public.cleaning_cycle_status DEFAULT 'IN_PROGRESS'::public.cleaning_cycle_status NOT NULL,
    started_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    completed_at timestamp with time zone,
    terminated_at timestamp with time zone,
    termination_reason text,
    cleaning_area_id uuid,
    pm_execution_id uuid,
    cleaning_reason_key character varying(100) NOT NULL,
    cleaning_reason_label character varying(255) NOT NULL,
    cleaning_justification text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    equipment_group_id uuid,
    dryer_duration_minutes integer,
    dryer_started_at timestamp with time zone,
    dryer_readings_submitted boolean DEFAULT false NOT NULL,
    checklist_version_pins jsonb DEFAULT '{}'::jsonb NOT NULL,
    equipment_group_version_pin integer
);


--
-- Name: cleaning_stage_approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cleaning_stage_approvals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cycle_id uuid NOT NULL,
    filter_id uuid NOT NULL,
    stage_key character varying(40) NOT NULL,
    status public.cleaning_stage_approval_status DEFAULT 'PENDING'::public.cleaning_stage_approval_status NOT NULL,
    approver_role character varying(50) NOT NULL,
    reject_to_state_key character varying(40) NOT NULL,
    attempt_seq integer DEFAULT 1 NOT NULL,
    details_snapshot jsonb NOT NULL,
    requested_by uuid NOT NULL,
    requested_by_name character varying(255) NOT NULL,
    requested_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    decided_by uuid,
    decided_by_name character varying(255),
    decided_at timestamp with time zone,
    decision_remarks text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: dashboard_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dashboard_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    dashboard_id uuid NOT NULL,
    assignee_type public."AssigneeType" NOT NULL,
    user_id uuid,
    role_value character varying(50),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: dashboard_widgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dashboard_widgets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    dashboard_id uuid NOT NULL,
    widget_type character varying(50) NOT NULL,
    title character varying(200) NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    "position" jsonb DEFAULT '{"h": 3, "w": 4, "x": 0, "y": 0}'::jsonb NOT NULL,
    data_source jsonb DEFAULT '{}'::jsonb NOT NULL,
    refresh_interval integer DEFAULT 30 NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: dashboards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dashboards (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title character varying(200) NOT NULL,
    description character varying(500),
    layout jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    created_by uuid
);


--
-- Name: deviation_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.deviation_number_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: deviations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deviations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deviation_number character varying(40) DEFAULT ('DEV-'::text || lpad((nextval('public.deviation_number_seq'::regclass))::text, 6, '0'::text)) NOT NULL,
    pm_schedule_entry_id uuid NOT NULL,
    ahu_id uuid NOT NULL,
    ahu_name character varying(255) NOT NULL,
    filter_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    filter_count integer DEFAULT 0 NOT NULL,
    scheduled_date date NOT NULL,
    window_end date NOT NULL,
    overdue_days_at_open integer NOT NULL,
    assigned_user_id uuid,
    status public.deviation_status DEFAULT 'OPEN'::public.deviation_status NOT NULL,
    acknowledged_by uuid,
    acknowledged_by_name character varying(255),
    acknowledged_at timestamp with time zone,
    password_verified boolean DEFAULT false NOT NULL,
    notified_at timestamp with time zone,
    completed_by uuid,
    completed_by_name character varying(255),
    completed_at timestamp with time zone,
    delay_days integer,
    closed_at timestamp with time zone,
    completion_notified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    window_start date
);


--
-- Name: electronic_signatures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.electronic_signatures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    record_type character varying(30) NOT NULL,
    record_id text NOT NULL,
    signer_user_id character varying(50) NOT NULL,
    signer_full_name character varying(100) NOT NULL,
    signer_role character varying(50) NOT NULL,
    signed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    meaning character varying(100) NOT NULL,
    record_hash character varying(64) NOT NULL,
    signature_hash character varying(64) NOT NULL,
    re_auth_verified boolean DEFAULT true NOT NULL,
    re_auth_method character varying(20) DEFAULT 'password'::character varying NOT NULL,
    signature_image text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: entity_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_id uuid NOT NULL,
    assignee_type public."AssigneeType" NOT NULL,
    user_id uuid,
    role_value character varying(50),
    permissions jsonb DEFAULT '{"view": true, "control": false, "configure": false}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by character varying(50)
);


--
-- Name: equipment_group_instruments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_group_instruments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    description character varying(255) NOT NULL,
    stage_key character varying(100) NOT NULL,
    serial_number character varying(100) NOT NULL,
    instrument_id character varying(100) NOT NULL,
    uom character varying(50) NOT NULL,
    instrument_min double precision NOT NULL,
    instrument_max double precision NOT NULL,
    operating_min double precision NOT NULL,
    operating_max double precision NOT NULL,
    least_count double precision NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    auto_fetch_enabled boolean DEFAULT false NOT NULL,
    response_key character varying(100)
);


--
-- Name: equipment_group_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_group_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    version_number integer NOT NULL,
    snapshot jsonb NOT NULL,
    change_notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by uuid
);


--
-- Name: equipment_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipment_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    block_id uuid NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    reading_url character varying(2048)
);


--
-- Name: field_id_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.field_id_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    field_id character varying(50) NOT NULL,
    default_name character varying(100) NOT NULL,
    display_name character varying(100) NOT NULL,
    module character varying(50) NOT NULL,
    description text,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_by character varying(50)
);


--
-- Name: filter_cleaning_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.filter_cleaning_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    flow_mode public.pipeline_flow_mode DEFAULT 'STRICT'::public.pipeline_flow_mode NOT NULL,
    alarm_on_forward_skip boolean DEFAULT true NOT NULL,
    alarm_on_backward_jump boolean DEFAULT true NOT NULL,
    alarm_on_out_of_sequence boolean DEFAULT true NOT NULL,
    cleaning_reasons jsonb,
    version integer DEFAULT 1 NOT NULL,
    status public.cleaning_profile_status DEFAULT 'DRAFT'::public.cleaning_profile_status NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    lineage_id uuid NOT NULL
);


--
-- Name: filter_details; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.filter_details (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    asset_instance_id uuid NOT NULL,
    filter_profile_id uuid,
    current_lifecycle_state character varying(100),
    current_cycle_id uuid,
    filter_set public.filter_set_label,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: filter_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.filter_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    filter_id uuid NOT NULL,
    cycle_id uuid,
    event_type public.filter_event_type NOT NULL,
    from_state character varying(100),
    to_state character varying(100),
    performed_by uuid NOT NULL,
    performed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    cleaning_area_id uuid,
    equipment_id uuid,
    block_id uuid,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    telemetry_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    remarks text,
    deviation_details jsonb,
    checksum character varying(64) NOT NULL,
    ip_address character varying(45) NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: filter_pipeline_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.filter_pipeline_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    from_stage_id uuid NOT NULL,
    to_stage_id uuid NOT NULL,
    label character varying(100) DEFAULT 'Next'::character varying
);


--
-- Name: filter_pipeline_stages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.filter_pipeline_stages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    state_key character varying(100),
    node_type public.pipeline_node_type NOT NULL,
    configuration jsonb DEFAULT '{}'::jsonb NOT NULL,
    position_x double precision DEFAULT 0 NOT NULL,
    position_y double precision DEFAULT 0 NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: filter_profile_applicable_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.filter_profile_applicable_templates (
    profile_id uuid NOT NULL,
    template_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: filter_profile_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.filter_profile_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    profile_id uuid NOT NULL,
    version_number integer NOT NULL,
    snapshot jsonb NOT NULL,
    change_notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by uuid
);


--
-- Name: filter_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.filter_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    cleaning_profile_id uuid NOT NULL,
    default_pm_schedule_id uuid,
    block_restriction public.block_restriction DEFAULT 'OWN_BLOCK_ONLY'::public.block_restriction NOT NULL,
    allowed_blocks jsonb,
    max_cleaning_cycles integer,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    version integer DEFAULT 1 NOT NULL
);


--
-- Name: filters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.filters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ahu_id uuid,
    name character varying(255) NOT NULL,
    description text,
    status character varying(50) DEFAULT 'Active'::character varying NOT NULL,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    custom_attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    created_by character varying(50),
    updated_by character varying(50)
);


--
-- Name: help_article_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.help_article_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    help_article_id uuid NOT NULL,
    version integer NOT NULL,
    content text NOT NULL,
    changed_by character varying(50) NOT NULL,
    change_notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: help_articles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.help_articles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key character varying(100) NOT NULL,
    title character varying(200) NOT NULL,
    content text NOT NULL,
    category character varying(50) NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    current_version integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: latest_telemetry; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.latest_telemetry (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_id uuid NOT NULL,
    key character varying(200) NOT NULL,
    value_num double precision,
    value_str text,
    value_bool boolean,
    value_json jsonb,
    last_updated timestamp with time zone NOT NULL
);


--
-- Name: notification_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel public."NotificationChannel" NOT NULL,
    recipient character varying(500) NOT NULL,
    subject character varying(500),
    message text NOT NULL,
    template_id character varying(100),
    status public."NotificationDeliveryStatus" DEFAULT 'PENDING'::public."NotificationDeliveryStatus" NOT NULL,
    retry_count integer DEFAULT 0 NOT NULL,
    max_retries integer DEFAULT 3 NOT NULL,
    next_retry_at timestamp with time zone,
    error_message text,
    metadata jsonb,
    triggered_by character varying(100),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    sent_at timestamp with time zone
);


--
-- Name: notification_rule_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_rule_recipients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rule_id uuid NOT NULL,
    recipient_type character varying(20) NOT NULL,
    role_value character varying(50),
    group_id uuid,
    user_id uuid
);


--
-- Name: notification_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(200) NOT NULL,
    description character varying(500),
    event_type public."NotificationEventType" NOT NULL,
    event_types public."NotificationEventType"[] DEFAULT ARRAY[]::public."NotificationEventType"[],
    conditions jsonb DEFAULT '{}'::jsonb NOT NULL,
    email_enabled boolean DEFAULT false NOT NULL,
    sms_enabled boolean DEFAULT false NOT NULL,
    in_app_enabled boolean DEFAULT true NOT NULL,
    email_template_id uuid,
    sms_template_id uuid,
    cooldown_minutes integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    created_by character varying(50)
);


--
-- Name: notification_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(100) NOT NULL,
    channel public."NotificationChannel" NOT NULL,
    subject character varying(500),
    body_template text NOT NULL,
    description character varying(500),
    variables jsonb,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    created_by character varying(50)
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type public."NotificationType" NOT NULL,
    title character varying(200) NOT NULL,
    message character varying(1000) NOT NULL,
    target_user_id character varying(50),
    for_user_id character varying(50),
    for_role character varying(50),
    is_read boolean DEFAULT false NOT NULL,
    read_at timestamp with time zone,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by character varying(50)
);


--
-- Name: password_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    password_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: password_reset_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    status character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    requested_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    processed_at timestamp with time zone,
    processed_by character varying(50),
    notes text
);


--
-- Name: pm_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pm_executions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    schedule_entry_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    status public.pm_execution_status DEFAULT 'SCHEDULED'::public.pm_execution_status NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    performed_by uuid,
    is_within_window boolean DEFAULT true NOT NULL,
    filter_set public.filter_set_label,
    notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: pm_schedule_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pm_schedule_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    schedule_id uuid NOT NULL,
    month integer NOT NULL,
    planned_date date NOT NULL,
    tolerance_days integer DEFAULT 0 NOT NULL,
    window_start date NOT NULL,
    window_end date NOT NULL,
    notes text,
    approval_status public.pm_entry_approval_status DEFAULT 'PENDING'::public.pm_entry_approval_status NOT NULL,
    approval_remarks text,
    approved_by uuid,
    approved_by_name character varying(255),
    approved_at timestamp with time zone,
    submitted_by uuid,
    submitted_by_name character varying(255),
    pending_planned_date date,
    pending_tolerance_days integer,
    pending_edit_by uuid,
    pending_edit_at timestamp with time zone,
    reviewed_by uuid,
    reviewed_by_name character varying(255),
    reviewed_at timestamp with time zone,
    review_remarks text,
    rejected_by uuid,
    rejected_by_name character varying(255),
    rejected_at timestamp with time zone,
    rejection_stage character varying(20)
);


--
-- Name: pm_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pm_schedules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_id uuid NOT NULL,
    year integer NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    status public.pm_schedule_status DEFAULT 'DRAFT'::public.pm_schedule_status NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: qnn_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.qnn_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: qr_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.qr_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_id uuid NOT NULL,
    qr_data text NOT NULL,
    image_path text NOT NULL,
    svg_data text,
    size character varying(10) DEFAULT 'MEDIUM'::character varying NOT NULL,
    include_label boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: quality_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quality_notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    qnn character varying(40) NOT NULL,
    action character varying(40) NOT NULL,
    pm_schedule_entry_id uuid,
    schedule_id uuid,
    ahu_name character varying(255),
    message character varying(1000),
    performed_by uuid,
    performed_by_name character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: replacement_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.replacement_executions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entry_id uuid NOT NULL,
    old_filter_id uuid NOT NULL,
    new_filter_id uuid,
    performed_by uuid NOT NULL,
    performed_by_name character varying(255),
    is_within_window boolean DEFAULT true NOT NULL,
    remarks text,
    performed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: replacement_schedule_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.replacement_schedule_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    schedule_id uuid NOT NULL,
    sl_no integer,
    ahu_id uuid NOT NULL,
    ahu_name character varying(255) NOT NULL,
    filter_micron character varying(100),
    filter_size character varying(100),
    qty integer NOT NULL,
    qty_replaced integer DEFAULT 0 NOT NULL,
    schedule_date date NOT NULL,
    tolerance_days integer DEFAULT 0 NOT NULL,
    window_start date NOT NULL,
    window_end date NOT NULL,
    status public.replacement_entry_status DEFAULT 'PENDING'::public.replacement_entry_status NOT NULL,
    notes text,
    approval_status public.pm_entry_approval_status DEFAULT 'APPROVED'::public.pm_entry_approval_status NOT NULL,
    approval_remarks text,
    submitted_by uuid,
    submitted_by_name character varying(255),
    reviewed_by uuid,
    reviewed_by_name character varying(255),
    reviewed_at timestamp with time zone,
    review_remarks text,
    approved_by uuid,
    approved_by_name character varying(255),
    approved_at timestamp with time zone,
    rejected_by uuid,
    rejected_by_name character varying(255),
    rejected_at timestamp with time zone,
    rejection_stage character varying(20)
);


--
-- Name: replacement_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.replacement_schedules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    file_name character varying(255),
    status character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    notes text,
    uploaded_by uuid NOT NULL,
    uploaded_by_name character varying(255),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: report_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_instances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_id uuid NOT NULL,
    template_version integer NOT NULL,
    name character varying(500) NOT NULL,
    status public."ReportStatus" DEFAULT 'DRAFT'::public."ReportStatus" NOT NULL,
    time_range_start timestamp with time zone,
    time_range_end timestamp with time zone,
    entity_slots jsonb,
    resolved_data jsonb,
    pdf_path character varying(1000),
    pdf_size integer,
    page_count integer,
    generated_by uuid NOT NULL,
    generated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    signed_at timestamp with time zone,
    expires_at timestamp with time zone
);


--
-- Name: report_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    report_type character varying(100) NOT NULL,
    title character varying(500) NOT NULL,
    subtitle character varying(1000),
    data_snapshot jsonb NOT NULL,
    status public.report_review_status DEFAULT 'PENDING_REVIEW'::public.report_review_status NOT NULL,
    generated_by uuid NOT NULL,
    generated_by_name character varying(255) NOT NULL,
    generated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    assignee_user_id uuid,
    assignee_role character varying(50),
    reviewed_by uuid,
    reviewed_by_name character varying(255),
    reviewed_at timestamp with time zone,
    review_remarks text,
    approved_by uuid,
    approved_by_name character varying(255),
    approved_at timestamp with time zone,
    approval_remarks text,
    rejection_stage character varying(20),
    rejected_by uuid,
    rejected_by_name character varying(255),
    rejected_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: report_signatures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_signatures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    report_id uuid NOT NULL,
    signer_role character varying(50) NOT NULL,
    signer_label character varying(100) NOT NULL,
    user_id uuid NOT NULL,
    meaning character varying(500) NOT NULL,
    signed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ip_address character varying(45),
    user_agent character varying(500)
);


--
-- Name: report_template_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_template_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_id uuid NOT NULL,
    version integer NOT NULL,
    config jsonb NOT NULL,
    changelog text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: report_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(200) NOT NULL,
    description character varying(2000),
    status public."ReportTemplateStatus" DEFAULT 'ACTIVE'::public."ReportTemplateStatus" NOT NULL,
    current_version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: role_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    role character varying(50) NOT NULL,
    sidebar_items jsonb DEFAULT '[]'::jsonb NOT NULL,
    home_widgets jsonb DEFAULT '[]'::jsonb NOT NULL,
    permissions jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_by character varying(50)
);


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(50) NOT NULL,
    display_name character varying(100) NOT NULL,
    description character varying(500),
    hierarchy_level integer NOT NULL,
    permissions jsonb DEFAULT '[]'::jsonb NOT NULL,
    color character varying(100) DEFAULT '#6366f1'::character varying NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    created_by character varying(50),
    updated_by character varying(50)
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    ip_address character varying(45),
    user_agent text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_active_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    termination_reason character varying(50)
);


--
-- Name: system_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    config_key character varying(100) NOT NULL,
    config_value jsonb NOT NULL,
    config_type character varying(50) NOT NULL,
    requires_reauth boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_by character varying(50)
);


--
-- Name: template_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.template_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_id uuid NOT NULL,
    assignee_type public."AssigneeType" NOT NULL,
    user_id uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_by character varying(50)
);


--
-- Name: template_kinds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.template_kinds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code character varying(50) NOT NULL,
    label character varying(100) NOT NULL,
    description character varying(500),
    is_system boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    created_by character varying(50),
    updated_by character varying(50)
);


--
-- Name: user_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    sidebar_items jsonb DEFAULT '[]'::jsonb NOT NULL,
    home_widgets jsonb DEFAULT '[]'::jsonb NOT NULL,
    permissions jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_by character varying(50)
);


--
-- Name: user_group_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_group_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: user_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name character varying(100) NOT NULL,
    description character varying(500),
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    created_by character varying(50)
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    username character varying(50) NOT NULL,
    full_name character varying(100) NOT NULL,
    email character varying(100),
    password_hash text NOT NULL,
    department character varying(50),
    photo_url character varying(500),
    role character varying(50) NOT NULL,
    status public."UserStatus" DEFAULT 'ENABLED'::public."UserStatus" NOT NULL,
    failed_login_attempts integer DEFAULT 0 NOT NULL,
    locked_at timestamp with time zone,
    lockout_until timestamp with time zone,
    password_changed_at timestamp with time zone,
    password_expires_at timestamp with time zone,
    force_password_change boolean DEFAULT true NOT NULL,
    is_temporary_password boolean DEFAULT true NOT NULL,
    auth_source character varying(10) DEFAULT 'local'::character varying NOT NULL,
    ldap_dn text,
    last_login timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    created_by character varying(50),
    updated_by character varying(50)
);


--
-- Name: audit_trail chain_position; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_trail ALTER COLUMN chain_position SET DEFAULT nextval('public.audit_trail_chain_position_seq'::regclass);


--
-- Name: admin_requests admin_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_requests
    ADD CONSTRAINT admin_requests_pkey PRIMARY KEY (id);


--
-- Name: ahus ahus_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ahus
    ADD CONSTRAINT ahus_pkey PRIMARY KEY (id);


--
-- Name: areas areas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.areas
    ADD CONSTRAINT areas_pkey PRIMARY KEY (id);


--
-- Name: asset_identifiers asset_identifiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_identifiers
    ADD CONSTRAINT asset_identifiers_pkey PRIMARY KEY (id);


--
-- Name: asset_instances asset_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_instances
    ADD CONSTRAINT asset_instances_pkey PRIMARY KEY (id);


--
-- Name: asset_relationships asset_relationships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_relationships
    ADD CONSTRAINT asset_relationships_pkey PRIMARY KEY (id);


--
-- Name: asset_template_versions asset_template_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_template_versions
    ADD CONSTRAINT asset_template_versions_pkey PRIMARY KEY (id);


--
-- Name: asset_templates asset_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_templates
    ADD CONSTRAINT asset_templates_pkey PRIMARY KEY (id);


--
-- Name: audit_trail audit_trail_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_trail
    ADD CONSTRAINT audit_trail_pkey PRIMARY KEY (id);


--
-- Name: block_change_requests block_change_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.block_change_requests
    ADD CONSTRAINT block_change_requests_pkey PRIMARY KEY (id);


--
-- Name: blocks blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocks
    ADD CONSTRAINT blocks_pkey PRIMARY KEY (id);


--
-- Name: checklist_profile_versions checklist_profile_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checklist_profile_versions
    ADD CONSTRAINT checklist_profile_versions_pkey PRIMARY KEY (id);


--
-- Name: checklist_profiles checklist_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checklist_profiles
    ADD CONSTRAINT checklist_profiles_pkey PRIMARY KEY (id);


--
-- Name: checklist_questions checklist_questions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checklist_questions
    ADD CONSTRAINT checklist_questions_pkey PRIMARY KEY (id);


--
-- Name: checklist_reviews checklist_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checklist_reviews
    ADD CONSTRAINT checklist_reviews_pkey PRIMARY KEY (id);


--
-- Name: cleaning_cycles cleaning_cycles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleaning_cycles
    ADD CONSTRAINT cleaning_cycles_pkey PRIMARY KEY (id);


--
-- Name: cleaning_stage_approvals cleaning_stage_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleaning_stage_approvals
    ADD CONSTRAINT cleaning_stage_approvals_pkey PRIMARY KEY (id);


--
-- Name: dashboard_assignments dashboard_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_assignments
    ADD CONSTRAINT dashboard_assignments_pkey PRIMARY KEY (id);


--
-- Name: dashboard_widgets dashboard_widgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_widgets
    ADD CONSTRAINT dashboard_widgets_pkey PRIMARY KEY (id);


--
-- Name: dashboards dashboards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboards
    ADD CONSTRAINT dashboards_pkey PRIMARY KEY (id);


--
-- Name: deviations deviations_deviation_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deviations
    ADD CONSTRAINT deviations_deviation_number_key UNIQUE (deviation_number);


--
-- Name: deviations deviations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deviations
    ADD CONSTRAINT deviations_pkey PRIMARY KEY (id);


--
-- Name: deviations deviations_pm_schedule_entry_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deviations
    ADD CONSTRAINT deviations_pm_schedule_entry_id_key UNIQUE (pm_schedule_entry_id);


--
-- Name: electronic_signatures electronic_signatures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.electronic_signatures
    ADD CONSTRAINT electronic_signatures_pkey PRIMARY KEY (id);


--
-- Name: entity_assignments entity_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_assignments
    ADD CONSTRAINT entity_assignments_pkey PRIMARY KEY (id);


--
-- Name: equipment_group_instruments equipment_group_instruments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_group_instruments
    ADD CONSTRAINT equipment_group_instruments_pkey PRIMARY KEY (id);


--
-- Name: equipment_group_versions equipment_group_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_group_versions
    ADD CONSTRAINT equipment_group_versions_pkey PRIMARY KEY (id);


--
-- Name: equipment_groups equipment_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_groups
    ADD CONSTRAINT equipment_groups_pkey PRIMARY KEY (id);


--
-- Name: field_id_config field_id_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.field_id_config
    ADD CONSTRAINT field_id_config_pkey PRIMARY KEY (id);


--
-- Name: filter_cleaning_profiles filter_cleaning_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_cleaning_profiles
    ADD CONSTRAINT filter_cleaning_profiles_pkey PRIMARY KEY (id);


--
-- Name: filter_details filter_details_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_details
    ADD CONSTRAINT filter_details_pkey PRIMARY KEY (id);


--
-- Name: filter_events filter_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_events
    ADD CONSTRAINT filter_events_pkey PRIMARY KEY (id);


--
-- Name: filter_pipeline_connections filter_pipeline_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_pipeline_connections
    ADD CONSTRAINT filter_pipeline_connections_pkey PRIMARY KEY (id);


--
-- Name: filter_pipeline_stages filter_pipeline_stages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_pipeline_stages
    ADD CONSTRAINT filter_pipeline_stages_pkey PRIMARY KEY (id);


--
-- Name: filter_profile_applicable_templates filter_profile_applicable_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_profile_applicable_templates
    ADD CONSTRAINT filter_profile_applicable_templates_pkey PRIMARY KEY (profile_id, template_id);


--
-- Name: filter_profile_versions filter_profile_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_profile_versions
    ADD CONSTRAINT filter_profile_versions_pkey PRIMARY KEY (id);


--
-- Name: filter_profiles filter_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_profiles
    ADD CONSTRAINT filter_profiles_pkey PRIMARY KEY (id);


--
-- Name: filters filters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filters
    ADD CONSTRAINT filters_pkey PRIMARY KEY (id);


--
-- Name: help_article_versions help_article_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.help_article_versions
    ADD CONSTRAINT help_article_versions_pkey PRIMARY KEY (id);


--
-- Name: help_articles help_articles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.help_articles
    ADD CONSTRAINT help_articles_pkey PRIMARY KEY (id);


--
-- Name: latest_telemetry latest_telemetry_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.latest_telemetry
    ADD CONSTRAINT latest_telemetry_pkey PRIMARY KEY (id);


--
-- Name: notification_logs notification_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_logs
    ADD CONSTRAINT notification_logs_pkey PRIMARY KEY (id);


--
-- Name: notification_rule_recipients notification_rule_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_rule_recipients
    ADD CONSTRAINT notification_rule_recipients_pkey PRIMARY KEY (id);


--
-- Name: notification_rules notification_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_rules
    ADD CONSTRAINT notification_rules_pkey PRIMARY KEY (id);


--
-- Name: notification_templates notification_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_templates
    ADD CONSTRAINT notification_templates_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: password_history password_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_history
    ADD CONSTRAINT password_history_pkey PRIMARY KEY (id);


--
-- Name: password_reset_requests password_reset_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_requests
    ADD CONSTRAINT password_reset_requests_pkey PRIMARY KEY (id);


--
-- Name: pm_executions pm_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pm_executions
    ADD CONSTRAINT pm_executions_pkey PRIMARY KEY (id);


--
-- Name: pm_schedule_entries pm_schedule_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pm_schedule_entries
    ADD CONSTRAINT pm_schedule_entries_pkey PRIMARY KEY (id);


--
-- Name: pm_schedules pm_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pm_schedules
    ADD CONSTRAINT pm_schedules_pkey PRIMARY KEY (id);


--
-- Name: qr_codes qr_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.qr_codes
    ADD CONSTRAINT qr_codes_pkey PRIMARY KEY (id);


--
-- Name: quality_notifications quality_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quality_notifications
    ADD CONSTRAINT quality_notifications_pkey PRIMARY KEY (id);


--
-- Name: quality_notifications quality_notifications_qnn_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quality_notifications
    ADD CONSTRAINT quality_notifications_qnn_key UNIQUE (qnn);


--
-- Name: replacement_executions replacement_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replacement_executions
    ADD CONSTRAINT replacement_executions_pkey PRIMARY KEY (id);


--
-- Name: replacement_schedule_entries replacement_schedule_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replacement_schedule_entries
    ADD CONSTRAINT replacement_schedule_entries_pkey PRIMARY KEY (id);


--
-- Name: replacement_schedules replacement_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replacement_schedules
    ADD CONSTRAINT replacement_schedules_pkey PRIMARY KEY (id);


--
-- Name: report_instances report_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_instances
    ADD CONSTRAINT report_instances_pkey PRIMARY KEY (id);


--
-- Name: report_reviews report_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_reviews
    ADD CONSTRAINT report_reviews_pkey PRIMARY KEY (id);


--
-- Name: report_signatures report_signatures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_signatures
    ADD CONSTRAINT report_signatures_pkey PRIMARY KEY (id);


--
-- Name: report_template_versions report_template_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_template_versions
    ADD CONSTRAINT report_template_versions_pkey PRIMARY KEY (id);


--
-- Name: report_templates report_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_templates
    ADD CONSTRAINT report_templates_pkey PRIMARY KEY (id);


--
-- Name: role_configs role_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_configs
    ADD CONSTRAINT role_configs_pkey PRIMARY KEY (id);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: system_config system_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_config
    ADD CONSTRAINT system_config_pkey PRIMARY KEY (id);


--
-- Name: template_assignments template_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_assignments
    ADD CONSTRAINT template_assignments_pkey PRIMARY KEY (id);


--
-- Name: template_kinds template_kinds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_kinds
    ADD CONSTRAINT template_kinds_pkey PRIMARY KEY (id);


--
-- Name: user_configs user_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_configs
    ADD CONSTRAINT user_configs_pkey PRIMARY KEY (id);


--
-- Name: user_group_members user_group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_members
    ADD CONSTRAINT user_group_members_pkey PRIMARY KEY (id);


--
-- Name: user_groups user_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_groups
    ADD CONSTRAINT user_groups_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: admin_requests_request_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_requests_request_type_idx ON public.admin_requests USING btree (request_type);


--
-- Name: admin_requests_requested_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_requests_requested_at_idx ON public.admin_requests USING btree (requested_at DESC);


--
-- Name: admin_requests_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_requests_status_idx ON public.admin_requests USING btree (status);


--
-- Name: ahus_area_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ahus_area_id_idx ON public.ahus USING btree (area_id);


--
-- Name: ahus_block_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ahus_block_id_idx ON public.ahus USING btree (block_id);


--
-- Name: ahus_is_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ahus_is_active_idx ON public.ahus USING btree (is_active);


--
-- Name: ahus_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ahus_name_idx ON public.ahus USING btree (name);


--
-- Name: ahus_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ahus_status_idx ON public.ahus USING btree (status);


--
-- Name: areas_block_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX areas_block_id_idx ON public.areas USING btree (block_id);


--
-- Name: areas_is_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX areas_is_active_idx ON public.areas USING btree (is_active);


--
-- Name: areas_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX areas_name_idx ON public.areas USING btree (name);


--
-- Name: areas_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX areas_status_idx ON public.areas USING btree (status);


--
-- Name: asset_identifiers_asset_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_identifiers_asset_id_idx ON public.asset_identifiers USING btree (asset_id);


--
-- Name: asset_identifiers_identifier_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_identifiers_identifier_type_idx ON public.asset_identifiers USING btree (identifier_type);


--
-- Name: asset_identifiers_identifier_value_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX asset_identifiers_identifier_value_key ON public.asset_identifiers USING btree (identifier_value);


--
-- Name: asset_instances_is_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_instances_is_active_idx ON public.asset_instances USING btree (is_active);


--
-- Name: asset_instances_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_instances_name_idx ON public.asset_instances USING btree (name);


--
-- Name: asset_instances_parent_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_instances_parent_id_idx ON public.asset_instances USING btree (parent_id);


--
-- Name: asset_instances_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_instances_status_idx ON public.asset_instances USING btree (status);


--
-- Name: asset_instances_template_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_instances_template_id_idx ON public.asset_instances USING btree (template_id);


--
-- Name: asset_relationships_relationship_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_relationships_relationship_type_idx ON public.asset_relationships USING btree (relationship_type);


--
-- Name: asset_relationships_source_asset_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_relationships_source_asset_id_idx ON public.asset_relationships USING btree (source_asset_id);


--
-- Name: asset_relationships_source_asset_id_target_asset_id_relatio_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX asset_relationships_source_asset_id_target_asset_id_relatio_key ON public.asset_relationships USING btree (source_asset_id, target_asset_id, relationship_type);


--
-- Name: asset_relationships_target_asset_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_relationships_target_asset_id_idx ON public.asset_relationships USING btree (target_asset_id);


--
-- Name: asset_template_versions_template_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_template_versions_template_id_idx ON public.asset_template_versions USING btree (template_id);


--
-- Name: asset_template_versions_template_id_version_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX asset_template_versions_template_id_version_number_key ON public.asset_template_versions USING btree (template_id, version_number);


--
-- Name: asset_templates_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_templates_category_idx ON public.asset_templates USING btree (category);


--
-- Name: asset_templates_is_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_templates_is_active_idx ON public.asset_templates USING btree (is_active);


--
-- Name: asset_templates_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX asset_templates_name_key ON public.asset_templates USING btree (name);


--
-- Name: asset_templates_template_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX asset_templates_template_kind_idx ON public.asset_templates USING btree (template_kind);


--
-- Name: audit_trail_action_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_trail_action_idx ON public.audit_trail USING btree (action);


--
-- Name: audit_trail_chain_position_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_trail_chain_position_idx ON public.audit_trail USING btree (chain_position);


--
-- Name: audit_trail_session_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_trail_session_id_idx ON public.audit_trail USING btree (session_id);


--
-- Name: audit_trail_target_type_target_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_trail_target_type_target_id_idx ON public.audit_trail USING btree (target_type, target_id);


--
-- Name: audit_trail_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_trail_timestamp_idx ON public.audit_trail USING btree ("timestamp" DESC);


--
-- Name: audit_trail_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_trail_user_id_idx ON public.audit_trail USING btree (user_id);


--
-- Name: audit_trail_user_id_timestamp_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_trail_user_id_timestamp_idx ON public.audit_trail USING btree (user_id, "timestamp" DESC);


--
-- Name: block_change_requests_filter_id_to_block_id_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX block_change_requests_filter_id_to_block_id_status_idx ON public.block_change_requests USING btree (filter_id, to_block_id, status);


--
-- Name: block_change_requests_requested_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX block_change_requests_requested_by_idx ON public.block_change_requests USING btree (requested_by);


--
-- Name: block_change_requests_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX block_change_requests_status_idx ON public.block_change_requests USING btree (status);


--
-- Name: blocks_is_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX blocks_is_active_idx ON public.blocks USING btree (is_active);


--
-- Name: blocks_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX blocks_name_idx ON public.blocks USING btree (name);


--
-- Name: blocks_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX blocks_status_idx ON public.blocks USING btree (status);


--
-- Name: checklist_profile_versions_profile_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX checklist_profile_versions_profile_id_idx ON public.checklist_profile_versions USING btree (profile_id);


--
-- Name: checklist_profile_versions_profile_id_version_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX checklist_profile_versions_profile_id_version_number_key ON public.checklist_profile_versions USING btree (profile_id, version_number);


--
-- Name: checklist_profiles_is_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX checklist_profiles_is_active_idx ON public.checklist_profiles USING btree (is_active);


--
-- Name: checklist_questions_profile_id_sort_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX checklist_questions_profile_id_sort_order_idx ON public.checklist_questions USING btree (profile_id, sort_order);


--
-- Name: checklist_reviews_checklist_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX checklist_reviews_checklist_id_key ON public.checklist_reviews USING btree (checklist_id);


--
-- Name: checklist_reviews_current_step_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX checklist_reviews_current_step_idx ON public.checklist_reviews USING btree (current_step);


--
-- Name: checklist_reviews_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX checklist_reviews_entity_id_idx ON public.checklist_reviews USING btree (entity_id);


--
-- Name: cleaning_cycles_cleaning_reason_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cleaning_cycles_cleaning_reason_key_idx ON public.cleaning_cycles USING btree (cleaning_reason_key);


--
-- Name: cleaning_cycles_cycle_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cleaning_cycles_cycle_code_key ON public.cleaning_cycles USING btree (cycle_code);


--
-- Name: cleaning_cycles_equipment_group_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cleaning_cycles_equipment_group_id_idx ON public.cleaning_cycles USING btree (equipment_group_id);


--
-- Name: cleaning_cycles_filter_id_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cleaning_cycles_filter_id_status_idx ON public.cleaning_cycles USING btree (filter_id, status);


--
-- Name: cleaning_cycles_filter_id_status_started_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cleaning_cycles_filter_id_status_started_at_idx ON public.cleaning_cycles USING btree (filter_id, status, started_at DESC);


--
-- Name: cleaning_cycles_pm_execution_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cleaning_cycles_pm_execution_id_idx ON public.cleaning_cycles USING btree (pm_execution_id);


--
-- Name: cleaning_cycles_profile_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cleaning_cycles_profile_id_idx ON public.cleaning_cycles USING btree (profile_id);


--
-- Name: cleaning_cycles_started_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cleaning_cycles_started_at_idx ON public.cleaning_cycles USING btree (started_at);


--
-- Name: cleaning_cycles_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cleaning_cycles_status_idx ON public.cleaning_cycles USING btree (status);


--
-- Name: cleaning_stage_approvals_cycle_id_stage_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cleaning_stage_approvals_cycle_id_stage_key_idx ON public.cleaning_stage_approvals USING btree (cycle_id, stage_key);


--
-- Name: cleaning_stage_approvals_filter_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cleaning_stage_approvals_filter_id_idx ON public.cleaning_stage_approvals USING btree (filter_id);


--
-- Name: cleaning_stage_approvals_status_approver_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cleaning_stage_approvals_status_approver_role_idx ON public.cleaning_stage_approvals USING btree (status, approver_role);


--
-- Name: dashboard_assignments_dashboard_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dashboard_assignments_dashboard_id_idx ON public.dashboard_assignments USING btree (dashboard_id);


--
-- Name: dashboard_assignments_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dashboard_assignments_user_id_idx ON public.dashboard_assignments USING btree (user_id);


--
-- Name: dashboard_widgets_dashboard_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dashboard_widgets_dashboard_id_idx ON public.dashboard_widgets USING btree (dashboard_id);


--
-- Name: dashboards_is_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dashboards_is_active_idx ON public.dashboards USING btree (is_active);


--
-- Name: deviations_ahu_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deviations_ahu_id_idx ON public.deviations USING btree (ahu_id);


--
-- Name: deviations_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deviations_created_at_idx ON public.deviations USING btree (created_at DESC);


--
-- Name: deviations_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deviations_status_idx ON public.deviations USING btree (status);


--
-- Name: electronic_signatures_record_type_record_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX electronic_signatures_record_type_record_id_idx ON public.electronic_signatures USING btree (record_type, record_id);


--
-- Name: entity_assignments_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_assignments_entity_id_idx ON public.entity_assignments USING btree (entity_id);


--
-- Name: entity_assignments_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_assignments_user_id_idx ON public.entity_assignments USING btree (user_id);


--
-- Name: equipment_group_instruments_group_id_sort_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX equipment_group_instruments_group_id_sort_order_idx ON public.equipment_group_instruments USING btree (group_id, sort_order);


--
-- Name: equipment_group_versions_group_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX equipment_group_versions_group_id_idx ON public.equipment_group_versions USING btree (group_id);


--
-- Name: equipment_group_versions_group_id_version_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX equipment_group_versions_group_id_version_number_key ON public.equipment_group_versions USING btree (group_id, version_number);


--
-- Name: equipment_groups_block_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX equipment_groups_block_id_idx ON public.equipment_groups USING btree (block_id);


--
-- Name: equipment_groups_is_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX equipment_groups_is_active_idx ON public.equipment_groups USING btree (is_active);


--
-- Name: field_id_config_field_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX field_id_config_field_id_key ON public.field_id_config USING btree (field_id);


--
-- Name: filter_cleaning_profiles_lineage_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX filter_cleaning_profiles_lineage_id_idx ON public.filter_cleaning_profiles USING btree (lineage_id);


--
-- Name: filter_cleaning_profiles_lineage_id_version_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX filter_cleaning_profiles_lineage_id_version_key ON public.filter_cleaning_profiles USING btree (lineage_id, version);


--
-- Name: filter_cleaning_profiles_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX filter_cleaning_profiles_status_idx ON public.filter_cleaning_profiles USING btree (status);


--
-- Name: filter_details_asset_instance_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX filter_details_asset_instance_id_key ON public.filter_details USING btree (asset_instance_id);


--
-- Name: filter_details_current_cycle_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX filter_details_current_cycle_id_idx ON public.filter_details USING btree (current_cycle_id);


--
-- Name: filter_details_current_lifecycle_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX filter_details_current_lifecycle_state_idx ON public.filter_details USING btree (current_lifecycle_state);


--
-- Name: filter_details_filter_profile_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX filter_details_filter_profile_id_idx ON public.filter_details USING btree (filter_profile_id);


--
-- Name: filter_events_cycle_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX filter_events_cycle_id_idx ON public.filter_events USING btree (cycle_id);


--
-- Name: filter_events_event_type_filter_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX filter_events_event_type_filter_id_idx ON public.filter_events USING btree (event_type, filter_id);


--
-- Name: filter_events_filter_id_cycle_id_event_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX filter_events_filter_id_cycle_id_event_type_idx ON public.filter_events USING btree (filter_id, cycle_id, event_type);


--
-- Name: filter_events_filter_id_cycle_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX filter_events_filter_id_cycle_id_idx ON public.filter_events USING btree (filter_id, cycle_id);


--
-- Name: filter_events_filter_id_performed_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX filter_events_filter_id_performed_at_idx ON public.filter_events USING btree (filter_id, performed_at DESC);


--
-- Name: filter_events_performed_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX filter_events_performed_at_idx ON public.filter_events USING btree (performed_at);


--
-- Name: filter_pipeline_connections_from_stage_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX filter_pipeline_connections_from_stage_id_idx ON public.filter_pipeline_connections USING btree (from_stage_id);


--
-- Name: filter_pipeline_connections_profile_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX filter_pipeline_connections_profile_id_idx ON public.filter_pipeline_connections USING btree (profile_id);


--
-- Name: filter_pipeline_stages_profile_id_sort_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX filter_pipeline_stages_profile_id_sort_order_idx ON public.filter_pipeline_stages USING btree (profile_id, sort_order);


--
-- Name: filter_profile_applicable_templates_template_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX filter_profile_applicable_templates_template_id_idx ON public.filter_profile_applicable_templates USING btree (template_id);


--
-- Name: filter_profile_versions_profile_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX filter_profile_versions_profile_id_idx ON public.filter_profile_versions USING btree (profile_id);


--
-- Name: filter_profile_versions_profile_id_version_number_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX filter_profile_versions_profile_id_version_number_key ON public.filter_profile_versions USING btree (profile_id, version_number);


--
-- Name: filter_profiles_cleaning_profile_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX filter_profiles_cleaning_profile_id_idx ON public.filter_profiles USING btree (cleaning_profile_id);


--
-- Name: filter_profiles_is_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX filter_profiles_is_active_idx ON public.filter_profiles USING btree (is_active);


--
-- Name: filters_ahu_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX filters_ahu_id_idx ON public.filters USING btree (ahu_id);


--
-- Name: filters_is_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX filters_is_active_idx ON public.filters USING btree (is_active);


--
-- Name: filters_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX filters_name_idx ON public.filters USING btree (name);


--
-- Name: filters_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX filters_status_idx ON public.filters USING btree (status);


--
-- Name: help_article_versions_help_article_id_version_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX help_article_versions_help_article_id_version_key ON public.help_article_versions USING btree (help_article_id, version);


--
-- Name: help_articles_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX help_articles_key_key ON public.help_articles USING btree (key);


--
-- Name: idx_cleaning_cycles_one_in_progress_per_filter; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_cleaning_cycles_one_in_progress_per_filter ON public.cleaning_cycles USING btree (filter_id) WHERE (status = 'IN_PROGRESS'::public.cleaning_cycle_status);


--
-- Name: latest_telemetry_entity_id_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX latest_telemetry_entity_id_key_key ON public.latest_telemetry USING btree (entity_id, key);


--
-- Name: notification_logs_channel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_logs_channel_idx ON public.notification_logs USING btree (channel);


--
-- Name: notification_logs_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_logs_created_at_idx ON public.notification_logs USING btree (created_at DESC);


--
-- Name: notification_logs_recipient_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_logs_recipient_idx ON public.notification_logs USING btree (recipient);


--
-- Name: notification_logs_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_logs_status_idx ON public.notification_logs USING btree (status);


--
-- Name: notification_rule_recipients_rule_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_rule_recipients_rule_id_idx ON public.notification_rule_recipients USING btree (rule_id);


--
-- Name: notification_rules_event_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_rules_event_type_idx ON public.notification_rules USING btree (event_type);


--
-- Name: notification_rules_is_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_rules_is_active_idx ON public.notification_rules USING btree (is_active);


--
-- Name: notification_rules_is_active_priority_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_rules_is_active_priority_idx ON public.notification_rules USING btree (is_active, priority DESC);


--
-- Name: notification_templates_channel_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_templates_channel_idx ON public.notification_templates USING btree (channel);


--
-- Name: notification_templates_is_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notification_templates_is_active_idx ON public.notification_templates USING btree (is_active);


--
-- Name: notification_templates_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX notification_templates_name_key ON public.notification_templates USING btree (name);


--
-- Name: notifications_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_created_at_idx ON public.notifications USING btree (created_at DESC);


--
-- Name: notifications_for_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_for_role_idx ON public.notifications USING btree (for_role);


--
-- Name: notifications_for_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_for_user_id_idx ON public.notifications USING btree (for_user_id);


--
-- Name: notifications_for_user_id_is_read_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_for_user_id_is_read_created_at_idx ON public.notifications USING btree (for_user_id, is_read, created_at DESC);


--
-- Name: notifications_is_read_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_is_read_idx ON public.notifications USING btree (is_read);


--
-- Name: password_history_user_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX password_history_user_id_created_at_idx ON public.password_history USING btree (user_id, created_at DESC);


--
-- Name: pm_executions_entity_id_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pm_executions_entity_id_status_idx ON public.pm_executions USING btree (entity_id, status);


--
-- Name: pm_executions_schedule_entry_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pm_executions_schedule_entry_id_idx ON public.pm_executions USING btree (schedule_entry_id);


--
-- Name: pm_schedule_entries_approval_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pm_schedule_entries_approval_status_idx ON public.pm_schedule_entries USING btree (approval_status);


--
-- Name: pm_schedule_entries_schedule_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pm_schedule_entries_schedule_id_idx ON public.pm_schedule_entries USING btree (schedule_id);


--
-- Name: pm_schedule_entries_schedule_id_month_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pm_schedule_entries_schedule_id_month_key ON public.pm_schedule_entries USING btree (schedule_id, month);


--
-- Name: pm_schedule_entries_window_start_window_end_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pm_schedule_entries_window_start_window_end_idx ON public.pm_schedule_entries USING btree (window_start, window_end);


--
-- Name: pm_schedules_entity_id_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pm_schedules_entity_id_status_idx ON public.pm_schedules USING btree (entity_id, status);


--
-- Name: pm_schedules_entity_id_year_version_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pm_schedules_entity_id_year_version_key ON public.pm_schedules USING btree (entity_id, year, version);


--
-- Name: pm_schedules_year_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pm_schedules_year_idx ON public.pm_schedules USING btree (year);


--
-- Name: qr_codes_entity_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX qr_codes_entity_id_key ON public.qr_codes USING btree (entity_id);


--
-- Name: quality_notifications_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX quality_notifications_created_at_idx ON public.quality_notifications USING btree (created_at DESC);


--
-- Name: quality_notifications_pm_schedule_entry_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX quality_notifications_pm_schedule_entry_id_idx ON public.quality_notifications USING btree (pm_schedule_entry_id);


--
-- Name: quality_notifications_schedule_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX quality_notifications_schedule_id_idx ON public.quality_notifications USING btree (schedule_id);


--
-- Name: replacement_executions_entry_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX replacement_executions_entry_id_idx ON public.replacement_executions USING btree (entry_id);


--
-- Name: replacement_schedule_entries_ahu_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX replacement_schedule_entries_ahu_id_idx ON public.replacement_schedule_entries USING btree (ahu_id);


--
-- Name: replacement_schedule_entries_schedule_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX replacement_schedule_entries_schedule_id_idx ON public.replacement_schedule_entries USING btree (schedule_id);


--
-- Name: replacement_schedule_entries_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX replacement_schedule_entries_status_idx ON public.replacement_schedule_entries USING btree (status);


--
-- Name: replacement_schedule_entries_window_start_window_end_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX replacement_schedule_entries_window_start_window_end_idx ON public.replacement_schedule_entries USING btree (window_start, window_end);


--
-- Name: replacement_schedules_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX replacement_schedules_status_idx ON public.replacement_schedules USING btree (status);


--
-- Name: report_instances_generated_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_instances_generated_at_idx ON public.report_instances USING btree (generated_at);


--
-- Name: report_instances_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_instances_status_idx ON public.report_instances USING btree (status);


--
-- Name: report_instances_template_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_instances_template_id_idx ON public.report_instances USING btree (template_id);


--
-- Name: report_reviews_assignee_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_reviews_assignee_role_idx ON public.report_reviews USING btree (assignee_role);


--
-- Name: report_reviews_assignee_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_reviews_assignee_user_id_idx ON public.report_reviews USING btree (assignee_user_id);


--
-- Name: report_reviews_generated_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_reviews_generated_by_idx ON public.report_reviews USING btree (generated_by);


--
-- Name: report_reviews_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_reviews_status_idx ON public.report_reviews USING btree (status);


--
-- Name: report_signatures_report_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_signatures_report_id_idx ON public.report_signatures USING btree (report_id);


--
-- Name: report_signatures_report_id_signer_role_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX report_signatures_report_id_signer_role_key ON public.report_signatures USING btree (report_id, signer_role);


--
-- Name: report_signatures_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_signatures_user_id_idx ON public.report_signatures USING btree (user_id);


--
-- Name: report_template_versions_template_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_template_versions_template_id_idx ON public.report_template_versions USING btree (template_id);


--
-- Name: report_template_versions_template_id_version_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX report_template_versions_template_id_version_key ON public.report_template_versions USING btree (template_id, version);


--
-- Name: report_templates_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_templates_status_idx ON public.report_templates USING btree (status);


--
-- Name: role_configs_role_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX role_configs_role_key ON public.role_configs USING btree (role);


--
-- Name: roles_hierarchy_level_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX roles_hierarchy_level_idx ON public.roles USING btree (hierarchy_level);


--
-- Name: roles_is_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX roles_is_active_idx ON public.roles USING btree (is_active);


--
-- Name: roles_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX roles_name_key ON public.roles USING btree (name);


--
-- Name: sessions_token_hash_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sessions_token_hash_key ON public.sessions USING btree (token_hash);


--
-- Name: sessions_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_id_idx ON public.sessions USING btree (user_id);


--
-- Name: sessions_user_id_is_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_id_is_active_idx ON public.sessions USING btree (user_id, is_active);


--
-- Name: system_config_config_key_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX system_config_config_key_key ON public.system_config USING btree (config_key);


--
-- Name: template_assignments_template_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX template_assignments_template_id_idx ON public.template_assignments USING btree (template_id);


--
-- Name: template_assignments_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX template_assignments_user_id_idx ON public.template_assignments USING btree (user_id);


--
-- Name: template_kinds_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX template_kinds_code_key ON public.template_kinds USING btree (code);


--
-- Name: template_kinds_is_active_sort_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX template_kinds_is_active_sort_order_idx ON public.template_kinds USING btree (is_active, sort_order);


--
-- Name: user_configs_user_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_configs_user_id_key ON public.user_configs USING btree (user_id);


--
-- Name: user_group_members_group_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_group_members_group_id_idx ON public.user_group_members USING btree (group_id);


--
-- Name: user_group_members_group_id_user_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_group_members_group_id_user_id_key ON public.user_group_members USING btree (group_id, user_id);


--
-- Name: user_group_members_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_group_members_user_id_idx ON public.user_group_members USING btree (user_id);


--
-- Name: user_groups_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_groups_name_key ON public.user_groups USING btree (name);


--
-- Name: users_email_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email);


--
-- Name: users_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_role_idx ON public.users USING btree (role);


--
-- Name: users_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_status_idx ON public.users USING btree (status);


--
-- Name: users_username_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_username_key ON public.users USING btree (username);


--
-- Name: audit_trail audit_trail_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_trail_no_delete BEFORE DELETE ON public.audit_trail FOR EACH ROW EXECUTE FUNCTION public.block_audit_trail_delete();


--
-- Name: asset_relationships trg_asset_relationship_pair; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER trg_asset_relationship_pair AFTER INSERT OR DELETE ON public.asset_relationships DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_asset_relationship_pair();


--
-- Name: filter_events trg_filter_event_consistency; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_filter_event_consistency BEFORE INSERT OR UPDATE OF cycle_id, filter_id ON public.filter_events FOR EACH ROW EXECUTE FUNCTION public.check_filter_event_consistency();


--
-- Name: asset_instances trg_mirror_asset_instance_iud; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_mirror_asset_instance_iud AFTER INSERT OR DELETE OR UPDATE ON public.asset_instances FOR EACH ROW EXECUTE FUNCTION public.fn_mirror_asset_instance();


--
-- Name: filters trg_mirror_typed_to_asset_instance; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_mirror_typed_to_asset_instance AFTER INSERT OR DELETE OR UPDATE ON public.filters FOR EACH ROW EXECUTE FUNCTION public.fn_mirror_typed_to_asset_instance();


--
-- Name: ahus ahus_area_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ahus
    ADD CONSTRAINT ahus_area_id_fkey FOREIGN KEY (area_id) REFERENCES public.areas(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: ahus ahus_block_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ahus
    ADD CONSTRAINT ahus_block_id_fkey FOREIGN KEY (block_id) REFERENCES public.blocks(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: areas areas_block_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.areas
    ADD CONSTRAINT areas_block_id_fkey FOREIGN KEY (block_id) REFERENCES public.blocks(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: asset_identifiers asset_identifiers_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_identifiers
    ADD CONSTRAINT asset_identifiers_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.asset_instances(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: asset_instances asset_instances_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_instances
    ADD CONSTRAINT asset_instances_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.asset_instances(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: asset_instances asset_instances_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_instances
    ADD CONSTRAINT asset_instances_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.asset_templates(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: asset_relationships asset_relationships_source_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_relationships
    ADD CONSTRAINT asset_relationships_source_asset_id_fkey FOREIGN KEY (source_asset_id) REFERENCES public.asset_instances(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: asset_relationships asset_relationships_target_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_relationships
    ADD CONSTRAINT asset_relationships_target_asset_id_fkey FOREIGN KEY (target_asset_id) REFERENCES public.asset_instances(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: asset_template_versions asset_template_versions_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_template_versions
    ADD CONSTRAINT asset_template_versions_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.asset_templates(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: asset_templates asset_templates_template_kind_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_templates
    ADD CONSTRAINT asset_templates_template_kind_fkey FOREIGN KEY (template_kind) REFERENCES public.template_kinds(code) ON UPDATE RESTRICT ON DELETE RESTRICT;


--
-- Name: checklist_profile_versions checklist_profile_versions_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checklist_profile_versions
    ADD CONSTRAINT checklist_profile_versions_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.checklist_profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: checklist_questions checklist_questions_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.checklist_questions
    ADD CONSTRAINT checklist_questions_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.checklist_profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: cleaning_cycles cleaning_cycles_equipment_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleaning_cycles
    ADD CONSTRAINT cleaning_cycles_equipment_group_id_fkey FOREIGN KEY (equipment_group_id) REFERENCES public.equipment_groups(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: cleaning_cycles cleaning_cycles_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cleaning_cycles
    ADD CONSTRAINT cleaning_cycles_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.filter_cleaning_profiles(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: dashboard_assignments dashboard_assignments_dashboard_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_assignments
    ADD CONSTRAINT dashboard_assignments_dashboard_id_fkey FOREIGN KEY (dashboard_id) REFERENCES public.dashboards(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: dashboard_widgets dashboard_widgets_dashboard_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dashboard_widgets
    ADD CONSTRAINT dashboard_widgets_dashboard_id_fkey FOREIGN KEY (dashboard_id) REFERENCES public.dashboards(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: entity_assignments entity_assignments_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_assignments
    ADD CONSTRAINT entity_assignments_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.asset_instances(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: entity_assignments entity_assignments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_assignments
    ADD CONSTRAINT entity_assignments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: equipment_group_instruments equipment_group_instruments_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_group_instruments
    ADD CONSTRAINT equipment_group_instruments_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.equipment_groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: equipment_group_versions equipment_group_versions_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_group_versions
    ADD CONSTRAINT equipment_group_versions_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.equipment_groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: equipment_groups equipment_groups_block_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipment_groups
    ADD CONSTRAINT equipment_groups_block_id_fkey FOREIGN KEY (block_id) REFERENCES public.asset_instances(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: filter_details filter_details_asset_instance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_details
    ADD CONSTRAINT filter_details_asset_instance_id_fkey FOREIGN KEY (asset_instance_id) REFERENCES public.asset_instances(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: filter_details filter_details_current_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_details
    ADD CONSTRAINT filter_details_current_cycle_id_fkey FOREIGN KEY (current_cycle_id) REFERENCES public.cleaning_cycles(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: filter_details filter_details_filter_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_details
    ADD CONSTRAINT filter_details_filter_profile_id_fkey FOREIGN KEY (filter_profile_id) REFERENCES public.filter_profiles(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: filter_events filter_events_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_events
    ADD CONSTRAINT filter_events_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.cleaning_cycles(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: filter_pipeline_connections filter_pipeline_connections_from_stage_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_pipeline_connections
    ADD CONSTRAINT filter_pipeline_connections_from_stage_id_fkey FOREIGN KEY (from_stage_id) REFERENCES public.filter_pipeline_stages(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: filter_pipeline_connections filter_pipeline_connections_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_pipeline_connections
    ADD CONSTRAINT filter_pipeline_connections_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.filter_cleaning_profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: filter_pipeline_connections filter_pipeline_connections_to_stage_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_pipeline_connections
    ADD CONSTRAINT filter_pipeline_connections_to_stage_id_fkey FOREIGN KEY (to_stage_id) REFERENCES public.filter_pipeline_stages(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: filter_pipeline_stages filter_pipeline_stages_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_pipeline_stages
    ADD CONSTRAINT filter_pipeline_stages_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.filter_cleaning_profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: filter_profile_applicable_templates filter_profile_applicable_templates_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_profile_applicable_templates
    ADD CONSTRAINT filter_profile_applicable_templates_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.filter_profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: filter_profile_applicable_templates filter_profile_applicable_templates_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_profile_applicable_templates
    ADD CONSTRAINT filter_profile_applicable_templates_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.asset_templates(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: filter_profile_versions filter_profile_versions_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_profile_versions
    ADD CONSTRAINT filter_profile_versions_profile_id_fkey FOREIGN KEY (profile_id) REFERENCES public.filter_profiles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: filter_profiles filter_profiles_cleaning_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_profiles
    ADD CONSTRAINT filter_profiles_cleaning_profile_id_fkey FOREIGN KEY (cleaning_profile_id) REFERENCES public.filter_cleaning_profiles(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: filter_profiles filter_profiles_default_pm_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filter_profiles
    ADD CONSTRAINT filter_profiles_default_pm_schedule_id_fkey FOREIGN KEY (default_pm_schedule_id) REFERENCES public.pm_schedules(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: filters filters_ahu_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.filters
    ADD CONSTRAINT filters_ahu_id_fkey FOREIGN KEY (ahu_id) REFERENCES public.ahus(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: help_article_versions help_article_versions_help_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.help_article_versions
    ADD CONSTRAINT help_article_versions_help_article_id_fkey FOREIGN KEY (help_article_id) REFERENCES public.help_articles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: notification_rule_recipients notification_rule_recipients_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_rule_recipients
    ADD CONSTRAINT notification_rule_recipients_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.user_groups(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: notification_rule_recipients notification_rule_recipients_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_rule_recipients
    ADD CONSTRAINT notification_rule_recipients_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.notification_rules(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: password_history password_history_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_history
    ADD CONSTRAINT password_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: pm_executions pm_executions_schedule_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pm_executions
    ADD CONSTRAINT pm_executions_schedule_entry_id_fkey FOREIGN KEY (schedule_entry_id) REFERENCES public.pm_schedule_entries(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: pm_schedule_entries pm_schedule_entries_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pm_schedule_entries
    ADD CONSTRAINT pm_schedule_entries_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES public.pm_schedules(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: replacement_executions replacement_executions_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replacement_executions
    ADD CONSTRAINT replacement_executions_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES public.replacement_schedule_entries(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: replacement_schedule_entries replacement_schedule_entries_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replacement_schedule_entries
    ADD CONSTRAINT replacement_schedule_entries_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES public.replacement_schedules(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: report_instances report_instances_generated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_instances
    ADD CONSTRAINT report_instances_generated_by_fkey FOREIGN KEY (generated_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: report_instances report_instances_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_instances
    ADD CONSTRAINT report_instances_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.report_templates(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: report_signatures report_signatures_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_signatures
    ADD CONSTRAINT report_signatures_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.report_instances(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: report_signatures report_signatures_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_signatures
    ADD CONSTRAINT report_signatures_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: report_template_versions report_template_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_template_versions
    ADD CONSTRAINT report_template_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: report_template_versions report_template_versions_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_template_versions
    ADD CONSTRAINT report_template_versions_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.report_templates(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: report_templates report_templates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_templates
    ADD CONSTRAINT report_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: template_assignments template_assignments_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_assignments
    ADD CONSTRAINT template_assignments_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.asset_templates(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: template_assignments template_assignments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_assignments
    ADD CONSTRAINT template_assignments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: user_group_members user_group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_group_members
    ADD CONSTRAINT user_group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.user_groups(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


