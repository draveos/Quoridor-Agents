/* Codex 에이전트(agents/codex.js): quoridor-arena 의 engine/agents/codex.py (GPT 작성, v5-h, 563줄) 를 JS 로 옮긴 것입니다.
 * 구조는 원본과 같습니다. 81칸 벽 그래프 위 반복심화 negamax 알파베타, 치환표, 벽 배치별 토폴로지 캐시,
 * 보호 경로(secure) 평가, 함정 예측(_trap_plans)과 방어벽 보존(_root_defenses), 48국면 반복 무승부와 재방문 감점,
 * 상대 벽 0장일 때 81×81×2 상태 정확 역행 분석(_solve_race).
 * 달라진 점: 128비트 마스크를 32비트 워드 4개(비트 검사)와 BigInt(캐시 키)로 나눠 들고, 치환표 키는 토폴로지 id 로 만듭니다.
 *   시간 예약은 Python 의 25%(최대 0.30초) 대신 15%(최소 12ms) 이고 시간 확인은 32노드가 아니라 16노드마다 합니다(JS 에는 엔진 재검증이 없고 GC 지연만 남습니다).
 *   인접 그래프는 칸당 4칸짜리 Uint8Array 로 들어 토폴로지 캐시의 메모리를 줄였습니다.
 * 일반 스크립트, Worker(importScripts), Node 에서 모두 동작하고 globalThis.QAgent 로 노출됩니다.
 * Worker 로 실행될 때의 메시지: {type:'think', id, side, state, budget} → {type:'move', id, action, stats}; {type:'reset', side}. */
