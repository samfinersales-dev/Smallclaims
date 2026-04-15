// generate-blog-post.js — lean version, ~$0.15-0.20 per run
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SITE_CONFIG = {
  domain:         process.env.SITE_DOMAIN,
  siteName:       process.env.SITE_NAME,
  blogPath:       process.env.BLOG_PATH || 'blog',
  topicArea:      process.env.TOPIC_AREA,
  targetAudience: process.env.TARGET_AUDIENCE,
  productDesc:    process.env.PRODUCT_DESC,
  ctaText:        process.env.CTA_TEXT,
  ctaUrl:         process.env.CTA_URL || ('https://' + process.env.SITE_DOMAIN),
  primaryColor:   process.env.PRIMARY_COLOR || '#1a3a5c',
  accentColor:    process.env.ACCENT_COLOR || '#c9a84c',
  netlifyHook:    process.env.NETLIFY_HOOK,
};

const API_KEY = process.env.ANTHROPIC_API_KEY;

// ── API CALL ─────────────────────────────────────────────────────────────────
function callClaude(prompt, model, useSearch) {
  return new Promise(function(resolve, reject) {
    var payload = {
      model: model,
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }]
    };
    if (useSearch) payload.tools = [{ type: 'web_search_20250305', name: 'web_search' }];

    var body = JSON.stringify(payload);
    var req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
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
          if (!text) reject(new Error('Empty response: ' + data.slice(0,200)));
          else resolve(text);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── STEP 1: PICK TOPIC (cheap model, no search) ───────────────────────────────
async function pickTopic() {
  console.log('Picking topic...');
  var weekNum = Math.floor(Date.now() / (7*24*60*60*1000));
  var states = ['California','Texas','Florida','New York','Illinois','Pennsylvania',
    'Ohio','Georgia','North Carolina','Michigan','New Jersey','Virginia','Washington',
    'Arizona','Tennessee','Indiana','Missouri','Maryland','Wisconsin','Colorado',
    'Minnesota','South Carolina','Alabama','Louisiana','Kentucky','Oregon','Oklahoma',
    'Connecticut','Iowa','Utah','Nevada','Arkansas','Mississippi','Kansas','New Mexico',
    'Nebraska','West Virginia','Idaho','Hawaii','New Hampshire','Maine','Montana',
    'Rhode Island','Delaware','South Dakota','North Dakota','Alaska','Vermont','Wyoming'];
  var stateTopicArea = SITE_CONFIG.topicArea.toLowerCase();
  var supportsStateSpecific = stateTopicArea.includes('lease') || stateTopicArea.includes('small claims') || stateTopicArea.includes('landlord') || stateTopicArea.includes('tenant');
  var doState = supportsStateSpecific && (weekNum % 2 === 0);
  var state = states[weekNum % states.length];
  var year = new Date().getFullYear();
  // Check what states have been recently written about
var recentFiles = [];
try { recentFiles = require('fs').readdirSync(SITE_CONFIG.blogPath || 'blog').filter(function(f){return f.endsWith('.html');}); } catch(e) {}
var stateAlreadyCovered = recentFiles.some(function(f){ return f.toLowerCase().includes(state.toLowerCase().replace(' ','-')); });
if (stateAlreadyCovered) {
  // Pick a different state
  state = states[(weekNum + 7) % states.length];
  console.log('State already covered, switching to: ' + state);
}
var stateNote = doState 
    ? ('Focus on ' + state + '-specific rules and figures. Search for the most current ' + state + ' regulations.')
    : 'Search for recent news, regulatory changes, or trending topics in this space from the last 30 days. Prioritise timely topics over evergreen ones when breaking news exists.';

  var prompt = 'You are an SEO writer for ' + SITE_CONFIG.siteName + ' (' + SITE_CONFIG.domain + ').\n' +
    'Product: ' + SITE_CONFIG.productDesc + '\n' +
    'Audience: ' + SITE_CONFIG.targetAudience + '\n' +
    'Topic area: ' + SITE_CONFIG.topicArea + '\n' +
    stateNote + '\n\n' +
    'Choose ONE specific topic. Current year: ' + year + '. No year in TITLE.\nRespond with ONLY these 9 lines, nothing else:\n' +
    'TITLE: [title here]\n' +
    'SLUG: [slug-here]\n' +
    'META: [155 char description]\n' +
    'KEYWORD: [primary keyword]\n' +
    'H2A: [section 1 heading]\n' +
    'H2B: [section 2 heading]\n' +
    'H2C: [section 3 heading]\n' +
    'H2D: [section 4 heading]\n' +
    'H2E: [section 5 heading]\n\n' +
    'IMPORTANT: The current year is ' + new Date().getFullYear() + '. Never reference past years as current. Search for recent developments first. If there is breaking news, a regulatory change, or a trending topic in this space from the last 30 days, prioritise that over evergreen topics.\n\n' +
    'No preamble. No explanation. Just those 9 lines.';

  var response = await callClaude(prompt, 'claude-sonnet-4-6', true);
  console.log('Raw topic response:\n' + response.slice(0,200));

  var get = function(key) {
    var m = response.match(new RegExp('^' + key + ':\\s*(.+)$', 'm'));
    return m ? m[1].trim() : '';
  };

  var topic = {
    title:    get('TITLE'),
    slug:     get('SLUG').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g,'-'),
    meta:     get('META'),
    keyword:  get('KEYWORD'),
    sections: [get('H2A'), get('H2B'), get('H2C'), get('H2D'), get('H2E')].filter(Boolean)
  };

  if (!topic.title || topic.sections.length < 3) {
    throw new Error('Could not parse topic. Response was:\n' + response);
  }
  console.log('Topic: ' + topic.title);
  
  // Check if this slug was already published recently
  var blogDir = SITE_CONFIG.blogPath;
  var slugFile = blogDir + '/' + topic.slug + '.html';
  if (require('fs').existsSync(slugFile)) {
    console.log('Slug already exists: ' + topic.slug + ' — picking a different angle');
    // Modify the slug slightly to force a different article
    topic.slug = topic.slug + '-guide';
    topic.title = topic.title + ': Complete Guide';
  }
  
  return topic;
}

