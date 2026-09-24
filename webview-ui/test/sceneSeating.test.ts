import assert from 'node:assert/strict';

import { test } from 'vitest';

import { dropMoves, planSeats } from '../src/scene/seating.ts';

const PER_FLOOR = 6;

test('stored seats win and everyone else fills the lowest free seats', () => {
  const plan = planSeats([5, 1, 3], new Map([[3, 0]]), PER_FLOOR);
  assert.deepEqual([...plan.seatOf.entries()].sort(), [
    [1, 1],
    [3, 0],
    [5, 2],
  ]);
  assert.equal(plan.floors, 1);
});

test('a stored seat past the first floor adds a floor; a clash falls back to a free seat', () => {
  const plan = planSeats(
    [1, 2],
    new Map([
      [1, 7],
      [2, 7],
    ]),
    PER_FLOOR,
  );
  assert.equal(plan.seatOf.get(1), 7);
  assert.equal(plan.seatOf.get(2), 0);
  assert.equal(plan.floors, 2);
});

test('seven sessions need two floors', () => {
  assert.equal(planSeats([1, 2, 3, 4, 5, 6, 7], new Map(), PER_FLOOR).floors, 2);
});

test('dropping on an occupied seat swaps, on an empty seat moves, on your own seat does nothing', () => {
  const plan = planSeats([1, 2], new Map(), PER_FLOOR);
  assert.deepEqual(dropMoves(1, 1, plan), [
    { agentId: 1, seat: 1 },
    { agentId: 2, seat: 0 },
  ]);
  assert.deepEqual(dropMoves(1, 4, plan), [{ agentId: 1, seat: 4 }]);
  assert.deepEqual(dropMoves(1, 0, plan), []);
});
