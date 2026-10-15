# omo-limitless

[English](README.md) | 한국어

goal이 도는 OMO 세션이 구독 사용량 한도에 닿으면 세션을 한도 대기(park) 상태로 멈춰 두었다가
리셋 시각에 이어서 돌리는 Senpi/OMO 확장이다.

## 설치

클론 없이 한 줄로 설치한다. Windows (PowerShell 5.1):

```powershell
irm https://raw.githubusercontent.com/yjacket/omo-limitless/master/install.ps1 | iex
```

Linux, macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/yjacket/omo-limitless/master/install.sh | sh
```

스크립트가 이 저장소의 `master` 브랜치를 받아 `extension/` 폴더를 `~/.omo/agent/extensions/omo-limitless/`(또는 `OMO_CODING_AGENT_DIR`가 가리키는 폴더 아래)에 설치한다. 새 폴더를 옆에 만든 뒤 기존 폴더와 바꾸므로, 업데이트 중에 옛 파일과 새 파일이 섞이지 않는다. 클론한 폴더에서 `.\install.ps1`이나 `sh install.sh`로 실행하면 받지 않고 그 폴더의 파일을 복사한다. 그다음 실행 중인 omo 세션에서 `/reload`를 입력한다.

Windows에서는 PowerShell 줄을 쓴다. Git Bash의 curl은 Windows 인증서 저장소를 읽지 않아 인증서 오류(60)로 실패할 수 있다.

**업데이트:** 같은 줄을 다시 실행한다.

## 동작

- goal이 실행 중이고 5시간 창 사용률이 90%, 또는 7일 창이 95% 이상이면 다음 턴 경계에서 한도 대기에 들어간다. 오늘 리셋이면 상태 줄에 `⏸ 한도 대기 · HH:MM 재개`, 다른 날 리셋이면 `⏸ 한도 대기 · M/D HH:MM 재개`가 뜬다.
- 리셋까지 남은 시간이 레인의 `waitLimitMs` 이하면 세션 안에서 기다린다. 길면 park 기록을 남기고 종료한 뒤 리셋 때 다시 띄운다.
- 기다리는 동안 warm 턴을 보내 프롬프트 캐시를 살려 둔다.
- 리셋 시각(+ `resumeGraceMs`)이 지나면 goal을 재개한다.
- 사용량 조회 전에 provider가 한도 오류를 돌려주면 그 자리에서 반응형 park를 한다. 오류에 리셋 시각이 없으면 상태 줄에 `⏸ 한도 대기 · 재개 시각 미정`이 뜨고, 30분 뒤 사용량을 확인한다. 한도가 풀렸거나 사용량을 읽을 수 없으면 park를 해제한다. 아직 한도를 넘었으면 일반 사용량 park로 바뀌어, 리셋 시각에 재개하거나 리셋 시각을 여전히 모르면 `pollMinIntervalMs`(최소 60초)마다 다시 확인한다. 확인이 실패하면 30분마다 다시 시도하고, 성공한 확인 없이 6시간이 지나면 park를 해제한다.
- limitless가 goal을 멈춰 둔 동안에는 자동 실행(goal 이어가기, todo 알림, 알림 메시지, 다른 세션이 보낸 메시지)은 도구를 하나도 쓰지 않는다. 직접 입력한 메시지와 `/loop`나 훅이 대신 보낸 프롬프트는 서브에이전트 생성(`task`, `task_create`)을 뺀 도구를 그대로 쓴다. 파크가 시작될 때 이미 백그라운드에서 돌던 작업은 멈추지 않는다.

## 설정

`~/.omo/limitless/config.json`. 없는 키는 기본값을 쓴다. 잘못된 값은 기본값으로 돌아가고, 세션 시작 때 잘못된 키를 적은 경고 알림이 한 번 뜬다(최대 3개, 나머지는 `외 N개`).

| 키 | 기본값 | 설명 |
|---|---|---|
| `thresholds.fiveHour` | `90` | 5시간 창 사용률(%) 기준. 이 값 이상이면 park |
| `thresholds.sevenDay` | `95` | 7일 창 사용률(%) 기준. 이 값 이상이면 park |
| `waitLimitMs.anthropic-subscription` | `14400000` | 리셋까지 이 시간(ms) 이하면 세션 안에서 대기, 넘으면 종료 후 재실행 |
| `waitLimitMs.chatgpt-subscription` | `7200000` | 위와 같음 (ChatGPT 구독) |
| `warm.anthropic-subscription.on` | `true` | 대기 중 warm 턴 사용 |
| `warm.anthropic-subscription.intervalMs` | `3300000` | warm 턴 간격(ms) |
| `warm.chatgpt-subscription.on` | `true` | 대기 중 warm 턴 사용 |
| `warm.chatgpt-subscription.intervalMs` | `1620000` | warm 턴 간격(ms) |
| `warm.chatgpt-subscription.requireTtlSeconds` | `1800` | Codex 모델은 프롬프트 캐시 TTL이 이 값(초)과 같을 때만 warm 한다. TTL이 다른 모델은 warm 하지 않는다 |
| `enabled` | `true` | 전역 스위치 |
| `pollMinIntervalMs` | `60000` | 사용량 조회 최소 간격(ms) |
| `resumeGraceMs` | `60000` | 리셋 시각 뒤 재개 전 여유(ms) |

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
- 대기 중인 omo-desk 보드
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

터미널이 Orca도 herdr도 아니면 `\omo-limitless\` 아래에 한 번만 도는 예약 작업을 등록해
리셋 시각에 세션을 다시 띄운다. 등록에 실패하면 종료하지 않고 그 자리에서 기다린다.
작업은 스스로 지워지지 않는다. 다시 뜬 세션이 지운다. 세션이 끝내 돌아오지 않으면
작업이 남을 수 있으니 이렇게 지운다.

```powershell
Get-ScheduledTask -TaskPath \omo-limitless\ | Unregister-ScheduledTask -Confirm:$false
```

## 세션별 스위치

`/limitless off`, `/limitless on`은 현재 세션만 끄고 켠다. 상태는
`~/.omo/limitless/control/<sid>.json`에 저장된다.

```json
{"v":1,"mode":"off"}
```

## 명령

| 명령 | 하는 일 |
|---|---|
| `/limitless status` | 여섯 줄 출력: 상태 줄(대기 중이 아니면 `⏸ 한도 대기 없음`), `상태:` 한도 대기 상태, `사용량:` 창별 사용률, `리셋:` 리셋 시각(HH:MM, 다른 날이면 M/D HH:MM, 모르면 `unknown`), `출처:` 사용량 출처, `스위치:` 켜짐/꺼짐 |
| `/limitless resume` | 한도 대기를 풀고 바로 재개. 여전히 임계치 위여도 재개 시점에 넘어 있던 창들이 리셋될 때까지 다시 대기하지 않는다(남은 사용량을 일부러 쓰는 것. 리셋 시각을 모르는 창은 보유하지 않는다). 그 밖의 창이 임계치를 넘거나, `/limitless park`, `off` 뒤 `on`, 실제 한도 오류가 나면 다시 대기한다 |
| `/limitless park` | 지금 세션 안에서 한도 대기. 현재 사용량이 이미 park 판정일 때만 동작하고, 아니면(사용량이 임계치 아래이거나 아직 판정이 없을 때) 대기를 걸지 않고 그 사실을 한 줄로 알린다 |
| `/limitless off` / `on` | 이 세션에서 끄기 / 켜기 |

## 하지 않는 일

- 토큰을 갱신하지 않는다.
- 다른 provider로 넘기지 않는다.
- 유료 초과 사용으로 넘기지 않는다.
- 도구를 등록하지 않는다.
