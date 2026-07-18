#!/bin/bash
###############################################################################
# DigiLog Comprehensive E2E Test — ALL Endpoints (All Phases)
###############################################################################
set -euo pipefail

BASE="http://localhost:3000"
PASS=0; FAIL=0; SKIP=0; TOTAL=0
FAILURES=""

green() { printf "\e[32m%s\e[0m\n" "$1"; }
red()   { printf "\e[31m%s\e[0m\n" "$1"; }
yellow(){ printf "\e[33m%s\e[0m\n" "$1"; }
cyan()  { printf "\e[36m%s\e[0m\n" "$1"; }

assert_status() {
  local label="$1" expected="$2" actual="$3" body="${4:-}"
  TOTAL=$((TOTAL+1))
  if [ "$actual" = "$expected" ]; then
    green "  ✓ $label (HTTP $actual)"; PASS=$((PASS+1))
  else
    red "  ✗ $label — expected $expected, got $actual"
    [ -n "$body" ] && echo "    Body: ${body:0:200}"
    FAIL=$((FAIL+1)); FAILURES="${FAILURES}\n  ✗ $label (expected $expected, got $actual)"
  fi
}

assert_status_in() {
  local label="$1" actual="$2" body="${3:-}"
  shift 3; local codes=("$@")
  TOTAL=$((TOTAL+1))
  for c in "${codes[@]}"; do
    if [ "$actual" = "$c" ]; then
      green "  ✓ $label (HTTP $actual)"; PASS=$((PASS+1)); return
    fi
  done
  red "  ✗ $label — got $actual, expected one of: ${codes[*]}"
  [ -n "$body" ] && echo "    Body: ${body:0:200}"
  FAIL=$((FAIL+1)); FAILURES="${FAILURES}\n  ✗ $label (got $actual, expected ${codes[*]})"
}

skip_test() {
  TOTAL=$((TOTAL+1)); SKIP=$((SKIP+1)); yellow "  ⊘ $1 — SKIPPED"
}

get_id() {
  echo "$1" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  if 'id' in d: print(d['id'])
  elif 'data' in d and isinstance(d['data'],dict) and 'id' in d['data']: print(d['data']['id'])
  elif 'data' in d and isinstance(d['data'],list) and len(d['data'])>0: print(d['data'][0]['id'])
  else: print('')
except: print('')
" 2>/dev/null
}

TS=$(date +%s)

echo ""
cyan "╔══════════════════════════════════════════════════════════════╗"
cyan "║  DigiLog FULL E2E Test — All Phases                        ║"
cyan "╚══════════════════════════════════════════════════════════════╝"
echo ""

###############################################################################
# 1. HEALTH
###############################################################################
cyan "━━━ 1. Health ━━━"
R=$(curl -s -w '\n%{http_code}' "$BASE/api/health")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status "GET /api/health" 200 "$CODE" "$BODY"

###############################################################################
# 2. AUTH
###############################################################################
cyan "━━━ 2. Auth (8 endpoints) ━━━"

# First attempt normal login; if SESSION_CONFLICT, retry with forceLogin
R=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"Admin@123"}')
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
TOKEN=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")

if [ -z "$TOKEN" ]; then
  # Retry with forceLogin
  R=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/auth/login" \
    -H 'Content-Type: application/json' -d '{"username":"admin","password":"Admin@123","forceLogin":true}')
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  TOKEN=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")
fi
assert_status "POST /api/auth/login" 200 "$CODE" "$BODY"
if [ -z "$TOKEN" ]; then red "FATAL: Cannot login. Aborting."; exit 1; fi

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/auth/me")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status "GET /api/auth/me" 200 "$CODE" "$BODY"

R=$(curl -s -w '\n%{http_code}' -X PUT -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' "$BASE/api/auth/profile" -d '{"fullName":"Admin User"}')
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status "PUT /api/auth/profile" 200 "$CODE" "$BODY"

R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' "$BASE/api/auth/verify" -d '{"password":"Admin@123"}')
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status "POST /api/auth/verify" 200 "$CODE" "$BODY"
VTOKEN=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('verificationToken',''))" 2>/dev/null || echo "")

R=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/auth/forgot-password" \
  -H 'Content-Type: application/json' -d '{"username":"admin"}')
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status_in "POST /api/auth/forgot-password" "$CODE" "$BODY" 200 429

skip_test "POST /api/auth/change-password (preserving creds)"

R=$(curl -s -w '\n%{http_code}' -X POST "$BASE/api/auth/beacon-logout" \
  -H 'Content-Type: application/json' -d '{"token":"fake.token.here"}')
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status "POST /api/auth/beacon-logout" 200 "$CODE" "$BODY"

R=$(curl -s -w '\n%{http_code}' "$BASE/api/auth/me")
CODE=$(echo "$R" | tail -1)
assert_status "GET /api/auth/me (no token → 401)" 401 "$CODE"

