import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { redactSecrets } from '@/lib/shared/errors';
import type { EvaluationCase, EvaluationSection, EvaluationStatus } from './types';

export const reportDirectory = resolve('reports', 'evaluation');
const statuses: EvaluationStatus[] = ['pass', 'fail', 'skip', 'requires-live'];

export function counts(cases: readonly EvaluationCase[]): Record<EvaluationStatus, number> {
  return Object.fromEntries(statuses.map(status => [status, cases.filter(entry => entry.status === status).length])) as Record<EvaluationStatus, number>;
}

export interface EvaluationReport {
  schemaVersion: 1;
  generatedAt: string;
  runner: string;
  externalAiRequests: number;
  network?: Record<string, unknown>;
  sections: EvaluationSection[];
  recommendations: Array<{ priority: number; finding: string; action: string }>;
}

const clean = (value: string) => redactSecrets(value)
  .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer [redacted]')
  .replace(/\bauth_tokens\/[A-Za-z0-9._~+%/-]+/giu, '[redacted]');
const esc = (value: string) => value.replace(/[&<>"']/gu, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const code = (value: unknown) => value === undefined ? '' : esc(JSON.stringify(value, null, 2));

function detail(label: string, value: unknown): string {
  return value === undefined ? '' : '<h4>' + esc(label) + '</h4><pre>' + code(value) + '</pre>';
}

function sectionHtml(section: EvaluationSection, index: number) {
  const result = counts(section.cases);
  const groups = [...new Set(section.cases.map(entry => entry.category).filter((entry): entry is string => Boolean(entry)))];
  const breakdown = groups.length ? '<table><thead><tr><th>Category</th><th>Pass</th><th>Fail</th><th>Skip</th><th>Requires live</th></tr></thead><tbody>' +
    groups.map(group => {
      const bucket = counts(section.cases.filter(entry => entry.category === group));
      return '<tr><th>' + esc(group) + '</th>' + statuses.map(status => '<td>' + bucket[status] + '</td>').join('') + '</tr>';
    }).join('') + '</tbody></table>' : '';
  const entries = section.cases.map(entry =>
    '<details class="case" data-status="' + entry.status + '"' + (entry.status === 'fail' ? ' open' : '') + '><summary>' +
    '<span class="badge ' + entry.status + '">' + entry.status + '</span> <strong>' + esc(entry.id) + '</strong> ' + esc(entry.title) +
    (entry.durationMs !== undefined ? '<span class="timing">' + entry.durationMs.toFixed(1) + ' ms</span>' : '') + '</summary>' +
    detail('Customer request', entry.request) + detail('Expected', entry.expected) + detail('Observed', entry.actual) +
    detail('Responsible component', entry.component) + detail('Evidence', entry.logs) + detail('Measurements', entry.metrics) + '</details>'
  ).join('');
  return '<section id="section-' + index + '"><h2>' + esc(section.name) + ' <small>' + section.mode + '</small></h2>' +
    '<p class="total">' + section.cases.length + ' cases · ' + result.pass + ' passed · ' + result.fail + ' failed · ' +
    result.skip + ' skipped · ' + result['requires-live'] + ' require live</p>' +
    (section.notes ?? []).map(note => '<p>' + esc(note) + '</p>').join('') + breakdown +
    (section.metrics ? '<details><summary>Section measurements</summary><pre>' + code(section.metrics) + '</pre></details>' : '') +
    entries + '</section>';
}

export function renderReport(report: EvaluationReport): string {
  const sections = report.sections;
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>SmartCart evaluation</title><style>' +
    'body{background:#f6f7f9;color:#172236;font:16px/1.5 system-ui,sans-serif;margin:0}main{max-width:1100px;margin:auto;padding:28px 20px 70px}' +
    'h1{font-size:2em;margin:0}h2{margin-top:0}small,.timing{font-size:.75em;color:#52637b}a{color:#1559a4}' +
    'section{background:white;border:1px solid #d8dfeb;border-radius:10px;padding:18px;margin:18px 0}nav{display:flex;flex-wrap:wrap;gap:6px 18px}' +
    'table{border-collapse:collapse;margin:12px 0}th,td{text-align:left;padding:4px 12px;border-bottom:1px solid #e1e7f0}' +
    'pre{background:#f4f6fa;padding:8px;white-space:pre-wrap;overflow-wrap:anywhere}summary{cursor:pointer;padding:8px 4px}' +
    'details{border-bottom:1px solid #e5e9f1}h4{margin-bottom:0}.timing{margin-left:8px}.badge{display:inline-block;font-size:.72em;padding:2px 8px;border-radius:5px;text-transform:uppercase}' +
    '.badge.pass{background:#d7f1df;color:#075129}.badge.fail{background:#fee3e2;color:#8d1425}.badge.skip,.badge.requires-live{background:#ebeff8;color:#3e506b}' +
    '</style><main><header><h1>SmartCart evaluation</h1><p>Generated ' + esc(report.generatedAt) + ' · ' +
    report.externalAiRequests + ' external AI requests</p><p>MOCK evaluates backend behavior with simulated replies. REPLAY evaluates intact recordings. DETERMINISTIC checks code and labelled data. LIVE evaluates actual responses for the listed requests.</p></header>' +
    '<nav>' + sections.map((section, index) => '<a href="#section-' + index + '">' + esc(section.name) + '</a>').join('') + '</nav>' +
    '<label>Case status <select id="status"><option value="">All statuses</option>' +
    statuses.map(status => '<option value="' + status + '">' + esc(status) + '</option>').join('') + '</select></label>' +
    sections.map(sectionHtml).join('') + '<section><h2>Recommendations</h2><ol>' + report.recommendations.map(row =>
      '<li><strong>' + esc(row.finding) + '</strong> ' + esc(row.action) + '</li>').join('') + '</ol></section>' +
    '<script>document.getElementById("status").addEventListener("change",e=>{for(const item of document.querySelectorAll(".case"))item.hidden=!!e.target.value&&item.dataset.status!==e.target.value})</script></main></html>';
}

export async function saveReport(report: EvaluationReport, name: string) {
  await mkdir(reportDirectory, { recursive: true });
  const raw = JSON.stringify(report, (_key, value: unknown) => typeof value === 'string' ? clean(value) : value, 2);
  const sanitized = JSON.parse(raw) as EvaluationReport;
  const json = resolve(reportDirectory, name + '.json');
  const html = resolve(reportDirectory, name + '.html');
  await Promise.all([writeFile(json, raw + '\n', 'utf8'), writeFile(html, renderReport(sanitized), 'utf8')]);
  return { json, html };
}

export async function rebuildReport(name = 'evaluation') {
  const report = JSON.parse(await readFile(resolve(reportDirectory, name + '.json'), 'utf8')) as EvaluationReport;
  return saveReport(report, name);
}
