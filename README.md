# omo-cpa

omo(senpi)용 [CLI Proxy API](https://github.com/router-for-me/CLIProxyAPI) 플러그인입니다. CPA가 내려주는 모델 목록을 주력 프로바이더 `cliproxyapi`와 최후수단 프로바이더 `cliproxyapi-last`로 나눠 등록하고, 세션 안에서 상태, 계정 사용량, 폴백 체인을 다룹니다.

저장소: <https://github.com/jc01rho/omo-cpa>

## 하는 일

- **프로바이더 둘.** `cliproxyapi`가 주력입니다. `cliproxyapi-last`는 직접 고를 때만 쓰는 최후수단이고, senpi의 암시적 패밀리 확장에서는 빠집니다. `/login cliproxyapi` 한 번으로 둘 다 인증합니다.
- **라이브 카탈로그.** OpenAI `GET /v1/models`, Anthropic `GET /v1/models`, Gemini `GET /v1beta/models`, Codex `GET /v1/models?client_version=cpa`를 한 목록으로 합칩니다. 성공한 목록은 기본 5분간 캐시하고, 동시에 들어온 조회는 요청 한 번으로 묶습니다.
- **티어.** 주력 패밀리는 muse, gpt, claude, gemini, glm, deepseek, grok입니다. id만으로 부족하면 displayName의 머리 단어로 가릅니다. `fable`처럼 별칭만 있는 모델도 이렇게 주력으로 올라갑니다. `free` 표식이 있거나 이미지, 음성, 임베딩 같은 비채팅 모델은 채팅 폴백 체인에서 빠집니다. `/cpa tier`로 저장한 수동 지정은 지금 카탈로그에 있는 모델에만 적용되고, 없는 id는 비활성으로만 보입니다.
- **목록 밖에서도 등록.** `gpt-spark`, `composer-2.5`, `MiniMax-M3`, `open-muse`는 네 목록에 없어도 등록합니다. 티어는 별칭 id가 아니라 각 별칭의 upstream 모델로 판정합니다. `higher-coding`과 `lower-coding`은 목록에서 빠져도 최후수단 꼬리로 남아, 기동 검증이 빈 셀렉터를 보지 않게 합니다.
- **헬스.** CPA로 보낸 응답만 집계합니다. HTTP 429는 요청 제한, 5xx가 연속 3회면 down입니다. 4xx는 서버 장애로 세지 않습니다. 핸들러 오류는 삼키므로 플러그인 버그가 세션을 죽이지 않습니다.
- **사용량.** 관리 키가 있을 때만 `GET /v0/management/auth-files`를 읽습니다. 키가 없거나 거부되면 숫자를 추정하지 않고 이유만 보여 줍니다.
- **비밀.** 리포트와 `--json` 출력에서 키는 빠집니다. 관리 키는 omo 설정 파일이 아니라 사용자만 읽는 파일에 둡니다.

## 필요한 것

- [Bun](https://bun.sh)
- 실행 중인 CLI Proxy API. 기본 주소는 `http://127.0.0.1:8317`입니다.
- omo(senpi). 이 패키지는 omo 확장으로 로드됩니다.

## 설치

```bash
git clone https://github.com/jc01rho/omo-cpa.git
cd omo-cpa
bun install
bun run install-extension
```

`install-extension`은 `~/.omo/agent/extensions/omo-cpa.ts`에 이 체크아웃의 `src/extension.ts`를 가리키는 로더를 씁니다. 체크아웃을 옮기면 로더도 다시 만들어야 합니다. 플러그인을 내리려면 그 로더 파일을 지우고 omo를 다시 시작하면 됩니다.

omo를 다시 시작한 뒤 추론 키를 넣습니다.

```text
/login cliproxyapi
```

세션 없이 서버만 점검할 때는 환경변수로 충분합니다. CLI는 omo에 저장된 로그인 키를 읽지 않습니다.

```bash
export OMO_CPA_API_KEY="추론 키"
bun run start
```

## 명령

omo 세션:

| 명령 | 동작 |
| --- | --- |
| `/cpa` | 서버, tier 수, 헬스, 계정 사용량 |
| `/cpa refresh` | 카탈로그를 다시 받아 tier를 다시 계산 |
| `/cpa help` | 도움말 |
| `/cpa tier` | 주력, 최후수단, 비채팅, 수동 지정 목록 |
| `/cpa tier promote <model-id>` | 그 모델을 주력으로 고정 |
| `/cpa tier demote <model-id>` | 그 모델을 최후수단으로 고정 |
| `/cpa tier reset <model-id>` | 수동 지정 해제 |
| `/cpa chains` | 폴백 체인 미리보기. 세션은 바꾸지 않음 |
| `/cpa chains apply` | 현재 세션에만 폴백 체인 적용 |
| `/cpa management status` | 관리 키 유무 |
| `/cpa management set` | 관리 키를 0600 파일에 저장. 입력 내용은 화면에 보일 수 있음 |
| `/cpa management clear` | 저장한 관리 키 삭제 |

터미널:

```bash
bun run start            # 상태 리포트
bun run start -- --json  # 같은 내용. 키는 포함하지 않음
bun run start -- --help
```

의존성을 설치한 뒤 `bun link`를 하면 `omo-cpa` 명령으로도 같은 엔트리를 실행합니다.

## 설정

| 이름 | 기본 | 설명 |
| --- | --- | --- |
| `OMO_CPA_BASE_URL` | `http://127.0.0.1:8317` | CPA 서버. 끝의 `/v1`, `/v1beta`, `/v0`는 루트로 접습니다. 세션에서는 `/login`에 저장된 주소가 우선합니다. |
| `OMO_CPA_API_KEY` | 없음 | 추론 키. 세션에서는 `/login cliproxyapi`로 저장된 키가 이 값보다 우선합니다. CLI는 이 변수만 봅니다. |
| `OMO_CPA_MANAGEMENT_KEY` | 없음 | 관리 API 키. 있으면 파일보다 우선하고, 계정별 사용량이 켜집니다. |
| `OMO_CPA_CATALOG_TTL_MS` | `300000` | 카탈로그 캐시(밀리초). `0`이면 매번 다시 받습니다. |

| 경로 | 내용 |
| --- | --- |
| `~/.omo/agent/extensions/omo-cpa.ts` | 설치 로더. 지우면 언로드됩니다. |
| `~/.omo/agent/cpa-management-key` | 관리 키. 모드 0600이며 암호화하지 않습니다. |
| `~/.cache/omo-cpa/tier-overrides.json` | `/cpa tier`로 저장한 수동 티어. |

상태 줄 키는 `omo-cpa`입니다.

## 개발

```bash
bun install
bun test
bun run typecheck
```

## 라이선스

[MIT](./LICENSE)