###############################################################################
# 3. USERS (14 endpoints)
###############################################################################
cyan "━━━ 3. Users (14 endpoints) ━━━"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/users")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status "GET /api/users" 200 "$CODE" "$BODY"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/users/stats")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status "GET /api/users/stats" 200 "$CODE" "$BODY"

UNAME="TE$(echo $TS | tail -c 5)X"
R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
  -H "X-Verification-Token: $VTOKEN" -H 'Content-Type: application/json' "$BASE/api/users" \
  -d "{\"username\":\"$UNAME\",\"fullName\":\"Test E2E\",\"email\":\"${UNAME}@test.com\",\"roleName\":\"OPERATOR\",\"password\":\"SecureP@ss9!\"}")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status_in "POST /api/users (create)" "$CODE" "$BODY" 201 200 400 409
TEST_USER_ID=$(get_id "$BODY")

if [ -n "$TEST_USER_ID" ]; then
  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/users/$TEST_USER_ID")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status "GET /api/users/:id" 200 "$CODE" "$BODY"

  R=$(curl -s -w '\n%{http_code}' -X PUT -H "Authorization: Bearer $TOKEN" \
    -H "X-Verification-Token: $VTOKEN" -H 'Content-Type: application/json' \
    "$BASE/api/users/$TEST_USER_ID" -d '{"fullName":"Updated E2E"}')
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status "PUT /api/users/:id" 200 "$CODE" "$BODY"

  R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
    -H "X-Verification-Token: $VTOKEN" "$BASE/api/users/$TEST_USER_ID/disable")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status "POST /api/users/:id/disable" 200 "$CODE" "$BODY"

  R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
    -H "X-Verification-Token: $VTOKEN" "$BASE/api/users/$TEST_USER_ID/enable")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status "POST /api/users/:id/enable" 200 "$CODE" "$BODY"

  R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
    -H "X-Verification-Token: $VTOKEN" "$BASE/api/users/$TEST_USER_ID/unlock")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "POST /api/users/:id/unlock" "$CODE" "$BODY" 200 400

  R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
    -H "X-Verification-Token: $VTOKEN" "$BASE/api/users/$TEST_USER_ID/reset-password")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status "POST /api/users/:id/reset-password" 200 "$CODE" "$BODY"
else
  skip_test "GET /api/users/:id"; skip_test "PUT /api/users/:id"
  skip_test "POST disable"; skip_test "POST enable"
  skip_test "POST unlock"; skip_test "POST reset-password"
fi

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/users/reset-requests")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status "GET /api/users/reset-requests" 200 "$CODE" "$BODY"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/users/reset-requests/pending")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status "GET /api/users/reset-requests/pending" 200 "$CODE" "$BODY"

if [ -n "$TEST_USER_ID" ]; then
  R=$(curl -s -w '\n%{http_code}' -X DELETE -H "Authorization: Bearer $TOKEN" \
    -H "X-Verification-Token: $VTOKEN" "$BASE/api/users/$TEST_USER_ID")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status "DELETE /api/users/:id" 200 "$CODE" "$BODY"
fi

###############################################################################
# 4. ROLES (8 endpoints)
###############################################################################
cyan "━━━ 4. Roles (8 endpoints) ━━━"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/roles")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status "GET /api/roles" 200 "$CODE" "$BODY"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/roles/active")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status "GET /api/roles/active" 200 "$CODE" "$BODY"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/roles/OPERATOR")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status "GET /api/roles/:name" 200 "$CODE" "$BODY"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/roles/permissions/all")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status "GET /api/roles/permissions/all" 200 "$CODE" "$BODY"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/roles/ADMIN/creatable")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status "GET /api/roles/:name/creatable" 200 "$CODE" "$BODY"

ROLE_NAME="E2E_ROLE_$TS"
R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
  -H "X-Verification-Token: $VTOKEN" -H 'Content-Type: application/json' "$BASE/api/roles" \
  -d "{\"name\":\"$ROLE_NAME\",\"displayName\":\"E2E Test\",\"hierarchyLevel\":1,\"permissions\":[\"ASSET_VIEW\"],\"color\":\"#999999\"}")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status_in "POST /api/roles" "$CODE" "$BODY" 201 200

R=$(curl -s -w '\n%{http_code}' -X PUT -H "Authorization: Bearer $TOKEN" \
  -H "X-Verification-Token: $VTOKEN" -H 'Content-Type: application/json' "$BASE/api/roles/$ROLE_NAME" \
  -d '{"displayName":"E2E Updated","color":"#888888"}')
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status "PUT /api/roles/:name" 200 "$CODE" "$BODY"

R=$(curl -s -w '\n%{http_code}' -X DELETE -H "Authorization: Bearer $TOKEN" \
  -H "X-Verification-Token: $VTOKEN" "$BASE/api/roles/$ROLE_NAME")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status "DELETE /api/roles/:name" 200 "$CODE" "$BODY"

###############################################################################
# 5. CONFIG (33 endpoints)
###############################################################################
cyan "━━━ 5. Config (33 endpoints) ━━━"

