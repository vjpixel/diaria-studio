import { classifyExecTrack } from '../lib/issue-exec-track.ts';
import fs from 'node:fs';
const issues = JSON.parse(fs.readFileSync('/tmp/overnight_issues_260828f.json', 'utf8'));
const out = issues.map((i: any) => ({
  number: i.number,
  track: classifyExecTrack({ labels: i.labels.map((l: any) => l.name), body: i.body || '', state: 'open' }),
  title: i.title,
}));
for (const o of out) console.log(`${o.number}\t${o.track}\t${o.title}`);
