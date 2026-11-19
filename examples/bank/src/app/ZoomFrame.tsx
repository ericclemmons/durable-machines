import { Button } from "@cloudflare/kumo";
import { ArrowsOutIcon, MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Chart } from "./graph";
import type { Box } from "./Statechart";

const PAD = 24;

const contains = (outer: Box, inner: Box) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

/** Most the frame magnifies when it zooms to a part. */
const MAX_SCALE = 1.1;
/** At 1×, state names are 12px and transition labels 10px, about the size of the events list. */
const READABLE_SCALE = 1;
const TWEEN_MS = 900;

const scaleOf = (view: Box, size: { width: number }) => size.width / view.width;

/**
 * Grow `box` by a margin, to the frame's aspect ratio, centred. A zoom target
 * is magnified between READABLE_SCALE and MAX_SCALE, even if that crops it.
 */
function framed(box: Box, size: { width: number; height: number }, readable = false): Box {
  const b = { x: box.x - PAD, y: box.y - PAD, width: box.width + PAD * 2, height: box.height + PAD * 2 };
  const aspect = size.width / Math.max(1, size.height);
  let width = Math.max(b.width, b.height * aspect);
  if (readable) width = Math.min(Math.max(width, size.width / MAX_SCALE), size.width / READABLE_SCALE);
  const height = width / aspect;
  return { x: b.x + b.width / 2 - width / 2, y: b.y + b.height / 2 - height / 2, width, height };
}

/**
 * Fills its parent. Animates to `target` (or the whole chart) when the focus
 * changes. Scroll to zoom, drag to pan.
 */
export function ZoomFrame({
  chart,
  target,
  focusKey,
  onBackground,
  children,
}: {
  chart: Chart;
  target?: Box;
  focusKey: string;
  onBackground?: () => void;
  children: (view: Box) => React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 500 });
  const [goal, setGoal] = useState<{ box: Box; instant: boolean }>();
  const [shown, setShown] = useState<Box>();
  const shownRef = useRef<Box>(undefined);
  shownRef.current = shown;
  const drag = useRef<{ x: number; y: number; box: Box; moved: boolean }>(undefined);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => entry && setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const whole = { x: 0, y: 0, width: chart.width, height: chart.height };

  // A new layout (machines appeared) or a new frame size: frame the focus afresh.
  useEffect(() => {
    setGoal({ box: target ? framed(target, size, true) : framed(whole, size), instant: !shownRef.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, size.width, size.height]);

  // A new focus: move only if it isn't already in view and readable.
  useEffect(() => {
    const current = shownRef.current;
    if (current && target && contains(current, target) && scaleOf(current, size) >= READABLE_SCALE) return;
    setGoal({ box: target ? framed(target, size, true) : framed(whole, size), instant: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  const setManual = (box: Box) => setGoal({ box, instant: true });

  // Tween the shown box toward the goal.
  const goalKey = goal ? `${goal.box.x}|${goal.box.y}|${goal.box.width}|${goal.box.height}` : "";
  useEffect(() => {
    if (!goal) return;
    const from = shownRef.current;
    if (goal.instant || !from) return setShown(goal.box);
    const to = goal.box;
    const start = performance.now();
    let frame = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / TWEEN_MS);
      // Ease in and out.
      const e = k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
      setShown({
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        width: from.width + (to.width - from.width) * e,
        height: from.height + (to.height - from.height) * e,
      });
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalKey]);

  const view = shown ?? goal?.box ?? framed(whole, size);
  const zoom = (factor: number, cx = size.width / 2, cy = size.height / 2) => {
    const px = view.x + (cx / size.width) * view.width;
    const py = view.y + (cy / size.height) * view.height;
    const width = Math.min(chart.width * 4, Math.max(120, view.width * factor));
    const height = width * (view.height / view.width);
    setManual({ x: px - (cx / size.width) * width, y: py - (cy / size.height) * height, width, height });
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoom(Math.exp(e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  const onPointerDown = (e: ReactPointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, box: view, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    const k = d.box.width / size.width;
    setManual({ ...d.box, x: d.box.x - dx * k, y: d.box.y - dy * k });
  };

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-[radial-gradient(circle_at_1px_1px,var(--color-kumo-line)_1px,transparent_0)] [background-size:16px_16px]">
      <div
        ref={ref}
        className="absolute inset-0 cursor-grab touch-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => setTimeout(() => (drag.current = undefined))}
        onPointerLeave={() => (drag.current = undefined)}
        onClickCapture={(e) => drag.current?.moved && e.stopPropagation()}
        onClick={(e) => (e.target === e.currentTarget || (e.target as Element).tagName === "svg" ? onBackground?.() : undefined)}
      >
        {children(view)}
      </div>
      <div className="absolute bottom-2 right-2 flex gap-1 rounded-lg bg-kumo-base/90 p-0.5 shadow-xs ring ring-kumo-line">
        <Button variant="ghost" shape="square" size="sm" icon={MagnifyingGlassPlusIcon} aria-label="Zoom in" onClick={() => zoom(1 / 1.4)} />
        <Button variant="ghost" shape="square" size="sm" icon={MagnifyingGlassMinusIcon} aria-label="Zoom out" onClick={() => zoom(1.4)} />
        <Button variant="ghost" shape="square" size="sm" icon={ArrowsOutIcon} aria-label="Fit" onClick={() => setManual(framed(whole, size))} />
      </div>
    </div>
  );
}
