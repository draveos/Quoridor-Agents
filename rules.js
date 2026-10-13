/* 쿼리도 규칙 엔진 (순수 JS, 의존 없음).
 * 좌표 규약은 quoridor-arena 의 pyquoridor 0.0.5 와 같습니다.
 *   칸: p = row*9 + col, row 0..8, col 0..8. white 는 (0,4) 에서 출발해 row 8 도착, black 은 (8,4) 에서 row 0 도착.
 *   울타리 id: kind*64 + r*8 + c (kind 0 = h 가로, 1 = v 세로), r, c 는 0..7.
 *   h(r,c) 는 칸 (r,c)-(r+1,c) 와 (r,c+1)-(r+1,c+1) 사이를 끊고, v(r,c) 는 (r,c)-(r,c+1) 와 (r+1,c)-(r+1,c+1) 를 끊습니다.
 * 이동, 점프, 대각 점프, 겹침, 경로 차단 판정은 codex.py 21~48, 105~123행과 pyquoridor board.py 를 옮긴 것입니다.
 * 규칙 판정 일부는 pyquoridor 0.0.5(MIT, Copyright (c) 2023 Ramon Viñas Torné, https://github.com/playquoridor/python-quoridor)를 참고해 JS 로 옮겼습니다. 라이선스 전문은 THIRD_PARTY.md 에 있습니다.
 * 브라우저(일반 스크립트, Worker 의 importScripts)와 Node 에서 모두 globalThis.QRules 로 노출됩니다. */
