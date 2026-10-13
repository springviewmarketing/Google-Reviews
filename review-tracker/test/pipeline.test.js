import test from 'node:test';
import assert from 'node:assert/strict';

import { validateConfig, allPlaces } from '../src/config.js';
import { PlacesClient, fetchAll } from '../src/places.js';
import { addSnapshot, toPlaceMap } from '../src/store.js';
import { buildAllReports } from '../src/metrics.js';
import { renderReport, renderIndex } from '../src/render/html.js';
import { practiceMessage } from '../src/render/text.js';
import { toCsv } from '../src/render/csv.js';

const config = validateConfig({
  agency: { name: 'Spring View Marketing' },
  clients: [
    {
      id: 'test-practice',
      name: 'Test Practice',
      placeId: 'p-us',
      area: 'Sheffield',
      competitors: [
        { name: 'Rival One', placeId: 'p-one' },
        { name: 'Rival Two', placeId: 'p-two' },
      ],
    },
  ],
});

const stub = (counts) =>
  new PlacesClient({
    apiKey: 'k',
    maxRetries: 0,
    fetchImpl: async (url) => {
      const placeId = decodeURIComponent(url.split('/places/')[1].split('?')[0]);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: placeId,
          displayName: { text: placeId },
          rating: 4.6,
          userRatingCount: counts[placeId],
          businessStatus: 'OPERATIONAL',
        }),
      };
    },
  });

test('config, fetch, store, metrics and render work together over two weeks', async () => {
  const places = allPlaces(config);
  assert.deepEqual(places.map((p) => p.placeId), ['p-us', 'p-one', 'p-two']);

  const history = { version: 1, snapshots: [] };
  const weekOne = await fetchAll(stub({ 'p-us': 100, 'p-one': 200, 'p-two': 50 }), places);
  addSnapshot(history, { takenAt: '2026-09-07T08:00:00.000Z', places: toPlaceMap(weekOne) });

  const weekTwo = await fetchAll(stub({ 'p-us': 109, 'p-one': 202, 'p-two': 50 }), places);
  addSnapshot(history, { takenAt: '2026-09-14T08:00:00.000Z', places: toPlaceMap(weekTwo) });

  const [report] = buildAllReports(config, history);
  assert.equal(report.row.newReviews, 9);
  assert.equal(report.row.total, 109);
  assert.equal(report.row.rank, 2);
  assert.equal(report.chase.name, 'p-one');
  assert.equal(report.chase.gap, 93);
  assert.equal(report.group.newReviews, 11);

  const html = renderReport(report, { message: practiceMessage(report) });
  assert.match(html, /<!doctype html>/);
  assert.match(html, /Test Practice/);
  assert.match(html, /\+9/);
  assert.equal(html.includes('http://'), false, 'no external requests');
  assert.equal(/<(script|iframe)\b/i.test(html), false, 'no script or frame in the report');
  assert.equal((html.match(/class="hero-figure/g) ?? []).length, 1, "exactly one hero figure in the markup");

  const csv = toCsv([report]);
  assert.equal(csv.trim().split('\n').length, 4, 'a header and one row per place');
  assert.match(csv, /test-practice,Test Practice,p-us,yes,p-us,109,4.6,9,7,2,1/);

  assert.match(renderIndex([report]), /test-practice\.html/);
});

test('a practice name carrying a quote or a bracket cannot break the markup', () => {
  const nasty = validateConfig({
    clients: [
      {
        id: 'x',
        name: 'Smith & Sons <script>alert("x")</script>',
        placeId: 'a',
        competitors: [],
      },
    ],
  });
  const history = {
    version: 1,
    snapshots: [
      { takenAt: '2026-09-07T08:00:00.000Z', places: { a: { name: nasty.clients[0].name, totalReviews: 4, rating: 5, status: 'ok' } } },
      { takenAt: '2026-09-14T08:00:00.000Z', places: { a: { name: nasty.clients[0].name, totalReviews: 6, rating: 5, status: 'ok' } } },
    ],
  };
  const [report] = buildAllReports(nasty, history);
  const html = renderReport(report);
  assert.equal(/<script\b/i.test(html), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Smith &amp; Sons/);
});

test('the whole pack failing to read still produces a report rather than throwing', async () => {
  const dead = new PlacesClient({
    apiKey: 'k',
    maxRetries: 0,
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => 'NOT_FOUND' }),
  });
  const history = { version: 1, snapshots: [] };
  const results = await fetchAll(dead, allPlaces(config));
  addSnapshot(history, { takenAt: '2026-09-14T08:00:00.000Z', places: toPlaceMap(results) });

  const [report] = buildAllReports(config, history);
  assert.equal(report.row.status, 'not_found');
  assert.equal(report.problems.length, 3);
  const html = renderReport(report);
  assert.match(html, /could not read this Google profile/);
  assert.match(html, /needs relinking/);
});

// The link from a practice's name to its Google listing.
//
// This is worth a test because the wrong format fails only on a phone, which
// is where a practice is most likely to open the page, and passes every check
// made on a laptop.
test('a practice name links to its Google listing in a format phones honour', async () => {
  const history = { version: 1, snapshots: [] };
  for (const [at, counts] of [
    ['2026-10-05T08:00:00.000Z', { 'p-us': 10, 'p-one': 20, 'p-two': 30 }],
    ['2026-10-12T08:00:00.000Z', { 'p-us': 12, 'p-one': 20, 'p-two': 30 }],
  ]) {
    const results = await fetchAll(stub(counts), allPlaces(config));
    addSnapshot(history, { takenAt: at, places: toPlaceMap(results) });
  }
  const [report] = buildAllReports(config, history, { asOf: '2026-10-12' });
  const html = renderReport(report);

  assert.ok(
    html.includes('https://www.google.com/maps/search/?api=1&amp;query='),
    'links must use the Maps URLs format, which resolves the same on web, Android and iOS'
  );
  assert.ok(html.includes('query_place_id=p-us'), 'the place ID decides which listing opens');
  assert.ok(
    !html.includes('q=place_id:'),
    'the maps/place/?q=place_id: form is read as literal search text by the mobile Maps apps'
  );
});

test('a branch label added by the config is not sent as part of the name', async () => {
  const branched = validateConfig({
    agency: { name: 'Spring View Marketing' },
    clients: [
      {
        id: 'test-practice',
        name: 'Test Practice',
        placeId: 'p-us',
        competitors: [{ name: 'Rival One (Fulwood)', placeId: 'p-one' }],
      },
    ],
  });
  const history = { version: 1, snapshots: [] };
  for (const at of ['2026-10-05T08:00:00.000Z', '2026-10-12T08:00:00.000Z']) {
    const results = await fetchAll(stub({ 'p-us': 10, 'p-one': 20 }), allPlaces(branched));
    addSnapshot(history, { takenAt: at, places: toPlaceMap(results) });
  }
  const [report] = buildAllReports(branched, history, { asOf: '2026-10-12' });
  const html = renderReport(report);

  assert.ok(html.includes('query_place_id=p-one'), 'the branch still links somewhere');
  assert.ok(!html.includes('Fulwood&amp;query_place_id'), '"(Fulwood)" is ours, not the business name');
});
