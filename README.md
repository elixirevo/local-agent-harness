# agent-harness

로컬 LLM 프로바이더(Ollama / llama.cpp / vLLM) 위에서 동작하는 에이전트 하네스.
설계 배경과 로드맵은 [docs/local-agent-harness-plan.md](docs/local-agent-harness-plan.md) 참조.

**현재 상태: Phase 1** — 에이전트 루프 + 파일 도구 5종(Read/Write/Edit/Glob/Grep) + 권한 게이트 + 루프 가드.
Bash 도구와 텍스트 프로토콜 폴백(네이티브 tool call 미지원 모델용)은 Phase 2에서 추가된다.

## 요구사항

- Node.js ≥ 20.10 (bun도 동작)
- 로컬 추론 서버 중 하나:
  - Ollama (`ollama serve`, 기본 http://localhost:11434)
  - llama.cpp (`llama-server --jinja -m <model.gguf>`, 기본 http://localhost:8080)
  - vLLM (`vllm serve <model>`, 기본 http://localhost:8000)

## 시작하기

```bash
npm install
npm start                                    # REPL (기본: ollama, 첫 번째 모델)
npm start -- -m gemma4:e2b                   # 모델 지정
npm start -- -p "src의 버그 고쳐줘" -M auto    # one-shot 에이전트 실행
npm start -- -P llamacpp                     # 프로바이더 지정
```

REPL 명령: `/help` `/models` `/model <id>` `/provider <name>` `/clear` `/exit`

## 도구와 권한 모드

네이티브 tool call을 지원하는 모델(프로파일 기준)에는 Read / Write / Edit / Glob / Grep
도구가 제공된다. 프롬프트로 가르치는 규칙은 코드로도 강제된다: Edit/Write는 선행 Read 필수,
읽은 뒤 파일이 외부에서 바뀌면 재읽기를 요구하고, 동일 호출 반복은 루프 가드가 차단한다
(3회 반복 시 턴 강제 종료).

`--permission-mode` (`-M`, 기본 `ask`):

| 모드 | 동작 |
|---|---|
| `readonly` | 변이 도구(Write/Edit)를 모델에게 아예 제공하지 않음 |
| `ask` | 변이 호출마다 y/N 확인 (비대화형 실행에서는 거부됨) |
| `auto` | 작업 디렉터리 안의 변이는 자동 허용, 밖은 확인 요청 |

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
