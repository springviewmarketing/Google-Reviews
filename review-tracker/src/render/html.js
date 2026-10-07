/**
 * The weekly report, as one self-contained HTML file.
 *
 * Self-contained is the whole point: no fonts, scripts or images are fetched,
 * so the file can be attached to an email, opened offline, or printed, and it
 * looks the same everywhere. Charts are inline SVG for the same reason.
 *
 * Charts follow fixed specs: bars capped at 24px with a 4px rounded data-end
 * square to the baseline, hairline solid gridlines, values direct-labelled
 * selectively rather than on every mark, and colour never carrying identity on
 * its own (every bar is named on the axis and its value is in the table).
 */

import { formatDate } from './text.js';

const esc = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const signed = (n) => (n > 0 ? `+${n}` : `${n}`);
const pct = (v) => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);
const num = (n) => (typeof n === 'number' ? n.toLocaleString('en-GB') : 'n/a');
// 1st, 2nd, 3rd, 4th. The teens are the exception that catches everyone out:
// 11th, 12th and 13th, not 11st, 12nd and 13rd.
const ordinal = (n) => {
  if (typeof n !== 'number') return 'n/a';
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

/**
 * A horizontal bar: square where it meets the baseline at `baseX`, rounded at
 * the data end at `tipX`. Returns '' for a bar too short to draw.
 */
function hBarPath(baseX, tipX, y, height, radius = 4) {
  const length = Math.abs(tipX - baseX);
  if (length < 0.5) return '';
  const r = Math.max(0, Math.min(radius, length, height / 2));
  if (tipX >= baseX) {
    return `M${baseX},${y} H${tipX - r} A${r},${r} 0 0 1 ${tipX},${y + r} V${y + height - r} A${r},${r} 0 0 1 ${tipX - r},${y + height} H${baseX} Z`;
  }
  return `M${baseX},${y} H${tipX + r} A${r},${r} 0 0 0 ${tipX},${y + r} V${y + height - r} A${r},${r} 0 0 0 ${tipX + r},${y + height} H${baseX} Z`;
}

/**
 * A column growing up from `baseY` to `topY`, square at the baseline and
 * rounded across the cap.
 */
function columnPath(x, width, topY, baseY, radius = 4) {
  const height = baseY - topY;
  if (height < 0.5) return '';
  const r = Math.max(0, Math.min(radius, width / 2, height));
  return `M${x},${baseY} V${topY + r} A${r},${r} 0 0 1 ${x + r},${topY} H${x + width - r} A${r},${r} 0 0 1 ${x + width},${topY + r} V${baseY} Z`;
}

/** Horizontal bars: reviews gained this period, one row per practice. */
/**
 * Every practice in the area, ranked on total reviews.
 *
 * This used to chart reviews gained in the week, which was the wrong measure to
 * lead with. In a normal week most of a small town's practices gain nothing, so
 * the chart was a row of empty bars that said little and repeated the following
 * week. Totals are what the practice is actually trying to move and what the
 * gap to the next one up is measured in, so that is what gets the space.
 *
 * Bars run from zero rather than from the smallest value. An area can run from
 * eight reviews to a hundred and eight, and cropping the axis to flatter the
 * client would misrepresent exactly the distance they are trying to close.
 *
 * The week's movement is not lost. It rides as a "+2" beside the total, in the
 * gain colour, so a practice that is climbing is still visible without the
 * whole chart being given over to a column of zeroes.
 */
function packChart(report) {
  const rows = report.table.filter((row) => typeof row.total === 'number');
  if (rows.length === 0) return '';

  const ordered = rows.slice().sort((a, b) => b.total - a.total);
  const rowHeight = 34;
  const barHeight = 22; // capped under 24px; the band's leftover is air
  const labelWidth = 186;
  const valueWidth = 64; // room for "108 +3"
  const width = 700;
  const height = ordered.length * rowHeight + 26;
  const plotLeft = labelWidth + 10;
  const plotRight = width - valueWidth;

  const max = Math.max(1, ...ordered.map((row) => row.total));
  const scale = (v) => plotLeft + (v / max) * (plotRight - plotLeft);

  const bars = ordered
    .map((row, index) => {
      const y = index * rowHeight + 4;
      const barY = y + (rowHeight - barHeight) / 2 - 2;
      const path = hBarPath(plotLeft, scale(row.total), barY, barHeight);
      const fill = row.isClient ? 'var(--series-you)' : 'var(--series-them)';
      // The client's own row is bold, so it sets the widest the label can get.
      // Truncation plus the viewBox gutter below has to cover that, or the
      // practice reading the page finds its own name clipped.
      const name = row.name.length > 26 ? `${row.name.slice(0, 25)}…` : row.name;
      const gained = row.newReviews > 0 ? row.newReviews : null;
      const midY = barY + barHeight / 2 + 4;
      return `
      <g class="bar-row">
        <title>${esc(row.name)}: ${num(row.total)} reviews in total${gained ? `, ${signed(row.newReviews)} this week` : ''}</title>
        <text class="axis-label${row.isClient ? ' is-you' : ''}" x="${labelWidth}" y="${midY}" text-anchor="end">${esc(name)}</text>
        ${path ? `<path d="${path}" fill="${fill}" />` : `<rect x="${plotLeft - 1}" y="${barY}" width="2" height="${barHeight}" fill="var(--baseline)" />`}
        <text class="bar-value" x="${scale(row.total) + 8}" y="${midY}" text-anchor="start">${num(row.total)}${gained ? `<tspan class="gain"> +${gained}</tspan>` : ''}</text>
      </g>`;
    })
    .join('');

  return `
  <figure class="chart">
    <figcaption>
      <h3>Total reviews, every practice nearby</h3>
      <p class="legend">
        <span class="key"><span class="swatch swatch-you"></span>${esc(report.client.name)}</span>
        <span class="key"><span class="swatch swatch-them"></span>Other opticians nearby</span>
        <span class="key">A green figure is what they added this week.</span>
      </p>
    </figcaption>
    <div class="scroller"><svg viewBox="-26 -2 ${width + 40} ${height + 4}" role="img" aria-label="Total Google reviews for every practice nearby, ranked. Every value is listed in the table below.">
      <line x1="${plotLeft}" y1="2" x2="${plotLeft}" y2="${height - 22}" stroke="var(--baseline)" stroke-width="1" />
      ${bars}
    </svg></div>
  </figure>`;
}

/** Columns: the client's own week-by-week run. */
function trendChart(report) {
  const all = report.row.series.slice().reverse(); // oldest first, reading left to right

  // Start the chart where the tracking started.
  //
  // The report asks for twelve weeks, and a practice added three weeks ago has
  // nine of them before anything was ever read. Those are not quiet weeks, they
  // are weeks nobody looked, and drawing them as empty bars both wastes most of
  // the chart and tells the practice they did nothing when in truth the data
  // does not exist. Google publishes a live count and no history, so those
  // weeks cannot be filled in later either.
  const begins = all.findIndex((week) => week.total !== null);
  const series = begins === -1 ? [] : all.slice(begins);
  if (series.filter((week) => week.newReviews !== null).length < 2) return '';

  const width = 700;
  const height = 210;
  const padTop = 18;
  const padBottom = 34;
  const padLeft = 32;
  const padRight = 12;
  const plotHeight = height - padTop - padBottom;
  const band = (width - padLeft - padRight) / series.length;
  const barWidth = Math.min(24, band - 10); // cap, and leave the band's air

  const values = series.map((w) => w.newReviews).filter((v) => v !== null);
  const max = Math.max(1, ...values);
  const ceiling = Math.ceil(max / 2) * 2 || 2;
  const y = (v) => padTop + plotHeight - (v / ceiling) * plotHeight;
  const baseline = padTop + plotHeight;

  const gridValues = [0, ceiling / 2, ceiling];
  const grid = gridValues
    .map(
      (v) => `
      <line x1="${padLeft}" y1="${y(v)}" x2="${width - padRight}" y2="${y(v)}" stroke="${v === 0 ? 'var(--baseline)' : 'var(--grid)'}" stroke-width="1" />
      <text class="tick" x="${padLeft - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`
    )
    .join('');

  const peakIndex = series.reduce(
    (best, week, index) => (week.newReviews !== null && week.newReviews > (series[best]?.newReviews ?? -1) ? index : best),
    0
  );
  const lastIndex = series.length - 1;

  const columns = series
    .map((week, index) => {
      const cx = padLeft + band * index + band / 2;
      const x0 = cx - barWidth / 2;
      const label = formatDate(week.weekEnding, { day: 'numeric', month: 'short' });
      if (week.newReviews === null) {
        const firstEver = week.total !== null;
        return `
        <g class="bar-row">
          <title>Week to ${esc(label)}: ${firstEver ? `first reading, ${num(week.total)} reviews, nothing before it to compare with` : 'no reading taken'}</title>
          <rect x="${x0}" y="${baseline - 2}" width="${barWidth}" height="2" fill="var(--muted)" opacity="0.5" />
          <text class="tick" x="${cx}" y="${height - 14}" text-anchor="middle">${esc(label)}</text>
        </g>`;
      }
      const top = y(Math.max(0, week.newReviews));
      const path = columnPath(x0, barWidth, top, baseline);
      // Labels stay sparing: only the best week and the latest one get a number.
      const showValue = index === peakIndex || index === lastIndex || week.newReviews < 0;
      return `
      <g class="bar-row">
        <title>Week to ${esc(label)}: ${signed(week.newReviews)} reviews, ${num(week.total)} in total</title>
        ${week.newReviews > 0 ? `<path d="${path}" fill="var(--series-you)" />` : `<rect x="${x0}" y="${baseline - 2}" width="${barWidth}" height="2" fill="${week.newReviews < 0 ? 'var(--critical)' : 'var(--baseline)'}" />`}
        ${showValue ? `<text class="bar-value" x="${cx}" y="${(week.newReviews > 0 ? top : baseline) - 7}" text-anchor="middle">${week.newReviews}</text>` : ''}
        <text class="tick" x="${cx}" y="${height - 14}" text-anchor="middle">${esc(label)}</text>
      </g>`;
    })
    .join('');

  const began = formatDate(series[0].weekEnding, { day: 'numeric', month: 'long', year: 'numeric' });
  return `
  <figure class="chart">
    <figcaption>
      <h3>${esc(report.client.name)}, new reviews week by week</h3>
      <p class="legend">Tracking began ${esc(began)}. Reviews earned before then are in the total, but week by week figures only exist from that date.</p>
    </figcaption>
    <div class="scroller"><svg viewBox="-10 -2 ${width + 20} ${height + 4}" role="img" aria-label="New reviews per week for ${esc(report.client.name)}. Every value is listed in the table below.">
      ${grid}
      ${columns}
    </svg></div>
  </figure>`;
}

function statTiles(report) {
  const { row, group } = report;
  const tiles = [
    { label: 'Reviews in total', value: num(row.total) },
    { label: 'Star rating', value: row.rating === null ? 'n/a' : row.rating.toFixed(1) },
    {
      label: 'Position locally',
      value: row.rank ? `${ordinal(row.rank)} (out of ${group.size})` : 'n/a',
    },
    {
      label: "Share of the area's new reviews",
      value: pct(group.shareOfNew),
    },
    {
      label: 'Weeks in a row',
      value: row.streak > 0 ? String(row.streak) : '0',
    },
    {
      label: 'Your recent pace',
      value: row.pace ? `${row.pace.perWeek}/wk` : 'n/a',
    },
  ];
  return `<div class="tiles">${tiles
    .map(
      (tile) =>
        `<div class="tile"><span class="tile-label">${esc(tile.label)}</span><span class="tile-value">${esc(tile.value)}</span></div>`
    )
    .join('')}</div>`;
}

function chasePanel(report) {
  const { chase, lead, row } = report;
  if (lead) {
    return `<section class="panel panel-good">
      <h3>You are top of your local table</h3>
      <p>${esc(lead.margin)} reviews clear of ${esc(lead.name)}. The gap holds as long as the asking does.</p>
    </section>`;
  }
  if (!chase) return '';
  const target = chase.gap + row.total;
  let outlook;
  if (chase.weeksToOvertake) {
    outlook = `At the pace of the last month you overtake them in about ${chase.weeksToOvertake} week${chase.weeksToOvertake === 1 ? '' : 's'}.`;
  } else if (chase.closingPerWeek !== null && chase.closingPerWeek <= 0) {
    outlook = 'They are gaining reviews faster than you at the moment, so the gap is widening rather than closing.';
  } else {
    outlook = 'Not enough history yet to say how long it takes to close.';
  }
  return `<section class="panel">
    <h3>Next one to catch: ${esc(chase.name)}</h3>
    <p><strong>${esc(num(chase.gap))} reviews</strong> behind, on ${esc(num(target))} to your ${esc(num(row.total))}. ${esc(outlook)}</p>
  </section>`;
}

function leaderboard(report) {
  const rows = report.table
    .map(
      (row) => `
      <tr${row.isClient ? ' class="is-you"' : ''}>
        <td class="rank">${row.rank ?? ''}</td>
        <td>${esc(row.name)}${row.isClient ? ' <span class="you-tag">you</span>' : ''}</td>
        <td class="numeric">${num(row.total)}</td>
        <td class="numeric">${row.rating === null ? 'n/a' : row.rating.toFixed(1)}</td>
        <td class="numeric ${row.newReviews > 0 ? 'up' : ''}">${row.newReviews === null ? 'n/a' : signed(row.newReviews)}</td>
        <td class="numeric">${row.pace ? row.pace.perWeek.toFixed(1) : 'n/a'}</td>
      </tr>`
    )
    .join('');
  return `
  <div class="scroller"><table class="board">
    <caption>Every tracked practice, ranked on total reviews</caption>
    <thead>
      <tr>
        <th scope="col">#</th>
        <th scope="col">Practice</th>
        <th scope="col" class="numeric">Reviews</th>
        <th scope="col" class="numeric">Rating</th>
        <th scope="col" class="numeric">This week</th>
        <th scope="col" class="numeric">Per week</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function problems(report) {
  if (report.problems.length === 0) return '';
  const items = report.problems
    .map(
      (row) =>
        `<li><strong>${esc(row.name)}</strong>: ${esc(
          row.status === 'not_found'
            ? 'Google no longer recognises this place ID. The profile may have been merged, moved or removed, so it needs relinking.'
            : `no reading this week (${row.error ?? row.status})${row.lastSeenAt ? `, last read ${formatDate(row.lastSeenAt)}` : ''}`
        )}</li>`
    )
    .join('');
  return `<section class="notice"><h3>Profiles needing attention</h3><ul>${items}</ul></section>`;
}

function headline(report) {
  const { row } = report;
  if (row.status !== 'ok') {
    return `<div class="hero"><p class="hero-note">We could not read this Google profile on this run. See the note below.</p></div>`;
  }
  if (row.baseline) {
    return `<div class="hero">
      <p class="hero-label">First reading</p>
      <p class="hero-figure">${num(row.total)}</p>
      <p class="hero-note">reviews on the board today. From next week this shows what has been added.</p>
    </div>`;
  }
  const period = row.exactWeek ? 'this week' : `over the last ${row.days} days`;
  const word = row.newReviews === 1 ? 'new review' : 'new reviews';
  return `<div class="hero">
    <p class="hero-label">Reviews gained ${esc(period)}</p>
    <p class="hero-figure ${row.newReviews > 0 ? 'up' : ''}">${signed(row.newReviews)}</p>
    <p class="hero-note">${esc(word)} on Google, taking ${esc(report.client.name)} to ${num(row.total)} in total at ${row.rating === null ? 'n/a' : row.rating.toFixed(1)} stars.</p>
  </div>`;
}

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px 16px 56px;
    background: var(--plane);
    color: var(--text-primary);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 16px;
    line-height: 1.5;
  }
  .sheet {
    max-width: 780px;
    margin: 0 auto;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 32px 28px 28px;
  }
  header { border-bottom: 1px solid var(--grid); padding-bottom: 18px; margin-bottom: 26px; }
  .eyebrow { margin: 0 0 4px; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
  h1 { margin: 0; font-size: 26px; line-height: 1.2; letter-spacing: -0.01em; }
  header p.sub { margin: 6px 0 0; color: var(--text-secondary); font-size: 14px; }
  h2 { font-size: 15px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); margin: 34px 0 12px; font-weight: 600; }
  h3 { font-size: 16px; margin: 0 0 4px; }

  .hero { margin: 0 0 22px; }
  .hero-label { margin: 0; font-size: 13px; color: var(--text-secondary); }
  .hero-figure { margin: 2px 0 2px; font-size: 62px; line-height: 1; font-weight: 600; letter-spacing: -0.03em; }
  .hero-figure.up { color: var(--good-ink); }
  .hero-note { margin: 0; color: var(--text-secondary); font-size: 15px; max-width: 46ch; }

  .tiles { display: grid; grid-template-columns: repeat(3, 1fr); background: var(--surface); border: 1px solid var(--grid); border-radius: 10px; overflow: hidden; }
  .tile { padding: 12px 14px; border-right: 1px solid var(--grid); border-bottom: 1px solid var(--grid); }
  .tiles .tile:nth-child(3n) { border-right: 0; }
  .tiles .tile:nth-last-child(-n+3) { border-bottom: 0; }
  .tile-label { display: block; font-size: 12px; color: var(--muted); }
  .tile-value { display: block; font-size: 22px; font-weight: 600; margin-top: 2px; letter-spacing: -0.01em; }

  .panel { margin: 26px 0 0; padding: 16px 18px; border: 1px solid var(--grid); border-left: 3px solid var(--series-you); border-radius: 8px; background: var(--surface); }
  .panel-good { border-left-color: var(--good-ink); }
  .panel p { margin: 4px 0 0; color: var(--text-secondary); font-size: 15px; }
  .panel strong { color: var(--text-primary); }

  .chart { margin: 26px 0 0; }
  .chart figcaption { margin-bottom: 8px; }
  .scroller { overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; }
  .chart svg { width: 100%; height: auto; display: block; min-width: 580px; }
  .chart .scroller { padding: 2px 2px 4px; }
  .legend { margin: 4px 0 0; font-size: 12px; color: var(--text-secondary); display: flex; gap: 16px; flex-wrap: wrap; }
  .key { display: inline-flex; align-items: center; gap: 6px; }
  .swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  .swatch-you { background: var(--series-you); }
  .swatch-them { background: var(--series-them); }
  .axis-label { font-size: 12px; fill: var(--text-secondary); }
  .axis-label.is-you { fill: var(--text-primary); font-weight: 600; }
  .bar-value { font-size: 12px; font-weight: 600; fill: var(--text-primary); font-variant-numeric: tabular-nums; }
  .bar-value .gain { fill: var(--good-ink); }
  .tick { font-size: 11px; fill: var(--muted); font-variant-numeric: tabular-nums; }
  .bar-row:hover path, .bar-row:hover rect { opacity: 0.82; }

  table.board { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 14px; min-width: 460px; }
  table.board caption { text-align: left; font-size: 12px; color: var(--muted); padding-bottom: 8px; }
  .board th { text-align: left; font-weight: 600; font-size: 12px; letter-spacing: 0.03em; text-transform: uppercase; color: var(--muted); padding: 6px 8px; border-bottom: 1px solid var(--grid); }
  .board td { padding: 9px 8px; border-bottom: 1px solid var(--grid); }
  .board .numeric { text-align: right; font-variant-numeric: tabular-nums; }
  .board .rank { color: var(--muted); font-variant-numeric: tabular-nums; width: 28px; }
  .board tr.is-you td { background: var(--you-wash); font-weight: 600; }
  .board .up { color: var(--good-ink); }
  .you-tag { font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--surface); background: var(--series-you); border-radius: 3px; padding: 2px 5px; vertical-align: 2px; font-weight: 700; }

  .notice { margin-top: 26px; padding: 14px 16px; border: 1px solid var(--grid); border-left: 3px solid var(--warn); border-radius: 8px; }
  .notice ul { margin: 6px 0 0; padding-left: 18px; color: var(--text-secondary); font-size: 14px; }

  .message { margin-top: 12px; white-space: pre-wrap; font-size: 14px; line-height: 1.6; color: var(--text-secondary); background: var(--you-wash); border: 1px solid var(--grid); border-radius: 8px; padding: 16px 18px; }

  footer { margin-top: 34px; padding-top: 16px; border-top: 1px solid var(--grid); font-size: 12px; line-height: 1.6; color: var(--muted); }
  footer p { margin: 0 0 8px; }
  footer strong { color: var(--text-secondary); }

  @media print {
    body { background: #fff; padding: 0; }
    .sheet { border: 0; max-width: none; }
    .bar-row:hover path { opacity: 1; }
  }
  @media (max-width: 560px) {
    .sheet { padding: 22px 16px; }
    .hero-figure { font-size: 48px; }
    .tiles { grid-template-columns: repeat(2, 1fr); }
    .tiles .tile:nth-child(3n) { border-right: 1px solid var(--grid); }
    .tiles .tile:nth-child(2n) { border-right: 0; }
    .tiles .tile:nth-last-child(-n+3) { border-bottom: 1px solid var(--grid); }
    .tiles .tile:nth-last-child(-n+2) { border-bottom: 0; }
  }
  @media print {
    .scroller { overflow: visible; }
  }
`;

const TOKENS = `
  :root {
    --plane: #f9f9f7;
    --surface: #fcfcfb;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --muted: #898781;
    --grid: #e1e0d9;
    --baseline: #c3c2b7;
    --border: rgba(11, 11, 11, 0.10);
    --series-you: #2a78d6;
    --series-them: #898781;
    --good-ink: #006300;
    --warn: #fab219;
    --critical: #d03b3b;
    --you-wash: rgba(42, 120, 214, 0.07);
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      --plane: #0d0d0d;
      --surface: #1a1a19;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --muted: #898781;
      --grid: #2c2c2a;
      --baseline: #383835;
      --border: rgba(255, 255, 255, 0.10);
      --series-you: #3987e5;
      --series-them: #898781;
      --good-ink: #0ca30c;
      --warn: #fab219;
      --critical: #d03b3b;
      --you-wash: rgba(57, 135, 229, 0.12);
    }
  }
  :root[data-theme="dark"] {
    --plane: #0d0d0d;
    --surface: #1a1a19;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --muted: #898781;
    --grid: #2c2c2a;
    --baseline: #383835;
    --border: rgba(255, 255, 255, 0.10);
    --series-you: #3987e5;
    --series-them: #898781;
    --good-ink: #0ca30c;
    --warn: #fab219;
    --critical: #d03b3b;
    --you-wash: rgba(57, 135, 229, 0.12);
  }
`;


/**
 * Paint a client's own brand over the report's tokens.
 *
 * Only the tokens that carry identity move: the practice's own series colour,
 * its wash, and the typeface. Everything the eye needs to read a chart, the
 * gridlines, the baseline, the text greys, is left alone, because a brand
 * palette chosen for a shopfront is not chosen for legibility at 11px.
 *
 * The two brand colours are used in opposite roles per theme. Murgatroyd's
 * navy is the readable one on a pale background and their turquoise is the
 * readable one on a dark background, so each takes the series colour in the
 * theme where it has the contrast to earn it.
 */
function brandTokens(brand) {
  if (!brand) return '';
  const wash = (hex, alpha) => {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  };

  // Which brand colour carries the data, per theme.
  //
  // Defaulting the pale theme to the brand's primary and the dark theme to its
  // accent works when a brand is a dark colour plus a bright one, as Murgatroyd
  // is. It does not always: Kemp & Kerrigan's primary is a near black charcoal,
  // which as a bar would be indistinguishable from the body text, and their tan
  // is documented in their own stylesheet as safe only on charcoal. Their brand
  // supplies a third, darker tan for exactly this job, so a brand can name the
  // colour for each theme rather than having it inferred.
  const seriesLight = brand.seriesLight ?? brand.primary;
  const seriesDark = brand.seriesDark ?? brand.accent;
  return `
  :root {
    --brand-primary: ${brand.primary};
    --brand-accent: ${brand.accent};
    --brand-on-primary: ${brand.onPrimary ?? '#ffffff'};
    --series-you: ${seriesLight};
    --you-wash: ${wash(seriesLight, 0.07)};
    --font-brand: ${brand.font ? `"${brand.font}", ` : ''}system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      --series-you: ${seriesDark};
      --you-wash: ${wash(seriesDark, 0.12)};
    }
  }
  body { font-family: var(--font-brand); }
  .brandbar {
    background: var(--brand-primary);
    border-radius: 10px 10px 0 0;
    padding: 20px 24px;
    display: flex; align-items: center; gap: 18px; flex-wrap: wrap;
  }
  .brandbar img { height: 42px; width: auto; display: block; }
  .brandbar p {
    margin: 0; color: var(--brand-accent);
    font-size: 13px; letter-spacing: 0.02em;
  }
  .sheet:has(.brandbar) > header { padding-top: 22px; }
  @media (max-width: 560px) { .brandbar { padding: 16px; gap: 12px; } .brandbar img { height: 34px; } }
`;
}

/** The navy band carrying the practice's logo. Nothing here is load bearing. */
function brandBar(brand) {
  if (!brand) return '';
  const logo = brand.logoDataUri
    ? `<img src="${brand.logoDataUri}" alt="${esc(brand.name)}">`
    : `<strong style="color:var(--brand-on-primary);font-size:19px">${esc(brand.name)}</strong>`;
  return `<div class="brandbar">${logo}${brand.tagline ? `<p>${esc(brand.tagline)}</p>` : ''}</div>`;
}

/** The fonts a brand asks for, fetched only when one is named. */
function brandFontLink(brand) {
  if (!brand?.font) return '';
  const family = brand.font.replace(/ /g, '+');
  return `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=${family}:wght@400;600;700&display=swap" rel="stylesheet">`;
}

export function renderReport(report, { agencyName = 'Spring View Marketing', message = null, brand = null } = {}) {
  const week = formatDate(report.weekEnding);
  const title = `${report.client.name}, Google reviews to ${week}`;
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${brandFontLink(brand)}
<style>${TOKENS}${STYLE}${brandTokens(brand)}</style>
</head>
<body>
<main class="sheet">
  ${brandBar(brand)}
  <header>
    <p class="eyebrow">${esc(agencyName)} &middot; weekly review report</p>
    <h1>${esc(report.client.name)}</h1>
    <p class="sub">Google reviews, week ending ${esc(week)}${report.client.area ? ` &middot; ${esc(report.client.area)}` : ''}</p>
  </header>

  ${headline(report)}
  ${statTiles(report)}
  ${chasePanel(report)}
  ${packChart(report)}
  ${trendChart(report)}

  <h2>The local table</h2>
  ${leaderboard(report)}
  ${problems(report)}

  ${message ? `<h2>Ready to send</h2><div class="message">${esc(message)}</div>` : ''}

  <footer>
    <p><strong>How these numbers are produced.</strong> Totals come from the Google Places API, read once a week. Google publishes a live review count rather than a dated list, so a weekly figure is the difference between two readings. It is a net figure: if Google removes a review it judges to be spam in the same week one arrives, the two cancel out. The count includes star-only ratings left without written text.</p>
    <p><strong>A note on asking.</strong> Ask every patient, in person, at the point they say they are happy. Never offer anything in return for a review and never filter who gets asked based on how pleased they seem. Both breach Google's policies and UK consumer law, and both are enforced. A spread of ratings reads as more credible than an unbroken wall of fives.</p>
    <p>Prepared by ${esc(agencyName)}. For the practice's own use, not for publication.</p>
  </footer>
</main>
</body>
</html>
`;
}

/** A one-page index across every client, for the agency's own view. */
export function renderIndex(reports, { agencyName = 'Spring View Marketing' } = {}) {
  const week = formatDate(reports[0]?.weekEnding);
  const rows = reports
    .map((report) => {
      const { row } = report;
      const status =
        row.status !== 'ok'
          ? '<td colspan="5" class="numeric">no reading this week</td>'
          : `<td class="numeric ${row.newReviews > 0 ? 'up' : ''}">${row.newReviews === null ? 'baseline' : signed(row.newReviews)}</td>
             <td class="numeric">${num(row.total)}</td>
             <td class="numeric">${row.rating === null ? 'n/a' : row.rating.toFixed(1)}</td>
             <td class="numeric">${row.rank ?? 'n/a'} of ${report.group.size}</td>
             <td class="numeric">${pct(report.group.shareOfNew)}</td>`;
      return `<tr><td><a href="${esc(report.client.id)}.html">${esc(report.client.name)}</a></td>${status}</tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(agencyName)}, review tracker, week ending ${esc(week)}</title>
<style>${TOKENS}${STYLE}
  .board a { color: var(--series-you); text-decoration: none; font-weight: 600; }
  .board a:hover { text-decoration: underline; }
</style>
</head>
<body>
<main class="sheet">
  <header>
    <p class="eyebrow">${esc(agencyName)} &middot; weekly review report</p>
    <h1>Every client, week ending ${esc(week)}</h1>
    <p class="sub">${reports.length} ${reports.length === 1 ? 'practice' : 'practices'} tracked. Open a practice for its own report.</p>
  </header>
  <div class="scroller"><table class="board">
    <thead><tr>
      <th scope="col">Practice</th>
      <th scope="col" class="numeric">This week</th>
      <th scope="col" class="numeric">Total</th>
      <th scope="col" class="numeric">Rating</th>
      <th scope="col" class="numeric">Local rank</th>
      <th scope="col" class="numeric">Share of new</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
  <footer><p>Totals read from the Google Places API. Weekly figures are the net difference between two readings.</p></footer>
</main>
</body>
</html>
`;
}

/**
 * One page covering every branch of a single practice.
 *
 * Built for the owner of a two-shop business who wants one link, not two. The
 * branches are deliberately kept in separate sections with their own table and
 * chart rather than merged into a combined total, because they compete in
 * different towns against different practices: adding Conisbrough's eleven to
 * Staveley's twenty eight would produce a number that means nothing to anyone
 * and would hide whichever branch had stopped asking.
 *
 * The strip at the top is the only place the two are seen together, and it
 * compares them only on the things that are genuinely comparable.
 */
export function renderGroupReport(reports, { agencyName = 'Spring View Marketing', brand = null } = {}) {
  const week = formatDate(reports[0]?.weekEnding);
  const title = `${brand?.name ?? 'Practice'}, Google reviews to ${week}`;

  const summary = reports
    .map((report) => {
      const { row } = report;
      const label = report.client.branch ?? report.client.name;
      const change =
        row.status !== 'ok'
          ? 'no reading'
          : row.newReviews === null
            ? 'first reading'
            : `${signed(row.newReviews)} this week`;
      return `
      <a class="branch-tile" href="#${esc(report.client.anchor)}">
        <span class="branch-name">${esc(label)}</span>
        <span class="branch-total">${num(row.total)}</span>
        <span class="branch-meta">reviews &middot; ${row.rating === null ? 'n/a' : row.rating.toFixed(1)} stars</span>
        <span class="branch-meta ${row.newReviews > 0 ? 'up' : ''}">${esc(change)}</span>
      </a>`;
    })
    .join('');

  const sections = reports
    .map(
      (report) => `
  <section class="branch" id="${esc(report.client.anchor)}">
    <h2>${esc(report.client.branch ?? report.client.name)}</h2>
    <p class="sub">${esc(report.client.name)}${report.client.area ? ` &middot; ${esc(report.client.area)}` : ''}</p>
    ${headline(report)}
    ${statTiles(report)}
    ${chasePanel(report)}
    ${packChart(report)}
    ${trendChart(report)}
    <h3>The local table</h3>
    ${leaderboard(report)}
    ${problems(report)}
  </section>`
    )
    .join('');

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
${brandFontLink(brand)}
<style>${TOKENS}${STYLE}${brandTokens(brand)}
  .branches { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin: 22px 0 6px; }
  .branch-tile {
    display: grid; gap: 2px; padding: 16px 18px; text-decoration: none;
    background: var(--you-wash); border: 1px solid var(--border); border-radius: 10px;
    color: var(--text-primary);
  }
  .branch-tile:hover { border-color: var(--series-you); }
  .branch-name { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); }
  .branch-total { font-size: 34px; font-weight: 700; line-height: 1.1; color: var(--series-you); }
  .branch-meta { font-size: 13px; color: var(--text-secondary); }
  .branch-meta.up { color: var(--good-ink); font-weight: 600; }
  html { scroll-behavior: smooth; }
  @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
  .branch { scroll-margin-top: 18px; margin-top: 34px; padding-top: 20px; border-top: 2px solid var(--border); }
  .branch:first-of-type { margin-top: 24px; }
  .branch > h2 { margin-top: 0; }
  .branch > .sub { margin-top: -6px; }
</style>
</head>
<body>
<main class="sheet">
  ${brandBar(brand)}
  <header>
    <p class="eyebrow">${esc(agencyName)} &middot; weekly review report</p>
    <h1>${esc(brand?.name ?? 'Your practice')}</h1>
    <p class="sub">Google reviews, week ending ${esc(week)} &middot; ${reports.length} ${reports.length === 1 ? 'branch' : 'branches'}</p>
  </header>

  <div class="branches">${summary}</div>

  ${sections}

  <footer>
    <p><strong>Why the branches are not added together.</strong> Each one competes in its own town against its own set of practices, so a combined total would not correspond to any league table either branch is actually in. The figures are kept apart for the same reason they are worth having at all.</p>
    <p><strong>How these numbers are produced.</strong> Totals come from the Google Places API, read once a week. Google publishes a live review count rather than a dated list, so a weekly figure is the difference between two readings. It is a net figure: if Google removes a review it judges to be spam in the same week one arrives, the two cancel out. The count includes star-only ratings left without written text.</p>
    <p><strong>A note on asking.</strong> Ask every patient, in person, at the point they say they are happy. Never offer anything in return for a review and never filter who gets asked based on how pleased they seem. Both breach Google's policies and UK consumer law, and both are enforced. A spread of ratings reads as more credible than an unbroken wall of fives.</p>
    <p>Prepared by ${esc(agencyName)}. For the practice's own use, not for publication.</p>
  </footer>
</main>
</body>
</html>
`;
}
