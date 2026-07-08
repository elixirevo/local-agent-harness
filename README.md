# agent-harness

로컬 LLM 프로바이더(Ollama / llama.cpp / vLLM / Apple MLX) 위에서 동작하는 에이전트 하네스.
설계 배경과 로드맵은 [docs/local-agent-harness-plan.md](docs/local-agent-harness-plan.md),
다음 단계는 [docs/maturity-roadmap.md](docs/maturity-roadmap.md) 참조.

**현재 상태: Phase 6** — 에이전트 루프 + 도구 7종+MCP(Read/Write/Edit/Glob/Grep/Bash/Agent + `mcp__*`) +
권한 게이트(명령 위험 분류) + 루프 가드 + 프롬프트 티어 + system-reminder 컨텍스트 주입 +
텍스트 프로토콜 폴백 + 세션 저장/복원 + 컨텍스트 수명 관리(캘리브레이션된 토큰 예산, FRC, 자동 압축,
grammar 강제 재시도) + 서브에이전트(Explore/Verify, **read-only 배치 병렬 실행**) + 계획 모드 +
MCP 클라이언트 + 평가 하네스(`harness eval`) + **Apple MLX 프로바이더** + `/remember` 세션 메모리 +
작업 중 스피너.

## 요구사항

- Node.js ≥ 20.10 (bun도 동작)
- 로컬 추론 서버 중 하나:
  - Ollama (`ollama serve`, 기본 http://localhost:11434)
  - llama.cpp (`llama-server --jinja -m <model.gguf>`, 기본 http://localhost:8080)
  - vLLM (`vllm serve <model>`, 기본 http://localhost:8000)
  - Apple MLX (`mlx_lm.server --model <mlx-model> --port 8081`, Apple Silicon 전용)

## 시작하기

```bash
npm install
npm start                                    # REPL (기본: ollama, 첫 번째 모델)
npm start -- -m gemma4:e2b                   # 모델 지정
npm start -- -p "src의 버그 고쳐줘" -M auto    # one-shot 에이전트 실행
npm start -- -P llamacpp                     # 프로바이더 지정
```

REPL 명령: `/help` `/models` `/model <id>` `/provider <name>` `/plan` `/mcp` `/remember <note>`
`/context` `/compact` `/session` `/clear` `/exit`

### 터미널 UI

대화형 터미널(TTY)에서는 입력창이 화면 **하단에 고정**되고 모델 출력은 그 위로 흐른다. 입력창
아래 힌트 줄에는 `/`를 입력하면 매칭되는 슬래시 명령이, 작업 중에는 진행 인디케이터가 표시된다.
입력 편집(←→, Home/End, Ctrl+U/K, ↑↓ 히스토리)을 지원한다. 파이프 입력·one-shot에서는 자동으로
단순 라인 모드로 동작하며, 터미널에서도 `--plain`으로 강제할 수 있다.

### Apple MLX (Apple Silicon)

vLLM은 CUDA 전용이라 Mac에서 못 쓰지만, Apple의 MLX(`mlx-lm`)는 Apple Silicon 네이티브다 —
Ollama에 이어 **Mac에서 라이브 검증 가능한 두 번째 프로바이더**:

```bash
pip install mlx-lm                                              # transformers 4.48로 핀 필요할 수 있음
mlx_lm.server --model mlx-community/Qwen3-4B-4bit --port 8081
npm start -- -P mlx -m mlx-community/Qwen3-4B-4bit -M auto      # 하네스 연결
```

실측 검증(Qwen3-4B-4bit): 스트리밍·네이티브 도구 호출·전체 에이전트 루프(Read→Edit) 정상,
그리고 Ollama와 달리 `cached_tokens`를 실제로 보고(2턴째 cached 2364/2389 — prefix cache 신호).
guided decoding은 없어 압축 재시도는 일반 재요청으로 폴백.

## 도구와 권한 모드

도구는 Read / Write / Edit / Glob / Grep / Bash 6종. 프롬프트로 가르치는 규칙은 코드로도
강제된다: Edit/Write는 선행 Read 필수, 읽은 뒤 파일이 외부에서 바뀌면 재읽기를 요구하고,
동일 호출 반복(실패·거부된 호출의 재시도 포함)은 루프 가드가 차단한다(3회 반복 시 턴 강제 종료).
Edit는 소형 모델의 대표 실수(라인 번호 프리픽스 포함, 들여쓰기 불일치)를 복구 사다리로 살려낸다.

Bash 명령은 실행 전 위험도로 분류된다: `read`(ls, cat, git status...) / `mutate`(빌드, 테스트,
git add...) / `destructive`(rm, git push, sudo, --no-verify...). 분류 불가능한 명령은 보수적으로
mutate 취급.

`--permission-mode` (`-M`, 기본 `ask`):

| 모드 | 동작 |
|---|---|
| `readonly` | 변이 도구(Write/Edit/Bash)를 모델에게 아예 제공하지 않음 |
| `ask` | 변이 호출마다 확인. read 분류 Bash 명령은 자동 허용 |
| `auto` | 작업 디렉터리 안의 변이는 자동 허용. **destructive는 항상 확인** |

`ask` 모드의 승인 프롬프트는 **y(허용) / n(거부) / a(항상)** 로 답한다. `a`는 그 도구(예: Write)를
세션 동안 다시 묻지 않도록 기억한다(파괴적 명령은 항상 확인 — a를 제공하지 않음).

## 텍스트 프로토콜 폴백

네이티브 tool call이 없는 모델(프로파일 기준, 또는 `--protocol text` 강제)은 시스템 프롬프트에
문서화된 `<tool_call>{"name": ..., "arguments": ...}</tool_call>` 블록으로 도구를 쓴다.
파서는 관대하다(코드펜스, parameters 별칭, 닫는 태그 누락, 태그 없는 bare JSON까지 복구).
파싱 불가 시 포맷 리마인더를 보내 재시도시키고, 3회 실패하면 턴을 중단한다.
Phase 1에서 네이티브 도구 호출에 실패했던 llama3.2(3B)가 이 프로토콜로는 버그 수정 시나리오를
완주한다.

## 컨텍스트 주입

대화 시작 시 날짜·git 스냅샷(2000자 잘림)·프로젝트 메모리(AGENTS.md 또는 CLAUDE.md)가
`<system-reminder>`로 첫 메시지에 주입된다("관련 없을 수 있음" 프레이밍 포함). 리마인더는
항상 대화 꼬리에만 붙어 프리픽스 캐시를 깨지 않는다.

## 계획 모드

`--plan` 플래그 또는 REPL `/plan` 토글. 문서의 패턴대로 "아직 실행하지 말 것"을 최우선
리마인더로 주입하고, 코드로도 강제한다: 모든 변이가 거부되며 **유일한 예외는 계획 파일**
(`.harness/plan.md`)의 Write/Edit다. 읽기 도구와 read 분류 Bash(git status 등)로 탐색하며
계획을 다듬은 뒤, `/plan`으로 해제하면 실행 허용 리마인더가 주입된다.

## MCP 서버 연결

config에 stdio MCP 서버를 등록하면 그 도구들이 `mcp__서버명__도구명`으로 모델에 제공된다:

```json
{
  "mcpServers": {
    "notes": { "command": "node", "args": ["./my-mcp-server.js"] }
  }
}
```

- 서버의 `readOnlyHint` 어노테이션이 있는 도구만 read로 취급(readonly 모드에 노출, ask 모드
  자동 허용); 나머지는 변이로 게이트를 통과해야 한다.
- 서버별 연결 실패는 경고로 격리된다. `/mcp`로 연결 상태·도구 목록 확인.
- 스키마는 서버 원본을 모델에 그대로 전달하고, 로컬 검증은 아는 타입만 확인한다(서버가 최종 권위).

## 서브에이전트 (Agent 도구)

모델이 `Agent` 도구로 스코프가 제한된 중첩 에이전트에 작업을 위임할 수 있다:

- **explore** — 읽기 전용 코드베이스 탐색(Read/Glob/Grep만, readonly 게이트로 이중 방어).
  넓은 검색의 중간 결과가 메인 컨텍스트를 오염시키지 않게 한다. config `agents.exploreModel`로
  탐색 전용 소형 모델을 지정할 수 있다.
- **verify** — 적대적 검증("확인이 아니라 부수기"). Bash로 빌드/테스트를 실행하되 프로젝트
  변이·파괴적 명령은 차단(auto 게이트 + 승인 불가 = 자동 거부). 보고서는
  `VERDICT: PASS|FAIL|PARTIAL` 라인으로 끝나며 호출자가 파싱한다.

서브에이전트는 다시 에이전트를 만들 수 없다(재귀 차단). 결과는 라벨 계약(`Scope:/Result:/Key files:`)으로 회수된다.

**병렬 실행**: 한 스텝에서 모델이 여러 read 분류 호출(Read/Grep/Glob 팬아웃, explore 서브에이전트)을
내면 동시 실행된다(mutation이 하나라도 섞이면 순차 유지 — 순서와 가드 상태가 중요하므로). 결과는
호출 순서대로 회수된다. 서브에이전트를 실제로 병렬 실행하려면 Ollama는 `OLLAMA_NUM_PARALLEL=2+`가
필요하다(로컬 파일 읽기는 무관하게 병렬).

## /remember — 세션 메모리

`/remember <note>`는 프로젝트 AGENTS.md의 관리 섹션(`## Harness notes`)에 날짜 붙은 노트를
append한다(사용자 기존 내용은 건드리지 않음). 다음 세션의 시작 컨텍스트가 자동 회수하고, 노화
프레이밍으로 오래된 노트를 실시간 상태로 오인하지 않게 한다. 자동 추출은 의도적으로 제외 —
사용자 프로젝트 파일 쓰기는 명시적 명령 뒤에만.

## 평가 하네스 (harness eval)

프롬프트·설정 변경을 감이 아니라 측정으로 검증한다:

```bash
npm start -- eval --model gemma4:e2b                  # 퀵 스위트 리포트
npm start -- eval -h                                  # 옵션
npm start -- eval --model gemma4:e2b --temp profile --temp 0.4   # 온도 매트릭스
npm start -- eval --model llama3.2 --protocol text    # 프로토콜 강제
npm start -- eval --list                              # 시나리오 목록
```

- 시나리오: edit/debug/multistep/search/agent 5종류(성공 판정은 모델 주장이 아니라
  **프로그래매틱 검사** — 테스트 실행, 파일 내용 확인). `--heavy`로 장기 압축 시나리오 포함.
- 매트릭스: `--model/--tier/--protocol/--temp`를 반복 지정하면 카테시안 곱으로 셀 구성.
- 지표: 성공률, 스텝/도구 호출 수, 도구 에러, 파싱 실패(텍스트 프로토콜), 가드 발동,
  압축 횟수, prefill ms/1k-tok, 벽시계 시간. 원자료는 `.harness/eval/*.json`에 저장(실패 진단용
  답변 원문 포함).

## 컨텍스트 수명 관리

토큰 사용량은 문자 수 기반 보수 추정으로 상시 추적되며 스텝 통계에 `ctx ~N%`로 표시된다.
예산(컨텍스트 − 출력 예약분)을 넘기면 단계적으로 회수한다:

1. **~60%**: 오래된 대형 도구 결과를 자리표시자로 치환(FRC, 최근 N개 유지 — 부족하면 최신 1개만 남기고 격상)
2. **~75%**: **자동 압축** — 도구 없는 요청으로 6섹션 요약을 만들고
   `[시스템, 요약+이어가기, 최근 턴 원문]`으로 대화를 재구성한다. 사용자의 첫 메시지는
   연쇄 요약의 정보 침식을 막기 위해 요약과 별개로 **원문 고정**된다. 압축 후에는 편집 전
   재읽기가 강제된다(파일 내용이 컨텍스트에서 사라졌으므로).

수동 실행은 `/compact`, 현황은 `/context`. 요약이 6섹션 계약을 어기면 1회 재시도한다.
자동 압축은 턴당 1회로 제한되며, 압축 전 전체 기록은 세션 파일에 남아 모델이 Read로
참조할 수 있다(이어가기 리마인더에 경로 포함). 설정: config `compaction`
(`enabled`/`threshold`/`frcThreshold`/`keepRecentResults`/`reserveTokens` — 예약분은 작은
윈도에서 ctx/4로 자동 축소).

## 세션 저장/복원

대화는 `.harness/sessions/<id>.jsonl`에 턴 단위로 증분 저장된다(끄기: `--no-save` 또는
config `saveSessions: false`). 복원은 `--resume last` 또는 `--resume <id>`. 복원 시
파일이 바뀌었을 수 있다는 리마인더가 주입되어 모델이 편집 전 재읽기를 하도록 유도한다.
현재 세션 파일 경로는 REPL에서 `/session`으로 확인.

## 턴별 통계와 캐시 계측

매 턴 끝에 통계 라인이 출력된다:

```
[0.2s · prompt 101 tok in 50ms · gen 2 tok @ 181.1 tok/s]
```

`prompt ... in Nms`의 prefill 시간이 핵심 신호다. 대화가 길어져도 이 값이 낮게 유지되면
프리픽스 캐시가 동작하는 것이다(하네스는 대화를 append-only로 유지해 캐시를 보존한다).

- **Ollama**: `prompt_eval_count`의 의미(전체 vs 재계산분)가 0.30 기준 모델/엔진별로 달라(실측 확인)
  토큰 수는 참고치로만 표시하고, prefill 시간으로 캐시 적중을 판단한다.
- **llama.cpp**: `timings` 확장에서 재계산 토큰(`prompt_n`)과 캐시 토큰(`cache_n`)을 구분 표시.
- **vLLM**: Automatic Prefix Caching 활성 시 `cached_tokens`를 표시.

## 설정

프로젝트 루트에 `harness.config.json` (선택):

```json
{
  "defaultProvider": "ollama",
  "defaultModel": "qwen3:8b",
  "contextLength": 32768,
  "providers": {
    "ollama": { "type": "ollama", "baseUrl": "http://localhost:11434", "keepAlive": "10m" }
  },
  "models": {
    "qwen3": { "temperature": 0.5 },
    "qwen3:32b": { "contextLength": 16384 }
  }
}
```

- `contextLength`는 VRAM 가드(상한)다. 실제 num_ctx = min(모델 프로파일의 컨텍스트, 이 값).
  Ollama는 num_ctx를 명시하지 않으면 작은 기본값으로 조용히 앞부분을 잘라내므로 하네스가 항상 명시 전송한다.
- `models`는 모델 프로파일 오버라이드(정확한 모델 id 또는 family 이름 키).

## 모델 프로파일

`src/models/profile.ts`에 모델 family별 능력(컨텍스트, 네이티브 도구 호출, thinking 방식, 권장 온도)이
선언되어 있다. 미등록 모델은 보수적 기본값으로 동작한다. 새 모델을 쓸 때는 `ollama show <model>`의
Capabilities와 대조해 프로파일을 추가/수정할 것.

## 개발

```bash
npm run typecheck
npm test
npm run build   # dist/ 로 컴파일 (bin: harness)
```
