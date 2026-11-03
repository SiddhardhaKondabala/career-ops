// tests/cv-experience-groups.test.mjs — labelled bullet runs inside one role.
//
// A consultant, agency employee or contractor holds ONE title at ONE employer
// while the work splits by client. A flat `bullets` array cannot say so, and
// the two workarounds both damage the document: repeating the role header once
// per client invents three jobs where the source CV has one, and folding the
// client name into each bullet ("Acme: Built …") rewrites the candidate's own
// sentences. `experience[].groups` carries the split the source CV already
// makes.
//
// Assertions run against rendered HTML from the real CLI, not against source
// patterns, because what matters is reading ORDER across two <ul> boundaries —
// unobservable from the builder's source text.
import { pass, fail, ownRootEnv, ROOT, NODE } from './helpers.mjs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

console.log('\nCV experience groups (labelled bullet runs inside one role)');

const SCRIPT = join(ROOT, 'build-cv-html.mjs');

// A minimal template: just enough placeholders for the builder to fill, so the
// assertions read the experience block and nothing else.
const TEMPLATE = `<!DOCTYPE html>
<!-- career-ops-template
name: Groups Fixture
version: 1.0.0
-->
<html lang="{{LANG}}">
<head><meta charset="UTF-8"><title>{{NAME}} — CV</title>
<style>.page { max-width: {{PAGE_WIDTH}}; }</style></head>
<body><div class="page">
  <h1>{{NAME}}</h1>
  <div class="contact-row"><a href="mailto:{{EMAIL}}">{{EMAIL}}</a></div>
  <div class="section">
    <div class="section-title">{{SECTION_EXPERIENCE}}</div>
    {{EXPERIENCE}}
  </div>
</div></body></html>
`;

// Uses {{BODY}}, which owns its own <ul> tags because a group label sits
// BETWEEN lists and cannot live inside the single <ul> that wraps {{BULLETS}}.
const PARTIAL_BODY = `<!--ENTRY-->
<div class="job">
  <div class="job-role">{{ROLE}}</div>
  <div class="job-company">{{COMPANY}}</div>
{{BODY}}
</div>
<!--/ENTRY-->
`;

// The shape every shipped partial has today: one <ul> around {{BULLETS}}.
const PARTIAL_BULLETS = `<!--ENTRY-->
<div class="job">
  <div class="job-company">{{COMPANY}}</div>
  <div class="job-role">{{ROLE}}</div>
  <ul>
    {{BULLETS}}
  </ul>
</div>
<!--/ENTRY-->
`;

const PAYLOAD = {
  candidate: { name: 'Test Candidate', email: 'test@example.com' },
  experience: [{
    company: 'Consultancy Ltd',
    role: 'Consultant',
    dates: 'Aug 2022 - Present',
    groups: [
      { label: 'Client: Alpha', bullets: ['Alpha first', 'Alpha second'] },
      { label: 'Client: Beta', bullets: ['Beta only'] },
    ],
  }],
};

