(() => {
  const vscode = acquireVsCodeApi();
  const el = id => document.getElementById(id);
  for (const id of ['stop','review','trace','allow','deny']) el(id).onclick = () => vscode.postMessage({action:id});
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
    el('model').textContent = s.model ? 'Model: ' + s.model + (s.usage ? ' | ' + s.usage : '') : '';
    el('banner').textContent = s.banner;
    el('banner').hidden = !s.banner;
    el('trace').hidden = !s.trace;
    el('cmd').hidden = !s.command;
    el('cmdText').textContent = s.command ? '$ ' + s.command.command + '\n(cwd: ' + s.command.cwd + ')' : '';
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
    el('changes').hidden = !s.edits.length;
    list('edits',s.edits);
  });
  vscode.postMessage({action:'ready'});
})();