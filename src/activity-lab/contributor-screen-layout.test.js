import test from 'node:test';
import assert from 'node:assert/strict';
import { placeContributorCards } from './contributor-screen-layout.js';

const gap = 12;
const placedCards = (cards, positions) => cards.map(card => ({ ...card, ...positions.get(card.id) }));
function assertClear(cards, positions, { obstacles = [], left, right, top, gap: requiredGap = gap } = {}) {
  assert.equal(positions.size, cards.length);
  const placed = placedCards(cards, positions);
  for (const card of placed) {
    assert.ok(Number.isFinite(card.x) && Number.isFinite(card.y), `nonfinite position: ${card.id}`);
    if (Number.isFinite(top)) assert.ok(card.y - card.height / 2 >= top - 1e-8);
    if (Number.isFinite(left) && Number.isFinite(right) && card.width <= right - left) {
      assert.ok(card.x - card.width / 2 >= left - 1e-8);
      assert.ok(card.x + card.width / 2 <= right + 1e-8);
    }
  }
  const separate = (a, b) => Math.abs(a.x - b.x) >= (a.width + b.width) / 2 + requiredGap - 1e-8
    || Math.abs(a.y - b.y) >= (a.height + b.height) / 2 + requiredGap - 1e-8;
  for (let index = 0; index < placed.length; index++) {
    for (let other = 0; other < index; other++) assert.ok(separate(placed[index], placed[other]), `${placed[index].id} overlaps ${placed[other].id}`);
    for (const obstacle of obstacles) assert.ok(separate(placed[index], obstacle), `${placed[index].id} overlaps fixed obstacle`);
  }
  return placed;
}

test('13 typical projected cards keep their already separated anchors', () => {
  const cards = Array.from({ length: 13 }, (_, index) => ({ id: `person${index}`, x: (index % 4) * 150, y: Math.floor(index / 4) * 100, width: 110, height: 54 }));
  const positions = placeContributorCards(cards);
  assertClear(cards, positions);
  for (const card of cards) assert.deepEqual(positions.get(card.id), { x: card.x, y: card.y });
});

test('30 crowded, variably sized full-name cards are separated without changing input', () => {
  const cards = Array.from({ length: 30 }, (_, index) => ({ id: `person${index}`, x: Math.cos(index) * 25, y: Math.sin(index) * 18, width: 60 + index % 7 * 31, height: 48 + index % 3 * 8 }));
  const before = structuredClone(cards);
  const positions = placeContributorCards(cards);
  assertClear(cards, positions);
  assert.deepEqual(cards, before);
  assert.deepEqual(placeContributorCards([...cards].reverse()), positions);
});

test('coincident projected centers separate deterministically and remain finite', () => {
  const cards = Array.from({ length: 40 }, (_, index) => ({ id: `person${index}`, x: 0, y: 0, width: 156, height: 62 }));
  assertClear(cards, placeContributorCards(cards));
  assert.deepEqual(placeContributorCards(cards), placeContributorCards([...cards].reverse()));
});

test('rotated projected coordinates with long names preserve the complete footprint', () => {
  const cards = Array.from({ length: 35 }, (_, index) => ({ id: `person${index}`, x: Math.cos(index * 2.4) * 160, y: Math.sin(index * 2.4) * 65, width: 75 + index % 5 * 57, height: 54 }));
  assertClear(cards, placeContributorCards(cards));
});

test('13 coincident mobile cards wrap into bounded columns with full names', () => {
  const cards = Array.from({ length: 13 }, (_, index) => ({ id: `person${index}`, x: 187.5, y: 350, width: 110, height: 54 }));
  const options = { left: 12, right: 363 };
  const placed = assertClear(cards, placeContributorCards(cards, options), options);
  assert.ok(new Set(placed.map(card => card.x)).size >= 2);
  const height = Math.max(...placed.map(card => card.y + card.height / 2)) - Math.min(...placed.map(card => card.y - card.height / 2));
  assert.ok(height < 530, `mobile layout unnecessarily tall: ${height}`);
});

