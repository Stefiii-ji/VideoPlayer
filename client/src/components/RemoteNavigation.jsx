import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function isEditable(element) {
  return element instanceof HTMLElement
    && (element.matches('input, textarea, select, [contenteditable="true"], video, audio')
      || element.getAttribute('role') === 'slider');
}

function moveFocus(direction) {
  const active = document.activeElement;
  const candidates = [...document.querySelectorAll(FOCUSABLE)]
    .filter((element) => element instanceof HTMLElement
      && !element.hidden
      && element.getAttribute('aria-hidden') !== 'true'
      && getComputedStyle(element).visibility !== 'hidden')
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 0 && rect.height > 0);
  const current = candidates.find(({ element }) => element === active);
  const origin = current
    ? { x: current.rect.left + current.rect.width / 2, y: current.rect.top + current.rect.height / 2 }
    : { x: window.innerWidth / 2, y: window.innerHeight / 2 };

  const next = candidates
    .filter(({ element, rect }) => element !== active && (
      direction === 'ArrowRight' ? rect.left + rect.width / 2 > origin.x
        : direction === 'ArrowLeft' ? rect.left + rect.width / 2 < origin.x
          : direction === 'ArrowDown' ? rect.top + rect.height / 2 > origin.y
            : rect.top + rect.height / 2 < origin.y
    ))
    .map(({ element, rect }) => {
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const primary = direction === 'ArrowRight' || direction === 'ArrowLeft'
        ? Math.abs(x - origin.x)
        : Math.abs(y - origin.y);
      const secondary = direction === 'ArrowRight' || direction === 'ArrowLeft'
        ? Math.abs(y - origin.y)
        : Math.abs(x - origin.x);
      return { element, score: primary + secondary * 1.5 };
    })
    .sort((left, right) => left.score - right.score)[0];

  next?.element.focus();
  return Boolean(next);
}

export default function RemoteNavigation() {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    function onKeyDown(event) {
      if (event.defaultPrevented) return;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        if (isEditable(document.activeElement)) return;
        const activeIsFocusable = document.activeElement?.matches?.(FOCUSABLE);
        if (!activeIsFocusable && event.target !== document.body && event.target !== document.documentElement) return;
        if (moveFocus(event.key)) event.preventDefault();
      } else if (event.key === 'BrowserBack'
        || (event.key === 'Backspace' && !isEditable(document.activeElement))) {
        if (location.pathname.startsWith('/watch/')) return;
        event.preventDefault();
        if (window.history.state?.idx > 0) navigate(-1);
        else navigate('/');
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [location.pathname, navigate]);

  return null;
}
