// Run anywhere:  node test-hold.js    (needs the 'undici' package; run it inside your project folder)
// Question: on YOUR network, which HTTP client can keep ONE connection (and so ONE public IP)?
const https = require('https');
let Agent; try { ({ Agent } = require('undici')); } catch (e) { console.log('undici not found - run this from your project folder'); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nativeGet(agent) {
  return new Promise((resolve, reject) => {
    https.get('https://api.ipify.org', { agent }, (r) => {
      let b = ''; const port = r.socket && r.socket.localPort;
      r.on('data', (d) => (b += d)); r.on('end', () => resolve(`${b.trim()} (port ${port})`));
    }).on('error', reject);
  });
}

(async () => {
  console.log('1) Node built-in https, one kept-alive connection, 6 requests 1.5s apart:');
  const native = new https.Agent({ keepAlive: true, maxSockets: 1 });
  for (let i = 0; i < 6; i++) { try { console.log('   ', await nativeGet(native)); } catch (e) { console.log('    ERR', e.message); } await sleep(1500); }
  native.destroy();

  if (Agent) {
    console.log('2) undici, connections:1, 6 requests 1.5s apart:');
    const ud = new Agent({ connections: 1, pipelining: 0, keepAliveTimeout: 120000 });
    for (let i = 0; i < 6; i++) {
      try { const r = await fetch('https://api.ipify.org', { dispatcher: ud }); console.log('   ', (await r.text()).trim()); }
      catch (e) { console.log('    ERR', e.message); }
      await sleep(1500);
    }
    await ud.close();
  }
  console.log('\nSame address (and same port in 1) all six times = that client holds one connection.');
})();