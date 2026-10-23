# Supabase setup (accounts + sync)

The streamer works signed-out. To enable email/password accounts and cross-device sync, you need a
Supabase project and a local config file. The config file is **ignored by git**.

## 1. Create the project

1. Create a project at <https://supabase.com>.
2. Open **Project Settings → API**.
3. Copy the **Project URL** and the **publishable (anon)** key.
4. Do **not** use the `service_role` / secret key in the browser.

## 2. Create the local config

```bash
cp public/streamer/supabase-config.example.js public/streamer/supabase-config.js
```

Edit `public/streamer/supabase-config.js`:

```js
window.MACSTREAM_SUPABASE = {
  url: 'https://YOUR-PROJECT.supabase.co',
  anonKey: 'sb_publishable_...'
};
```

`public/streamer/supabase-config.js` is listed in `.gitignore` and is excluded from the Docker
build context. Commit the example instead. If the real file was ever committed, remove it from git,
rotate the key in Supabase, and commit the example.

## 3. Create the table and row-level security

Run this in the Supabase SQL editor:

```sql
create table if not exists public.user_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  version integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.user_data enable row level security;

create policy "read own row" on public.user_data
  for select using (auth.uid() = user_id);

create policy "insert own row" on public.user_data
  for insert with check (auth.uid() = user_id);

create policy "update own row" on public.user_data
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

## 4. Enable email/password auth

In Supabase: **Authentication → Providers → Email** → enable. For local testing, turning off
"Confirm email" avoids an extra confirmation step.

## 5. Reload

Reload the streamer. The account dialog should no longer say "Accounts aren't set up yet."

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `401` / `403` on `/rest/v1/user_data` | RLS policies are missing, or the user isn't signed in. |
| `404` on `/rest/v1/user_data` | The table hasn't been created. |
| CORS error from a custom domain | Add the origin under **Authentication → URL Configuration**. |
