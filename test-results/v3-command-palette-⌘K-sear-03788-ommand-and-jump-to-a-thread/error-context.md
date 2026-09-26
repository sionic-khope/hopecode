# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: v3.spec.ts >> command palette (⌘K): search, then run a command and jump to a thread
- Location: tests/e2e/v3.spec.ts:295:1

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator: locator('.app__thread-name')
Expected: "README 인사말을 바꿔 주세요"
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toHaveText" locator('.app__thread-name') with timeout 15000ms
  - waiting for locator('.app__thread-name')

```

```yaml
- complementary:
  - button "사이드바 숨기기 (⌘B)"
  - text: Hopecode
  - button "스레드 검색"
  - navigation "탐색":
    - button "새 채팅 ⌘N"
    - button "검색"
    - button "계정 3/3"
    - button "설정 ⌘,"
  - region "프로젝트":
    - button "프로젝트" [expanded]:
      - text: 프로젝트
      - img
    - button "프로젝트 추가":
      - img
    - button "hopecode-e2e-repo-G3Aaj7" [expanded]
    - button "hopecode-e2e-repo-G3Aaj7 작업":
      - img
    - button "hopecode-e2e-repo-G3Aaj7에서 새 채팅":
      - img
    - list "hopecode-e2e-repo-G3Aaj7 스레드":
      - listitem:
        - button "README 인사말을 바꿔 주세요 방금"
        - button "README 인사말을 바꿔 주세요 고정":
          - img
        - button "README 인사말을 바꿔 주세요 보관":
          - img
      - listitem:
        - button "[text] worktree 없이 작업 방금"
        - button "[text] worktree 없이 작업 고정":
          - img
        - button "[text] worktree 없이 작업 보관":
          - img
  - 'button "프로필: Personal (Max)"': Personal personal@example.com Max
- main:
  - button "뒤로"
  - heading "설정" [level=1]
  - paragraph: 새 채팅의 기본값, 계정 전환, 공유 설정과 데이터를 관리합니다.
  - region "일반":
    - heading "일반" [level=2]
    - paragraph: 새 채팅을 시작할 때 쓰는 값입니다. 이미 시작된 채팅은 바뀌지 않습니다.
    - text: 기본 모델 기본은 지금 Fable 5.1로 실행됩니다
    - 'button "기본 모델: 기본 (Fable 5.1)"': 기본 (Fable 5.1)
    - text: 기본 effort 모델의 추론 깊이
    - radiogroup "기본 effort":
      - radio "자동" [checked]
      - radio "Low"
      - radio "Medium"
      - radio "High"
      - radio "XHigh"
      - radio "Max"
    - text: 기본 권한 모드 전체 액세스는 채팅마다 확인을 거쳐 켭니다
    - radiogroup "기본 권한 모드":
      - radio "기본" [checked]
      - radio "계획"
      - radio "편집 자동 승인"
    - text: 새 스레드마다 worktree 만들기 git 저장소에서는 스레드마다 hopecode/<id> 브랜치의 worktree에서 작업합니다
    - switch "새 스레드마다 worktree 만들기" [checked]
    - text: 유휴 세션 종료 이 시간 동안 입력이 없으면 세션을 닫습니다. 다음 메시지에서 이어집니다 (0 = 닫지 않음)
    - spinbutton "유휴 세션 종료 (분)": "10"
    - text: 분 기본 에디터 대화 화면의 ‘에디터에서 열기’ 버튼이 여는 앱
    - 'button "기본 에디터: 자동 (Visual Studio Code)"': 자동 (Visual Studio Code)
    - text: 알림 창이 뒤에 있을 때 턴 완료, 권한 요청, 계정 전환을 알립니다
    - switch "알림" [checked]
    - text: "New Task Start 템플릿 새 채팅 화면의 'New Task Start' 버튼(⌘⇧N)이 입력창에 붙여넣는 문구입니다. {project}는 폴더 이름, {date}는 오늘 날짜로 바뀝니다"
    - textbox "New Task Start 템플릿": 작업 시작 전에 다음을 순서대로 해 주세요. 1. git pull로 base 브랜치를 최신 상태로 맞추기 2. 이번 작업용 worktree와 branch 만들기 3. CLAUDE.md, context.md를 읽고 프로젝트 규칙과 컨텍스트 파악하기 4. 최근 변경사항(CHANGES.md 또는 git log 최근 커밋) 확인하기 5. 파악한 내용을 짧게 요약하고 다음 지시를 기다리기
    - text: 213 / 4000
    - button "기본값으로 되돌리기"
  - region "계정":
    - heading "계정" [level=2]
    - paragraph: 계정 3개 · 활성 3개
    - text: 한도 도달 시 자동 전환 한도에 도달하면 다음 계정으로 이어서 실행합니다
    - switch "한도 도달 시 자동 전환" [checked]
    - text: 사용량 조회 간격 계정마다 이 간격으로 사용량을 새로 받아옵니다
    - slider "사용량 조회 간격 (초)": "120"
    - status: 2분
  - region "공유 설정":
    - heading "공유 설정" [level=2]
    - paragraph: /var/folders/45/9gtdct614mz4rplqs209nykm0000gn/T/hopecode-e2e-home-9SU8Kz/home/fixture-claude의 항목을 계정마다 링크해 같은 설정·스킬·훅을 씁니다
    - button "다시 연결"
    - list "공유 항목":
      - listitem:
        - code: CLAUDE.md
        - text: 원본 없음
      - listitem:
        - code: settings.json
        - text: 원본 없음
      - listitem:
        - code: plugins
        - text: 원본 없음
      - listitem:
        - code: hooks
        - text: 원본 없음
      - listitem:
        - code: skills
        - text: 원본 없음
      - listitem:
        - code: agents
        - text: 원본 없음
      - listitem:
        - code: output-styles
        - text: 원본 없음
  - region "데이터":
    - heading "데이터" [level=2]
    - text: 데이터 폴더 /var/folders/45/9gtdct614mz4rplqs209nykm0000gn/T/hopecode-e2e-home-9SU8Kz/userData
    - button "열기"
    - text: 보관된 스레드 보관된 스레드가 없습니다
    - button "모두 삭제…" [disabled]
