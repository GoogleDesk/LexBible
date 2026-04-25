# LexBrother

A personal law school companion. Paste e-textbook content into a per-course workspace, generate rigorous multiple-choice quizzes via the Claude API, and write case briefs that export to a clean Word document.

Data is stored in your own Supabase project so you can work seamlessly across laptop, desktop, and phone. Your Anthropic API key also syncs across devices.

## Features

- **Textbook** — paste a raw TOC (or upload a `.docx` / `.pdf`); Claude extracts chapters and cases. Paste each chapter's content to populate its case list.
- **Quizzes** — generate up to 500 questions per chapter using Claude Opus 4.7. Fact-based, application, or mixed. Focus area field lets you narrow questions to specific pages, a specific case, or a specific concept. Right-side navigation pane, flagging, progress is saved mid-quiz, multiple quiz sets per chapter with automatic overlap avoidance.
- **Case Briefs** — standard six-field brief template (Facts, Procedural History, Issue, Holding, Reasoning, Rule). Optional "red flag" AI review per field flags major omissions. Export all completed briefs as a plain Times New Roman Word document with standard 1" margins.

## Stack

Vanilla React 18 loaded via CDN, JSX compiled in-browser by `@babel/standalone`. No build step. No server. Data lives in a Supabase Postgres row; the browser talks to Supabase directly.

```
index.html         # App shell, loads React + Babel + Supabase + all components
js/
  config.js        # Your Supabase URL + anon key (you fill these in)
  storage.js       # Data layer (cloud sync + Anthropic API calls)
  AuthScreen.jsx   # Sign-in (magic-link email)
  App.jsx          # Root component, auth gate, data load
  Sidebar.jsx      # Course list + API key + sign-out
  CourseView.jsx   # Tab shell
  TextbookTab.jsx  # TOC + chapter content
  QuizTab.jsx      # Quiz generation + taking
  CaseBriefsTab.jsx # Case briefs + Word export
```

## First-time cloud setup (do this once, ~10 minutes)

This is a one-time setup. After this, you sign in with an email link on each device and everything syncs.

### 1. Create a free Supabase project

