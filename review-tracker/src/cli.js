#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { loadConfig, loadEnv, allPlaces } from './config.js';
import { PlacesClient, fetchAll } from './places.js';
import { loadHistory, saveHistory, addSnapshot, toPlaceMap, isReadingFresh } from './store.js';
import { buildAllReports } from './metrics.js';
import { renderReport, renderIndex, renderGroupReport } from './render/html.js';
import { practiceMessage, terminalSummary, formatDate } from './render/text.js';
import { toCsv } from './render/csv.js';
import { demoConfig, demoHistory } from './demo-data.js';
import { resolveAnchor, findNearby, shortlist, disambiguateNames } from './nearby.js';
import { readClientFile, upsertClient, writeClientFile, slugify, reportPath, reportHref } from './client-file.js';
import { buildEmail } from './render/email.js';
import { milesToMetres } from './geo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `
review-tracker, weekly Google review counts for practices and their local rivals

  snapshot            read every tracked profile and store this week's totals
  report              rebuild the reports from stored history, no API calls
  weekly              snapshot, then report (this is what the schedule runs)
  discover "<query>"  find place IDs by name, for setting a practice up
  add-client "<practice>"  find a practice, pick its competitors and add it to
                      the config. One command, nothing to copy by hand.
  nearby "<practice>" the same search, but printed rather than saved
  demo                write a worked example report from sample data, no API key

Options
  --config <path>   default config/practices.json
  --data <path>     default data/snapshots.json
  --out <dir>       default reports/
  --as-of <date>    treat this ISO date as "now" when reporting
  --weeks <n>       weeks of history to chart, default 12
  --miles <n>       radius for the nearby search, default 5
  --limit <n>       how many competitors to track, default 10
  --id <slug>       the client id to write, default taken from the name
  --include-chains yes   put Specsavers, Boots and the rest back in
  --site <dir>      where to publish the linkable reports, default docs/
  --site-url <url>  the address the site is served from
  --skip-if-fresh <hours>  read nothing if a complete reading is already
                    this recent. Used by the backup schedule slots.
  --quiet           print less
  --verbose         list every business the search looked at