// ── STEP 2: WRITE ARTICLE (sonnet with search) ────────────────────────────────
async function writeArticle(topic) {
  console.log('Writing article...');
  var today = new Date().toISOString().split('T')[0];

  var sectionBlocks = topic.sections.map(function(h) {
    return 'SECTION\nHEADING: ' + h + '\nWrite 100-150 words plain text. Separate paragraphs with blank lines. Start list items with "- ". No HTML.\nENDSECTION';
  }).join('\n\n');

  var prompt = 'Write a blog article for ' + SITE_CONFIG.siteName + '.\n\n' +
    'Title: ' + topic.title + '\n' +
    'Audience: ' + SITE_CONFIG.targetAudience + '\n' +
    'CTA: ' + SITE_CONFIG.ctaText + ' at ' + SITE_CONFIG.ctaUrl + '\n\n' +
    'CRITICAL: Use EXACTLY the format below. Replace placeholder text. No HTML tags. Plain text only.\n\n' +
    'INTRO\n[Write 2-3 sentence intro]\nENDINTRO\n\n' +
    sectionBlocks + '\n\n' +
    'CONCLUSION\n[Write 2 sentence conclusion with CTA]\nENDCONCLUSION\n\n' +
    'FAQ\nQ: [question 1]\nA: [answer 1]\n\nQ: [question 2]\nA: [answer 2]\n\nQ: [question 3]\nA: [answer 3]\nENDFAQ';

  var response = await callClaude(prompt, 'claude-sonnet-4-6', false);

  var article = { title: topic.title, slug: topic.slug, meta: topic.meta, keyword: topic.keyword, date: today };

  var introM = response.match(/INTRO\n([\s\S]*?)\nENDINTRO/);
  article.intro = introM ? introM[1].trim() : '';

  article.sections = [];
  var sReg = /SECTION\nHEADING: ([^\n]+)\n([\s\S]*?)\nENDSECTION/g;
  var m;
  while ((m = sReg.exec(response)) !== null) {
    article.sections.push({ h: m[1].trim(), body: m[2].trim() });
  }

  var concM = response.match(/CONCLUSION\n([\s\S]*?)\nENDCONCLUSION/);
  article.conclusion = concM ? concM[1].trim() : '';

  article.faqs = [];
  var faqM = response.match(/FAQ\n([\s\S]*?)\nENDFAQ/);
  if (faqM) {
    var pairs = faqM[1].split(/\n\n+/);
    pairs.forEach(function(p) {
      var q = p.match(/Q: ([^\n]+)/);
      var a = p.match(/A: ([\s\S]+)/);
      if (q && a) article.faqs.push({ q: q[1].trim(), a: a[1].trim() });
    });
  }

  if (!article.sections.length) {
    throw new Error('No sections parsed. Response:\n' + response.slice(0,400));
  }
  console.log('Written: ' + article.sections.length + ' sections');
  return article;
}

