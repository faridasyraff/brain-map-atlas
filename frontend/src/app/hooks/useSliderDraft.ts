import { useEffect, useState } from 'react';

/**
 * A slice slider's shown value: it follows the thumb while dragging and the
 * real slice index otherwise. The image only reloads on release
 * (onValueCommit), so there's no request per pixel of drag.
 */
export function useSliderDraft(idx: number) {
  const [draft, setDraft] = useState(idx);
  useEffect(() => {
    setDraft(idx);
  }, [idx]);
  return [draft, setDraft] as const;
}
