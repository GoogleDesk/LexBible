# LexBrother

A personal law school companion. Paste e-textbook content into a per-course workspace, generate rigorous multiple-choice quizzes via the Claude API, and write case briefs that export to a clean Word document.

Single-user, browser-first with optional cloud sync. Data is always cached in browser `localStorage`, and can sync to Supabase so your courses/chapters/briefs/quizzes follow you across devices. Your Anthropic API key is stored only in your browser and is sent directly to Anthropic — nothing is proxied through a server.

## Features

- **Textbook** — paste a raw TOC (or upload a `.docx` / `.pdf`); Claude extracts chapters and cases. Paste each chapter's content to populate its case list.
- **Quizzes** — generate up to 500 questions per chapter using Claude Opus 4.7. Fact-based, application, or mixed. Focus area field lets you narrow questions to specific pages, a specific case, or a specific concept. Right-side navigation pane, flagging, progress is saved mid-quiz, multiple quiz sets per chapter with automatic overlap avoidance.
- **Case Briefs** — standard six-field brief template (Facts, Procedural History, Issue, Holding, Reasoning, Rule). Optional "red flag" AI review per field flags major omissions. Export all completed briefs as a plain Times New Roman Word document with standard 1" margins.

## Stack

Vanilla React 18 loaded via CDN, JSX compiled in-browser by `@babel/standalone`. No build step. Optional Supabase REST backend for cloud sync.

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

## Cloud sync (Supabase)

1. Create a Supabase project.
2. In SQL editor, run:

```sql
create table if not exists public.lexbrother_data (
  sync_id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.lexbrother_data enable row level security;

create policy "lexbrother read"
on public.lexbrother_data
for select
to anon
using (true);

create policy "lexbrother upsert"
on public.lexbrother_data
for insert
to anon
with check (true);

create policy "lexbrother update"
on public.lexbrother_data
for update
to anon
using (true)
with check (true);
```

3. In Supabase **Project Settings → API**, copy:
   - Project URL
   - `anon` public key
4. In LexBrother sidebar, click **☁** and paste:
   - Supabase URL
   - anon key
   - a private Sync ID (use the exact same value on every device)

After saving, LexBrother loads whichever copy is newer (local or cloud) and then keeps syncing automatically.

## Local backup

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

Clearing browser data or using incognito still wipes local cache, so keep cloud sync enabled (or export backups) for safety across devices.
