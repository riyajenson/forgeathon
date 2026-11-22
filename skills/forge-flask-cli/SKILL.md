---
name: forge-flask-cli
description: How Flask's built-in CLI commands are defined, registered, tested and documented (Flask 3.x), for tasks that add or change a `flask` subcommand.
---

# Flask CLI commands

Use this when a task adds or changes a built-in `flask <command>`.

- **Define** the command in `src/flask/cli.py` as a `click.Command` (usually `@click.command("name")` plus
  `@with_appcontext` when it needs `current_app`). Look at `run_command`, `shell_command` and `routes_command`.
- **Register** it in `FlaskGroup.__init__`, next to `self.add_command(run_command)`, `shell_command` and
  `routes_command`. A command only defined, not registered, does not appear in `flask --help`.
- **Test** in `tests/test_cli.py` with the `runner` fixture (`FlaskCliRunner` via `app.test_cli_runner()`), e.g.
  `result = runner.invoke(args=["name"])`, then assert on `result.exit_code` and `result.output`. Add a new
  test class; never replace an existing one.
- **Document** it in `docs/cli.rst`, in the section that lists the built-in commands.
- Run only `python -m pytest tests/test_cli.py -q` to verify.
