import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

// Mirrors the API's annotated attribute row: `slot`/`decimals`/`display` are
// computed server-side for keys that hold a reading, absent for the rest.
type Row = {
  key: string; value: string; createdAt: string; updatedAt: string;
  slot?: 'temperature' | 'humidity' | null; decimals?: number | null; display?: string | null;
};
const rows = { current: [] as Row[] };
/**
 * The administered key list, as the PROFILE returns it. Read from the owning
 * profile since 2026-08-08 — each profile asks for its own keys, so the
 * suggestions here have to follow the instrument's profile rather than a single
 * global list.
 */
const profileKeys = { current: '' };
const mutate = vi.fn();

/**
 * The caller's own attribute rule, as `GET /attribute-access/me` returns it.
 * `mode: null` is the shipped state — not configured, so exactly the behaviour
 * this panel had before per-role access existed.
 */
const access = { current: { mode: null as string | null, keys: [] as string[], requireReauth: false } };
/** Configuration → Attribute Display Names, as the narrow-slice route returns it. */
const labels = { current: {} as Record<string, string> };

vi.mock('swr', () => ({
  // `key` is NULL when the instrument has no profile — the panel skips the fetch
  // rather than requesting `/api/instrument-profiles/undefined`. A mock typed
  // `(key: string)` threw on that, which is the mock being wrong, not the page.
  default: (key: string | null) => {
    if (key === null) return { data: undefined, mutate };
    if (key.includes('/attribute-access/me')) return { data: access.current, mutate };
    if (key === '/api/config/attribute-labels/current') return { data: { labels: labels.current }, mutate };
    return key.includes('/instrument-profiles/')
      ? { data: { attributeKeys: profileKeys.current }, mutate }
      : { data: { data: rows.current }, mutate };
  },
}));

/**
 * The real hook drives its prompt off the 401 the backend returns, which this
 * mock cannot produce — so it runs the callback straight through with no
 * password, which IS the production path whenever the role does not require
 * re-authentication. The retroactive 401 branch is the hook's own tested
 * behaviour.
 */
/** Every action `execute` was asked to run, and whether it hands the callback a password. */
const executed: string[] = [];
const withPassword = { current: false };
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (
      action: string,
      cb: (p?: string) => Promise<void>,
      opts?: { onSuccess?: () => void; onError?: (e: unknown) => void; onCancel?: () => void },
    ) => {
      executed.push(action);
      try { await cb(withPassword.current ? 'pw' : undefined); opts?.onSuccess?.(); } catch (e) { opts?.onError?.(e); }
    },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));

const post = vi.fn();
const postWithReauth = vi.fn();
const put = vi.fn();
const del = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    post: (...a: unknown[]) => post(...a),
    postWithReauth: (...a: unknown[]) => postWithReauth(...a),
    put: (...a: unknown[]) => put(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }),
}));

const { AttributesPanel } = await import('../attributes-panel');

const attr = (key: string, value: string) => ({
  key, value, createdAt: '2026-08-06T00:00:00.000Z', updatedAt: '2026-08-06T00:00:00.000Z',
});

beforeEach(() => {
  rows.current = [];
  profileKeys.current = '';
  access.current = { mode: null, keys: [], requireReauth: false };
  labels.current = {};
  post.mockReset().mockResolvedValue({});
  postWithReauth.mockReset().mockResolvedValue({});
  executed.length = 0;
  withPassword.current = false;
  put.mockReset().mockResolvedValue({});
  del.mockReset().mockResolvedValue({});
  mutate.mockReset().mockResolvedValue(undefined);
});

const REMARK = 'Corrected against the calibration certificate';

/** Type the mandatory remark into the dialog that is already open. */
const giveRemark = (text = REMARK) => {
  fireEvent.change(screen.getByRole('textbox', { name: /remarks/i }), { target: { value: text } });
};

/**
 * Row Delete opens the remark dialog; the dialog's own button does the work.
 *
 * The row button is matched by "Delete <key>", not a bare "Delete": it is an
 * icon button whose accessible name names the attribute it removes, because an
 * instrument carries two dozen of these and buttons that all announce "Delete"
 * are indistinguishable to anyone not looking at the row. Naming the key here
 * also makes the test stricter than it was — it now proves the RIGHT row's
 * button was pressed.
 */
const confirmDelete = (key: string, remark = REMARK) => {
  fireEvent.click(screen.getByRole('button', { name: `Delete ${key}` }));
  giveRemark(remark);
  fireEvent.click(screen.getByRole('button', { name: /^remove attribute$/i }));
};

