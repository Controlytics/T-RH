# Global Success Dialog on Save — Design

**Date:** 2026-05-30 · **Branch:** RFID · **Status:** Approved — implementing

## Goal
After every successful save-type action (create / update / save / submit / assign / approve) anywhere in the app, show a **modal success dialog with an OK button** (user must acknowledge). Replace the current transient success toast for these cases.

## Key leverage point
All success feedback already funnels through one function — `toast.success(title, message)` in `useToastState()` (`hooks/use-toast.ts`), used at ~56 call sites. Changing what `toast.success` *renders* (a modal instead of a toast) makes the behavior app-wide with **zero per-site edits** for the common case.

## Architecture (Approach A — centralize at the toast layer)

1. **New `components/ui/success-dialog.tsx`** — `SuccessItem = { id, title, message? }` + `<SuccessDialog item onDismiss>`. Light-theme modal matching app dialogs: gradient header, white check icon, title, message (default "Your changes have been saved successfully." when no message), full-width **OK** button (`themeButton`). Dismiss on OK / backdrop click / Escape. Rendered at `z-[80]` (above the app's `z-[55]` dialogs). OK is `autoFocus` so Enter also confirms.

2. **`hooks/use-toast.ts`**
   - Add `successDialogs: SuccessItem[]` state + `dismissSuccess(id)`.
   - `toast.success(title, message)` → **enqueues a success dialog** (was: add toast).
   - Add `toast.successToast(title, message)` → non-blocking success **toast** (escape hatch for background events).
   - `error` / `warning` / `info` unchanged (toasts). SWR error wiring (`registerSwrToast(state.toast.error)`) unchanged.

3. **`components/toast-provider.tsx`** — also render `<SuccessDialog item={successDialogs[0]} onDismiss={dismissSuccess} />` when the queue is non-empty (one at a time; FIFO).

## Audit pass (only per-site work)
Reclassify the handful of **background / minor** successes where a blocking modal would annoy — e.g. "Data Synced", "Copied to clipboard", offline auto-sync — from `toast.success` to `toast.successToast`. Everything that is a real save keeps the modal. (Scan shows the large majority are real saves.)

## Edge cases
- **Flows with their own success popup** (a couple of approval flows): de-dupe so we don't show two modals.
- **Reauth / 21 CFR:** success fires only after the mutation resolves — no compliance impact.
- Same component on desktop + tablet/mobile wrapper.
- Multiple successes firing together: queued, shown one at a time.

## Out of scope
- Errors/warnings stay as toasts (user asked only for success).
- No auto-dismiss timer on the success modal — it requires OK (user's explicit choice), with Esc/backdrop as conveniences.

## Testing
- Component: `<SuccessDialog>` renders title/message + default message; OK / Esc / backdrop call `onDismiss`.
- Hook: `toast.success` pushes to `successDialogs` (not `toasts`); `toast.successToast` pushes a toast.
- Manual browser: save on 2+ screens → modal with OK; a sync/copy event still shows a quiet toast; no double-modals.
