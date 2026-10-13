/* 3D 복셀 판 렌더러. quoridor-arena 관전 클라이언트(app.js)의 지오메트리, 색, 카메라 각도, 조명을 그대로 옮겼습니다.
 * view2d.js 와 같은 인터페이스: render(view), showGhost(f, ok), clearGhost(), focus(), setActive(on).
 * 세계 좌표: x = 열, z = 화면 줄(0 이 먼 쪽, 8 이 카메라 쪽). 사람 말은 항상 카메라 쪽(아래)에 둡니다.
 * 카메라는 고정입니다(드래그 회전 없음). prefers-reduced-motion 이면 말 이동, 울타리 낙하를 보간하지 않고 바로 놓습니다. */
import * as THREE from './vendor/three.module.js';

export function createView3D(canvas, handlers, opts) {
  const R = globalThis.QRules;
  const N = 9, V = 0.1, T = 0.1;            // V: 말, 울타리 복셀 크기. T: 타일 복셀 크기
  const reduceMotion = () => !!(opts && opts.reduceMotion && opts.reduceMotion());
  const badge = opts && opts.badge;

  // ── 렌더러, 장면: 평평한 색면 + 강한 그림자 + 낮은 FOV
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
  } catch (e) { return null; }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.BasicShadowMap;
  const scene = new THREE.Scene(); scene.background = null;   // CSS 배경이 비친다
  scene.fog = new THREE.Fog(0x0e1322, 22, 40);
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 100);
  const orbit = { theta: Math.PI * 0.5, phi: 0.9, r: 21, target: new THREE.Vector3(4, 0.2, 4.3) };   // 각도는 원본(θ π/2, φ 0.9), 거리와 타깃만 캔버스 크기에 맞춤
  function placeCamera() {
    const { theta, phi, r, target } = orbit;
    camera.position.set(target.x + r * Math.sin(phi) * Math.cos(theta), target.y + r * Math.cos(phi), target.z + r * Math.sin(phi) * Math.sin(theta));
    camera.lookAt(target);
  }
  scene.add(new THREE.HemisphereLight(0xdde6ff, 0x3a2a1a, 1.25));
  const key = new THREE.DirectionalLight(0xfff0d8, 2.4); key.position.set(7, 14, 3); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048); key.shadow.camera.left = -9; key.shadow.camera.right = 9; key.shadow.camera.top = 9; key.shadow.camera.bottom = -9; key.shadow.bias = -0.0008;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x4fd1c5, 0.35); rim.position.set(-6, 6, -8); scene.add(rim);

  // ── 복셀 도구: 같은 색 상자를 한 InstancedMesh 로
  const unit = new THREE.BoxGeometry(1, 1, 1);
  const matCache = new Map();
  function mat(hex) { if (!matCache.has(hex)) matCache.set(hex, new THREE.MeshLambertMaterial({ color: hex })); return matCache.get(hex); }
  function voxels(list, size, origin = [0, 0, 0]) {
    const byColor = new Map();
    for (const [x, y, z, hex] of list) { if (!byColor.has(hex)) byColor.set(hex, []); byColor.get(hex).push([x, y, z]); }
    const g = new THREE.Group(); const m4 = new THREE.Matrix4();
    for (const [hex, pts] of byColor) {
      const im = new THREE.InstancedMesh(unit, mat(hex), pts.length);
      pts.forEach(([x, y, z], i) => { m4.makeScale(size, size, size); m4.setPosition(origin[0] + (x + 0.5) * size, origin[1] + (y + 0.5) * size, origin[2] + (z + 0.5) * size); im.setMatrixAt(i, m4); });
      im.castShadow = true; im.receiveShadow = true; g.add(im);
    }
    return g;
  }
  function disposeGroup(g) { g.traverse(o => { if (o.isInstancedMesh) o.dispose(); }); }
  function model(layers, palette) {
    const out = [];
    layers.forEach((rows, y) => { rows.forEach((row, zi) => { [...row].forEach((ch, xi) => { if (ch !== '.' && palette[ch]) out.push([xi, y, zi, palette[ch]]); }); }); });
    return out;
  }

  // ── 판: 복셀 타일(8×8 복셀, 높이 2) + 홈 + 테두리. 화면 줄 8(카메라 쪽)은 황토, 줄 0(먼 쪽)은 청록
  const board = new THREE.Group(); scene.add(board);
  const tileList = [], frameList = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const goal = r === 8 ? 0x6b5a3a : r === 0 ? 0x3a5a5c : ((r + c) % 2 ? 0x2c3342 : 0x323a4b);
    const edge = r === 8 ? 0x4e4129 : r === 0 ? 0x2a4244 : 0x222836;
    for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) {
      const isEdge = x === 0 || z === 0 || x === 7 || z === 7;
      tileList.push([c * 10 + x + 1, 0, r * 10 + z + 1, isEdge ? edge : goal]);
      tileList.push([c * 10 + x + 1, -1, r * 10 + z + 1, 0x1a1f2a]);
    }
  }
  for (let x = 0; x < N * 10; x++) for (let z = 0; z < N * 10; z++) {
    const inTileX = (x % 10) >= 1 && (x % 10) <= 8, inTileZ = (z % 10) >= 1 && (z % 10) <= 8;
    if (!(inTileX && inTileZ)) tileList.push([x, -1, z, 0x141821]);
  }
  for (let x = -3; x < N * 10 + 3; x++) for (let z = -3; z < N * 10 + 3; z++) {
    const inside = x >= 0 && z >= 0 && x < N * 10 && z < N * 10;
    if (inside) continue;
    const top = ((x + z) % 7 === 0) ? 0x3b4252 : 0x30374a;
    frameList.push([x, -1, z, 0x20263a]); frameList.push([x, 0, z, top]);
  }
  for (let i = 0; i < N; i++) { frameList.push([i * 10 + 4, 1, -2, 0x4fd1c5]); frameList.push([i * 10 + 5, 1, -2, 0x4fd1c5]); }   // 먼 쪽 테두리의 열 눈금
  board.add(voxels(tileList, T, [-0.5, -0.2, -0.5]));
  board.add(voxels(frameList, T, [-0.5, -0.2, -0.5]));
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(26, 26), new THREE.ShadowMaterial({ opacity: 0.45 }));
  floor.rotation.x = -Math.PI / 2; floor.position.set(4, -0.42, 4); floor.receiveShadow = true; scene.add(floor);

  // ── 남은 벽: 판 왼쪽 테두리 위에 노란 작은 블록. 카메라 쪽부터 사람 것, 먼 쪽부터 에이전트 것
  let stockGroup = null, stockKey = '';
  function drawStock(human, agent) {
    const k = human + ',' + agent;
    if (k === stockKey) return;
    stockKey = k;
    if (stockGroup) { board.remove(stockGroup); disposeGroup(stockGroup); }
    const l = [];
    for (let i = 0; i < human; i++) for (const dz of [0, 1]) l.push([-2, 1, 87 - i * 4 + dz, 0xffb74d]);
    for (let i = 0; i < agent; i++) for (const dz of [0, 1]) l.push([-2, 1, 1 + i * 4 + dz, 0xffb74d]);
    stockGroup = l.length ? voxels(l, T, [-0.5, -0.2, -0.5]) : new THREE.Group();
    board.add(stockGroup);
  }

  // ── 말: 복셀 인형(폭 5, 깊이 5, 높이 9). 아래층부터
  const PAWN_LAYERS = [
    ['.XXX.', 'XXXXX', 'XXXXX', 'XXXXX', '.XXX.'],
    ['.XXX.', 'XXXXX', 'XXXXX', 'XXXXX', '.XXX.'],
    ['..B..', '.BBB.', '.BBB.', '.BBB.', '..B..'],
    ['..B..', '.BBB.', '.BBB.', '.BBB.', '..B..'],
    ['.BBB.', 'BBBBB', 'BBBBB', 'BBBBB', '.BBB.'],
    ['.BBB.', 'BBBBB', 'BBBBB', 'BBBBB', '.BBB.'],
    ['..H..', '.HHH.', '.HHH.', '.HHH.', '..H..'],
    ['.HHH.', 'HHHHH', 'HHEHH', 'HHHHH', '.HHH.'],
    ['.HHH.', 'HHHHH', 'HHHHH', 'HHHHH', '.HHH.'],
    ['..C..', '.CCC.', 'C.C.C', '.CCC.', '..C..'],
  ];
  const PAL = {
    white: { X: 0xd9cfb8, B: 0xf4efe4, H: 0xfff8ec, E: 0x2b2f3a, C: 0xffb74d },
    black: { X: 0x262c3a, B: 0x3b4357, H: 0x4a546c, E: 0xfff8ec, C: 0x4fd1c5 },
  };
  function makePawn(skin) {
    const g = new THREE.Group();
    g.add(voxels(model(PAWN_LAYERS, PAL[skin]), V, [-2.5 * V, 0, -2.5 * V]));
    const ringList = []; for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; ringList.push([Math.round(Math.cos(a) * 4), 0, Math.round(Math.sin(a) * 4), PAL[skin].C]); }
    const ring = voxels(ringList, V, [-0.5 * V, 0.02, -0.5 * V]);
    ring.visible = false; g.add(ring); g.userData.ring = ring;
    g.userData.target = new THREE.Vector3();
    return g;
  }
  const pawns = { human: makePawn('black'), agent: makePawn('white') };   // 아래(카메라 쪽) 청록 왕, 위 흰색 금관 왕
  board.add(pawns.human, pawns.agent);

  // ── 울타리: 복셀 널빤지. 길이 19복셀(두 칸), 두께 2, 높이 6, 기둥 2개
  const fenceGroup = new THREE.Group(); board.add(fenceGroup);
  const fenceMeshes = new Map();                 // 울타리 id → Group
  function fenceVoxels(o, fresh) {
    const l = []; const wood = fresh ? 0xffd58a : 0xc8a165, dark = fresh ? 0xe0a855 : 0x9c7a46, post = 0x6b4f2a;
    for (let i = 0; i < 19; i++) for (let y = 0; y < 6; y++) for (let t = 0; t < 2; t++) {
      const col = (y === 2 || y === 5) ? dark : wood;
      if (o === 'h') l.push([i, y, t, col]); else l.push([t, y, i, col]);
    }
    for (const i of [0, 18]) for (let y = 0; y < 8; y++) for (let t = 0; t < 2; t++) { if (o === 'h') l.push([i, y, t, post]); else l.push([t, y, i, post]); }
    return l;
  }
  function fenceMesh(f, fresh, drop) {
    const { r, c, orient: o } = R.fenceRC(f);
    const zc = fenceZ(r), xc = c + 0.5;
    const org = o === 'h' ? [xc - 9.5 * V, 0, zc - 1 * V] : [xc - 1 * V, 0, zc - 9.5 * V];
    const g = voxels(fenceVoxels(o, fresh), V, org);
    g.userData = { drop: drop ? 1 : 0, fresh };
    if (drop) g.position.y = 1.6;
    return g;
  }

  // ── 합법 이동 칸(빛나는 타일), 울타리 고스트
  const hintGroup = new THREE.Group(); board.add(hintGroup);
  const hintMat = new THREE.MeshBasicMaterial({ color: 0x4fd1c5, transparent: true, opacity: 0.35 });
  const hintHot = new THREE.MeshBasicMaterial({ color: 0x4fd1c5, transparent: true, opacity: 0.65 });
  const hintGeo = new THREE.BoxGeometry(0.8, 0.05, 0.8);
  const ghostOk = new THREE.MeshBasicMaterial({ color: 0x7CFF9A, transparent: true, opacity: 0.6 });
  const ghostBad = new THREE.MeshBasicMaterial({ color: 0xff5b5b, transparent: true, opacity: 0.5 });
  const ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 0.6, 1), ghostOk); ghost.visible = false; board.add(ghost);
  let hot = null;
  function showGhost(f, ok) {
    const { r, c, orient: o } = R.fenceRC(f);
    ghost.visible = true; ghost.material = ok ? ghostOk : ghostBad;
    ghost.scale.set(o === 'h' ? 1.9 : 0.2, 1, o === 'h' ? 0.2 : 1.9); ghost.position.set(c + 0.5, 0.3, fenceZ(r));
    requestFrame();
  }
  function clearGhost() { if (ghost.visible) { ghost.visible = false; requestFrame(); } }
  function setHot(m) { if (hot === m) return; if (hot) hot.material = hintMat; hot = m; if (hot) hot.material = hintHot; canvas.style.cursor = hot ? 'pointer' : ''; requestFrame(); }

  // ── 좌표: 규칙 줄 r ↔ 화면 줄 z. 사람(humanSide)이 항상 카메라 쪽
  let humanSide = 0;
  const zOf = r => humanSide === 0 ? 8 - r : r;
  const rOf = z => humanSide === 0 ? 8 - z : z;
  const fenceZ = r => humanSide === 0 ? 7.5 - r : r + 0.5;     // 규칙 줄 r 과 r+1 사이의 화면 z
  const fenceR = zi => humanSide === 0 ? 7 - zi : zi;          // 화면 줄 zi 와 zi+1 사이 → 규칙 r

  // ── 상태 반영
  let cur = null;
  function render(view) {
    cur = view;
    humanSide = view.humanSide;
    const snap = view.reset || reduceMotion();
    for (let s = 0; s < 2; s++) {
      const p = view.state.pawns[s], r = (p / 9) | 0, c = p % 9;
      const pawn = s === humanSide ? pawns.human : pawns.agent;
      pawn.userData.target.set(c, 0, zOf(r));
      if (snap) { pawn.position.set(c, 0, zOf(r)); }
      pawn.userData.ring.visible = view.turnSide === s;
    }
    // 울타리: 사라진 것은 치우고(다시 시작), 새 것은 떨어뜨린다. 마지막 울타리만 밝은 색
    const walls = view.state.walls, last = walls.length ? walls[walls.length - 1] : -1;
    for (const [f, g] of fenceMeshes) {
      if (!walls.includes(f) || (g.userData.fresh !== (f === last))) { fenceGroup.remove(g); disposeGroup(g); fenceMeshes.delete(f); }
    }
    for (const f of walls) {
      if (fenceMeshes.has(f)) continue;
      const isNew = f === last && !view.reset;
      const g = fenceMesh(f, f === last, isNew && !snap);
      fenceMeshes.set(f, g); fenceGroup.add(g);
    }
    drawStock(view.state.fences[humanSide], view.state.fences[view.agentSide]);
    // 이동 후보
    while (hintGroup.children.length) hintGroup.remove(hintGroup.children[0]);
    hot = null; canvas.style.cursor = '';
    for (const p of view.legalMoves) {
      const r = (p / 9) | 0, c = p % 9;
      const m = new THREE.Mesh(hintGeo, hintMat); m.position.set(c, 0.07, zOf(r)); m.userData.p = p; hintGroup.add(m);
    }
    if (!view.fenceMode) { ghost.visible = false; lastHover = null; }
    else if (lastHover) handlers.onFenceEnter(lastHover[0], lastHover[1]);   // R 로 방향을 바꾸면 고스트도 바로 따라간다
    if (badge) { badge.hidden = !view.thinking; badge.textContent = view.thinking ? `${view.agentName} 생각 중` : ''; }
    board.updateMatrixWorld(true);      // 첫 프레임 전에 클릭해도 레이캐스트가 새 메시를 잡도록
    requestFrame();
  }

  // ── 입력: 마우스 위치 → 레이. 이동 모드는 빛나는 칸을, 벽 모드는 바닥 평면 교차점을 쓴다
  const mouse = new THREE.Vector2(); const ray = new THREE.Raycaster(); const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let lastHover = null, lastPointerType = 'mouse';
  function setMouse(e) {
    const rect = canvas.getBoundingClientRect();
    mouse.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
  }
  function fenceAt() {
    const p = new THREE.Vector3(); if (!ray.ray.intersectPlane(plane, p)) return null;
    const zi = Math.min(7, Math.max(0, Math.round(p.z - 0.5))), c = Math.min(7, Math.max(0, Math.round(p.x - 0.5)));
    return [fenceR(zi), c];
  }
  function hintAt() { const hit = ray.intersectObjects(hintGroup.children, false)[0]; return hit ? hit.object : null; }
  canvas.addEventListener('pointerdown', e => { lastPointerType = e.pointerType || 'mouse'; });
  canvas.addEventListener('pointermove', e => {
    if (!cur || e.pointerType !== 'mouse') return;
    setMouse(e);
    if (cur.fenceMode) {
      const rc = fenceAt(); if (!rc) return;
      if (!lastHover || lastHover[0] !== rc[0] || lastHover[1] !== rc[1]) { lastHover = rc; handlers.onFenceEnter(rc[0], rc[1]); }
    } else if (cur.legalMoves.length) setHot(hintAt());
  });
  canvas.addEventListener('pointerleave', e => {
    if (e.pointerType !== 'mouse') return;
    setHot(null);
    if (lastHover) { lastHover = null; handlers.onFenceLeave(); }
  });
  canvas.addEventListener('click', e => {
    if (!cur) return;
    setMouse(e);
    if (cur.fenceMode) { const rc = fenceAt(); if (rc) handlers.onFenceTap(rc[0], rc[1], { pointerType: lastPointerType }); return; }
    const m = hintAt(); if (m) handlers.onMove(m.userData.p);
  });

  // ── 크기, 루프. 말은 목표로 깡총 이동, 울타리는 위에서 떨어져 꽂힘. reduced-motion 이면 바로 놓고 필요할 때만 그린다
  function resize() {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    requestFrame();
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(canvas); else addEventListener('resize', resize);
  let tm = 0, active = false, raf = 0, lastT = 0;
  function tick() { const now = performance.now(); const dt = lastT ? (now - lastT) / 1000 : 0; lastT = now; return dt; }
  function requestFrame() { if (active && !raf && !document.hidden) raf = requestAnimationFrame(frame); }
  function settle() {
    for (const pawn of [pawns.human, pawns.agent]) pawn.position.copy(pawn.userData.target);
    for (const g of fenceGroup.children) { g.userData.drop = 0; g.position.y = 0; }
  }
  function frame() {
    raf = 0;
    if (!active || document.hidden) return;
    const dt = Math.min(0.05, tick()); tm += dt;
    let busy = false;
    if (reduceMotion()) settle();
    else {
      for (const pawn of [pawns.human, pawns.agent]) {
        const t = pawn.userData.target, p = pawn.position;
        const d = Math.hypot(t.x - p.x, t.z - p.z);
        if (d > 0.003) { p.x += (t.x - p.x) * Math.min(1, dt * 7); p.z += (t.z - p.z) * Math.min(1, dt * 7); p.y = Math.sin(Math.min(1, d) * Math.PI) * 0.35; busy = true; }
        else { p.x = t.x; p.z = t.z; p.y = pawn.userData.ring.visible ? Math.abs(Math.sin(tm * 3)) * 0.04 : 0; if (pawn.userData.ring.visible) busy = true; }
      }
      for (const g of fenceGroup.children) {
        if (g.userData.drop > 0) { g.userData.drop = Math.max(0, g.userData.drop - dt * 2.5); g.position.y = g.userData.drop * g.userData.drop * 1.6; busy = true; }
      }
    }
    placeCamera(); renderer.render(scene, camera);
    if (busy) raf = requestAnimationFrame(frame);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && active) { lastT = 0; requestFrame(); } });
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); });
  canvas.addEventListener('webglcontextrestored', () => requestFrame());

  function setActive(on) {
    active = on; canvas.hidden = !on;
    if (on) { lastT = 0; resize(); requestFrame(); }
    else if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  function focus() { canvas.focus({ preventScroll: true }); }
  placeCamera(); resize();
  return { render, showGhost, clearGhost, focus, setActive, el: canvas };
}
