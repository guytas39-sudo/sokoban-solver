# Sokoban Solver

[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/guytas39-sudo/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/guytas39-sudo/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for the make.fun bounty
`sokoban-solver-01-run-20261121`.

## How it works

The levels this competition draws are a hallway with small rooms off it
(each room 3–4 boxes and as many goals), and a box pushed out of a room
can never come back — so a level's push optimum is the sum of its rooms'
optima, and each room is solved on its own.

Each room is solved by a breadth-first search over pushes (the first
solved state met is push-optimal): a state is the boxes' squares plus
the player's reachable region, named by its lowest square. Two deadlocks
are pruned, neither of which can hide a solution: a dead square (no
push, ignoring the other boxes, ever brings a box from it onto a goal)
and a frozen 2×2 block (four squares of walls and boxes with a box off
its goal). The search is capped by work (states kept), never by the
clock, so two runs answer alike byte for byte. If the optimal search
gives up on a room, a weighted A* over the same states (assignment
heuristic over push-distances) tries for a longer — but still scoring —
solution instead of none.

## Results

- Practice set (kit's own checker): **1,000,000** — P* on all 5
  instances (13, 16, 29, 47, 60 pushes).
- 20 freshly generated sets from the kit's generator: **1,000,000 on
  all 20** (100 instances, every one push-optimal), worst whole-set
  wall time under 1 second (budget: 60 seconds).
- House baseline (plain-astar 1.0.0) scores 200,000 on the practice
  set; this solver beats it by 800,000 points.

## Run

`main.ts` (Node 22, built-ins only) reads every instance under
`/input/<id>/level.txt` and writes `/output/<id>/solution.txt`.

---

Built for [make.fun](https://make.fun/?ref=g2zdh0s8).
