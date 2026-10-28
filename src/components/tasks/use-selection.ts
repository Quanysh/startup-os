import { useCallback, useMemo, useState } from "react";
import { MAX_SELECTED } from "@/lib/tasks/bulk";

/**
 * The cards ticked for a bulk action, among those on screen. A card that
 * leaves the screen (filtered out, deleted, moved away by someone else) is
 * dropped from the selection for good, so an action never touches a card the
 * person cannot see.
 *
 * The task board holds 50 at most; another list says its own most and what
 * it holds (the sales table: 100 deals).
 */
export function useSelection(
  shown: readonly string[],
  { max = MAX_SELECTED, noun = "cards" }: { max?: number; noun?: string } = {},
) {
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const key = shown.join("\n");
  const visible = useMemo(() => new Set(key === "" ? [] : key.split("\n")), [key]);
  const tooMany = `At most ${max} ${noun} can be selected at once.`;

  // Forget what went out of sight, so it does not come back with it. (Done
  // while rendering, React's way of adjusting state to new props.)
  if (picked.some((id) => !visible.has(id))) {
    setPicked(picked.filter((id) => visible.has(id)));
  }
  const ids = useMemo(() => picked.filter((id) => visible.has(id)), [picked, visible]);

  const toggle = useCallback(
    (id: string) => {
      setPicked((had) => {
        if (had.includes(id)) {
          setNotice(null);
          return had.filter((other) => other !== id);
        }
        if (had.length >= max) {
          setNotice(tooMany);
          return had;
        }
        return [...had, id];
      });
    },
    [max, tooMany],
  );
  const clear = useCallback(() => {
    setPicked([]);
    setNotice(null);
  }, []);
  /** Keep only these of the selection (the cards an action refused). */
  const keep = useCallback((only: readonly string[]) => {
    setPicked((had) => had.filter((id) => only.includes(id)));
    setNotice(null);
  }, []);
  /** Select these instead, up to the most (the first of them, in their order). */
  const pickAll = useCallback(
    (all: readonly string[]) => {
      setPicked(all.slice(0, max));
      setNotice(all.length > max ? tooMany : null);
    },
    [max, tooMany],
  );
  const has = useCallback((id: string) => ids.includes(id), [ids]);

  return { ids, has, toggle, clear, keep, pickAll, notice };
}