test('bounded cards avoid fixed repository and satellite obstacles', () => {
  const cards = Array.from({ length: 25 }, (_, index) => ({ id: `person${index}`, x: 90 + index % 5 * 30, y: 160 + Math.floor(index / 5) * 18, width: 85 + index % 4 * 15, height: 54 }));
  const options = { left: 12, right: 363, obstacles: [{ x: 187, y: 210, width: 70, height: 80 }, { x: 90, y: 110, width: 45, height: 45 }] };
  const before = structuredClone(options);
  assertClear(cards, placeContributorCards(cards, options), options);
  assert.deepEqual(options, before);
});

test('a name wider than the viewport may overflow while other cards still fit and remain clear', () => {
  const cards = [{ id: 'long-name', x: 187.5, y: 0, width: 500, height: 54 }, ...Array.from({ length: 8 }, (_, index) => ({ id: `person${index}`, x: 187.5, y: 0, width: 110, height: 54 }))];
  const options = { left: 12, right: 363 };
  const positions = placeContributorCards(cards, options);
  assertClear(cards, positions, options);
  assert.equal(positions.get('long-name').x, 187.5);
  assert.equal(cards[0].width, 500);
});

test('empty input and transient unmeasured rectangles do not produce NaNs', () => {
  assert.deepEqual(placeContributorCards([]), new Map());
  const positions = placeContributorCards([{ id: 'a', x: NaN, y: undefined, width: 0, height: 0 }, { id: 'b', x: Infinity, y: NaN, width: NaN, height: -1 }]);
  for (const value of positions.values()) assert.ok(Number.isFinite(value.x) && Number.isFinite(value.y));
});


test('mobile cards reflow below a fixed top edge without entering the navbar', () => {
  const cards = Array.from({ length: 13 }, (_, index) => ({ id: `person${index}`, x: 187.5, y: 90, width: 110, height: 54 }));
  const options = { left: 12, right: 363, top: 160 };
  const placed = assertClear(cards, placeContributorCards(cards, options), options);
  assert.ok(new Set(placed.map(card => card.x)).size >= 2);
  assert.ok(Math.max(...placed.map(card => card.y + card.height / 2)) < 690);
});

test('the top edge and large fixed obstacles still permit finite downward expansion', () => {
  const cards = Array.from({ length: 20 }, (_, index) => ({ id: `person${index}`, x: 187.5, y: 100, width: 130, height: 62 }));
  const options = { left: 12, right: 363, top: 160, obstacles: [{ x: 187.5, y: 220, width: 351, height: 120 }] };
  assertClear(cards, placeContributorCards(cards, options), options);
});


test('varied projections, bounds, obstacles and custom gaps preserve the separation invariant', () => {
  let seed = 23891;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let sample = 0; sample < 72; sample++) {
    const cards = Array.from({ length: 16 }, (_, index) => ({ id: `person${index}`, x: random() * 650 - 150, y: random() * 380 - 100, width: 35 + random() * 430, height: 28 + random() * 75 }));
    const options = { gap: [0, 7, 12, 24][sample % 4], obstacles: [{ x: random() * 350, y: random() * 300, width: 10 + random() * 80, height: 10 + random() * 80 }] };
    if (sample % 2) Object.assign(options, { left: 12, right: 363, top: 160 });
    assertClear(cards, placeContributorCards(cards, options), options);
  }
});


test('a prioritized contributor retains its free anchor while other full cards move around it', () => {
  const cards = Array.from({ length: 13 }, (_, index) => ({ id: `person${index}`, x: 187.5 + index % 2 * 5, y: 300, width: 110, height: 54 }));
  const selected = cards[11];
  const options = { priorityId: selected.id, left: 12, right: 363, top: 160 };
  const positions = placeContributorCards(cards, options);
  assert.equal(positions.keys().next().value, selected.id);
  assert.deepEqual(positions.get(selected.id), { x: selected.x, y: selected.y });
  assertClear(cards, positions, options);
  assert.deepEqual(placeContributorCards([...cards].reverse(), options), positions);
});

