import { spawnSync } from 'node:child_process';
import { offlineNetworkStats } from './offline-guard.mjs';
import { counts, rebuildReport, saveReport, type EvaluationReport } from './report';
import type { EvaluationSection } from './types';

const loaders: Record<string, () => Promise<EvaluationSection>> = {
  scenarios: async () => (await import('./scenarios')).runScenarios(),
  retrieval: async () => (await import('./retrieval')).runRetrieval(),
  matching: async () => (await import('./matching')).runMatching(),
  validation: async () => (await import('./matching')).runValidation(),
  cache: async () => (await import('./backend')).runCache(),
  optimizer: async () => (await import('./backend')).runOptimizer(),
  failures: async () => (await import('./backend')).runFailures(),
  voice: async () => (await import('./backend')).runVoice(),
  response: async () => (await import('./backend')).runFinalResponses(),
  performance: async () => (await import('./performance')).runPerformance(),
  replay: async () => (await import('./replay')).runReplay(process.argv[2] === 'replay' && process.argv.length > 3 ? process.argv.slice(3) : undefined)
};

const baselineSuites = [
  { name: 'Engine', patterns: ['tests/engine/*.test.mjs'], ts: false, database: false },
  { name: 'Unit and agent', patterns: ['tests/unit/**/*.test.ts', 'tests/agent/**/*.test.ts'], ts: true, database: false },
  { name: 'Credit protection', patterns: ['tests/evaluation/live-budget.test.mjs'], ts: false, database: false },
  { name: 'Database and integration', patterns: ['tests/database/**/*.test.ts', 'tests/integration/**/*.test.ts'], ts: true, database: true },
  { name: 'HTTP (production build)', patterns: ['tests/e2e/**/*.test.ts'], ts: true, database: true }
];