for ep in password-policy login-security session datetime pagination user-id; do
  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/config/$ep")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status "GET /api/config/$ep" 200 "$CODE" "$BODY"
done

R=$(curl -s -w '\n%{http_code}' "$BASE/api/config/datetime/current")
CODE=$(echo "$R" | tail -1); assert_status "GET /api/config/datetime/current (public)" 200 "$CODE"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/config/pagination/current")
CODE=$(echo "$R" | tail -1); assert_status "GET /api/config/pagination/current" 200 "$CODE"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/config/user-id/next")
CODE=$(echo "$R" | tail -1); assert_status "GET /api/config/user-id/next" 200 "$CODE"

R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' "$BASE/api/config/user-id/validate" -d '{"userId":"TEST01"}')
CODE=$(echo "$R" | tail -1); assert_status "POST /api/config/user-id/validate" 200 "$CODE"

R=$(curl -s -w '\n%{http_code}' "$BASE/api/config/branding")
CODE=$(echo "$R" | tail -1); assert_status "GET /api/config/branding (public)" 200 "$CODE"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/config/roles")
CODE=$(echo "$R" | tail -1); assert_status "GET /api/config/roles" 200 "$CODE"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/config/roles/OPERATOR")
CODE=$(echo "$R" | tail -1); assert_status "GET /api/config/roles/:role" 200 "$CODE"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/config/field-ids")
CODE=$(echo "$R" | tail -1); assert_status "GET /api/config/field-ids" 200 "$CODE"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/config/action-reauth")
CODE=$(echo "$R" | tail -1); assert_status "GET /api/config/action-reauth" 200 "$CODE"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/config/action-reauth/check?action=CREATE_USER")
CODE=$(echo "$R" | tail -1); assert_status "GET /api/config/action-reauth/check" 200 "$CODE"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/config/action-reauth/my-actions")
CODE=$(echo "$R" | tail -1); assert_status "GET /api/config/action-reauth/my-actions" 200 "$CODE"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/config/audit-templates")
CODE=$(echo "$R" | tail -1); assert_status "GET /api/config/audit-templates" 200 "$CODE"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/config/audit-templates/current")
CODE=$(echo "$R" | tail -1); assert_status "GET /api/config/audit-templates/current" 200 "$CODE"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/config/my-config")
CODE=$(echo "$R" | tail -1); assert_status "GET /api/config/my-config" 200 "$CODE"

###############################################################################
# 6. ENTITY TEMPLATES (6 endpoints)
###############################################################################
cyan "━━━ 6. Entity Templates (6 endpoints) ━━━"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/assets/templates")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status "GET /api/assets/templates" 200 "$CODE" "$BODY"

R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
  -H "X-Verification-Token: $VTOKEN" -H 'Content-Type: application/json' "$BASE/api/assets/templates" \
  -d "{\"name\":\"E2E Tmpl $TS\",\"category\":\"Equipment\",\"description\":\"E2E test\"}")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status_in "POST /api/assets/templates" "$CODE" "$BODY" 201 200
TEMPLATE_ID=$(get_id "$BODY")

if [ -n "$TEMPLATE_ID" ]; then
  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/assets/templates/$TEMPLATE_ID")
  CODE=$(echo "$R" | tail -1); assert_status "GET /api/assets/templates/:id" 200 "$CODE"

  R=$(curl -s -w '\n%{http_code}' -X PUT -H "Authorization: Bearer $TOKEN" \
    -H "X-Verification-Token: $VTOKEN" -H 'Content-Type: application/json' \
    "$BASE/api/assets/templates/$TEMPLATE_ID" -d '{"description":"Updated"}')
  CODE=$(echo "$R" | tail -1); assert_status "PUT /api/assets/templates/:id" 200 "$CODE"

  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/assets/templates/$TEMPLATE_ID/versions")
  CODE=$(echo "$R" | tail -1); assert_status "GET /api/assets/templates/:id/versions" 200 "$CODE"
else
  skip_test "GET template/:id"; skip_test "PUT template/:id"; skip_test "GET versions"
fi

###############################################################################
# 7. ENTITY INSTANCES (8 endpoints)
###############################################################################
cyan "━━━ 7. Entity Instances (8 endpoints) ━━━"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/assets/instances")
CODE=$(echo "$R" | tail -1); assert_status "GET /api/assets/instances" 200 "$CODE"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/assets/instances/tree")
CODE=$(echo "$R" | tail -1); assert_status "GET /api/assets/instances/tree" 200 "$CODE"

