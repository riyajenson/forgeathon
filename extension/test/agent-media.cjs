const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

exports.run = async () => {
  const elements = new Map();
  const messages = [];
  const frames = [];
  let now = 100;
  let wall = 1016;
  let onMessage;
  const element = id => {
    if (!elements.has(id)) {
      const node = {
        id, children: [], textWrites: 0, hiddenWrites: 0, disabledWrites: 0, replaceCount: 0,
        _text: '', _hidden: false, _disabled: false,
        get textContent() { return this._text; },
        set textContent(value) { this.textWrites++; this._text = value; },
        get hidden() { return this._hidden; },
        set hidden(value) { this.hiddenWrites++; this._hidden = value; },
        get disabled() { return this._disabled; },
        set disabled(value) { this.disabledWrites++; this._disabled = value; },
        replaceChildren(...children) { this.replaceCount++; this.children = children; }
      };
      elements.set(id, node);
    }
    return elements.get(id);
  };
  const mutationCount = () => [...elements.values()].reduce((sum, node) =>
    sum + node.textWrites + node.hiddenWrites + node.disabledWrites + node.replaceCount, 0);
  const document = {
    visibilityState: 'visible',
    getElementById: element,
    createElement: tag => ({ tag, textContent: '' })
  };
  const window = { addEventListener: (name, fn) => { assert.equal(name, 'message'); onMessage = fn; } };
  const vscode = { postMessage: message => messages.push(message) };
  const source = fs.readFileSync(path.join(__dirname, '../media/agent.js'), 'utf8');
  vm.runInNewContext(source, {
    document, window, Number, setTimeout, clearTimeout,
    performance: { now: () => now },
    Date: { now: () => wall },
    acquireVsCodeApi: () => vscode,
    requestAnimationFrame: callback => frames.push(() => { now += 16; wall += 16; callback(); })
  });

  assert.equal(messages[0]?.action, 'ready', 'the webview announces that it is ready');
  messages.length = 0;
  const state = {
    renderSequence: 17, renderEventWallAt: 1000, renderTextEventWallAt: 1010,
    busy: false, reviewing: false, status: 'Ready', model: '', usage: '',
    banner: '', trace: '', command: undefined, text: 'visible text', tools: [], context: undefined,
    summary: [], edits: [], warnings: [], tests: '', resume: undefined
  };
  onMessage({ data: state });
  assert.equal(element('text').textContent, 'visible text', 'the DOM is updated before frame acknowledgement');
  assert.equal(frames.length, 1, 'one frame acknowledgement is scheduled');
  assert.equal(messages.length, 0, 'the acknowledgement does not arrive before the frame');
  const mutationsAfterFirstRender = mutationCount();
  onMessage({ data: { ...state, renderSequence: 18, tools: [], summary: [], edits: [] } });
  assert.equal(mutationCount(), mutationsAfterFirstRender, 'an unchanged snapshot does not rewrite DOM content or lists');
  assert.equal(frames.length, 2, 'each snapshot still receives its own frame acknowledgement');
  frames.shift()();
  frames.shift()();
  assert.equal(messages.length, 2);
  assert.equal(messages[0].action, 'rendered');
  assert.equal(messages[0].sequence, 17);
  assert.equal(messages[0].frameMs, 16, 'the acknowledgement reports time from message handling to the frame');
  assert.equal(messages[0].domMs, 0, 'DOM update time is measured separately from waiting for a frame');
  assert.equal(messages[0].visibility, 1, 'the acknowledgement reports that the webview was visible');
  assert.equal(messages[0].eventToFrameMs, 32, 'control latency includes host-to-webview delivery and the frame');
  assert.equal(messages[0].textEventToFrameMs, 22, 'text latency starts at the first coalesced delta');
};
