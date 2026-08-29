#!/usr/bin/env bash
# UI design-system conformance sweep — apps/web, WHOLE TREE.
#
# Re-derives the findings of the 2026-08-29 sweep (90d6f2c). Run it whenever the
# design system or a batch of screens changes; it is counts-first so it stays
# readable. Deliberate keeps are documented in tasks/ui-redesign-stage2.md
# ("Excluded on purpose", "Left un-migrated ON PURPOSE", Tier 9) and in
# 90d6f2c's "Checked and deliberately left" — a hit on one of those is NOT a
# defect. The allowlist below encodes them so the report shows only the delta.
#
# The scoping matters: sweep the WHOLE tree, not the files a pass touched.
# Auditing only the files a pass touched is what let two segmented controls and
# two primitives survive three earlier passes.
set -uo pipefail
cd "$(dirname "$0")/../apps/web/src" || exit 1

SRC=$(find . -name '*.tsx' -not -path './*/__tests__/*')

hdr() { printf '\n=== %s ===\n' "$1"; }

# --- ALLOWLIST -------------------------------------------------------------
# Decided, with a reason in code or in tasks/ui-redesign-stage2.md.
ALLOW='aria-\[invalid\]|ring-rose|placeholder=.#1e3a5f|border-2 border-white|--chart-|\.tv-|band-marker|ACTION_COLORS'
ALLOW_FILES='routes/dashboard/|routes/login|routes/forgot-password|routes/contact-admin'

hdr "1. Hardcoded focus accents on controls (rose excluded — that is the error ring)"
grep -rnE 'focus:(ring|border)-(indigo|cyan|blue|violet|purple|sky|emerald|green|teal|amber|orange|fuchsia)' $SRC | grep -vE "$ALLOW"

hdr "2. Off-scale control geometry (system is h-10/h-8, ring-2, radius 6px)"
grep -rnE '<(input|select|textarea|Input|Select)[^>]*(h-(9|11|12|14)|ring-4|ring-\[3px\])' $SRC
grep -rnE 'ring-4|ring-\[3px\]' $SRC | grep -vE "$ALLOW"

hdr "3. Raw controls with no .ctl and no primitive (sr-only/peer/hidden/file are deliberate)"
# MUST be element-aware, not line-aware: a JSX control routinely carries its
# className on a continuation line, and a line-based grep reports every one of
# them as a miss. ldap.tsx alone produced 18 such false positives.
# The `>` of an arrow function inside a prop (onChange={(e) => ...}) is NOT the
# end of the tag. Consuming to the first `>` cut every such element off before
# its className and reported 152 conforming controls as misses.
perl -0777 -ne 'while (/<(input|select|textarea)\b((?:[^>]|(?<==)>)*?)\/?(?<!=)>/gs) {
    my ($tag,$attrs) = ($1,$2);
    next if $attrs =~ /\bctl\b|sr-only|peer|hidden|type="file"|type="color"/;
    # Tier 8 moved ~20 call sites by pointing ONE module-level constant at .ctl
    # (`const field = ctl w-full`). className={field} is conformant; resolve the
    # indirection rather than reporting every one of its call sites.
    if ($attrs =~ /className=\{`?\$?\{?(\w+)/ && /^\s*const\s+$1\s*=\s*[^;]*\bctl\b/m) { next; }
    my $pre = substr($_,0,pos($_)); my $ln = ($pre =~ tr/\n//) + 1;
    print "$ARGV:$ln: <$tag>\n";
  }' $SRC | grep -vE \
  "components/ui/(checkbox|input|radio|select|searchable-select)\.tsx" `# the primitives ARE the styling` \
  | grep -vE "background-upload-section" `# file input, styled via file: variants` \
  | grep -vE "dynamic-config\.tsx" `# hand-rolls .ctl inline; no Textarea primitive yet, reason in code` \
  | grep -vE "floorplans\.tsx" `# type=range tracing-guide slider; .ctl does not describe a slider` \
  | grep -vE "users/edit\.tsx" `# the match is inside a comment` \
  | grep -vE "audit-filters\.tsx" `# date inputs INSIDE a bordered composite; the wrapper carries the shape`

hdr "4. Gradient-clipped values (bg-clip-text renders lighter than solid ink)"
grep -rnE 'bg-clip-text' $SRC | grep -vE "$ALLOW_FILES"

hdr "5. Hardcoded hex colours in TSX"
grep -rnoE '#[0-9a-fA-F]{6}' $SRC | grep -vE "$ALLOW" | sed 's/.*://' | sort | uniq -c | sort -rn | head -30

hdr "6. Raw Tailwind shadows (elevation is --elev-1/2/3)"
grep -rnE 'shadow-(sm|md|lg|xl|2xl)' $SRC | grep -vE 'shadow-soft|shadow-elevated'

hdr "7. Raw tables without .tbl"
for f in $(grep -rlE '<table' $SRC); do grep -qE 'tbl' "$f" || echo "$f"; done

hdr "8. rounded-2xl/3xl outside the dashboard panel cards"
grep -rnE 'rounded-(2xl|3xl)' $SRC | grep -vE "$ALLOW_FILES"

hdr "9. Active-state button styling with no ARIA state (the segmented-control miss)"
for f in $(grep -rlE '<button' $SRC); do
  if grep -qE 'isActive|active \?|selected \?|=== (tab|mode|view|window|channel)' "$f" && ! grep -qE 'aria-pressed|aria-selected|role="tab"' "$f"; then echo "$f"; fi
done

hdr "10. Toggle switches — one control, one colour"
# The switch is drawn with peer-checked:, not translate-x-N; an earlier version
# of this sweep keyed on the latter and reported the toggles clean when two of
# the three were still blue and green.
grep -rnoE 'peer-checked:bg-[a-zA-Z0-9\[(#,.%_-]+' $SRC

hdr "11. Hardcoded accents ANYWHERE in the ui/ primitives, not just on :focus"
# A primitive with its own accent is the drift these components exist to
# prevent, and it does not only live on the focus ring: SearchableSelect's
# trigger was themed in 90d6f2c while its chevron and option rows stayed indigo.
grep -rnE '(bg|text|border|ring)-(indigo|cyan|violet|purple|sky|fuchsia|blue)-[0-9]' ./components/ui/*.tsx | grep -vE "$ALLOW"
