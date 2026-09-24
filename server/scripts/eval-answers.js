// Answer-quality evaluation: asks every question in eval/questions.json through the running API and
// scores the answers. Run against a server that has eval/demo-docs loaded (use --load to upload
// and index them first).
//
//   node scripts/eval-answers.js --user <name> --password <pw> [--api http://localhost:4000] [--load] [--runs 2]
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, index, all) => {
  if (arg.startsWith('--')) pairs.push([arg.slice(2), all[index + 1]?.startsWith('--') || all[index + 1] === undefined ? true : all[index + 1]]);
  return pairs;
}, []));
const api = args.api || 'http://localhost:4000';
const runs = Number(args.runs) || 1;
const evalDir = fileURLToPath(new URL('../eval/', import.meta.url));
const { cases } = JSON.parse(readFileSync(`${evalDir}questions.json`, 'utf8'));

const login = await fetch(`${api}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: args.user, password: args.password })
});
if (!login.ok) throw new Error(`login failed: ${login.status}`);
const { token } = await login.json();
const headers = { authorization: `Bearer ${token}` };

async function waitForDocument(id, predicate) {
  for (;;) {
    const { document } = await (await fetch(`${api}/api/documents/${id}`, { headers })).json();
    if (predicate(document)) return document;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

if (args.load) {
  const mimeTypes = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    png: 'image/png'
  };
  for (const name of readdirSync(`${evalDir}demo-docs`)) {
    const extension = name.split('.').pop();
    const form = new FormData();
    form.append('file', new Blob([readFileSync(`${evalDir}demo-docs/${name}`)], { type: mimeTypes[extension] }), name);
    const { document } = await (await fetch(`${api}/api/documents`, { method: 'POST', headers, body: form })).json();
    await fetch(`${api}/api/documents/${document.id}/${extension === 'png' ? 'ocr' : 'extract'}`, { method: 'POST', headers });
    await waitForDocument(document.id, (doc) => ['extracted', 'failed'].includes(doc.status));
    await fetch(`${api}/api/documents/${document.id}/index`, { method: 'POST', headers });
    await waitForDocument(document.id, (doc) => ['indexed', 'failed'].includes(doc.embeddingStatus));
    console.log(`loaded ${name}`);
  }
}

function scoreCase(testCase, result) {
  const answer = result.answer || '';
  if (testCase.refuse) return { correct: result.status === 'no_evidence', sourceOk: true };
  const correct = result.status === 'completed'
    && (testCase.expect || []).every((pattern) => new RegExp(pattern, 'i').test(answer))
    && !(testCase.reject || []).some((pattern) => new RegExp(pattern, 'i').test(answer));
  const sourceOk = !testCase.source || (result.citations || []).some((citation) => citation.documentName.includes(testCase.source));
  return { correct, sourceOk };
}

const totals = { correct: 0, sourceOk: 0, citedDocuments: 0, answered: 0, seconds: [], asked: 0 };
const perCase = new Map();
for (let run = 1; run <= runs; run += 1) {
  for (const testCase of cases) {
    const startedAt = Date.now();
    const response = await fetch(`${api}/api/questions`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ question: testCase.question })
    });
    const result = await response.json();
    const seconds = (Date.now() - startedAt) / 1000;
    const { correct, sourceOk } = scoreCase(testCase, result);
    const citedDocuments = new Set((result.citations || []).map((citation) => citation.documentId)).size;
    totals.asked += 1;
    totals.correct += correct ? 1 : 0;
    totals.sourceOk += sourceOk ? 1 : 0;
    totals.seconds.push(seconds);
    if (result.status === 'completed') {
      totals.answered += 1;
      totals.citedDocuments += citedDocuments;
    }
    const entry = perCase.get(testCase.id) || { passes: 0, answers: [] };
    entry.passes += correct ? 1 : 0;
    entry.answers.push(`${correct ? 'PASS' : 'FAIL'} ${seconds.toFixed(1)}s [${result.answerModel || result.status}] docs:${citedDocuments} ${(result.answer || '').replace(/\s+/g, ' ').slice(0, 150)}`);
    perCase.set(testCase.id, entry);
  }
}

for (const [id, entry] of perCase) {
  console.log(`\n${entry.passes === runs ? '✔' : entry.passes ? '~' : '✖'} ${id} (${entry.passes}/${runs})`);
  for (const answer of entry.answers) console.log(`    ${answer}`);
}
const sorted = [...totals.seconds].sort((a, b) => a - b);
console.log(`\nSCORE: ${totals.correct}/${totals.asked} correct (${Math.round((100 * totals.correct) / totals.asked)}%)` +
  ` | right source cited: ${totals.sourceOk}/${totals.asked}` +
  ` | avg documents cited per answer: ${(totals.citedDocuments / Math.max(totals.answered, 1)).toFixed(1)}` +
  ` | latency median ${sorted[Math.floor(sorted.length / 2)].toFixed(1)}s, max ${sorted[sorted.length - 1].toFixed(1)}s`);
