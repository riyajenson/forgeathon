# Protected verification commands

Merged with the editor-side controls (see `docs/review/merge-origin-main.md`): protection is one layer of
several. Before a command reaches bubblewrap, the harness still requires your approval of the exact command
(or the narrowed auto-approval), flags anything outside the verification list as ⚠ Unrestricted, and applies
the per-turn command budget. A virtualenv outside the workspace (for example under `/tmp`) is bound read-only
so it stays visible after `/tmp` is replaced.

`run_command` still asks for approval of the exact command and directory. It now
runs through Linux bubblewrap with a read-only host filesystem, private `/tmp`
and `/run`, isolated network/process namespaces, and no inherited provider keys.
The live checkout cannot be edited through shell redirection or a test script.
Use `propose_edit` for all source changes. Tests may use disposable temporary files.
Commands see saved files; unsaved edits retain the existing warning.

Install `bubblewrap` through your Linux/WSL distribution package manager, then run:

```bash
bwrap --unshare-all --ro-bind / / --proc /proc --dev /dev -- true
```

If namespaces or bubblewrap are unavailable, the command tool refuses execution.
There is deliberately no unrestricted fallback. VS Code editing and model calls
do not require bubblewrap. Run commands in a supported Linux/WSL extension host.
This is separate from TrueForge's optional sandbox feature.

The filesystem is readable: this is write protection for a trusted development
workspace, not a confidentiality boundary for hostile repositories. Network tests,
tests writing into source directories, package installation, and build commands
writing project output need a different workflow. Do not weaken protection to
make those commands pass. The environment retains PATH/virtualenv and locale,
but drops API credentials; Flask applications requiring environment configuration
must be configured explicitly in the approved command.

Cancellation is checked after each preparation step and immediately before spawn.
An unsettled tool keeps the session busy even after the model has stopped; retry,
fallback, and subsequent turns are blocked until it actually finishes.

Reference: https://github.com/containers/bubblewrap/blob/main/bwrap.xml