function baseline(): EvaluationSection {
  return {
    name: 'Existing regression suites', mode: 'DETERMINISTIC',
    notes: ['Every child inherits the network guard. Database suites create only disposable test databases using the isolated evaluation URI.'],
    cases: baselineSuites.map(({ name, patterns, ts, database }) => {
      const start = performance.now();
      const uri = database ? process.env.SMARTCART_EVAL_MONGO_URI ?? '' : '';
      const suite = spawnSync(process.execPath, [
        ...(ts ? ['--import', 'tsx'] : []),
        '--test', ...(database ? ['--test-concurrency=1'] : []), ...patterns
      ], {
        encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 180_000,
        env: { ...process.env, MONGODB_URI: uri }
      });
      const raw = (suite.stdout ?? '') + (suite.stderr ?? '');
      const summary = Object.fromEntries([...raw.matchAll(/^# (tests|pass|fail|skipped|cancelled) (\d+)\s*$/gmu)]
        .map(match => [match[1], Number(match[2])]));
      const skip = raw.split(/\r?\n/u).filter(line => /^\s*ok \d+.*# SKIP/u.test(line));
      const failures = [...raw.matchAll(/^[ \t]*not ok[^\r\n]*(?:\r?\n(?!\s*(?:ok|not ok|# Subtest))[^\r\n]*){0,15}/gmu)].map(row => row[0]);
      const status = suite.status !== 0 ? 'fail' : summary.pass ? 'pass' : 'skip';
      return {
        id: 'SUITE-' + name.split(' ', 1)[0]!, title: name, status,
        category: 'existing regression tests', component: patterns.join(', '), expected: 'All eligible tests pass',
        actual: summary, durationMs: performance.now() - start,
        logs: status === 'fail' ? [...failures, ...(suite.error ? [String(suite.error)] : []), ...(failures.length ? [] : [raw.slice(-4_000)])]
          : skip.length ? skip : database && !uri ? ['No isolated SMARTCART_EVAL_MONGO_URI was supplied.'] : undefined
      };
    })
  };
}

function recommendations(sections: EvaluationSection[]): EvaluationReport['recommendations'] {
  const failures = sections.flatMap(section => section.cases).filter(entry => entry.status === 'fail');
  const has = (pattern: RegExp) => failures.some(entry => pattern.test(entry.id + ' ' + entry.title));
  return [
    ...(has(/RESP|final answer|final response/iu) ? [{
      priority: 1, finding: 'A verified basket can be followed by conflicting model text.',
      action: 'Render product names, package counts, prices, store and availability directly from the verified basket or validate assertions before returning them.'
    }] : []),
    ...(has(/retriev|search|RET-/iu) ? [{
      priority: 2, finding: 'Broad retrieval can still miss relevant offers.',
      action: 'Use independently labelled barcode tests to evaluate multilingual synonyms, alternate spellings and candidate ranking. Optimize for recall and track cheapest-valid retrieval.'
    }] : []),
    ...(has(/VALID-17|semantic error/iu) ? [{
      priority: 3, finding: 'Structural consistency and catalog quotes allow coherent identity errors.',
      action: 'Measure real semantic decisions with a budgeted held-out sample. Consider independently verified product type evidence before treating a model verdict as final.'
    }] : []),
    ...(failures.some(entry => entry.id.startsWith('SC-') &&
      entry.logs?.some(log => /quantity|servingsSource|qualifier wording/iu.test(log))) ? [{
      priority: 4, finding: 'Some natural quantity and serving phrases fail request validation.',
      action: 'Add independently labelled Hebrew shorthand, fractional quantities and container phrasing to the production request parser regression set before changing its grammar.'
    }] : []),
    ...(has(/cache.*concurr|concurr.*cache|cold concurrency/iu) ? [{
      priority: 5, finding: 'Concurrent cache misses can duplicate model work.',
      action: 'Coalesce matching for the same versioned key and repeat the controlled overlap test.'
    }] : []),
    ...(has(/retryinfo|retry-after|retry.delay/iu) ? [{
      priority: 6, finding: 'Provider retry hints may not match the application backoff.',
      action: 'Use bounded provider retry hints and check the retry deadline before waiting.'
    }] : []),
    ...(has(/voice.*duplic|duplic.*voice|duplicate tool/iu) ? [{
      priority: 7, finding: 'Duplicate Live tool calls can trigger repeated shopping work.',
      action: 'Deduplicate call IDs within each voice session and return the original tool response.'
    }] : [])
  ];
}

async function main() {
  const command = process.argv[2] ?? 'all';
  if (process.env.SMARTCART_EVAL_OFFLINE !== '1') throw new Error('Use the offline guard preload.');
  if (command === 'report') {
    const files = await rebuildReport();
    console.log(files.html);
    return;
  }
  if (command !== 'all' && command !== 'baseline' && !Object.hasOwn(loaders, command)) {
    throw new Error('Unknown evaluation section ' + command);
  }
  const sections: EvaluationSection[] = [];
  const selected = command === 'all' ? ['baseline', ...Object.keys(loaders)] : [command];
  for (const name of selected) {
    console.log('Running offline evaluation: ' + name);
    try {
      sections.push(name === 'baseline' ? baseline() : await loaders[name]!());
    } catch (error) {
      sections.push({ name, mode: 'DETERMINISTIC', cases: [
        { id: 'RUN-' + name, title: 'Section could not run', status: 'fail', component: name, actual: String(error) }
      ] });
    }
    const section = sections.at(-1)!;
    const summary = counts(section.cases);
    console.log(section.name + ' ' + JSON.stringify(summary));
  }
  const report: EvaluationReport = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), runner: 'smartcart-offline',
    externalAiRequests: 0, network: offlineNetworkStats(), sections, recommendations: recommendations(sections)
  };
  const files = await saveReport(report, command === 'all' ? 'evaluation' : command);
  console.log(files.html + '\n' + files.json);
  if (sections.some(section => section.cases.some(entry => entry.status === 'fail'))) process.exitCode = 1;
}

await main();
