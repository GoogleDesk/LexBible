# LexBrother

A personal law school companion. Paste e-textbook content into a per-course workspace, generate rigorous multiple-choice quizzes via the Claude API, and write case briefs that export to a clean Word document.

Single-user, browser-only. All data lives in your browser's `localStorage`. Your Anthropic API key is stored only in your browser and is sent directly to Anthropic — nothing is proxied through a server.

## Features

- **Textbook** — paste a raw TOC (or upload a `.docx` / `.pdf`); Claude extracts chapters and cases. Paste each chapter's content to populate its case list.
- **Quizzes** — generate up to 500 questions per chapter using Claude Opus 4.7. Fact-based, application, or mixed. Focus area field lets you narrow questions to specific pages, a specific case, or a specific concept. Right-side navigation pane, flagging, progress is saved mid-quiz, multiple quiz sets per chapter with automatic overlap avoidance.
- **Case Briefs** — standard six-field brief template (Facts, Procedural History, Issue, Holding, Reasoning, Rule). Optional "red flag" AI review per field flags major omissions. Export all completed briefs as a plain Times New Roman Word document with standard 1" margins.

## Stack

Vanilla React 18 loaded via CDN, JSX compiled in-browser by `@babel/standalone`. No build step. No backend. Data persists in `localStorage` only.

```
index.html        # App shell, loads React + Babel + all components
js/
  storage.js      # Data layer + Anthropic API calls
  App.jsx         # Root component
  Sidebar.jsx     # Course list + API key modal
  CourseView.jsx  # Tab shell
  TextbookTab.jsx # TOC + chapter content
  QuizTab.jsx     # Quiz generation + taking
  CaseBriefsTab.jsx # Case briefs + Word export
```

## Running locally

Because browsers block some features when opening files via `file://`, serve the folder over a local HTTP server:

```bash
# Python 3
python3 -m http.server 8080

# Or: any static server
npx serve .
```

Then open http://localhost:8080.

## Deploy to Cloudflare Pages

1. Push this repo to GitHub (instructions below).
2. Go to **Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git**.
3. Select the `LexBrother` repo.
4. On the build config screen, **leave the framework preset as "None"** and **leave the build command empty**. Set the **build output directory** to `/` (the repo root).
5. Click Save and Deploy.

That's it. Cloudflare will serve `index.html` at the site URL. Every future `git push` to the main branch triggers an auto-deploy.

## Setting up your Anthropic API key

1. Go to https://console.anthropic.com, create an account, add a credit card (minimum $5).
2. **Settings → API Keys → Create Key.** Copy it (starts with `sk-ant-…`).
3. In LexBrother, click the **⚙** icon at the bottom-left of the sidebar. Paste your key, hit Save.
4. The key lives only in your browser's localStorage and is sent directly to Anthropic on every request. It is never stored or logged anywhere else.

Without a key, the app falls back to a built-in quota (rate-limited and capped at 30 questions per quiz). With a key, you get up to 500 questions and full TOC cleanup on Claude Opus 4.7.

## Data backup

All data is in one localStorage key: `lexbrother_v1`. To back up manually:

```js
// Browser console
copy(localStorage.getItem('lexbrother_v1'));  // copies full JSON to clipboard
```

To restore:

```js
localStorage.setItem('lexbrother_v1', /* paste JSON string */);
location.reload();
```

Clearing browser data, using incognito, or switching devices wipes it. A future upgrade path would be to add Supabase or a similar backend for cloud sync.
