// Scripted "model" for the three fixed demo tasks on Flask 3.1.3 (commit 22d92470). Used by the
// demo-without-keys mode and the end-to-end check. It plays the role of a model: it calls the same MCP
// tools a real model would (search, read, propose_edit, run_command) and reads their results.
import type { MockReply, MockRequest } from './mock-model';
import { textOf } from './mock-model';

export type Edit = { old_text: string; new_text: string };

// ---------------------------------------------------------------- Task A

export const TASK_A_EDITS: Record<string, Edit[]> = {
  'src/flask/helpers.py': [
    {
      old_text: '    """Get whether debug mode should be enabled for the app, indicated by the\n    :envvar:`FLASK_DEBUG` environment variable. The default is ``False``.\n    """',
      new_text: '    """Get whether debug mode should be enabled for the app, indicated by the\n    :envvar:`FLASK_DEBUG` environment variable. The default is ``False``.\n\n    The following values are treated as false, case-insensitively:\n    ``"0"``, ``"false"``, ``"no"``, ``"off"`` and ``"n"``. An unset or\n    empty value is also false.\n    """',
    },
    {
      old_text: 'return bool(val and val.lower() not in {"0", "false", "no"})',
      new_text: 'return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})',
    },
  ],
};

// ---------------------------------------------------------------- Task B

const CONFIG_COMMAND = `

@click.command("config", short_help="Show the app's configuration as JSON.")
@with_appcontext
def config_command() -> None:
    """Show the loaded application's configuration as JSON.

    The values of keys containing \`\`SECRET\`\`, \`\`PASSWORD\`\`, \`\`TOKEN\`\` or
    \`\`KEY\`\` are masked as \`\`"***"\`\`.
    """
    import json

    masked = ("SECRET", "PASSWORD", "TOKEN", "KEY")
    config = {
        key: "***" if any(word in key.upper() for word in masked) else value
        for key, value in current_app.config.items()
    }
    click.echo(json.dumps(config, indent=2, sort_keys=True, default=str))`;

const CONFIG_TESTS = `


def test_config_command(app, runner):
    app.config.update(
        SECRET_KEY="dev-secret",
        DB_PASSWORD="hunter2",
        API_TOKEN="abc123",
        STRIPE_KEY="sk-live",
        GREETING="hello",
    )
    cli = FlaskGroup(create_app=lambda: app)
    result = runner.invoke(cli, ["config"])
    assert result.exit_code == 0, result.output
    data = json.loads(result.output)
    for key in ("SECRET_KEY", "DB_PASSWORD", "API_TOKEN", "STRIPE_KEY"):
        assert data[key] == "***"
    assert data["GREETING"] == "hello"
    assert "dev-secret" not in result.output
    assert "hunter2" not in result.output


def test_config_command_in_help(runner):
    cli = FlaskGroup(create_app=lambda: Flask("test"))
    result = runner.invoke(cli, ["--help"])
    assert result.exit_code == 0, result.output
    assert "config" in result.output
`;

const CONFIG_DOCS = `Show the Configuration
----------------------

The :func:\`config <cli.config_command>\` command prints the loaded application's
configuration as JSON. The values of keys that contain \`\`SECRET\`\`, \`\`PASSWORD\`\`,
\`\`TOKEN\`\` or \`\`KEY\`\` are replaced with \`\`"***"\`\`. Other values are printed as they
are, so check the output before sharing it.

.. code-block:: text

    $ flask --app hello config
    {
      "DEBUG": false,
      "SECRET_KEY": "***",
      ...
    }


Environment Variables From dotenv
---------------------------------`;

export const TASK_B_EDITS: Record<string, Edit[]> = {
  'src/flask/cli.py': [
    {
      old_text: '            self.add_command(routes_command)\n',
      new_text: '            self.add_command(routes_command)\n            self.add_command(config_command)\n',
    },
    {
      old_text: '    for row in rows:\n        click.echo(template.format(*row))\n',
      new_text: `    for row in rows:\n        click.echo(template.format(*row))${CONFIG_COMMAND}\n`,
    },
  ],
  'tests/test_cli.py': [
    { old_text: 'import importlib.metadata\nimport os\n', new_text: 'import importlib.metadata\nimport json\nimport os\n' },
    {
      old_text: '    ctx = run_command.make_context("run", ["--exclude-patterns", __file__])\n    assert ctx.params["exclude_patterns"] == [__file__]\n',
      new_text: `    ctx = run_command.make_context("run", ["--exclude-patterns", __file__])\n    assert ctx.params["exclude_patterns"] == [__file__]${CONFIG_TESTS}`,
    },
  ],
  'docs/cli.rst': [
    { old_text: 'Environment Variables From dotenv\n---------------------------------', new_text: CONFIG_DOCS },
  ],
};

