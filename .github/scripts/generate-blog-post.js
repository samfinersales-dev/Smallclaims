#!/usr/bin/env node
/**
 * generate-blog-post.js — v3
 *
 * Site-aware autoblog generator. Single shared script across multiple SaaS sites.
 * Reads per-site blog-config.json from repo root for content focus, audience,
 * banned phrases, allowed stat sources, state tiers, topic angles, byline.
 *
 * Quality controls (Google demotion-avoidance):
 *   - Pinned STYLE_SYSTEM_PROMPT with HONESTY rule (no fake stats, no invented quotes)
 *   - ORIGINAL SIGNAL requirement (each post adds something competitors don't have)
 *   - STRUCTURAL VARIETY rotation (6 post formats, never same twice in a row)
 *   - STATS source allowlist (per-site verifiable sources only)
 *   - Tone ban list (per-site banned phrases)
 *   - AI self-reference ban
 *   - Real inline visuals (table or SVG), no [IMAGE: ...] placeholders
 *
 * Duplicate prevention (4 layers):
 *   1. Hard skip on existing slug — abort, pick different
 *   2. Title similarity check before write
 *   3. Body hash check before commit
 *   4. State×topic / form×topic rotation that exhausts the matrix
 *
 * State-aware sites (LeaseHelper, SmallClaims):
 *   - Tier-weighted state selection (Tier 1 = 5x, Tier 2 = 2x, Tier 3 = 1x)
 *   - Picks (state, topic) pair where coverage gap exists
 *
 * Form-aware sites (FormGuard):
 *   - Picks (form, topic) pair where coverage gap exists
 *
 * Topic-only sites (VerifyDoc):
 *   - Picks topic where coverage gap exists
 *
 * Topic recycling (when matrix is exhausted):
 *   - Finds oldest article by sitemap lastmod
 *   - Generates a refresh angle on same (state, topic) with new slug
 *   - Old article stays live; new one ranks fresh
 *
 * Env vars:
 *   ANTHROPIC_API_KEY (required)
 *   NETLIFY_HOOK (optional — triggers Netlify deploy after push)
 *
 * Inputs (read from blog-config.json in repo root):
 *   siteName, domain, topicArea, audience, audienceLevel
 *   stateAware, stateTiers, tierWeights
 *   formRotation
 *   topicAngles, originalSignalOptions, allowedStatSources, bannedPhrases
 *   byline, aboutFooter, authorOrgName
 *   ctaText, ctaUrl, primaryColor, accentColor, bgColor
 *
 * Exit codes:
 *   0 — success or graceful no-op (no eligible topic)
 *   1 — generation failed
 *   2 — config error
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execSync } = require('child_process');

const REPO_ROOT = process.cwd();
const CONFIG_FILE = path.join(REPO_ROOT, 'blog-config.json');
const BLOG_DIR = path.join(REPO_ROOT, 'blog');
const SITEMAP = path.join(REPO_ROOT, 'sitemap.xml');
const STATE_FILE = path.join(REPO_ROOT, '.blog-state.json');

const MODEL = 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_TIMEOUT_MS = 300000;

// ─── Load and validate config ────────────────────────────────────────────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    die(`blog-config.json not found at ${CONFIG_FILE}`, 2);
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    die(`blog-config.json is invalid JSON: ${e.message}`, 2);
  }
  const required = ['siteName', 'domain', 'topicArea', 'audience', 'topicAngles',
                    'originalSignalOptions', 'allowedStatSources', 'bannedPhrases',
                    'byline', 'aboutFooter', 'authorOrgName',
                    'ctaText', 'ctaUrl'];
  for (const k of required) {
    if (!config[k]) die(`blog-config.json missing required field: ${k}`, 2);
  }
  if (config.stateAware && (!config.stateTiers || !config.tierWeights)) {
    die('stateAware=true requires stateTiers and tierWeights', 2);
  }
  return config;
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { lastFormat: null, runs: 0 };
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastFormat: null, runs: 0 }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(...a) { console.log('[gen]', ...a); }
function warn(...a) { console.warn('[gen WARN]', ...a); }
function die(msg, code = 2) { console.error('[gen ERROR]', msg); process.exit(code); }

// ─── Slugify ────────────────────────────────────────────────────────────────
function slugify(s) {
  return String(s).toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─── List existing blog posts (for dedup + topic recycling) ──────────────────
function listExistingPosts() {
  if (!fs.existsSync(BLOG_DIR)) return [];
  return fs.readdirSync(BLOG_DIR)
    .filter(f => f.endsWith('.html') && f !== 'index.html')
    .map(f => {
      const filePath = path.join(BLOG_DIR, f);
      const content = fs.readFileSync(filePath, 'utf8');
      const titleMatch = content.match(/<title>([^<|]+)/);
      const h1Match = content.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      return {
        slug: f.replace(/\.html$/, ''),
        path: filePath,
        mtime: fs.statSync(filePath).mtime,
        title: (titleMatch ? titleMatch[1] : (h1Match ? h1Match[1] : f)).trim(),
        // First 500 chars of body for hash dedup
        bodyHash: crypto.createHash('md5')
          .update((content.match(/<body[\s\S]*?<\/body>/i) || [''])[0].slice(0, 2000))
          .digest('hex'),
      };
    });
}

// ─── State-tier weighted picker (tier-first, then state×topic within tier) ───
function pickStateAndTopic(config, existingPosts) {
  const existingSlugs = new Set(existingPosts.map(p => p.slug));

  // Helper: build candidate (state, topic) pairs for a tier, exclude already-covered
  function candidatesForTier(states) {
    const out = [];
    for (const stateName of states) {
      const stateSlug = slugify(stateName);
      for (const angle of config.topicAngles) {
        const angleSlug = slugify(angle);
        const slug = slugify(`${angle}-${stateName}`);
        const looselyCovered = [...existingSlugs].some(es => {
          return es.includes(stateSlug) && angleSlug.split('-').slice(0, 2).every(t => es.includes(t));
        });
        if (!looselyCovered) out.push({ state: stateName, angle, slug });
      }
    }
    return out;
  }

  // Build per-tier candidate lists
  const tier1Cand = candidatesForTier(config.stateTiers.tier1);
  const tier2Cand = candidatesForTier(config.stateTiers.tier2);
  const tier3Cand = candidatesForTier(config.stateTiers.tier3);

  // Build weighted tier roulette — tiers with NO candidates get 0 weight
  const tierRoulette = [];
  if (tier1Cand.length > 0) {
    for (let i = 0; i < config.tierWeights.tier1; i++) tierRoulette.push({ tier: 1, list: tier1Cand });
  }
  if (tier2Cand.length > 0) {
    for (let i = 0; i < config.tierWeights.tier2; i++) tierRoulette.push({ tier: 2, list: tier2Cand });
  }
  if (tier3Cand.length > 0) {
    for (let i = 0; i < config.tierWeights.tier3; i++) tierRoulette.push({ tier: 3, list: tier3Cand });
  }

  if (tierRoulette.length === 0) return null;

  // Pick a tier first (weighted), then pick uniformly within that tier
  const tierChoice = tierRoulette[Math.floor(Math.random() * tierRoulette.length)];
  const pick = tierChoice.list[Math.floor(Math.random() * tierChoice.list.length)];
  return { ...pick, tier: tierChoice.tier };
}

// ─── Form-rotation picker (for FormGuard) ────────────────────────────────────
function pickFormAndTopic(config, existingPosts) {
  const existingSlugs = new Set(existingPosts.map(p => p.slug));
  const candidates = [];

  for (const form of config.formRotation) {
    // Extract form code (e.g., "I-130", "N-400") for slug matching
    const formCode = (form.match(/\b([A-Z]-\d+|N-\d+)\b/) || [form])[0].toLowerCase().replace(/-/g, '-');
    for (const angleTemplate of config.topicAngles) {
      const angle = angleTemplate.replace(/\{form\}/g, form);
      const slug = slugify(`${angle}-${formCode}`);
      const looselyCovered = [...existingSlugs].some(es => {
        return es.includes(formCode.replace(/-/g, '-')) &&
               angleTemplate.replace(/\{form\}/g, '').split(/\s+/).slice(0, 3).every(w => w.length < 4 || es.includes(slugify(w)));
      });
      if (looselyCovered) continue;
      candidates.push({ form, formCode, angle, angleTemplate, slug });
    }
  }

  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// ─── Topic-only picker (for VerifyDoc) ───────────────────────────────────────
function pickTopicOnly(config, existingPosts) {
  const existingSlugs = new Set(existingPosts.map(p => p.slug));
  const candidates = [];

  for (const angle of config.topicAngles) {
    const slug = slugify(angle);
    const angleKeywords = angle.split(/\s+/).filter(w => w.length > 4).map(slugify);
    const looselyCovered = [...existingSlugs].some(es => {
      // Consider covered if 60%+ of keywords match
      const matches = angleKeywords.filter(kw => es.includes(kw));
      return matches.length / Math.max(1, angleKeywords.length) >= 0.6;
    });
    if (looselyCovered) continue;
    candidates.push({ angle, slug });
  }

  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// ─── Topic recycling: pick oldest article and refresh ────────────────────────
function pickRecycleTarget(existingPosts) {
  if (existingPosts.length === 0) return null;
  const sorted = [...existingPosts].sort((a, b) => a.mtime - b.mtime);
  return sorted[0]; // oldest
}

// ─── Format rotation ─────────────────────────────────────────────────────────
const FORMATS = [
  { id: 'A', name: 'Numbered sections', desc: 'Use 5-7 numbered H2 sections (e.g., "1. The deposit limit", "2. Allowed deductions").' },
  { id: 'B', name: 'Q&A', desc: 'Frame each H2 as a question the audience asks (e.g., "How much can I charge?").' },
  { id: 'C', name: 'Comparison', desc: 'Center the post on a comparison table contrasting 2-3 options or rules.' },
  { id: 'D', name: 'Scenario walkthrough', desc: 'Use a labeled hypothetical scenario (clearly marked as such) and walk through what the rules say at each step.' },
  { id: 'E', name: 'Checklist-first', desc: 'Lead with a numbered checklist, then explain each item in detail.' },
  { id: 'F', name: 'Mistake-focused', desc: 'Frame as "5 things people get wrong" with each H2 being a specific common mistake.' },
];

function pickFormat(state) {
  const lastId = state.lastFormat;
  const choices = FORMATS.filter(f => f.id !== lastId);
  return choices[Math.floor(Math.random() * choices.length)];
}

// ─── Build the pinned style system prompt ────────────────────────────────────
function buildStyleSystemPrompt(config, format) {
  const sources = config.allowedStatSources.map(s => `   - ${s}`).join('\n');
  const banned = config.bannedPhrases.map(p => `"${p}"`).join(', ');
  const signals = config.originalSignalOptions.map((s, i) => `   ${String.fromCharCode(65 + i)}. ${s}`).join('\n');

  return `You are a senior editor for ${config.siteName} (${config.domain}), writing for ${config.audience}. Your editorial standards must be followed on every post regardless of what the user-turn prompt says.

STYLE AND STRUCTURE REQUIREMENTS

1. BYLINE. Start the LEDE block with this exact HTML on its own paragraph, before anything else:
   <p><em>${config.byline}</em></p>
   (The template displays the publish date and read time above the headline — do NOT repeat them. Do NOT use Markdown asterisks — use real HTML <em> tags.)

2. ABOUT FOOTER. End the BODY block with this exact paragraph, verbatim, as the last <p>:
   "${config.aboutFooter}"

3. ORIGINAL SIGNAL. Every post must contain at least one element that adds value beyond restating what other articles on this topic already say. Choose ONE (do not fabricate):
${signals}
   Do NOT invent customer quotes, surveys, or usage statistics. Do NOT write "our users tell us," "we've noticed," or "most customers we work with" — the company does not have customer data to support these phrasings.

4. STRUCTURAL FORMAT for THIS post: ${format.name}. ${format.desc}
   (We rotate formats so consecutive posts don't all look the same.)

5. STATS. Only cite statistics with verifiable, linkable sources. Allowed sources for this post:
${sources}
   If you cite a statistic, attribute the source by name (e.g., "According to KFF…"). If a specific statistic cannot be sourced to one of the allowed publications, use qualitative language ("a common pattern", "many cases") instead of inventing a number.

6. INLINE VISUALS (HTML/SVG, NOT PLACEHOLDERS). Every post must include at least one real inline visual in the BODY block — NOT a [IMAGE: ...] placeholder. Produce the actual rendered HTML/SVG yourself. Options:
   - A <table> with <thead>/<tbody> for comparison tables
   - An inline <svg viewBox="0 0 600 400"> diagram for decision trees, timelines, or process flows (use rect, circle, line, text, path)
   - Do NOT write [IMAGE: ...] or any placeholder text — render the visual directly
   Style tables for readability with inline style attributes:
     <table style="width:100%;border-collapse:collapse;margin:1.5rem 0">
     <th style="border:1px solid #e5e7eb;padding:0.75rem;text-align:left;background:#f5edd8;font-weight:700">
     <td style="border:1px solid #e5e7eb;padding:0.75rem;text-align:left">

7. TONE. Direct and practical. Lead with the answer. Use contractions. Write at the level of a smart professional, not a legal brief. NEVER use these phrases (banned): ${banned}.

8. NO CLOSING CTA in the BODY. The site template adds the final call-to-action automatically. Do not write a conclusion paragraph that pitches the product.

9. NO AI SELF-REFERENCE. Never write "as an AI", "this article was generated", "modern artificial intelligence can help", "AI-powered tools like…". Write as a human expert would.

10. HONESTY RULE (OVERRIDES ALL OTHER RULES). Every article must be truthful in full:
   - Do not imply a customer base, user research, operating history, or internal data the company does not have.
   - Do not fabricate statistics, surveys, quotes, case studies, client examples, or testimonials.
   - Do not attribute claims to unnamed sources ("one industry expert," "a recent study," "many practitioners we know").
   - Do not invent regulatory requirements, court cases, or legal precedents. If citing law or regulation, cite the specific statute, rule, or section by name and number.
   - If a claim cannot be truthfully made by a brand-new product with no customer base yet, do not make it.
   - When uncertain whether something is verifiable, either find a real source via web search, soften to qualitative language, or remove the claim entirely.
   This rule overrides every other rule. A shorter, less engaging, or less persuasive post that is fully truthful is always preferred over a more polished post containing any fabricated or implied-but-false claim.`;
}

// ─── Build the user prompt for evergreen mode ────────────────────────────────
function buildUserPrompt(config, pick, year) {
  const today = new Date().toISOString().slice(0, 10);
  const isStateMode = !!pick.state;
  const isFormMode = !!pick.form;

  let topicLine, slugLine, geoNote;
  if (isStateMode) {
    topicLine = `${pick.angle} in ${pick.state}`;
    slugLine = pick.slug;
    geoNote = `Focus specifically on ${pick.state}. Use web_search to find the most current ${pick.state} statute numbers, dollar limits, and notice periods. Cite specific statute numbers (e.g., Cal. Civ. Code § 1950.5). Do NOT rely on training data for legal figures — they change.`;
  } else if (isFormMode) {
    topicLine = pick.angle;
    slugLine = pick.slug;
    geoNote = `Focus specifically on USCIS Form ${pick.form}. Use web_search to find the most current USCIS Policy Manual guidance, processing times, and edition date for this form. Cite the specific Policy Manual chapter/section. Do NOT rely on training data — USCIS forms and policy change frequently.`;
  } else {
    topicLine = pick.angle;
    slugLine = pick.slug;
    geoNote = `Use web_search to find the most current federal regulations, CMS guidance, or HHS rules relevant to this topic. Cite specific CFR sections (e.g., 45 CFR § 149.110). Do NOT rely on training data for regulatory figures — they change.`;
  }

  return `You are writing a blog post for ${config.siteName} (${config.domain}).

Product: ${config.siteName}, which serves ${config.audience}. Topic area: ${config.topicArea}.

Today is ${today} (year ${year}).

POST TOPIC
Topic: ${topicLine}
Target slug: ${slugLine}
Audience level: ${config.audienceLevel}

${geoNote}

OUTPUT STRUCTURE — CRITICAL

Produce the output inside six clearly-delimited blocks. Use these EXACT markers (including brackets):

[TITLE]
A specific, question-format or claim-format headline that includes the year ${year} for freshness signal. ${isStateMode ? 'Include the state name.' : ''} ${isFormMode ? `Include the form code (${pick.form.match(/\\b([A-Z]-\\d+|N-\\d+)\\b/) ? pick.form.match(/\\b([A-Z]-\\d+|N-\\d+)\\b/)[0] : pick.form}).` : ''} Max 70 chars.
[/TITLE]

[LEDE]
First paragraph: the byline as instructed (real HTML <em> tag).
Second paragraph: bold opening sentence stating the bottom-line answer.
Third paragraph: 2-3 sentences previewing what this post covers.
[/LEDE]

[TLDR]
60-90 word direct answer block. This is what AI Overviews extract. State the specific answer with numbers and statute citations. No filler.
[/TLDR]

[BODY]
Main article content in HTML fragments. Use ONLY these tags: <h2>, <h3>, <p>, <strong>, <em>, <ul>, <ol>, <li>, <blockquote>, <table>, <thead>, <tbody>, <tr>, <th>, <td>, <a>, <svg>, <rect>, <circle>, <line>, <text>, <path>, <g>.

Structure (per the format you were assigned in the system prompt): 4-6 H2 sections, each 2-4 paragraphs, with at least one inline visual (real <table> or <svg>) somewhere in the body. End the body with the verbatim About footer paragraph.

DO NOT include H1 (template adds it). DO NOT include FAQ here (separate block). DO NOT include conclusion or CTA (template adds them).
[/BODY]

[FAQ]
Exactly 4 Q&A pairs. Use this exact format:

Q: <question 1>?
A: <3-5 sentence answer with specifics>

Q: <question 2>?
A: <3-5 sentence answer>

Q: <question 3>?
A: <3-5 sentence answer>

Q: <question 4>?
A: <3-5 sentence answer>

Questions should be realistic things ${config.audience} would ask after reading this post.
[/FAQ]

[SEO_DESCRIPTION]
A meta description for search engines. MUST be 110-155 characters (inclusive). One sentence. Do not exceed 155 — if you do, shorten before submitting.
[/SEO_DESCRIPTION]

Begin now. Output only the six marked blocks. No preamble, no explanation, no closing notes.`;
}

// ─── Build prompt for topic recycling (refresh) mode ─────────────────────────
function buildRecyclePrompt(config, oldPost, freshAngle, year) {
  const today = new Date().toISOString().slice(0, 10);
  return `You are writing a refreshed/updated version of a blog post for ${config.siteName} (${config.domain}). Today is ${today}.

ORIGINAL POST INFO
Old title: ${oldPost.title}
Old slug: ${oldPost.slug}
Last updated: ${oldPost.mtime.toISOString().slice(0, 10)}

REFRESH GOAL
Write a NEW article on the same general topic but with a fresh angle and updated information for ${year}. Use web_search to find:
   - Any law/rule/policy changes since the original was published
   - Updated statistics and dollar amounts
   - New developments worth highlighting
The new article must be substantively different — not just a date swap. Add new information, a new angle, or a new structural format.

NEW ANGLE FOR THIS REFRESH
${freshAngle}

OUTPUT STRUCTURE
Same six-block format as a regular post (TITLE, LEDE, TLDR, BODY, FAQ, SEO_DESCRIPTION). The new TITLE should signal freshness with "${year}" or "Updated".

All editorial rules from the system prompt apply (HONESTY, no fake stats, banned phrases, real visuals, no AI self-reference).

Begin now. Output only the six marked blocks.`;
}

// ─── Call Claude ─────────────────────────────────────────────────────────────
function callClaude(systemPrompt, userPrompt, useSearch) {
  return new Promise((resolve, reject) => {
    const payload = {
      model: MODEL,
      max_tokens: 12000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    };
    if (useSearch) payload.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }];

    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: API_TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(`API error: ${parsed.error.message}`));
          const text = (parsed.content || [])
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n').trim();
          if (!text) return reject(new Error(`Empty response: ${data.slice(0, 300)}`));
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(body);
    req.end();
  });
}

// ─── Parse Claude output ─────────────────────────────────────────────────────
function parseOutput(raw) {
  const extract = (name) => {
    const re = new RegExp(`\\[${name}\\]([\\s\\S]*?)\\[\\/${name}\\]`, 'i');
    const m = raw.match(re);
    return m ? m[1].trim() : '';
  };

  const title = extract('TITLE').replace(/\s+/g, ' ').trim();
  const lede = extract('LEDE');
  const tldr = extract('TLDR');
  const body = extract('BODY');
  const faqBlock = extract('FAQ');
  let seoDesc = extract('SEO_DESCRIPTION').replace(/\s+/g, ' ').trim();

  // Truncate seoDesc to 155 chars
  if (seoDesc.length > 155) {
    const cutoff = seoDesc.slice(0, 154);
    const lastSpace = cutoff.lastIndexOf(' ');
    seoDesc = (lastSpace > 100 ? cutoff.slice(0, lastSpace) : cutoff).replace(/[,;:\s]+$/, '') + '…';
  }

  // Parse FAQ
  const faqs = [];
  if (faqBlock) {
    const pairs = faqBlock.split(/\n\s*\n/);
    for (const p of pairs) {
      const qm = p.match(/Q:\s*(.+?)(?=\nA:|$)/is);
      const am = p.match(/A:\s*([\s\S]+?)(?=\n\s*Q:|$)/i);
      if (qm && am) faqs.push({ q: qm[1].trim().replace(/\s+/g, ' '), a: am[1].trim().replace(/\s+/g, ' ') });
    }
  }

  // Sanitise body — strip dangerous tags, [IMAGE:] placeholders, code fences
  let cleanBody = body
    .replace(/^```(?:html)?\s*/i, '').replace(/\s*```\s*$/i, '')
    .replace(/\[IMAGE:[^\]]*\]/gi, '')
    .replace(/<\/?html[^>]*>/gi, '')
    .replace(/<\/?head[^>]*>/gi, '')
    .replace(/<\/?body[^>]*>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<(h1)[^>]*>[\s\S]*?<\/h1>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '')
    .trim();

  return { title, lede, tldr, body: cleanBody, faqs, seoDesc };
}

// ─── Validate output ─────────────────────────────────────────────────────────
function validateOutput(parsed, config, existingPosts) {
  const errors = [];
  if (!parsed.title || parsed.title.length < 10) errors.push('Title missing or too short');
  if (!parsed.lede || parsed.lede.length < 100) errors.push('Lede missing or too short');
  if (!parsed.tldr || parsed.tldr.length < 50) errors.push('TL;DR missing or too short');
  if (!parsed.body || parsed.body.length < 2000) errors.push(`Body too short (${parsed.body.length} chars)`);
  if (parsed.faqs.length < 3) errors.push(`Too few FAQs (${parsed.faqs.length})`);
  if (!parsed.seoDesc || parsed.seoDesc.length < 80) errors.push('SEO description missing or too short');

  // Banned phrase check
  const allText = (parsed.title + ' ' + parsed.lede + ' ' + parsed.tldr + ' ' + parsed.body).toLowerCase();
  for (const phrase of config.bannedPhrases) {
    if (allText.includes(phrase.toLowerCase())) {
      warn(`Output contains banned phrase: "${phrase}"`);
      // Warning only — don't fail. Edit out instead.
    }
  }

  // No-AI-self-reference check
  const aiSelfRefs = ['as an ai', 'this article was generated', 'as a language model', 'i cannot', 'my training data'];
  for (const phrase of aiSelfRefs) {
    if (allText.includes(phrase)) errors.push(`Contains AI self-reference: "${phrase}"`);
  }

  // Body hash uniqueness check
  const bodyHash = crypto.createHash('md5').update(parsed.body.slice(0, 2000)).digest('hex');
  const dup = existingPosts.find(p => p.bodyHash === bodyHash);
  if (dup) errors.push(`Body hash matches existing post: ${dup.slug}`);

  // Title similarity check (basic — same first 6 normalised words)
  const normTitle = parsed.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).slice(0, 6).join(' ');
  const dupTitle = existingPosts.find(p => {
    const norm = p.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).slice(0, 6).join(' ');
    return norm === normTitle && norm.length > 20;
  });
  if (dupTitle) errors.push(`Title too similar to existing post: ${dupTitle.slug} (${dupTitle.title})`);

  return errors;
}

// ─── Render HTML page ────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderHtml(parsed, slug, config, publishDate) {
  const siteUrl = `https://${config.domain}`;
  const pageUrl = `${siteUrl}/blog/${slug}`;
  const displayDate = new Date(publishDate + 'T12:00:00Z').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const wordCount = parsed.body.split(/\s+/).length;
  const readMin = Math.max(3, Math.ceil(wordCount / 220));

  // Render lede — preserve HTML if present, else wrap in <p>
  const ledeHtml = /<p[\s>]/i.test(parsed.lede)
    ? parsed.lede
    : parsed.lede.split(/\n\s*\n/).filter(Boolean).map(p => `<p>${p.trim()}</p>`).join('\n  ');

  // FAQ HTML
  const faqHtml = parsed.faqs.map(f =>
    `<details class="faq-item"><summary>${escHtml(f.q)}</summary><div class="faq-body"><p>${escHtml(f.a)}</p></div></details>`
  ).join('\n');

  // FAQ schema
  const faqSchema = parsed.faqs.length >= 3 ? {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: parsed.faqs.map(f => ({
      '@type': 'Question', name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  } : null;

  // Article schema
  const articleSchema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: parsed.title,
    description: parsed.seoDesc,
    datePublished: publishDate,
    dateModified: publishDate,
    author: { '@type': 'Organization', name: config.authorOrgName, url: siteUrl + '/' },
    publisher: { '@type': 'Organization', name: config.siteName, url: siteUrl + '/', logo: { '@type': 'ImageObject', url: siteUrl + '/logo.png' } },
    mainEntityOfPage: pageUrl,
    image: siteUrl + '/logo.png',
  };

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: siteUrl + '/' },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: siteUrl + '/blog/' },
      { '@type': 'ListItem', position: 3, name: parsed.title, item: pageUrl },
    ],
  };

  const speakableSchema = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    speakable: { '@type': 'SpeakableSpecification', cssSelector: ['h1', '.tldr', 'h2', '.faq-item summary'] },
  };

  const isDark = !!config.darkTheme;
  const css = [
    '@import url("https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=DM+Sans:wght@300;400;500;600;700&display=swap");',
    '*{box-sizing:border-box;margin:0;padding:0}',
    isDark
      ? `:root{--brand:${config.primaryColor};--gold:${config.accentColor};--ink:#f0ece0;--muted:#8a8278;--rule:rgba(255,255,255,.08);--bg:${config.bgColor};--white:#0f1422;--accent:rgba(212,175,110,.12);--body-text:#e8e4d8;--body-muted:#a8a298}`
      : `:root{--brand:${config.primaryColor};--gold:${config.accentColor};--ink:#1c1a14;--muted:#7a7560;--rule:#e8e4de;--bg:${config.bgColor};--white:#fff;--accent:#f5edd8;--body-text:#333;--body-muted:#666}`,
    'body{font-family:"DM Sans",-apple-system,BlinkMacSystemFont,sans-serif;color:var(--ink);background:var(--bg);line-height:1.75;font-size:17px;-webkit-font-smoothing:antialiased}',
    'a{color:var(--gold)}',
    '.hdr{background:var(--brand);padding:0 32px;height:60px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}',
    '.hdr-logo{font-family:"Playfair Display",serif;font-size:1.15rem;color:#fff;text-decoration:none;font-weight:600}',
    '.hdr-cta{background:var(--gold);color:var(--brand);padding:7px 16px;border-radius:4px;font-size:.8rem;font-weight:700;text-decoration:none}',
    '.hero{background:var(--brand);padding:56px 32px 48px}',
    '.hero-inner{max-width:760px;margin:0 auto}',
    '.hero-tag{display:inline-block;font-size:.72rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--gold);margin-bottom:16px}',
    '.hero h1{font-family:"Playfair Display",serif;font-size:clamp(1.8rem,4vw,2.6rem);font-weight:600;line-height:1.18;color:#fff;margin-bottom:18px;letter-spacing:-.015em}',
    '.hero-meta{display:flex;align-items:center;gap:14px;font-size:.82rem;color:rgba(255,255,255,.55);flex-wrap:wrap;margin-top:14px}',
    '.hero-meta-dot{width:3px;height:3px;background:var(--gold);border-radius:50%;opacity:.6}',
    '.breadcrumb{font-size:.75rem;color:rgba(255,255,255,.5);margin-bottom:14px}',
    '.breadcrumb a{color:rgba(255,255,255,.7);text-decoration:none}',
    '.layout{max-width:780px;margin:0 auto;padding:48px 32px}',
    '@media(max-width:600px){.hero{padding:40px 20px 44px}.layout{padding:28px 20px}}',
    '.tldr{background:#fff8e1;border-left:4px solid var(--gold);border-radius:0 6px 6px 0;padding:18px 22px;margin:0 0 32px;font-size:1rem;line-height:1.7}',
    '.tldr-label{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--gold);margin-bottom:6px;display:block}',
    '.lede{font-size:1.08rem;line-height:1.78;color:#333;margin-bottom:32px}',
    '.lede p{margin-bottom:14px}',
    '.lede em{color:var(--muted);font-style:italic}',
    '.body h2{font-family:"Playfair Display",serif;font-size:1.45rem;font-weight:600;color:var(--ink);margin:36px 0 14px;letter-spacing:-.01em;padding-left:16px;position:relative}',
    '.body h2::before{content:"";position:absolute;left:0;top:6px;bottom:6px;width:3px;background:var(--gold);border-radius:2px}',
    '.body h3{font-family:"Playfair Display",serif;font-size:1.15rem;font-weight:600;margin:24px 0 10px;color:var(--ink)}',
    '.body p{margin-bottom:14px;color:#333;line-height:1.78}',
    '.body ul,.body ol{padding-left:0;margin-bottom:16px;list-style:none}',
    '.body li{padding:8px 0 8px 24px;position:relative;color:#333;line-height:1.7;border-bottom:1px solid var(--rule)}',
    '.body li:last-child{border-bottom:none}',
    '.body li::before{content:"";position:absolute;left:0;top:16px;width:8px;height:8px;border-radius:50%;background:var(--gold);opacity:.7}',
    '.body table{border-collapse:collapse;width:100%;font-size:.92rem;margin:20px 0}',
    '.body th,.body td{border:1px solid var(--rule);padding:10px 12px;text-align:left;vertical-align:top}',
    '.body th{background:var(--accent);font-weight:700;color:var(--ink);font-size:.85rem}',
    '.body svg{display:block;max-width:100%;height:auto;margin:24px auto}',
    '.body blockquote{border-left:3px solid var(--gold);padding:8px 16px;color:var(--muted);font-style:italic;margin:16px 0}',
    '.cta-box{background:var(--brand);border-radius:8px;padding:32px 30px;text-align:center;margin:36px 0;color:#fff}',
    '.cta-box h3{font-family:"Playfair Display",serif;font-size:1.4rem;font-weight:600;color:#fff;margin-bottom:10px}',
    '.cta-box p{color:rgba(255,255,255,.68);margin-bottom:20px;font-size:.95rem}',
    '.cta-btn{display:inline-block;background:var(--gold);color:var(--brand);font-weight:700;padding:12px 26px;border-radius:6px;text-decoration:none;font-size:.92rem}',
    '.faqs{margin:44px 0 24px}',
    '.faqs>h2{font-family:"Playfair Display",serif;font-size:1.4rem;font-weight:600;color:var(--ink);margin-bottom:18px;padding-left:16px;position:relative}',
    '.faqs>h2::before{content:"";position:absolute;left:0;top:6px;bottom:6px;width:3px;background:var(--gold);border-radius:2px}',
    '.faq-item{border:1px solid var(--rule);border-radius:6px;margin-bottom:8px;background:var(--white)}',
    '.faq-item summary{padding:14px 18px;font-weight:600;font-size:.92rem;cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;color:var(--ink)}',
    '.faq-item summary::-webkit-details-marker{display:none}',
    '.faq-item summary::after{content:"+";font-size:1.2rem;color:var(--gold);font-weight:400}',
    '.faq-item[open] summary::after{content:"−"}',
    '.faq-body{padding:2px 18px 16px;color:#444;font-size:.92rem;line-height:1.72}',
    '.disclaimer{font-size:.8rem;color:var(--muted);font-style:italic;border-top:1px solid var(--rule);padding-top:18px;margin-top:40px;line-height:1.65}',
    '.ftr{background:var(--brand);padding:36px 32px;margin-top:64px;color:#fff}',
    '.ftr-inner{max-width:1100px;margin:0 auto;text-align:center}',
    '.ftr a{color:rgba(255,255,255,.7);text-decoration:none;margin:0 12px}',
    '.ftr-copy{padding-top:18px;font-size:.72rem;color:rgba(255,255,255,.35)}',
  ].join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large">
