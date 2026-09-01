import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  TREND_WIDGET_FIELDS, TREND_WIDGET_LABEL_DEFAULT, TREND_WIDGET_FIELD_LABEL,
} from '@digilog/shared';

/**
 * The pencil that renames a trend-page widget.
 *
 * Two things are worth a test here and neither is visible on a rendered page in
 * this dev environment, where the only account is a SUPER_ADMIN:
 *
 * 1. **It is HIDDEN from everyone who is not a SUPER_ADMIN.** Hiding it is
 *    presentation, not the control — the server's `requiredRole` on the def is
 *    what actually refuses the write — but a button that opens a dialog whose
 *    Save will 403 invites an operator to type a rename and lose it.
 *
 * 2. **A save MERGES.** The dynamic config route REPLACES `configValue` with the
 *    request body rather than patching it, so a PUT carrying one widget's fields
 *    alone would erase the other five widgets' labels. That failure is silent at
 *    the moment it happens and only shows up on a different screen later, which
 *    is exactly the kind this suite exists for.
 */

const authUser = { role: 'SUPER_ADMIN' } as { role: string };
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: authUser }) }));

/** The RAW stored row the dialog prefills from — deliberately carrying ANOTHER
 *  widget's label, so the merge assertion has something to lose. */
const storedRow: Record<string, unknown> = {
  alarmsTitle: 'Events in this period',
  tempCardTitle: 'Product Temperature',
  timeseriesTitle: 'Raw Log',
};

vi.mock('swr', () => ({
  default: () => ({ data: storedRow, isLoading: false, error: undefined }),
  useSWRConfig: () => ({ mutate: vi.fn(async () => {}) }),
}));

/** Typed, so `put.mock.calls[0]` is a real tuple and the assertions below do not
 *  need a cast that would compile against any shape at all. */
const put = vi.fn(async (_url: string, _body: Record<string, unknown>) => ({}));
vi.mock('@/lib/api-client', () => ({ apiClient: { put } }));
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }),
}));

const { WidgetSettingsButton } = await import('../widget-settings-button');

const asRole = (role: string) => { authUser.role = role; };

beforeEach(() => {
  put.mockClear();
  asRole('SUPER_ADMIN');
});

describe('WidgetSettingsButton — who can see it', () => {
  it('renders for a SUPER_ADMIN', () => {
    render(<WidgetSettingsButton widget="alarms" />);
    expect(screen.getByRole('button', { name: `Edit ${TREND_WIDGET_FIELDS.alarms.name} labels` }))
      .toBeInTheDocument();
  });

  /**
   * Every non-SUPER_ADMIN role this installation ships, not just one. A single
   * role would pass against a check that had been narrowed to exclude only that
   * one — the assertion is "everyone else", so the test says everyone else.
   */
  it.each(['ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER', 'QA'])(
    'renders NOTHING for %s',
    (role) => {
      asRole(role);
      const { container } = render(<WidgetSettingsButton widget="alarms" />);
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByRole('button')).toBeNull();
    },
  );

  it('renders nothing when there is no user at all', () => {
    // The pre-auth render. `undefined?.role` must not accidentally satisfy the
    // check the way a truthiness test would.
    asRole(undefined as unknown as string);
    const { container } = render(<WidgetSettingsButton widget="tempCard" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('WidgetSettingsButton — the dialog', () => {
  const open = (widget: 'alarms' | 'tempCard' = 'alarms') => {
    render(<WidgetSettingsButton widget={widget} />);
    fireEvent.click(screen.getByRole('button', { name: `Edit ${TREND_WIDGET_FIELDS[widget].name} labels` }));
  };

  it('lists exactly the fields that widget owns, and no others', () => {
    open('tempCard');
    // The temperature card owns one label. The alarms table's headings must not
    // appear in it — the dialog renders from TREND_WIDGET_FIELDS, so this is
    // what keeps a per-widget dialog per-widget.
    expect(screen.getByLabelText(TREND_WIDGET_FIELD_LABEL.tempCardTitle)).toBeInTheDocument();
    expect(screen.queryByLabelText(TREND_WIDGET_FIELD_LABEL.alarmsStatusHeading)).toBeNull();
  });

  it('prefills from the RAW row, leaving an unset field empty', () => {
    open();
    // Set in the row → shown.
    expect(screen.getByLabelText(TREND_WIDGET_FIELD_LABEL.alarmsTitle))
      .toHaveValue('Events in this period');
    // NOT in the row → empty, with the shipped wording only as a placeholder.
    // Prefilling this with the default would write the defaults into the row on
    // the next Save and quietly retire the blank-falls-back rule.
    const unset = screen.getByLabelText(TREND_WIDGET_FIELD_LABEL.alarmsStatusHeading);
    expect(unset).toHaveValue('');
    expect(unset).toHaveAttribute('placeholder', TREND_WIDGET_LABEL_DEFAULT.alarmsStatusHeading);
    // The LABEL names the field, the PLACEHOLDER is the shipped value. Labelling
    // the box "Status" would read as a value rather than as what it renames.
    expect(TREND_WIDGET_FIELD_LABEL.alarmsStatusHeading)
      .not.toBe(TREND_WIDGET_LABEL_DEFAULT.alarmsStatusHeading);
  });

  it('offers Inherit as the date and time format default', () => {
    open();
    expect(screen.getByLabelText('Date format')).toHaveValue('inherit');
    expect(screen.getByLabelText('Time format')).toHaveValue('inherit');
  });

  it('PUTs the whole row MERGED — the other widgets keep their labels', async () => {
    open();
    fireEvent.change(screen.getByLabelText(TREND_WIDGET_FIELD_LABEL.alarmsStatusHeading), {
      target: { value: 'State' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [url, body] = put.mock.calls[0];
    expect(url).toBe('/api/config/dynamic/trend-widgets');
    expect(body.alarmsStatusHeading).toBe('State');
    // The whole point: fields belonging to OTHER widgets survive the write.
    expect(body.tempCardTitle).toBe('Product Temperature');
    expect(body.timeseriesTitle).toBe('Raw Log');
  });

  it('writes the format override under the widget-specific key', async () => {
    open();
    fireEvent.change(screen.getByLabelText('Date format'), { target: { value: 'YYYY-MM-DD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const body = put.mock.calls[0][1];
    // `alarmsDateFormat`, not a shared `dateFormat` — six widgets, six keys.
    expect(body.alarmsDateFormat).toBe('YYYY-MM-DD');
    expect(body.tempCardDateFormat).toBeUndefined();
  });

  it('saves with apiClient.put, NOT putWithReauth', async () => {
    // The def sets `requiresReauth: false` and no `reauthAction`, matching every
    // other display-wording def, so the dynamic route asks for no signature.
    // A `putWithReauth` here would prompt for a password the server never wanted.
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]).toHaveLength(2);
  });
});
