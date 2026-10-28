/** The champagne hairline that closes the masthead and hero, broken up by a few ice cubes bobbing along it. */
const CUBES = [
  { left: '6%', size: 1.1, turn: -14, drop: 0.1 },
  { left: '27%', size: 0.8, turn: 22, drop: 0.35 },
  { left: '52%', size: 1.25, turn: 9, drop: 0 },
  { left: '71%', size: 0.85, turn: -28, drop: 0.3 },
  { left: '90%', size: 1.05, turn: 17, drop: 0.05 },
];

export default function Rule() {
  return (
    <div className="rule" aria-hidden="true">
      {CUBES.map((c) => (
        <i
          key={c.left}
          className="ice"
          style={{ left: c.left, width: `${c.size}rem`, height: `${c.size}rem`, transform: `translate(-50%, ${c.drop - 0.5}rem) rotate(${c.turn}deg)` }}
        />
      ))}
    </div>
  );
}
