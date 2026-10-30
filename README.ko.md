# omo-keepalive

[English](README.md) | 한국어

goal이 도는 OMO 세션이 구독 사용량 한도에 닿으면 세션을 한도 대기(park) 상태로 멈춰 두었다가
리셋 시각에 이어서 돌리는 Senpi/OMO 확장이다. 자리를 비운 동안과 한도 대기 동안 프롬프트 캐시도
대화에 기록을 남기지 않고 데워 둔다(예전 omo-keepwarm).

## 설치

```sh
omo install git:github.com/yjacket/omo-keepalive
```

omo가 저장소를 `~/.omo/agent/git/github.com/yjacket/omo-keepalive`에 클론하고 `~/.omo/agent/settings.json`의 `packages`에 등록한다. 실행 중인 세션에서 `/reload`를 입력한다.

**업데이트:** `omo update --extensions`는 git으로 설치한 확장을 모두 갱신하고, `omo update --extension git:github.com/yjacket/omo-keepalive`는 이 확장만 갱신한다. 실행 중인 세션은 `/reload` 뒤나 새 세션에서 바뀐 내용을 쓴다.

예전 복사 스크립트로 설치했다면 `~/.omo/agent/extensions/omo-limitless/`를 지운다. 남겨 두면 패키지와 함께 로드된다.

## omo-limitless, omo-keepwarm에서 옮기기

omo-limitless는 omo-keepalive로 이름이 바뀌었고, omo-keepwarm은 여기에 합쳐졌다. 두 옛 패키지는 더 쓰지 않으니 다시 설치하지 않는다.

1. `omo remove git:github.com/yjacket/omo-limitless`를 실행한다.
2. `~/.omo/agent/extensions/omo-keepwarm.ts` 파일을 직접 지운다.
3. 예전 `omo-keepwarm uninstall`은 실행하지 않는다. `mode: off`를 써서 캐시 데우기가 멈춘다. `--purge`도 절대 쓰지 않는다. 기록이 지워진다.
4. 위처럼 omo-keepalive를 설치하고 `/reload`를 입력한다.
5. `~/.omo/agent/statusbar.json`에서 `limitless`를 `omo-keepalive`로 바꾼다.
6. 예전 버전이 남긴 예약 작업을 지운다: `Get-ScheduledTask -TaskPath \omo-limitless\ | Unregister-ScheduledTask -Confirm:$false`.

처음 로드할 때 `~/.omo/limitless`를 `~/.omo/keepalive`로 옮긴다(`~/.omo/keepalive`가 아직 없을 때만). 캐시 데우기 데이터는 `~/.omo-keepwarm`에 그대로 둔다.

## 동작

