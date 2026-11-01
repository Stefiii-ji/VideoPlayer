import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import RemoteNavigation from './RemoteNavigation.jsx';

afterEach(cleanup);

function setBounds(element, left, top) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    left, top, width: 100, height: 50, right: left + 100, bottom: top + 50,
  });
}

describe('RemoteNavigation', () => {
  it('moves focus to the nearest visible control in the arrow direction', () => {
    render(
      <MemoryRouter>
        <RemoteNavigation />
        <button type="button">First</button>
        <button type="button">Second</button>
      </MemoryRouter>,
    );
    const first = screen.getByRole('button', { name: 'First' });
    const second = screen.getByRole('button', { name: 'Second' });
    setBounds(first, 20, 20);
    setBounds(second, 140, 20);
    first.focus();

    fireEvent.keyDown(first, { key: 'ArrowRight' });

    expect(second).toHaveFocus();
  });

  it('leaves text and selection controls to their native arrow-key behavior', () => {
    render(
      <MemoryRouter>
        <RemoteNavigation />
        <input aria-label="Search" />
      </MemoryRouter>,
    );
    const input = screen.getByRole('textbox', { name: 'Search' });
    input.focus();
    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(input).toHaveFocus();
  });
});
