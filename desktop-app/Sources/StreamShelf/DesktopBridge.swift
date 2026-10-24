import Foundation

enum DesktopBridge {
    // This code is injected only into WKWebView. The public website source contains none of it.
    static let script = #"""
    (() => {
      if (window.StreamShelfDesktop) return;
      const post = (message) => window.webkit?.messageHandlers?.streamShelf?.postMessage(message);
      let streams = [];
      const originalFetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        try {
          const url = String(args[0] instanceof Request ? args[0].url : args[0]);
          if (/\/api\/streams\//.test(url)) {
            response.clone().json().then(body => { if (Array.isArray(body?.streams)) streams = body.streams; }).catch(() => {});
          }
        } catch (_) {}
        return response;
      };
      const css = document.createElement('style');
      css.textContent = '#ss-offline{position:fixed;z-index:2147483647;top:10px;left:50%;transform:translateX(-50%);padding:9px 13px;border-radius:999px;background:#a34100;color:#fff;font:13px -apple-system;box-shadow:0 5px 20px #0008}#ss-download{position:fixed;z-index:2147483647;right:18px;bottom:18px;padding:10px 14px;border:0;border-radius:999px;background:#fff;color:#000;font:600 13px -apple-system;box-shadow:0 5px 20px #0008;cursor:pointer}';
      document.documentElement.appendChild(css);
      const button = document.createElement('button'); button.id = 'ss-download'; button.textContent = '↓ Downloads';
      button.onclick = () => {
        if (!streams.length) return post({kind:'library'});
        const choices = streams.filter(s => s && s.url).slice(0, 20);
        const answer = prompt('Choose stream to download:\n' + choices.map((s, i) => `${i + 1}. ${s.quality || 'Auto'} — ${s.provider || 'Source'}`).join('\n'));
        const stream = choices[Number(answer) - 1];
        if (!stream) return;
        post({kind:'download', payload:{url:stream.url, quality:stream.quality || 'Auto', headers:stream.headers || {}, title:document.querySelector('h1, .hero-title')?.textContent?.trim() || document.title, detail:stream.title || stream.name || stream.provider || ''}});
      };
      document.addEventListener('DOMContentLoaded', () => document.body.appendChild(button));
      const banner = document.createElement('button'); banner.id = 'ss-offline'; banner.hidden = true; banner.textContent = 'API unavailable — View Downloads'; banner.onclick = () => post({kind:'library'});
      document.addEventListener('DOMContentLoaded', () => document.body.appendChild(banner));
      const check = async () => { try { const r = await originalFetch('http://127.0.0.1:8787/api/health', {cache:'no-store'}); banner.hidden = !r.ok; post({kind:'apiStatus',online:r.ok}); } catch (_) { banner.hidden = false; post({kind:'apiStatus',online:false}); } };
      window.StreamShelfDesktop = { setDownloads: (_) => {}, check };
      check(); setInterval(check, 15000);
    })();
    """#
}