`;

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const options = { command, positional: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key === 'quiet') options.quiet = true;
      else options[key] = rest[++i];
    } else {
      options.positional.push(arg);
    }
  }
  return options;
}

const resolve = (value, fallback) => path.resolve(ROOT, value ?? fallback);

/**
 * Publish each report to the site folder under its unguessable filename, and
 * write the email that links to it. Both are skipped without a site URL, since
 * a link to nowhere is worse than no link.
 */
/**
 * Read each brand's assets once. The logo is inlined as a data URI so a report
 * still renders with its branding when opened from disk or forwarded as a file,
 * which a link to the practice's own web server would not survive.
 */
async function loadBrands(config) {
  const brands = {};
  for (const [key, brand] of Object.entries(config.brands ?? {})) {
    let logoDataUri = null;
    if (brand.logo) {
      try {
        const bytes = await readFile(path.resolve(ROOT, brand.logo));
        logoDataUri = `data:image/png;base64,${bytes.toString('base64')}`;
      } catch {
        // A missing logo is a cosmetic problem. It must never stop a reading.
        console.warn(`  Note: brand logo not found at ${brand.logo}, falling back to the name.`);
      }
    }
    brands[key] = { ...brand, logoDataUri };
  }
  return brands;
}

/**
 * Publish each report to the site folder, and write the email that links to it.
 * Both are skipped without a site URL, since a link to nowhere is worse than
 * no link.
 *
 * A practice with more than one branch also gets a single combined page, and
 * its emails link there rather than to either branch, so the owner keeps one
 * address for the whole business.
 */
async function publishSite(reports, config, { siteDir, siteUrl, agencyName, senderName, brands }) {
  const byId = new Map(config.clients.map((client) => [client.id, client]));
  const absolute = (href) => (siteUrl ? `${siteUrl.replace(/\/$/, '')}/${href}` : null);

  const write = async (relative, html) => {
    await mkdir(path.join(siteDir, path.dirname(relative)), { recursive: true });
    await writeFile(path.join(siteDir, relative), html, 'utf8');
  };

  // Which brands have more than one branch, and so get a combined page.
  const grouped = new Map();
  for (const report of reports) {
    const client = byId.get(report.client.id);
    if (!client?.brand) continue;
    // The combined page needs the branch's short name and the anchor its
    // summary tile jumps to; neither is the report builder's concern, so both
    // are attached here where the config is in hand.
    report.client.branch = client.branch ?? null;
    report.client.anchor = reportHref(client).split('/').at(-2);
    if (!grouped.has(client.brand)) grouped.set(client.brand, []);
    grouped.get(client.brand).push(report);
  }

  // A branch of a multi-branch practice gets no page of its own. Everything it
  // would have held is already a section of the combined page, so a second copy
  // behind a second link was a page to maintain, a link to get wrong, and a
  // dead end to navigate back out of, for nothing the owner could not already
  // see. The summary tiles jump down the page instead.
  const combinedHref = new Map();
  for (const [key, members] of grouped) {
    const brand = brands[key];
    if (!brand || members.length < 2) continue;
    const href = `${brand.slug ?? key}/`;
    await write(`${href}index.html`, renderGroupReport(members, { agencyName, brand }));
    for (const report of members) combinedHref.set(report.client.id, href);
  }

  // Everyone else gets their own page.
  for (const report of reports) {
    const client = byId.get(report.client.id);
    if (!client || combinedHref.has(client.id)) continue;
    await write(
      reportPath(client),
      renderReport(report, { agencyName, message: null, brand: brands[client.brand] })
    );
  }

  const published = [];
  for (const report of reports) {
    const client = byId.get(report.client.id);
    if (!client) continue;
    const href = combinedHref.get(client.id) ?? reportHref(client);
    const url = absolute(href);
    const email = buildEmail(report, { reportUrl: url, agencyName, senderName });
    published.push({ id: client.id, name: client.name, to: client.contactEmail ?? null, url, email });
  }

  // The outbox is what the send step reads. It is written even with no
  // addresses configured, so a dry run shows exactly what would go out.
  await writeFile(
    path.join(siteDir, 'outbox.json'),
    `${JSON.stringify(
      published.map(({ id, name, to, url, email }) => ({ id, name, to, url, ...(email ?? {}) })),
      null,
      2
    )}\n`,
    'utf8'
  );
  return published;
}

async function writeReports(reports, { outDir, agencyName, quiet }) {
  await mkdir(outDir, { recursive: true });
  const written = [];
  for (const report of reports) {
    const message = report.row.status === 'ok' ? practiceMessage(report) : null;
    const file = path.join(outDir, `${report.client.id}.html`);
    await writeFile(file, renderReport(report, { agencyName, message }), 'utf8');
    written.push(file);
    if (message) {
      const messageFile = path.join(outDir, `${report.client.id}.txt`);
      await writeFile(messageFile, `${message}\n`, 'utf8');
      written.push(messageFile);
    }
  }
  if (reports.length > 0) {
    const indexFile = path.join(outDir, 'index.html');
    await writeFile(indexFile, renderIndex(reports, { agencyName }), 'utf8');
    written.push(indexFile);
    const csvFile = path.join(outDir, 'history.csv');
    await writeFile(csvFile, toCsv(reports), 'utf8');
    written.push(csvFile);
  }
  if (!quiet) {
    console.log(`\n  Wrote ${written.length} files to ${path.relative(ROOT, outDir) || '.'}/`);
  }
  return written;
}

async function commandSnapshot(options) {
  const config = await loadConfig(resolve(options.config, 'config/practices.json'));
  const dataFile = resolve(options.data, 'data/snapshots.json');
  const places = allPlaces(config);
  const history = await loadHistory(dataFile);

  // The schedule fires several times over, so that a run GitHub delays or drops
  // is picked up by a later slot. Once one of them has stored a complete
  // reading the rest have nothing to do, and saying so costs no API calls.
  // A manual run never skips: reading afresh is the whole point of the button.
  const skipIfFresh = Number(options['skip-if-fresh'] ?? 0);
  if (skipIfFresh > 0 && isReadingFresh(history, { withinHours: skipIfFresh })) {
    if (!options.quiet) {
      console.log(
        `  A complete reading from ${formatDate(history.snapshots.at(-1).takenAt)} is already stored, so this run read nothing.`
      );
    }
    return { config, history, failures: [], skipped: true };
  }

  const client = new PlacesClient({
    apiKey: process.env.GOOGLE_MAPS_API_KEY,
    regionCode: config.agency?.regionCode ?? 'GB',
    languageCode: config.agency?.languageCode ?? 'en-GB',
  });

  if (!options.quiet) console.log(`  Reading ${places.length} Google profiles...`);
  const results = await fetchAll(client, places, {
    onResult: (record) => {
      if (options.quiet) return;
      const label = record.name ?? record.configName;
      console.log(
        record.status === 'ok'
          ? `    ok    ${label}: ${record.totalReviews} reviews, ${record.rating ?? 'n/a'} stars`
          : `    FAIL  ${label}: ${record.error}`
      );
    },
  });

  const failures = results.filter((result) => result.status !== 'ok');
  const { merged } = addSnapshot(history, {
    takenAt: new Date().toISOString(),
    places: toPlaceMap(results),
  });
  await saveHistory(dataFile, history);

  // A place ID Google has re-issued keeps working for now but will not forever.
  for (const result of results) {
    if (result.status === 'ok' && result.currentPlaceId && result.currentPlaceId !== result.placeId) {
      console.warn(
        `  Note: Google now returns a different place ID for ${result.name}. Update the config to ${result.currentPlaceId}`
      );
    }
  }

  if (!options.quiet) {
    console.log(
      `  ${merged ? 'Merged into' : 'Stored as'} the reading for ${formatDate(history.snapshots.at(-1).takenAt)}. ${failures.length} failed. ${client.callCount} API calls.`
    );
  }
  return { config, history, failures };
}

async function commandReport(options, preloaded) {
  const config = preloaded?.config ?? (await loadConfig(resolve(options.config, 'config/practices.json')));
  const history = preloaded?.history ?? (await loadHistory(resolve(options.data, 'data/snapshots.json')));

  if (history.snapshots.length === 0) {
    console.error('  No readings stored yet. Run: npm run snapshot');
    process.exitCode = 1;
    return;
  }

  const reports = buildAllReports(config, history, {
    asOf: options['as-of'],
    weeks: Number(options.weeks ?? 12),
  });
  if (!options.quiet) console.log(terminalSummary(reports));
  await writeReports(reports, {
    outDir: resolve(options.out, 'reports'),
    agencyName: config.agency?.name ?? 'Spring View Marketing',
    quiet: options.quiet,
  });

  const siteUrl = options['site-url'] ?? config.agency?.siteUrl ?? null;
  const brands = await loadBrands(config);
  const published = await publishSite(reports, config, {
    brands,
    siteDir: resolve(options.site, '../docs'),
    siteUrl,
    agencyName: config.agency?.name ?? 'Spring View Marketing',
    senderName: config.agency?.senderName ?? 'Tom',
  });

  if (!options.quiet) {
    const addressed = published.filter((entry) => entry.to && entry.email).length;
    console.log(`  Published ${published.length} report${published.length === 1 ? '' : 's'} to the site.`);
    console.log(
      `  ${addressed} of ${published.length} ${addressed === 1 ? 'has' : 'have'} a contact address and an email ready to send.`
    );
    if (!siteUrl) console.log('  No siteUrl set, so the emails carry no link. Add it to "agency" in the config.');
  }
}

async function commandDiscover(options) {
  const query = options.positional.join(' ');
  if (!query) {
    console.error('  Give it something to search for, e.g. discover "opticians in Hillsborough Sheffield"');
    process.exitCode = 1;
    return;
  }
  const client = new PlacesClient({ apiKey: process.env.GOOGLE_MAPS_API_KEY });
  const places = await client.searchText(query);
  if (places.length === 0) {
    console.log('  Nothing found. Try the practice name with its town.');
    return;
  }
  console.log(`\n  ${places.length} results for "${query}"\n`);
  for (const place of places) {
    console.log(`  ${place.name}`);
    console.log(`    ${place.address ?? ''}`);
    console.log(`    ${place.totalReviews} reviews, ${place.rating ?? 'n/a'} stars${place.businessStatus && place.businessStatus !== 'OPERATIONAL' ? `, ${place.businessStatus}` : ''}`);
    console.log(`    "placeId": "${place.placeId}"`);
    console.log('');
  }
  console.log('  Paste the placeId lines into config/practices.json.\n');
}

const slug = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'practice';

function configBlock(anchor, rivals, id) {
  return JSON.stringify(
    {
      id,
      name: anchor.name,
      placeId: anchor.placeId,
      area: anchor.address ?? null,
      searchTerm: 'opticians near me',
      competitors: rivals.map((rival) => ({ name: rival.name, placeId: rival.placeId })),
    },
    null,
    2
  );
}

async function commandNearby(options) {
  const target = options.positional.join(' ');
  if (!target) {
    console.error('  Give it a practice, e.g. nearby "Murgatroyd Opticians Conisbrough" --miles 5');
    process.exitCode = 1;
    return;
  }

  const miles = Number(options.miles ?? 5);
  if (!Number.isFinite(miles) || miles <= 0 || miles > 31) {
    console.error('  --miles must be between 0 and 31. Google will not restrict a search wider than 50km.');
    process.exitCode = 1;
    return;
  }

  const client = new PlacesClient({ apiKey: process.env.GOOGLE_MAPS_API_KEY });
  const anchor = await resolveAnchor(client, target);

  console.log(`\n  Centred on ${anchor.name}`);
  console.log(`    ${anchor.address ?? ''}`);
  console.log(`    ${anchor.totalReviews ?? '?'} reviews, ${anchor.rating ?? 'n/a'} stars`);
  if (anchor.matched) console.log('    (matched by name. If that is the wrong branch, re-run with its place ID.)');
  console.log(`\n  Searching ${miles} miles around it...\n`);

  const radius = milesToMetres(miles);
  const places = await findNearby(client, { center: anchor.location, radiusMetres: radius });
  const anchorTotal = places.find((p) => p.placeId === anchor.placeId)?.totalReviews ?? anchor.totalReviews ?? 0;

  const includeChains = options['include-chains'] === 'yes' || options['include-chains'] === true;
  const { ladder, tooBig, tooSmall, notOpticians, chains, ceiling } = shortlist(places, {
    anchorPlaceId: anchor.placeId,
    anchorTotal,
    limit: Number(options.limit ?? 10),
    includeChains,
  });

  const chosen = new Set(ladder.map((p) => p.placeId));
  // The place ID and address go on every line, not just the shortlisted ones.
  // Curating the list by hand means picking practices the shortlist rejected,
  // and that needs their IDs; the address is what tells four branches of the
  // same practice apart, which a distance from the anchor never could.
  const line = (place, mark) =>
    `  ${mark} ${String(place.miles).padStart(4)}mi  ${String(place.totalReviews).padStart(5)} reviews  ${String(place.rating ?? 'n/a').padStart(3)}*  ${place.name}\n        ${place.placeId}  ${place.address ?? 'no address'}`;

  const excluded = new Set([...chains, ...notOpticians].map((p) => p.placeId));
  const opticians = places.filter((place) => place.isOptician !== false && !excluded.has(place.placeId));
  console.log(`  ${opticians.length} opticians within ${miles} miles. A + marks the ones shortlisted.\n`);
  for (const place of opticians) {
    const mark = place.placeId === anchor.placeId ? ' *' : chosen.has(place.placeId) ? ' +' : '  ';
    const why =
      place.placeId === anchor.placeId
        ? 'the practice itself'
        : chosen.has(place.placeId)
          ? ''
          : place.totalReviews > ceiling
            ? `too far ahead to chase, over ${ceiling}`
            : place.totalReviews < 5
              ? 'too few reviews to be a benchmark'
              : 'comparable, but outside the shortlist';
    console.log(line(place, mark));
    if (why) console.log(`          ${why}`);
  }

  if (chains.length > 0) {
    console.log(`\n  Chains and supermarket concessions, left out on purpose:\n`);
    for (const place of chains) console.log(line(place, '  '));
    console.log('\n  A chain is not a target anyone can catch, at any size. Add --include-chains if');
    console.log('  this practice is big enough to genuinely compete with one.');
  }

  // Shown rather than silently dropped: the name test is a judgement call, and
  // a genuine practice with an unusual name would otherwise vanish unnoticed.
  if (notOpticians.length > 0) {
    console.log(`\n  Ignored, because they do not look like opticians:\n`);
    for (const place of notOpticians) console.log(line(place, '  '));
    console.log('\n  If a real practice is in that list, add it to the block below by hand.');
  }

  if (ladder.length === 0) {
    console.log('\n  Nothing comparable found. Widen the radius with --miles, or check the anchor is right.');
    return;
  }

  console.log(
    `\n  Shortlisted ${ladder.length}. Skipped ${chains.length} chains, ${tooBig.length} as too far ahead, ${tooSmall.length} as too small, ${notOpticians.length} as not opticians.`
  );
  console.log(`\n  Paste this into the "clients" array in config/practices.json:\n`);
  console.log(configBlock(anchor, ladder, options.id ?? slug(anchor.name)));
  console.log(`\n  ${client.callCount} API calls used.\n`);
}

/** The shared search: resolve the practice, find rivals, pick the ladder. */
async function findClient(client, target, options) {
  const miles = Number(options.miles ?? 5);
  if (!Number.isFinite(miles) || miles <= 0 || miles > 31) {
    const error = new Error('--miles must be between 0 and 31. Google will not restrict a search wider than 50km.');
    error.expected = true;
    throw error;
  }

  const anchor = await resolveAnchor(client, target);
  const found = await findNearby(client, { center: anchor.location, radiusMetres: milesToMetres(miles) });
  const places = disambiguateNames(found);
  const anchorTotal = places.find((p) => p.placeId === anchor.placeId)?.totalReviews ?? anchor.totalReviews ?? 0;

  const buckets = shortlist(places, {
    anchorPlaceId: anchor.placeId,
    anchorTotal,
    limit: Number(options.limit ?? 10),
    includeChains: options['include-chains'] === 'yes' || options['include-chains'] === true,
  });

  return { anchor, anchorTotal, places, miles, ...buckets };
}

const reviewLine = (place, mark = '  ') =>
  `  ${mark} ${String(place.miles ?? 0).padStart(4)}mi  ${String(place.totalReviews).padStart(5)} reviews  ${String(place.rating ?? 'n/a').padStart(3)}*  ${place.name}`;

/** The short version: what was added, who it is up against, what to check. */
function printSummary(result, { clientCount, replaced, file }) {
  const { anchor, anchorTotal, ladder, chains, notOpticians, tooBig, tooSmall, miles } = result;

  console.log(`\n  ${replaced ? 'Updated' : 'Added'} ${anchor.name}.\n`);
  console.log('  CHECK THIS IS THE RIGHT PRACTICE');
  console.log(`    ${anchor.name}`);
  console.log(`    ${anchor.address ?? 'no address returned'}`);
  console.log(`    ${anchorTotal} reviews, ${anchor.rating ?? 'n/a'} stars`);
  console.log(`    https://www.google.com/maps/place/?q=place_id:${anchor.placeId}`);

  const table = [...ladder, { ...anchor, totalReviews: anchorTotal, isAnchor: true }].sort(
    (a, b) => b.totalReviews - a.totalReviews
  );
  console.log(`\n  Tracking it against ${ladder.length} nearby ${ladder.length === 1 ? 'practice' : 'practices'}:\n`);
  for (const place of table) {
    const mark = place.isAnchor ? '>>' : '  ';
    const distance = place.isAnchor ? '     ' : `${String(place.miles).padStart(4)}mi`;
    console.log(`  ${mark} ${String(place.totalReviews).padStart(5)}  ${distance}  ${place.name}`);
  }

  const above = table.filter((p) => !p.isAnchor && p.totalReviews > anchorTotal);
  const next = above.at(-1);
  console.log('');
  if (next) {
    const gap = next.totalReviews - anchorTotal;
    console.log(`  Next one to catch: ${next.name}, ${gap} review${gap === 1 ? '' : 's'} ahead.`);
  } else if (ladder.length > 0) {
    console.log('  Already top of this table. The job is holding the lead.');
  } else {
    console.log(`  No comparable practices found within ${miles} miles. Try a wider radius.`);
  }

  const skipped = chains.length + notOpticians.length + tooBig.length + tooSmall.length;
  console.log(
    `\n  ${skipped} other nearby businesses were left out: ${chains.length} chains, ${notOpticians.length} not opticians, ${tooBig.length} too far ahead, ${tooSmall.length} too few reviews.`
  );
  console.log('  Run again with --verbose to see them listed.');
  console.log(`\n  Saved to ${file}. ${clientCount} ${clientCount === 1 ? 'practice' : 'practices'} now tracked.`);
}

