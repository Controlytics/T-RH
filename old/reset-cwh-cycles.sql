BEGIN;

-- 1. Terminate the 6 stuck CWH cycles
UPDATE cleaning_cycles
SET status = 'TERMINATED',
    terminated_at = NOW(),
    termination_reason = 'Cleared by admin: cycle was bound to obsolete profile (test/Dry and Store Only). Will restart under live block-assigned profile.',
    updated_at = NOW()
WHERE filter_id IN (
  SELECT ai.id
  FROM asset_instances ai
  JOIN asset_templates t ON ai.template_id = t.id
  WHERE t.name = 'Filter'
    AND ai.parent_id IN (
      SELECT id FROM asset_instances WHERE name = 'CWH-AHU-01'
    )
)
AND status = 'IN_PROGRESS'
RETURNING id, filter_id, cycle_code, status;

-- 2. Clear the filters' current_cycle_id and current_lifecycle_state so a fresh scan starts a new cycle
UPDATE asset_instances
SET current_cycle_id = NULL,
    current_lifecycle_state = NULL,
    updated_at = NOW()
WHERE id IN (
  SELECT ai.id
  FROM asset_instances ai
  JOIN asset_templates t ON ai.template_id = t.id
  WHERE t.name = 'Filter'
    AND ai.parent_id IN (
      SELECT id FROM asset_instances WHERE name = 'CWH-AHU-01'
    )
)
RETURNING id, name, current_cycle_id, current_lifecycle_state;

COMMIT;
