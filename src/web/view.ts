import type { RunEvidence, RunSummary } from '../evidence-view.js';
import type { QueryGroups } from '../query-groups.js';

const main = document.querySelector<HTMLElement>('#investigation')!;
const runs = document.querySelector<HTMLUListElement>('#runs')!;
const refresh = document.querySelector<HTMLAnchorElement>('#refresh')!;
const verdicts = { pass: 'Passed', regression: 'Regression', inconclusive: 'Inconclusive' };
const stages = { cold: 'Cold read', warm: 'Warm read', 'after-rename': 'Read after rename' };
const queryLabels: Record<keyof QueryGroups, string> = {
  orders: 'Read orders',
  customer: 'Look up one customer',
  customerBatch: 'Look up customers in a batch',
  other: 'Other PostgreSQL calls',
};

function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function runLink(id: string, label: string) {
  const link = element('a', '', label);
  link.href = '/?run=' + encodeURIComponent(id);
  return link;
}

function badge(verdict: RunSummary['verdict']) {
  return element('span', 'verdict ' + verdict, verdicts[verdict]);
}

function shortCommit(commit: string) {
  return commit.slice(0, 8);
}

function renderList(summaries: RunSummary[], active: string) {
  if (!summaries.length) {
    runs.append(element('li', 'nav-empty', 'No saved runs yet'));
    return;
  }
  for (const run of summaries) {
    const item = element('li');
    const link = runLink(run.runId, '');
    link.className = 'run-link';
    if (run.runId === active) link.setAttribute('aria-current', 'page');

    const row = element('span', 'run-row');
    const stamp = element('time', '', new Date(run.createdAt).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }));
    stamp.dateTime = run.createdAt;
    row.append(badge(run.verdict), stamp);
    const label = run.fixtureImplementation ?? shortCommit(run.candidateCommit);
    link.append(row, element('code', 'run-label', shortCommit(run.baseCommit) + ' → ' + label));
    item.append(link);
    runs.append(item);
  }
}

function commands(run: RunEvidence) {
  const details = element('details', 'commands');
  details.append(element('summary', '', 'Replay and source'));
  const list = element('dl', 'command-list');
  for (const [label, command] of [
    ['Replay this case', 'npm run demo -- replay ' + run.runId],
    ['Inspect the candidate at its recorded commit', 'git show ' + run.candidateCommit + ':' + run.sourcePath],
  ]) {
    const description = element('dd');
    description.append(element('code', '', command));
    list.append(element('dt', '', label), description);
  }
  details.append(list);
  return details;
}

function pathLane(side: string, count: number, measured: boolean) {
  const lane = element('li', 'lane');
  lane.append(element('strong', 'lane-label', side));
  const route = element('div', 'route');
  const unit = measured ? 'call' : 'reported read';
  const callCount = element('span', 'read-count', count + ' ' + unit + (count === 1 ? '' : 's'));
  route.append(
    element('code', 'route-node', 'GET /orders'),
    element('span', 'route-edge'),
    element('code', 'route-node', 'ordersService'),
    callCount,
    element('code', 'route-node destination', 'PostgreSQL'),
  );
  lane.append(route);
  return lane;
}

function queryBreakdown(groups: { reference: QueryGroups; candidate: QueryGroups } | undefined) {
  if (!groups) return element('p', 'muted archive-note', 'This recording contains totals. New recordings also include query groups.');
  const table = element('table', 'queries');
  table.append(element('caption', '', 'PostgreSQL client calls'));
  const head = table.createTHead().insertRow();
  for (const label of ['Query group', 'Baseline', 'Candidate']) {
    const column = element('th', '', label);
    column.scope = 'col';
    head.append(column);
  }
  const body = table.createTBody();
  for (const key of Object.keys(queryLabels) as (keyof QueryGroups)[]) {
    const before = groups.reference[key];
    const after = groups.candidate[key];
    if (before === 0 && after === 0) continue;
    const row = body.insertRow();
    const heading = element('th', '', queryLabels[key]);
    heading.scope = 'row';
    row.append(heading, element('td', 'number', String(before)), element('td', 'number', String(after)));
  }
  return table;
}