/** The long version, for when a judgement call needs checking. */
function printDetail(result) {
  const { places, chains, notOpticians, ladder, miles } = result;
  const chosen = new Set(ladder.map((p) => p.placeId));
  const excluded = new Set([...chains, ...notOpticians].map((p) => p.placeId));

  console.log(`\n  Opticians within ${miles} miles. A + marks the ones picked.\n`);
  for (const place of places.filter((p) => p.isOptician !== false && !excluded.has(p.placeId))) {
    console.log(reviewLine(place, place.placeId === result.anchor.placeId ? ' *' : chosen.has(place.placeId) ? ' +' : '  '));
  }
  if (chains.length > 0) {
    console.log('\n  Chains and supermarket concessions, left out on purpose:\n');
    for (const place of chains) console.log(reviewLine(place));
  }
  if (notOpticians.length > 0) {
    console.log('\n  Not opticians, so ignored:\n');
    for (const place of notOpticians) console.log(reviewLine(place));
    console.log('\n  If a real practice is in that list, add it to the config by hand.');
  }
}

async function commandAddClient(options) {
  const target = options.positional.join(' ');
  if (!target) {
    console.error('  Give it a practice, e.g. add-client "Murgatroyd Holmes Opticians Staveley"');
    process.exitCode = 1;
    return;
  }

  const file = resolve(options.config, 'config/practices.json');
  const client = new PlacesClient({ apiKey: process.env.GOOGLE_MAPS_API_KEY });
  const result = await findClient(client, target, options);

  const entry = {
    id: options.id ?? slugify(result.anchor.name),
    name: result.anchor.name,
    placeId: result.anchor.placeId,
    area: result.anchor.address ?? null,
    searchTerm: options['search-term'] ?? 'opticians near me',
    competitors: result.ladder.map(({ name, placeId }) => ({ name, placeId })),
  };

  const existing = await readClientFile(file);
  const { config, replaced } = upsertClient(existing, entry);
  await writeClientFile(file, config);

  if (options.verbose !== undefined) printDetail(result);
  printSummary(result, { clientCount: config.clients.length, replaced, file: path.relative(ROOT, file) });
  console.log(`  ${client.callCount} API calls used.\n`);
}

