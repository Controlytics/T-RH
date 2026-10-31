import { TEXT_CARD_MAX, customWidgetSchema, widgetsEqual, type CustomWidget } from '@digilog/shared';
import { stripHtml } from './sanitize.js';

/**
 * The schema's own cap on a widget title, read from `customWidgetSchema` so it
 * is never a second copy of the number. `Infinity` if the schema ever stops
 * capping it: the cut then does nothing and the re-validation below decides.
 */
export const WIDGET_TITLE_MAX: number =
  customWidgetSchema.innerType().innerType().shape.title.maxLength ?? Number.POSITIVE_INFINITY;

/**
 * HTML stripped, then cut to `max`, then trimmed. Cut AFTER stripping:
 * `stripHtml`'s fail-safe ESCAPES a value it cannot converge, and escaping
 * lengthens it (73 characters in, 121 out) — the dashboards module cuts its
 * own title and description the same way, for the same reason.
 */
const clean = (v: string, max: number): string => stripHtml(v).slice(0, max).trim();

/**
 * What a built widget SAYS — its title and a text card's text — with HTML
 * stripped, on every write of a widget (dashboard builder phase 2, R8-1): the
 * dashboards module's document and the two home layout routes'
 * `checkLayoutWrite`. Every other text field here is stripped on write
 * (`lib/sanitize.ts`); these were not. The browser draws both as text nodes
 * (never markup), so this is the stored record's hygiene — what the audit row,
 * an export or a mail template is handed — not the screen's only defence.
 *
 * A widget equal to the STORED widget of the same id is kept exactly as
 * stored. A write cleans what it changes and never rewrites what it keeps: an
 * arrangement saved by a non-super-admin echoes the stored widgets back, and
 * rewriting a stored title there would read as a widget change (a 403); a
 * dashboard save would audit a change nobody made.
 *
 * Each cleaned widget is parsed again by the shared schema, so a title or a
 * text that was nothing but markup is refused in the schema's own words
 * ("A widget needs a title") rather than stored empty — the forgiving reader
 * would then drop the widget on the next read, a 200 that loses it.
 */
export function cleanWidgetText(
  widgets: readonly CustomWidget[],
  stored: readonly CustomWidget[] | undefined,
): { ok: true; widgets: CustomWidget[] } | { ok: false; message: string } {
  const before = new Map((stored ?? []).map((w) => [w.id, w]));
  const out: CustomWidget[] = [];
  for (const [n, w] of widgets.entries()) {
    const was = before.get(w.id);
    if (was && widgetsEqual([was], [w])) {
      out.push(w);
      continue;
    }
    const title = clean(w.title, WIDGET_TITLE_MAX);
    const options = w.options.text === undefined ? w.options : { ...w.options, text: clean(w.options.text, TEXT_CARD_MAX) };
    const r = customWidgetSchema.safeParse({ ...w, title, options });
    if (!r.success) {
      return { ok: false, message: `Widget "${title || `#${n + 1}`}": ${r.error.issues[0]?.message ?? 'not a widget'}` };
    }
    out.push(r.data);
  }
  return { ok: true, widgets: out };
}
