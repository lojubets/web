import { useEffect, useMemo, useRef, useState } from 'react';

const VIEW = 260; // the on-screen viewport, in CSS pixels
const MAX_ZOOM = 4;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Lets the user drag and zoom a picture under a circular viewport, then returns the cropped square as a small JPEG data URL. */
export default function AvatarCropper({ file, busy, onCancel, onSave }: { file: File; busy: boolean; onCancel: () => void; onSave: (dataUrl: string) => void }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  // Pinching belongs to the picture while we're open: stop the browser zooming the page, but keep scrolling
  useEffect(() => {
    const root = document.documentElement;
    const before = root.style.touchAction;
    root.style.touchAction = 'pan-x pan-y';
    return () => {
      root.style.touchAction = before;
    };
  }, []);
  const view = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 }); // image top-left, relative to the viewport
  // Active pointers (a finger or the mouse) and the state when the current gesture began
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; mx: number; my: number; zoom: number; x: number; y: number; ox: number; oy: number }>(null);

  const baseScale = natural ? VIEW / Math.min(natural.w, natural.h) : 1;

  const scale = baseScale * zoom;
  const fit = (p: { x: number; y: number }, s: number) =>
    natural ? { x: clamp(p.x, VIEW - natural.w * s, 0), y: clamp(p.y, VIEW - natural.h * s, 0) } : p;

  const onLoad = () => {
    const el = img.current!;
    const n = { w: el.naturalWidth, h: el.naturalHeight };
    const s = VIEW / Math.min(n.w, n.h);
    setNatural(n);
    setPos({ x: (VIEW - n.w * s) / 2, y: (VIEW - n.h * s) / 2 });
  };

  /** Zooms about the viewport centre so the face you lined up stays put. */
  const changeZoom = (z: number) => {
    if (!natural) return;
    const next = clamp(z, 1, MAX_ZOOM);
    const base = baseScale;
    const ratio = (base * next) / scale;
    const c = VIEW / 2;
    setZoom(next);
    setPos(fit({ x: c - (c - pos.x) * ratio, y: c - (c - pos.y) * ratio }, base * next));
  };

  // Trackpads don't send pointer events for a pinch: Chrome sends ctrl+wheel, Safari its own gesture events.
  // Both need non-passive native listeners to keep the page itself from zooming.
  const zoomBy = useRef(changeZoom);
  zoomBy.current = changeZoom;
  const zoomNow = useRef(zoom);
  zoomNow.current = zoom;
  useEffect(() => {
    const inside = (t: EventTarget | null) => t instanceof Node && !!view.current?.contains(t);
    let start = 1;
    const wheel = (e: WheelEvent) => {
      if (!inside(e.target)) {
        if (e.ctrlKey) e.preventDefault();
        return;
      }
      e.preventDefault();
      zoomBy.current(zoomNow.current * (e.ctrlKey ? Math.exp(-e.deltaY * 0.01) : e.deltaY < 0 ? 1.08 : 1 / 1.08));
    };
    const gestureStart = (e: Event) => {
      e.preventDefault();
      start = zoomNow.current;
    };
    const gestureChange = (e: Event) => {
      e.preventDefault();
      if (inside(e.target)) zoomBy.current(start * (e as unknown as { scale: number }).scale);
    };
    const gestureEnd = (e: Event) => e.preventDefault();
    document.addEventListener('wheel', wheel, { passive: false });
    document.addEventListener('gesturestart', gestureStart);
    document.addEventListener('gesturechange', gestureChange);
    document.addEventListener('gestureend', gestureEnd);
    return () => {
      document.removeEventListener('wheel', wheel);
      document.removeEventListener('gesturestart', gestureStart);
      document.removeEventListener('gesturechange', gestureChange);
      document.removeEventListener('gestureend', gestureEnd);
    };
  }, []);

  /** Re-bases the gesture on the pointers that are down now, so lifting or adding a finger doesn't make the picture jump. */
  const beginGesture = (view: HTMLElement) => {
    const [a, b] = [...pointers.current.values()];
    if (!a) {
      gesture.current = null;
      return;
    }
    const rect = view.getBoundingClientRect();
    gesture.current = {
      dist: b ? Math.hypot(b.x - a.x, b.y - a.y) || 1 : 1,
      mx: (b ? (a.x + b.x) / 2 : a.x) - rect.left,
      my: (b ? (a.y + b.y) / 2 : a.y) - rect.top,
      zoom,
      x: pos.x,
      y: pos.y,
      ox: a.x,
      oy: a.y,
    };
  };
  const endPointer = (e: React.PointerEvent<HTMLElement>) => {
    pointers.current.delete(e.pointerId);
    beginGesture(e.currentTarget);
  };

  const save = () => {
    if (!natural) return;
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const side = VIEW / scale;
    canvas.getContext('2d')!.drawImage(img.current!, -pos.x / scale, -pos.y / scale, side, side, 0, 0, size, size);
    onSave(canvas.toDataURL('image/jpeg', 0.85));
  };

  const nudge = (e: React.KeyboardEvent) => {
    const d = { ArrowLeft: [20, 0], ArrowRight: [-20, 0], ArrowUp: [0, 20], ArrowDown: [0, -20] }[e.key];
    if (!d) return;
    e.preventDefault();
    setPos(fit({ x: pos.x + d[0], y: pos.y + d[1] }, scale));
  };

  return (
    <div className="card stack cropper">
      <h2>Adjust your picture</h2>
      <span className="muted">Drag to move, and pinch or use the slider to zoom so your face fits your face in the circle.</span>
      <div
        ref={view}
        className="cropper-view"
        style={{ width: VIEW, height: VIEW }}
        tabIndex={0}
        role="application"
        aria-label="Picture position. Use the arrow keys to move it."
        onKeyDown={nudge}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          beginGesture(e.currentTarget);
        }}
        onPointerMove={(e) => {
          if (!pointers.current.has(e.pointerId) || !gesture.current || !natural) return;
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          const g = gesture.current;
          const [a, b] = [...pointers.current.values()];
          if (!b) {
            setPos(fit({ x: g.x + a.x - g.ox, y: g.y + a.y - g.oy }, scale));
            return;
          }
          // Pinch: scale by the change in finger distance, keeping the point under the fingers' midpoint under them
          const rect = e.currentTarget.getBoundingClientRect();
          const next = clamp((g.zoom * Math.hypot(b.x - a.x, b.y - a.y)) / g.dist, 1, MAX_ZOOM);
          const ratio = next / g.zoom;
          const mx = (a.x + b.x) / 2 - rect.left;
          const my = (a.y + b.y) / 2 - rect.top;
          setZoom(next);
          setPos(fit({ x: mx - (g.mx - g.x) * ratio, y: my - (g.my - g.y) * ratio }, baseScale * next));
        }}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
      >
        <img
          ref={img}
          src={url}
          alt=""
          draggable={false}
          onLoad={onLoad}
          style={natural ? { width: natural.w * scale, height: natural.h * scale, transform: `translate(${pos.x}px, ${pos.y}px)` } : { visibility: 'hidden' }}
        />
        <div className="cropper-mask" aria-hidden="true" />
      </div>
      <label className="cropper-zoom">
        Zoom
        <input type="range" min={1} max={MAX_ZOOM} step={0.01} value={zoom} onChange={(e) => changeZoom(Number(e.target.value))} />
      </label>
      <div className="row-actions">
        <button className="btn" disabled={busy || !natural} onClick={save}>Save picture</button>
        <button className="btn btn-secondary" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
