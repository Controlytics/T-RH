import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { builtinReportTemplate, type ReportTemplateRow, type TemplateKind } from '@digilog/shared';
import { ReportTemplateLines } from '../report-template-lines';
import { BUILTIN_TEMPLATE_PICK, type PlanSection } from '@/lib/report-template-plan';

/**
 * The template lines every download dialog shows (2026-11-03, extracted from
 * the widget dialog, whose own tests pin the per-profile lines): here, the
 * APPLICATION-WIDE section the Alarm Report and Audit Trail get — named as
 * such, keyed `application`, its editor link with no profile.
 */

const row = (id: string, kind: TemplateKind, isDefault = false): ReportTemplateRow => ({
  id, kind, profileId: null, name: id === 'a1' ? 'Audit A' : 'Audit B', isDefault, document: builtinReportTemplate(kind),
  createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z', updatedBy: 'admin',
});
const A = row('a1', 'page:audit-trail', true);
const B = row('a2', 'page:audit-trail');
const app = (over: Partial<PlanSection> = {}): PlanSection => ({
  profileId: null, profileName: null, instrumentIds: [], resolved: A, templates: [A, B], availableIds: [], ...over,
});

const mount = (sections: PlanSection[], props: { picks?: Record<string, string>; superAdmin?: boolean; onPick?: (k: string, v: string) => void } = {}) => render(
  <MemoryRouter>
    <ReportTemplateLines
      kind="page:audit-trail" sections={sections} picks={props.picks ?? {}} onPick={props.onPick ?? vi.fn()}
      loading={false} failed={false} superAdmin={props.superAdmin ?? false}
    />
  </MemoryRouter>,
);

describe('ReportTemplateLines — an application-wide kind', () => {
  it('names the template "(application-wide)", offers its picker keyed `application`, and prints the pick', () => {
    const onPick = vi.fn();
    const { rerender } = mount([app()], { onPick });
    expect(screen.getByText('Template: Audit A (application-wide)')).toBeInTheDocument();
    const picker = screen.getByRole('combobox', { name: 'Template (application-wide)' });
    expect((picker as HTMLSelectElement).value).toBe('a1');
    fireEvent.change(picker, { target: { value: 'a2' } });
    expect(onPick).toHaveBeenCalledWith('application', 'a2');
    rerender(
      <MemoryRouter>
        <ReportTemplateLines kind="page:audit-trail" sections={[app()]} picks={{ application: BUILTIN_TEMPLATE_PICK }} onPick={onPick} loading={false} failed={false} superAdmin={false} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Template: Built-in (application-wide)')).toBeInTheDocument();
  });

  it('no default and one template: "Built-in", no picker; a SUPER_ADMIN\'s link names the kind and NO profile', () => {
    mount([app({ resolved: null, templates: [B] })], { superAdmin: true });
    expect(screen.getByText('Template: Built-in (application-wide)')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
    const link = screen.getByRole('link', { name: 'Edit the application-wide report templates' });
    expect(link.getAttribute('href')).toBe('/config/report-templates?kind=page%3Aaudit-trail');
  });

  it('says so while loading, and when the templates could not be loaded', () => {
    const { rerender } = render(
      <MemoryRouter><ReportTemplateLines kind="page:alarms" sections={[]} picks={{}} onPick={vi.fn()} loading failed={false} superAdmin={false} /></MemoryRouter>,
    );
    expect(screen.getByText('Loading the report templates…')).toBeInTheDocument();
    rerender(<MemoryRouter><ReportTemplateLines kind="page:alarms" sections={[]} picks={{}} onPick={vi.fn()} loading={false} failed superAdmin={false} /></MemoryRouter>);
    expect(screen.getByRole('alert')).toHaveTextContent('The report templates could not be loaded.');
  });
});

/**
 * An instrument the LOADED plan left out — `/resolve` named no profile for it
 * (whole-branch review m2): its own line naming its code, beside the lines of
 * the instruments that did resolve. Never "could not be loaded" (the plan
 * loaded) and never "No instruments in this selection" (it has one).
 */
describe('ReportTemplateLines — instruments the plan left out', () => {
  const profile = (over: Partial<PlanSection> = {}): PlanSection => ({
    profileId: 'p1', profileName: 'T&RH', instrumentIds: ['i1'], resolved: null, templates: [], availableIds: [], ...over,
  });
  const lines = (props: { sections: PlanSection[]; leftOut?: string[]; loading?: boolean; failed?: boolean }) => (
    <MemoryRouter>
      <ReportTemplateLines
        kind="page:data-report" sections={props.sections} picks={{}} onPick={vi.fn()}
        loading={props.loading ?? false} failed={props.failed ?? false} superAdmin={false} leftOut={props.leftOut}
      />
    </MemoryRouter>
  );

  it('names EACH left-out instrument on its own line, beside the template line of the ones that resolved', () => {
    render(lines({ sections: [profile()], leftOut: ['CWH/RDU/002-00', 'CWH/RDU/003-00'] }));
    const alerts = screen.getAllByRole('alert');
    expect(alerts.map((a) => a.textContent)).toEqual([
      'No instrument profile resolved for CWH/RDU/002-00 — the report will be refused',
      'No instrument profile resolved for CWH/RDU/003-00 — the report will be refused',
    ]);
    expect(screen.getByTestId('report-template-line')).toHaveTextContent('Template: Built-in (T&RH)');
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });

  it('a plan with NO section for the one instrument: its line, never "No instruments in this selection"', () => {
    render(lines({ sections: [], leftOut: ['DEMO-TH-142'] }));
    expect(screen.getByRole('alert')).toHaveTextContent('No instrument profile resolved for DEMO-TH-142 — the report will be refused');
    expect(screen.queryByText(/No instruments in this selection/)).toBeNull();
  });

  it('loading and failure keep their own words — no left-out line under either', () => {
    const { rerender } = render(lines({ sections: [], leftOut: ['DEMO-TH-142'], loading: true }));
    expect(screen.getByText('Loading the report templates…')).toBeInTheDocument();
    expect(screen.queryByText(/No instrument profile resolved/)).toBeNull();
    rerender(lines({ sections: [], leftOut: ['DEMO-TH-142'], failed: true }));
    expect(screen.getByRole('alert')).toHaveTextContent('The report templates could not be loaded.');
    expect(screen.queryByText(/No instrument profile resolved/)).toBeNull();
  });
});