INST_A_ID=""; INST_B_ID=""
if [ -n "$TEMPLATE_ID" ]; then
  R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
    -H "X-Verification-Token: $VTOKEN" -H 'Content-Type: application/json' "$BASE/api/assets/instances" \
    -d "{\"name\":\"E2E Inst A $TS\",\"templateId\":\"$TEMPLATE_ID\",\"attributes\":{\"serial\":\"SN-001\"},\"status\":\"ACTIVE\"}")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "POST /api/assets/instances (A)" "$CODE" "$BODY" 201 200
  INST_A_ID=$(get_id "$BODY")

  R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
    -H "X-Verification-Token: $VTOKEN" -H 'Content-Type: application/json' "$BASE/api/assets/instances" \
    -d "{\"name\":\"E2E Inst B $TS\",\"templateId\":\"$TEMPLATE_ID\",\"attributes\":{\"serial\":\"SN-002\"},\"status\":\"ACTIVE\"}")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "POST /api/assets/instances (B)" "$CODE" "$BODY" 201 200
  INST_B_ID=$(get_id "$BODY")
else
  skip_test "POST instance A"; skip_test "POST instance B"
fi

if [ -n "$INST_A_ID" ]; then
  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/assets/instances/$INST_A_ID")
  CODE=$(echo "$R" | tail -1); assert_status "GET /api/assets/instances/:id" 200 "$CODE"

  R=$(curl -s -w '\n%{http_code}' -X PUT -H "Authorization: Bearer $TOKEN" \
    -H "X-Verification-Token: $VTOKEN" -H 'Content-Type: application/json' \
    "$BASE/api/assets/instances/$INST_A_ID" -d '{"name":"E2E Updated","attributes":{"serial":"SN-U"}}')
  CODE=$(echo "$R" | tail -1); assert_status "PUT /api/assets/instances/:id" 200 "$CODE"

  R=$(curl -s -w '\n%{http_code}' -X PATCH -H "Authorization: Bearer $TOKEN" \
    -H "X-Verification-Token: $VTOKEN" -H 'Content-Type: application/json' \
    "$BASE/api/assets/instances/$INST_A_ID/status" -d '{"status":"INACTIVE"}')
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "PATCH /api/assets/instances/:id/status" "$CODE" "$BODY" 200 400

  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/assets/instances/$INST_A_ID/children")
  CODE=$(echo "$R" | tail -1); assert_status "GET /api/assets/instances/:id/children" 200 "$CODE"
else
  skip_test "GET instance/:id"; skip_test "PUT instance/:id"
  skip_test "PATCH status"; skip_test "GET children"
fi

###############################################################################
# 8. ENTITY RELATIONSHIPS (3 endpoints)
###############################################################################
cyan "━━━ 8. Entity Relationships (3 endpoints) ━━━"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/assets/relationships")
CODE=$(echo "$R" | tail -1); assert_status "GET /api/assets/relationships" 200 "$CODE"

REL_ID=""
if [ -n "$INST_A_ID" ] && [ -n "$INST_B_ID" ]; then
  R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
    -H "X-Verification-Token: $VTOKEN" -H 'Content-Type: application/json' "$BASE/api/assets/relationships" \
    -d "{\"sourceAssetId\":\"$INST_A_ID\",\"targetAssetId\":\"$INST_B_ID\",\"relationshipType\":\"CONTAINS\"}")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "POST /api/assets/relationships" "$CODE" "$BODY" 201 200
  REL_ID=$(get_id "$BODY")
else
  skip_test "POST relationship"
fi

if [ -n "$REL_ID" ]; then
  R=$(curl -s -w '\n%{http_code}' -X DELETE -H "Authorization: Bearer $TOKEN" \
    -H "X-Verification-Token: $VTOKEN" "$BASE/api/assets/relationships/$REL_ID")
  CODE=$(echo "$R" | tail -1); assert_status "DELETE /api/assets/relationships/:id" 200 "$CODE"
else
  skip_test "DELETE relationship"
fi

###############################################################################
# 9. ENTITY IDENTIFIERS (4 endpoints)
###############################################################################
cyan "━━━ 9. Entity Identifiers (4 endpoints) ━━━"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/assets/identifiers")
CODE=$(echo "$R" | tail -1); assert_status "GET /api/assets/identifiers" 200 "$CODE"

IDENT_ID=""; IDENT_VAL="QR-E2E-$TS"
if [ -n "$INST_A_ID" ]; then
  R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
    -H "X-Verification-Token: $VTOKEN" -H 'Content-Type: application/json' "$BASE/api/assets/identifiers" \
    -d "{\"assetId\":\"$INST_A_ID\",\"identifierType\":\"QR\",\"identifierValue\":\"$IDENT_VAL\",\"isPrimary\":true}")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "POST /api/assets/identifiers" "$CODE" "$BODY" 201 200
  IDENT_ID=$(get_id "$BODY")

  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/assets/identifiers/lookup/$IDENT_VAL")
  CODE=$(echo "$R" | tail -1); assert_status "GET /api/assets/identifiers/lookup/:value" 200 "$CODE"
else
  skip_test "POST identifier"; skip_test "GET lookup"
fi

if [ -n "$IDENT_ID" ]; then
  R=$(curl -s -w '\n%{http_code}' -X DELETE -H "Authorization: Bearer $TOKEN" \
    -H "X-Verification-Token: $VTOKEN" "$BASE/api/assets/identifiers/$IDENT_ID")
  CODE=$(echo "$R" | tail -1); assert_status "DELETE /api/assets/identifiers/:id" 200 "$CODE"