async function commandDemo(options) {
  const outDir = resolve(options.out, 'reports/demo');
  const reports = buildAllReports(demoConfig, demoHistory(), { weeks: 12 });
  if (!options.quiet) console.log(terminalSummary(reports));
  await writeReports(reports, { outDir, agencyName: 'Spring View Marketing', quiet: options.quiet });
}

async function main() {
  loadEnv(ROOT);
  const options = parseArgs(process.argv.slice(2));

  switch (options.command) {
    case 'snapshot': {
      const state = await commandSnapshot(options);
      if (state.failures.length > 0) process.exitCode = 1;
      break;
    }
    case 'report':
      await commandReport(options);
      break;
    case 'weekly': {
      const state = await commandSnapshot(options);
      await commandReport(options, state);
      if (state.failures.length > 0) process.exitCode = 1;
      break;
    }
    case 'discover':
      await commandDiscover(options);
      break;
    case 'nearby':
      await commandNearby(options);
      break;
    case 'add-client':
      await commandAddClient(options);
      break;
    case 'demo':
      await commandDemo(options);
      break;
    default:
      console.log(USAGE);
  }
}

main().catch((error) => {
  // An expected failure is a config or key problem the user can fix; a stack
  // trace there is noise. Anything else is a bug and deserves the full trace.
  if (error.expected) {
    console.error(`\n  ${error.message}\n`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