<title>${escHtml(parsed.title)} | ${escHtml(config.siteName)}</title>
<meta name="description" content="${escHtml(parsed.seoDesc)}">
<meta name="author" content="${escHtml(config.authorOrgName)}">
<link rel="canonical" href="${pageUrl}">
<meta property="og:type" content="article">
<meta property="og:title" content="${escHtml(parsed.title)}">
<meta property="og:description" content="${escHtml(parsed.seoDesc)}">
<meta property="og:url" content="${pageUrl}">
<meta property="og:site_name" content="${escHtml(config.siteName)}">
<meta property="og:image" content="${siteUrl}/logo.png">
<meta property="article:published_time" content="${publishDate}">
<meta property="article:modified_time" content="${publishDate}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escHtml(parsed.title)}">
<meta name="twitter:description" content="${escHtml(parsed.seoDesc)}">
<meta name="twitter:image" content="${siteUrl}/logo.png">
<script type="application/ld+json">${JSON.stringify(articleSchema)}</script>
<script type="application/ld+json">${JSON.stringify(breadcrumbSchema)}</script>
<script type="application/ld+json">${JSON.stringify(speakableSchema)}</script>
${faqSchema ? `<script type="application/ld+json">${JSON.stringify(faqSchema)}</script>` : ''}
<style>${css}</style>
</head>
<body>
<header class="hdr">
  <a href="${siteUrl}" class="hdr-logo">${escHtml(config.siteName)}</a>
  <a href="${siteUrl}/blog/" class="hdr-cta" style="background:transparent;color:#fff;font-weight:500">All Guides</a>
