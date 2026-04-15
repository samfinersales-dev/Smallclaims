// auto-update.js
// Monthly compliance check that automatically opens a GitHub Pull Request
// with proposed code fixes when regulatory changes are found.
// Human reviews and merges — never auto-deploys.

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CONFIG = {
  domain:         process.env.SITE_DOMAIN,
  siteName:       process.env.SITE_NAME,
  appType:        process.env.APP_TYPE,
  regulatoryArea: process.env.REGULATORY_AREA,
  checkItems:     process.env.CHECK_ITEMS,
  githubToken:    process.env.GITHUB_TOKEN,
  githubRepo:     process.env.GITHUB_REPOSITORY, // auto-set by GitHub Actions e.g. "samfinersales-dev/Formguard"
};

const API_KEY = process.env.ANTHROPIC_API_KEY;

// ── CLAUDE API ───────────────────────────────────────────────────────────────
function callClaude(prompt, useSearch) {
  return new Promise(function(resolve, reject) {
    var payload = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      tools: useSearch ? [{ type: 'web_search_20250305', name: 'web_search' }] : undefined,
      messages: [{ role: 'user', content: prompt }]
    });
    var req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try {
          var parsed = JSON.parse(data);
          var text = (parsed.content || [])
            .filter(function(b) { return b.type === 'text'; })
            .map(function(b) { return b.text; })
            .join('\n').trim();
          if (!text) reject(new Error('Empty response: ' + data.slice(0, 200)));
          else resolve(text);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── GITHUB API ───────────────────────────────────────────────────────────────
function githubRequest(method, endpoint, body) {
  return new Promise(function(resolve, reject) {
    var payload = body ? JSON.stringify(body) : '';
    var [owner, repo] = CONFIG.githubRepo.split('/');
    var req = https.request({
      hostname: 'api.github.com',
      path: '/repos/' + CONFIG.githubRepo + endpoint,
      method: method,
      headers: {
        'Authorization': 'Bearer ' + CONFIG.githubToken,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'auto-update-bot',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── STEP 1: CHECK FOR REGULATORY CHANGES ─────────────────────────────────────
async function checkRegulations() {
  var today = new Date().toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'});
  var items = CONFIG.checkItems.split(',').map(function(s){ return s.trim(); });

  var prompt = 'Today is ' + today + '.\n\n' +
    'You are a regulatory compliance auditor for ' + CONFIG.siteName + ' (' + CONFIG.domain + ').\n' +
    'App type: ' + CONFIG.appType + '\n' +
    'Regulatory area: ' + CONFIG.regulatoryArea + '\n\n' +
    'Search for regulatory changes, new laws, updated guidance, or significant developments in this area from the last 45 days.\n\n' +
    'Check each item:\n' +
    items.map(function(item, i){ return (i+1) + '. ' + item; }).join('\n') + '\n\n' +
    'Respond using EXACTLY this format:\n\n' +
    'OVERALL_RISK: LOW|MEDIUM|HIGH\n' +
    'CHANGES_FOUND: YES|NO\n\n' +
    'FINDING_1_STATUS: OK|NEEDS_UPDATE|URGENT\n' +
    'FINDING_1_ITEM: [which item]\n' +
    'FINDING_1_DETAIL: [what changed and source URL]\n' +
    'FINDING_1_ACTION: [exactly what needs to change in the app]\n\n' +
    '[repeat FINDING_N blocks for each item that needs attention, skip OK items]\n\n' +
    'SUMMARY: [2-3 sentence plain English summary of what was found]';

  console.log('Checking regulations for ' + CONFIG.siteName + '...');
  return await callClaude(prompt, true);
}

// ── STEP 2: GENERATE CODE FIX ────────────────────────────────────────────────
async function generateFix(finding, indexHtml) {
  var prompt = 'You are a web developer fixing a compliance issue in a single-file HTML app.\n\n' +
    'Site: ' + CONFIG.siteName + ' (' + CONFIG.domain + ')\n' +
    'Issue: ' + finding.item + '\n' +
    'Detail: ' + finding.detail + '\n' +
    'Required action: ' + finding.action + '\n\n' +
    'Here is the relevant section of index.html (first 8000 chars):\n\n' +
    indexHtml.slice(0, 8000) + '\n\n' +
    'Provide the minimal code change needed. Respond using EXACTLY this format:\n\n' +
    'CHANGE_DESCRIPTION: [one sentence describing what you changed]\n' +
    'OLD_TEXT: [exact text to find and replace — must be unique in the file]\n' +
    'NEW_TEXT: [replacement text]\n\n' +
    'Rules:\n' +
    '- OLD_TEXT must be unique enough to find exactly once in the file\n' +
    '- Only change what is necessary for compliance\n' +
    '- Do not rewrite entire sections\n' +
    '- If the change requires adding new content, include surrounding context in OLD_TEXT';

  return await callClaude(prompt, false);
}

// ── STEP 3: APPLY FIX TO FILE ─────────────────────────────────────────────────
function applyFix(html, fixResponse) {
  var oldMatch = fixResponse.match(/OLD_TEXT:\s*([\s\S]*?)(?=\nNEW_TEXT:)/);
  var newMatch = fixResponse.match(/NEW_TEXT:\s*([\s\S]*?)(?=\n[A-Z_]+:|$)/);
  var descMatch = fixResponse.match(/CHANGE_DESCRIPTION:\s*([^\n]+)/);

  if (!oldMatch || !newMatch) {
    console.log('Could not parse fix response — skipping this change');
    return { html: html, applied: false, description: 'Parse failed' };
  }

  var oldText = oldMatch[1].trim();
  var newText = newMatch[1].trim();
  var description = descMatch ? descMatch[1].trim() : 'Compliance update';

  if (!html.includes(oldText)) {
    console.log('OLD_TEXT not found in file — skipping: ' + oldText.slice(0, 60));
    return { html: html, applied: false, description: description };
  }

  var count = (html.match(new RegExp(oldText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  if (count > 1) {
    console.log('OLD_TEXT not unique (' + count + ' matches) — skipping');
    return { html: html, applied: false, description: description };
  }

  return { html: html.replace(oldText, newText), applied: true, description: description };
}

// ── STEP 4: CREATE PULL REQUEST ──────────────────────────────────────────────
async function createPR(changes, findings, summary) {
  var date = new Date().toISOString().split('T')[0];
  var branchName = 'compliance-update-' + date;

  // Create branch
  try {
    var mainRef = await githubRequest('GET', '/git/ref/heads/main');
    var sha = mainRef.object ? mainRef.object.sha : null;
    if (!sha) { console.log('Could not get main SHA'); return; }

    await githubRequest('POST', '/git/refs', {
      ref: 'refs/heads/' + branchName,
      sha: sha
    });
    console.log('Created branch: ' + branchName);
  } catch(e) {
    console.log('Branch creation failed:', e.message);
    return;
  }

  // Commit each changed file
  for (var change of changes) {
    try {
      var currentFile = await githubRequest('GET', '/contents/' + change.path + '?ref=' + branchName);
      var content = Buffer.from(change.content).toString('base64');
      await githubRequest('PUT', '/contents/' + change.path, {
        message: 'fix: ' + change.description,
        content: content,
        sha: currentFile.sha,
        branch: branchName
      });
      console.log('Committed: ' + change.path);
    } catch(e) {
      console.log('Commit failed for ' + change.path + ':', e.message);
    }
  }

  // Build PR body
  var prBody = '## Automated Compliance Update\n\n' +
    '**Site:** ' + CONFIG.siteName + ' (' + CONFIG.domain + ')\n' +
    '**Date:** ' + date + '\n\n' +
    '### Summary\n' + summary + '\n\n' +
    '### Changes Made\n' +
    changes.filter(function(c){ return c.applied; }).map(function(c){
      return '- **' + c.path + '**: ' + c.description;
    }).join('\n') + '\n\n' +
    '### Findings\n' +
    findings.map(function(f){
      return '**' + (f.status === 'URGENT' ? '🔴' : '🟡') + ' ' + f.item + '**\n' +
        f.detail + '\n\n' +
        '> Action required: ' + f.action;
    }).join('\n\n') + '\n\n' +
    '### Review Checklist\n' +
    '- [ ] Changes are factually accurate\n' +
    '- [ ] Changes do not break existing functionality\n' +
    '- [ ] Tested on staging or verified visually\n' +
    '- [ ] Legal review completed if required\n\n' +
    '⚠️ **Do not merge without reviewing each change above.** This PR was generated automatically.';

  var pr = await githubRequest('POST', '/pulls', {
    title: '🔄 Compliance update — ' + CONFIG.siteName + ' (' + date + ')',
    body: prBody,
    head: branchName,
    base: 'main'
  });

  if (pr.html_url) {
    console.log('✅ Pull Request created: ' + pr.html_url);
    return pr.html_url;
  } else {
    console.log('PR creation response:', JSON.stringify(pr).slice(0, 200));
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Auto-update check — ' + CONFIG.siteName);
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  if (!CONFIG.domain) throw new Error('SITE_DOMAIN not set');
  if (!CONFIG.githubToken) throw new Error('GITHUB_TOKEN not set');
  if (!CONFIG.githubRepo) throw new Error('GITHUB_REPOSITORY not set');

  // Step 1: Check regulations
  var checkResult = await checkRegulations();
  console.log('\nRegulation check result:\n' + checkResult.slice(0, 500));

  // Parse overall risk and whether changes found
  var riskMatch = checkResult.match(/OVERALL_RISK:\s*(\w+)/);
  var changesMatch = checkResult.match(/CHANGES_FOUND:\s*(\w+)/);
  var summaryMatch = checkResult.match(/SUMMARY:\s*([\s\S]*?)(?=\n[A-Z_]+:|$)/);

  var risk = riskMatch ? riskMatch[1] : 'LOW';
  var changesFound = changesMatch ? changesMatch[1] === 'YES' : false;
  var summary = summaryMatch ? summaryMatch[1].trim() : 'No significant changes found.';

  console.log('\nRisk level: ' + risk);
  console.log('Changes found: ' + changesFound);

  if (!changesFound || risk === 'LOW') {
    console.log('✅ No updates needed — everything looks current');
    // Write a simple log entry
    fs.mkdirSync('compliance-reports', { recursive: true });
    fs.appendFileSync('compliance-reports/check-log.txt',
      new Date().toISOString() + ' | ' + CONFIG.siteName + ' | ' + risk + ' | No PR needed\n');
    execSync('git config user.name "compliance-bot"');
    execSync('git config user.email "compliance-bot@users.noreply.github.com"');
    execSync('git add compliance-reports/ 2>/dev/null || true');
    execSync('git diff --staged --quiet || git commit -m "compliance: monthly check ' + new Date().toISOString().split('T')[0] + ' — no changes needed"');
    execSync('git push origin main');
    return;
  }

  // Parse findings that need action
  var findings = [];
  var findingRegex = /FINDING_(\d+)_STATUS:\s*(\w+)\nFINDING_\d+_ITEM:\s*([^\n]+)\nFINDING_\d+_DETAIL:\s*([^\n]+)\nFINDING_\d+_ACTION:\s*([^\n]+)/g;
  var match;
  while ((match = findingRegex.exec(checkResult)) !== null) {
    if (match[2] !== 'OK') {
      findings.push({
        status: match[2],
        item: match[3].trim(),
        detail: match[4].trim(),
        action: match[5].trim()
      });
    }
  }

  if (!findings.length) {
    console.log('No actionable findings — skipping PR');
    return;
  }

  console.log('\nFindings requiring action: ' + findings.length);
  findings.forEach(function(f, i){ console.log((i+1) + '. [' + f.status + '] ' + f.item); });

  // Step 2: Read current index.html
  var indexPath = 'index.html';
  if (!fs.existsSync(indexPath)) {
    console.log('index.html not found — cannot generate fixes');
    return;
  }
  var indexHtml = fs.readFileSync(indexPath, 'utf8');

  // Step 3: Generate and apply fixes
  var changes = [];
  var updatedHtml = indexHtml;

  for (var finding of findings) {
    console.log('\nGenerating fix for: ' + finding.item);
    try {
      var fixResponse = await generateFix(finding, updatedHtml);
      var result = applyFix(updatedHtml, fixResponse);
      if (result.applied) {
        updatedHtml = result.html;
        changes.push({
          path: 'index.html',
          content: updatedHtml,
          description: result.description,
          applied: true
        });
        console.log('✅ Fix applied: ' + result.description);
      } else {
        console.log('⚠️ Fix not applied: ' + result.description);
        // Still add to PR body as manual review item
        changes.push({
          path: 'index.html',
          content: updatedHtml,
          description: '(manual review needed) ' + finding.action,
          applied: false
        });
      }
    } catch(e) {
      console.log('Fix generation failed:', e.message);
    }
  }

  // Step 4: Create PR
  var appliedChanges = changes.filter(function(c){ return c.applied; });
  if (appliedChanges.length === 0) {
    console.log('No changes could be auto-applied — creating informational PR');
  }

  // Deduplicate — only commit index.html once with all changes applied
  var uniqueChanges = [];
  var seenPaths = {};
  changes.forEach(function(c) {
    if (!seenPaths[c.path]) {
      seenPaths[c.path] = true;
      uniqueChanges.push(c);
    }
  });

  var prUrl = await createPR(uniqueChanges, findings, summary);

  // Exit with error if URGENT — GitHub will send email notification
  if (risk === 'HIGH' || findings.some(function(f){ return f.status === 'URGENT'; })) {
    console.error('🔴 URGENT compliance issues found — review PR immediately: ' + prUrl);
    process.exit(1);
  }
}

main().catch(function(e) {
  console.error('Fatal error:', e.message || e);
  process.exit(1);
});