// ── STEP 3: BUILD HTML ────────────────────────────────────────────────────────
function buildHTML(a) {
  var c = SITE_CONFIG.primaryColor;
  var gold = SITE_CONFIG.accentColor;
  var siteUrl = 'https://' + SITE_CONFIG.domain;
  var pageUrl = siteUrl + '/blog/' + a.slug;
  var pubDate = new Date(a.date).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});

  var sectionsHTML = a.sections.map(function(s) {
    var paras = s.body.split(/\n\n+/).map(function(para) {
      para = para.trim();
      if (!para) return '';
      var lines = para.split('\n');
      if (lines.some(function(l){return l.trim().startsWith('-');})) {
        var intro = lines.filter(function(l){ return l.trim() && !l.trim().startsWith('-'); });
        var items = lines.filter(function(l){ return l.trim().startsWith('-'); });
        var introHtml = intro.length ? '<p>' + intro.join(' ') + '</p>' : '';
        return introHtml + '<ul>' + items.map(function(l){
          return '<li>' + l.replace(/^-\s*/,'') + '</li>';
        }).join('') + '</ul>';
      }
      return '<p>' + para + '</p>';
    }).filter(Boolean).join('\n');
    return '<section class="s"><h2>' + s.h + '</h2>' + paras + '</section>';
  }).join('\n');

  var faqHTML = a.faqs.length ? '<section class="faqs"><h2>Frequently asked questions</h2>' +
    a.faqs.map(function(f,i){
      return '<details class="faq-item"><summary>' + f.q + '</summary><div class="faq-body"><p>' + f.a + '</p></div></details>';
    }).join('\n') + '</section>' : '';

  var articleSchema = JSON.stringify({
    "@context":"https://schema.org","@type":"Article",
    "headline":a.title,"description":a.meta,"datePublished":a.date,
    "author":{"@type":"Organization","name":SITE_CONFIG.siteName},
    "publisher":{"@type":"Organization","name":SITE_CONFIG.siteName,"url":siteUrl},
    "mainEntityOfPage":pageUrl
  });

  var bcSchema = JSON.stringify({
    "@context":"https://schema.org","@type":"BreadcrumbList",
    "itemListElement":[
      {"@type":"ListItem","position":1,"name":"Home","item":siteUrl+"/"},
      {"@type":"ListItem","position":2,"name":"Blog","item":siteUrl+"/blog/"},
      {"@type":"ListItem","position":3,"name":a.title,"item":pageUrl}
    ]
  });

  var faqSchema = a.faqs.length ? '<script type="application/ld+json">' + JSON.stringify({
    "@context":"https://schema.org","@type":"FAQPage",
    "mainEntity":a.faqs.map(function(f){
      return {"@type":"Question","name":f.q,"acceptedAnswer":{"@type":"Answer","text":f.a}};
    })
  }) + '</script>' : '';

  var css = [
    '@import url("https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;1,400&family=Source+Sans+3:wght@300;400;500;600&display=swap");',
    '*{box-sizing:border-box;margin:0;padding:0}',
    ':root{--brand:' + c + ';--gold:' + gold + ';--ink:#1a1a2e;--muted:#666;--rule:#e8e4de;--bg:#faf9f7;--white:#fff;--accent:#f0ece4}',
    'body{font-family:"Source Sans 3",sans-serif;font-weight:400;color:var(--ink);background:var(--bg);line-height:1.75;font-size:17px}',

    /* Header */
    '.hdr{background:var(--brand);padding:0 32px;height:64px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}',
    '.hdr-logo{font-family:"Playfair Display",serif;font-size:1.2rem;color:#fff;text-decoration:none;font-weight:600;letter-spacing:-.01em;display:flex;align-items:center;gap:10px}',
    '.hdr-logo-dot{width:8px;height:8px;background:var(--gold);border-radius:50%;display:inline-block}',
    '.hdr-nav{display:flex;align-items:center;gap:24px}',
    '.hdr-nav a{font-size:.875rem;color:rgba(255,255,255,.75);text-decoration:none;font-weight:500;letter-spacing:.01em;transition:color .2s}',
    '.hdr-nav a:hover{color:#fff}',
    '.hdr-cta{background:var(--gold)!important;color:var(--brand)!important;padding:8px 18px;border-radius:6px;font-size:.825rem!important;font-weight:700!important;letter-spacing:.02em;opacity:1!important;transition:opacity .2s!important}',
    '.hdr-cta:hover{opacity:.88!important}',

    /* Hero */
    '.hero{background:var(--brand);padding:72px 32px 60px;position:relative;overflow:hidden}',
    '.hero::after{content:"";position:absolute;bottom:-1px;left:0;right:0;height:40px;background:var(--bg);clip-path:ellipse(55% 100% at 50% 100%)}',
    '.hero-inner{max-width:760px;margin:0 auto;position:relative;z-index:1}',
    '.hero-tag{display:inline-flex;align-items:center;gap:8px;font-size:.75rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--gold);margin-bottom:20px}',
    '.hero-tag::before{content:"";display:inline-block;width:20px;height:2px;background:var(--gold)}',
    '.hero h1{font-family:"Playfair Display",serif;font-size:clamp(1.8rem,4vw,2.75rem);font-weight:600;line-height:1.2;color:#fff;margin-bottom:20px;letter-spacing:-.02em}',
    '.hero-meta{display:flex;align-items:center;gap:16px;font-size:.85rem;color:rgba(255,255,255,.55);flex-wrap:wrap}',
    '.hero-meta-dot{width:3px;height:3px;background:var(--gold);border-radius:50%;opacity:.6}',
    '.hero-intro{font-size:1.1rem;line-height:1.8;color:rgba(255,255,255,.8);margin-top:28px;padding-top:24px;border-top:1px solid rgba(255,255,255,.12)}',

    /* Layout */
    '.layout{max-width:1100px;margin:0 auto;padding:56px 32px;display:grid;grid-template-columns:1fr 280px;gap:64px;align-items:start}',
    '@media(max-width:900px){.layout{grid-template-columns:1fr}.sidebar{display:none}}',
    '@media(max-width:600px){.hero{padding:48px 20px 52px}.layout{padding:32px 20px}}',

    /* Article body */
    '.article-body .s{margin-bottom:44px}',
    '.article-body .s h2{font-family:"Playfair Display",serif;font-size:1.45rem;font-weight:600;color:var(--ink);margin-bottom:16px;letter-spacing:-.01em;position:relative;padding-left:16px}',
    '.article-body .s h2::before{content:"";position:absolute;left:0;top:4px;bottom:4px;width:3px;background:var(--gold);border-radius:2px}',
    '.article-body .s p{margin-bottom:16px;color:#333;line-height:1.8}',
    '.article-body .s ul{padding-left:0;margin-bottom:16px;list-style:none;margin-left:0}',
    '.article-body .s li{padding:10px 0 10px 28px;position:relative;color:#333;border-bottom:1px solid var(--rule);line-height:1.7;list-style:none}',
    '.article-body .s li:last-child{border-bottom:none}',
    '.article-body .s li::before{content:"";position:absolute;left:0;top:19px;width:10px;height:10px;border-radius:50%;background:var(--gold);opacity:.7}',

    /* Conclusion */
    '.conclusion{background:var(--white);border:1px solid var(--rule);border-left:4px solid var(--gold);border-radius:0 8px 8px 0;padding:24px 28px;margin:40px 0;font-size:1rem;line-height:1.8;color:#333}',

    /* CTA */
    '.cta-box{background:var(--brand);border-radius:12px;padding:40px 36px;text-align:center;margin:40px 0;position:relative;overflow:hidden}',
    '.cta-box::before{content:"";position:absolute;top:-60px;right:-60px;width:200px;height:200px;border-radius:50%;border:1px solid rgba(255,255,255,.06)}',
    '.cta-box::after{content:"";position:absolute;bottom:-40px;left:-40px;width:140px;height:140px;border-radius:50%;border:1px solid rgba(255,255,255,.04)}',
    '.cta-box h3{font-family:"Playfair Display",serif;font-size:1.5rem;font-weight:600;color:#fff;margin-bottom:10px;position:relative}',
    '.cta-box p{color:rgba(255,255,255,.65);margin-bottom:24px;font-size:.95rem;position:relative}',
    '.cta-btn{display:inline-block;background:var(--gold);color:var(--brand);font-weight:700;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:.95rem;letter-spacing:.01em;position:relative;transition:transform .15s,box-shadow .15s}',
    '.cta-btn:hover{transform:translateY(-2px);box-shadow:0 8px 28px rgba(0,0,0,.2)}',

    /* FAQ */
    '.faqs{margin:48px 0}',
    '.faqs>h2{font-family:"Playfair Display",serif;font-size:1.45rem;font-weight:600;color:var(--ink);margin-bottom:20px;padding-left:16px;position:relative}',
    '.faqs>h2::before{content:"";position:absolute;left:0;top:4px;bottom:4px;width:3px;background:var(--gold);border-radius:2px}',
    '.faq-item{border:1px solid var(--rule);border-radius:8px;margin-bottom:8px;overflow:hidden;background:var(--white)}',
    '.faq-item summary{padding:16px 20px;font-weight:600;font-size:.925rem;cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;color:var(--ink);user-select:none}',
    '.faq-item summary::-webkit-details-marker{display:none}',
    '.faq-item summary::after{content:"+";font-size:1.2rem;color:var(--gold);font-weight:400;min-width:16px;text-align:center;transition:transform .2s}',
    '.faq-item[open] summary::after{transform:rotate(45deg)}',
    '.faq-item[open]{border-color:var(--gold)}',
    '.faq-item[open] summary{color:var(--brand)}',
    '.faq-body{padding:4px 20px 18px;color:#444;font-size:.925rem;line-height:1.75}',

    /* Sidebar */
    '.sidebar{position:sticky;top:88px}',
    '.sidebar-cta{background:var(--brand);border-radius:10px;padding:24px;text-align:center;margin-bottom:20px}',
    '.sidebar-cta p{color:rgba(255,255,255,.7);font-size:.875rem;margin-bottom:16px;line-height:1.6}',
    '.sidebar-cta a{display:block;background:var(--gold);color:var(--brand);font-weight:700;padding:11px;border-radius:6px;text-decoration:none;font-size:.875rem;transition:opacity .2s}',
    '.sidebar-cta a:hover{opacity:.88}',
    '.sidebar-card{background:var(--white);border:1px solid var(--rule);border-radius:10px;padding:22px;margin-bottom:20px}',
    '.sidebar-card-title{font-family:"Playfair Display",serif;font-size:.95rem;font-weight:600;margin-bottom:14px;color:var(--ink)}',
    '.toc-item{font-size:.8rem;color:#555;padding:7px 0;border-bottom:1px solid #f0ece4;line-height:1.4;display:flex;gap:8px;align-items:baseline}',
    '.toc-item:last-child{border-bottom:none}',
    '.toc-num{color:var(--gold);font-weight:700;font-size:.75rem;min-width:16px}',

    /* Footer */
    '.ftr{background:var(--brand);padding:40px 32px;margin-top:80px}',
    '.ftr-inner{max-width:1100px;margin:0 auto;display:grid;grid-template-columns:1fr 1fr;gap:32px;align-items:center}',
    '@media(max-width:600px){.ftr-inner{grid-template-columns:1fr;text-align:center}}',
    '.ftr-brand{font-family:"Playfair Display",serif;color:#fff;font-size:1.2rem;margin-bottom:6px}',
    '.ftr-tagline{font-size:.8rem;color:rgba(255,255,255,.45)}',
    '.ftr-links{display:flex;gap:20px;justify-content:flex-end;flex-wrap:wrap}',
    '@media(max-width:600px){.ftr-links{justify-content:center}}',
    '.ftr-links a{color:rgba(255,255,255,.45);text-decoration:none;font-size:.8rem;transition:color .2s}',
    '.ftr-links a:hover{color:var(--gold)}',
    '.ftr-copy{grid-column:1/-1;padding-top:24px;border-top:1px solid rgba(255,255,255,.08);font-size:.75rem;color:rgba(255,255,255,.3);text-align:center}',
  ].join('\n');

  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + a.title + ' | ' + SITE_CONFIG.siteName + '</title>' +
    '<meta name="description" content="' + a.meta + '">' +
    '<link rel="canonical" href="' + pageUrl + '">' +
    '<meta property="og:title" content="' + a.title + '">' +
    '<meta property="og:description" content="' + a.meta + '">' +
    '<meta property="og:url" content="' + pageUrl + '">' +
    '<meta property="og:type" content="article">' +
    '<meta name="robots" content="index,follow">' +
    '<script type="application/ld+json">' + articleSchema + '</script>' +
    '<script type="application/ld+json">' + bcSchema + '</script>' +
    faqSchema +
    '<style>' + css + '</style>' +
    '</head><body>' +

    /* Header */
    '<header class="hdr">' +
    '<a href="' + siteUrl + '" class="hdr-logo">' + SITE_CONFIG.siteName + '</a>' +
    '<nav class="hdr-nav">' +
    '<a href="' + siteUrl + '/blog/">Blog</a>' +
    '<a href="' + siteUrl + '" class="hdr-cta">Get started</a>' +
    '</nav></header>' +

    /* Hero */
    '<div class="hero">' +
    '<div class="hero-inner">' +
    '<span class="hero-tag">' + SITE_CONFIG.siteName + ' Guide</span>' +
    '<h1>' + a.title + '</h1>' +
    '<div class="hero-meta">' +
    '<span>' + pubDate + '</span>' +
    '<span class="hero-meta-dot"></span>' +
    '<span>' + SITE_CONFIG.siteName + '</span>' +
    '<span class="hero-meta-dot"></span>' +
    '<span>' + Math.ceil(a.sections.reduce(function(n,s){return n+s.body.split(' ').length;},0) / 200) + ' min read</span>' +
    '</div>' +
    '<p class="hero-intro">' + a.intro + '</p>' +
    '</div></div>' +

    /* Body */
    '<div class="layout">' +
    '<main class="article-body">' +
    sectionsHTML +
    '<div class="conclusion">' + a.conclusion + '</div>' +
    '<div class="cta-box">' +
    '<h3>' + SITE_CONFIG.ctaText + '</h3>' +
    '<p>Used by ' + SITE_CONFIG.targetAudience + '.</p>' +
    '<a href="' + SITE_CONFIG.ctaUrl + '" class="cta-btn">Get started &rarr;</a>' +
    '</div>' +
    faqHTML +
    '</main>' +

    /* Sidebar */
    '<aside class="sidebar">' +
    '<div class="sidebar-cta">' +
    '<p>' + SITE_CONFIG.productDesc + '</p>' +
    '<a href="' + SITE_CONFIG.ctaUrl + '">' + SITE_CONFIG.ctaText + ' &rarr;</a>' +
    '</div>' +
    '<div class="sidebar-card">' +
    '<div class="sidebar-card-title">In this guide</div>' +
    a.sections.map(function(s,i){
      return '<div class="toc-item"><span class="toc-num">' + (i+1) + '</span><span>' + s.h + '</span></div>';
    }).join('') +
    '</div>' +
    '</aside>' +
    '</div>' +

    /* Footer */
    '<footer class="ftr">' +
    '<div class="ftr-inner">' +
    '<div><div class="ftr-brand">' + SITE_CONFIG.siteName + '</div>' +
    '<div class="ftr-tagline">' + SITE_CONFIG.productDesc + '</div></div>' +
    '<div class="ftr-links">' +
    '<a href="' + siteUrl + '">Home</a>' +
    '<a href="' + siteUrl + '/blog/">Blog</a>' +
    '<a href="' + siteUrl + '">Get started</a>' +
    '</div>' +
    '<div class="ftr-copy">&copy; ' + new Date().getFullYear() + ' ' + SITE_CONFIG.siteName + ' &middot; Not legal advice. For informational purposes only.</div>' +
    '</div></footer>' +
    '</body></html>';
}

