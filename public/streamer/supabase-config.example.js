/* MacStream — supabase-config.example.js
 *
 * Copy this file to supabase-config.js and fill in your project's URL and publishable (anon) key.
 * The real supabase-config.js is ignored by git and must never be committed.
 *
 * The URL and anon key are public by design; row-level security protects the data. Never put the
 * service_role / secret key in this file.
 *
 * Full steps: docs/SUPABASE-SETUP.md
 */
window.MACSTREAM_SUPABASE = {
  url: 'https://YOUR-PROJECT.supabase.co',
  anonKey: 'sb_publishable_REPLACE_ME' // or the legacy anon JWT
};
