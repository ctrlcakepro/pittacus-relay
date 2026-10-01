import type { CSSProperties } from 'react'
import { COMPACT, FULL, squircle, strandVars } from './geometry'
import './hydra-mark.css'

const TILES = new Map<number, string>()
function tilePath(at: number, size: number): string {
  let d = TILES.get(at)
  if (!d) TILES.set(at, (d = squircle(at, size)))
  return d
}

export interface HydraMarkProps {
  size?: number
  /** Draw the squircle tile behind the mark. */
  tile?: boolean
  /** Play the draw-in on mount; remount (change `key`) to replay. */
  intro?: boolean
  /** Idle sway and breathing. */
  live?: boolean
  /** Packets travel from the node to the heads (e.g. gateway running). */
  active?: boolean
  /** Strands fan open under the pointer. */
  hover?: boolean
  className?: string
  title?: string
}

/** The animated Hydra mark. Colours come from `--hm-ink` / `--hm-tile`. */
export function HydraMark({
  size = 24,
  tile = true,
  intro = true,
  live = true,
  active = false,
  hover = false,
  className = '',
  title
}: HydraMarkProps) {
  const g = size <= 32 ? COMPACT : FULL
  const cls = ['hm', intro && 'hm-intro', live && 'hm-live', active && 'hm-active', hover && 'hm-hover', className]
    .filter(Boolean)
    .join(' ')
  const style = { '--hm-w': `${g.stroke}px`, '--hm-dot-y': `${g.dot.cy}px` } as CSSProperties

  return (
    <svg
      className={cls}
      style={style}
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {tile && <path className="hm-tile" d={tilePath(g.tile.at, g.tile.size)} />}
      <circle className="hm-ring" cx={512} cy={g.dot.cy} r={g.dot.r} />
      {g.strands.map((s, i) => (
        <g key={i} className="hm-s" style={strandVars(s) as CSSProperties}>
          <g className="hm-sway">
            <g className="hm-open">
              <path className="hm-line" d={s.d} pathLength={1} />
              <path className="hm-bead" d={s.d} pathLength={1} />
            </g>
          </g>
        </g>
      ))}
      <g className="hm-core">
        <circle className="hm-dot" cx={512} cy={g.dot.cy} r={g.dot.r} />
      </g>
    </svg>
  )
}