</header>
<div class="hero"><div class="hero-inner">
  <div class="breadcrumb"><a href="${siteUrl}/">Home</a> / <a href="${siteUrl}/blog/">Blog</a> / ${escHtml(parsed.title)}</div>
  <span class="hero-tag">${escHtml(config.siteName)} Guide</span>
  <h1>${escHtml(parsed.title)}</h1>
  <div class="hero-meta">
    <span>${displayDate}</span>
    <span class="hero-meta-dot"></span>
    <span>${escHtml(config.authorOrgName)}</span>
    <span class="hero-meta-dot"></span>
    <span>${readMin} min read</span>
  </div>
</div></div>
<main class="layout">
  <div class="lede">${ledeHtml}</div>
  <div class="tldr"><span class="tldr-label">Quick Answer</span>${escHtml(parsed.tldr)}</div>
  <div class="body">${parsed.body}</div>
  <div class="cta-box">
    <h3>${escHtml(config.ctaText)}</h3>
    <p>${escHtml(config.aboutFooter.replace(/^About [^:]+:\s*/, ''))}</p>
    <a href="${config.ctaUrl}" class="cta-btn">Get started →</a>
  </div>
  <section class="faqs">
    <h2>Frequently asked questions</h2>
    ${faqHtml}
  </section>
  <div class="disclaimer">This article provides general information about ${escHtml(config.topicArea)} and is not legal, medical, or financial advice. Laws and regulations change; verify current rules before acting. For complex situations, consult a licensed professional in your jurisdiction. Last reviewed: ${displayDate}.</div>
