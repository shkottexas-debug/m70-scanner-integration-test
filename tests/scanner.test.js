'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createElement(initialText = '') {
  return {
    textContent: initialText,
    className: '',
    disabled: false,
    hidden: false,
    value: '',
    addEventListener() {}
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
  let timerId = 0;
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
      randomUUID: () => 'request-12345678',
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
    navigator: { vibrate() {} },
    URL,
    TextEncoder,
    Uint8Array,
    Array,
    Map,
    Set,
    Date,
    Math,
    console,
    setTimeout() { timerId += 1; return timerId; },
    clearTimeout() {}
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'scanner.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'scanner.js' });
  documentListeners.DOMContentLoaded();

  return { bridgeWindow, elements, postedMessages, window, windowListeners };
}

async function flushPromises() {
  await new Promise(resolve => setImmediate(resolve));
}

test('page has separate connection and ticket result regions', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id="connectionStatus"[^>]*role="status"/);
  assert.match(html, /id="result"[^>]*role="status"/);
});

test('renewal after successful check-in preserves ticket result and confirmed count', async () => {
  const harness = createHarness();
  const bridgeOrigin = 'https://script.google.com';
  const channelId = 'channel-12345678';
  const initialExpiry = Date.now() + 5 * 60 * 1000;

  harness.windowListeners.message({
    origin: bridgeOrigin,
    source: harness.bridgeWindow,
    data: {
      type: 'M70_BRIDGE_INIT',
      channelId,
      expiresAt: initialExpiry,
      bridgeOrigin,
      signature: 'AA=='
    }
  });
  await flushPromises();

  harness.window.__M70_TEST__.onScanSuccess('synthetic-test-token');
  const request = harness.postedMessages.find(entry => entry.message.type === 'M70_CHECKIN_REQUEST');
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
      expiresAt: initialExpiry + 30_000,
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
    harness.postedMessages.filter(entry => entry.message.type === 'M70_CHECKIN_REQUEST').length,
    1,
    'local duplicate must not be sent to the server'
  );
});
