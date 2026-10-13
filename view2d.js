/* 2D SVG 판 렌더러. ui.js 가 만드는 view 객체를 그리고, 입력은 handlers 로 돌려줍니다.
 * 렌더러 인터페이스(view3d.js 도 같은 모양):
 *   render(view)        view = { state, humanSide, agentSide, legalMoves, fenceMode, orient, wallOwner, turnSide, thinking, over, agentName, reset }
 *   showGhost(f, ok)    울타리 id f 를 미리보기(ok 면 초록, 아니면 빨강)
 *   clearGhost()
 *   focus()             사람이 둔 뒤 포커스를 판으로
 *   setActive(on)       보이기/숨기기(3D 는 렌더 루프 정지)
 * handlers: onMove(p), onFenceEnter(r, c), onFenceLeave(), onFenceTap(r, c, event) */
(function (root) {
  'use strict';
  const R = root.QRules;
  const CELL = 40, GAP = 10, PAD = 8, STEP = CELL + GAP;
  const NS = 'http://www.w3.org/2000/svg';

  function create(svg, handlers) {
    const layers = {};
    for (const k of ['cells', 'walls', 'moves', 'pawns', 'ghost', 'fences']) layers[k] = svg.querySelector('#layer-' + k);
    let humanSide = 0, cellsFor = -1;
    const yIdx = r => humanSide === 0 ? 8 - r : r;          // 사람이 항상 아래
    const sx = c => PAD + c * STEP;
    const sy = r => PAD + yIdx(r) * STEP;
    const ix = c => sx(c) + CELL + GAP / 2;                  // 교차점 (r,c) 의 화면 중심
    const iy = r => Math.min(sy(r), sy(r + 1)) + CELL + GAP / 2;
    const humanRow = r => (humanSide === 0 ? r + 1 : 9 - r);  // 사람 기준 "아래에서 n번째 줄"
    const el = (tag, attrs, cls) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); if (cls) n.setAttribute('class', cls); return n; };

    function drawCells(agentSide) {
      layers.cells.textContent = '';
      for (let r = 0; r < 9; r++) for (let c = 0; c < 9; c++) {
        const goalH = (humanSide === 0 && r === 8) || (humanSide === 1 && r === 0);
        const goalA = (agentSide === 0 && r === 8) || (agentSide === 1 && r === 0);
        layers.cells.appendChild(el('rect', { x: sx(c), y: sy(r), width: CELL, height: CELL, rx: 6 }, 'cell' + (goalH ? ' goal-human' : goalA ? ' goal-agent' : '')));
      }
    }
    function wallRect(f, cls) {
      const { r, c, orient: o } = R.fenceRC(f);
      const t = GAP * 0.64;
      return o === 'h'
        ? el('rect', { x: sx(c), y: iy(r) - t / 2, width: 2 * CELL + GAP, height: t }, cls)
        : el('rect', { x: ix(c) - t / 2, y: Math.min(sy(r), sy(r + 1)), width: t, height: 2 * CELL + GAP }, cls);
    }

    function render(view) {
      const { state, orient } = view;
      humanSide = view.humanSide;
      if (cellsFor !== humanSide) { drawCells(view.agentSide); cellsFor = humanSide; }
      // 벽
      layers.walls.textContent = '';
      state.walls.forEach((f, i) => {
        layers.walls.appendChild(wallRect(f, 'wall ' + (view.wallOwner[i] === humanSide ? 'human' : 'agent')));
      });
      // 말
      layers.pawns.textContent = '';
      for (let s = 0; s < 2; s++) {
        const p = state.pawns[s], r = (p / 9) | 0, c = p % 9;
        layers.pawns.appendChild(el('circle', { cx: sx(c) + CELL / 2, cy: sy(r) + CELL / 2, r: 14 }, 'pawn ' + (s === humanSide ? 'human' : 'agent')));
      }
      // 이동 후보
      layers.moves.textContent = '';
      for (const p of view.legalMoves) {
        const r = (p / 9) | 0, c = p % 9;
        const g = el('g', { tabindex: 0, role: 'button', 'aria-label': `아래에서 ${humanRow(r)}번째 줄, 왼쪽에서 ${c + 1}번째 칸으로 이동` }, 'move');
        g.appendChild(el('rect', { x: sx(c), y: sy(r), width: CELL, height: CELL }));
        g.appendChild(el('circle', { cx: sx(c) + CELL / 2, cy: sy(r) + CELL / 2, r: 5 }));
        g.addEventListener('click', () => handlers.onMove(p));
        g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlers.onMove(p); } });
        layers.moves.appendChild(g);
      }
      // 울타리 히트 영역
      layers.fences.textContent = '';
      if (view.fenceMode) {
        for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
          layers.fences.appendChild(el('circle', { cx: ix(c), cy: iy(r), r: 2.2 }, 'mark'));
        }
        for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
          const hit = el('rect', { x: ix(c) - STEP / 2, y: iy(r) - STEP / 2, width: STEP, height: STEP, tabindex: 0, role: 'button', 'aria-label': `${orient === 'h' ? '가로' : '세로'} 벽, 아래에서 ${humanRow(r)}번째 줄과 ${humanRow(r + 1)}번째 줄 사이, 왼쪽에서 ${c + 1}번째 칸 옆` }, 'fence-hit');
          hit.dataset.r = r; hit.dataset.c = c;
          hit.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') handlers.onFenceEnter(r, c); });
          hit.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') handlers.onFenceLeave(); });
          hit.addEventListener('focus', () => handlers.onFenceEnter(r, c));
          hit.addEventListener('blur', () => handlers.onFenceLeave());
          hit.addEventListener('click', e => handlers.onFenceTap(r, c, e));
          hit.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlers.onFenceTap(r, c, null); } });
          layers.fences.appendChild(hit);
        }
      } else clearGhost();
    }
    function clearGhost() { layers.ghost.textContent = ''; }
    function showGhost(f, ok) { clearGhost(); layers.ghost.appendChild(wallRect(f, 'ghost ' + (ok ? 'ok' : 'bad'))); }
    function focus() { svg.focus({ preventScroll: true }); }
    function setActive(on) { if (on) svg.removeAttribute('hidden'); else svg.setAttribute('hidden', ''); }

    return { render, showGhost, clearGhost, focus, setActive, el: svg };
  }

  root.QView2D = create;
})(typeof globalThis !== 'undefined' ? globalThis : self);