1. Go to **https://supabase.com** and click **Start your project** (or **Sign in**). Sign up with GitHub or email.
2. Once signed in, click **New project**.
3. Fill in:
   - **Name:** `lexbrother` (or anything)
   - **Database password:** click the generator button, then save the password somewhere safe (you won't need it for LexBrother, but Supabase requires one)
   - **Region:** pick whichever is closest to you
4. Click **Create new project**. Wait ~2 minutes for it to provision.

### 2. Create the data table

1. In the Supabase dashboard left sidebar, click **SQL Editor**.
2. Click **+ New query**.
3. Paste the SQL below and click **Run** (bottom right, or press Cmd/Ctrl-Enter):

```sql
create table public.user_data (
  user_id    uuid primary key references auth.users on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  api_key    text        not null default '',
  updated_at timestamptz not null default now()
);

alter table public.user_data enable row level security;

create policy "Users can read own data"
  on public.user_data for select
  using (auth.uid() = user_id);

create policy "Users can insert own data"
  on public.user_data for insert
  with check (auth.uid() = user_id);

create policy "Users can update own data"
  on public.user_data for update
  using (auth.uid() = user_id);
```

You should see "Success. No rows returned." That's correct — the table is empty until you sign in.

### 3. Set the redirect URL for magic-link sign-in

Supabase needs to know which URL the sign-in email should send users back to.

1. Left sidebar → **Authentication** → **URL Configuration**.
2. Under **Site URL**, paste your Cloudflare Pages URL (e.g. `https://lexbrother.pages.dev` or your custom domain). If you don't have one yet, use `http://localhost:8080` for now and update this later.
3. Under **Redirect URLs**, click **Add URL** and add both of the following (add whichever you'll actually use):
   - `http://localhost:8080` — for local testing
   - `https://your-site.pages.dev` — for the deployed site
4. Click **Save changes**.

> Note: Supabase ships with email auth enabled by default, so there's no toggle to flip. If you ever want to disable it, it's under **Authentication → Providers**.

### 4. Paste your Supabase URL and anon key into LexBrother

1. In the Supabase dashboard, left sidebar → **Project Settings** (gear icon) → **API**.
2. Copy the **Project URL** (looks like `https://abcdefghijklm.supabase.co`).
3. Copy the **anon public** API key (a long string starting with `eyJ…`). **Not** the service_role key.
4. Open `js/config.js` in LexBrother and paste the two values:

```js
window.LEXBROTHER_CONFIG = {
  SUPABASE_URL:      'https://abcdefghijklm.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi...(long string)...',
};
```

5. Save the file. Commit and push — Cloudflare Pages will auto-deploy.

Both values are safe to commit publicly. The anon key is designed to be exposed in client code; the row-level security policies you created in step 2 ensure users can only read and write their own row.

### 5. Sign in

Open your site. Enter your email. Click the link in your inbox. Done — your data will sync automatically.

### 6. (Optional) Customize the magic-link email

By default, Supabase sends a plain "Confirm your email" template. To make it say LexBrother:

1. Dashboard → **Authentication** → **Email Templates** → **Magic Link**.
2. Customize the subject and body. Save.

## Running locally

```bash
# Python 3
python3 -m http.server 8080

# Or: any static server
npx serve .
```

Then open http://localhost:8080.

Make sure `http://localhost:8080` is in your Supabase redirect URL list (step 3 above) or magic-link sign-in won't work locally.

## Deploying to Cloudflare Pages

1. Push this repo to GitHub.
2. Go to **Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git**.
3. Select the `LexBrother` repo.
4. On the build config screen, **leave the framework preset as "None"** and **leave the build command empty**. Set the **build output directory** to `/` (the repo root).
5. Click Save and Deploy.

Every future `git push` to the main branch triggers an auto-deploy. No environment variables needed — config is in `js/config.js`.

## Setting up your Anthropic API key

1. Go to https://console.anthropic.com, create an account, add a credit card (minimum $5).
2. **Settings → API Keys → Create Key.** Copy it (starts with `sk-ant-…`).
3. In LexBrother, click the **⚙** icon at the bottom-left of the sidebar. Paste your key, hit Save.
4. The key is stored in your Supabase row, so it's available on every device you sign in on. It's sent directly from your browser to Anthropic on every request and never logged anywhere else.

Without a key, the app falls back to a built-in quota (rate-limited and capped at 30 questions per quiz). With a key, you get up to 500 questions and full TOC cleanup on Claude Opus 4.7.

## URLs and bookmarking

Each course (and inner tab) has its own URL, so you can bookmark or share links to specific places:

- `/` — opens the default course (Civil Procedure)
- `/criminal-law` — Criminal Law, Textbook tab
- `/criminal-law/quizzes` — Criminal Law, Quizzes tab
- `/criminal-law/briefs` — Criminal Law, Case Briefs tab

Default-course slugs match their IDs (e.g. `civil-procedure`, `constitutional-law`, `legal-research-writing`). Custom courses get a slug auto-generated from their name (e.g. "Intellectual Property" → `/intellectual-property`). Browser back/forward navigates between courses just like a normal site.

If a URL points to a course that no longer exists, the app silently falls back to the default course.

The `_redirects` file at the repo root tells Cloudflare Pages to serve `index.html` for any path so refreshes on `/criminal-law` work — don't delete it.

## Cross-device notes

- Sign in on each device with the same email — your courses, chapters, quizzes, briefs, and API key appear automatically.
- Saves are debounced (roughly every second while you type) and pending changes flush when you close the tab.
- If you edit on two devices at the same time, the later save wins. For a single user switching between devices, this is fine. Don't run two tabs editing the same brief simultaneously.

## Data export / backup

Your data lives in your Supabase database. To back up:

1. Dashboard → **Table Editor** → `user_data` → click your row → export as JSON.

Or via SQL: `select data from public.user_data where user_id = auth.uid();`
