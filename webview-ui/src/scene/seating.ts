/**
 * Seat assignment for the multi-floor office. Seats are numbered globally:
 * seat -> global room = seat / perRoom (floor-major, rooms left to right), desk = seat % perRoom.
 */

export interface SeatPlan {
  seatOf: Map<number, number>;
  agentAt: Map<number, number>;
  floors: number;
}

/** Stored seats win when free; everyone else takes the lowest free seat, in id order. */
export function planSeats(
  agentIds: number[],
  stored: Map<number, number>,
  perFloor: number,
): SeatPlan {
  const seatOf = new Map<number, number>();
  const agentAt = new Map<number, number>();
  const sorted = [...agentIds].sort((a, b) => a - b);
  for (const id of sorted) {
    const seat = stored.get(id);
    if (seat !== undefined && !agentAt.has(seat)) {
      seatOf.set(id, seat);
      agentAt.set(seat, id);
    }
  }
  let next = 0;
  for (const id of sorted) {
    if (seatOf.has(id)) continue;
    while (agentAt.has(next)) next++;
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
