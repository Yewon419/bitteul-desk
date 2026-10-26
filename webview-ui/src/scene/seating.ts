/**
 * Seat assignment for the multi-floor office. Seats are numbered globally:
 * seat -> global room = seat / perRoom (floor-major, rooms left to right), desk = seat % perRoom.
 */

export interface SeatPlan {
  seatOf: Map<number, number>;
  agentAt: Map<number, number>;
  floors: number;
}

/**
 * Stored seats win when free; everyone else takes the lowest free seat, in id order.
 * `blocked` seats belong to a team office and are never handed out.
 */
export function planSeats(
  agentIds: number[],
  stored: Map<number, number>,
  perFloor: number,
  blocked: ReadonlySet<number> = new Set(),
): SeatPlan {
  const seatOf = new Map<number, number>();
  const agentAt = new Map<number, number>();
  const sorted = [...agentIds].sort((a, b) => a - b);
  for (const id of sorted) {
    const seat = stored.get(id);
    if (seat !== undefined && !agentAt.has(seat) && !blocked.has(seat)) {
      seatOf.set(id, seat);
      agentAt.set(seat, id);
    }
  }
  let next = 0;
  for (const id of sorted) {
    if (seatOf.has(id)) continue;
    while (agentAt.has(next) || blocked.has(next)) next++;
    seatOf.set(id, next);
    agentAt.set(next, id);
  }
  const highest = Math.max(-1, ...seatOf.values());
  return { seatOf, agentAt, floors: Math.max(1, Math.ceil((highest + 1) / perFloor)) };
}

/** Moves for dropping `agentId` on `target`: take it, and send whoever sat there to our old seat. */
export function dropMoves(
  agentId: number,
  target: number,
  plan: SeatPlan,
): Array<{ agentId: number; seat: number }> {
  const from = plan.seatOf.get(agentId);
  if (from === undefined || from === target) return [];
  const moves = [{ agentId, seat: target }];
  const occupant = plan.agentAt.get(target);
  if (occupant !== undefined) moves.push({ agentId: occupant, seat: from });
  return moves;
}

export interface Arrangement {
  seats: Map<number, number>;
  rooms: Map<number, string>;
}

/**
 * Pull occupied rooms together so no empty room is left between them. Room 0 (headquarters,
 * where the wall board hangs) stays put with its sign; every other occupied room keeps its
 * order, its desks and its sign, and the signs of empty rooms are dropped.
 * `seats` holds every seated agent (a team's MD stands for the team office).
 * Null when the office is already tidy.
 */
export function tidyRooms(
  seats: ReadonlyMap<number, number>,
  titles: ReadonlyMap<number, string>,
  perRoom: number,
): Arrangement | null {
  const occupied = [...new Set([...seats.values()].map((s) => Math.floor(s / perRoom)))]
    .filter((room) => room !== 0)
    .sort((a, b) => a - b);
  const target = new Map(occupied.map((room, i) => [room, i + 1]));
  target.set(0, 0);
  let moved = false;
  const next = new Map<number, number>();
  for (const [id, seat] of seats) {
    const room = Math.floor(seat / perRoom);
    const to = target.get(room) ?? room;
    if (to !== room) moved = true;
    next.set(id, to * perRoom + (seat % perRoom));
  }
  const rooms = new Map<number, string>();
  for (const [room, title] of titles) {
    const to = target.get(room);
    if (to !== undefined) rooms.set(to, title);
  }
  if (!moved && rooms.size === titles.size) return null;
  return { seats: next, rooms };
}