(function (root) {
  'use strict';
  const N = 81, F = 128, UNREACH = 99;

  /* ---- 울타리 기하 (codex.py 105~123행) ---- */
  const EDGES = new Array(F);          // EDGES[f] = [[a,b],[c,d]] 끊는 간선 2개
  const CONFLICT_IDS = new Array(F);   // 겹치는 울타리 id 목록(자기 자신 포함)
  const CONFLICT_WORDS = new Array(F); // 같은 것을 32비트 워드 4개 비트마스크로
  const FENCE_BIG = new Array(F);      // 1n << f (캐시 키용)
  const COVERS = new Array(N * N);     // COVERS[a*81+b] = 간선 (a,b)를 끊을 수 있는 울타리 id 목록
  for (let kind = 0; kind < 2; kind++) {
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = r * 9 + c, f = kind * 64 + r * 8 + c;
        EDGES[f] = kind === 0 ? [[p, p + 9], [p + 1, p + 10]] : [[p, p + 1], [p + 9, p + 10]];
        const ids = [kind * 64 + r * 8 + c, (1 - kind) * 64 + r * 8 + c];
        if (kind === 0) { for (const nc of [c - 1, c + 1]) if (nc >= 0 && nc < 8) ids.push(r * 8 + nc); }
        else { for (const nr of [r - 1, r + 1]) if (nr >= 0 && nr < 8) ids.push(64 + nr * 8 + c); }
        CONFLICT_IDS[f] = ids;
        const w = new Int32Array(4);
        for (const i of ids) w[i >> 5] |= 1 << (i & 31);
        CONFLICT_WORDS[f] = w;
        FENCE_BIG[f] = 1n << BigInt(f);
      }
    }
  }
  for (let f = 0; f < F; f++) {
    for (const [a, b] of EDGES[f]) {
      (COVERS[a * N + b] || (COVERS[a * N + b] = [])).push(f);
      (COVERS[b * N + a] || (COVERS[b * N + a] = [])).push(f);
    }
  }

  /* 기본 직교 인접(울타리 없음) */
  const BASE_ADJ = new Array(N);
  for (let p = 0; p < N; p++) {
    const r = (p / 9) | 0, c = p % 9, list = [];
    if (r > 0) list.push(p - 9);
    if (c > 0) list.push(p - 1);
    if (c < 8) list.push(p + 1);
    if (r < 8) list.push(p + 9);
    BASE_ADJ[p] = list;
  }

  function fenceId(r, c, orient) {
    if (!(r >= 0 && r <= 7 && c >= 0 && c <= 7)) return -1;
    const kind = orient === 'v' || orient === 'vertical' ? 1 : 0;
    return kind * 64 + r * 8 + c;
  }
  function fenceRC(f) { const k = f >> 6, i = f & 63; return { r: i >> 3, c: i & 7, orient: k === 1 ? 'v' : 'h' }; }

  /* 울타리 목록 → 인접 그래프(81개 정렬 배열). walls 는 울타리 id 배열 */
  function buildAdj(walls) {
    const adj = BASE_ADJ.map(l => l.slice());
    for (const f of walls) {
      for (const [a, b] of EDGES[f]) {
        adj[a] = adj[a].filter(x => x !== b);
        adj[b] = adj[b].filter(x => x !== a);
      }
    }
    return adj;
  }
  function maskWords(walls) { const w = new Int32Array(4); for (const f of walls) w[f >> 5] |= 1 << (f & 31); return w; }
  function maskBig(walls) { let m = 0n; for (const f of walls) m |= FENCE_BIG[f]; return m; }
  function availableWords(walls) {
    const w = new Int32Array(4); w[0] = w[1] = w[2] = w[3] = -1;
    for (const f of walls) { const c = CONFLICT_WORDS[f]; for (let i = 0; i < 4; i++) w[i] &= ~c[i]; }
    return w;
  }
  const hasBit = (words, f) => (words[f >> 5] & (1 << (f & 31))) !== 0;

  /* 합법 이동 (codex.py _moves): 직교 인접, 인접 상대는 뒤가 이어지면 직선 점프, 아니면 상대 칸의 다른 이웃으로 대각 */
  function pawnMoves(adj, position, opponent) {
    const result = [];
    for (const n of adj[position]) {
      if (n !== opponent) { result.push(n); continue; }
      const jump = opponent + opponent - position;
      if (adj[opponent].includes(jump)) result.push(jump);
      else for (const d of adj[opponent]) if (d !== position) result.push(d);
    }
    return Array.from(new Set(result)).sort((a, b) => a - b);
  }

  /* 목표줄 다중 소스 BFS 거리 (codex.py _distances). 99 는 도달 불가 */
  function distances(adj, side) {
    const d = new Uint8Array(N).fill(UNREACH);
    const queue = [];
    if (side === 0) for (let p = 72; p < 81; p++) queue.push(p); else for (let p = 0; p < 9; p++) queue.push(p);
    for (const p of queue) d[p] = 0;
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i], nd = d[p] + 1;
      for (const n of adj[p]) if (d[n] === UNREACH) { d[n] = nd; queue.push(n); }
    }
    return d;
  }

  /* ---- 상태 ---- */
  function initial() { return { pawns: [4, 76], fences: [10, 10], turn: 0, walls: [] }; }
  function clone(s) { return { pawns: s.pawns.slice(), fences: s.fences.slice(), turn: s.turn, walls: s.walls.slice() }; }
  const sideToMove = s => s.turn & 1;
  function winner(s) { if (s.pawns[0] >= 72) return 0; if (s.pawns[1] < 9) return 1; return -1; }

  function legalMoves(s, adj) {
    const side = sideToMove(s);
    adj = adj || buildAdj(s.walls);
    return pawnMoves(adj, s.pawns[side], s.pawns[1 - side]);
  }

  /* 울타리 합법성. null 이면 합법, 아니면 이유 문자열 (range, none-left, overlap, blocks) */
  function fenceCheck(s, f, avail, adj) {
    if (!(f >= 0 && f < F)) return 'range';
    if (s.fences[sideToMove(s)] <= 0) return 'none-left';
    avail = avail || availableWords(s.walls);
    if (!hasBit(avail, f)) return 'overlap';
    adj = adj || buildAdj(s.walls);
    const child = adj.slice();
    for (const [a, b] of EDGES[f]) { child[a] = child[a].filter(x => x !== b); child[b] = child[b].filter(x => x !== a); }
    if (distances(child, 0)[s.pawns[0]] === UNREACH || distances(child, 1)[s.pawns[1]] === UNREACH) return 'blocks';
    return null;
  }
  function legalFences(s) {
    const out = [];
    if (s.fences[sideToMove(s)] <= 0) return out;
    const avail = availableWords(s.walls), adj = buildAdj(s.walls);
    for (let f = 0; f < F; f++) if (hasBit(avail, f) && fenceCheck(s, f, avail, adj) === null) out.push(f);
    return out;
  }

  /* 수 적용. action: {type:'move', to} 또는 {type:'fence', f}. 불법이면 Error(reason) */
  function apply(s, action) {
    if (winner(s) >= 0) throw Object.assign(new Error('game over'), { reason: 'over' });
    const side = sideToMove(s), next = clone(s);
    if (action.type === 'move') {
      const moves = legalMoves(s);
      if (!moves.includes(action.to)) throw Object.assign(new Error('illegal move'), { reason: 'move' });
      next.pawns[side] = action.to;
    } else if (action.type === 'fence') {
      const why = fenceCheck(s, action.f);
      if (why) throw Object.assign(new Error('illegal fence: ' + why), { reason: why });
      next.walls.push(action.f);
      next.fences[side] -= 1;
    } else throw Object.assign(new Error('unknown action'), { reason: 'unknown' });
    next.turn += 1;
    return next;
  }

  root.QRules = {
    N, F, UNREACH, EDGES, CONFLICT_IDS, CONFLICT_WORDS, FENCE_BIG, COVERS,
    fenceId, fenceRC, buildAdj, maskWords, maskBig, availableWords, hasBit,
    pawnMoves, distances, initial, clone, sideToMove, winner, legalMoves, fenceCheck, legalFences, apply,
    cell: (r, c) => r * 9 + c, rc: p => [(p / 9) | 0, p % 9]
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
