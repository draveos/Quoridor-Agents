/* 쿼리도 에이전트 "claude": quoridor-arena 의 engine/agents/office.py (Agent Office 가 회의 12회차까지 다듬은 에이전트,
 * GPT 작성 codex 상대 비교 실험에서 18/40 = 45% 까지 간 설치본) 를 순수 JS 로 옮긴 것입니다. 외부 의존은 rules.js(QRules) 하나입니다.
 *
 * 구조는 원본과 같습니다.
 *   candidates(): 루트 후보 고르기 — 초반 탐색 국면(양쪽 벽 미사용, 3수까지)은 이동만, 그 뒤 상대 울타리 사용 이력으로 공격형/수비형 분류,
 *     상대 말 이력으로 레인 질주 감지, 내 가로벽이 가장자리에 영구 틈 1칸을 남겼는지 확인, "가깝고 앞서 있으면 벽 안 둠" 게이트,
 *     상대 최단 경로 2~4칸 앞 칸을 덮는 울타리만 1단 통과, 상대 말과 가까운 20개로 2단 축소, 2~3장 조합 계획(_plan_combo),
 *     (상대 경로 증가 - 내 경로 증가) + 가장자리 밀어내기 보너스로 채점해 상위 24개를 이동 앞에 둔다.
 *   adversarial_search(): 반복심화 알파베타 negamax(깊이 1→6). 깊이 1은 평가만, 그 아래는 벽 그래프(Topology) 재귀.
 *     치환표(깊이 포함 값 캐시), 위치별 최선수 힌트, 깊이별 킬러 2개, 울타리 후보는 가능 비트 56개만 훑어 상대 지연 효과 순 12개.
 *   평가 = -내거리 + 상대거리 + 0.15*내벽 - 0.05*상대벽 + 0.02*(-|열-4|) - 0.1*경로취약도(공격형 상대면 1.5배) + 0.1*점프기회.
 * 달라진 점:
 *   시간 예산은 Python 의 "마감 0.15초 전" 대신 15%(최소 12ms) 예약이고 시간 확인은 64노드가 아니라 16노드마다 합니다.
 *   엔진 BFS 의 이웃 순서(파이썬 set 순서)는 칸 번호 오름차순으로 대체했습니다(같은 길이 경로 중 어느 것을 고르느냐만 다릅니다).
 *   원본의 self_wall_penalty 분기는 방향 문자열 비교('h' 대 'horizontal')가 어긋나 실제로는 한 번도 발동하지 않았으므로
 *     self_wall_penalty_on 토글(기본 false) 뒤에 두어 측정된 설치본과 같은 동작을 기본으로 합니다.
 *   즉시 승리 수는 탐색 없이 둡니다(원본은 평가 1e6 으로 같은 수를 고릅니다).
 * 일반 스크립트, Worker(importScripts), Node 에서 모두 동작하고 globalThis.QAgentClaude 로 노출됩니다.
 * Worker 로 실행될 때의 메시지: {type:'think', id, side, state, budget} → {type:'move', id, action, stats}; {type:'reset', side} → {type:'ready'}. */