</main>
<footer class="ftr"><div class="ftr-inner">
  <div><strong>${escHtml(config.siteName)}</strong></div>
  <div style="margin:12px 0"><a href="${siteUrl}/">Home</a><a href="${siteUrl}/blog/">Blog</a><a href="${config.ctaUrl}">Get Started</a></div>
  <div class="ftr-copy">© ${new Date().getFullYear()} ${escHtml(config.siteName)} · Informational purposes only.</div>
</div></footer>
</body>
</html>
`;
}

// ─── Update sitemap.xml ──────────────────────────────────────────────────────
function updateSitemap(slug, config, publishDate) {
  if (!fs.existsSync(SITEMAP)) {
    log(`Sitemap not found at ${SITEMAP} — skipping update`);
    return;
  }
  let sm = fs.readFileSync(SITEMAP, 'utf8');
  const url = `https://${config.domain}/blog/${slug}`;
  // Remove existing entry (idempotent)
  const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  sm = sm.replace(new RegExp(`\\s*<url>\\s*<loc>${escapedUrl}</loc>[\\s\\S]*?</url>`, 'g'), '');
  // Add fresh entry before </urlset>
  if (!sm.includes('</urlset>')) {
    warn('sitemap.xml missing </urlset> — skipping update');
    return;
  }
  const entry =
    '  <url>\n' +
    `    <loc>${url}</loc>\n` +
    `    <lastmod>${publishDate}</lastmod>\n` +
    '    <changefreq>monthly</changefreq>\n' +
    '    <priority>0.7</priority>\n' +
    '  </url>\n\n';
  sm = sm.replace('</urlset>', entry + '</urlset>');
  fs.writeFileSync(SITEMAP, sm);
  log(`Sitemap updated with ${url}`);
}

