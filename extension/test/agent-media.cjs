const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

exports.run = async () => {
  const elements = new Map();
  const messages = [];
  const frames = [];
  let onMessage;
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, textContent: '', hidden: false, disabled: false, children: [],
      replaceChildren(...children) { this.children = children; }
    });
    return elements.get(id);
  };
  const document = {
    getElementById: element,
    createElement: tag => ({ tag, textContent: '' })
  };
  const window = { addEventListener: (name, fn) => { assert.equal(name, 'message'); onMessage = fn; } };
  const vscode = { postMessage: message => messages.push(message) };
  const source = fs.readFileSync(path.join(__dirname, '../media/agent.js'), 'utf8');
  vm.runInNewContext(source, {
    document, window, Number,
    acquireVsCodeApi: () => vscode,
    requestAnimationFrame: callback => frames.push(callback)
  });

  assert.equal(messages[0]?.action, 'ready', 'the webview announces that it is ready');
  messages.length = 0;
  onMessage({ data: {
    renderSequence: 17, busy: false, reviewing: false, status: 'Ready', model: '', usage: '',
    banner: '', trace: '', command: undefined, text: 'visible text', tools: [], context: undefined,
    summary: [], edits: []
  } });
  assert.equal(element('text').textContent, 'visible text', 'the DOM is updated before frame acknowledgement');
  assert.equal(frames.length, 1, 'one frame acknowledgement is scheduled');
  assert.equal(messages.length, 0, 'the acknowledgement does not arrive before the frame');
  frames.shift()();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].action, 'rendered');
  assert.equal(messages[0].sequence, 17);
};