/** Edit a row's value and carry it through the remark dialog. */
const editValue = (from: string, to: string, remark = REMARK) => {
  fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
  fireEvent.change(screen.getByDisplayValue(from), { target: { value: to } });
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
  giveRemark(remark);
  fireEvent.click(screen.getByRole('button', { name: /save change/i }));
};

describe('AttributesPanel', () => {
  describe('display names (2026-09-16)', () => {
    it('prints ONLY the configured display name, and a bare key as itself', () => {
      // Operator (2026-09-16): "in instruments page or settings page only
      // attributes display names should be display" — the key is not printed
      // beside it. It stays in the row's accessible names and in every request.
      rows.current = [attr('Enable_Temp_NMT', '1'), attr('Building', 'CWH Block')];
      labels.current = { Enable_Temp_NMT: 'High temperature alarm enabled' };
      render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
      expect(screen.getByText('High temperature alarm enabled')).toBeInTheDocument();
      expect(screen.queryByText('Enable_Temp_NMT')).not.toBeInTheDocument();
      expect(screen.getAllByText('Building')).toHaveLength(1);
    });

    it('names a configured-but-unfilled row by its display name too', () => {
      profileKeys.current = 'Room';
      labels.current = { Room: 'Cleanroom number' };
      render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
      expect(screen.getByText('Cleanroom number')).toBeInTheDocument();
    });

    it('still records the KEY when a display-named row is changed', async () => {
      rows.current = [attr('Room', '101')];
      labels.current = { Room: 'Cleanroom number' };
      render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
      editValue('101', '102');
      await waitFor(() => expect(put).toHaveBeenCalledWith(
        '/api/instruments/i-1/attributes/Room',
        expect.objectContaining({ value: '102' }),
      ));
    });
  });

  it('explains itself when empty rather than showing a bare table', () => {
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.getByText(/no attributes recorded/i)).toBeInTheDocument();
    expect(screen.getByText(/audited by key/i)).toBeInTheDocument();
  });

  it('adds an attribute', async () => {
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /add attribute/i }));
    fireEvent.change(screen.getByPlaceholderText(/key \(/i), { target: { value: 'Calibration Due' } });
    fireEvent.change(screen.getByPlaceholderText(/value \(/i), { target: { value: '2027-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/api/instruments/i-1/attributes', { key: 'Calibration Due', value: '2027-01-01' },
    ));
  });

  it('edits a value in place, keying the request on the attribute key', async () => {
    rows.current = [attr('Room', '204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    editValue('204', '205');
    await waitFor(() => expect(put).toHaveBeenCalledWith(
      '/api/instruments/i-1/attributes/Room', { value: '205', reason: REMARK },
    ));
  });

  // A key is free text — spaces and slashes are ordinary in one ("Calibration
  // Due", "kg/h"). Unencoded, a slash would split the URL into a route that
  // does not exist and the edit would 404 for no visible reason.
  it('URL-encodes the key on edit and delete', async () => {
    rows.current = [attr('Flow kg/h', '12')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    confirmDelete('Flow kg/h');
    await waitFor(() => expect(del).toHaveBeenCalledWith(
      '/api/instruments/i-1/attributes/Flow%20kg%2Fh', { reason: REMARK },
    ));
  });

  it('deletes an attribute after confirming in the dialog', async () => {
    rows.current = [attr('Room', '204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Room' }));
    // The row button only opens the dialog — nothing is destroyed by it alone.
    expect(del).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: /remarks/i })).toBeInTheDocument();

    // And it stays undestroyed until a remark is given: the dialog's own button
    // is not enough on its own.
    fireEvent.click(screen.getByRole('button', { name: /^remove attribute$/i }));
    expect(del).not.toHaveBeenCalled();

    giveRemark();
    fireEvent.click(screen.getByRole('button', { name: /^remove attribute$/i }));
    await waitFor(() => expect(del).toHaveBeenCalledWith(
      '/api/instruments/i-1/attributes/Room', { reason: REMARK },
    ));
  });

  // The whole point of replacing `window.confirm` is that the cancel path stays
  // as safe as it was — an unstyled dialog that no longer guards anything would
  // be a worse outcome than the OS one it replaced.
  it('deletes nothing when the confirm dialog is cancelled', async () => {
    rows.current = [attr('Room', '204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete Room' }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByText(/kept in the audit trail/i)).not.toBeInTheDocument());
    expect(del).not.toHaveBeenCalled();
  });

  // A dangling `pendingDelete` would re-open the dialog on the next render, and
  // the row it names is already gone.
  it('closes the dialog after a successful delete', async () => {
    rows.current = [attr('Room', '204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    confirmDelete('Room');
    await waitFor(() => expect(del).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('textbox', { name: /remarks/i })).not.toBeInTheDocument());
  });

  // The backend accepts an empty value on purpose ("we track this, we do not
  // know it yet"). A blank cell reads as a rendering fault, so it is marked.
  it('marks an empty value rather than rendering a blank cell', () => {
    rows.current = [attr('Serial', '')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.getByText('(empty)')).toBeInTheDocument();
  });

  it('reads without instruments.edit, but offers no mutation', () => {
    rows.current = [attr('Room', '204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit={false} />);
    expect(screen.getByText('Room')).toBeInTheDocument();
    expect(screen.getByText('204')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add attribute/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Room' })).not.toBeInTheDocument();
  });
});


/**
 * A key added in Configuration used to change the New Instrument form ONLY, so
 * an admin who added "Calibration Due" saw nothing happen on the instruments
 * already registered — the key existed and there was no way to reach it short
 * of retyping it by hand on every one.
 */
describe('AttributesPanel — configured keys this instrument does not have', () => {
  it('offers a configured key that is missing', () => {
    profileKeys.current = 'Calibration Due';
    rows.current = [attr('Room', 'B-204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.getByRole('textbox', { name: 'Calibration Due' })).toBeInTheDocument();
  });

  it('does not offer one the instrument already has, whatever the casing', () => {
    profileKeys.current = 'Room\ncalibration due';
    rows.current = [attr('Room', 'B-204'), attr('Calibration Due', '2027-01-01')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    // Asserted on the ROWS, not on a heading: a heading assertion here would
    // pass vacuously the moment the heading is removed, which is exactly what
    // happened when the two sections merged.
    expect(screen.queryByRole('textbox', { name: /room/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /calibration due/i })).not.toBeInTheDocument();
    expect(screen.getByText('B-204')).toBeInTheDocument();
    expect(screen.getByText('2027-01-01')).toBeInTheDocument();
  });

  // Block / Area / Location are COLUMNS, edited in Details. Offering them here
  // would write a second copy as an attribute that nothing reads.
  it('never offers the placement keys', () => {
    profileKeys.current = 'Block\nArea\nLocation';
    rows.current = [];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    for (const k of ['Block', 'Area', 'Location']) {
      expect(screen.queryByRole('textbox', { name: k })).not.toBeInTheDocument();
    }
    // Nothing to list at all, so the empty explanation stands.
    expect(screen.getByText(/no attributes recorded/i)).toBeInTheDocument();
  });

  it('saves a filled-in key as an ordinary attribute', async () => {
    profileKeys.current = 'Calibration Due';
    rows.current = [];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Calibration Due' }), { target: { value: '2027-06-30' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^save$/i })[0]);
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/api/instruments/i-1/attributes', { key: 'Calibration Due', value: '2027-06-30' },
    ));
  });

  // Absent is the truth ("nobody has said yet"); an empty string is a recorded
  // fact in a §11 trail ("this was checked and is blank").
  it('will not write a blank value', () => {
    profileKeys.current = 'Calibration Due';
    rows.current = [];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.getAllByRole('button', { name: /^save$/i })[0]).toBeDisabled();
  });

  it('offers nothing without instruments.edit', () => {
    profileKeys.current = 'Calibration Due';
    rows.current = [];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit={false} />);
    expect(screen.queryByRole('textbox', { name: 'Calibration Due' })).not.toBeInTheDocument();
    expect(screen.getByText(/no attributes recorded/i)).toBeInTheDocument();
  });
});

describe('AttributesPanel — suggestions come from the profile', () => {
  it('suggests a non-placement profile key the instrument is missing', () => {
    profileKeys.current = 'Slave ID';
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.getByRole('textbox', { name: /slave id/i })).toBeInTheDocument();
  });

  it('offers nothing when the instrument has no profile', () => {
    // Defensive: the fetch is skipped entirely, so there are no suggestions
    // rather than a request for `/api/instrument-profiles/undefined`.
    profileKeys.current = 'Slave ID';
    render(<AttributesPanel instrumentId="i-1" profileId="" canEdit />);
    expect(screen.queryByRole('textbox', { name: /slave id/i })).not.toBeInTheDocument();
  });

  it('keeps rendering an attribute the profile no longer asks for', () => {
    // Recorded data is never hidden by a profile change — only suggestions move.
    // This is the "prompts, not values" rule at the UI layer.
    profileKeys.current = 'Slave ID';
    rows.current = [attr('Legacy Tag', 'X-9')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.getByText('Legacy Tag')).toBeInTheDocument();
    expect(screen.getByText('X-9')).toBeInTheDocument();
  });
});


