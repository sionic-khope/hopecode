<p align="center"><img src="docs/logo.png" width="128" alt="Hopecode"></p>

# Hopecode

A macOS desktop harness for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions: threads in a native chat UI, a per-thread terminal, and a pool of subscription accounts that rotates automatically when a usage limit is reached.

> Hopecode is an independent project and is not affiliated with or endorsed by Anthropic.

## Features

- **Threads** — Claude Code sessions (via the Claude Agent SDK) rendered as a native chat: streaming text, tool cards, diff view, permission prompts, per-thread model and permission mode. Each thread gets its own git worktree and survives app restarts (resume).
- **Terminal sidebar** — a shell per thread, opened in the thread's worktree (⌘J).
- **Account pool** — register several Claude subscription accounts (OAuth, isolated `CLAUDE_CONFIG_DIR` each, with `~/.claude` settings shared via symlinks). When the active account hits a limit, the next turn continues on the next available account with the same conversation. When every account is exhausted the thread waits and resumes automatically after the earliest reset. Extra-usage (overage) billing is never used.
- **Usage statusline** — pool-averaged 5h / weekly / Fable usage with time to the earliest reset, session time, context usage and `N/M avail`. Click for a per-account breakdown.
- **Accounts page** — add, rename, recolor, reorder (priority), enable/disable, pin to a thread, usage charts.

## Development

```bash
npm install
npm run dev          # run the app
npm run typecheck
npm test             # unit / integration (vitest)
npm run test:e2e     # Playwright + Electron, hidden window, fixture mode
npm run dist:dir     # build dist/mac-arm64/Hopecode.app
```

Requirements: macOS (Apple Silicon), Node 22+.

## Notes

- Usage numbers come from an undocumented OAuth usage endpoint used by Claude Code itself; it may change. Account rotation also works from Agent SDK rate-limit events alone.
- Only use accounts that belong to you, and review Anthropic's terms for your plan.
- 에이전트 로고: 공식 로고 에셋(예: Claude Code)을 `src/renderer/assets/agents/claude-code.svg`에 넣으면 에이전트 선택 칩과 대화 아바타에 표시됩니다. 파일이 없으면 Hopecode의 중립 아이콘을 씁니다.