test('an absent priority preserves the default deterministic placement', () => {
  const cards = Array.from({ length: 9 }, (_, index) => ({ id: `person${index}`, x: 100, y: 100, width: 110, height: 54 }));
  assert.deepEqual(placeContributorCards(cards, { priorityId: 'missing' }), placeContributorCards(cards));
  assert.deepEqual(placeContributorCards(cards, { priorityId: null }), placeContributorCards([...cards].reverse()));
});


test('13 mobile cards fit between top and bottom while avoiding sun and dock obstacles', () => {
  const cards = Array.from({ length: 13 }, (_, index) => ({ id: `person${index}`, x: 187.5, y: 350, width: 110, height: 54 }));
  const options = { left: 12, right: 363, top: 160, bottom: 650, obstacles: [
    { x: 187.5, y: 350, width: 38, height: 38 },
    { x: 187.5, y: 710, width: 351, height: 80 },
  ] };
  const positions = placeContributorCards(cards, options);
  const placed = assertClear(cards, positions, options);
  for (const card of placed) assert.ok(card.y + card.height / 2 <= options.bottom + 1e-8, `${card.id} unnecessarily overflows`);
});

test('a free in-bound horizontal alternative wins over nearer downward overflow', () => {
  const cards = [{ id: 'selected', x: 90, y: 190, width: 110, height: 54 }];
  const options = { left: 12, right: 363, top: 160, bottom: 260, obstacles: [{ x: 85, y: 210, width: 120, height: 100 }], priorityId: 'selected' };
  const positions = placeContributorCards(cards, options);
  const placed = assertClear(cards, positions, options);
  assert.ok(placed[0].x > 200);
  assert.ok(placed[0].y + placed[0].height / 2 <= options.bottom);
});

test('impossible bounded capacity expands downward while retaining clearance and the top edge', () => {
  const cards = Array.from({ length: 9 }, (_, index) => ({ id: `person${index}`, x: 150, y: 180, width: 130, height: 62 }));
  const options = { left: 12, right: 300, top: 160, bottom: 230 };
  const placed = assertClear(cards, placeContributorCards(cards, options), options);
  assert.ok(placed.some(card => card.y + card.height / 2 > options.bottom));
});


