import type { SVGProps } from 'react';

/** The icon set: 24px grid, 2px stroke, round caps and joins, no fill, currentColor. See docs/brand-guide.md section 8. */
const PATHS = {
  can: 'M7 4h10l1 3v11a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 6 18V7l1-3zM6 7h12M9.5 12.5h5M9.5 15.5h5',
  friends: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.6-3.4 3.1-5.2 6.5-5.2s5.9 1.8 6.5 5.2M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.9c1.8.7 3 2.3 3.5 5.1',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5c.7-3.6 3.5-5.5 7.5-5.5s6.8 1.9 7.5 5.5',
  plus: 'M12 5v14M5 12h14',
  'chevron-left': 'm15 6-6 6 6 6',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  flame: 'M12 21c3.9 0 6.5-2.6 6.5-6.2 0-2.6-1.5-4.4-3-6-.8-.9-1.4-2-1.5-3.3-2.5 1.2-4.2 3.6-4.2 6.1-1-.5-1.6-1.4-1.9-2.5C6.7 10.9 5.5 12.6 5.5 14.8 5.5 18.4 8.1 21 12 21z',
  lock: 'M6.5 11h11a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5v-6A1.5 1.5 0 0 1 6.5 11zM8 11V8a4 4 0 0 1 8 0v3',
  mail: 'M4.5 5h15A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11A1.5 1.5 0 0 1 4.5 5zM3.5 7l8.5 6 8.5-6',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  pencil: 'm4 20 1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1zM14.5 6.5l3 3',
  alert: 'M12 4 2.8 19.5h18.4L12 4zM12 10v4.5M12 17.2v.1',
  trophy: 'M8 4h8v5a4 4 0 0 1-8 0V4zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7M10 17h4',
} as const;

export type IconName = keyof typeof PATHS;

export default function Icon({ name, size = 20, ...rest }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
