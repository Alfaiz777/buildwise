import { useEffect } from 'react';

/** Sets the browser tab title for a public page (UI-6); consoles set theirs in AppShell. */
export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
