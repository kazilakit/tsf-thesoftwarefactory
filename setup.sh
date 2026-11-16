#!/bin/sh
# Sets up this clone: checks the tools, installs and builds the core, writes the local ./factory and
# factory.cmd launchers, installs the Claude Code plugin (user scope). Then run `./factory init` yourself.
# Running it again is safe: every step checks first. Nothing is installed globally except the plugin.
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

need() { # tool, url
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is missing: install it from $2"
    exit 1
  fi
}

# 1. Tools. Node must be 22 or newer.
need node https://nodejs.org
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  echo "node is too old: install version 22 or newer from https://nodejs.org"
  exit 1
fi
need git https://git-scm.com
need claude https://docs.claude.com/claude-code
need gh https://cli.github.com

# 2. Dependencies and build.
(cd core && npm ci)
(cd plugin && npm ci)
(cd core && npm run build)

# 3. Launchers (git-ignored). Each sets FACTORY_ROOT to its own folder.
cat > "$ROOT/factory" <<'EOF'
#!/bin/sh
FACTORY_ROOT="$(cd "$(dirname "$0")" && pwd)"
export FACTORY_ROOT
exec node "$FACTORY_ROOT/core/dist/cli.js" "$@"
EOF
chmod 755 "$ROOT/factory"
printf '@echo off\r\nset "FACTORY_ROOT=%%~dp0"\r\nif "%%FACTORY_ROOT:~-1%%"=="\\" set "FACTORY_ROOT=%%FACTORY_ROOT:~0,-1%%"\r\nnode "%%FACTORY_ROOT%%\\core\\dist\\cli.js" %%*\r\n' > "$ROOT/factory.cmd"

# 4. The plugin, unless it is already installed.
if claude plugin list 2>/dev/null | grep -q 'factory@the-software-factory'; then
  echo "plugin factory@the-software-factory is already installed"
else
  # `marketplace add` fails when the marketplace is already registered: add it only when it is missing.
  if claude plugin marketplace list 2>/dev/null | grep -q 'the-software-factory'; then
    echo "marketplace the-software-factory is already registered"
  else
    claude plugin marketplace add "$ROOT"
  fi
  claude plugin install factory@the-software-factory
fi

# 5. Next step: the wizard is run by the user.
echo
echo "Setup is done. Next, run: ./factory init"