- region "오른쪽 패널"
- contentinfo:
  - button "Fable 5.1 5h 47% · 2h0m wk 29% · 3d0h fable 13% · 3d0h session 0m ctx 31% 2/3 avail"
- dialog "명령 팔레트":
  - combobox "명령 검색" [expanded]: ㅅㅈREADME 인사말
  - status: 일치하는 항목이 없습니다
```

# Test source

```ts
  211 |   await startThread(page, sandbox, 'README 인사말을 바꿔 주세요');
  212 |   const permission = page.locator('.hc-permission');
  213 |   await expect(permission).toBeVisible();
  214 |   await screenshot(page, 'v3-conversation-permission', SHOTS);
  215 |   await permission.getByRole('button', { name: '허용', exact: true }).click();
  216 |   await expect(page.locator('.hc-messages')).toContainText('Done. The greeting now says "Hello Hopecode".');
  217 |   await page.locator('.hc-tool').filter({ hasText: 'Edit' }).locator('.hc-tool__header').click();
  218 |   await expect(page.locator('.hc-tool .hc-diff__row--add')).toContainText('Hello Hopecode');
  219 |   await page.mouse.move(10, 700);
  220 |   await screenshot(page, 'v3-conversation', SHOTS);
  221 | 
  222 |   const toolbar = page.getByRole('toolbar', { name: '스레드 도구' });
  223 |   await expect(toolbar).toBeVisible();
  224 |   await screenshotOf(page, page.locator('.app__titlebar--chat'), 'v3-toolbar', SHOTS);
  225 |   await toolbar.getByRole('button', { name: '변경사항 패널' }).click();
  226 |   const panel = page.getByTestId('changes-panel');
  227 |   await expect(panel).toBeVisible();
  228 |   const file = panel.locator('.hc-changes__file[data-path="README.md"]');
  229 |   await expect(file).toBeVisible();
  230 |   await expect(panel.locator('.hc-changes__badge--M')).toBeVisible();
  231 |   await file.click();
  232 |   await expect(panel.locator('.hc-diff__row--add')).toContainText('Hello Hopecode');
  233 |   await page.mouse.move(10, 700);
  234 |   await screenshot(page, 'v3-changes-panel', SHOTS);
  235 | });
  236 | 
  237 | test('commit (auto message), then merge into the project branch', async () => {
  238 |   const { page } = run;
  239 |   const { threads } = await bootstrapState(page);
  240 |   const thread = threads.find((t) => t.title === 'README 인사말을 바꿔 주세요')!;
  241 |   await page.getByRole('button', { name: '커밋', exact: true }).click();
  242 |   const pop = page.getByRole('dialog', { name: '커밋' });
  243 |   await expect(pop).toBeVisible();
  244 |   await pop.getByRole('button', { name: '자동 생성' }).click();
  245 |   const message = pop.getByRole('textbox', { name: '커밋 메시지' });
  246 |   await expect(message).toHaveValue(/README\.md 수정/);
  247 |   await screenshot(page, 'v3-commit', SHOTS);
  248 |   await pop.getByRole('button', { name: '커밋', exact: true }).click();
  249 |   await expect(pop.getByRole('status')).toContainText('커밋했습니다');
  250 |   expect(git(thread.worktree!.path, 'log', '-1', '--format=%s')).toBe('README.md 수정');
  251 |   expect(git(thread.worktree!.path, 'status', '--porcelain')).toBe('');
  252 | 
  253 |   await pop.getByRole('button', { name: /원래 브랜치에 병합/ }).click();
  254 |   const confirm = page.getByRole('dialog', { name: '원래 브랜치에 병합할까요?' });
  255 |   await expect(confirm).toBeVisible();
  256 |   await expect(confirm).toContainText(thread.worktree!.branch);
  257 |   await confirm.getByRole('button', { name: '병합', exact: true }).click();
  258 |   await expect(confirm).toContainText('병합했습니다');
  259 |   expect(readFileSync(join(sandbox.project, 'README.md'), 'utf8')).toContain('Hello Hopecode');
  260 |   await confirm.locator('.hc-modal__actions').getByRole('button', { name: '닫기' }).click();
  261 | });
  262 | 
  263 | test('Push + PR goes through a confirm naming the remote and branches (fixture publisher)', async () => {
  264 |   const { page } = run;
  265 |   await page.getByRole('button', { name: '커밋', exact: true }).click();
  266 |   const pop = page.getByRole('dialog', { name: '커밋' });
  267 |   const pushItem = pop.getByRole('button', { name: /Push \+ PR 만들기/ });
  268 |   await expect(pushItem).toBeEnabled();
  269 |   await pushItem.click();
  270 |   const confirm = page.getByRole('dialog', { name: 'Push하고 PR을 만들까요?' });
  271 |   await expect(confirm).toContainText('origin');
  272 |   await expect(confirm).toContainText('main');
  273 |   await screenshot(page, 'v3-push-pr-confirm', SHOTS);
  274 |   await confirm.getByRole('button', { name: 'Push + PR 만들기' }).click();
  275 |   await expect(confirm.locator('code.hc-commit__url')).toHaveText('https://github.com/example/hopecode-fixture/pull/1');
  276 |   await confirm.locator('.hc-modal__actions').getByRole('button', { name: '닫기' }).click();
  277 |   // Nothing reached the bare origin: the fixture publisher records instead of pushing.
  278 |   expect(git(origin, 'branch', '--list')).toBe('');
  279 | });
  280 | 
  281 | test('terminal lives in the right panel as a tab (⌘J)', async () => {
  282 |   const { page } = run;
  283 |   const app = page.locator('.app');
  284 |   await menuShortcut(run.app, 'CmdOrCtrl+J');
  285 |   await expect(app).toHaveClass(/app--terminal-open/);
  286 |   await expect(page.getByTestId('terminal').locator('.xterm')).toBeVisible();
  287 |   await expect(page.getByRole('radiogroup', { name: '패널' }).getByRole('radio', { name: /터미널/ })).toHaveAttribute('aria-checked', 'true');
  288 |   await page.getByRole('radiogroup', { name: '패널' }).getByRole('radio', { name: /변경사항/ }).click();
  289 |   await expect(page.getByTestId('changes-panel')).toBeVisible();
  290 |   await expect(app).toHaveClass(/app--terminal-closed/);
  291 |   await menuShortcut(run.app, 'CmdOrCtrl+Shift+D');
  292 |   await expect(app).toHaveClass(/app--panel-closed/);
  293 | });
  294 | 
  295 | test('command palette (⌘K): search, then run a command and jump to a thread', async () => {
  296 |   const { page } = run;
  297 |   await menuShortcut(run.app, 'CmdOrCtrl+K');
  298 |   const palette = page.getByTestId('command-palette');
  299 |   await expect(palette).toBeVisible();
  300 |   await expect(page.getByRole('combobox', { name: '명령 검색' })).toBeFocused();
  301 |   await page.keyboard.type('ㅅㅈ');
  302 |   await expect(palette.getByRole('option').first()).toContainText('설정');
  303 |   await screenshot(page, 'v3-palette', SHOTS);
  304 |   await page.keyboard.press('Enter');
  305 |   await expect(palette).toHaveCount(0);
  306 |   await expect(page.getByTestId('settings')).toBeVisible();
  307 | 
  308 |   await menuShortcut(run.app, 'CmdOrCtrl+K');
  309 |   await page.keyboard.type('README 인사말');
  310 |   await page.keyboard.press('Enter');
> 311 |   await expect(page.locator('.app__thread-name')).toHaveText('README 인사말을 바꿔 주세요');
      |                                                   ^ Error: expect(locator).toHaveText(expected) failed
  312 | });
  313 | 
  314 | test('code block: language label and copy (clipboard stubbed, the real one is untouched)', async () => {
  315 |   const { page } = run;
  316 |   await sendMessage(page, '[code] 인사 함수');
  317 |   const block = page.locator('.hc-code').last();
  318 |   await expect(block).toBeVisible();
  319 |   await expect(block.locator('.hc-code__lang')).toHaveText('ts');
  320 |   await page.evaluate(() => {
  321 |     const w = window as unknown as { __copied: string[] };
  322 |     w.__copied = [];
  323 |     Clipboard.prototype.writeText = async (text: string) => {
  324 |       w.__copied.push(text);
  325 |     };
  326 |   });
  327 |   await block.getByRole('button', { name: '코드 복사' }).click();
  328 |   await expect(block.getByRole('button', { name: '복사됨' })).toBeVisible();
  329 |   const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
  330 |   expect(copied).toEqual(['export function greet(name: string): string {\n  return `Hello ${name}`;\n}']);
  331 | });
  332 | 
  333 | test('user message: 편집해서 다시 보내기 puts the text back in the composer; thread title renames in place', async () => {
  334 |   const { page } = run;
  335 |   const bubble = page.locator('.hc-msg-user').filter({ hasText: '[code] 인사 함수' });
  336 |   await bubble.hover();
  337 |   await bubble.getByRole('button', { name: '편집해서 다시 보내기' }).click();
  338 |   await expect(page.locator('.hc-composer__textarea')).toHaveValue('[code] 인사 함수');
  339 |   await page.locator('.hc-composer__textarea').fill('');
  340 | 
  341 |   await page.locator('.app__thread-name').click();
  342 |   const input = page.getByRole('textbox', { name: '스레드 이름' });
  343 |   await input.fill('인사말 작업');
  344 |   await input.press('Enter');
  345 |   await expect(page.locator('.app__thread-name')).toHaveText('인사말 작업');
  346 |   await expect(page.getByTestId('sidebar').locator('.hc-thread__title').filter({ hasText: '인사말 작업' })).toHaveCount(1);
  347 | });
  348 | 
  349 | test('model menu names the current lineup (Fable 5.1)', async () => {
  350 |   const { page } = run;
  351 |   await openDraft(page);
  352 |   const model = page.getByTestId('draft').locator('.hc-chip--model');
  353 |   await expect(model).toContainText('Fable 5.1');
  354 |   await expect(page.getByTestId('statusline').locator('.hc-statusline__model')).toHaveText('Fable 5.1');
  355 |   await model.click();
  356 |   const menu = page.getByRole('menu', { name: '모델' });
  357 |   await expect(menu.getByRole('group', { name: '모델' }).locator('.hc-mnu__label')).toHaveText([
  358 |     '기본 (Fable 5.1)',
  359 |     'Fable 5.1',
  360 |     'Opus 5.5',
  361 |     'Sonnet 5',
  362 |     'Haiku 4.5',
  363 |   ]);
  364 |   await screenshot(page, 'v3-model-menu', SHOTS);
  365 |   await page.keyboard.press('Escape');
  366 |   await page.getByTestId('sidebar').getByRole('button', { name: /^계정/ }).click();
  367 |   await expect(page.locator('.hc-accounts-page')).toBeVisible();
  368 |   await page.mouse.move(10, 700);
  369 |   await screenshot(page, 'v3-accounts', SHOTS);
  370 |   await screenshotOf(page, page.getByTestId('statusline'), 'v3-statusline', SHOTS);
  371 | });
  372 | 
```