function evidence(run: RunEvidence, observed: NonNullable<RunEvidence['observed']>) {
  const article = element('section', 'request-section');
  const heading = element('div', 'section-heading');
  heading.append(element('h2', '', 'Request path'), element('code', 'muted', 'PostgreSQL ' + observed.postgres));
  const controls = element('div', 'steps');
  controls.setAttribute('role', 'group');
  controls.setAttribute('aria-label', 'Read to inspect');
  const panel = element('div', 'request');
  panel.setAttribute('aria-live', 'polite');

  const difference = observed.mismatch;
  const firstDifferentRead = difference
    ? (difference.readIndex ?? observed.reads.findIndex(read => read.stage === difference.stage))
    : -1;
  const buttons: HTMLButtonElement[] = [];

  function select(index: number) {
    const selected = observed.reads[index];
    if (!selected) return;
    for (const [position, button] of buttons.entries()) {
      button.setAttribute('aria-pressed', String(position === index));
    }
    const paths = element('ul', index === firstDifferentRead ? 'paths changed' : 'paths');
    paths.setAttribute('aria-label', stages[selected.stage] + ' comparison');
    const measured = observed.callMetric === 'postgres-client-calls';
    paths.append(pathLane('Baseline', selected.reference, measured), pathLane('Candidate', selected.candidate, measured));
    panel.replaceChildren(paths, queryBreakdown(selected.queryGroups));
  }

  let readIndex = 0;
  for (const step of run.plan?.steps ?? []) {
    if (step === 'rename') {
      controls.append(element('span', 'write-step', 'Rename customer ' + run.plan!.customerId + ' to Avery'));
      continue;
    }
    const position = readIndex++;
    const read = observed.reads[position];
    if (!read) continue;
    const button = element('button', 'stage', stages[read.stage]);
    button.type = 'button';
    if (position === firstDifferentRead) {
      button.classList.add('changed');
      button.setAttribute('aria-label', stages[read.stage] + ', first response difference');
    }
    button.onclick = () => select(position);
    buttons.push(button);
    controls.append(button);
  }
  select(Math.max(firstDifferentRead, 0));
  article.append(heading, controls, panel);
  return article;
}

function renderRun(run: RunEvidence) {
  const title = element('header', 'run-header');
  const titleLine = element('div', 'title-line');
  titleLine.append(element('h1', '', 'Orders investigation'), badge(run.verdict));
  const identity = element('p', 'identity');
  identity.append(
    element('span', '', 'Baseline'),
    element('code', '', shortCommit(run.baseCommit)),
    element('span', '', 'Candidate'),
    element('code', '', shortCommit(run.candidateCommit)),
  );
  if (run.fixtureImplementation) identity.append(element('code', '', run.fixtureImplementation));
  if (run.planner) identity.append(element('span', 'planner-label', run.planner === 'rule' ? 'Rule plan' : 'Ollama plan'));
  title.append(titleLine, identity);

  const parent = run.verificationOf ?? run.replayOf;
  if (parent) {
    const lineage = element('p', 'lineage', run.verificationOf ? 'Verifies ' : 'Replay of ');
    lineage.append(runLink(parent, parent.slice(0, 8)));
    title.append(lineage);
  }

  main.replaceChildren(title);
  if (run.observed) {
    main.append(evidence(run, run.observed));
    const finding = element('section', 'finding');
    const mismatch = run.observed.mismatch;
    if (mismatch) {
      finding.append(element('h2', '', 'First response difference'));
      const compare = element('dl', 'difference');
      for (const [label, order] of [['Expected', mismatch.expected], ['Candidate', mismatch.actual]] as const) {
        const description = element('dd');
        description.append(element('code', '', order ? 'Order ' + order.id : 'No order'));
        if (order) description.append(element('span', '', order.customerName));
        compare.append(element('dt', '', label), description);
      }
      finding.append(compare);
    } else {
      finding.append(element('h2', '', 'Responses matched'));
      finding.append(element('p', '', 'Every recorded read matched the fixture’s order and freshness requirements.'));
    }
    main.append(finding);
  } else {
    main.append(element('p', 'status-note', 'The runner marked this comparison inconclusive. Replay locally to inspect the diagnostic.'));
  }
  main.append(commands(run));
}

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(response.status === 404 ? 'Investigation not found.' : 'Could not read local evidence.');
  return response.json() as Promise<T>;
}

try {
  const { runs: summaries } = await json<{ runs: RunSummary[] }>('/api/runs');
  const selected = new URL(location.href).searchParams.get('run') ?? summaries[0]?.runId;
  renderList(summaries, selected ?? '');
  if (selected) {
    refresh.href = '/?run=' + encodeURIComponent(selected);
    renderRun(await json<RunEvidence>('/api/runs/' + encodeURIComponent(selected)));
  } else {
    const notice = element('section', 'empty');
    notice.append(element('h1', '', 'No saved investigations'));
    notice.append(element('p', '', 'Record the orders cache case, then refresh this view.'));
    notice.append(element('code', '', 'npm run demo -- record cache'));
    main.replaceChildren(notice);
  }
} catch (error) {
  const failure = element('p', 'status-note', error instanceof Error ? error.message : 'Could not load the investigation.');
  failure.setAttribute('role', 'alert');
  main.replaceChildren(failure);
}
