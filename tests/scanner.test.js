'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createElement(initialText = '') {
  const listeners = {};
  return {
    textContent: initialText,
    className: '',
    disabled: false,
    hidden: false,
    value: '',
    addEventListener(type, listener) { listeners[type] = listener; },
    dispatch(type, event = {}) {
      if (listeners[type]) return listeners[type](event);
    }
  };
}

function createHarness() {
  const elements = {
    result: createElement('Камера выключена'),
    connectionStatus: createElement('Приложение регистратора не подключено'),
    mode: createElement('Определение режима…'),
    count: createElement('0'),
    confirmedCount: createElement('0'),
    startBtn: createElement(),
    stopBtn: createElement(),
    testBtn: createElement(),
    retryBtn: createElement(),
    photoInput: createElement()
  };
  const documentListeners = {};
  const windowListeners = {};
  const postedMessages = [];
  const timers = new Map();
  let timerId = 0;
  let requestSequence = 0;
  let now = 1_800_000_000_000;
  const bridgeWindow = {
    closed: false,
    postMessage(message, origin) {
      postedMessages.push({ message, origin });
    }
  };
  const window = {
    location: {
      hostname: 'localhost',
      origin: 'https://shkottexas-debug.github.io'
    },
    crypto: {
      randomUUID: () => `request-${String(++requestSequence).padStart(8, '0')}`,
      subtle: {
        importKey: async () => ({}),
        verify: async () => true
      }
    },
    atob,
    addEventListener(type, listener) {
      windowListeners[type] = listener;
    }
  };
  const navigator = {
    onLine: true,
    vibrate() {}
  };
  class FakeDate extends Date {
    static now() { return now; }
  }
  const document = {
    getElementById(id) {
      return elements[id];
    },
    addEventListener(type, listener) {
      documentListeners[type] = listener;
    }
  };
  const context = vm.createContext({
    window,
    document,
    navigator,
    URL,
    TextEncoder,
    Uint8Array,
    Array,
    Map,
    Set,
    Date: FakeDate,
    Math,
    console,
    setTimeout(callback, delay) {
      timerId += 1;
      timers.set(timerId, { callback, delay });
      return timerId;
    },
    clearTimeout(id) { timers.delete(id); }
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'scanner.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'scanner.js' });
  documentListeners.DOMContentLoaded();

  return {
    bridgeWindow,
    elements,
    postedMessages,
    window,
    windowListeners,
    now: () => now,
    advance(milliseconds) { now += milliseconds; },
    setOnline(online) {
      navigator.onLine = online;
      windowListeners[online ? 'online' : 'offline']();
    },
    runTimerByDelay(delay) {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `timer with delay ${delay} must exist`);
      timers.delete(entry[0]);
      entry[1].callback();
    }
  };
}

async function flushPromises() {
  await new Promise(resolve => setImmediate(resolve));
}

async function connectBridge(harness) {
  const bridgeOrigin = 'https://script.google.com';
  const channelId = 'channel-12345678';
  harness.windowListeners.message({
    origin: bridgeOrigin,
    source: harness.bridgeWindow,
    data: {
      type: 'M70_BRIDGE_INIT',
      channelId,
      expiresAt: harness.now() + 5 * 60 * 1000,
      bridgeOrigin,
      signature: 'AA=='
    }
  });
  await flushPromises();
  return { bridgeOrigin, channelId };
}

function checkInRequests(harness) {
  return harness.postedMessages.filter(entry => entry.message.type === 'M70_CHECKIN_REQUEST');
}

test('page has separate connection and ticket result regions', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id="connectionStatus"[^>]*role="status"/);
  assert.match(html, /id="result"[^>]*role="status"/);
});

