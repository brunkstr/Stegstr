# CI workflows

## Shell convention for multi-OS jobs

Jobs that run on **Windows** (e.g. via a matrix including `windows-latest`) use **PowerShell** as the default shell. Any step whose `run:` script uses **bash/sh** syntax must set **`shell: bash`** explicitly so the script runs in bash on all platforms.

Bash syntax includes: `[[ ... ]]`, `$(...)`, `$VAR`, `if ...; then ... fi`, `[ -f ... ]`, backticks, etc.

**Rule:** For any job that uses a matrix (or otherwise runs on `windows-latest`), any step with bash-like syntax in `run:` must include `shell: bash`.

This avoids parser errors such as "Missing '(' after 'if' in if statement" when the same step runs on Windows.