// ---------------------------------------------------------------- the script

const TASK_A_MARK = "'off' and 'n'";
const TASK_B_MARK = 'flask config';

function userText(req: MockRequest): string {
  return req.messages.filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n');
}

function toolTexts(req: MockRequest): string[] {
  return req.messages.filter((m) => m.role === 'tool').map((m) => textOf(m.content));
}

/** sha256 of `path` from the latest read_file result, or from the prompt's "file sha256:" note. */
function shaOf(req: MockRequest, path: string): string {
  const reads = toolTexts(req).reverse();
  for (const t of reads) {
    const m = new RegExp(`path: ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\nsha256: ([0-9a-f]{64})`).exec(t);
    if (m) return m[1]!;
  }
  const inline = new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} lines \\d+-\\d+ \\(file sha256: ([0-9a-f]{64})\\)`).exec(userText(req));
  return inline?.[1] ?? '';
}

function call(name: string, args: unknown, text?: string): MockReply {
  return { toolCalls: [{ name, args }], ...(text ? { text } : {}) };
}

/** Next step of a fixed plan, chosen by how many tool results the conversation already has. */
export function demoScript(req: MockRequest): MockReply {
  const user = userText(req);
  const step = toolTexts(req).length;
  const last = toolTexts(req).at(-1) ?? '';

  if (user.includes(TASK_A_MARK)) {
    if (step === 0) {
      return call('propose_edit', {
        path: 'src/flask/helpers.py', base_sha256: shaOf(req, 'src/flask/helpers.py'),
        summary: "treat 'off' and 'n' as false and document every false value",
        edits: TASK_A_EDITS['src/flask/helpers.py'],
      }, "I'll extend the set of false values and list them in the docstring.");
    }
    return { text: /error|denied|rejected/i.test(last)
      ? 'The change was not applied; nothing else was modified.'
      : "Done: get_debug_flag now treats '0', 'false', 'no', 'off' and 'n' (any case) as false, and the docstring lists every false value." };
  }

  if (user.includes(TASK_B_MARK)) {
    const plan: Array<() => MockReply> = [
      // find_symbol is a deferred tool: it is reached through TrueForge's call_tool meta tool.
      () => call('call_tool', { mcp_server: 'vscode', tool_name: 'find_symbol', input: { name: 'routes_command' } }, 'Let me find where the built-in commands are defined.'),
      () => call('search_workspace', { query: 'self.add_command(routes_command)' }, 'And where they are registered.'),
      () => call('read_file', { path: 'src/flask/cli.py', start_line: 1050, end_line: 1130 }, 'The built-in commands live in src/flask/cli.py; reading the routes command.'),
      () => call('propose_edit', { path: 'src/flask/cli.py', base_sha256: shaOf(req, 'src/flask/cli.py'), summary: 'add the config command and register it', edits: TASK_B_EDITS['src/flask/cli.py'] },
        "I'll add config_command next to routes_command and register it in FlaskGroup."),
      () => call('read_file', { path: 'tests/test_cli.py', start_line: 1, end_line: 40 }, 'Now a test in tests/test_cli.py.'),
      () => call('propose_edit', { path: 'tests/test_cli.py', base_sha256: shaOf(req, 'tests/test_cli.py'), summary: 'test the config command and its help entry', edits: TASK_B_EDITS['tests/test_cli.py'] }),
      () => call('read_file', { path: 'docs/cli.rst', start_line: 130, end_line: 155 }, 'And the documentation next to the other built-in commands.'),
      () => call('propose_edit', { path: 'docs/cli.rst', base_sha256: shaOf(req, 'docs/cli.rst'), summary: 'document the config command', edits: TASK_B_EDITS['docs/cli.rst'] }),
      () => call('run_command', { command: 'python -m pytest tests/test_cli.py -q' }, 'Running the CLI tests.'),
    ];
    if (step < plan.length) return plan[step]!();
    return { text: `Added the \`flask config\` command (src/flask/cli.py), registered it with the other built-in commands so it appears in \`flask --help\`, covered it with tests in tests/test_cli.py, and documented it in docs/cli.rst. Test run: ${/(\d+ passed[^\n]*)/.exec(last)?.[1] ?? 'see the command output above'}.` };
  }

  return { text: 'This is the scripted demo model. It only knows the fixed Task A and Task B instructions; configure a real model in config/models.json for anything else.' };
}