test('renewal after successful check-in preserves ticket result and confirmed count', async () => {
  const harness = createHarness();
  const { bridgeOrigin, channelId } = await connectBridge(harness);

  harness.window.__M70_TEST__.onScanSuccess('synthetic-test-token');
  const request = checkInRequests(harness)[0];
  assert.ok(request, 'first scan must be sent to the bridge');

  harness.windowListeners.message({
    origin: bridgeOrigin,
    source: harness.bridgeWindow,
    data: {
      type: 'M70_CHECKIN_RESULT',
      channelId,
      requestId: request.message.requestId,
      status: 'checked_in'
    }
  });

  assert.equal(harness.elements.result.textContent, '✓ Приход отмечен\nСканирование продолжается');
  assert.equal(harness.elements.confirmedCount.textContent, '1');

  harness.windowListeners.message({
    origin: bridgeOrigin,
    source: harness.bridgeWindow,
    data: {
      type: 'M70_BRIDGE_INIT',
      channelId,
      expiresAt: harness.now() + 5 * 60 * 1000 + 30_000,
      bridgeOrigin,
      signature: 'AA=='
    }
  });
  await flushPromises();

  assert.equal(harness.elements.connectionStatus.textContent, 'Связь с приложением регистратора установлена.');
  assert.equal(harness.elements.result.textContent, '✓ Приход отмечен\nСканирование продолжается');
  assert.equal(harness.elements.confirmedCount.textContent, '1');

  harness.window.__M70_TEST__.onScanSuccess('synthetic-test-token');

  assert.equal(harness.elements.result.textContent, 'Билет уже отмечен в этой сессии');
  assert.equal(harness.elements.count.textContent, '1');
  assert.equal(harness.elements.confirmedCount.textContent, '1');
  assert.equal(
    checkInRequests(harness).length,
    1,
    'local duplicate must not be sent to the server'
  );
});

test('QR remaining in frame after reconnect cannot resend until registrar clicks retry', async () => {
  const harness = createHarness();
  await connectBridge(harness);

  harness.window.__M70_TEST__.onScanSuccess('offline-in-flight-token');
  const firstRequest = checkInRequests(harness)[0];
  assert.ok(firstRequest);

  harness.setOnline(false);
  assert.equal(harness.elements.retryBtn.hidden, false);
  assert.match(harness.elements.result.textContent, /Приход не подтверждён/);

  harness.setOnline(true);
  assert.equal(checkInRequests(harness).length, 1, 'online event must not resend a ticket');

  for (let index = 0; index < 3; index += 1) {
    harness.advance(2_000);
    harness.window.__M70_TEST__.onScanSuccess('offline-in-flight-token');
  }
  assert.equal(checkInRequests(harness).length, 1, 'decode callbacks for a QR still in frame must not resend');
  assert.equal(harness.elements.result.textContent, 'Билет ожидает ручного повтора. Нажмите «Повторить отправку».');

  harness.elements.retryBtn.dispatch('click');
  const requests = checkInRequests(harness);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].message.requestId, firstRequest.message.requestId, 'manual retry reuses requestId');
});

test('15 second timeout releases request and manual retry reuses the same requestId', async () => {
  const harness = createHarness();
  const { bridgeOrigin, channelId } = await connectBridge(harness);

  harness.window.__M70_TEST__.onScanSuccess('timeout-token');
  const firstRequest = checkInRequests(harness)[0];
  harness.runTimerByDelay(15_000);

  assert.equal(harness.elements.retryBtn.hidden, false);
  assert.match(harness.elements.result.textContent, /Сервер не ответил/);

  harness.elements.retryBtn.dispatch('click');
  const retryRequest = checkInRequests(harness)[1];
  assert.equal(retryRequest.message.requestId, firstRequest.message.requestId);

  harness.windowListeners.message({
    origin: bridgeOrigin,
    source: harness.bridgeWindow,
    data: {
      type: 'M70_CHECKIN_RESULT',
      channelId,
      requestId: retryRequest.message.requestId,
      status: 'checked_in'
    }
  });
  assert.equal(harness.elements.confirmedCount.textContent, '1');
});

test('late positive response after timeout is accepted once for the known requestId', async () => {
  const harness = createHarness();
  const { bridgeOrigin, channelId } = await connectBridge(harness);

  harness.window.__M70_TEST__.onScanSuccess('late-result-token');
  const request = checkInRequests(harness)[0];
  harness.runTimerByDelay(15_000);

  const lateResult = {
    origin: bridgeOrigin,
    source: harness.bridgeWindow,
    data: {
      type: 'M70_CHECKIN_RESULT',
      channelId,
      requestId: request.message.requestId,
      status: 'checked_in'
    }
  };
  harness.windowListeners.message(lateResult);

  assert.equal(harness.elements.confirmedCount.textContent, '1');
  assert.equal(harness.elements.retryBtn.hidden, true);
  assert.equal(harness.elements.result.textContent, '✓ Приход отмечен\nСканирование продолжается');

  harness.windowListeners.message(lateResult);
  assert.equal(harness.elements.confirmedCount.textContent, '1', 'duplicate late result must not count twice');
});

