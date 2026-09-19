export type HotStyle = 'A' | 'B' | 'C' | 'D';

export function formatCompact(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} 千`;
  return String(n);
}

interface Props {
  score: number | null | undefined;
  style?: HotStyle;
  max?: number;
}

export default function HotBadge({ score, style = 'B', max }: Props) {
  if (score == null) return null;

  if (style === 'A') {
    return <span className="hot-raw">{score.toLocaleString()}</span>;
  }
  if (style === 'B') {
    return <span className="hot-compact">{formatCompact(score)}</span>;
  }
  if (style === 'C') {
    return <span className="hot-badge">🔥 {formatCompact(score)}</span>;
  }
  // D
  const m = max && max > 0 ? max : score;
  const pct = Math.max(8, Math.round((score / m) * 100));
  return (
    <span className="hot-bar-wrap">
      <span className="hot-bar-num">{formatCompact(score)}</span>
      <span className="hot-bar">
        <span className="hot-bar-fill" style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}