// ─── Update blog/index.html (post-card grid) ─────────────────────────────────
function updateBlogIndex(slug, parsed, config) {
  const indexPath = path.join(BLOG_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) {
    log(`Blog index not found at ${indexPath} — skipping`);
    return;
  }
  let html = fs.readFileSync(indexPath, 'utf8');

  // Skip if already present
  if (html.includes(`/blog/${slug}"`)) {
    log(`Blog index already contains card for ${slug} — skipping`);
    return;
  }

  // Self-heal: remove any cards pointing to articles that no longer exist on disk
  const cardRegex = /\s*<a\s+href="\/blog\/([^"]+?)"\s+class="post-card"[^>]*>[\s\S]*?<\/a>/g;
  let removed = 0;
  html = html.replace(cardRegex, (match, cardSlug) => {
    const articleFile = path.join(BLOG_DIR, `${cardSlug}.html`);
    if (!fs.existsSync(articleFile)) {
      removed++;
      return '';
    }
    return match;
  });
  if (removed > 0) log(`Removed ${removed} stale post card(s) from blog index`);

  // Build new card matching the v1 inline format
  const monthYear = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const escTitle = escHtml(parsed.title);
  const escDesc = escHtml(parsed.seoDesc);
  const newCard =
    `    <a href="/blog/${slug}" class="post-card">` +
    `<div class="post-card-body"><h3>${escTitle}</h3>` +
    `<p>${escDesc}</p>` +
    `<div class="post-card-footer"><span>${monthYear}</span><span class="post-card-read">Read &rarr;</span></div></div></a>\n`;

  // Insert before the autoblog comment marker if present, else before closing </div></main>
  if (html.includes('Article cards added here by autoblog')) {
    html = html.replace(/(\s*<!--\s*Article cards added here by autoblog[^>]*-->)/,
      '\n' + newCard + '$1');
    log(`Added post card before autoblog marker`);
  } else if (html.includes('class="post-grid"')) {
    // Insert right after the post-grid opening tag
    html = html.replace(/(class="post-grid"[^>]*>)/, '$1\n' + newCard);
    log(`Added post card after post-grid opening`);
  } else {
    // Last-resort fallback — before closing </main>
    html = html.replace(/(\n\s*<\/main>)/, '\n' + newCard + '$1');
    log(`Added post card via fallback insertion`);
  }

  fs.writeFileSync(indexPath, html);
  log(`Blog index updated`);
}

