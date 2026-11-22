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
    createElement: tag => ({ tag, textContent: '', children: [], append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; } })
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
  // Attach picker result: mentions are appended to the request box, separated by a space; nothing is rendered or acknowledged.
  element('task').value = 'add a config command';
  const framesBefore = frames.length;
  onMessage({ data: { insertMentions: '@file:src/flask/cli.py @symbol:FlaskGroup ' } });
  assert.equal(element('task').value, 'add a config command @file:src/flask/cli.py @symbol:FlaskGroup ');
  assert.equal(frames.length, framesBefore, 'an insert is not a render');
  element('task').value = '';
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
  // Tool timeline: a run of three finished reads collapses into one row; edits and running reads stay visible.
  {
    const reads = [1, 2, 3].map(i => ({ id: 'r' + i, label: 'read_file', detail: 'Done: src/flask/cli.py' }));
    const tools = [...reads, { id: 'e1', label: 'propose_edit', detail: 'Done: saved' }, { id: 'r4', label: 'read_file', detail: 'src/a.py' }];
    onMessage({ data: { ...state, renderSequence: 90, tools } });
    const rows = element('tools').children;
    assert.equal(rows.length, 3, 'three finished reads grouped, then the edit and the running read');
    const details = rows[0].children[0];
    assert.equal(details.tag, 'details');
    assert.equal(details.children[0].textContent, '3 finished reads and searches');
    assert.equal(rows[1].textContent, 'propose_edit | Done: saved');
    const edit = rows[1];
    onMessage({ data: { ...state, renderSequence: 91, tools: tools.map(t => t.id === 'r4' ? { ...t, detail: 'Done: src/a.py' } : t) } });
    assert.equal(element('tools').children[1], edit, 'rows are keyed by call id and patched in place');
    onMessage({ data: { ...state, renderSequence: 92, tools: [] } });
    assert.equal(element('tools').children.length, 0);
  }
};
