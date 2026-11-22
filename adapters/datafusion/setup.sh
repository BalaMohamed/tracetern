#!/usr/bin/env bash
set -eu
# Keep both native engines isolated from each other and the user's Python.
for binding in 54.0.0 55.0.0; do
  env_dir=".tracetern/datafusion/venvs/$binding"
  uv venv --allow-existing --python 3.12 "$env_dir"
  uv pip install --only-binary :all: --python "$env_dir/bin/python" \
    "datafusion==$binding" pyarrow==22.0.0 cloudpickle==3.1.3 typing-extensions==4.16.0
done
