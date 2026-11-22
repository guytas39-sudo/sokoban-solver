// sokoban-solver: a push-optimal Sokoban solver, room by room.
//
// The levels this competition draws are a hallway with small rooms off it,
// each room holding 3-4 boxes and as many goals, and a box pushed out of a
// room can never come back -- so a level's push optimum is the sum of its
// rooms' optima, and each room is solved on its own. A room is solved by a
// breadth-first search over pushes (the first solved state met is
// push-optimal): a state is the boxes' squares plus the player's reachable
// region, named by its lowest square. Two deadlocks are pruned, neither of
// which can hide a solution: a dead square (no push, ignoring the other
// boxes, ever brings a box from it onto a goal) and a frozen 2 x 2 block
// (four squares of walls and boxes with a box off its goal). The search is
// capped by work (states kept), never by the clock, so two runs answer
// alike byte for byte. If the optimal search gives up on a room, a
// weighted A* over the same states tries for a longer (but scoring)
// solution instead of none.
//
// Plain JavaScript in a .ts file: Node 22 strips types natively, and this
// file has none to strip. Node built-ins only, no network, no clock.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The most states one optimal search keeps before it gives up (work, never
// the clock). The rooms this competition draws are kept only when the
// reference search solves them within this many states, so the cap is a
// safety net, not the plan.
const SEARCH_STATES = 250_000;
// The most expansions the weighted fallback spends on one room.
const FALLBACK_STATES = 500_000;

// [dx, dy, walk letter, push letter] -- the four directions, in the order
// ties are broken (up, down, left, right).
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

/**
 * A level in XSB text (# wall, space floor, . goal, $ box, * box on a
 * goal, @ player, + player on a goal), one row a line: width, height,
 * walls (1 a wall; short rows and squares outside padded as walls),
 * goals, boxes (sorted) and player.
 */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // A square on the outermost frame is a wall whatever it shows.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The squares from which a box alone can be pushed onto some goal: pull
 * the goals back over open floor. A box on any other square is dead --
 * no push, ignoring the other boxes, ever saves it.
 */
