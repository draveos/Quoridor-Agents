# Quoridor Agents

Play Quoridor in the browser against one of two AI agents.
Pure HTML, CSS and JavaScript: no server, no build step, no dependencies.
Each agent runs in a Web Worker, so the page stays responsive while it searches.
On desktop the board is drawn as a 3D voxel board (Three.js, `view3d.js`, same look as the quoridor-arena spectator client); a "3D 보기" button switches between it and the 2D SVG board, which is the default on phones and when WebGL is unavailable.

**Play:** https://draveos.github.io/Quoridor-Agents/

## Agents

Both agents come from Sejin Kim's quoridor-arena experiments (a local league, not yet published), where AI-written agents played each other in a league.

| File | Origin |
|---|---|
| `agents/codex.js` | Port of `codex.py`, written by GPT. Iterative-deepening negamax with alpha-beta, transposition table, topology cache and trap prediction. |
| `agents/claude.js` | Port of `office.py`, written by Agent Office (Claude). |

Every agent follows the same Worker protocol:
`{type:'think', id, side, state, budget}` → `{type:'move', id, action, stats}` and `{type:'reset', side}` → `{type:'ready'}`.

## Run locally

```
python3 -m http.server 8000
```

Then open http://localhost:8000/. A local server is needed because browsers do not start Web Workers from `file://`.

## License

MIT. See `LICENSE`. The rule engine (`rules.js`) ports part of pyquoridor 0.0.5 (MIT, Ramon Viñas Torné) and the 3D board bundles three.js r184 (MIT) in `vendor/`; see `THIRD_PARTY.md`.

---

브라우저에서 쿼리도를 AI 에이전트와 두는 정적 사이트입니다. 상대는 둘 중에 고릅니다. Codex 에이전트는 GPT 가 작성한 `codex.py` 를, Claude 에이전트는 Agent Office(Claude) 가 작성한 `office.py` 를 JS 로 옮긴 것이며, 둘 다 김세진의 quoridor-arena 실험에서 나왔습니다. 규칙 엔진은 pyquoridor 를 JS 로 옮겼습니다. 데스크톱에서는 quoridor-arena 관전 화면과 같은 Three.js 복셀 판(3D)이 기본이고, 버튼으로 2D 판과 오갑니다. 로컬에서는 `python3 -m http.server` 로 띄워서 열면 됩니다.
