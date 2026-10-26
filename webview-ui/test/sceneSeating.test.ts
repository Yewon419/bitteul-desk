import assert from 'node:assert/strict';

import { test } from 'vitest';

import { dropMoves, planSeats, tidyRooms } from '../src/scene/seating.ts';

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

test('seats in a team office are never handed out, stored or not', () => {
  const plan = planSeats([1, 2], new Map([[1, 0]]), PER_FLOOR, new Set([0, 1]));
  assert.equal(plan.seatOf.get(1), 2);
  assert.equal(plan.seatOf.get(2), 3);
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

const PER_ROOM = 2;

test('occupied rooms are pulled together, roommates and signs move with their room', () => {
  const seats = new Map([
    [1, 5],
    [2, 20],
    [3, 21],
    [4, 22],
  ]);
  const titles = new Map([
    [0, 'HQ'],
    [10, 'Music'],
    [7, 'Gone'],
  ]);
  const next = tidyRooms(seats, titles, PER_ROOM);
  assert.ok(next);
  assert.deepEqual([...next.seats].sort(), [
    [1, 3],
    [2, 4],
    [3, 5],
    [4, 6],
  ]);
  assert.deepEqual([...next.rooms].sort(), [
    [0, 'HQ'],
    [2, 'Music'],
  ]);
});

test('room 0 stays put even when empty, and a tidy office is left alone', () => {
  assert.equal(
    tidyRooms(
      new Map([
        [1, 2],
        [2, 5],
      ]),
      new Map([[0, 'HQ']]),
      PER_ROOM,
    ),
    null,
  );
  const next = tidyRooms(new Map([[1, 9]]), new Map(), PER_ROOM);
  assert.deepEqual([...(next?.seats ?? [])], [[1, 3]]);
});

test('a sign on an empty room alone is enough to tidy', () => {
  const next = tidyRooms(new Map([[1, 0]]), new Map([[3, 'Empty']]), PER_ROOM);
  assert.ok(next);
  assert.equal(next.rooms.size, 0);
  assert.deepEqual([...next.seats], [[1, 0]]);
});
