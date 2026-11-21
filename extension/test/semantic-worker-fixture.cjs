const { parentPort } = require('node:worker_threads');

parentPort.on('message', (message) => {
  if (message.type !== 'embed') return;
  for (let i = 0; i < 100; i++) parentPort.postMessage({ type: 'progress', id: message.id, event: { status: 'progress_total', progress: 100 } });
  const end = Date.now() + 300;
  while (Date.now() < end) { /* Simulate CPU inference on the worker thread. */ }
  parentPort.postMessage({ type: 'result', id: message.id, vectors: message.texts.map(() => [1, 0]) });
});