(function (root) {
  'use strict';
  if (typeof importScripts === 'function' && !root.QRules) importScripts('../rules.js');
  const R = root.QRules;
  const TIME_UP = { timeUp: true };
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const GOAL0 = [72, 73, 74, 75, 76, 77, 78, 79, 80], GOAL1 = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const hasBit = R.hasBit;

  /* 인접 그래프는 Uint8Array(81*4) 로 듭니다(칸마다 이웃 최대 4개, 오름차순, 빈 자리 255). 토폴로지 하나가 324바이트라 캐시 수만 개도 가볍습니다. */
  const NONE = 255;
  function flatAdj(adj) { const f = new Uint8Array(324).fill(NONE); for (let p = 0; p < 81; p++) { const l = adj[p]; for (let k = 0; k < l.length; k++) f[p * 4 + k] = l[k]; } return f; }
  function removeEdge(f, a, b) { const base = a * 4; for (let k = 0; k < 4; k++) if (f[base + k] === b) { for (let j = k; j < 3; j++) f[base + j] = f[base + j + 1]; f[base + 3] = NONE; return; } }
  function hasEdge(f, a, b) { const base = a * 4; return f[base] === b || f[base + 1] === b || f[base + 2] === b || f[base + 3] === b; }
  /* codex.py _moves 와 같은 결과(정렬, 중복 제거) */
  function movesF(f, pos, opp) {
    const out = [];
    for (let k = 0; k < 4; k++) {
      const n = f[pos * 4 + k];
      if (n === NONE) break;
      if (n !== opp) { out.push(n); continue; }
      const jump = opp + opp - pos;
      if (jump >= 0 && jump < 81 && hasEdge(f, opp, jump)) out.push(jump);
      else for (let j = 0; j < 4; j++) { const d = f[opp * 4 + j]; if (d === NONE) break; if (d !== pos) out.push(d); }
    }
    out.sort((a, b) => a - b);
    let w = 0;
    for (let i = 0; i < out.length; i++) if (i === 0 || out[i] !== out[i - 1]) out[w++] = out[i];
    out.length = w;
    return out;
  }
  const QUEUE = new Uint8Array(81);
  function distF(f, side) {
    const d = new Uint8Array(81).fill(99);
    let head = 0, tail = 0;
    if (side === 0) for (let p = 72; p < 81; p++) { d[p] = 0; QUEUE[tail++] = p; } else for (let p = 0; p < 9; p++) { d[p] = 0; QUEUE[tail++] = p; }
    while (head < tail) {
      const p = QUEUE[head++], nd = d[p] + 1, base = p * 4;
      for (let k = 0; k < 4; k++) { const n = f[base + k]; if (n === NONE) break; if (d[n] === 99) { d[n] = nd; QUEUE[tail++] = n; } }
    }
    return d;
  }

  /* codex.py _Topology: 벽 배치 하나당 인접 그래프, 놓을 수 있는 울타리, 양쪽 거리, 보호 경로 거리, 자식 캐시 */
  function Topology(adj, maskBig, mask, available, withSecure, parentDist, removed) {
    this.adj = adj; this.maskBig = maskBig; this.mask = mask; this.available = available; this.id = 0;
    if (!parentDist) this.dist = [distF(adj, 0), distF(adj, 1)];
    else {
      const dist = [];
      for (let side = 0; side < 2; side++) {
        const old = parentDist[side], affected = [];
        for (const [a, b] of removed) {
          if (old[a] === old[b] + 1) affected.push(a);
          else if (old[b] === old[a] + 1) affected.push(b);
        }
        // 간선 삭제는 경로를 줄이지 못한다. 영향받은 칸이 모두 최단 전임자를 유지하면 거리 배열을 그대로 공유한다.
        let unchanged = true;
        for (const p of affected) {
          let keep = false;
          for (let k = 0; k < 4; k++) { const n = adj[p * 4 + k]; if (n === NONE) break; if (old[n] === old[p] - 1) { keep = true; break; } }
          if (!keep) { unchanged = false; break; }
        }
        dist.push(unchanged ? old : distF(adj, side));
      }
      this.dist = dist;
    }
    this.secure = null;
    if (withSecure) {
      const safe = [];
      for (let side = 0; side < 2; side++) {
        const d = new Uint8Array(81).fill(99);
        const queue = (side === 0 ? GOAL0 : GOAL1).slice();
        for (const p of queue) d[p] = 0;
        for (let i = 0; i < queue.length; i++) {
          const p = queue[i];
          for (let k = 0; k < 4; k++) {
            const n = adj[p * 4 + k];
            if (n === NONE) break;
            if (d[n] !== 99) continue;
            const covers = R.COVERS[p * 81 + n];
            let cuttable = false;
            for (let k = 0; k < covers.length; k++) if (hasBit(available, covers[k])) { cuttable = true; break; }
            if (!cuttable) { d[n] = d[p] + 1; queue.push(n); }
          }
        }
        safe.push(d);
      }
      this.secure = safe;
    }
    this.children = [];
  }

  class QAgent {
    constructor(side) {
      this.side = side;                 // 0 white, 1 black
      this.recent = [];                 // maxlen 12: {maskBig, p, opp}
      this.positions = [];              // maxlen 48: {maskBig, p0, p1, f0, f1, side}
      this.endgame = null;
      this.lastStats = {};
      this.reserve = budget => Math.max(12, budget * 0.15);
      this.nodeLimit = 0;               // 0 이면 시간 예산, 양수면 노드 예산(Python 과 선택 수 비교용)
    }

    check() { if (this.nodeLimit ? this.nodes >= this.nodeLimit : now() >= this.deadline) throw TIME_UP; }   // nodeLimit 은 검증용 결정적 모드

    child(topology, fence) {
      let child = topology.children[fence];
      if (child !== undefined) return child;
      const maskBig = topology.maskBig | R.FENCE_BIG[fence];
      child = this.topologies.get(maskBig);
      if (child === undefined) {
        const adj = topology.adj.slice();
        for (const [a, b] of R.EDGES[fence]) { removeEdge(adj, a, b); removeEdge(adj, b, a); }
        const mask = new Int32Array(topology.mask); mask[fence >> 5] |= 1 << (fence & 31);
        const available = new Int32Array(topology.available);
        const conflict = R.CONFLICT_WORDS[fence];
        for (let i = 0; i < 4; i++) available[i] &= ~conflict[i];
        child = new Topology(adj, maskBig, mask, available, true, topology.dist, R.EDGES[fence]);
        child.id = this.nextId++;
        this.topologies.set(maskBig, child);
      }
      topology.children[fence] = child;
      return child;
    }

    static distance(topology, p, opponent, side) {
      const d = topology.dist[side][p];
      if (!d) return 0;
      if (hasEdge(topology.adj, p, opponent)) {
        let best = 98;
        for (const n of movesF(topology.adj, p, opponent)) if (topology.dist[side][n] < best) best = topology.dist[side][n];
        return 1 + best;
      }
      return d;
    }
    static freedom(topology, p, side) {
      const d = topology.dist[side], adj = topology.adj; let s = 0;
      for (let k = 0; k < 4; k++) { const n = adj[p * 4 + k]; if (n === NONE) break; if (d[n] < d[p]) s++; }
      return s;
    }
    static protection(topology, p, side) {
      if (topology.secure === null) return 99;
      const d = topology.secure[side], adj = topology.adj; let best = 99;
      for (let k = 0; k < 4; k++) { const n = adj[p * 4 + k]; if (n === NONE) break; if (d[n] < best) best = d[n]; }
      return Math.min(d[p], 1 + best);
    }

    evaluate(topology, p0, p1, f0, f1, turn) {
      const d0 = QAgent.distance(topology, p0, p1, 0), d1 = QAgent.distance(topology, p1, p0, 1);
      const difference = d1 - d0, magnitude = Math.abs(difference);
      let capped = magnitude <= 4 ? 100 * magnitude : 400 + 25 * (magnitude - 4);
      capped = difference >= 0 ? capped : -capped;
      const relative = 1800 * difference / (d0 + d1 + 6);
      const blend = Math.min(.75, Math.max(0, (d0 + d1 - 18) / 16));
      let value = Math.trunc(capped * (1 - blend) + relative * blend) + 70 * (f0 - f1);
      value += Math.trunc(240 / (d0 + 1) - 240 / (d1 + 1));
      if (f1) { const safe0 = QAgent.protection(topology, p0, 0); if (safe0 < 99) value += Math.floor(180 / (safe0 + 1)); }
      if (f0) { const safe1 = QAgent.protection(topology, p1, 1); if (safe1 < 99) value -= Math.floor(180 / (safe1 + 1)); }
      value += 13 * ((f0 > 0) - (f1 > 0));
      value += 180 * ((f0 > 0) - (f1 > 0)) + 90 * ((f0 > 1) - (f1 > 1));
      value += 50 * ((f0 > 2) - (f1 > 2)) + 30 * ((f0 > 3) - (f1 > 3));
      value += 4 * (QAgent.freedom(topology, p0, 0) - QAgent.freedom(topology, p1, 1));
      value += 2 * (Math.abs(p1 % 9 - 4) - Math.abs(p0 % 9 - 4));
      return turn === 0 ? value : -value;
    }

    static key(topology, p0, p1, f0, f1, turn) { return ((((topology.id * 81 + p0) * 81 + p1) * 11 + f0) * 11 + f1) * 2 + turn; }

    /* 후보 수: 이동 전부 + 울타리 상위 width 개 + 방어벽(최대 6) + 상대 즉시 승리를 막는 벽. 옵션 = {s, act, t, a, b, u, v} */
    options(topology, p0, p1, f0, f1, turn, width) {
      const key = QAgent.key(topology, p0, p1, f0, f1, turn);
      let old = this.ordered.get(key);
      if (old === undefined) {
        this.check();
        const pawn = turn === 0 ? p0 : p1, opponent = turn === 0 ? p1 : p0;
        const moves = [];
        for (const dest of movesF(topology.adj, pawn, opponent)) {
          const a = turn === 0 ? dest : p0, b = turn === 0 ? p1 : dest;
          let score = this.evaluate(topology, a, b, f0, f1, turn);
          if (topology.dist[turn][dest] === 0) score = 1000000;
          moves.push({ s: score, act: dest, t: topology, a, b, u: f0, v: f1 });
        }
        const walls = [];
        if ((turn === 0 ? f0 : f1) > 0) {
          const available = topology.available; let count = 0;
          for (let w = 0; w < 4; w++) {
            let bits = available[w];
            while (bits !== 0) {
              const bit = bits & -bits; bits ^= bit;
              const fence = w * 32 + (31 - Math.clz32(bit));
              count++;
              if (count % 8 === 0) this.check();
              const child = this.child(topology, fence);
              if (child.dist[0][p0] === 99 || child.dist[1][p1] === 99) continue;
              const nf0 = turn === 0 ? f0 - 1 : f0, nf1 = turn === 0 ? f1 : f1 - 1;
              const score = this.evaluate(child, p0, p1, nf0, nf1, turn);
              const r = (fence & 63) >> 3, c = fence & 7;
              const affinity = -Math.abs(r - ((opponent / 9) | 0)) - Math.abs(c - opponent % 9);
              walls.push({ s: score, aff: affinity, act: fence + 81, t: child, a: p0, b: p1, u: nf0, v: nf1 });
            }
          }
        }
        moves.sort((x, y) => (y.s - x.s) || (x.act - y.act));
        walls.sort((x, y) => (y.s - x.s) || (y.aff - x.aff) || (x.act - y.act));
        const oldProtection = QAgent.protection(topology, pawn, turn);
        const defenses = walls.filter(w => QAgent.protection(w.t, pawn, turn) < oldProtection);
        defenses.sort((x, y) => (QAgent.protection(x.t, pawn, turn) - QAgent.protection(y.t, pawn, turn)) || (y.s - x.s) || (x.act - y.act));
        let extra = defenses.slice(0, 6);
        if (QAgent.distance(topology, opponent, pawn, 1 - turn) === 1) {
          extra = extra.concat(walls.filter(w => QAgent.distance(w.t, opponent, pawn, 1 - turn) > 1));
        }
        const seen = new Map();
        for (const w of extra) if (!seen.has(w.act)) seen.set(w.act, w);
        old = { moves, walls, defenses: Array.from(seen.values()) };
        this.ordered.set(key, old);
      }
      const selected = old.walls.slice(0, width);
      const selectedIds = new Set(selected.map(w => w.act));
      const result = old.moves.concat(selected, old.defenses.filter(w => !selectedIds.has(w.act)));
      result.sort((x, y) => (y.s - x.s) || (x.act - y.act));
      return result;
    }

    /* 루트 전용: 상대의 벽 1~2장 조합이 내 경로를 얼마나 늘리는지 예측 (codex.py _trap_plans) */
    trapPlans(rootT, p0, p1, enemyWalls, until) {
      if (!enemyWalls) return [];
      const side = this.side, enemy = 1 - side;
      const pawn = side === 0 ? p0 : p1, opponent = side === 0 ? p1 : p0;
      const targets = [pawn].concat(movesF(rootT.adj, pawn, opponent));
      const baseEnemy = rootT.dist[enemy][opponent];
      const loss = child => {
        if (child.dist[enemy][opponent] === 99) return -999;
        const enemyDetour = child.dist[enemy][opponent] - baseEnemy;
        let best = -999;
        for (const p of targets) {
          if (child.dist[side][p] === 99) continue;
          const v = child.dist[side][p] - rootT.dist[side][p] - .65 * enemyDetour;
          if (v > best) best = v;
        }
        return best;
      };
      const first = [];
      for (let fence = 0; fence < 128; fence++) {
        if (!hasBit(rootT.available, fence)) continue;
        this.check();
        const child = this.child(rootT, fence);
        const severity = loss(child);
        if (severity < 0) continue;
        const r = (fence & 63) >> 3, c = fence & 7;
        const near = -Math.abs(r - ((pawn / 9) | 0)) - Math.abs(c - pawn % 9);
        first.push({ severity, near, fence, child });
      }
      first.sort((x, y) => (y.severity - x.severity) || (y.near - x.near) || (x.fence - y.fence));
      const plans = first.slice(0, 12).map(t => ({ strength: t.severity, first: t.fence, second: -1 }));
      if (enemyWalls < 2) return plans;
      for (const { fence, child } of first.slice(0, 10)) {
        let best = null;
        for (let second = 0; second < 128; second++) {
          if (now() >= until) return plans;
          if (!hasBit(child.available, second)) continue;
          this.check();
          const end = this.child(child, second);
          const total = loss(end);
          if (total > 2 && (best === null || total > best.strength)) best = { strength: total, first: fence, second };
        }
        if (best !== null) plans.push(best);
      }
      return plans;
    }

    rootDefenses(options, allWalls, plans) {
      const own = this.side, present = new Set(options.map(o => o.act));
      const potential = [];
      for (const option of allWalls) {
        if (present.has(option.act)) continue;
        const child = option.t;
        let blocked = 0;
        for (const { strength, first, second } of plans) {
          const firstGone = !hasBit(child.available, first) && !hasBit(child.mask, first);
          const secondGone = second >= 0 && !hasBit(child.available, second) && !hasBit(child.mask, second);
          if (firstGone || secondGone) blocked += Math.max(0, strength - (second < 0 ? 1 : 2));
        }
        if (blocked > 0) {
          const pawn = own === 0 ? option.a : option.b;
          potential.push({ blocked, negd: -child.dist[own][pawn], s: option.s, negact: -option.act, option });
        }
      }
      potential.sort((x, y) => (y.blocked - x.blocked) || (y.negd - x.negd) || (y.s - x.s) || (y.negact - x.negact));
      return options.concat(potential.slice(0, 6).map(v => v.option));
    }

    search(topology, p0, p1, f0, f1, turn, depth, alpha, beta, ply) {
      this.nodes++;
      if (this.nodes % 16 === 0) this.check();
      if (p0 >= 72) return turn === 0 ? 1000000 - ply : -1000000 + ply;
      if (p1 < 9) return turn === 1 ? 1000000 - ply : -1000000 + ply;
      const pawn = turn === 0 ? p0 : p1, opponent = turn === 0 ? p1 : p0;
      if (QAgent.distance(topology, pawn, opponent, turn) === 1) return 1000000 - ply - 1;
      // 이미 거쳐 온 국면으로 돌아오면 무승부(0). 원본은 (mask,p0,p1,f0,f1,turn) 키 비교이며, 탐색은 벽을 더할 뿐이라
      // 루트와 같은 벽 배치(topology === root)에서만 일치할 수 있고 그때 f0, f1 은 루트와 같다.
      if (topology === this.root && this.prevSet.has((p0 * 81 + p1) * 2 + turn)) return 0;
      if (depth === 0) return this.evaluate(topology, p0, p1, f0, f1, turn);
      const key = QAgent.key(topology, p0, p1, f0, f1, turn);
      const old = this.tt.get(key);
      const alpha0 = alpha;
      if (old !== undefined && old.depth >= depth) {
        let value = old.value;
        if (value > 900000) value -= ply; else if (value < -900000) value += ply;
        if (old.flag === 0) return value;
        if (old.flag === 1) alpha = Math.max(alpha, value); else beta = Math.min(beta, value);
        if (alpha >= beta) return value;
      }
      const width = depth >= 2 ? 10 : 8;
      const options = this.options(topology, p0, p1, f0, f1, turn, width);
      if (options.length === 0) return this.evaluate(topology, p0, p1, f0, f1, turn);
      if (old !== undefined) options.sort((x, y) => (x.act !== old.best) - (y.act !== old.best));
      let best = -2000000, bestAction = options[0].act;
      for (const o of options) {
        const score = -this.search(o.t, o.a, o.b, o.u, o.v, 1 - turn, depth - 1, -beta, -alpha, ply + 1);
        if (score > best) { best = score; bestAction = o.act; }
        alpha = Math.max(alpha, best);
        if (alpha >= beta) break;
      }
      const flag = best <= alpha0 ? -1 : best >= beta ? 1 : 0;
      const stored = best > 900000 ? best + ply : best < -900000 ? best - ply : best;
      this.tt.set(key, { depth, value: stored, flag, best: bestAction });
      return best;
    }

    /* 벽 행동이 없는 고정 그래프에서 81×81×2 상태의 정확한 승패와 종료 거리 (codex.py _solve_race) */
    solveRace(topology) {
      if (this.endgame !== null && this.endgame.maskBig === topology.maskBig) return this.endgame;
      const size = 81 * 81 * 2;
      const parents = new Array(size); for (let i = 0; i < size; i++) parents[i] = [];
      const remaining = new Uint8Array(size), winner = new Int8Array(size).fill(-1);
      const depth = new Int32Array(size), longest = new Int32Array(size);
      const heap = [];
      const push = v => { heap.push(v); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p] <= heap[i]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
      const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l] < heap[m]) m = l; if (r < heap.length && heap[r] < heap[m]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
      const ENC = 16384;
      for (let a = 0; a < 81; a++) {
        this.check();
        for (let b = 0; b < 81; b++) {
          if (a === b) continue;
          const key = (a * 81 + b) * 2;
          const terminal = a >= 72 ? 0 : b < 9 ? 1 : -1;
          if (terminal >= 0) { winner[key] = winner[key + 1] = terminal; push(key); push(key + 1); continue; }
          for (let turn = 0; turn < 2; turn++) {
            const index = key + turn;
            for (const dest of movesF(topology.adj, turn === 0 ? a : b, turn === 0 ? b : a)) {
              const child = (turn === 0 ? dest * 81 + b : a * 81 + dest) * 2 + 1 - turn;
              parents[child].push(index); remaining[index]++;
            }
          }
        }
      }
      let count = 0;
      while (heap.length) {
        const v = pop(), distance = (v / ENC) | 0, index = v % ENC;
        count++;
        if (count % 128 === 0) this.check();
        const childWinner = winner[index];
        for (const parent of parents[index]) {
          if (winner[parent] >= 0) continue;
          const turn = parent & 1;
          if (childWinner === turn) { winner[parent] = turn; depth[parent] = distance + 1; push((distance + 1) * ENC + parent); }
          else {
            remaining[parent]--;
            if (distance > longest[parent]) longest[parent] = distance;
            if (remaining[parent] === 0) { winner[parent] = 1 - turn; depth[parent] = longest[parent] + 1; push(depth[parent] * ENC + parent); }
          }
        }
      }
      this.endgame = { maskBig: topology.maskBig, winner, depth };
      return this.endgame;
    }

    /* 한 수 선택. state 는 QRules 상태, budget 은 ms. 반환 {action:{type:'move',to}|{type:'fence',f}, stats} */
    choose(state, budget) {
      const started = now();
      this.deadline = started + Math.max(0, budget - Math.min(budget, this.reserve(budget)));
      this.nodes = 0;
      const side = this.side;
      const adj = R.buildAdj(state.walls);
      const p0 = state.pawns[0], p1 = state.pawns[1], f0 = state.fences[0], f1 = state.fences[1];
      const pawn = side === 0 ? p0 : p1, opponent = side === 0 ? p1 : p0;
      const legal = R.pawnMoves(adj, pawn, opponent);
      if (legal.length === 0) { this.lastStats = { depth: 0, nodes: 0, seconds: 0 }; return { action: null, stats: this.lastStats }; }
      for (const dest of legal) {
        if ((side === 0 && dest >= 72) || (side === 1 && dest < 9)) {
          this.lastStats = { depth: 0, nodes: 0, score: 1000000, ms: now() - started };
          return { action: { type: 'move', to: dest }, stats: this.lastStats };
        }
      }
      let fallback = { type: 'move', to: legal[0] };
      if (budget < 15) { this.lastStats = { depth: 0, nodes: 0, ms: now() - started }; return { action: fallback, stats: this.lastStats }; }
      const maskBig = R.maskBig(state.walls);
      const rootT = new Topology(flatAdj(adj), maskBig, R.maskWords(state.walls), R.availableWords(state.walls), true);
      this.root = rootT; rootT.id = 0; this.nextId = 1;
      this.positions.push({ maskBig, p0, p1, f0, f1, side });
      if (this.positions.length > 48) this.positions.shift();
      this.prevSet = new Set();
      for (const q of this.positions) if (q.maskBig === maskBig) this.prevSet.add((q.p0 * 81 + q.p1) * 2 + q.side);
      const legalSet = new Set(legal);
      const recentCount = p => { let n = 0; for (const r of this.recent) if (r.maskBig === maskBig && r.p === p) n++; return n; };
      let bestMove = legal[0], bestKey = null;
      for (const p of legal) {
        const k = [rootT.dist[side][p], recentCount(p), Math.abs(p % 9 - 4), p];
        if (bestKey === null || k[0] < bestKey[0] || (k[0] === bestKey[0] && (k[1] < bestKey[1] || (k[1] === bestKey[1] && (k[2] < bestKey[2] || (k[2] === bestKey[2] && k[3] < bestKey[3])))))) { bestKey = k; bestMove = p; }
      }
      fallback = { type: 'move', to: bestMove };
      this.topologies = new Map([[maskBig, rootT]]);
      this.ordered = new Map(); this.tt = new Map();
      let selected = bestMove, completedDepth = 0, score = 0;
      try {
        const enemyWalls = side === 0 ? f1 : f0;
        if (enemyWalls === 0 && budget >= 80) {
          const { winner, depth: dtm } = this.solveRace(rootT);
          const index = (p0 * 81 + p1) * 2 + side;
          if (winner[index] === side || f0 + f1 === 0) {
            let bestRank = null, pick = legal[0];
            for (const dest of legal) {
              const child = (side === 0 ? dest * 81 + p1 : p0 * 81 + dest) * 2 + 1 - side;
              const outcome = winner[child];
              const rank = outcome === side ? [2, -dtm[child]] : outcome < 0 ? [1, -rootT.dist[side][dest]] : [0, dtm[child]];
              const k = [rank[0], rank[1], -recentCount(dest), -dest];
              let better = bestRank === null;
              if (!better) for (let i = 0; i < 4; i++) { if (k[i] !== bestRank[i]) { better = k[i] > bestRank[i]; break; } }
              if (better) { bestRank = k; pick = dest; }
            }
            this.recent.push({ maskBig, p: pick, opp: opponent }); if (this.recent.length > 12) this.recent.shift();
            this.lastStats = { depth: 'exact race', nodes: 0, ms: now() - started };
            return { action: { type: 'move', to: pick }, stats: this.lastStats };
          }
        }
        let options = this.options(rootT, p0, p1, f0, f1, side, 26);
        const until = this.nodeLimit ? Infinity : Math.min(this.deadline, started + Math.max(25, budget * .14));
        const plans = this.trapPlans(rootT, p0, p1, enemyWalls, until);
        const rootKey = QAgent.key(rootT, p0, p1, f0, f1, side);
        options = this.rootDefenses(options, this.ordered.get(rootKey).walls, plans);
        options = options.filter(o => o.act >= 81 || legalSet.has(o.act));
        const penalties = new Map();
        for (const o of options) penalties.set(o.act, o.act < 81 ? 30 * recentCount(o.act) : 0);
        for (let depth = 1; depth <= 8; depth++) {
          this.check();
          options.sort((x, y) => ((x.act !== selected) - (y.act !== selected)) || ((penalties.get(x.act) - x.s) - (penalties.get(y.act) - y.s)) || (x.act - y.act));
          let alpha = -2000000, iterationAction = selected, iterationScore = -2000000;
          for (const o of options) {
            this.check();
            const penalty = penalties.get(o.act);
            const value = -this.search(o.t, o.a, o.b, o.u, o.v, 1 - side, depth - 1, -2000000, -(alpha + penalty), 1) - penalty;
            if (value > iterationScore) { iterationScore = value; iterationAction = o.act; }
            alpha = Math.max(alpha, value);
          }
          selected = iterationAction; score = iterationScore; completedDepth = depth;
          if (Math.abs(score) >= 900000) break;
        }
      } catch (e) { if (e !== TIME_UP) throw e; }
      this.lastStats = { depth: completedDepth, nodes: this.nodes, topologies: this.topologies.size, score, ms: now() - started };
      let action = null;
      if (selected >= 81) {
        const fence = selected - 81;
        if (R.fenceCheck(state, fence) === null) action = { type: 'fence', f: fence };   // 최종 규칙 재검증
      } else if (legalSet.has(selected)) {
        this.recent.push({ maskBig, p: selected, opp: opponent }); if (this.recent.length > 12) this.recent.shift();
        action = { type: 'move', to: selected };
      }
      if (action === null) action = fallback;
      this.lastStats.ms = now() - started;
      this.topologies = null; this.ordered = null; this.tt = null; this.root = null;
      return { action, stats: this.lastStats };
    }
  }

  root.QAgent = QAgent;

  /* Worker 모드 */
  if (typeof importScripts === 'function' && typeof root.postMessage === 'function') {
    let agent = null;
    root.onmessage = e => {
      const m = e.data || {};
      if (m.type === 'reset') { agent = new QAgent(m.side); root.postMessage({ type: 'ready' }); return; }
      if (m.type !== 'think') return;
      if (agent === null || agent.side !== m.side) agent = new QAgent(m.side);
      try {
        const res = agent.choose(m.state, m.budget);
        root.postMessage({ type: 'move', id: m.id, action: res.action, stats: res.stats });
      } catch (err) {
        root.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
      }
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
