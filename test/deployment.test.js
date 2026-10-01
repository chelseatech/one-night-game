const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');

test('serves the host and frontend beneath SiteGround’s hidden .nodeapp directory', async (t) => {
  const temporary = await fs.mkdtemp(path.join(tmpdir(), 'who-said-that-deployment-'));
  const source = path.join(__dirname, '..');
  const deployed = path.join(temporary, '.nodeapp', 'release', 'app_source');
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.io.close(resolve));
    delete require.cache[path.join(deployed, 'server.js')];
    delete require.cache[path.join(deployed, 'prompts.js')];
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await fs.mkdir(deployed, { recursive: true });
  await fs.copyFile(path.join(source, 'server.js'), path.join(deployed, 'server.js'));
  await fs.copyFile(path.join(source, 'prompts.js'), path.join(deployed, 'prompts.js'));
  await fs.cp(path.join(source, 'public'), path.join(deployed, 'public'), { recursive: true });
  await fs.writeFile(path.join(deployed, 'public', '.private-fixture'), 'Must not be served');
  await fs.symlink(path.join(source, 'node_modules'), path.join(deployed, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  server = require(path.join(deployed, 'server.js')).createGameServer();
  await new Promise((resolve) => server.httpServer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;

  const host = await fetch(`${origin}/host`);
  assert.equal(host.status, 200, 'Host page must be served even when the deployment root contains .nodeapp');
  assert.match(await host.text(), /data-role="host"/);
  const player = await fetch(`${origin}/`);
  assert.equal(player.status, 200);
  assert.match(await player.text(), /data-role="player"/);
  for (const route of ['/style.css', '/app.js', '/socket.io/socket.io.js']) {
    assert.equal((await fetch(`${origin}${route}`)).status, 200, route);
  }
  assert.equal((await fetch(`${origin}/.private-fixture`)).status, 404, 'Hidden public files must remain blocked');
});
