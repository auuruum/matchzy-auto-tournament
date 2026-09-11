/* global window, document */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const matUrl = process.env.MAT_URL || 'http://localhost:3069';
const hudUrl = process.env.JTS_HUD_URL || 'http://localhost:1349';
const steamIds = ['76561199667555193', '76561198655090584'];
const outputDir = 'test-results/player-cameras';

const browser = await chromium.launch({ headless: true });
const contexts = [];
let initialPolicy;

async function context() {
  const next = await browser.newContext({ baseURL: matUrl });
  contexts.push(next);
  return next;
}

async function setPolicy(request, transport, enabled = true) {
  const response = await request.put('/api/player-cameras/admin', { data: { enabled, transport } });
  assert.equal(response.ok(), true, await response.text());
}

async function startPublisher(steamId) {
  const player = await context();
  const login = await player.request.post('/api/test/login-player', { data: { steamId } });
  assert.equal(login.ok(), true, await login.text());
  const page = await player.newPage();
  await page.goto(`/player/${steamId}`);
  await page.getByTestId('player-camera-card').waitFor();
  await page.getByRole('button', { name: 'Test pattern' }).click();
  await page.getByText(/^Live ·/).waitFor();
  return page;
}

async function openHud(steamId, transport) {
  const hud = await context();
  const page = await hud.newPage();
  await page.goto(`${hudUrl}/huds/bebraland/index.html?variant=vertical&cameraLive=1&cameraSteamId=${steamId}`);
  await page.waitForFunction((id) => {
    const state = window.playerCameraDebug?.state();
    const video = document.querySelector('#mat-player-camera');
    return state?.watchedSteamId === id && state?.activeSteamId === id && video?.readyState >= 2 && !video.paused;
  }, steamId, { timeout: 20_000 });

  let previousTime = -1;
  for (let sample = 0; sample < 20; sample += 1) {
    const status = await page.evaluate(() => {
      const video = document.querySelector('#mat-player-camera');
      return { ...window.playerCameraDebug.state(), currentTime: video.currentTime, active: video.classList.contains('active') };
    });
    assert.equal(status.watchedSteamId, steamId);
    assert.equal(status.activeSteamId, steamId);
    assert.equal(status.active, true);
    assert.ok(status.currentTime >= previousTime, `${transport}/${steamId}: playback moved backwards`);
    if (transport === 'relay') assert.ok(status.relayQueue < 12, `${transport}/${steamId}: relay queue grew to ${status.relayQueue}`);
    previousTime = status.currentTime;
    await page.waitForTimeout(250);
  }
  await page.locator('#mat-player-camera').screenshot({ path: `${outputDir}/${transport}-${steamId}.png` });
}

async function checkAdminPreviews(admin, transport) {
  const page = await admin.newPage();
  await page.goto('/settings');
  await page.getByText('Players & Access', { exact: true }).click();
  const videos = page.getByTestId('player-camera-admin-settings').locator('video');
  await page.waitForFunction(() => {
    const elements = [...document.querySelectorAll('[data-testid="player-camera-admin-settings"] video')];
    return elements.length === 2 && elements.every((video) => video.readyState >= 2 && !video.paused);
  }, undefined, { timeout: 20_000 });
  const previousTimes = [-1, -1];
  for (let sample = 0; sample < 28; sample += 1) {
    const currentTimes = await videos.evaluateAll((elements) => elements.map((video) => video.currentTime));
    currentTimes.forEach((currentTime, index) => {
      assert.ok(currentTime >= previousTimes[index], `${transport}/admin/${index}: playback moved backwards`);
      previousTimes[index] = currentTime;
    });
    await page.waitForTimeout(250);
  }
  await page.screenshot({ path: `${outputDir}/${transport}-admin.png` });
  await page.close();
}

async function runTransport(admin, transport) {
  await setPolicy(admin.request, transport);
  const publishers = await Promise.all(steamIds.map(startPublisher));
  await checkAdminPreviews(admin, transport);
  await Promise.all(steamIds.map((steamId) => openHud(steamId, transport)));
  await Promise.all(publishers.map((page) => page.getByRole('button', { name: 'Disable camera' }).click()));
  while (contexts.length > 1) await contexts.pop().close();
}

try {
  await mkdir(outputDir, { recursive: true });
  const admin = await context();
  const login = await admin.request.post('/api/test/login-admin', { data: { steamId: '76561198000000001' } });
  assert.equal(login.ok(), true, await login.text());
  const status = await admin.request.get('/api/player-cameras/admin');
  assert.equal(status.ok(), true, await status.text());
  initialPolicy = await status.json();

  await runTransport(admin, 'p2p');
  await runTransport(admin, 'relay');
  console.log('Player camera P2P and relay streams stayed stable in both HUD and admin previews.');
} finally {
  const admin = contexts[0];
  if (admin && initialPolicy) await setPolicy(admin.request, initialPolicy.transport, initialPolicy.enabled).catch(() => undefined);
  await Promise.all(contexts.map((item) => item.close().catch(() => undefined)));
  await browser.close();
}