/**
 * ONE LIST (2026-08-19). The unset profile keys used to sit in a dashed block
 * BELOW the table, which read as a different KIND of thing — the operator saw a
 * key they had typed on the instrument "not going into" the profile section. It
 * is one table now, and these are the properties that keep it one.
 */
describe('AttributesPanel — recorded and unset keys are one list', () => {
  it('puts an unset profile key in the same table as the recorded ones', () => {
    profileKeys.current = 'Calibration Due';
    rows.current = [attr('Room', 'B-204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    const table = screen.getByRole('table');
    // Both rows under the SAME table element — the assertion the split layout
    // could not have satisfied.
    expect(within(table).getByText('Room')).toBeInTheDocument();
    expect(within(table).getByText('Calibration Due')).toBeInTheDocument();
    expect(within(table).getByRole('textbox', { name: 'Calibration Due' })).toBeInTheDocument();
    expect(screen.getAllByRole('table')).toHaveLength(1);
  });

  it('reads in the profile order, with instrument-only keys after it', () => {
    profileKeys.current = 'Slave ID\nCalibration Due';
    rows.current = [attr('Legacy Tag', 'X-9'), attr('Calibration Due', '2027-01-01')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    const keys = screen.getAllByRole('row').slice(1)
      .map((r) => (r as HTMLTableRowElement).cells[0].textContent);
    expect(keys).toEqual(['Slave ID', 'Calibration Due', 'Legacy Tag']);
  });

  it('keeps a key typed on this instrument visible even though the profile has none', () => {
    // The operator's case: add a key here and it must appear in the list, not
    // look as though it went somewhere else.
    profileKeys.current = '';
    rows.current = [attr('temp_decimals', '0')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('temp_decimals')).toBeInTheDocument();
    expect(within(table).getByText('0')).toBeInTheDocument();
  });

  it('distinguishes a key never answered from one recorded as blank', () => {
    // The distinction the merge must not lose. "Not set" = nobody has said;
    // "(empty)" = someone checked and it was blank, which is a §11 fact.
    profileKeys.current = 'Calibration Due';
    rows.current = [attr('Room', '')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.getByText('(empty)')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Calibration Due' }))
      .toHaveAttribute('placeholder', 'Not set');
  });

  it('counts only what is recorded, not the prompts', () => {
    profileKeys.current = 'Calibration Due\nSlave ID';
    rows.current = [attr('Room', 'B-204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.getByText(/Attributes \(1 set\)/)).toBeInTheDocument();
  });
});

describe('AttributesPanel — case-variant keys are all still shown', () => {
  it('never swallows a recorded attribute that differs from another only by case', () => {
    // The attributes table's unique index is (instrument_id, key) and Postgres
    // compares case, so an instrument really can carry both. Matching the
    // profile's key case-insensitively must claim ONE of them, not silence the
    // other — a recorded value is a §11 record and this screen is where it is read.
    profileKeys.current = 'Room';
    rows.current = [attr('Room', 'B-204'), attr('room', 'B-205')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.getByText('B-204')).toBeInTheDocument();
    expect(screen.getByText('B-205')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + both
  });

  it('offers no unset prompt for a profile key some casing of which is already recorded', () => {
    profileKeys.current = 'Room';
    rows.current = [attr('room', 'B-205')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.queryByRole('textbox', { name: /room/i })).not.toBeInTheDocument();
    expect(screen.getByText('B-205')).toBeInTheDocument();
  });
});

/**
 * A limit or a range is a reading, so it is shown at the instrument's own
 * precision. The API resolves it; this panel must render `display` and keep
 * `value` as the thing it edits and saves.
 */
describe('AttributesPanel — limits and ranges follow the decimals attributes', () => {
  const withDisplay = (key: string, value: string, display: string | null) => ({
    ...attr(key, value), slot: 'temperature' as const, decimals: 1, display,
  });

  it('renders the formatted value, not the raw one', () => {
    rows.current = [withDisplay('High Temperature Limit', '25', '25.0')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.getByText('25.0')).toBeInTheDocument();
    expect(screen.queryByText('25')).not.toBeInTheDocument();
  });

  it('edits from the STORED value, so saving cannot rewrite the record to a display string', () => {
    rows.current = [withDisplay('High Temperature Limit', '25', '25.0')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(screen.getByRole('textbox')).toHaveValue('25');
  });

  it('falls back to the raw value for an attribute the server did not classify', () => {
    rows.current = [attr('Slave ID', '3')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('still marks a recorded blank as (empty) rather than showing nothing', () => {
    rows.current = [{ ...attr('High Temperature Limit', ''), slot: 'temperature' as const, decimals: 1, display: null }];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.getByText('(empty)')).toBeInTheDocument();
  });
});


/**
 * The per-role rule (2026-08-19). The SERVER is the control; these assert the
 * panel offers exactly what the server would allow, because an Edit button that
 * leads to a 403 reads as the app being broken rather than as a policy.
 */
describe('AttributesPanel — per-role attribute access', () => {
  it('offers everything when the role is not configured — exactly as before', () => {
    rows.current = [attr('Room', '204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Room' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add attribute/i })).toBeInTheDocument();
  });

  it('ALL_VIEW leaves no way to change anything, and says so on the row', () => {
    access.current = { mode: 'ALL_VIEW', keys: [], requireReauth: false };
    rows.current = [attr('Room', '204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Room' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add attribute/i })).not.toBeInTheDocument();
    // The Actions COLUMN is gone entirely, rather than a column of "View only"
    // against every row. The per-row marker exists for the SELECTED case below,
    // where it explains why one row has buttons and its neighbour does not.
    expect(screen.queryByRole('columnheader', { name: /actions/i })).not.toBeInTheDocument();
  });

  it('SELECTED offers the named key and protects the rest, in the same table', () => {
    access.current = { mode: 'SELECTED', keys: ['Room'], requireReauth: false };
    rows.current = [attr('Room', '204'), attr('High Temperature Limit', '25')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.getAllByRole('button', { name: /^edit$/i })).toHaveLength(1);
    expect(screen.getByText(/view only/i)).toBeInTheDocument();
  });

  it('SELECTED still offers Add — a new key cannot overwrite a protected one', () => {
    access.current = { mode: 'SELECTED', keys: ['Room'], requireReauth: false };
    rows.current = [attr('Room', '204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.getByRole('button', { name: /add attribute/i })).toBeInTheDocument();
  });

  it('a role without Edit Instruments stays read-only whatever the mode says', () => {
    // The rule NARROWS the permission and must never be a second route to it.
    access.current = { mode: 'ALL_EDIT', keys: [], requireReauth: false };
    rows.current = [attr('Room', '204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit={false} />);
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add attribute/i })).not.toBeInTheDocument();
  });

  it('does not offer an unset profile key to a view-only role', () => {
    access.current = { mode: 'ALL_VIEW', keys: [], requireReauth: false };
    profileKeys.current = 'Calibration Due';
    rows.current = [];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    expect(screen.queryByRole('textbox', { name: 'Calibration Due' })).not.toBeInTheDocument();
  });
});

describe('AttributesPanel — the remark is mandatory', () => {
  it('refuses to submit a change until a usable remark is given', async () => {
    rows.current = [attr('Room', '204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    fireEvent.change(screen.getByDisplayValue('204'), { target: { value: '205' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    fireEvent.click(screen.getByRole('button', { name: /save change/i }));
    expect(put).not.toHaveBeenCalled();
    // And it says why rather than silently doing nothing.
    expect(screen.getByText(/at least 5 characters/i)).toBeInTheDocument();

    giveRemark();
    fireEvent.click(screen.getByRole('button', { name: /save change/i }));
    await waitFor(() => expect(put).toHaveBeenCalled());
  });

  it('treats whitespace as no remark at all', () => {
    rows.current = [attr('Room', '204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    giveRemark('        ');
    fireEvent.click(screen.getByRole('button', { name: /save change/i }));
    expect(put).not.toHaveBeenCalled();
  });

  it('does NOT ask for one when a key is added for the first time', async () => {
    // Registration, not a change. Demanding a reason on every key of a new
    // instrument teaches people to type "x".
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /add attribute/i }));
    fireEvent.change(screen.getByPlaceholderText(/key \(/i), { target: { value: 'Supplier Ref' } });
    fireEvent.change(screen.getByPlaceholderText(/value \(/i), { target: { value: 'SR-1' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/api/instruments/i-1/attributes', { key: 'Supplier Ref', value: 'SR-1' },
    ));
    expect(screen.queryByRole('textbox', { name: /remarks/i })).not.toBeInTheDocument();
  });

  it('does NOT ask for one when filling a configured key that was never set', async () => {
    profileKeys.current = 'Calibration Due';
    rows.current = [];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Calibration Due' }), { target: { value: '2027-06-30' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^save$/i })[0]);
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(screen.queryByRole('textbox', { name: /remarks/i })).not.toBeInTheDocument();
  });

  it('shows what is being replaced, so the remark is written against the real change', () => {
    rows.current = [attr('Room', '204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    fireEvent.change(screen.getByDisplayValue('204'), { target: { value: '205' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(screen.getByText('204')).toBeInTheDocument();
    expect(screen.getByText('205')).toBeInTheDocument();
  });

  it('does not carry a remark over from the previous change', () => {
    // A reason typed for one attribute and submitted against another is a wrong
    // reason in a §11 record — worse than no dialog.
    rows.current = [attr('Room', '204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    giveRemark('First reason, typed and abandoned');
    // The DIALOG's Cancel — the edit row behind it has one of its own.
    const dialog = screen.getByRole('textbox', { name: /remarks/i }).closest('div[role="dialog"], div');
    fireEvent.click(within(dialog as HTMLElement).getAllByRole('button', { name: /cancel/i })[0]);

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(screen.getByRole('textbox', { name: /remarks/i })).toHaveValue('');
  });
});

/**
 * Audit 2026-10-12, finding 2: Fill and Add went out as bare `apiClient.post`.
 * The server re-authenticates EVERY attribute write (POST included) as
 * UPDATE_INSTRUMENT_ATTRIBUTE when the role's Attribute Access asks for it, so
 * those two never reached the password dialog and failed with a bare 401. And
 * Add on a key the instrument already carries is an OVERWRITE, for which the
 * server demands a remark the panel never asked for.
 */
describe('AttributesPanel — Fill and Add are signed like every other write', () => {
  it('fills an unset key through the re-auth hook', async () => {
    profileKeys.current = 'Calibration Due';
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Calibration Due' }), { target: { value: '2027-06-30' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^save$/i })[0]);
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(executed).toEqual(['UPDATE_INSTRUMENT_ATTRIBUTE']);
  });

  it('sends the password with a fill when the dialog collected one', async () => {
    withPassword.current = true;
    profileKeys.current = 'Calibration Due';
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Calibration Due' }), { target: { value: '2027-06-30' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^save$/i })[0]);
    await waitFor(() => expect(postWithReauth).toHaveBeenCalledWith(
      '/api/instruments/i-1/attributes', { key: 'Calibration Due', value: '2027-06-30' }, 'pw',
    ));
    expect(post).not.toHaveBeenCalled();
  });

  it('adds a new key through the re-auth hook, with the password when given', async () => {
    withPassword.current = true;
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /add attribute/i }));
    fireEvent.change(screen.getByPlaceholderText(/key \(/i), { target: { value: 'Supplier Ref' } });
    fireEvent.change(screen.getByPlaceholderText(/value \(/i), { target: { value: 'SR-1' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(postWithReauth).toHaveBeenCalledWith(
      '/api/instruments/i-1/attributes', { key: 'Supplier Ref', value: 'SR-1' }, 'pw',
    ));
    expect(executed).toEqual(['UPDATE_INSTRUMENT_ATTRIBUTE']);
  });

  it('asks for a remark when Add would overwrite a recorded key, and sends it', async () => {
    rows.current = [attr('Room', '204')];
    render(<AttributesPanel instrumentId="i-1" profileId="p-1" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: /add attribute/i }));
    fireEvent.change(screen.getByPlaceholderText(/key \(/i), { target: { value: 'Room' } });
    fireEvent.change(screen.getByPlaceholderText(/value \(/i), { target: { value: '205' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^save$/i })[0]);
    // Nothing goes out until the remark is given.
    expect(post).not.toHaveBeenCalled();
    giveRemark();
    fireEvent.click(screen.getByRole('button', { name: /save change/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(
      '/api/instruments/i-1/attributes', { key: 'Room', value: '205', reason: REMARK },
    ));
    expect(executed).toEqual(['UPDATE_INSTRUMENT_ATTRIBUTE']);
  });
});
