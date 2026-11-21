(() => {
  const vscode = acquireVsCodeApi();
  const el = id => document.getElementById(id);
  for (const id of ['stop','review','trace','allow','deny','resume']) el(id).onclick = () => vscode.postMessage({action:id});
  let resumeTimer;
  // Resume is enabled once the suggested wait after a rate limit has passed; the label counts down until then.
  const showResume = s => {
    clearTimeout(resumeTimer);
    el('resumeBox').hidden = !s.resume || s.busy;
    if (!s.resume || s.busy) return;
    const files = s.resume.files.length ? ' Already changed: ' + s.resume.files.join(', ') + '.' : ' No file was changed.';
    const why = s.resume.reason === 'stalled' ? 'Stopped: the model did not respond in time.' : 'Stopped by a model rate limit (HTTP 429).';
    el('resumeText').textContent = why + files + ' Resume continues the task in this conversation.';
    const wait = s.resume.at - Date.now();
    el('resume').disabled = wait > 0;
    el('resume').textContent = wait > 0 ? 'Resume (in ' + Math.ceil(wait / 1000) + ' s)' : 'Resume';
    if (wait > 0) resumeTimer = setTimeout(() => showResume(s), Math.min(wait, 1000));
  };
  el('send').onclick = () => {
    const text = el('task').value;
    if (text.trim()) vscode.postMessage({action:'send',text});
  };
  const list = (id, values) => {
    el(id).replaceChildren(...values.map(value => {
      const li = document.createElement('li');
      li.textContent = value;
      return li;
    }));
  };
  window.addEventListener('message', ({data:s}) => {
    el('send').disabled = s.busy;
    el('stop').disabled = !s.busy;
    el('review').hidden = !s.reviewing;
    el('status').textContent = s.status;
    showResume(s);
    el('model').textContent = s.model ? 'Model: ' + s.model + (s.usage ? ' | ' + s.usage : '') : '';
    el('banner').textContent = s.banner;
    el('banner').hidden = !s.banner;
    el('trace').hidden = !s.trace;
    el('cmd').hidden = !s.command;
    el('cmdText').textContent = s.command
      ? (s.command.warning ? '⚠ ' + s.command.warning + '\n' : '') + '$ ' + s.command.command + '\n(cwd: ' + s.command.cwd + ')' : '';
    el('text').textContent = s.text;
    el('activity').hidden = !s.tools.length;
    list('tools',s.tools.map(t => t.label + ' | ' + t.detail));
    el('context').hidden = !s.context;
    if (s.context) {
      el('budget').textContent = s.context.estimatedTokens + ' / ' + s.context.budgetTokens + ' estimated tokens';
      list('selected',s.context.selections.map(i => i.path + (i.symbol ? ' | ' + i.symbol : '') +
        ' | ' + i.source + ' | ' + i.rationale + ' | ' + i.estimatedTokens + ' tokens' + (i.truncated ? ' (truncated)' : '')));
      el('skippedTitle').hidden = !s.context.skipped.length;
      list('skipped',s.context.skipped.map(i => i.path + ' | ' + i.reason + ' | ' + i.estimatedTokens + ' tokens'));
    }
    el('tests').hidden = !s.tests;
    el('tests').textContent = s.tests;
    el('warnings').hidden = !s.warnings.length;
    list('warningList', s.warnings);
    el('turnFiles').hidden = !s.summary.length;
    el('turnFilesTitle').textContent = 'Files changed in this turn: ' + s.summary.filter(line => !line.endsWith('| not changed')).length;
    list('summary',s.summary);
    el('changes').hidden = !s.edits.length;
    list('edits',s.edits);
  });
  vscode.postMessage({action:'ready'});
})();