(function (root) {
  'use strict';
  if (typeof importScripts === 'function' && !root.QRules) importScripts('../rules.js');
  const R = root.QRules;
  const TIME_UP = { timeUp: true };
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const hasBit = R.hasBit;
  const FENCES_MAX = 10;
  const NONE = 255;

  /* office_params.json(설치본) 과 DEFAULT 를 합친 값. 미사용 하위호환 키(lead_bonus, fence_reserve, aggressive_turn_threshold, reply_margin)는 뺐습니다. */
  const DEFAULT = {
    my_dist: -1.0, op_dist: 1.0, fence_keep: 0.15, op_fence: -0.05, center: 0.02,
    fence_when_behind: 1, max_fence_candidates: 24,
    path_vuln: -0.1, self_wall_penalty: 0.08, self_wall_penalty_on: false, jump_op: 0.1, detour_bonus: 0.05,
    explore_k: 3, path_vuln_aggr_mult: 1.5,
    trap_ahead_min: 2, trap_ahead_max: 4, max_fence_prescreen: 20,
    style_fence_count: 2, style_history_len: 6,
    row_wall_trigger: 2, gap_align_bonus: 0.05, combo_min_gain: 4, fence_reserve_min: 1, row_wall_exception_on: false,
    beam_width: 12, max_search_depth: 5, fence_scan_cap: 56,
    lane_rush_window: 4, lane_rush_col_tol: 1, lane_rush_min_progress: 2, lane_rush_extra_ahead: 3, lane_rush_row_tol: 1
  };

  /* ---- 벽 그래프: 칸당 4칸짜리 Uint8Array(이웃 오름차순, 빈 자리 255) ---- */
  function flatAdj(adj) { const f = new Uint8Array(324).fill(NONE); for (let p = 0; p < 81; p++) { const l = adj[p]; for (let k = 0; k < l.length; k++) f[p * 4 + k] = l[k]; } return f; }
  function removeEdge(f, a, b) { const base = a * 4; for (let k = 0; k < 4; k++) if (f[base + k] === b) { for (let j = k; j < 3; j++) f[base + j] = f[base + j + 1]; f[base + 3] = NONE; return; } }
  function hasEdge(f, a, b) { const base = a * 4; return f[base] === b || f[base + 1] === b || f[base + 2] === b || f[base + 3] === b; }
  function degF(f, p) { const base = p * 4; let n = 0; for (let k = 0; k < 4; k++) { if (f[base + k] === NONE) break; n++; } return n; }
  /* office.py _topo_moves: 이웃 전부 + 인접 상대는 직선 점프, 막히면 대각 (정렬, 중복 제거) */
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
  /* office.py _topo_distances: 목표줄 다중 소스 BFS (점프 무시) */
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

  /* ---- 엔진 그래프 흉내 (office.py shortest / shortest_path / path_vulnerability) ----
   * pyquoridor 의 square.neighbours 는 말이 선 칸에 한해 직교 이웃에 점프 칸(직선, 막히면 대각)을 더해 둡니다.
   * 루트의 거리, 경로, 취약도는 그 그래프로 재고, 탐색 안쪽(Topology)은 점프를 뺀 거리를 씁니다. 원본과 같은 두 층입니다. */
  function engineNb(f, cell, p0, p1) {
    const out = [];
    for (let k = 0; k < 4; k++) { const n = f[cell * 4 + k]; if (n === NONE) break; out.push(n); }
    if (cell === p0 || cell === p1) {
      const other = cell === p0 ? p1 : p0;
      for (const m of movesF(f, cell, other)) if (!out.includes(m)) out.push(m);
      out.sort((a, b) => a - b);
    }
    return out;
  }
  function shortestPathE(f, side, start, p0, p1) {
    const goalRow = side === 0 ? 8 : 0;
    const prev = new Int16Array(81).fill(-2);
    const queue = [start]; prev[start] = -1;
    let end = -1;
    for (let i = 0; i < queue.length && end < 0; i++) {
      const p = queue[i];
      if (((p / 9) | 0) === goalRow) { end = p; break; }
      for (const n of engineNb(f, p, p0, p1)) if (prev[n] === -2) { prev[n] = p; queue.push(n); }
    }
    if (end < 0) return [start];
    const path = [];
    for (let p = end; p !== -1; p = prev[p]) path.push(p);
    path.reverse();
    return path;
  }
  function shortestE(f, side, start, p0, p1) {
    const goalRow = side === 0 ? 8 : 0;
    const seen = new Uint8Array(81); seen[start] = 1;
    const queue = [start], dist = [0];
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i];
      if (((p / 9) | 0) === goalRow) return dist[i];
      for (const n of engineNb(f, p, p0, p1)) if (!seen[n]) { seen[n] = 1; queue.push(n); dist.push(dist[i] + 1); }
    }
    return 99;
  }
  function pathVulnE(f, side, start, p0, p1) {
    const path = shortestPathE(f, side, start, p0, p1);
    let v = 0;
    for (let i = 0; i < path.length - 1; i++) v += 1 / Math.max(engineNb(f, path[i], p0, p1).length, 1);
    return v;
  }

  /* office.py fence_ahead_of_op: 울타리가 덮는 네 칸이 상대가 지나온 칸과 겹치면 버리고, lo~hi 칸 앞과 겹칠 때만 통과 */
  function fenceAheadOfOp(r, c, opPath, lo, hi) {
    const n = opPath.length;
    let hi2 = Math.min(hi, n - 1), lo2 = lo;
    if (hi2 < lo2) { lo2 = 0; hi2 = n - 1; }
    const p = r * 9 + c, cells = [p, p + 1, p + 9, p + 10];
    for (let i = 0; i < lo2; i++) if (cells.includes(opPath[i])) return false;
    for (let i = lo2; i <= hi2; i++) if (cells.includes(opPath[i])) return true;
    return false;
  }
  /* office.py lane_rush_detected: 상대 말 이력이 한 열(또는 한 행)에 머물며 min_progress 이상 전진했는가 */
  function laneRushDetected(history, colTol, minProgress, rowTol) {
    if (history.length < 2) return false;
    let minR = 9, maxR = -1, minC = 9, maxC = -1;
    for (const [r, c] of history) { if (r < minR) minR = r; if (r > maxR) maxR = r; if (c < minC) minC = c; if (c > maxC) maxC = c; }
    const first = history[0], last = history[history.length - 1];
    if (maxC - minC <= colTol && Math.abs(last[0] - first[0]) >= minProgress) return true;
    return maxR - minR <= rowTol && Math.abs(last[1] - first[1]) >= minProgress;
  }
  function openCols(cols) { const covered = new Set(); for (const c of cols) { covered.add(c); covered.add(c + 1); } const open = []; for (let c = 0; c < 9; c++) if (!covered.has(c)) open.push(c); return open; }
  function addCol(map, r, c) { let s = map.get(r); if (!s) { s = new Set(); map.set(r, s); } s.add(c); }

  /* office.py _Topology: 벽 배치 하나당 인접 그래프, 놓을 수 있는 울타리, 양쪽 거리, 자식 캐시 */
  function Topology(adj, maskBig, mask, available) {
    this.adj = adj; this.maskBig = maskBig; this.mask = mask; this.available = available; this.id = 0;
    this.dist = [distF(adj, 0), distF(adj, 1)];
    this.children = [];
  }

  class QAgentClaude {
    constructor(side, params) {
      this.side = side;                                  // 0 white, 1 black
      this.P = Object.assign({}, DEFAULT, params || {});
      this.turn = 0;
      this.style = null;                                 // 'aggressive' | 'defensive' | null
      this.prevOpFences = FENCES_MAX;
      this.opFenceHistory = [];                          // 최근 style_history_len 수 동안 상대가 벽을 썼는지 (1/0)
      this.knownFences = new Set();                      // 직전에 본 울타리 id 집합
      this.lastMyBlock = -1;                             // 직전에 내가 둔 울타리 id
      this.opHFenceCols = new Map();                     // 상대 가로벽 row -> Set(col)
      this.rowWallGap = null;
      this.myHFenceCols = new Map();                     // 내 가로벽 row -> Set(col)
      this.lockedEdgeGap = null;                         // [row, col] | null
      this.opPawnHistory = [];                           // 최근 lane_rush_window 수 동안 상대 말 [row, col]
      this.plan = null;                                  // {fences:[id...], gain, madeAt, execCount} | null
      this.planExecTotal = 0; this.comboIllegalTotal = 0;
      this.depthReachedTotal = 0; this.movesSearched = 0;
      this.lastStats = {};
      this.reserve = budget => Math.max(12, budget * 0.15);
      this.nodeLimit = 0;                                // 0 이면 시간 예산, 양수면 노드 예산(결정적 검증용)
    }

    check() { if (this.nodeLimit ? this.nodes >= this.nodeLimit : now() >= this.deadline) throw TIME_UP; }
    timeLeft() { return this.nodeLimit ? this.nodes < this.nodeLimit : now() < this.deadline; }

    /* office.py _topo_child: 울타리 하나를 더 놓은 자식 Topology. mask 로 전역 캐시 */
    topoChild(topology, fence) {
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
        child = new Topology(adj, maskBig, mask, available);
        child.id = this.nextId++;
        this.topologies.set(maskBig, child);
      }
      topology.children[fence] = child;
      return child;
    }

    /* office.py _path_vuln_topo: 거리 내림 경로 하나를 복원해 칸마다 1/이웃수 를 더한다 (외길일수록 취약) */
    static pathVulnTopo(topology, pos, side) {
      const dist = topology.dist[side], adj = topology.adj;
      let p = pos, d = dist[p], v = 0;
      while (d > 0) {
        let nxt = -1;
        for (let k = 0; k < 4; k++) { const n = adj[p * 4 + k]; if (n === NONE) break; if (dist[n] === d - 1) { nxt = n; break; } }
        if (nxt < 0) break;
        v += 1 / Math.max(degF(adj, p), 1);
        p = nxt; d -= 1;
      }
      return v;
    }

    /* office.py _features_topo + _evaluate_topo: 항상 내(self.side) 관점의 값 */
    evaluateTopo(topology, p0, p1, f0, f1, P) {
      const me = this.side, op = 1 - me;
      const mePos = me === 0 ? p0 : p1, opPos = me === 0 ? p1 : p0;
      const meF = me === 0 ? f0 : f1, opF = me === 0 ? f1 : f0;
      const md = topology.dist[me][mePos], od = topology.dist[op][opPos];
      if (md === 0) return 1e6;
      if (od === 0) return -1e6;
      const vuln = QAgentClaude.pathVulnTopo(topology, mePos, me);
      let jump = 0;
      if (hasEdge(topology.adj, mePos, opPos)) {
        const jd = opPos + opPos - mePos;
        if (jd >= 0 && jd < 81 && hasEdge(topology.adj, opPos, jd)) jump = 1;
        else for (let k = 0; k < 4; k++) { const d = topology.adj[opPos * 4 + k]; if (d === NONE) break; if (d !== mePos) { jump = 1; break; } }
      }
      return P.my_dist * md + P.op_dist * od + P.fence_keep * meF + P.op_fence * opF
        + P.center * (-Math.abs(mePos % 9 - 4)) + P.path_vuln * vuln + P.jump_op * jump;
    }

    /* office.py _topo_options: 이동 전부(목표 쪽 먼저, 거리 동률이면 분기 많은 쪽) + 울타리 상위 beam_width(상대 지연 효과 큰 순).
     * 행동 코드: 0~80 이동 목적지, 81~208 울타리 id+81 */
    topoOptions(topology, p0, p1, f0, f1, mover, beamWidth, fenceScanCap) {
      const pawn = mover === 0 ? p0 : p1, opp = mover === 0 ? p1 : p0, oppSide = 1 - mover;
      const dm = topology.dist[mover], adj = topology.adj;
      const moves = movesF(adj, pawn, opp);
      moves.sort((a, b) => (dm[a] - dm[b]) || (degF(adj, b) - degF(adj, a)));
      if ((mover === 0 ? f0 : f1) <= 0) return moves;
      const orow = (opp / 9) | 0, ocol = opp % 9, base = topology.dist[oppSide][opp];
      const cand = [];
      let scanned = 0;
      for (let w = 0; w < 4 && scanned < fenceScanCap; w++) {
        let bits = topology.available[w];
        while (bits !== 0 && scanned < fenceScanCap) {
          const bit = bits & -bits; bits ^= bit;
          const fence = w * 32 + (31 - Math.clz32(bit));
          scanned++;
          const child = this.topoChild(topology, fence);
          if (child.dist[0][p0] === 99 || child.dist[1][p1] === 99) continue;
          const delta = child.dist[oppSide][opp] - base;
          const r = (fence & 63) >> 3, c = fence & 7;
          cand.push({ k1: -delta, k2: Math.abs(r - orow) + Math.abs(c - ocol), fence });
        }
      }
      cand.sort((a, b) => (a.k1 - b.k1) || (a.k2 - b.k2) || (a.fence - b.fence));
      for (let i = 0; i < cand.length && i < beamWidth; i++) moves.push(cand[i].fence + 81);
      return moves;
    }

    /* office.py _order_options: 전치표 최선수 → 킬러 → 나머지 (안정 정렬) */
    static orderOptions(options, hint, killers) {
      if (hint === undefined && !killers) return options;
      const first = [], second = [], rest = [];
      for (const o of options) {
        if (o === hint) first.push(o);
        else if (killers && (killers[0] === o || killers[1] === o)) second.push(o);
        else rest.push(o);
      }
      return first.concat(second, rest);
    }

    static posKey(topology, p0, p1, f0, f1, mover) { return ((((topology.id * 81 + p0) * 81 + p1) * 11 + f0) * 11 + f1) * 2 + mover; }

    /* office.py _negamax: 값 캐시 치환표(깊이 포함), 리프 또는 승부 확정이면 내 관점 값을 mover 부호로 */
    negamax(topology, p0, p1, f0, f1, mover, depth, alpha, beta, S) {
      this.nodes++;
      if (this.nodes % 16 === 0) this.check();
      const me = this.side;
      const posKey = QAgentClaude.posKey(topology, p0, p1, f0, f1, mover), key = posKey * 8 + depth;
      const cached = S.tt.get(key);
      if (cached !== undefined) return cached;
      const val = this.evaluateTopo(topology, p0, p1, f0, f1, S.P);
      if (depth === 0 || Math.abs(val) >= 1e5) {
        const result = mover === me ? val : -val;
        S.tt.set(key, result);
        return result;
      }
      const options = QAgentClaude.orderOptions(
        this.topoOptions(topology, p0, p1, f0, f1, mover, S.beamWidth, S.fenceScanCap), S.ttMove.get(posKey), S.killers[depth]);
      let best = -1e9, bestOpt = -1;
      for (const opt of options) {
        let np0 = p0, np1 = p1, nf0 = f0, nf1 = f1, child = topology;
        if (opt < 81) { if (mover === 0) np0 = opt; else np1 = opt; }
        else { child = this.topoChild(topology, opt - 81); if (mover === 0) nf0 = f0 - 1; else nf1 = f1 - 1; }
        const score = -this.negamax(child, np0, np1, nf0, nf1, 1 - mover, depth - 1, -beta, -alpha, S);
        if (score > best) { best = score; bestOpt = opt; }
        if (best > alpha) alpha = best;
        if (alpha >= beta) {
          const k = S.killers[depth] || (S.killers[depth] = []);
          const i = k.indexOf(opt); if (i >= 0) k.splice(i, 1);
          k.unshift(opt); if (k.length > 2) k.length = 2;
          break;
        }
      }
      if (best === -1e9) best = mover === me ? val : -val;
      S.tt.set(key, best);
      if (bestOpt >= 0) S.ttMove.set(posKey, bestOpt);
      return best;
    }

    /* office.py _eval_combo: 울타리 묶음을 순서대로 다 뒀을 때의 (상대증가 - 내증가) + detour - vuln 증가분. 불법이면 null */
    evalCombo(ctx, fences, od, md, baseVuln) {
      const me = this.side, op = 1 - me, P = this.P;
      if (fences.length > ctx.myF) return null;
      let t = ctx.rootT, cntMe = ctx.myF, cntOp = ctx.opF;
      for (let i = 0; i < fences.length; i++) {          // 엔진 simulate 체인 흉내: 내 벽 수 assert, 차례 번갈아 소비, 겹침, 경로 차단
        const f = fences[i];
        if (cntMe <= 0 || !hasBit(t.available, f) || (i % 2 === 0 ? cntMe : cntOp) <= 0) { this.comboIllegalTotal++; return null; }
        if (i % 2 === 0) cntMe--; else cntOp--;
        t = this.topoChild(t, f);
        if (t.dist[0][ctx.p0] === 99 || t.dist[1][ctx.p1] === 99) { this.comboIllegalTotal++; return null; }
      }
      const op2 = shortestE(t.adj, op, ctx.opPos, ctx.p0, ctx.p1), me2 = shortestE(t.adj, me, ctx.mePos, ctx.p0, ctx.p1);
      const gain = (op2 - od) - (me2 - md);
      const opPath2 = shortestPathE(t.adj, op, ctx.opPos, ctx.p0, ctx.p1);
      let edgeClose = 0; for (const q of opPath2) { const c2 = q % 9; edgeClose += Math.min(c2, 8 - c2); }
      const detour = 4 - edgeClose / Math.max(opPath2.length, 1);
      if (baseVuln === undefined) baseVuln = pathVulnE(ctx.rootT.adj, me, ctx.mePos, ctx.p0, ctx.p1);
      const vulnDelta = pathVulnE(t.adj, me, ctx.mePos, ctx.p0, ctx.p1) - baseVuln;
      return gain + P.detour_bonus * detour - Math.abs(P.path_vuln) * vulnDelta;
    }

    /* office.py _plan_combo: raw 안의 2장 조합 전부 → 최고 2장에 한 장을 탐욕 확장(첫 개선에서 멈춤) */
    planCombo(ctx, raw, od, md) {
      const baseVuln = pathVulnE(ctx.rootT.adj, this.side, ctx.mePos, ctx.p0, ctx.p1);
      let bestPair = null, bestPairV = -1e9, i = 0;
      outer: for (let a = 0; a < raw.length; a++) {
        for (let b = a + 1; b < raw.length; b++, i++) {
          if (i % 8 === 0 && !this.timeLeft()) break outer;
          const v = this.evalCombo(ctx, [raw[a], raw[b]], od, md, baseVuln);
          if (v !== null && v > bestPairV) { bestPair = [raw[a], raw[b]]; bestPairV = v; }
        }
      }
      if (bestPair === null) return null;
      let bestFences = bestPair, bestV = bestPairV;
      for (const extra of raw) {
        if (!this.timeLeft()) break;
        if (bestFences.includes(extra)) continue;
        const v = this.evalCombo(ctx, bestFences.concat([extra]), od, md, baseVuln);
        if (v !== null && v > bestV) { bestFences = bestFences.concat([extra]); bestV = v; break; }
      }
      return { fences: bestFences, gain: bestV, madeAt: this.turn, execCount: 0 };
    }

    /* office.py _plan_still_valid: 남은 울타리가 아직 합법(겹침 없음)이고 증가량이 유지되는가 */
    planStillValid(ctx, od, md) {
      if (!this.plan || !this.plan.fences.length) return false;
      if (ctx.myF <= 0) return false;
      for (const f of this.plan.fences) if (!hasBit(ctx.rootT.available, f)) return false;
      const v = this.evalCombo(ctx, this.plan.fences, od, md);
      return v !== null && v >= this.P.combo_min_gain;
    }

    /* office.py candidates(): 루트 후보 행동 코드 목록. Agent 가변 상태(style, 이력, 계획)는 여기서만 바뀝니다 */
    candidates(ctx) {
      const P = this.P, me = this.side, op = 1 - me;
      const { state, rootT, p0, p1, myF, opF, mePos, opPos } = ctx;
      const f = rootT.adj;
      let acts = ctx.legal.slice();
      const md = shortestE(f, me, mePos, p0, p1), od = shortestE(f, op, opPos, p0, p1);
      ctx.md = md; ctx.od = od;

      // 상대가 방금 둔 울타리만 diff 로 골라 가로벽 줄 기록 (row_wall_exception_on 이 꺼져 있어 기록만 남습니다)
      const cur = new Set(state.walls);
      for (const w of cur) if (!this.knownFences.has(w) && w !== this.lastMyBlock && w < 64) addCol(this.opHFenceCols, w >> 3, w & 7);
      this.knownFences = cur;
      this.rowWallGap = null;
      for (const [r, cols] of this.opHFenceCols) if (cols.size >= P.row_wall_trigger) { const open = openCols(cols); if (open.length) this.rowWallGap = [r, open]; }

      if (this.turn <= P.explore_k && opF === FENCES_MAX && myF === FENCES_MAX) return acts;   // ① 탐색 국면: 이동만

      this.opFenceHistory.push(opF < this.prevOpFences ? 1 : 0);
      while (this.opFenceHistory.length > P.style_history_len) this.opFenceHistory.shift();
      this.prevOpFences = opF;
      this.style = this.opFenceHistory.reduce((a, b) => a + b, 0) >= P.style_fence_count ? 'aggressive' : 'defensive';

      const mr = (mePos / 9) | 0, mc = mePos % 9, orr = (opPos / 9) | 0, occ = opPos % 9;
      const wallBuilding = !!P.row_wall_exception_on && this.rowWallGap !== null;
      this.opPawnHistory.push([orr, occ]);
      while (this.opPawnHistory.length > P.lane_rush_window) this.opPawnHistory.shift();
      const laneRushing = laneRushDetected(this.opPawnHistory, P.lane_rush_col_tol, P.lane_rush_min_progress, P.lane_rush_row_tol);

      this.lockedEdgeGap = null;                           // 내 가로벽이 가장자리 틈 1칸만 남긴 줄(구조적으로 더는 못 막음)
      for (const [r, cols] of this.myHFenceCols) { const open = openCols(cols); if (open.length === 1 && (open[0] === 0 || open[0] === 8)) { this.lockedEdgeGap = [r, open[0]]; break; } }
      const closeAndAhead = (Math.abs(mr - orr) + Math.abs(mc - occ) <= 2) && md <= od && !wallBuilding && !laneRushing && this.lockedEdgeGap === null;

      if (myF > 0 && !closeAndAhead && (od <= md + P.fence_when_behind || this.lockedEdgeGap !== null)) {
        const opPath = shortestPathE(f, op, opPos, p0, p1);
        const lo = P.trap_ahead_min;
        let hi = P.trap_ahead_max;
        if (laneRushing || this.lockedEdgeGap !== null) hi += P.lane_rush_extra_ahead;
        let raw = [];                                        // get_applicable_fences 순서: (r,c) 오름차순, 가로 먼저
        for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) for (let kind = 0; kind < 2; kind++) {
          const fence = kind * 64 + r * 8 + c;
          if (hasBit(rootT.available, fence) && fenceAheadOfOp(r, c, opPath, lo, hi)) raw.push(fence);
        }
        if (raw.length > P.max_fence_prescreen) {            // heapq.nsmallest(상대 말과의 거리, 안정)
          raw = raw.map((fence, i) => ({ fence, i, k: Math.abs(((fence & 63) >> 3) - orr) + Math.abs((fence & 7) - occ) }))
            .sort((a, b) => (a.k - b.k) || (a.i - b.i)).slice(0, P.max_fence_prescreen).map(x => x.fence);
        }

        if (this.plan !== null && !this.planStillValid(ctx, od, md)) this.plan = null;
        if (this.plan === null && raw.length >= 2 && this.timeLeft()) {
          const plan = this.planCombo(ctx, raw, od, md);
          if (plan !== null && plan.gain >= P.combo_min_gain) this.plan = plan;
        }

        const scored = [];
        for (const fence of raw) {                           // 2단: 여기서만 자식 그래프 + BFS 3회
          if (!this.timeLeft()) break;
          const child = this.topoChild(rootT, fence);
          if (child.dist[0][p0] === 99 || child.dist[1][p1] === 99) continue;
          const op2 = shortestE(child.adj, op, opPos, p0, p1), me2 = shortestE(child.adj, me, mePos, p0, p1);
          const gain = (op2 - od) - (me2 - md);
          if (gain <= 0) continue;
          const opPath2 = shortestPathE(child.adj, op, opPos, p0, p1);
          let edgeClose = 0; for (const q of opPath2) { const c2 = q % 9; edgeClose += Math.min(c2, 8 - c2); }
          let score = gain + P.detour_bonus * (4 - edgeClose / Math.max(opPath2.length, 1));
          if (P.self_wall_penalty_on && fence < 64) {         // 원본 q10/q12 분기(설치본에서는 발동하지 않음, 머리말 참고)
            const r = fence >> 3, c = fence & 7;
            const hyp = new Set(this.myHFenceCols.get(r) || []); hyp.add(c);
            if (hyp.size >= P.row_wall_trigger) {
              const open = openCols(hyp);
              const reachesLocked = open.length === 1 && (open[0] === 0 || open[0] === 8);
              if (open.length && !reachesLocked) score -= P.self_wall_penalty * open.length;
            }
          }
          scored.push({ score, act: fence + 81, i: scored.length });
        }
        scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));
        const fenceActs = scored.slice(0, P.max_fence_candidates).map(x => x.act);
        acts = fenceActs.concat(acts);                       // q9: 울타리 후보를 이동 앞에

        if (this.plan !== null && this.plan.gain >= P.combo_min_gain && myF >= this.plan.fences.length + P.fence_reserve_min) {
          const hint = this.plan.fences[0] + 81;
          if (!acts.includes(hint)) acts.push(hint);
        }
      }
      return acts;
    }

    /* 한 수 선택 (office.py adversarial_search). state 는 QRules 상태, budget 은 ms.
     * 반환 {action:{type:'move',to}|{type:'fence',f}, stats:{depth,nodes,ms}} */
    choose(state, budget) {
      const started = now();
      this.deadline = started + Math.max(0, budget - Math.min(budget, this.reserve(budget)));
      this.nodes = 0;
      const side = this.side;
      const adj = R.buildAdj(state.walls);
      const p0 = state.pawns[0], p1 = state.pawns[1], f0 = state.fences[0], f1 = state.fences[1];
      const mePos = side === 0 ? p0 : p1, opPos = side === 0 ? p1 : p0;
      const myF = side === 0 ? f0 : f1, opF = side === 0 ? f1 : f0;
      const legal = R.pawnMoves(adj, mePos, opPos);
      if (legal.length === 0) { this.lastStats = { depth: 0, nodes: 0, ms: 0 }; return { action: null, stats: this.lastStats }; }
      for (const dest of legal) {
        if ((side === 0 && dest >= 72) || (side === 1 && dest < 9)) {
          this.turn += 1;
          this.lastStats = { depth: 0, nodes: 0, score: 1e6, ms: now() - started };
          return { action: { type: 'move', to: dest }, stats: this.lastStats };
        }
      }
      this.turn += 1;
      const maskBig = R.maskBig(state.walls);
      const rootT = new Topology(flatAdj(adj), maskBig, R.maskWords(state.walls), R.availableWords(state.walls));
      this.topologies = new Map([[maskBig, rootT]]); this.nextId = 1;
      const ctx = { state, rootT, p0, p1, f0, f1, myF, opF, mePos, opPos, legal };
      const legalSet = new Set(legal);
      const acts = this.candidates(ctx);

      const P = Object.assign({}, this.P);
      if (this.style === 'aggressive') P.path_vuln = P.path_vuln * P.path_vuln_aggr_mult;   // 공격형 상대엔 수비적으로

      // 루트 전개: 후보마다 합법성을 한 번 확인하고 자식 그래프를 세운다 (이동은 루트 그래프 공유)
      const children = [];
      for (const act of acts) {
        if (act < 81) {
          if (!legalSet.has(act)) continue;
          children.push({ act, t: rootT, p0: side === 0 ? act : p0, p1: side === 1 ? act : p1, f0, f1 });
        } else {
          const fence = act - 81;
          if (myF <= 0 || !hasBit(rootT.available, fence)) continue;
          const t = this.topoChild(rootT, fence);
          if (t.dist[0][p0] === 99 || t.dist[1][p1] === 99) continue;
          children.push({ act, t, p0, p1, f0: side === 0 ? f0 - 1 : f0, f1: side === 1 ? f1 - 1 : f1 });
        }
      }

      const S = { P, tt: new Map(), ttMove: new Map(), killers: [], beamWidth: P.beam_width, fenceScanCap: P.fence_scan_cap };
      const opSide = 1 - side;
      let bestOverall = -1, completedDepth = 0, score = 0;
      const depth1Scored = [];
      for (let depth = 1; depth <= P.max_search_depth; depth++) {
        try {
          const ordered = bestOverall < 0 ? children : children.filter(c => c.act === bestOverall).concat(children.filter(c => c.act !== bestOverall));
          let alpha = -1e9, iterBest = -1, iterBestV = -1e9;
          for (const rc of ordered) {
            this.nodes++;
            if (this.nodes % 32 === 0) this.check();
            let v;
            if (depth === 1) { v = this.evaluateTopo(rc.t, rc.p0, rc.p1, rc.f0, rc.f1, P); depth1Scored.push({ v, act: rc.act }); }
            else v = -this.negamax(rc.t, rc.p0, rc.p1, rc.f0, rc.f1, opSide, depth - 1, -1e9, -alpha, S);
            if (v > iterBestV) { iterBestV = v; iterBest = rc.act; }
            if (v > alpha) alpha = v;
          }
          if (iterBest >= 0) { bestOverall = iterBest; score = iterBestV; completedDepth = depth; }
        } catch (e) { if (e !== TIME_UP) throw e; break; }
      }
      this.depthReachedTotal += completedDepth; this.movesSearched += 1;

      // 반환 직전 규칙 재검증. 깨지면 깊이 1 순위로 차선책, 그것도 없으면 첫 합법 이동
      const rootLegal = act => act < 81 ? legalSet.has(act) : (myF > 0 && R.fenceCheck(state, act - 81) === null);
      let best = bestOverall >= 0 && rootLegal(bestOverall) ? bestOverall : -1;
      if (best < 0) {
        depth1Scored.sort((a, b) => b.v - a.v);
        for (const { act } of depth1Scored) if (rootLegal(act)) { best = act; break; }
      }
      if (best < 0) best = legal[0];

      this.lastMyBlock = best >= 81 ? best - 81 : -1;
      if (best >= 81 && best - 81 < 64) addCol(this.myHFenceCols, (best - 81) >> 3, (best - 81) & 7);
      if (best >= 81 && this.plan !== null && this.plan.fences.length && this.plan.fences[0] === best - 81) {
        this.plan.fences = this.plan.fences.slice(1);
        this.plan.execCount += 1; this.planExecTotal += 1;
        if (!this.plan.fences.length) this.plan = null;
      }
      this.lastStats = { depth: completedDepth, nodes: this.nodes, topologies: this.topologies.size, score, style: this.style, ms: now() - started };
      this.topologies = null;
      const action = best >= 81 ? { type: 'fence', f: best - 81 } : { type: 'move', to: best };
      return { action, stats: this.lastStats };
    }
  }

  root.QAgentClaude = QAgentClaude;

  /* Worker 모드 (agents/codex.js 와 같은 메시지 규약) */
  if (typeof importScripts === 'function' && typeof root.postMessage === 'function') {
    let agent = null;
    root.onmessage = e => {
      const m = e.data || {};
      if (m.type === 'reset') { agent = new QAgentClaude(m.side); root.postMessage({ type: 'ready' }); return; }
      if (m.type !== 'think') return;
      if (agent === null || agent.side !== m.side) agent = new QAgentClaude(m.side);
      try {
        const res = agent.choose(m.state, m.budget);
        root.postMessage({ type: 'move', id: m.id, action: res.action, stats: res.stats });
      } catch (err) {
        root.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
      }
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