// ── STEP 4: SAVE & COMMIT ────────────────────────────────────────────────────
function saveAndCommit(article, html) {
  var blogDir = SITE_CONFIG.blogPath;
  fs.mkdirSync(blogDir, { recursive: true });

  // Save article
  var filePath = path.join(blogDir, article.slug + '.html');
  fs.writeFileSync(filePath, html);
  console.log('Saved: ' + filePath);

  // Update blog index — add new card AND remove cards for deleted articles
  var indexPath = path.join(blogDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    var index = fs.readFileSync(indexPath, 'utf8');

    // Remove cards for articles that no longer exist on disk
    var cardRegex = /<a[^>]+href="\/blog\/([^"]+)"[^>]*class="post-card"[^>]*>[\s\S]*?<\/a>/g;
    var altCardRegex = /<a[^>]+class="post-card"[^>]+href="\/blog\/([^"]+)"[^>]*>[\s\S]*?<\/a>/g;
    var removedCount = 0;
    index = index.replace(cardRegex, function(match, slug) {
      var articleFile = path.join(blogDir, slug + '.html');
      if (!fs.existsSync(articleFile)) {
        console.log('Removing stale card for: ' + slug);
        removedCount++;
        return '';
      }
      return match;
    });
    index = index.replace(altCardRegex, function(match, slug) {
      var articleFile = path.join(blogDir, slug + '.html');
      if (!fs.existsSync(articleFile)) {
        console.log('Removing stale card (alt): ' + slug);
        removedCount++;
        return '';
      }
      return match;
    });
    if (removedCount > 0) console.log('Removed ' + removedCount + ' stale cards');

    // Add new card at top of grid
    var card = '\n    <a href="/blog/' + article.slug + '" class="post-card">' +
      '<div class="post-card-body"><h3>' + article.title + '</h3>' +
      '<p>' + article.meta + '</p>' +
      '<div class="post-card-footer"><span>' + new Date(article.date).toLocaleDateString('en-US',{month:'long',year:'numeric'}) + '</span>' +
      '<span class="post-card-read">Read &rarr;</span></div></div></a>';
    if (index.includes('class="post-grid"')) {
      index = index.replace('class="post-grid">', 'class="post-grid">' + card);
      fs.writeFileSync(indexPath, index);
      console.log('Blog index updated');
    }
  }

  // Update sitemap
  if (fs.existsSync('sitemap.xml')) {
    var sitemap = fs.readFileSync('sitemap.xml', 'utf8');
    var entry = '  <url>\n    <loc>https://' + SITE_CONFIG.domain + '/blog/' + article.slug + '</loc>\n' +
      '    <lastmod>' + article.date + '</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>\n\n';
    sitemap = sitemap.replace('</urlset>', entry + '</urlset>');
    fs.writeFileSync('sitemap.xml', sitemap);
    console.log('Sitemap updated');
  }

  // Git commit and push
  execSync('git config user.name "blog-bot"');
  execSync('git config user.email "blog-bot@users.noreply.github.com"');
  execSync('git add ' + filePath);
  try { execSync('git add ' + indexPath); } catch(e) {}
  try { execSync('git add sitemap.xml'); } catch(e) {}
  execSync('git diff --staged --quiet || git commit -m "blog: ' + article.slug + '"');
  execSync('git push origin main');
  console.log('Pushed to GitHub');

  // Trigger Netlify
  if (SITE_CONFIG.netlifyHook) {
    https.request(new URL(SITE_CONFIG.netlifyHook), { method: 'POST' }, function(){}).end();
    console.log('Netlify deploy triggered');
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Auto Blog — ' + SITE_CONFIG.siteName);
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  if (!SITE_CONFIG.domain) throw new Error('SITE_DOMAIN not set');

  var topic = await pickTopic();
  var article = await writeArticle(topic);
  var html = buildHTML(article);
  saveAndCommit(article, html);
  console.log('Done: https://' + SITE_CONFIG.domain + '/blog/' + article.slug);
}

main().catch(function(e) {
  console.error('Fatal error:', e.message || e);
  process.exit(1);
});
