(() => {
  const vscode = acquireVsCodeApi();
  const el = id => document.getElementById(id);
  const lastLists = new WeakMap();
  const setText = (id, value) => { const node = el(id); if (node.textContent !== value) node.textContent = value; };
  const setHidden = (id, value) => { const node = el(id); if (node.hidden !== value) node.hidden = value; };
  const setDisabled = (id, value) => { const node = el(id); if (node.disabled !== value) node.disabled = value; };
  for (const id of ['stop','review','trace','allow','deny','resume']) el(id).onclick = () => vscode.postMessage({action:id});
  let resumeTimer;
  // Resume is enabled once the suggested wait after a rate limit has passed; the label counts down until then.
  const showResume = s => {
    clearTimeout(resumeTimer);
    setHidden('resumeBox', !s.resume || s.busy);
    if (!s.resume || s.busy) return;
    const files = s.resume.files.length ? ' Already changed: ' + s.resume.files.join(', ') + '.' : ' No file was changed.';
    const why = s.resume.reason === 'stalled' ? 'Stopped: the model did not respond in time.' : 'Stopped by a model rate limit (HTTP 429).';
    setText('resumeText', why + files + ' Resume continues the task in this conversation.');
    const wait = s.resume.at - Date.now();
    setDisabled('resume', wait > 0);
    setText('resume', wait > 0 ? 'Resume (in ' + Math.ceil(wait / 1000) + ' s)' : 'Resume');
    if (wait > 0) resumeTimer = setTimeout(() => showResume(s), Math.min(wait, 1000));
  };
  el('send').onclick = () => {
    const text = el('task').value;
    if (text.trim()) vscode.postMessage({action:'send',text});
  };
  const list = (id, values) => {
    const node = el(id), previous = lastLists.get(node);
    if (previous && previous.length === values.length && previous.every((value, i) => value === values[i])) return;
    lastLists.set(node, [...values]);
    node.replaceChildren(...values.map(value => {
      const li = document.createElement('li');
      li.textContent = value;
      return li;
    }));
  };
  window.addEventListener('message', ({data:s}) => {
    const receivedAt = performance.now();
    setDisabled('send', s.busy);
    setDisabled('stop', !s.busy);
    setHidden('review', !s.reviewing);
    setText('status', s.status);
    showResume(s);
    setText('model', s.model ? 'Model: ' + s.model + (s.usage ? ' | ' + s.usage : '') : '');
    setText('banner', s.banner);
    setHidden('banner', !s.banner);
    setHidden('recovery', !s.recovery);
    setText('recoveryText', s.recovery || '');
    setHidden('trace', !s.trace);
    setHidden('cmd', !s.command);
    setText('cmdText', s.command
      ? (s.command.warning ? '⚠ ' + s.command.warning + '\n' : '') + '$ ' + s.command.command + '\n(cwd: ' + s.command.cwd + ')' : '');
    setText('text', s.text);
    setHidden('activity', !s.tools.length);
    list('tools',s.tools.map(t => t.label + ' | ' + t.detail));
    setHidden('context', !s.context);
    if (s.context) {
      setText('budget', s.context.estimatedTokens + ' / ' + s.context.budgetTokens + ' estimated tokens');
      list('selected',s.context.selections.map(i => i.path + (i.symbol ? ' | ' + i.symbol : '') +
        ' | ' + i.source + ' | ' + i.rationale + ' | ' + i.estimatedTokens + ' tokens' + (i.truncated ? ' (truncated)' : '')));
      setHidden('skippedTitle', !s.context.skipped.length);
      list('skipped',s.context.skipped.map(i => i.path + ' | ' + i.reason + ' | ' + i.estimatedTokens + ' tokens'));
    }
    setHidden('verification', !s.verification);
    setText('verification', s.verification || '');
    { const node = el('verification'), cls = (s.verification || '').startsWith('\u26a0') ? 'unverified' : 'verified'; if (node.className !== cls) node.className = cls; }
    setHidden('tests', !s.tests);
    setText('tests', s.tests || '');
    setHidden('warnings', !s.warnings.length);
    list('warningList', s.warnings);
    setHidden('turnFiles', !s.summary.length);
    setText('turnFilesTitle', 'Files changed in this turn: ' + s.summary.filter(line => !line.endsWith('| not changed')).length);
    list('summary',s.summary);
    setHidden('changes', !s.edits.length);
    list('edits',s.edits);
    const domUpdatedAt = performance.now();
    if (Number.isInteger(s.renderSequence)) {
      requestAnimationFrame(() => {
        const acknowledgement = {
          action: 'rendered', sequence: s.renderSequence,
          frameMs: Math.max(0, performance.now() - receivedAt),
          domMs: Math.max(0, domUpdatedAt - receivedAt),
          visibility: document.visibilityState === 'visible' ? 1 : 0
        };
        if (Number.isFinite(s.renderEventWallAt))
          acknowledgement.eventToFrameMs = Math.max(0, Date.now() - s.renderEventWallAt);
        if (Number.isFinite(s.renderTextEventWallAt))
          acknowledgement.textEventToFrameMs = Math.max(0, Date.now() - s.renderTextEventWallAt);
        vscode.postMessage(acknowledgement);
      });
    }
  });
  vscode.postMessage({action:'ready'});
})();