// ─── Git push ────────────────────────────────────────────────────────────────
function gitCommitAndPush(slug) {
  try {
    execSync('git config user.name "blog-bot"');
    execSync('git config user.email "blog-bot@users.noreply.github.com"');
    execSync(`git add blog/${slug}.html blog/index.html sitemap.xml ${path.basename(STATE_FILE)} 2>/dev/null || true`);
    const status = execSync('git status --porcelain').toString().trim();
    if (!status) { log('No changes to commit'); return false; }
    execSync(`git commit -m "blog: ${slug}"`);
    execSync('git push origin main');
    log('Pushed to GitHub');
    return true;
  } catch (e) {
    warn(`Git push failed: ${e.message}`);
    return false;
  }
}

// ─── Trigger Netlify deploy ──────────────────────────────────────────────────
function triggerNetlify() {
  if (!process.env.NETLIFY_HOOK) return;
  try {
    https.request(new URL(process.env.NETLIFY_HOOK), { method: 'POST' }, () => {}).end();
    log('Netlify deploy triggered');
  } catch (e) { warn(`Netlify hook failed: ${e.message}`); }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.ANTHROPIC_API_KEY) die('ANTHROPIC_API_KEY not set', 2);

  const config = loadConfig();
  const state = loadState();
  log(`Site: ${config.siteName} (${config.domain})`);

  if (!fs.existsSync(BLOG_DIR)) fs.mkdirSync(BLOG_DIR, { recursive: true });

  const existingPosts = listExistingPosts();
  log(`Found ${existingPosts.length} existing posts`);

  // Pick topic — strategy depends on site config
  let pick, isRecycle = false;
  if (config.stateAware) {
    pick = pickStateAndTopic(config, existingPosts);
  } else if (config.formRotation && config.formRotation.length > 0) {
    pick = pickFormAndTopic(config, existingPosts);
  } else {
    pick = pickTopicOnly(config, existingPosts);
  }

  // If no fresh topic available, recycle
  if (!pick) {
    log('No uncovered topics in matrix — entering recycle mode');
    const oldPost = pickRecycleTarget(existingPosts);
    if (!oldPost) die('No posts exist and no fresh topics — nothing to do', 0);

    // Pick a fresh angle for the refresh
    const freshAngle = config.topicAngles[Math.floor(Math.random() * config.topicAngles.length)];
    pick = {
      angle: freshAngle,
      slug: `${oldPost.slug}-${new Date().getFullYear()}-update`,
      isRecycle: true,
      oldPost,
    };
    isRecycle = true;
  }

  log(`Pick: ${JSON.stringify({ slug: pick.slug, state: pick.state, form: pick.form, isRecycle })}`);

  // Format rotation
  const format = pickFormat(state);
  log(`Format: ${format.name} (${format.id})`);

  const year = new Date().getFullYear();
  const today = new Date().toISOString().slice(0, 10);

  // Build prompts
  const systemPrompt = buildStyleSystemPrompt(config, format);
  const userPrompt = isRecycle
    ? buildRecyclePrompt(config, pick.oldPost, pick.angle, year)
    : buildUserPrompt(config, pick, year);

  // Call Claude
  log('Calling Claude...');
  const startTime = Date.now();
  let raw;
  try {
    raw = await callClaude(systemPrompt, userPrompt, true);
  } catch (e) {
    die(`Claude call failed: ${e.message}`, 1);
  }
  log(`Got response (${raw.length} chars in ${Math.round((Date.now() - startTime) / 1000)}s)`);

  // Parse + validate
  const parsed = parseOutput(raw);
  const errors = validateOutput(parsed, config, existingPosts);
  if (errors.length > 0) {
    warn('Validation errors:');
    errors.forEach(e => warn(`  - ${e}`));
    // Save raw response for debugging
    fs.writeFileSync(path.join(REPO_ROOT, '.blog-debug-failed.txt'),
      `Pick: ${JSON.stringify(pick, null, 2)}\n\nErrors:\n${errors.join('\n')}\n\nRaw response:\n${raw}`);
    die(`Validation failed: ${errors.length} errors. See .blog-debug-failed.txt`, 1);
  }

  // Final slug
  let finalSlug = pick.slug;
  if (fs.existsSync(path.join(BLOG_DIR, `${finalSlug}.html`))) {
    if (isRecycle) {
      // Recycle slug already includes year suffix; if STILL exists, abort
      die(`Recycle slug ${finalSlug} already exists — refusing to overwrite`, 1);
    }
    // Should not happen with new picker logic, but guard anyway
    die(`Slug ${finalSlug} already exists — refusing to overwrite (autoblog dedup failed)`, 1);
  }

  // Render and write
  const html = renderHtml(parsed, finalSlug, config, today);
  const filePath = path.join(BLOG_DIR, `${finalSlug}.html`);
  fs.writeFileSync(filePath, html);
  log(`Wrote ${filePath} (${html.length.toLocaleString()} bytes)`);

  // Update sitemap and blog index
  updateSitemap(finalSlug, config, today);
  updateBlogIndex(finalSlug, parsed, config);

  // Persist format choice
  state.lastFormat = format.id;
  state.runs = (state.runs || 0) + 1;
  saveState(state);

  // Commit, push, trigger Netlify
  const pushed = gitCommitAndPush(finalSlug);
  if (pushed) triggerNetlify();

  log(`✓ Done in ${Math.round((Date.now() - startTime) / 1000)}s: https://${config.domain}/blog/${finalSlug}`);
}

main().catch(e => {
  console.error('[gen FATAL]', e.stack || e.message || e);
  process.exit(1);
});