function liveSquares(level) {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The squares the player reaches from `from` with `occupied` boxes in the
 * way, marked in `seen` with `stamp`; returns the lowest square of the
 * region -- the region's name in a state's key.
 */
function regionLow(level, occupied, from, seen, stamp, stack) {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    // Four neighbours, inlined for speed.
    const q0 = p - w;
    const q1 = p + w;
    const q2 = p - 1;
    const q3 = p + 1;
    if (wall[q0] === 0 && occupied[q0] === 0 && seen[q0] !== stamp) {
      seen[q0] = stamp;
      stack[n++] = q0;
    }
    if (wall[q1] === 0 && occupied[q1] === 0 && seen[q1] !== stamp) {
      seen[q1] = stamp;
      stack[n++] = q1;
    }
    if (wall[q2] === 0 && occupied[q2] === 0 && seen[q2] !== stamp) {
      seen[q2] = stamp;
      stack[n++] = q2;
    }
    if (wall[q3] === 0 && occupied[q3] === 0 && seen[q3] !== stamp) {
      seen[q3] = stamp;
      stack[n++] = q3;
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2 x 2 block of walls and boxes with a box off its goal. */
function frozenBlock(level, occupied, goal, t) {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

// A state's key: the region's lowest square and the boxes' squares, as
// digits in base `size` (exact while size ** (boxes + 1) stays under
// 2 ** 53: a room of up to four boxes on any board this generator draws).
function keyOf(boxes, low, size) {
  let k = low;
  for (const b of boxes) k = k * size + b;
  return k;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (the first direction first on ties). */
function walkTo(level, occupied, from, to) {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, the case aside) from `from` on a board `w` wide. */
function endOf(w, from, moves) {
  let p = from;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    p += c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * The push-optimal solution of `level`, searching at most `maxStates`
 * states: {pushes, moves} (moves in LURD: a lower letter a step, an
 * upper one a push), or null when the search gives up (or the level has
 * no solution). Breadth-first over pushes, so the first solved state
 * met is push-optimal.
 */
function solvePushOptimal(level, maxStates = SEARCH_STATES) {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes) => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;

  // The states in the order found: their boxes, the player's square, and
  // the push that made them from their parent.
  const statesBoxes = [level.boxes];
  const statesPlayer = [level.player];
  const parent = [-1];
  const index = new Map();
  for (const b of level.boxes) occupied[b] = 1;
  index.set(keyOf(level.boxes, regionLow(level, occupied, level.player, seen, ++stamp, stack), size), 0);
  for (const b of level.boxes) occupied[b] = 0;
  let found = solved(level.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < statesBoxes.length; head++) {
    const boxes = statesBoxes[head];
    for (const b of boxes) occupied[b] = 1;
    regionLow(level, occupied, statesPlayer[head], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = -1;
        let next = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, regionLow(level, occupied, b, mark, ++stamp, stack), size);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || index.has(key)) continue;
        if (statesBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        index.set(key, statesBoxes.length);
        statesBoxes.push(next);
        statesPlayer.push(b);
        parent.push(head);
        if (solved(next)) {
          found = statesBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;
  return buildMoves(level, statesBoxes, statesPlayer, parent, found);
}

/**
 * The moves for a solved state: walk the parent chain back, then walk to
 * each push's square and push, in order.
 */
function buildMoves(level, statesBoxes, statesPlayer, parent, found) {
  const { w } = level;
  const path = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  const occupied = new Uint8Array(level.wall.length);
  for (const s of path) {
    const nextBoxes = statesBoxes[s];
    const from = boxes.find((b) => !nextBoxes.includes(b));
    const to = nextBoxes.find((b) => !boxes.includes(b));
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d);
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/**
 * Each box's fewest pushes to each goal, ignoring the other boxes
 * (a relaxation, so a lower bound): a box moves from p to p + d when
 * the square p - d is open floor for the player to stand on.
 */
function pushDistances(level) {
  const { w, wall, goals } = level;
  const size = wall.length;
  const dist = new Int32Array(size * goals.length).fill(-1);
  for (let gi = 0; gi < goals.length; gi++) {
    const g = goals[gi];
    const base = gi * size;
    dist[base + g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi];
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const y = x - d;
        if (wall[y] || wall[y - d] || dist[base + y] >= 0) continue;
        dist[base + y] = dist[base + x] + 1;
        queue.push(y);
      }
    }
  }
  return dist;
}

/** The cheapest assignment of boxes to goals under `dist`, by brute force over the (at most 4!) permutations; Infinity when some box reaches no goal. */
function assignmentCost(boxes, goals, dist) {
  const n = boxes.length;
  const size = dist.length / goals.length;
  const order = boxes.map((_, i) => i);
  let best = Infinity;
  const permute = (k) => {
    if (k === n) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const d = dist[i * size + boxes[order[i]]];
        if (d < 0) return;
        sum += d;
      }
      if (sum < best) best = sum;
      return;
    }
    for (let i = k; i < n; i++) {
      [order[k], order[i]] = [order[i], order[k]];
      permute(k + 1);
      [order[k], order[i]] = [order[i], order[k]];
    }
  };
  permute(0);
  return best;
}

/**
 * A weighted A* over the same push states, for when the optimal search
 * gives up: the estimate is the cheapest assignment of boxes to goals
 * under push-distances (admissible), weighted to trade pushes for
 * speed. Returns {pushes, moves} or null.
 */
function solveWeighted(level, maxStates = FALLBACK_STATES, weight = 3) {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const dist = pushDistances(level);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes) => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;
  const estimate = (boxes) => assignmentCost(boxes, goals, dist);

  const statesBoxes = [level.boxes];
  const statesPlayer = [level.player];
  const parent = [-1];
  const gScore = [0];
  const index = new Map();
  for (const b of level.boxes) occupied[b] = 1;
  index.set(keyOf(level.boxes, regionLow(level, occupied, level.player, seen, ++stamp, stack), size), 0);
  for (const b of level.boxes) occupied[b] = 0;
  // The open list: a heap on g + weight * h, ties by more pushes made.
  const heap = [[estimate(level.boxes) * weight, 0]];
  const less = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] > b[1]);
  const heapPush = (e) => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
        if (!less(heap[c], heap[i])) break;
        [heap[i], heap[c]] = [heap[c], heap[i]];
        i = c;
      }
    }
    return top;
  };
  let expanded = 0;
  while (heap.length > 0 && expanded < maxStates) {
    const [, s] = heapPop();
    const boxes = statesBoxes[s];
    for (const b of boxes) occupied[b] = 1;
    if (solved(boxes)) {
      for (const b of boxes) occupied[b] = 0;
      return buildMoves(level, statesBoxes, statesPlayer, parent, s);
    }
    expanded++;
    regionLow(level, occupied, statesPlayer[s], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = -1;
        let next = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, regionLow(level, occupied, b, mark, ++stamp, stack), size);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || index.has(key)) continue;
        index.set(key, statesBoxes.length);
        statesBoxes.push(next);
        statesPlayer.push(b);
        parent.push(s);
        gScore.push(gScore[s] + 1);
        heapPush([(gScore[s] + 1 + weight * estimate(next)), statesBoxes.length - 1]);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  return null;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the
 * hallway: a box there reaches no goal) out of the floor, and each part
 * left that holds a box is a room, its squares, boxes and goals. Null
 * when some part holds more or fewer boxes than goals, or a box starts
 * in the hallway: then the level is no set of rooms.
 */
function roomsOf(level) {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in
 * turn, the other rooms' boxes standing as walls (on their goals once
 * their room is done), the player walking on from where the last room
 * left it. A box never leaves its room (a push through a door lands it
 * in the hallway, where it reaches no goal), so the rooms' optima add
 * up to the level's. Falls back to the weighted search per room, and
 * to a whole-level search when the level is no set of rooms.
 */
function solveLevel(level) {
  const rooms = roomsOf(level);
  if (rooms === null) {
    const whole = solvePushOptimal(level) ?? solveWeighted(level);
    return whole === null ? '' : whole.moves;
  }
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushOptimal(sub) ?? solveWeighted(sub);
    if (solved === null) return '';
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return moves;
}

for (const id of readdirSync(INPUT).sort()) {
  const moves = solveLevel(parseLevel(readFileSync(join(INPUT, id, 'level.txt'), 'utf8')));
  mkdirSync(join(OUTPUT, id), { recursive: true });
  writeFileSync(join(OUTPUT, id, 'solution.txt'), `${moves}\n`);
}