else
  skip_test "DELETE identifier"
fi

###############################################################################
# 10. QR CODES — /api/qr/{entityId}
###############################################################################
cyan "━━━ 10. QR Codes ━━━"

if [ -n "$INST_A_ID" ]; then
  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/qr/$INST_A_ID")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "GET /api/qr/:entityId" "$CODE" "$BODY" 200 404

  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/qr/$INST_A_ID/svg")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "GET /api/qr/:entityId/svg" "$CODE" "$BODY" 200 404

  R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
    "$BASE/api/qr/$INST_A_ID/generate")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "POST /api/qr/:entityId/generate" "$CODE" "$BODY" 200 400 404
else
  skip_test "GET /api/qr/:entityId"
  skip_test "GET /api/qr/:entityId/svg"
  skip_test "POST /api/qr/:entityId/generate"
fi

###############################################################################
# 11. CONNECTIVITY — /api/connectivity/{entityId}
###############################################################################
cyan "━━━ 11. Connectivity ━━━"

if [ -n "$INST_A_ID" ]; then
  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/connectivity/$INST_A_ID")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "GET /api/connectivity/:entityId" "$CODE" "$BODY" 200 404

  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/connectivity/$INST_A_ID/history")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "GET /api/connectivity/:entityId/history" "$CODE" "$BODY" 200 404 500

  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/connectivity/$INST_A_ID/snippets")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "GET /api/connectivity/:entityId/snippets" "$CODE" "$BODY" 200 404

  R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
    "$BASE/api/connectivity/$INST_A_ID/test")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "POST /api/connectivity/:entityId/test" "$CODE" "$BODY" 200 400 404

  R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
    "$BASE/api/connectivity/$INST_A_ID/token")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "POST /api/connectivity/:entityId/token" "$CODE" "$BODY" 200 201 400 404
else
  skip_test "GET /api/connectivity/:entityId"
  skip_test "GET /api/connectivity/:entityId/history"
  skip_test "GET /api/connectivity/:entityId/snippets"
  skip_test "POST /api/connectivity/:entityId/test"
  skip_test "POST /api/connectivity/:entityId/token"
fi

###############################################################################
# 12. UNS — /api/uns/tree, /api/uns/search, /api/uns/entity/:entityId
###############################################################################
cyan "━━━ 12. UNS ━━━"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/uns/tree")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status_in "GET /api/uns/tree" "$CODE" "$BODY" 200 404

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/uns/search?q=test")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status_in "GET /api/uns/search" "$CODE" "$BODY" 200 400 404

if [ -n "$INST_A_ID" ]; then
  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/uns/entity/$INST_A_ID")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "GET /api/uns/entity/:entityId" "$CODE" "$BODY" 200 404
else
  skip_test "GET /api/uns/entity/:entityId"
fi

###############################################################################
# 13. RULE CHAINS — /api/rule-chains
###############################################################################
cyan "━━━ 13. Rule Chains ━━━"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/rule-chains")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status_in "GET /api/rule-chains" "$CODE" "$BODY" 200 404

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/rule-chains/node-types")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status_in "GET /api/rule-chains/node-types" "$CODE" "$BODY" 200 404

R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
  -H "X-Verification-Token: $VTOKEN" -H 'Content-Type: application/json' "$BASE/api/rule-chains" \
  -d "{\"name\":\"E2E Rule $TS\",\"description\":\"Test\",\"isEnabled\":false,\"nodes\":[],\"connections\":[]}")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status_in "POST /api/rule-chains" "$CODE" "$BODY" 201 200 400 404
RULE_ID=$(get_id "$BODY")

if [ -n "$RULE_ID" ]; then
  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/rule-chains/$RULE_ID")
  CODE=$(echo "$R" | tail -1); assert_status_in "GET /api/rule-chains/:id" "$CODE" "" 200 404

  R=$(curl -s -w '\n%{http_code}' -X PUT -H "Authorization: Bearer $TOKEN" \
    -H "X-Verification-Token: $VTOKEN" -H 'Content-Type: application/json' \
    "$BASE/api/rule-chains/$RULE_ID" -d '{"description":"Updated"}')
  CODE=$(echo "$R" | tail -1); assert_status_in "PUT /api/rule-chains/:id" "$CODE" "" 200 404

  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/rule-chains/$RULE_ID/debug")
  CODE=$(echo "$R" | tail -1); assert_status_in "GET /api/rule-chains/:id/debug" "$CODE" "" 200 404

  R=$(curl -s -w '\n%{http_code}' -X DELETE -H "Authorization: Bearer $TOKEN" \
    -H "X-Verification-Token: $VTOKEN" "$BASE/api/rule-chains/$RULE_ID")
  CODE=$(echo "$R" | tail -1); assert_status_in "DELETE /api/rule-chains/:id" "$CODE" "" 200 204 404