test('late response with an unknown requestId cannot confirm a ticket', async () => {
  const harness = createHarness();
  const { bridgeOrigin, channelId } = await connectBridge(harness);

  harness.windowListeners.message({
    origin: bridgeOrigin,
    source: harness.bridgeWindow,
    data: {
      type: 'M70_CHECKIN_RESULT',
      channelId,
      requestId: 'unknown-request-id',
      status: 'checked_in'
    }
  });

  assert.equal(harness.elements.confirmedCount.textContent, '0');
  assert.equal(harness.elements.result.textContent, 'Камера выключена');
});

test('ticket scanned while offline waits for manual action and authorization can be checked after reconnect', async () => {
  const harness = createHarness();
  await connectBridge(harness);

  harness.setOnline(false);
  harness.window.__M70_TEST__.onScanSuccess('offline-before-send-token');
  assert.equal(checkInRequests(harness).length, 0);

  harness.setOnline(true);
  assert.equal(checkInRequests(harness).length, 0, 'reconnect must not send automatically');

  harness.elements.testBtn.dispatch('click');
  assert.equal(
    harness.postedMessages.filter(entry => entry.message.type === 'M70_TEST_REQUEST').length,
    1,
    'authorization check is available without reloading the page'
  );
});

test('late checked_in removes a queued retry before it can be sent and counts once', async () => {
  const harness = createHarness();
  const { bridgeOrigin, channelId } = await connectBridge(harness);

  harness.window.__M70_TEST__.onScanSuccess('queued-late-result-token');
  const originalRequest = checkInRequests(harness)[0];
  harness.setOnline(false);
  harness.setOnline(true);

  harness.elements.testBtn.dispatch('click');
  const testRequest = harness.postedMessages.find(entry => entry.message.type === 'M70_TEST_REQUEST');
  assert.ok(testRequest, 'connection test occupies the single in-flight request slot');

  harness.elements.retryBtn.dispatch('click');
  assert.equal(checkInRequests(harness).length, 1, 'retry is queued but not sent while another request is active');

  const lateResult = {
    origin: bridgeOrigin,
    source: harness.bridgeWindow,
    data: {
      type: 'M70_CHECKIN_RESULT',
      channelId,
      requestId: originalRequest.message.requestId,
      status: 'checked_in'
    }
  };
  harness.windowListeners.message(lateResult);
  assert.equal(harness.elements.confirmedCount.textContent, '1');

  harness.windowListeners.message({
    origin: bridgeOrigin,
    source: harness.bridgeWindow,
    data: {
      type: 'M70_TEST_RESULT',
      channelId,
      requestId: testRequest.message.requestId,
      ok: true
    }
  });
  assert.equal(checkInRequests(harness).length, 1, 'completed queued token must not be sent after queue resumes');

  harness.windowListeners.message(lateResult);
  assert.equal(harness.elements.confirmedCount.textContent, '1', 'duplicate late result must not increment twice');
});

test('server busy response leaves the ticket retryable with the original requestId', async () => {
  const harness = createHarness();
  const { bridgeOrigin, channelId } = await connectBridge(harness);

  harness.window.__M70_TEST__.onScanSuccess('server-busy-token');
  const firstRequest = checkInRequests(harness)[0];
  harness.windowListeners.message({
    origin: bridgeOrigin,
    source: harness.bridgeWindow,
    data: {
      type: 'M70_CHECKIN_RESULT',
      channelId,
      requestId: firstRequest.message.requestId,
      status: 'error',
      message: 'Дождитесь завершения предыдущей проверки.'
    }
  });

  assert.equal(harness.elements.retryBtn.hidden, false);
  harness.elements.retryBtn.dispatch('click');
  const retryRequest = checkInRequests(harness)[1];
  assert.equal(retryRequest.message.requestId, firstRequest.message.requestId);
});
