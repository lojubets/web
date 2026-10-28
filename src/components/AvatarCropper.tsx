import { useEffect, useMemo, useRef, useState } from 'react';

const VIEW = 260; // the on-screen viewport, in CSS pixels
const MAX_ZOOM = 4;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Lets the user drag and zoom a picture under a circular viewport, then returns the cropped square as a small JPEG data URL. */
export default function AvatarCropper({ file, busy, onCancel, onSave }: { file: File; busy: boolean; onCancel: () => void; onSave: (dataUrl: string) => void }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const img = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 }); // image top-left, relative to the viewport
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  const scale = natural ? (VIEW / Math.min(natural.w, natural.h)) * zoom : 1;
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
    const base = VIEW / Math.min(natural.w, natural.h);
    const ratio = (base * next) / scale;
    const c = VIEW / 2;
    setZoom(next);
    setPos(fit({ x: c - (c - pos.x) * ratio, y: c - (c - pos.y) * ratio }, base * next));
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
      <span className="muted">Drag to move, and zoom to fit your face in the circle.</span>
      <div
        className="cropper-view"
        style={{ width: VIEW, height: VIEW }}
        tabIndex={0}
        role="application"
        aria-label="Picture position. Use the arrow keys to move it."
        onKeyDown={nudge}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) setPos(fit({ x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py }, scale));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onWheel={(e) => changeZoom(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))}
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
