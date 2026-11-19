import { useCallback, useSyncExternalStore } from 'react';

/** Whether a CSS media query matches, kept up to date as the window changes. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mq = window.matchMedia?.(query);
      mq?.addEventListener('change', onChange);
      return () => mq?.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia?.(query).matches ?? false, () => false);
}

/** Phones (and very narrow windows) get the one-view layout. Tailwind's `md` is 768px. */
export const PHONE_QUERY = '(max-width: 767px)';
export const usePhoneLayout = () => useMediaQuery(PHONE_QUERY);
