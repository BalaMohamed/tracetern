"""Prepare and run the frozen paired review using public Git objects."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tarfile
from time import monotonic


ROOT = Path(__file__).resolve().parents[2]
INPUTS = ROOT / '.tracetern/paired-review-inputs'
HERE = Path(__file__).resolve().parent
MANIFEST = json.loads((HERE / 'cases.json').read_text())
PROMPT = (HERE / 'prompt.md').read_text()


def name(case):
    return case['repo'].replace('/', '-') + '-' + str(case['pr'])


def repository(case):
    return INPUTS / case['repo'].replace('/', '-')


def archive(repo, commit, destination):
    snapshot = subprocess.check_output(['git', '-C', repo, 'archive', commit])
    destination.mkdir()
    with tarfile.open(fileobj=io.BytesIO(snapshot)) as tree:
        tree.extractall(destination, filter='data')


def experiment(cli, cwd, *args):
    started = monotonic()
    run = subprocess.run(['node', cli, *args, '--json'], cwd=cwd, check=False,
                         capture_output=True, text=True, timeout=120)
    if run.returncode not in (0, 1, 2):
        raise RuntimeError('TraceTern exited without a comparison')
    return json.loads(run.stdout), round((monotonic() - started) * 1000)


def prepare(output, runner_root):
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=runner_root, text=True).strip()
    if commit != MANIFEST['traceTernCommit']:
        raise RuntimeError('Prepare evidence from the pinned TraceTern commit')
    cli = runner_root / 'dist/src/cli.js'
    evidence = output / 'evidence-workspace'
    evidence.mkdir(parents=True)
    for seed in MANIFEST['seeds']:
        repo = ROOT / '.tracetern' / ('tanstack-query' if seed['repo'] == 'TanStack/query' else 'zustand')
        result, _ = experiment(cli, evidence, seed['command'], repo, seed['base'], seed['head'], *seed.get('args', []))
        if result['verdict'] != 'pass' or not result.get('checks'):
            raise RuntimeError('Seed experiment did not produce passing checks: ' + seed['head'])

    for case in MANIFEST['cases']:
        case_dir = output / name(case)
        baseline = case_dir / 'baseline'
        baseline.mkdir(parents=True)
        diff = (INPUTS / (name(case) + '.diff')).read_bytes()
        if hashlib.sha256(diff).hexdigest() != case['diffSha256']:
            raise RuntimeError('Diff digest mismatch for ' + name(case))
        (baseline / 'change.diff').write_bytes(diff)
        repo = repository(case)
        archive(repo, case['base'], baseline / 'base')
        archive(repo, case['head'], baseline / 'candidate')
        assisted = case_dir / 'assisted'
        shutil.copytree(baseline, assisted, symlinks=True)

        raw, duration = experiment(cli, evidence, 'run-suggested', repo, case['base'], case['head'])
        public_fields = ('verdict', 'reasonCode', 'baseCommit', 'candidateCommit',
                         'plan', 'checks', 'selection', 'runId')
        report = {key: raw[key] for key in public_fields if key in raw}
        report.setdefault('baseCommit', case['base'])
        report.setdefault('candidateCommit', case['head'])
        (assisted / 'evidence.json').write_text(json.dumps(report, indent=2) + '\n')
        (case_dir / 'runner-ms.txt').write_text(str(duration) + '\n')
        print(name(case), report['verdict'], report.get('reasonCode', ''), flush=True)


def review(output):
    reviewer = MANIFEST['reviewer']
    version = subprocess.check_output(['codex', '--version'], text=True).split()
    if not version or version[-1] != reviewer['version']:
        raise RuntimeError('Review with the Codex CLI version recorded in the manifest')
    for index, case in enumerate(MANIFEST['cases']):
        case_dir = output / name(case)
        arms = ('baseline', 'assisted') if index % 2 == 0 else ('assisted', 'baseline')
        for arm in arms:
            transcript = case_dir / (arm + '.jsonl')
            diagnostic = case_dir / (arm + '.stderr')
            status = case_dir / (arm + '.status.json')
            response = case_dir / (arm + '.md')
            if status.exists():
                continue
            args = [
                'codex', 'exec', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only',
                '--skip-git-repo-check', '-C', str(case_dir / arm), '-m', reviewer['model'],
                '-c', f'model_reasoning_effort="{reviewer["reasoningEffort"]}"',
                '-c', 'project_doc_max_bytes=0', '--json', '--output-last-message', str(response), '-',
            ]
            started = monotonic()
            with transcript.open('wb') as log, diagnostic.open('wb') as err:
                child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=log, stderr=err, start_new_session=True)
                try:
                    child.communicate(PROMPT.encode(), timeout=reviewer['maxSeconds'])
                    outcome = 'complete' if child.returncode == 0 and response.is_file() else 'failed'
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.communicate(timeout=10)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.communicate()
                    outcome = 'timeout'
            elapsed = round((monotonic() - started) * 1000)
            status.write_text(json.dumps({'outcome': outcome, 'wallMs': elapsed, 'exitCode': child.returncode}) + '\n')
            print(name(case), arm, outcome, elapsed, flush=True)
            if outcome == 'failed':
                raise RuntimeError('Review process failed. See its local stderr before rerunning.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['prepare', 'review'])
    parser.add_argument('output', type=Path)
    parser.add_argument('--runner-root', type=Path, default=ROOT)
    options = parser.parse_args()
    if options.mode == 'prepare':
        prepare(options.output.resolve(), options.runner_root.resolve())
    else:
        review(options.output.resolve())
