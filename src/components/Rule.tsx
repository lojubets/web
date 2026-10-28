/** The wavy edge that closes the masthead and hero, with a few ice cubes bobbing on it. */
const W = 480; // viewBox width; the wave repeats twice across it
const H = 24;
const STEPS = 96;
const wave = (x: number) => 11 + 6 * Math.sin((x / (W / 2)) * 2 * Math.PI);

const POINTS = Array.from({ length: STEPS + 1 }, (_, i) => {
  const x = (i * W) / STEPS;
  return `${x} ${wave(x).toFixed(2)}`;
});
const EDGE = `M${POINTS.join('L')}`;
const FILL = `M0 0H${W}L${[...POINTS].reverse().join('L')}Z`;

const CUBES = [
  { at: 0.06, size: 1.1, turn: -14 },
  { at: 0.27, size: 0.8, turn: 22 },
  { at: 0.52, size: 1.25, turn: 9 },
  { at: 0.73, size: 0.85, turn: -28 },
  { at: 0.92, size: 1.05, turn: 17 },
];

export default function Rule() {
  return (
    <div className="rule" aria-hidden="true">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <path d={FILL} className="rule-fill" />
        <path d={EDGE} className="rule-edge" />
      </svg>
      {CUBES.map((c) => (
        <i
          key={c.at}
          className="ice"
          style={{ left: `${c.at * 100}%`, top: `${wave(c.at * W)}px`, width: `${c.size}rem`, height: `${c.size}rem`, transform: `translate(-50%, -50%) rotate(${c.turn}deg)` }}
        />
      ))}
    </div>
  );
}