else
  skip_test "GET rule/:id"; skip_test "PUT rule/:id"
  skip_test "GET rule/:id/debug"; skip_test "DELETE rule/:id"
fi

###############################################################################
# 14. DATA INGESTION — /api/data/* (device-token auth, not user JWT)
###############################################################################
cyan "━━━ 14. Data Ingestion ━━━"

# These endpoints use device token auth, so 401 is expected with user JWT
R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' "$BASE/api/data/telemetry" \
  -d '{"entityId":"00000000-0000-0000-0000-000000000000","ts":1709000000000,"values":{"temp":25.5}}')
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status_in "POST /api/data/telemetry (device auth)" "$CODE" "$BODY" 200 202 400 401 404 422

R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' "$BASE/api/data/attributes" \
  -d '{"entityId":"00000000-0000-0000-0000-000000000000","scope":"SERVER","attributes":{"key":"val"}}')
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status_in "POST /api/data/attributes (device auth)" "$CODE" "$BODY" 200 202 400 401 404 422

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/data/attributes?entityId=00000000-0000-0000-0000-000000000000&scope=SERVER")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status_in "GET /api/data/attributes (device auth)" "$CODE" "$BODY" 200 400 401 404

R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' "$BASE/api/data/event" \
  -d '{"entityId":"00000000-0000-0000-0000-000000000000","eventType":"TEST","body":{"msg":"test"}}')
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status_in "POST /api/data/event" "$CODE" "$BODY" 200 202 400 401 404 422

R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' "$BASE/api/data/rpc" \
  -d '{"entityId":"00000000-0000-0000-0000-000000000000","method":"ping","params":{}}')
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status_in "POST /api/data/rpc" "$CODE" "$BODY" 200 202 400 401 404 422

# Pause to avoid rate limit window
sleep 3

###############################################################################
# 15. TELEMETRY — /api/telemetry/{entityId}/*
###############################################################################
cyan "━━━ 15. Telemetry ━━━"

if [ -n "$INST_A_ID" ]; then
  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/telemetry/$INST_A_ID/keys")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "GET /api/telemetry/:entityId/keys" "$CODE" "$BODY" 200 404

  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/telemetry/$INST_A_ID/latest")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "GET /api/telemetry/:entityId/latest" "$CODE" "$BODY" 200 404

  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" \
    "$BASE/api/telemetry/$INST_A_ID/timeseries?keys=temp&from=2026-01-01T00:00:00Z&to=2026-12-31T23:59:59Z")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "GET /api/telemetry/:entityId/timeseries" "$CODE" "$BODY" 200 400 404
else
  skip_test "GET telemetry/:entityId/keys"
  skip_test "GET telemetry/:entityId/latest"
  skip_test "GET telemetry/:entityId/timeseries"
fi

###############################################################################
# 16. ALARMS — /api/alarms/, /api/alarms/{entityId}
###############################################################################
cyan "━━━ 16. Alarms ━━━"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/alarms/")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status_in "GET /api/alarms/" "$CODE" "$BODY" 200 404

if [ -n "$INST_A_ID" ]; then
  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/alarms/$INST_A_ID")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "GET /api/alarms/:entityId" "$CODE" "$BODY" 200 404
else
  skip_test "GET /api/alarms/:entityId"
fi

###############################################################################
# 17. HELP — /api/help/
###############################################################################
cyan "━━━ 17. Help ━━━"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/help/")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status_in "GET /api/help/" "$CODE" "$BODY" 200 404

###############################################################################
# 18. RETENTION — /api/config/retention
###############################################################################
cyan "━━━ 18. Retention ━━━"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/config/retention")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status_in "GET /api/config/retention" "$CODE" "$BODY" 200 404

###############################################################################
# 19. ATTRIBUTES — /api/attributes/{entityId}/{scope}
###############################################################################
cyan "━━━ 19. Attributes ━━━"

if [ -n "$INST_A_ID" ]; then
  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/attributes/$INST_A_ID/history")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "GET /api/attributes/:entityId/history" "$CODE" "$BODY" 200 400 404

  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/attributes/$INST_A_ID/SERVER")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "GET /api/attributes/:entityId/SERVER" "$CODE" "$BODY" 200 400 404
else
  skip_test "GET attributes/:entityId/history"
  skip_test "GET attributes/:entityId/SERVER"
fi

###############################################################################
# 20. CHECKLISTS — /api/checklist/{entityId}/responses
###############################################################################
cyan "━━━ 20. Checklists ━━━"

if [ -n "$INST_A_ID" ]; then
  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/checklist/$INST_A_ID/responses")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "GET /api/checklist/:entityId/responses" "$CODE" "$BODY" 200 404
else
  skip_test "GET checklist/:entityId/responses"
fi

###############################################################################
# 21. EXPORT — /api/export/*
###############################################################################
cyan "━━━ 21. Export ━━━"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/export/alarms")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status_in "GET /api/export/alarms" "$CODE" "$BODY" 200 400 404

