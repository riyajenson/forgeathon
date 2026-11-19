# Third-party notices

This repository's own code is MIT-licensed (see `LICENSE`). It contains no vendored third-party source
code; dependencies are installed by npm from the public registry at the exact versions in the lockfiles.
Their licences, checked with `license-checker` on the harness's production dependency tree, are all
permissive (MIT, ISC, BSD-2-Clause, BSD-3-Clause).

## Runtime and development dependencies used directly

| Component | Version | Licence | Use |
|---|---|---|---|
| [TrueForge](https://github.com/truefoundry/trueforge) (`@truefoundry/trueforge`) | 0.185.1 | MIT | Agent harness, run locally with `npx`; not redistributed |
| `@truefoundry/trueforge-sdk` | 0.185.0 | MIT | TrueForge HTTP client used by the harness |
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT | MCP server for the editor tools |
| `zod` | 4.6.7 | MIT | Tool input schemas |
| `typescript` | 5.9.3 / 5.6.x | Apache-2.0 | Build only |
| `@types/node`, `@types/vscode` | 22.20.5 / 1.95.0 | MIT | Build only |
| `@vscode/test-electron` | 2.5.2 | MIT | Extension tests only (downloads VS Code at test time) |
| `md-to-pdf` (via `npx`) | 5.x | MIT | Optional: renders the write-up PDF; not a dependency |

## Flask (demo target)

The demo and tests operate on [Flask](https://github.com/pallets/flask) 3.1.3 (commit `22d92470`), which is
cloned separately and is not part of this repository. `src/harness/testing/demo-script.ts` quotes short
excerpts of Flask source lines as search anchors and contains new code written for the demo tasks.

Flask is licensed under the BSD 3-Clause License:

```
Copyright 2010 Pallets

Redistribution and use in source and binary forms, with or without modification, are permitted provided
that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the
   following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the
   following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or
   promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED
WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH
DAMAGE.
```

## Tools fetched at test time (not distributed)

`scripts/test-extension.sh` downloads Visual Studio Code (Microsoft) through `@vscode/test-electron` and, when
missing, the Ubuntu packages `libnspr4`, `libnss3` and `libasound2t64` with `apt-get download` into the user's
cache. These are used only to run tests locally.