- keepalive가 켜져 있고 한도 대기 중이 아니면 상태 줄에 `🔄`가 뜬다. `/keepalive off`이면 사라진다.
- goal이 실행 중이고 5시간 창 사용률이 90%, 또는 7일 창이 95% 이상이면 다음 턴 경계에서 한도 대기에 들어간다. 오늘 리셋이면 상태 줄에 `⏸ 한도 대기 · HH:MM 재개`, 다른 날 리셋이면 `⏸ 한도 대기 · M/D HH:MM 재개`가 뜬다.
- 리셋까지 남은 시간이 레인의 `waitLimitMs` 이하면 세션 안에서 기다린다. 길면 park 기록을 남기고 종료한 뒤 리셋 때 다시 띄운다.
- 기다리는 동안 리셋 시각까지 프롬프트 캐시를 데워 둔다. 대화 턴이 아니라 기록에 남지 않는 ping이다. 사용률이 99% 이상이면 데우지 않는다. 자세한 것은 [캐시 데우기](#캐시-데우기).
- 리셋 시각(+ `resumeGraceMs`)이 지나면 goal을 재개한다.
- 사용량 조회 전에 provider가 한도 오류를 돌려주면 그 자리에서 반응형 park를 한다. 오류에 리셋 시각이 없으면 상태 줄에 `⏸ 한도 대기 · 재개 시각 미정`이 뜨고, 30분 뒤 사용량을 확인한다. 한도가 풀렸거나 사용량을 읽을 수 없으면 park를 해제한다. 아직 한도를 넘었으면 일반 사용량 park로 바뀌어, 리셋 시각에 재개하거나 리셋 시각을 여전히 모르면 `pollMinIntervalMs`(최소 60초)마다 다시 확인한다. 확인이 실패하면 30분마다 다시 시도하고, 성공한 확인 없이 6시간이 지나면 park를 해제한다.
- 한 모델 계열에만 걸린 한도(`You've reached your Fable limit`, 또는 auth.json에서 실패한 모델에 걸린 아직 안 끝난 `modelBlocks`)는 park하지 않는다. 다른 모델은 쓸 수 있고 OMO fallback이 넘어간다. `All ... accounts ... are currently blocked`는 계정 자체에 아직 안 끝난 `blockedUntil`이 있을 때만 park한다.
- goal 자동 계속이 상한(연속 8번)에서 멈췄고(새 OMO는 goal을 blocked로도 바꾼다) 마지막 턴이 한도 오류로 끝났으면, goal을 다시 active로 돌리고 사용자 메시지를 한 번 보내 쓸 수 있는 모델로 이어가게 한다. OMO는 fallback 시도 목록을 사용자 메시지에서만 비우고, 확장이 보낸 메시지로는 blocked goal을 풀지 않는다. 멈출 때마다 한 번이고, 성공한 턴 없이 3번 이어지면 그만두고 알린다. park 중에는 보내지 않는다.
- keepalive가 goal을 멈춰 둔 동안에는 자동 실행(goal 이어가기, todo 알림, 알림 메시지, 다른 세션이 보낸 메시지)은 도구를 하나도 쓰지 않는다. 직접 입력한 메시지와 `/loop`나 훅이 대신 보낸 프롬프트는 서브에이전트 생성(`task`, `task_create`)을 뺀 도구를 그대로 쓴다. 파크가 시작될 때 이미 백그라운드에서 돌던 작업은 멈추지 않는다.

## 설정

`~/.omo/keepalive/config.json`. 없는 키는 기본값을 쓴다. 잘못된 값은 기본값으로 돌아가고, 세션 시작 때 잘못된 키를 적은 경고 알림이 한 번 뜬다(최대 3개, 나머지는 `외 N개`).
값은 `/keepalive set`으로 바꿀 수 있고, `enabled`를 제외한 파일 편집은 실행 중인 모든 세션에 반영된다.

| 키 | 기본값 | 설명 |
|---|---|---|
| `thresholds.fiveHour` | `90` | 5시간 창 사용률(%) 기준. 이 값 이상이면 park |
| `thresholds.sevenDay` | `95` | 7일 창 사용률(%) 기준. 이 값 이상이면 park |
| `waitLimitMs.anthropic-subscription` | `14400000` | 리셋까지 이 시간(ms) 이하면 세션 안에서 대기, 넘으면 종료 후 재실행 |
| `waitLimitMs.chatgpt-subscription` | `7200000` | 위와 같음 (ChatGPT 구독) |
| `warm.anthropic-subscription.on` | `true` | 한도 대기 중 캐시를 데움 |
| `warm.chatgpt-subscription.on` | `true` | 위와 같음 (ChatGPT 구독) |
| `enabled` | `true` | 전역 스위치 |
| `pollMinIntervalMs` | `60000` | 사용량 조회 최소 간격(ms) |
| `resumeGraceMs` | `60000` | 리셋 시각 뒤 재개 전 여유(ms) |

## 캐시 데우기

Claude 구독과 Codex 구독 세션을 자리를 비운 동안 데워, 돌아온 첫 턴이 캐시를 읽게 한다.

- **기록 없는 ping.** Claude는 세션의 Claude Code 세션을 저장하지 않는 fork로 이어 보내고, Codex는 마지막 요청을 `store:false`로 같은 캐시 키에 다시 보낸다. 대화, transcript, 다른 확장에는 보이지 않는다.
- **간격.** 마지막 요청(사람, goal, 다른 확장 턴 모두)부터 Claude 55분, Codex 15분. Codex 구독 캐시는 보장 없이 25~30분에 사라진다.
- **언제까지.** 평소에는 복귀 습관으로 정한 시간까지, 한도 대기 중에는 리셋 시각까지. miss 하나는 일시적일 수 있어 다음 ping은 그대로 나간다. 연달아 두 번 miss가 나면 그 구간의 데우기를 멈춘다.
- **설정과 기록.** `~/.omo-keepwarm/config.json`의 `mode`가 `on`이면 ping을 보내고, `shadow`면 판단만 기록하며, 파일이 없거나 `off`면 아무것도 하지 않는다. 기록은 같은 폴더에 남는다.
- senpi를 업데이트한 뒤에는 `/keepalive`의 최근 7일 줄과 `~/.omo-keepwarm/records`의 `ping` 기록으로 적중을 한 번 확인한다. senpi가 요청 조립을 바꾸면 ping이 miss가 나고, 연달아 두 번 miss가 나면 데우기가 멈춘다.

### omo-ai 미리보기 안전 패치

omo-ai 5.1.43보다 오래된 버전에만 해당한다. 5.1.43부터는 omo-ai가 자기 핸들러에 직접 표시를 붙이므로 keepalive는 번들을 건드리지 않는다. Senpi는 캐시 데우기 ping을 프롬프트 미리보기로 만들고, `before_agent_start` 핸들러에 `previewSafe` 표시가 없으면 그 ping 전체를 건너뛴다(Claude ping이 나가지 않는 이유). 그 이전 버전에서는 omo-ai의 핸들러 두 개(게이트웨이 규칙, 온보딩)에 표시가 없어서, keepalive가 설치된 omo-ai의 `plugin/extensions/omo.js`에서 두 등록에 `{previewSafe:!0}`를 붙인다. 패치는 프로세스당 한 번 실행되고 여러 번 적용해도 같으며, 번들 모양을 알 수 없으면 아무것도 바꾸지 않고 이유를 알린다. 원본은 `omo.js.before-previewsafe`로 남는다. omo-ai를 업데이트하면 다시 적용되고, 다음 실행부터 적용된다. `OMO_KEEPALIVE_PREVIEW_SAFE=off`로 건너뛸 수 있다.

## omo-health 연동

종료 후 재실행 경로는 `~/.omo-health/parks`에 park 기록을 쓴다. omo-health가 리셋
시각에 그 기록을 읽어 Orca 또는 herdr에서 세션을 다시 띄운다.

백그라운드 작업이 돌고 있는 동안에는 종료하지 않는다. 종료를 막는 것:

- 실행 중인 서브에이전트와 DAG 노드
- 백그라운드 eval 셀
- 백그라운드 셸 세션
- 모니터
- 대기 중인 ask-user 질문
- loop-guard 하드 정지
- 개수를 읽을 수 없는 그 밖의 소스

그 자리에서 기다리다가 모두 끝나고 세션이 끝남 알림을 처리한 뒤(다음 agent_settled)에만
종료한다. reload는 종료를 강제하지 않는다. reload 뒤에는 세션이 한 번 settle되고 짧은 유예가
지날 때까지 기다려, reload를 넘기고 살아남은 작업도 먼저 센다. 기다리는 동안(세션이 끝내 settle되지 않아도)은
일반 한도 대기 상태로 있다가 리셋 때 그 자리에서 재개한다.

터미널이 Orca나 herdr인데 최근에 살아 있는 omo-health 데몬이 없으면 종료하지 않는다.
Orca/herdr 재실행에는 park 재개를 지원하는 omo-health(`daemon.json`의 `park-resume`
capability)도 필요하다. 없으면 세션은 그 자리에서 기다린다.
세션은 그 자리에서 한도 대기로 남았다가 리셋 때 그대로 재개한다.

## self-launch 대체 경로

터미널이 Orca도 herdr도 아니면 `\omo-keepalive\` 아래에 한 번만 도는 예약 작업을 등록해
리셋 시각에 세션을 다시 띄운다. 등록에 실패하면 종료하지 않고 그 자리에서 기다린다.
작업은 스스로 지워지지 않는다. 다시 뜬 세션이 지운다. 세션이 끝내 돌아오지 않으면
작업이 남을 수 있으니 이렇게 지운다.

```powershell
Get-ScheduledTask -TaskPath \omo-keepalive\ | Unregister-ScheduledTask -Confirm:$false
```

## 세션별 스위치

`/keepalive off`, `/keepalive on`은 현재 세션만 끄고 켠다. 상태는
`~/.omo/keepalive/control/<sid>.json`에 저장된다.

```json
{"v":1,"mode":"off"}
```

## 화면

`/keepalive`만 입력하면 세 묶음으로 된 화면 하나가 뜬다.

- **한도.** `🔄 감시 중`, 한도 대기 중이면 상태 줄 문구와 남은 시간, 이 세션에서 껐으면 `⏹ 꺼짐 (이 세션)`. 그 아래 창별 사용량 막대와 리셋 시각. 한도 대기 중이 아니면 최근 한 시간 속도로 임계치에 닿는 시각을 예측 줄로 보여 줄 수 있다.
- **캐시.** ❤️‍🔥는 데우는 중이고, 언제까지(시각 또는 `재개까지`)와 다음 ping이 붙는다. 🩵는 데우지 않는 중이고, 이유 한 단어가 붙는다. 한도 대기 중이 아니면 데우는 동안 돌아올 확률을 예측 줄로 보여 줄 수 있다.
- **기록.** 오늘 ping, 적중, 아낀 토큰. 그리고 최근 7일 식은 복귀와 아낀 토큰.

한도 대기 중에는 예측 줄이 없다. 한도 대기 중의 🩵 단어는 대기 보류 이유다. 그 밖의 이유 단어: 시간 끝, 캐시 놓침, 맥락 작음, 시간 0, 이미 식음, 기준 없음, 대상 아님, 중복, 맥락 바뀜, 모델 바뀜, 정리 중, 횟수 끝, 상한, 오류 뒤, 취소 뒤, 취소, 실패, 맥락 모름, 꺼짐, 세션 닫힘, 시계 이상, 늦음, 다른 확장, 판단만 기록, 다른 인스턴스, 작업 중, 준비 중.

## goal 대기와 senpi backstop

goal이 무언가(터미널 monitor, 백그라운드 작업, workflow)를 기다리는 동안 senpi는 backstop을 건다. 대기가 멈춰도 goal이 영영 서 있지 않도록 한 시간쯤마다 숨은 continuation을 보낸다. 그 턴은 실제 모델 호출이고, 한 시간 쉬고 나면 프롬프트 캐시는 대개 식어 있다.

keepalive는 senpi의 `goal_continuation_timer_state`와 `wake_source_state` 이벤트를 본다. goal이 기다리는 동안 다음 턴까지 캐시를 데운다. backstop도 붙잡는데(source `omo-keepalive`로 `continuation_hold_state`를 낸다), 아래가 모두 맞을 때만 그렇게 한다.

- 이 세션에서 데우기가 실제로 돌고 있다(이득이 있고, 대상이고, 대기 또는 ping 중).
- 사용자 유예 대기나 사용자 질문 대기가 아니다.
- omo-health가 살아 있고 `goal-liveness`를 선언하며 이 세션을 깨울 수 있고, 이 세션 안의 센서 heartbeat가 최근 것이고 goal-liveness 스키마를 담고 있다.
- backstop 설정이 켜져 있다.

붙잡는 동안 생존 확인은 omo-health가 맡는다. 대기가 새어 버렸거나 조용해지면 omo-health가 세션을 직접 깨운다. 그 밖의 경우는 모두 지금과 같다. 조건 하나라도 빠지면 keepalive는 붙잡기를 풀고, senpi의 한 시간 backstop이 전처럼 돈다.

스스로 확인하는 장치가 있다. keepalive가 backstop을 붙잡았는데도 senpi가 그것을 보내면, keepalive는 backstop이 튕겼다고 표시하고 이 omo 프로세스가 끝날 때까지(같은 프로세스의 새 세션 포함) 더 붙잡지 않으며 화면에 알린다.

설정: `/keepalive set backstop on|off`(기본은 켜짐). 붙잡기는 maxHoldMinutes(기본 360, 30에서 1440까지) 뒤에도 끝나고, 그때 캐시 줄은 시간 끝을 보여 준다.

goal 대기 중 화면의 캐시 묶음에는 이런 줄이 붙는다.

- 데우기가 돌면 `❤️‍🔥 다음 턴까지`와 다음 ping 시각. 예측 줄은 없다.
- 돌지 않으면 `🩵`와 이유 단어: 이득 없음, 맥락 모름, 대상 아님, 꺼짐, 시간 끝, 준비 중, 또는 위 목록의 멈춤 단어.
- backstop을 붙잡는 동안 `대기  backstop 멈춤 · 확인은 omo-health`.
- 확인 장치가 튕기면 `대기  backstop 그대로 · senpi 바뀜`.

되돌리기: `/keepalive set backstop off`를 실행한다. 그러면 keepalive는 backstop을 붙잡지 않고, senpi의 한 시간 continuation은 keepalive가 없을 때와 똑같이 돈다.

## 명령

| 명령 | 하는 일 |
|---|---|
| `/keepalive` | 위의 화면 보기 (`/keepalive status`도 같다) |
| `/keepalive resume` | 한도 대기를 풀고 바로 재개. 여전히 임계치 위여도 재개 시점에 넘어 있던 창들이 리셋될 때까지 다시 대기하지 않는다(남은 사용량을 일부러 쓰는 것. 리셋 시각을 모르는 창은 보유하지 않는다). 그 밖의 창이 임계치를 넘거나, `/keepalive park`, `off` 뒤 `on`, 실제 한도 오류가 나면 다시 대기한다 |
| `/keepalive park` | 지금 세션 안에서 한도 대기. 현재 사용량이 이미 park 판정일 때만 동작하고, 아니면(사용량이 임계치 아래이거나 아직 판정이 없을 때) 대기를 걸지 않고 그 사실을 한 줄로 알린다 |
| `/keepalive off` / `on` | 이 세션에서 끄기 / 켜기 |
| `/keepalive set` | 설정 화면을 연다. 터미널 UI 밖에서는 설정 목록을 출력한다 |
| `/keepalive set <item> <value>` | 설정 하나를 바꾼다. item은 목록의 왼쪽 열이다. 예: `set threshold 5h 95`, `set wait claude 3h`, `set usd day 5` |
| `/keepalive set expiry <lane> <step\|auto>` | lane별 데우는 시간을 정한다 (`0`은 데우지 않음, `auto`는 복귀 습관 사용) |
| `/keepalive set habit auto` / `--return-rate <0-1> --median <dur> --t90 <dur>` | 복귀 습관을 기록에서 자동으로 두거나 직접 정하기. 돌아오는 비율, 복귀 시간 중앙값, 90%가 돌아오는 시간 (예: `--return-rate 0.8 --median 10m --t90 2h`) |
| `/keepalive set mode on\|shadow\|off` | 캐시 데우기 설정. `on`은 ping을 보내고, `shadow`는 판단만 기록하고, `off`는 아무것도 하지 않는다 |
| `/keepalive set backstop on\|off` | 데우기가 도는 동안 senpi goal backstop을 붙잡게 하기(`on`, 기본) 또는 절대 붙잡지 않기(`off`) |

## 설정 화면

설정 화면은 네 묶음으로 되어 있다.
- **한도:** 5시간·7일 임계치, 한도에 걸렸을 때 세션을 켜 둔 채 리셋을 기다리는 시간, 기다리는 동안 데우기.
- **캐시:** 캐시 데우기, goal backstop 붙잡기, goal이 기다릴 때 데우는 시간, 하루·자리 비울 때마다 비용 상한.
- **자리 비운 뒤 데우는 시간:** 구독·API별로 자리를 비운 뒤 캐시를 데워 두는 시간.
- **복귀 습관:** 자동 또는 직접, 돌아오는 비율, 절반이 돌아오는 시간, 90%가 돌아오는 시간.

키: `↑↓` 이동, `←→` 변경, `Enter`/`Space` 다음 값, `r` 기본값, `s` 저장, `q`/`Esc` 닫기 (저장하지 않은 변경이 있으면 두 번 누른다).

`enabled`를 제외한 모든 keepalive 설정값은 파일을 저장하는 즉시 실행 중인 모든 세션에 반영된다. 임계치, 리셋 기다리기, 기다리는 동안 데우기뿐 아니라 `pollMinIntervalMs`와 `resumeGraceMs`를 직접 편집한 값도 반영된다. 캐시·자리 비운 뒤 데우는 시간·복귀 습관 묶음의 설정은 실행 중인 세션에 5초 안에 반영된다. `enabled`만 파일을 편집한 뒤 `/reload`해야 한다. 읽을 수 없는 설정 파일은 절대 덮어쓰지 않는다.

## 하지 않는 일

- 토큰을 갱신하지 않는다.
- 다른 provider로 넘기지 않는다.
- 유료 초과 사용으로 넘기지 않는다.
- 도구를 등록하지 않는다.

## 개발

- 브랜치를 딴 git worktree에서 작업하고 `master`로 PR을 연다. `master`에 직접 push할 수 없고, PR은 `test` 체크가 통과해야 머지된다.
- 로컬 테스트는 `npm test`(`node --test`)로 돌린다. 엔진 테스트(`test/notice-request.test.mjs`, `test/senpi-store.test.mjs`)는 설치된 omo-ai(`bun add -g omo-ai`)가 필요하고, CI도 설치해서 돌린다.
- 작업 사본을 omo에서 잠깐 확인할 때만 `omo install C:/dev/omo/omo-keepalive`를 쓰고, 끝나면 git 설치로 되돌린다.
- 실제 테스트는 진짜 `~/.omo`, 돌고 있는 omo-health 데몬, 예약 작업을 건드리면 안 된다. `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `PI_CODING_AGENT_DIR`를 임시 폴더로 돌린다.
