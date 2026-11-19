// Runs the scripted demo model as an OpenAI-compatible server on loopback.
// Usage: node demo-model-cli.js [--port 47790] [--delay-ms 40] [--dump-edits]
import { MockModel } from './mock-model';
import { demoScript, TASK_A_EDITS, TASK_B_EDITS } from './demo-script';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

if (process.argv.includes('--dump-edits')) {
  process.stdout.write(JSON.stringify({ A: TASK_A_EDITS, B: TASK_B_EDITS }, null, 2));
} else {
  const model = new MockModel();
  model.handler = demoScript;
  model.delayMsPerWord = Number(arg('--delay-ms', '40'));
  const port = Number(arg('--port', '47790'));
  void model.start(port).then(() => {
    console.log(`demo model listening on http://127.0.0.1:${model.port}/v1 (scripted Task A/B/C)`);
  });
  const stop = () => { void model.stop().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