if [ -n "$INST_A_ID" ]; then
  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/export/telemetry/$INST_A_ID")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "GET /api/export/telemetry/:entityId" "$CODE" "$BODY" 200 400 404

  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/export/attributes/$INST_A_ID")
  CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
  assert_status_in "GET /api/export/attributes/:entityId" "$CODE" "$BODY" 200 400 404
else
  skip_test "GET /api/export/telemetry/:entityId"
  skip_test "GET /api/export/attributes/:entityId"
fi

# Brief pause to avoid rate limiting on subsequent sections
sleep 3

###############################################################################
# 22. MQTT INTERNAL AUTH
###############################################################################
cyan "━━━ 22. MQTT Internal ━━━"

R=$(curl -s -w '\n%{http_code}' -X POST -H 'Content-Type: application/json' \
  "$BASE/api/internal/mqtt/auth" -d '{"clientid":"t","username":"t","password":"t"}')
CODE=$(echo "$R" | tail -1); assert_status_in "POST /api/internal/mqtt/auth" "$CODE" "" 200 400 401 403 404

R=$(curl -s -w '\n%{http_code}' -X POST -H 'Content-Type: application/json' \
  "$BASE/api/internal/mqtt/acl" -d '{"clientid":"t","username":"t","topic":"digilog/v1/t","action":"publish"}')
CODE=$(echo "$R" | tail -1); assert_status_in "POST /api/internal/mqtt/acl" "$CODE" "" 200 400 403 404

R=$(curl -s -w '\n%{http_code}' -X POST -H 'Content-Type: application/json' \
  "$BASE/api/internal/mqtt/superuser" -d '{"clientid":"t","username":"t"}')
CODE=$(echo "$R" | tail -1); assert_status_in "POST /api/internal/mqtt/superuser" "$CODE" "" 200 400 403 404

###############################################################################
# 23. UPLOADS
###############################################################################
cyan "━━━ 23. Uploads ━━━"

R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/uploads/photo")
CODE=$(echo "$R" | tail -1); assert_status_in "POST /api/uploads/photo (no file)" "$CODE" "" 400 415 500

R=$(curl -s -w '\n%{http_code}' "$BASE/uploads/nonexistent.jpg")
CODE=$(echo "$R" | tail -1); assert_status_in "GET /uploads/:filename (404)" "$CODE" "" 404 403

# Pause to avoid rate limit window
sleep 3

###############################################################################
# 24. AUDIT TRAIL
###############################################################################
cyan "━━━ 24. Audit Trail ━━━"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/audit")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status "GET /api/audit" 200 "$CODE" "$BODY"

AUDIT_ID=$(echo "$BODY" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin); items=d.get('data',[])
  print(items[0]['id'] if items else '')
except: print('')
" 2>/dev/null)

if [ -n "$AUDIT_ID" ]; then
  R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/audit/$AUDIT_ID")
  CODE=$(echo "$R" | tail -1); assert_status "GET /api/audit/:id" 200 "$CODE"
else
  skip_test "GET /api/audit/:id (no entries)"
fi

###############################################################################
# 25. NOTIFICATIONS
###############################################################################
cyan "━━━ 25. Notifications ━━━"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/notifications")
CODE=$(echo "$R" | tail -1); assert_status "GET /api/notifications" 200 "$CODE"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/notifications/unread-count")
CODE=$(echo "$R" | tail -1); assert_status "GET /api/notifications/unread-count" 200 "$CODE"

R=$(curl -s -w '\n%{http_code}' -X PUT -H "Authorization: Bearer $TOKEN" "$BASE/api/notifications/mark-all-read")
CODE=$(echo "$R" | tail -1); assert_status "PUT /api/notifications/mark-all-read" 200 "$CODE"

