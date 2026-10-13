/* Quoridor Agents 판 UI. 사람은 아래에서 시작합니다. 규칙은 rules.js, 상대는 agents/<이름>.js 를 Web Worker 로 띄웁니다.
 * 판 그리기는 렌더러에 맡깁니다. view2d.js(SVG)와 view3d.js(Three.js 복셀)가 같은 인터페이스(render, showGhost, clearGhost, focus, setActive)를 구현합니다.
 * 폭 720px 이상이고 WebGL 이 되면 3D 가 기본, 아니면 2D 입니다. "3D 보기" 버튼으로 바꿉니다.
 * 에이전트 메시지 규약: {type:'think', id, side, state, budget} → {type:'move', id, action, stats}; {type:'reset', side} → {type:'ready'}.
 * Worker 를 만들 수 없으면(file:// 등) 같은 파일을 메인 스레드에 올려 globalThis.QAgent 로 두고, 그것도 없으면 최단 경로로 한 칸 전진합니다.
 * 부모 페이지 계약(iframe): postMessage {type:'portfolio:visible', visible:false} 를 받으면 진행 중 탐색은 두되 새 탐색을 시작하지 않습니다. */
(function () {
  'use strict';
  const R = window.QRules;
  const $ = s => document.querySelector(s);
  const boardEl = $('#board'), statusEl = $('#status'), statsEl = $('#stats'), srEl = $('#sr-state');
  const wrap3d = $('#board3d-wrap'), canvas3d = $('#board3d'), badge3d = $('#think3d'), viewBtn = $('#view-toggle');
  const bannerEl = $('#banner'), bannerText = $('#banner-text'), bannerRestart = $('#banner-restart');
  const fenceBtn = $('#fence-toggle'), orientBtn = $('#orient-toggle'), restartBtn = $('#restart');
  const firstSel = $('#first'), budgetSel = $('#budget'), agentBtns = Array.from(document.querySelectorAll('.seg-btn[data-agent]'));
  const wallsHuman = $('#walls-human'), wallsAgent = $('#walls-agent'), agentNameEl = $('#agent-name');
  const whoHuman = $('.who-human'), whoAgent = $('.who-agent');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const coarse = matchMedia('(pointer: coarse)').matches;
  const MIN_WAIT = 250;                                                               // 에이전트 응답 최소 표시 시간
  const MAX_TURNS = 300;                                                              // 아레나 서버 규칙: 300수 무승부

  /* ---------- 에이전트 목록 ---------- */
  const AGENTS = {
    codex: { name: 'Codex', by: 'GPT 작성' },
    claude: { name: 'Claude', by: 'Agent Office 작성' }
  };
  let agentKey = 'codex';
  let budget = Number(budgetSel.value) || 400;                                        // 수당 예산 ms
  const agentName = () => AGENTS[agentKey].name;

  let state, humanSide = 0, agentSide = 1;
  let mode = 'move', orient = 'h', armed = -1;      // armed: 터치 첫 탭으로 미리보기 중인 울타리
  let thinking = false, over = false, visible = true, pendingThink = false;
  let reqId = 0, thinkTimer = null, thinkStart = 0;
  let cachedMoves = null, cachedAvail = null, cachedAdj = null;

  /* ---------- 에이전트 실행 (Worker, 실패 시 메인 스레드) ---------- */
  let worker = null, workerKey = null;
  const broken = new Set();            // Worker 를 띄우지 못한 에이전트 이름
  const waiting = new Map();           // id → resolve
  const mainCtor = new Map();          // 이름 → Promise<생성자|null> (메인 스레드 폴백)
  let mainAgent = null, mainAgentKey = null;

  function dropWorker() {
    if (worker) { try { worker.terminate(); } catch (e) { } }
    worker = null; workerKey = null;
    for (const [, res] of waiting) res(null);
    waiting.clear();
  }
  function makeWorker() {
    if (broken.has(agentKey) || typeof Worker === 'undefined') return null;
    try {
      const key = agentKey;
      const w = new Worker('agents/' + key + '.js');
      w.onmessage = e => {
        const m = e.data || {};
        if (m.type === 'move' && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
        else if (m.type === 'error' && waiting.has(m.id)) { waiting.get(m.id)(null); waiting.delete(m.id); }
      };
      w.onerror = () => { broken.add(key); if (worker === w) dropWorker(); else { try { w.terminate(); } catch (e) { } } };
      workerKey = key;
      return w;
    } catch (e) { broken.add(agentKey); return null; }
  }
  function think(s, side, ms) {
    const id = ++reqId;
    if (worker && workerKey !== agentKey) dropWorker();
    if (!worker) worker = makeWorker();
    if (worker) {
      return new Promise(resolve => {
        waiting.set(id, resolve);
        worker.postMessage({ type: 'think', id, side, state: s, budget: ms });
      }).then(res => res && res.id === id ? res : (broken.has(agentKey) ? thinkMain(s, side, ms, id) : null));
    }
    return thinkMain(s, side, ms, id);
  }
  function loadMainCtor(key) {
    if (mainCtor.has(key)) return mainCtor.get(key);
    const p = new Promise(resolve => {
      const before = window.QAgent;
      const sc = document.createElement('script');
      sc.src = 'agents/' + key + '.js';
      sc.onload = () => { const c = key === 'claude' ? window.QAgentClaude : window.QAgent; resolve(typeof c === 'function' && (c !== before || key !== 'codex') ? c : null); };
      sc.onerror = () => resolve(null);
      document.head.appendChild(sc);
    });
    mainCtor.set(key, p);
    return p;
  }
  function greedy(s, side) {
    const adj = R.buildAdj(s.walls), d = R.distances(adj, side), moves = R.legalMoves(s, adj);
    if (!moves.length) return null;
    let best = moves[0];
    for (const m of moves) if (d[m] < d[best]) best = m;
    return { type: 'move', to: best };
  }
  function thinkMain(s, side, ms, id) {
    const key = agentKey;
    return loadMainCtor(key).then(Ctor => new Promise(resolve => setTimeout(() => {
      if (Ctor) {
        if (!mainAgent || mainAgentKey !== key || mainAgent.side !== side) { mainAgent = new Ctor(side); mainAgentKey = key; }
        try { const r = mainAgent.choose(s, ms); resolve({ id, action: r.action, stats: r.stats }); return; }
        catch (e) { }
      }
      const t0 = performance.now();
      resolve({ id, action: greedy(s, side), stats: { depth: 'greedy', ms: performance.now() - t0 } });
    }, 0)));
  }
  function resetAgent() {
    reqId++;                       // 늦게 오는 응답은 버린다
    waiting.clear();
    if (worker && workerKey !== agentKey) dropWorker();
    if (worker) worker.postMessage({ type: 'reset', side: agentSide });
    mainAgent = null; mainAgentKey = null;
  }

  /* ---------- 에이전트 파일 확인 (없으면 "준비 중") ---------- */
  function markAgent(key, ok) {
    const btn = agentBtns.find(b => b.dataset.agent === key);
    if (!btn) return;
    btn.disabled = !ok;
    btn.lastElementChild.textContent = ok ? AGENTS[key].by : '준비 중';
    btn.title = ok ? '' : '아직 올라오지 않은 에이전트입니다.';
  }
  function probeAgent(key) {
    if (typeof fetch !== 'function') return Promise.resolve(false);
    return fetch('agents/' + key + '.js', { method: 'HEAD', cache: 'no-store' }).then(r => r.ok).catch(() => false);
  }
  probeAgent('claude').then(ok => markAgent('claude', ok));
  markAgent('codex', true);

  /* ---------- 렌더러 (2D SVG, 3D 복셀) ---------- */
  const humanRow = r => (humanSide === 0 ? r + 1 : 9 - r);  // 사람 기준 "아래에서 n번째 줄"
  const handlers = {
    onMove: p => humanMove(p),
    onFenceEnter: (r, c) => preview(r, c),
    onFenceLeave: () => { if (armed < 0) clearGhost(); },
    onFenceTap: (r, c, e) => tapFence(r, c, e)
  };
  const view2d = window.QView2D(boardEl, handlers);
  let view3d = null, active = view2d, can3d = null, resetView = true;   // can3d: null 아직 모름, false 불가
  function webglOk() {
    try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
  }
  if (!wrap3d || !canvas3d || !webglOk()) can3d = false;
  function load3d() {
    if (view3d) return Promise.resolve(view3d);
    if (can3d === false) return Promise.resolve(null);
    let imp;
    try { imp = new Function('u', 'return import(u)'); } catch (e) { can3d = false; return Promise.resolve(null); }
    return imp('./view3d.js?v=3')
      .then(m => { view3d = m.createView3D(canvas3d, handlers, { reduceMotion: () => reduceMotion.matches, badge: badge3d }); if (!view3d) can3d = false; else can3d = true; return view3d; })
      .catch(() => { can3d = false; return null; });
  }
  const show = (el, on) => { if (!el) return; if (on) el.removeAttribute('hidden'); else el.setAttribute('hidden', ''); };   // SVG 에는 hidden 프로퍼티가 없다
  function useView(v) {
    if (active !== v) { active.setActive(false); active = v; resetView = true; active.setActive(true); }
    show(boardEl, v === view2d);
    show(wrap3d, v !== view2d);
    if (viewBtn) { viewBtn.hidden = can3d === false; viewBtn.setAttribute('aria-pressed', String(v === view3d)); }
    if (state) render();
  }
  function setView3d(on) {
    if (!on) { useView(view2d); return; }
    if (wrap3d) { show(wrap3d, true); show(boardEl, false); }         // 불러오는 동안 2D 가 잠깐 보이지 않게
    load3d().then(v => { if (v) useView(v); else useView(view2d); });
  }
  function render() {
    const side = R.sideToMove(state);
    cachedAdj = R.buildAdj(state.walls);
    cachedMoves = R.legalMoves(state, cachedAdj);
    cachedAvail = R.availableWords(state.walls);
    const canAct = !over && !thinking && side === humanSide;
    active.render({
      state, humanSide, agentSide,
      legalMoves: canAct && mode === 'move' ? cachedMoves : [],
      fenceMode: canAct && mode === 'fence',
      orient, wallOwner,
      turnSide: over ? -1 : side,
      thinking, over, agentName: agentName(),
      reset: resetView
    });
    resetView = false;
    if (!(canAct && mode === 'fence')) clearGhost();
    // 점수판, 버튼
    agentNameEl.textContent = agentName();
    wallsHuman.textContent = `벽 ${state.fences[humanSide]}`;
    wallsAgent.textContent = `벽 ${state.fences[agentSide]}`;
    whoHuman.classList.toggle('is-turn', !over && side === humanSide);
    whoAgent.classList.toggle('is-turn', !over && side === agentSide);
    fenceBtn.setAttribute('aria-pressed', String(mode === 'fence'));
    fenceBtn.disabled = over || state.fences[humanSide] === 0;
    orientBtn.disabled = mode !== 'fence';
    orientBtn.setAttribute('aria-pressed', String(orient === 'v'));
    orientBtn.firstChild.textContent = (orient === 'h' ? '가로 ' : '세로 ');
    // 스크린리더용 상태
    const hp = state.pawns[humanSide], ap = state.pawns[agentSide];
    srEl.textContent = `내 말은 아래에서 ${humanRow((hp / 9) | 0)}번째 줄, 왼쪽에서 ${hp % 9 + 1}번째 칸. ${agentName()} 말은 아래에서 ${humanRow((ap / 9) | 0)}번째 줄, 왼쪽에서 ${ap % 9 + 1}번째 칸. 벽은 ${state.walls.length}개 놓였습니다.`;
  }
  function clearGhost() { active.clearGhost(); }
  function preview(r, c) {
    const f = R.fenceId(r, c, orient);
    const why = R.fenceCheck(state, f, cachedAvail, cachedAdj);
    active.showGhost(f, !why);
    if (why) setStatus(reasonText(why)); else if (armed === f) setStatus('같은 자리를 한 번 더 누르면 벽을 놓습니다.'); else setStatus(mode === 'fence' ? fenceHint() : '');
    return why;
  }
  const reasonText = why => why === 'blocks' ? '그 자리는 경로를 완전히 막아서 놓을 수 없습니다.' : why === 'overlap' ? '다른 벽과 겹치는 자리입니다.' : why === 'none-left' ? '남은 벽이 없습니다.' : '놓을 수 없는 자리입니다.';
  const fenceHint = () => `벽을 놓을 자리를 누르세요. 지금은 ${orient === 'h' ? '가로' : '세로'} 벽입니다.${coarse ? ' 첫 번째 누름은 미리보기, 두 번째 누름이 설치입니다.' : ''}`;
  const moveHint = () => '당신 차례입니다. 밝게 표시된 칸을 누르면 이동합니다.';

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
  }

  /* ---------- 사람 입력 ---------- */
  function tapFence(r, c, e) {
    const f = R.fenceId(r, c, orient);
    const touch = e && (e.pointerType === 'touch' || e.pointerType === 'pen');
    if (touch && armed !== f) { armed = f; const why = preview(r, c); if (why) armed = -1; return; }
    placeFence(f);
  }
  function placeFence(f) {
    if (over || thinking || R.sideToMove(state) !== humanSide) return;
    const why = R.fenceCheck(state, f, cachedAvail, cachedAdj);
    if (why) { setStatus(reasonText(why)); armed = -1; return; }
    armed = -1;
    wallOwner.push(humanSide);
    state = R.apply(state, { type: 'fence', f });
    mode = 'move';
    afterHuman();
  }
  function humanMove(p) {
    if (over || thinking || R.sideToMove(state) !== humanSide) return;
    if (!cachedMoves.includes(p)) return;
    state = R.apply(state, { type: 'move', to: p });
    afterHuman();
  }
  function afterHuman() {
    render();
    active.focus();
    if (!checkEnd()) requestAgent();
  }
  function toggleFence() {
    if (over || thinking || state.fences[humanSide] === 0) return;
    mode = mode === 'fence' ? 'move' : 'fence'; armed = -1;
    render();
    setStatus(mode === 'fence' ? fenceHint() : moveHint());
  }
  function toggleOrient() {
    if (mode !== 'fence') return;
    orient = orient === 'h' ? 'v' : 'h'; armed = -1;
    render();
    setStatus(fenceHint());
  }

  /* ---------- 에이전트 차례 ---------- */
  function requestAgent() {
    if (over || R.sideToMove(state) !== agentSide) return;
    if (!visible) { pendingThink = true; setStatus(`화면에 보이면 ${agentName()} 가 둡니다.`); return; }
    pendingThink = false;
    // 둘 수 있는 수가 없으면 차례를 넘긴다(극히 드문 경우)
    if (R.legalMoves(state).length === 0 && R.legalFences(state).length === 0) { state.turn += 1; render(); setStatus(`${agentName()} 가 둘 수 있는 수가 없어 차례를 넘깁니다. ` + moveHint()); return; }
    thinking = true; thinkStart = performance.now();
    render();
    startThinkDisplay();
    const snapshot = R.clone(state), myReq = reqId + 1;
    think(snapshot, agentSide, budget).then(res => {
      if (myReq !== reqId || !thinking) return;      // 다시 시작으로 무효화된 응답
      const elapsed = performance.now() - thinkStart;
      const apply = () => applyAgent(res);
      if (elapsed < MIN_WAIT) setTimeout(apply, MIN_WAIT - elapsed); else apply();
    });
  }
  function statsText(st) {
    const parts = [];
    if (typeof st.depth === 'number') parts.push(`깊이 ${st.depth}`);
    else if (st.depth === 'exact race') parts.push('정확 역행 분석');
    else if (st.depth === 'greedy') parts.push('단순 전진(워커 없음)');
    else if (typeof st.depth === 'string') parts.push(st.depth);
    if (typeof st.nodes === 'number' && st.nodes > 0) parts.push(`노드 ${st.nodes.toLocaleString('ko-KR')}`);
    if (typeof st.ms === 'number') parts.push(`${Math.round(st.ms)}ms`);
    return parts.length ? `${agentName()}: ${parts.join(', ')}` : '';
  }
  function applyAgent(res) {
    stopThinkDisplay();
    thinking = false;
    let action = res && res.action;
    if (!action) {                                   // 워커 오류나 수 없음: 첫 합법 이동 또는 차례 넘김
      const moves = R.legalMoves(state);
      action = moves.length ? { type: 'move', to: moves[0] } : null;
    }
    if (action) {
      if (action.type === 'fence') wallOwner.push(agentSide);
      try { state = R.apply(state, action); }
      catch (e) { const moves = R.legalMoves(state); if (moves.length) { if (action.type === 'fence') wallOwner.pop(); state = R.apply(state, { type: 'move', to: moves[0] }); action = { type: 'move' }; } }
    } else state.turn += 1;
    render();
    statsEl.textContent = res && res.stats && typeof res.stats === 'object' ? statsText(res.stats) : '';
    if (checkEnd()) return;
    setStatus((action && action.type === 'fence' ? `${agentName()} 가 벽을 놓았습니다. ` : `${agentName()} 가 이동했습니다. `) + moveHint());
  }
  function startThinkDisplay() {
    const dots = reduceMotion.matches ? '' : '<span class="dots" aria-hidden="true"><span></span><span></span><span></span></span>';
    const name = agentName();
    const tick = () => {
      const ms = Math.round(performance.now() - thinkStart);
      statusEl.innerHTML = `${name} 가 생각하고 있습니다 ${dots} <span class="elapsed">${ms}ms</span>`;
    };
    statusEl.className = 'status is-thinking';
    tick();
    thinkTimer = setInterval(tick, reduceMotion.matches ? 250 : 80);
  }
  function stopThinkDisplay() { if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = null; } }

  /* ---------- 승패, 시작 ---------- */
  function checkEnd() {
    const w = R.winner(state);
    if (w < 0 && state.turn < MAX_TURNS) return false;
    over = true; mode = 'move'; armed = -1;
    render();
    const text = w < 0 ? `${MAX_TURNS}수가 지나 무승부입니다.` : w === humanSide ? `이겼습니다. ${agentName()} 의 길을 잘 막았습니다.` : '졌습니다. 다시 시작해서 다른 수를 시도해 보세요.';
    setStatus(text);
    bannerText.textContent = w < 0 ? '무승부' : w === humanSide ? '이겼습니다' : '졌습니다';
    bannerEl.hidden = false;
    bannerRestart.focus({ preventScroll: true });
    return true;
  }
  let wallOwner = [];
  function start() {
    stopThinkDisplay();
    humanSide = Number(firstSel.value) === 1 ? 1 : 0;   // 선공은 white(0)
    agentSide = 1 - humanSide;
    state = R.initial(); wallOwner = [];
    mode = 'move'; orient = 'h'; armed = -1; thinking = false; over = false; pendingThink = false;
    bannerEl.hidden = true; statsEl.textContent = '';
    resetAgent();
    resetView = true;
    render();
    setStatus(humanSide === 0 ? moveHint() : `${agentName()} 가 먼저 둡니다.`);
    requestAgent();
  }
  function pickAgent(key) {
    if (!AGENTS[key] || key === agentKey) return;
    agentKey = key;
    for (const b of agentBtns) b.setAttribute('aria-pressed', String(b.dataset.agent === key));
    start();
  }

  /* ---------- 이벤트 ---------- */
  fenceBtn.addEventListener('click', toggleFence);
  orientBtn.addEventListener('click', toggleOrient);
  restartBtn.addEventListener('click', start);
  bannerRestart.addEventListener('click', start);
  if (viewBtn) viewBtn.addEventListener('click', () => setView3d(active !== view3d));
  firstSel.addEventListener('change', () => { if (state.turn === 0 && !thinking) start(); });
  budgetSel.addEventListener('change', () => { budget = Number(budgetSel.value) || 400; });
  for (const b of agentBtns) b.addEventListener('click', () => pickAgent(b.dataset.agent));
  document.addEventListener('keydown', e => {
    if (e.target && (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT')) return;
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFence(); }
    else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); toggleOrient(); }
    else if (e.key === 'Escape' && mode === 'fence') { e.preventDefault(); mode = 'move'; armed = -1; render(); setStatus(moveHint()); }
  });
  window.addEventListener('message', e => {
    const m = e.data;
    if (!m || m.type !== 'portfolio:visible') return;
    visible = !!m.visible;
    if (visible && pendingThink) requestAgent();
  });

  const wide = matchMedia('(min-width: 720px)').matches;   // 데스크톱(720px 이상, 마우스)은 3D 가 기본, 그 외는 2D. 버튼은 WebGL 이 되면 항상 보인다
  start();
  if (can3d !== false && wide && !coarse) setView3d(true); else useView(view2d);
})();
