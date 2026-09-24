<h1 align="center">빛뜰 데스크 (Bitteul Desk)</h1>

<p align="center">
  Claude Code 세션이 사무실 직원이 되는 픽셀아트 대시보드.<br>
  직원을 누르면 그 세션의 대화 창이 열리고, 거기서 바로 답을 쓸 수 있어요.
</p>

<p align="center">
  <em>A pixel-art office where each Claude Code session is a staff member at a desk. Click one to read and reply in its own chat window.</em>
</p>

![빛뜰 데스크 사무실 화면](docs/screenshots/office.png)

## 이런 걸 해요

- **세션마다 직원 한 명.** 지금 돌고 있는 Claude Code 세션이 책상에 앉아 일해요. 모니터에는 작업 제목이 뜨고, 머리 위에는 지금 하는 일(파일 수정 중, 웹 조사 중 등)이 떠요.
- **일이 끝나면 딴짓.** 할 일을 마친 직원은 의자에서 내려와 산책하고, 기지개 켜고, 낮잠 자고, 커피를 마셔요.
- **누르면 대화 창.** 직원을 누르면 그 세션의 대화가 별도 창으로 열려요. 터미널처럼 읽기 편한 화면이라 여러 개 띄워 놓고 일하기 좋아요.
- **대시보드에서 바로 답장.** 대화 창에서 메시지를 보내면 그 세션이 이어서 일해요. 도구 사용 승인 요청이 오면 허용이나 거부를 누르면 돼요.
- **새 직원 부르기.** 왼쪽 위 **+ 새 직원** 버튼으로 새 세션을 시작해요.
- **층 늘리기와 자리 바꾸기.** 방 3개에 6자리가 한 층이고, 세션이 늘면 아래로 층이 생겨요. 직원을 꾹 눌러 끌면 자리를 옮기고, 다른 직원 자리에 놓으면 둘이 자리를 바꿔요.
- **방 이름표.** 방 위 이름표를 누르면 이름을 쓸 수 있어요. 자리와 이름은 다시 켜도 그대로예요.

| 대화 창                               | 세션이 늘면 층이 생겨요                      |
| ------------------------------------- | -------------------------------------------- |
| ![대화 창](docs/screenshots/chat.png) | ![두 층 사무실](docs/screenshots/floors.png) |

## 준비물

- [Node.js](https://nodejs.org) 20 이상
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 설치와 로그인. 터미널에서 `claude`가 실행되면 준비된 거예요.

## 설치하고 켜기

Claude Code를 쓰는 프로젝트 폴더에서 아래 한 줄을 실행하세요. 설치 과정 없이 바로 켜져요.

```bash
cd 내-프로젝트-폴더
npx https://github.com/Yewon419/bitteul-desk/releases/download/v0.1.0/bitteul-desk-0.1.0.tgz
```

켜지면 브라우저가 자동으로 사무실 화면을 열어요. 브라우저가 안 열리면 터미널에 찍힌 `Bitteul Desk office:` 주소를 직접 여세요. 끌 때는 터미널에서 **Ctrl+C**를 누르면 돼요.

매번 긴 주소를 치기 싫으면 전역으로 설치해 두세요.

```bash
npm install --global https://github.com/Yewon419/bitteul-desk/releases/download/v0.1.0/bitteul-desk-0.1.0.tgz
bitteul-desk
```

## 쓰는 법

1. 평소처럼 터미널에서 `claude`로 작업하세요. 같은 폴더의 세션이 몇 초 안에 직원으로 나타나요.
2. 직원을 누르면 대화 창이 열려요. 브라우저가 팝업을 막으면 화면 아래에 뜨는 링크를 누르거나, 주소창 오른쪽의 팝업 차단 아이콘에서 이 주소를 허용해 주세요.
3. 대화 창에서 **Enter**는 보내기, **Shift+Enter**는 줄바꿈이에요.

**터미널에 열려 있는 세션은 보기 전용이에요.** 두 곳에서 한 세션에 동시에 쓰면 대화가 꼬여서 막아 뒀어요. 터미널에서 그 세션을 닫으면 대시보드에서 이어받아 답할 수 있어요. 대시보드에서 **+ 새 직원**으로 시작한 세션은 처음부터 대시보드에서 주고받아요.

## 옵션

```bash
bitteul-desk --port 3100      # 포트 고정 (기본은 빈 포트 자동 선택)
bitteul-desk --no-open        # 브라우저 자동 열기 끄기
bitteul-desk --host 127.0.0.1 # 접속 주소 (기본값)
bitteul-desk --help
```

- **다른 폴더의 세션까지 보고 싶을 때:** 터미널에 함께 찍히는 `Classic Pixel Agents:` 주소를 열고 Settings에서 **Watch All Sessions**를 켜세요. 기본은 실행한 폴더의 세션만 보여요.
- **`claude`를 못 찾는다는 오류가 날 때:** 환경변수 `BITTEUL_CLAUDE_EXE`에 claude 실행 파일 경로를 넣고 다시 켜세요.

## 보안 안내

터미널에 찍히는 주소 끝의 `?token=...`은 비밀번호와 같아요. 이 토큰이 있는 화면은 에이전트에게 메시지를 보내고 도구 사용을 승인할 수 있어요. 주소를 채팅방이나 화면 공유에 그대로 올리지 마세요.

토큰을 뺀 `/scene.html` 주소는 보기 전용이에요. 대화 창과 답장 기능 없이 사무실만 보여서 화면 녹화나 방송용으로 쓰기 좋아요.

기본 설정은 내 컴퓨터(`127.0.0.1`)에서만 접속돼요. `--host 0.0.0.0`으로 바꾸면 같은 네트워크의 다른 기기도 들어올 수 있으니 믿을 수 있는 네트워크에서만 쓰세요.

## 소스에서 빌드하기

```bash
git clone https://github.com/Yewon419/bitteul-desk.git
cd bitteul-desk
npm install
npm run build
node dist/cli.js
```

화면 코드는 `webview-ui/src/scene/`(사무실)와 `webview-ui/src/chat/`(대화 창)에 있고, 서버 쪽 대시보드 API는 `server/src/httpServer.ts`에 있어요. 사무실 그림과 직원 도트를 만드는 스크립트는 `art/`에 있어요. 벽 게시판에 뜨는 D-day와 월급 문구는 `webview-ui/public/scene/company.json`에서 바꿀 수 있어요.

## 만든 방법과 출처

빛뜰 데스크는 [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents)(MIT, © 2026 Pablo De Lucca)를 포크해서 만들었어요. 세션 감지와 서버 구조는 원본을 그대로 쓰고, 그 위에 사무실 화면과 대화 창, 대시보드 API를 얹었어요. 원본 안내문은 [docs/UPSTREAM_README.md](docs/UPSTREAM_README.md)에 그대로 남겨 뒀어요.

- **그림:** 번들된 캐릭터, 가구, 바닥, 벽 그림은 이 포크에서 새로 그렸어요(`art/`). 사무실 배경은 이 프로젝트용으로 생성했고, Clawd 모양 직원은 한 점씩 찍었어요(`art/clawd.py`).
- **폰트:** [Galmuri](https://github.com/quiple/galmuri) (SIL OFL 1.1)
- **대화 연결:** [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)로 대시보드가 맡은 세션에 메시지를 보내요.

## 라이선스

[MIT License](LICENSE)