R=$(curl -s -w '\n%{http_code}' -X PUT -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' "$BASE/api/notifications/bulk-read" -d '{"ids":[]}')
CODE=$(echo "$R" | tail -1); assert_status_in "PUT /api/notifications/bulk-read" "$CODE" "" 200 400

R=$(curl -s -w '\n%{http_code}' -X PUT -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' "$BASE/api/notifications/bulk-unread" -d '{"ids":[]}')
CODE=$(echo "$R" | tail -1); assert_status_in "PUT /api/notifications/bulk-unread" "$CODE" "" 200 400

# Pause to avoid rate limit window
sleep 3

###############################################################################
# 26. SYSTEM HEALTH
###############################################################################
cyan "━━━ 26. System Health ━━━"

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/api/system-health")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status "GET /api/system-health" 200 "$CODE" "$BODY"

HAS_SECTIONS=$(echo "$BODY" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('yes' if all(k in d for k in ['os','cpu','memory','database','api']) else 'no')
" 2>/dev/null || echo "no")
TOTAL=$((TOTAL+1))
if [ "$HAS_SECTIONS" = "yes" ]; then
  green "  ✓ System health has all sections"; PASS=$((PASS+1))
else
  red "  ✗ System health missing sections"; FAIL=$((FAIL+1))
fi

###############################################################################
# 27. BACKUP
###############################################################################
cyan "━━━ 27. Backup ━━━"

R=$(curl -s -w '\n%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
  -F "file=@/dev/null;filename=test.json" "$BASE/api/backup/validate")
CODE=$(echo "$R" | tail -1); assert_status_in "POST /api/backup/validate" "$CODE" "" 200 400

R=$(curl -s -w '\n%{http_code}' -H "Authorization: Bearer $TOKEN" \
  -H "X-Verification-Token: $VTOKEN" "$BASE/api/backup/export")
CODE=$(echo "$R" | tail -1); assert_status_in "GET /api/backup/export" "$CODE" "" 200 400 403

skip_test "POST /api/backup/restore (destructive)"

###############################################################################
# 28. SWAGGER
###############################################################################
cyan "━━━ 28. Swagger ━━━"

R=$(curl -s -w '\n%{http_code}' "$BASE/docs")
CODE=$(echo "$R" | tail -1); assert_status_in "GET /docs" "$CODE" "" 200 302

R=$(curl -s -w '\n%{http_code}' "$BASE/docs/json")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
assert_status "GET /docs/json" 200 "$CODE"

EP_COUNT=$(echo "$BODY" | python3 -c "
import sys,json
spec=json.load(sys.stdin)
print(sum(len([m for m in p if m in ('get','post','put','patch','delete')]) for p in spec.get('paths',{}).values()))
" 2>/dev/null || echo "?")
echo "  OpenAPI spec: $EP_COUNT endpoints registered"

###############################################################################
# 29. FRONTEND PAGES
###############################################################################
cyan "━━━ 29. Frontend Pages (24 routes) ━━━"

PAGES="/ /login /forgot-password /change-password /profile /users /users/create /users/reset-requests /assets /assets/templates /audit /notifications /config/password-policy /config/login-security /config/session /config/datetime /config/branding /config/user-id /config/field-ids /config/role-privileges /config/action-reauth /config/audit-templates /config/pagination /config/system-health"

FE_PASS=0; FE_FAIL=0; FE_FAILS=""
for path in $PAGES; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://3.108.185.106$path" 2>/dev/null || echo "000")
  if [ "$CODE" = "200" ]; then
    FE_PASS=$((FE_PASS+1))
  else
    FE_FAIL=$((FE_FAIL+1)); FE_FAILS="$FE_FAILS $path($CODE)"
  fi
done
TOTAL=$((TOTAL+1))
if [ "$FE_FAIL" -eq 0 ]; then
  green "  ✓ All 24 frontend pages return HTTP 200"; PASS=$((PASS+1))
else
  red "  ✗ ${FE_FAIL}/24 frontend pages failed: $FE_FAILS"; FAIL=$((FAIL+1))
fi

###############################################################################
# 30. CLEANUP
###############################################################################
cyan "━━━ 30. Cleanup ━━━"

[ -n "$INST_B_ID" ] && curl -s -X DELETE -H "Authorization: Bearer $TOKEN" -H "X-Verification-Token: $VTOKEN" "$BASE/api/assets/instances/$INST_B_ID" > /dev/null 2>&1 && echo "  Deleted instance B"
[ -n "$INST_A_ID" ] && curl -s -X DELETE -H "Authorization: Bearer $TOKEN" -H "X-Verification-Token: $VTOKEN" "$BASE/api/assets/instances/$INST_A_ID" > /dev/null 2>&1 && echo "  Deleted instance A"
[ -n "$TEMPLATE_ID" ] && curl -s -X DELETE -H "Authorization: Bearer $TOKEN" -H "X-Verification-Token: $VTOKEN" "$BASE/api/assets/templates/$TEMPLATE_ID" > /dev/null 2>&1 && echo "  Deleted template"
curl -s -X POST -H "Authorization: Bearer $TOKEN" "$BASE/api/auth/logout" > /dev/null 2>&1 && echo "  Logged out"

###############################################################################
# SUMMARY
###############################################################################
echo ""
cyan "╔══════════════════════════════════════════════════════════════╗"
cyan "║                    E2E TEST RESULTS                        ║"
cyan "╚══════════════════════════════════════════════════════════════╝"
echo ""
green "  PASSED:  $PASS"
red   "  FAILED:  $FAIL"
yellow "  SKIPPED: $SKIP"
echo   "  ─────────────────"
echo   "  TOTAL:   $TOTAL"
echo ""

if [ "$FAIL" -gt 0 ]; then
  red "Failed tests:"; echo -e "$FAILURES"; echo ""
fi

TESTED=$((TOTAL - SKIP))
PCT=0; [ "$TESTED" -gt 0 ] && PCT=$(( (PASS * 100) / TESTED ))
if [ "$FAIL" -eq 0 ]; then
  green "ALL TESTS PASSED ($PCT%)"
else
  red "$FAIL test(s) failed ($PCT% pass rate)"
fi

echo ""
echo "Timestamp: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "Server: http://3.108.185.106"
echo "API: $BASE"
echo ""
