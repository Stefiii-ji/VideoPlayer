import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import Navigation from './Navigation.jsx';

function CurrentPath() {
  const location = useLocation();
  return <output aria-label="Current path">{location.pathname}</output>;
}

describe('Navigation', () => {
  it('routes the MovieStream logo home with a keyboard-accessible link', () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <Navigation />
        <CurrentPath />
      </MemoryRouter>,
    );

    const logo = screen.getByRole('link', { name: 'MovieStream home' });
    expect(logo).toHaveAttribute('href', '/');
    fireEvent.click(logo);
    expect(screen.getByLabelText('Current path')).toHaveTextContent('/');
  });
});