// Actual mobile XO Space projection/footprints captured by browser QA.
const mobileProjectionFixtures = [{"view":"constellation","cards":[{"id":"andreolf","x":195.96946467369457,"y":369.67081995712056,"width":64,"height":37.66537225558807},{"id":"argus-runtime","x":185.80064777581492,"y":387.09761359755964,"width":93,"height":37.60601467515232},{"id":"copilot","x":206.12316365214204,"y":387.6434453003599,"width":59,"height":37.649668403481144},{"id":"dwivedi-ai","x":185.79052386613682,"y":351.6535151390868,"width":74,"height":37.68111514705902},{"id":"harishkotra","x":206.23449785650115,"y":352.07913581279007,"width":78,"height":37.7252914712592},{"id":"krishbhimani","x":175.71403923122676,"y":369.12969573606375,"width":87,"height":37.61648635968055},{"id":"mukesh804","x":216.38247065392667,"y":370.21615394636973,"width":79,"height":37.71463846766272},{"id":"quirq-dev","x":195.9193684618605,"y":404.96460589860277,"width":71,"height":37.59045758318331},{"id":"quirq-gates","x":196.02016061041877,"y":333.9545158027923,"width":80,"height":37.7411837661374},{"id":"rohini-sp","x":165.57762681548684,"y":386.5974980270834,"width":67,"height":37.56601716468418},{"id":"sagarrambade21","x":226.6111573639571,"y":388.15025225211775,"width":117,"height":37.69020106743909},{"id":"seemanttripathi","x":165.44744088391073,"y":351.2635577398852,"width":100,"height":37.64064041085447},{"id":"sharmasuraj0123","x":226.84572792103512,"y":352.4743420596835,"width":110,"height":37.76631099960298}],"sun":{"x":193.80954381721017,"y":443.90235194339914,"width":130,"height":59}},{"view":"contributors","cards":[{"id":"andreolf","x":271.5169651744215,"y":360.79975923469505,"width":64,"height":41.4384379289545},{"id":"argus-runtime","x":245.3657632384267,"y":499.39026470083377,"width":93,"height":40.998259373399605},{"id":"copilot","x":84.97342067924619,"y":383.23990610055336,"width":59,"height":41.286447383198634},{"id":"dwivedi-ai","x":189.54021888788077,"y":359.2732456168723,"width":74,"height":41.46815044909732},{"id":"harishkotra","x":96.68243547943729,"y":473.1898575890515,"width":78,"height":40.837658465762615},{"id":"krishbhimani","x":132.2582884296865,"y":415.2232557320484,"width":87,"height":41.15927113267662},{"id":"mukesh804","x":69.11348257243051,"y":426.48418979408353,"width":79,"height":41.15488115511235},{"id":"quirq-dev","x":300.3559972947064,"y":430.286128818258,"width":71,"height":41.33512285792176},{"id":"quirq-gates","x":230.56608743478117,"y":314.2177669837219,"width":80,"height":41.69522949700274},{"id":"rohini-sp","x":134.23887763196666,"y":522.4081895674633,"width":67,"height":40.89337892338165},{"id":"sagarrambade21","x":124.30189766170497,"y":341.4304663995178,"width":117,"height":41.24153080465402},{"id":"seemanttripathi","x":164.03249631048976,"y":302.29042633935086,"width":100,"height":41.736041702338696},{"id":"sharmasuraj0123","x":176.13392758963886,"y":485.0813390452156,"width":104,"height":41.075832878868084}],"sun":{"x":185.03723553061488,"y":416.9626442394341,"width":130,"height":59}}];

for (const fixture of mobileProjectionFixtures) test(`actual mobile ${fixture.view}: all 13 full cards fit after orbit and moderate zoom`, () => {
  for (const zoom of [1, 1.8, 2.5]) {
    const cards = fixture.cards.map(card => ({ ...card, width: Math.max(card.width, (card.height - 25) * zoom), height: (card.height - 25) * zoom + 25 }));
    const options = { left: 22, right: 353, top: 160, bottom: 644, gap: 16, obstacles: [fixture.sun, { x: 187.5, y: 732, width: 355, height: 136 }] };
    const positions = placeContributorCards(cards, options);
    const placed = assertClear(cards, positions, options);
    for (const card of placed) assert.ok(card.y + card.height / 2 <= options.bottom + 1e-8, `${fixture.view} zoom ${zoom}: ${card.id} overflows`);
    assert.deepEqual(placeContributorCards([...cards].reverse(), options), positions);
  }
});

test('global repacking keeps a selected mobile contributor fixed when the rest can fit around it', () => {
  const fixture = mobileProjectionFixtures[0];
  const cards = fixture.cards.map(card => ({ ...card, height: 64 }));
  const selected = cards[3];
  const options = { left: 22, right: 353, top: 160, bottom: 644, gap: 16, priorityId: selected.id, obstacles: [fixture.sun] };
  const positions = placeContributorCards(cards, options);
  const placed = assertClear(cards, positions, options);
  for (const card of placed) assert.ok(card.y + card.height / 2 <= options.bottom + 1e-8);
  assert.deepEqual(positions.get(selected.id), { x: selected.x, y: selected.y });
});