// Render `payload` with `partial` (or with no partial at all) and return the
// HTML plus the run, so a test can assert on either.
function render(name, payload, partial) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `career-ops-groups-${name}-`)));
  try {
    const templateDir = join(dir, 'templates');
    mkdirSync(templateDir, { recursive: true });
    const templatePath = join(templateDir, 'cv-template.fixture.html');
    writeFileSync(templatePath, TEMPLATE);
    if (partial) {
      mkdirSync(join(templateDir, 'sections'), { recursive: true });
      writeFileSync(join(templateDir, 'sections', 'experience.html'), partial);
    }
    const input = join(dir, 'payload.json');
    const output = join(dir, 'cv.html');
    writeFileSync(input, JSON.stringify(payload, null, 2));
    const run = spawnSync(NODE, [SCRIPT, input, output, templatePath], {
      cwd: dir, encoding: 'utf-8', timeout: 60_000, env: ownRootEnv(),
    });
    let html = '';
    try { html = readFileSync(output, 'utf-8'); } catch { /* render failed */ }
    return { html, run };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Positions of each needle in `html`, -1 when absent. Order assertions compare
// these rather than matching one big regex, so a failure names the needle.
function at(html, ...needles) {
  return needles.map(n => html.indexOf(n));
}

// ── 1. Grouped bullets render a label and a list per group, in payload order ──
{
  const { html, run } = render('body', PAYLOAD, PARTIAL_BODY);
  if (!html) {
    fail(`grouped render produced no HTML: ${(run.stdout || '') + (run.stderr || '')}`);
  } else {
    const [alphaLabel, alphaFirst, alphaSecond, betaLabel, betaOnly] = at(
      html,
      '<div class="job-group">Client: Alpha</div>',
      'Alpha first', 'Alpha second',
      '<div class="job-group">Client: Beta</div>',
      'Beta only',
    );
    if ([alphaLabel, alphaFirst, alphaSecond, betaLabel, betaOnly].some(i => i === -1)) {
      fail('grouped render dropped a label or a bullet '
        + `(alpha label ${alphaLabel}, bullets ${alphaFirst}/${alphaSecond}, `
        + `beta label ${betaLabel}, bullet ${betaOnly})`);
    } else if (!(alphaLabel < alphaFirst && alphaFirst < alphaSecond
                 && alphaSecond < betaLabel && betaLabel < betaOnly)) {
      fail('grouped bullets rendered out of reading order');
    } else {
      pass('each group renders its label above its own bullets, in payload order');
    }

    // The label must sit between two lists, not inside one — that is the whole
    // reason {{BODY}} exists and the one thing a single <ul> cannot express.
    const lists = html.match(/<ul>/g) || [];
    if (lists.length !== 2) {
      fail(`expected one <ul> per group, got ${lists.length}`);
    } else {
      pass('each group gets its own <ul> (the label is not an <li>)');
    }
  }
}

// ── 2. An old partial still renders every bullet ─────────────────────────────
// {{BULLETS}} carries the grouped bullets flattened, so a partial written
// before groups existed loses the LABELS and never a bullet. A CV going out
// short with no warning is the #3523 failure this contract exists to prevent.
{
  const { html, run } = render('bullets', PAYLOAD, PARTIAL_BULLETS);
  if (!html) {
    fail(`flat-partial render produced no HTML: ${(run.stdout || '') + (run.stderr || '')}`);
  } else {
    const items = (html.match(/<li>/g) || []).length;
    const missing = ['Alpha first', 'Alpha second', 'Beta only'].filter(b => !html.includes(b));
    if (missing.length) {
      fail(`a {{BULLETS}} partial dropped grouped bullets: ${missing.join(', ')}`);
    } else if (items !== 3) {
      fail(`expected 3 <li> from a {{BULLETS}} partial, got ${items}`);
    } else if (html.includes('job-group')) {
      fail('a {{BULLETS}} partial emitted a group label it has no slot for');
    } else {
      pass('a partial that predates groups still renders every bullet');
    }
  }
}

// ── 3. The built-in builder (no partial at all) groups too ───────────────────
{
  const { html, run } = render('builtin', PAYLOAD, null);
  if (!html) {
    fail(`built-in render produced no HTML: ${(run.stdout || '') + (run.stderr || '')}`);
  } else {
    const [label, bullet] = at(html, 'Client: Alpha', 'Alpha first');
    if (label === -1 || bullet === -1 || label > bullet) {
      fail('the built-in builder did not render grouped bullets under their label');
    } else {
      pass('the built-in builder renders groups without a partial');
    }
  }
}

// ── 4. bullets and groups coexist; ungrouped work renders first ───────────────
{
  const mixed = {
    ...PAYLOAD,
    experience: [{ ...PAYLOAD.experience[0], bullets: ['Firm-wide work'] }],
  };
  const { html, run } = render('mixed', mixed, PARTIAL_BODY);
  if (!html) {
    fail(`mixed render produced no HTML: ${(run.stdout || '') + (run.stderr || '')}`);
  } else {
    const [ungrouped, firstLabel] = at(html, 'Firm-wide work', 'Client: Alpha');
    if (ungrouped === -1) {
      fail('ungrouped bullets vanished when groups were present');
    } else if (firstLabel === -1 || ungrouped > firstLabel) {
      fail('ungrouped bullets must render before the first group');
    } else {
      pass('ungrouped bullets render before the labelled runs');
    }
  }
}

// ── 5. A label is escaped, not injected ──────────────────────────────────────
{
  const hostile = {
    ...PAYLOAD,
    experience: [{
      ...PAYLOAD.experience[0],
      groups: [{ label: 'Client: <script>x</script> & Co', bullets: ['Did work'] }],
    }],
  };
  const { html, run } = render('escape', hostile, PARTIAL_BODY);
  if (!html) {
    fail(`escaping render produced no HTML: ${(run.stdout || '') + (run.stderr || '')}`);
  } else if (html.includes('<script>x</script>')) {
    fail('a group label reached the document as live markup');
  } else if (!html.includes('&lt;script&gt;') || !html.includes('&amp; Co')) {
    fail('a group label was not HTML-escaped');
  } else {
    pass('a group label is escaped like every other field');
  }
}

// ── 6. A malformed `groups` fails the render instead of losing bullets ───────
// Each of these renders a label with nothing under it, or nothing at all. The
// builder must refuse rather than write a CV that is quietly short.
{
  const malformed = [
    ['an object instead of an array', { label: 'Client: Alpha', bullets: ['x'] }],
    ['a group with no label', [{ bullets: ['x'] }]],
    ['a group with no bullets', [{ label: 'Client: Alpha' }]],
    ['a group whose bullets are all blank', [{ label: 'Client: Alpha', bullets: ['', '  '] }]],
    ['a string where a group belongs', ['Client: Alpha']],
  ];
  let refused = 0;
  for (const [what, groups] of malformed) {
    const payload = { ...PAYLOAD, experience: [{ ...PAYLOAD.experience[0], groups }] };
    const { html, run } = render('malformed', payload, PARTIAL_BODY);
    const said = (run.stdout || '') + (run.stderr || '');
    if (run.status === 0 || html) {
      fail(`${what} was accepted — a CV would go out short (exit ${run.status})`);
    } else if (!/groups/.test(said)) {
      fail(`${what} was refused without naming groups: ${said.trim().slice(0, 200)}`);
    } else {
      refused++;
    }
  }
  if (refused === malformed.length) {
    pass(`every malformed groups shape is refused by name (${refused} cases)`);
  }
}
