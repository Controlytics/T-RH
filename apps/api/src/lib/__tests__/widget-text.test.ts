import { describe, it, expect } from 'vitest';
import { TEXT_CARD_MAX, customWidgetSchema, type CustomWidget } from '@digilog/shared';
import { cleanWidgetText, WIDGET_TITLE_MAX } from '../widget-text.js';

/**
 * R8-1 (dashboard builder phase 2): what a widget SAYS — its title and a text
 * card's text — is stripped of HTML on every write, the rule every text field
 * here follows (`lib/sanitize.ts`). Widgets the write leaves exactly as stored
 * are kept as stored, so a save that changes nothing changes nothing.
 */
const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const text = (t: string, title = 'Note', id = ID): CustomWidget =>
  customWidgetSchema.parse({ id, type: 'text_card', title, source: { mode: 'selection' }, keys: [], options: { text: t } });
const grid = (title: string, id = ID2): CustomWidget =>
  customWidgetSchema.parse({ id, type: 'status_grid', title, source: { mode: 'selection' }, keys: [], options: {} });

/** Four raw tags and a five-deep encoded one: the sanitizer's fail-safe ESCAPES it, 73 characters in, 121 out. */
const GROWS = `${'<i>a</i>'.repeat(4)}&amp;amp;amp;amp;lt;b&amp;amp;amp;amp;gt;`;

describe('cleanWidgetText', () => {
  it('strips HTML from a title and a text card\'s text, keeping the text\'s lines', () => {
    const r = cleanWidgetText([text('<script>alert(1)</script>Hand over <b>at</b> 06:00\nLine 2', '<b>Shift</b> note')], undefined);
    expect(r).toEqual({ ok: true, widgets: [text('Hand over at 06:00\nLine 2', 'Shift note')] });
  });

  it('keeps ordinary text as typed (an ampersand, a bare angle bracket)', () => {
    const w = text('R&D < 25 °C & "dry"', 'R&D');
    expect(cleanWidgetText([w], undefined)).toEqual({ ok: true, widgets: [w] });
  });

  it('a widget equal to the stored one of the same id is kept as stored, markup and all', () => {
    const stored = [text('<b>x</b>', '<i>old</i>')];
    const r = cleanWidgetText([text('<b>x</b>', '<i>old</i>'), grid('<u>new</u>')], stored);
    expect(r).toEqual({ ok: true, widgets: [stored[0], grid('new')] });
    // A changed widget with that id is cleaned.
    expect(cleanWidgetText([text('<b>y</b>', '<i>old</i>')], stored)).toEqual({ ok: true, widgets: [text('y', 'old')] });
  });

  it('a title or a text that is nothing but markup is refused in the schema\'s words', () => {
    expect(cleanWidgetText([grid('<b></b>')], undefined)).toEqual({ ok: false, message: 'Widget "#1": A widget needs a title' });
    expect(cleanWidgetText([grid('Fine'), text('<img src=x onerror=alert(1)>', 'Card')], undefined))
      .toEqual({ ok: false, message: 'Widget "Card": Write the card\'s text' });
  });

  it('cuts AFTER stripping: the sanitizer\'s fail-safe escaping can lengthen a value past the schema\'s cap', () => {
    expect(WIDGET_TITLE_MAX).toBe(80);
    expect(customWidgetSchema.safeParse({ ...grid('x'), title: 'a'.repeat(WIDGET_TITLE_MAX) }).success).toBe(true);
    expect(customWidgetSchema.safeParse({ ...grid('x'), title: 'a'.repeat(WIDGET_TITLE_MAX + 1) }).success).toBe(false);
    expect(GROWS.length).toBeLessThanOrEqual(WIDGET_TITLE_MAX);
    const r = cleanWidgetText([grid(GROWS)], undefined);
    expect(r.ok).toBe(true);
    const title = r.ok ? r.widgets[0].title : '';
    expect(title.length).toBe(WIDGET_TITLE_MAX);
    expect(title).not.toMatch(/<\s*\/?\s*[a-z]/i);

    const long = `${'x'.repeat(TEXT_CARD_MAX - GROWS.length)}${GROWS}`;
    const t = cleanWidgetText([text(long)], undefined);
    expect(t.ok && t.widgets[0].options.text?.length).toBe(TEXT_CARD_MAX);
  });
});
