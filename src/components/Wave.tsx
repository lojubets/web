/** The wave edge that closes the masthead and hero: a yellow stripe, then the page, like the stripes on the can. */
export default function Wave() {
  return (
    <svg className="wave" viewBox="0 0 480 24" preserveAspectRatio="none" aria-hidden="true">
      <path className="wave-accent" d="M0 9 C40 -1 80 -1 120 9 S200 19 240 9 S320 -1 360 9 S440 19 480 9 V24 H0Z" />
      <path className="wave-page" d="M0 15 C40 5 80 5 120 15 S200 25 240 15 S320 5 360 15 S440 25 480 15 V24 H0Z" />
    </svg>
  );
}
