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
