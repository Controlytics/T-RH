import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CustomWidget } from '@digilog/shared';
import { WidgetBody } from '../widget-panel';

const card = (text: string): CustomWidget => ({
  id: '88888888-8888-4888-8888-888888888888', type: 'text_card', title: 'Note',
  source: { mode: 'selection' }, keys: [], options: { text },
});
const view = (text: string) => render(
  <MemoryRouter><WidgetBody widget={card(text)} selection={{ directOnly: false }} /></MemoryRouter>,
);

describe('text card widget', () => {
  it('prints the text as TEXT: markup reads as its characters, never as an element', () => {
    view('<b>x</b> and <img src=x onerror="alert(1)"> and **bold**');
    const body = screen.getByTestId('text-card');
    expect(body.textContent).toBe('<b>x</b> and <img src=x onerror="alert(1)"> and **bold**');
    expect(body.querySelector('b')).toBeNull();
    expect(body.querySelector('img')).toBeNull();
    // Never markdown either.
    expect(body.querySelector('strong')).toBeNull();
    expect(body.childElementCount).toBe(0);
  });

  it('keeps its line breaks and wraps a long unbroken word inside the card', () => {
    view('Shift handover at 06:00\n\nCall QA before release');
    const body = screen.getByTestId('text-card');
    expect(body.textContent).toBe('Shift handover at 06:00\n\nCall QA before release');
    const classes = body.className.split(/\s+/);
    expect(classes).toContain('whitespace-pre-wrap');
    expect(classes).toContain('[overflow-wrap:anywhere]');
  });
});
