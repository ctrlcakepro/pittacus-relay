/*
 * The Hydra mark: one node, strands fanning out of it, three of them ending
 * in curled heads. Drawn on a 1024 grid; the tile is a superellipse (n = 5),
 * which reads softer than a rounded rect at the corners.
 *
 * Each strand also carries its motion parameters so the React component, the
 * exported animated SVG and the showcase page all move identically:
 *   r0  intro: angle the strand starts folded at (deg, about the pivot)
 *   dl  intro: delay (s)
 *   sw  idle sway amplitude (deg); sp period (s); sd phase offset (s)
 *   hv  hover: angle the strand fans out to (deg)
 *   bd  active: delay of the packet travelling along this strand (s)
 * Positive angles turn clockwise, so left strands open with negative values.
 * Both scripts/brand.mjs (under Node's type stripping) and the renderer import
 * this file, so it must stay plain data and type-only syntax.
 */

export interface Strand {
  d: string
  r0: number
  dl: number
  sw: number
  sp: number
  sd: number
  hv: number
  bd: number
}

export interface MarkGeometry {
  /** Line weight in grid units. */
  stroke: number
  /** The root node. */
  dot: { cy: number; r: number }
  /** Tile origin and side; the tile is square. */
  tile: { at: number; size: number }
  strands: Strand[]
}

/** The point strands rotate around: just above the node. */
export const PIVOT = { x: 512, y: 728 }

/** Full mark, for 48px and up. */
export const FULL: MarkGeometry = {
  stroke: 24,
  dot: { cy: 780, r: 31 },
  tile: { at: 100, size: 824 },
  strands: [
    {
      // centre stem, head curling right
      d: 'M512 720.6 C512 632.6 525.2 557.8 503.2 483 C485.6 421.4 448.2 375.2 452.6 311.4 C455.9 258.6 496.6 221.2 542.8 227.8 C571.4 232.2 595.6 249.8 611 265.2 C584.6 287.2 551.6 298.2 523 285',
      r0: -10, dl: 0.12, sw: 1.2, sp: 3.8, sd: -1.2, hv: -3, bd: 0
    },
    {
      // left head
      d: 'M504.3 720.6 C496.6 619.4 459.2 516 391 458.8 C349.2 423.6 292 406 256.8 430.2 C243.6 439 234.8 447.8 228.2 456.6 C256.8 472 292 485.2 318.4 476.4 C331.6 472 336 461 329.4 452.2',
      r0: 26, dl: 0.22, sw: 2, sp: 3.2, sd: -0.4, hv: -7, bd: 1.4
    },
    {
      // right head
      d: 'M519.7 720.6 C527.4 619.4 564.8 516 633 458.8 C674.8 423.6 732 406 767.2 430.2 C780.4 439 789.2 447.8 795.8 456.6 C767.2 472 732 485.2 705.6 476.4 C692.4 472 688 461 694.6 452.2',
      r0: -26, dl: 0.26, sw: 2, sp: 3.5, sd: -2, hv: 7, bd: 0.5
    },
    {
      // left tendril
      d: 'M508.7 720.6 C501 648 465.8 564.4 362.4 531.4',
      r0: 34, dl: 0.34, sw: 2.8, sp: 2.7, sd: -0.9, hv: -10, bd: 1
    },
    {
      // right tendril
      d: 'M515.3 720.6 C523 648 558.2 564.4 661.6 531.4',
      r0: -34, dl: 0.38, sw: 2.8, sp: 2.9, sd: -1.7, hv: 10, bd: 1.9
    }
  ]
}

/**
 * Small-size glyph (32px and below): tendrils dropped, heads simplified,
 * line weight doubled, tile nearly full-bleed. At these sizes the full mark's
 * lines fall below a pixel and the heads blur together.
 */
export const COMPACT: MarkGeometry = {
  stroke: 54,
  dot: { cy: 800, r: 56 },
  tile: { at: 40, size: 944 },
  strands: [
    {
      d: 'M512 700 C512 600 520 530 500 460 C484 404 456 356 466 296 C476 240 544 220 596 262 C566 292 532 298 510 286',
      r0: -10, dl: 0.12, sw: 1.6, sp: 3.8, sd: -1.2, hv: -4, bd: 0
    },
    {
      d: 'M500 700 C492 600 452 510 380 462 C330 430 262 430 224 470 C262 500 306 506 330 486',
      r0: 26, dl: 0.22, sw: 2.6, sp: 3.2, sd: -0.4, hv: -9, bd: 0.8
    },
    {
      d: 'M524 700 C532 600 572 510 644 462 C694 430 762 430 800 470 C762 500 718 506 694 486',
      r0: -26, dl: 0.26, sw: 2.6, sp: 3.5, sd: -2, hv: 9, bd: 1.6
    }
  ]
}

/** Superellipse |x|^n + |y|^n = 1 through `steps` points per quadrant. */
export function squircle(at: number, size: number, n = 5, steps = 48): string {
  const a = size / 2
  const c = at + a
  const pts: string[] = []
  for (let i = 0; i < steps * 4; i++) {
    const t = (i / (steps * 4)) * Math.PI * 2
    const cos = Math.cos(t)
    const sin = Math.sin(t)
    const x = c + a * Math.sign(cos) * Math.abs(cos) ** (2 / n)
    const y = c + a * Math.sign(sin) * Math.abs(sin) ** (2 / n)
    pts.push(`${x.toFixed(1)} ${y.toFixed(1)}`)
  }
  return `M${pts.join('L')}Z`
}

/** CSS custom properties that drive one strand's motion (see hydra-mark.css). */
export function strandVars(s: Strand): Record<string, string> {
  return {
    '--r0': `${s.r0}deg`,
    '--dl': `${s.dl}s`,
    '--sw': `${s.sw}deg`,
    '--sp': `${s.sp}s`,
    '--sd': `${s.sd}s`,
    '--hv': `${s.hv}deg`,
    '--bd': `${s.bd}s`
  }
}
