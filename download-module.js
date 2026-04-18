// download-module.js
// Professional PDF generation for all 5 apps
// Uses jsPDF 2.5.1 — loaded via CDN or ensured dynamically

var DownloadModule = (function() {

  // ── ENSURE jsPDF IS LOADED ──────────────────────────────────────────────
  function ensureJsPDF(cb) {
    if (window.jspdf && window.jspdf.jsPDF) { cb(); return; }
    var s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    s.onload = function() { cb(); };
    s.onerror = function() { alert('PDF library failed to load. Please try again or use the text download.'); };
    document.head.appendChild(s);
  }

  // ── PDF HELPER: new document ────────────────────────────────────────────
  function newDoc() {
    return new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
  }

  // ── PDF CONSTANTS ────────────────────────────────────────────────────────
  var W = 210, H = 297, ML = 18, MR = 18, MT = 18, CW = W - ML - MR;

  // ── COLOR HELPERS ────────────────────────────────────────────────────────
  function hexToRgb(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    return [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16)];
  }
  function setFill(doc, hex) { var c=hexToRgb(hex); doc.setFillColor(c[0],c[1],c[2]); }
  function setStroke(doc, hex) { var c=hexToRgb(hex); doc.setDrawColor(c[0],c[1],c[2]); }
  function setColor(doc, hex) { var c=hexToRgb(hex); doc.setTextColor(c[0],c[1],c[2]); }

  // ── SAFE TEXT ────────────────────────────────────────────────────────────
  function safeText(doc, text, x, y, opts) {
    if (!text && text !== 0) return;
    var s = String(text).trim();
    if (!s) return;
    try { doc.text(s, x, y, opts || {}); } catch(e) {}
  }

  // ── SPLIT TO SIZE SAFE ───────────────────────────────────────────────────
  function wrapText(doc, text, maxW) {
    if (!text) return [''];
    try { return doc.splitTextToSize(String(text), maxW); }
    catch(e) { return [String(text).substring(0,80)]; }
  }

  // ── PAGE HEADER ─────────────────────────────────────────────────────────
  function pageHeader(doc, cfg) {
    // Full-width color bar
    setFill(doc, cfg.accentColor || '#1a3a5c');
    doc.rect(0, 0, W, 18, 'F');
    // Site name left
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    setColor(doc, '#ffffff');
    safeText(doc, cfg.siteName, ML, 12);
    // Document title right
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    safeText(doc, cfg.docTitle, W - MR, 12, { align: 'right' });
    // Thin rule below bar
    setStroke(doc, cfg.accentColor || '#1a3a5c');
    doc.setLineWidth(0.3);
    doc.line(0, 18, W, 18);
  }

  // ── DOCUMENT TITLE BLOCK (first page only) ───────────────────────────────
  function titleBlock(doc, cfg, y) {
    // Light background
    setFill(doc, cfg.titleBg || '#f4f7fb');
    doc.rect(ML, y, CW, 28, 'F');
    setStroke(doc, cfg.accentColor || '#1a3a5c');
    doc.setLineWidth(0.4);
    doc.line(ML, y, ML, y + 28); // left accent bar
    // Title
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    setColor(doc, cfg.accentColor || '#1a3a5c');
    safeText(doc, cfg.title, ML + 5, y + 10);
    // Subtitle
    if (cfg.subtitle) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      setColor(doc, '#555555');
      safeText(doc, cfg.subtitle, ML + 5, y + 18);
    }
    // Date right
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    setColor(doc, '#888888');
    safeText(doc, new Date().toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'}), W - MR, y + 10, { align: 'right' });
    return y + 36;
  }

  // ── STATS BAR ────────────────────────────────────────────────────────────
  function statsBar(doc, stats, y, accentColor) {
    var sw = CW / stats.length;
    setFill(doc, '#ffffff');
    setStroke(doc, '#e0e0e0');
    doc.setLineWidth(0.3);
    doc.rect(ML, y, CW, 18, 'FD');
    stats.forEach(function(s, i) {
      var x = ML + sw * i;
      // Divider
      if (i > 0) { doc.setLineWidth(0.2); doc.line(x, y + 2, x, y + 16); }
      var cx = x + sw / 2;
      // Value
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      var c = hexToRgb(s.color || accentColor || '#1a3a5c');
      doc.setTextColor(c[0], c[1], c[2]);
      safeText(doc, String(s.value), cx, y + 9, { align: 'center' });
      // Label
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      setColor(doc, '#888888');
      safeText(doc, s.label, cx, y + 15, { align: 'center' });
    });
    return y + 24;
  }

  // ── SECTION HEADING ──────────────────────────────────────────────────────
  function sectionHead(doc, text, y, accentColor) {
    setFill(doc, accentColor || '#1a3a5c');
    doc.rect(ML, y, 3, 7, 'F');
    setFill(doc, '#f0f4f8');
    doc.rect(ML + 3, y, CW - 3, 7, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    setColor(doc, accentColor || '#1a3a5c');
    safeText(doc, (text || '').toUpperCase(), ML + 7, y + 5);
    return y + 11;
  }

  // ── KEY-VALUE ROW ────────────────────────────────────────────────────────
  function kvRow(doc, label, value, y, bold) {
    if (y > H - 16) return y;
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(8.5);
    setColor(doc, '#555555');
    safeText(doc, label + ':', ML + 2, y + 4);
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    setColor(doc, '#111111');
    safeText(doc, String(value || ''), ML + 52, y + 4);
    return y + 7;
  }

  // ── BODY PARAGRAPH ───────────────────────────────────────────────────────
  function bodyParagraph(doc, text, y, maxY, onNewPage) {
    if (!text) return y;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    setColor(doc, '#333333');
    // Split on newlines first to preserve paragraph breaks
    var paragraphs = String(text).split(/\n+/);
    paragraphs.forEach(function(para) {
      if (!para.trim()) { y += 3; return; } // blank line = small gap
      var lines = wrapText(doc, para.trim(), CW - 4);
      lines.forEach(function(line) {
        if (y > (maxY || H - 16)) {
          doc.addPage();
          if (onNewPage) onNewPage(doc);
          y = MT + 22;
        }
        safeText(doc, line, ML + 2, y + 4);
        y += 5.5;
      });
      y += 2; // paragraph gap
    });
    return y + 2;
  }

  // ── FLAG ROW (error/warning) ─────────────────────────────────────────────
  function flagRow(doc, label, detail, y, onNewPage) {
    if (y > H - 25) { doc.addPage(); if (onNewPage) onNewPage(doc); y = MT + 22; }
    setFill(doc, '#fff5f5');
    setStroke(doc, '#ffcccc');
    doc.setLineWidth(0.3);
    doc.rect(ML, y, CW, 6, 'FD');
    setFill(doc, '#e53e3e');
    doc.rect(ML, y, 2, 6, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    setColor(doc, '#c53030');
    safeText(doc, '⚠  ' + String(label || ''), ML + 4, y + 4.5);
    y += 7;
    if (detail) {
      y = bodyParagraph(doc, detail, y, H - 16, onNewPage);
    }
    return y + 1;
  }

  // ── OK ROW (success) ─────────────────────────────────────────────────────
  function okRow(doc, label, value, y) {
    if (y > H - 12) return y;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    setColor(doc, '#276749');
    safeText(doc, '✓  ' + String(label || ''), ML + 2, y + 4);
    if (value) { setColor(doc, '#555555'); safeText(doc, String(value), W - MR, y + 4, { align: 'right' }); }
    return y + 6.5;
  }

  // ── CHECKBOX ROW ─────────────────────────────────────────────────────────
  function checkboxRow(doc, label, y) {
    if (y > H - 12) return y;
    // Draw box
    setStroke(doc, '#888888');
    setFill(doc, '#ffffff');
    doc.setLineWidth(0.4);
    doc.rect(ML + 2, y, 4, 4, 'FD');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    setColor(doc, '#333333');
    safeText(doc, String(label || ''), ML + 9, y + 3.5);
    return y + 7;
  }

  // ── SIGNATURE BLOCK ──────────────────────────────────────────────────────
  function signatureBlock(doc, labels, y) {
    if (y > H - 30) { return y; }
    y += 4;
    setFill(doc, '#fafafa');
    setStroke(doc, '#e0e0e0');
    doc.setLineWidth(0.3);
    var bh = labels.length * 16 + 8;
    doc.rect(ML, y, CW, bh, 'FD');
    var sy = y + 10;
    labels.forEach(function(label) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      setColor(doc, '#555555');
      safeText(doc, label + ':', ML + 4, sy);
      setStroke(doc, '#aaaaaa');
      doc.setLineWidth(0.3);
      doc.line(ML + 30, sy, ML + CW/2, sy);
      safeText(doc, 'Date:', ML + CW/2 + 4, sy);
      doc.line(ML + CW/2 + 18, sy, ML + CW - 4, sy);
      sy += 16;
    });
    return y + bh + 4;
  }

  // ── PAGE FOOTER ──────────────────────────────────────────────────────────
  function pageFooter(doc, text, pageNum) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    setColor(doc, '#aaaaaa');
    safeText(doc, text || '', ML, H - 6);
    if (pageNum !== undefined) safeText(doc, 'Page ' + pageNum, W - MR, H - 6, { align: 'right' });
    setStroke(doc, '#dddddd');
    doc.setLineWidth(0.2);
    doc.line(ML, H - 9, W - MR, H - 9);
  }

  // ════════════════════════════════════════════════════════════════════════
  // ── VERIFYDOC: MEDICAL BILL AUDIT REPORT ────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════
  function downloadMedicalBillReport(report) {
    ensureJsPDF(function() {
      var doc = newDoc();
      var accent = '#0d7377';
      var pgNum = 1;

      function header() { pageHeader(doc, { siteName: 'VerifyDoc', docTitle: 'Medical Bill Audit Report', accentColor: accent }); }
      function footer() { pageFooter(doc, 'VerifyDoc — For informational purposes only. Not medical or legal advice.', pgNum++); }

      header();
      var y = titleBlock(doc, { title: 'Medical Bill Audit Report', subtitle: 'AI-powered analysis of charges, codes, and potential billing errors', accentColor: accent, titleBg: '#e6f7f7' }, 22);

      // Stats
      y = statsBar(doc, [
        { value: report.total || 0, label: 'Items Audited', color: '#0d7377' },
        { value: report.flagged || 0, label: 'Potential Errors', color: '#c53030' },
        { value: report.clean || 0, label: 'Correct', color: '#276749' }
      ], y, accent);
      y += 4;

      var flagged = (report.items || []).filter(function(i) { return !i.ok; });
      var clean = (report.items || []).filter(function(i) { return i.ok; });

      // Flagged items
      if (flagged.length) {
        y = sectionHead(doc, 'Potential Billing Errors (' + flagged.length + ' found)', y, '#c53030');
        flagged.forEach(function(item) {
          if (y > H - 35) { footer(); doc.addPage(); pgNum; header(); y = 22; }
          flagRow(doc, item.code + ' — ' + (item.desc || '') + '  ' + (item.amount || ''), item.flag || '', y, function() { header(); });
          y += (item.flag ? wrapText(doc, item.flag, CW - 4).length * 5.5 + 12 : 10);
        });
        y += 4;
      }

      // Clean items
      if (clean.length) {
        if (y > H - 40) { footer(); doc.addPage(); header(); y = 22; }
        y = sectionHead(doc, 'Items Correct (' + clean.length + ')', y, accent);
        clean.forEach(function(item) {
          if (y > H - 14) { footer(); doc.addPage(); header(); y = 22; }
          y = okRow(doc, item.code + ' — ' + (item.desc || ''), item.amount || '', y);
        });
        y += 4;
      }

      // Dispute letters
      if (flagged.length) {
        if (y > H - 40) { footer(); doc.addPage(); header(); y = 22; }
        y = sectionHead(doc, 'Dispute Letters (' + flagged.length + ')', y, '#c53030');
        flagged.forEach(function(item, i) {
          if (y > H - 50) { footer(); doc.addPage(); header(); y = 22; }
          doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
          setColor(doc, '#c53030');
          safeText(doc, 'Letter ' + (i+1) + ': ' + item.code, ML + 2, y + 5); y += 9;
          var letter = item.disputeLetter || ('Dear Billing Department,\n\nI am writing to formally dispute the charge of ' + (item.amount||'') + ' for ' + item.code + ' (' + (item.desc||'') + ').\n\n' + (item.flag||'') + '\n\nI request an itemized review and written response within 30 days.\n\nSincerely,\n[Your Name]\n[Account Number]');
          y = bodyParagraph(doc, letter, y, H - 16, function() { header(); });
          y += 6;
        });
      }

      footer();
      doc.save('verifydoc-audit-' + new Date().toISOString().split('T')[0] + '.pdf');
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // ── FORMGUARD: USCIS FORM ERROR REPORT ──────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════
  function downloadFormGuardReport(report) {
    ensureJsPDF(function() {
      var doc = newDoc();
      var accent = '#1a5c3a';
      var pgNum = 1;

      function header() { pageHeader(doc, { siteName: 'FormGuard', docTitle: (report.formName || 'USCIS Form') + ' Error Report', accentColor: accent }); }
      function footer() { pageFooter(doc, 'FormGuard — For informational purposes only. Not legal or immigration advice.', pgNum++); }

      header();
      var errCount = (report.errors || []).length;
      var y = titleBlock(doc, {
        title: (report.formName || 'USCIS Form') + ' — Error Report',
        subtitle: errCount > 0 ? errCount + ' error' + (errCount !== 1 ? 's' : '') + ' require correction before filing' : 'No critical errors found',
        accentColor: accent, titleBg: '#edf7f0'
      }, 22);

      y = statsBar(doc, [
        { value: report.totalFields || 0, label: 'Fields Checked', color: accent },
        { value: errCount, label: 'Errors Found', color: '#c53030' },
        { value: (report.warnings || []).length, label: 'Warnings', color: '#b7791f' }
      ], y, accent);
      y += 4;

      // Summary
      y = sectionHead(doc, 'Form Information', y, accent);
      y = kvRow(doc, 'Form', report.formName || 'USCIS Form', y);
      y = kvRow(doc, 'Version', report.formVersion || 'Latest edition', y);
      y = kvRow(doc, 'Fields Checked', String(report.totalFields || 0), y);
      y += 4;

      // Errors
      if (errCount > 0) {
        if (y > H - 40) { footer(); doc.addPage(); header(); y = 22; }
        y = sectionHead(doc, 'Errors — Must Fix Before Filing', y, '#c53030');
        (report.errors || []).forEach(function(e, i) {
          if (y > H - 40) { footer(); doc.addPage(); header(); y = 22; }
          var label = (i+1) + '. ' + (e.field || 'Field') + (e.part ? ' (Part ' + e.part + ')' : '');
          var detail = (e.issue || '') + (e.fix ? '\n\nHow to fix: ' + e.fix : '');
          y = flagRow(doc, label, detail, y, function() { header(); });
          y += 2;
        });
      } else {
        if (y > H - 30) { footer(); doc.addPage(); header(); y = 22; }
        y = sectionHead(doc, 'Result', y, accent);
        y = bodyParagraph(doc, 'No critical errors were found in the fields reviewed. Always verify your form against the latest USCIS instructions at uscis.gov before filing.', y, H - 16, function() { header(); });
      }

      // Warnings
      if ((report.warnings || []).length > 0) {
        if (y > H - 30) { footer(); doc.addPage(); header(); y = 22; }
        y = sectionHead(doc, 'Warnings — Review Before Filing', y, '#b7791f');
        (report.warnings || []).forEach(function(w) {
          if (y > H - 14) { footer(); doc.addPage(); header(); y = 22; }
          doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
          setColor(doc, '#744210');
          safeText(doc, '⚠  ' + (w.field || '') + ': ' + (w.note || ''), ML + 2, y + 4);
          y += 7;
        });
      }

      footer();
      doc.save('formguard-' + (report.formName || 'form').replace(/\s+/g, '-').toLowerCase() + '-' + new Date().toISOString().split('T')[0] + '.pdf');
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // ── LEASEHELPER: UNIVERSAL DOCUMENT PDF ─────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════

  function makeLeasePDF(data, titleStr, subtitleStr, accentColor, bgColor, filename) {
    ensureJsPDF(function() {
      var doc = newDoc();
      var pgNum = 1;

      function header() { pageHeader(doc, { siteName: 'LeaseHelper', docTitle: titleStr, accentColor: accentColor }); }
      function footer() { pageFooter(doc, 'LeaseHelper — For informational purposes only. Consult a licensed attorney before use.', pgNum++); }

      header();
      var y = titleBlock(doc, { title: titleStr, subtitle: subtitleStr, accentColor: accentColor, titleBg: bgColor }, 22);
      y += 2;

      // Key details section
      y = sectionHead(doc, 'Document Details', y, accentColor);
      if (data.state) y = kvRow(doc, 'State', data.state, y);
      if (data.landlordName || data.senderName) y = kvRow(doc, 'From', data.landlordName || data.senderName, y, true);
      if (data.tenantNames || data.recipientName) y = kvRow(doc, 'To', data.tenantNames || data.recipientName, y, true);
      if (data.propertyAddress) y = kvRow(doc, 'Property', data.propertyAddress, y);
      if (data.rent) y = kvRow(doc, 'Monthly Rent', '$' + data.rent, y);
      if (data.deposit) y = kvRow(doc, 'Security Deposit', '$' + data.deposit, y);
      if (data.leaseType) y = kvRow(doc, 'Lease Type', data.leaseType, y);
      if (data.startDate && data.startDate !== '[Start Date]') y = kvRow(doc, 'Start Date', data.startDate, y);
      if (data.newRent) y = kvRow(doc, 'New Rent', '$' + data.newRent, y);
      if (data.effectiveDate) y = kvRow(doc, 'Effective Date', data.effectiveDate, y);
      if (data.terminationDate) y = kvRow(doc, 'Termination Date', data.terminationDate, y);
      if (data.moveoutDate) y = kvRow(doc, 'Move-Out Date', data.moveoutDate, y);
      if (data.evictionType) y = kvRow(doc, 'Reason', data.evictionType, y, true);
      if (data.amountOwed && data.amountOwed !== '0') y = kvRow(doc, 'Amount Owed', '$' + data.amountOwed, y, true);
      y += 6;

      // Main document content
      var mainText = data.documentText || '';
      if (mainText && mainText.length > 10) {
        if (y > H - 40) { footer(); doc.addPage(); header(); y = 22; }
        y = sectionHead(doc, titleStr, y, accentColor);
        y = bodyParagraph(doc, mainText, y, H - 20, function() { header(); });
        y += 4;
      } else if (data.terms && data.terms.length > 0) {
        if (y > H - 40) { footer(); doc.addPage(); header(); y = 22; }
        y = sectionHead(doc, 'Terms & Conditions', y, accentColor);
        data.terms.forEach(function(t) {
          y = bodyParagraph(doc, t, y, H - 20, function() { header(); });
        });
        y += 4;
      }

      // Supplement content
      var suppText = data.supplementText || '';
      if (suppText && suppText.length > 10) {
        if (y > H - 40) { footer(); doc.addPage(); header(); y = 22; }
        var suppTitle = data.docType === 'lease' ? 'Move-In Condition Checklist' :
                        data.docType === 'eviction' ? 'Next Steps & Timeline' :
                        data.docType === 'moveout' ? 'Move-Out Inspection Checklist' :
                        'Key Terms & Next Steps';
        y = sectionHead(doc, suppTitle, y, accentColor);
        y = bodyParagraph(doc, suppText, y, H - 20, function() { header(); });
        y += 4;
      }

      // Signature block
      if (y > H - 35) { footer(); doc.addPage(); header(); y = 22; }
      var sigLabels = ['Landlord / Sender'];
      if (data.tenantNames || data.recipientName) sigLabels.push('Tenant / Recipient');
      y = signatureBlock(doc, sigLabels, y);

      footer();
      doc.save(filename + '-' + (data.state || '').toLowerCase().replace(/\s+/g, '-') + '.pdf');
    });
  }

  function downloadLeaseAgreement(data) {
    makeLeasePDF(data, (data.state||'State') + ' Residential Lease Agreement', (data.propertyAddress||'') + (data.tenantNames ? ' · ' + data.tenantNames : ''), '#1c1a14', '#faf8f2', 'lease-agreement');
  }
  function downloadEvictionNotice(data) {
    makeLeasePDF(data, (data.state||'State') + ' Eviction Notice', 'Notice to Vacate · ' + (data.evictionType||''), '#8b1a1a', '#fff8f8', 'eviction-notice');
  }
  function downloadLeaseRenewal(data) {
    makeLeasePDF(data, (data.state||'State') + ' Lease Renewal Agreement', (data.propertyAddress||'') + (data.renewalStart ? ' · Effective ' + data.renewalStart : ''), '#1a3a1a', '#f2f8f2', 'lease-renewal');
  }
  function downloadRentIncrease(data) {
    makeLeasePDF(data, (data.state||'State') + ' Rent Increase Notice', 'Effective ' + (data.effectiveDate||'[Date]') + ' · New Rent: $' + (data.newRent||'0'), '#5c3a00', '#fdf8ee', 'rent-increase');
  }
  function downloadMoveOutChecklist(data) {
    makeLeasePDF(data, (data.state||'State') + ' Move-Out Checklist', (data.propertyAddress||'') + (data.moveoutDate ? ' · ' + data.moveoutDate : ''), '#1a3a5c', '#f0f6ff', 'move-out-checklist');
  }
  function downloadLeaseTermination(data) {
    makeLeasePDF(data, (data.state||'State') + ' Lease Termination Letter', 'Effective ' + (data.terminationDate||'[Date]'), '#3a1a1a', '#fdf0f0', 'lease-termination');
  }

  function downloadLeaseDocument(data) {
    var t = data.docType || 'lease';
    if (t === 'eviction') return downloadEvictionNotice(data);
    if (t === 'renewal') return downloadLeaseRenewal(data);
    if (t === 'rentincrease') return downloadRentIncrease(data);
    if (t === 'moveout') return downloadMoveOutChecklist(data);
    if (t === 'termination') return downloadLeaseTermination(data);
    return downloadLeaseAgreement(data);
  }

  // ════════════════════════════════════════════════════════════════════════
  // ── SMALLCLAIMS: 3-PAGE PACKAGE ─────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════
  function downloadSmallClaimsPackage(claim) {
    ensureJsPDF(function() {
      var doc = newDoc();
      var accent = '#1a1a2e';
      var pgNum = 1;

      function header(title) { pageHeader(doc, { siteName: 'SmallClaimsHelper', docTitle: title, accentColor: accent }); }
      function footer() { pageFooter(doc, 'SmallClaimsHelper — For informational purposes only. Not legal advice.', pgNum++); }

      // ── PAGE 1: COMPLAINT FORM ──────────────────────────────────────────
      header((claim.state||'State') + ' Small Claims Court — Complaint');
      var y = titleBlock(doc, {
        title: 'Small Claims Complaint Form',
        subtitle: (claim.plaintiffName||'Plaintiff') + ' v. ' + (claim.defendantName||'Defendant') + ' · $' + (claim.amount||'0'),
        accentColor: accent, titleBg: '#f0f0f8'
      }, 22);

      // Case info
      y = sectionHead(doc, 'Case Information', y, accent);
      y = kvRow(doc, 'Plaintiff', claim.plaintiffName || '[Your Name]', y, true);
      y = kvRow(doc, 'Address', claim.plaintiffAddress || '[Your Address]', y);
      y = kvRow(doc, 'Defendant', claim.defendantName || '[Defendant]', y, true);
      y = kvRow(doc, 'Address', claim.defendantAddress || '[Defendant Address]', y);
      y = kvRow(doc, 'State', claim.state || '[State]', y);
      y = kvRow(doc, 'Amount Claimed', '$' + (claim.amount || '0'), y, true);
      y = kvRow(doc, 'Claim Type', claim.claimType || 'Civil Dispute', y);
      y += 4;

      y = sectionHead(doc, 'Statement of Claim', y, accent);
      (claim.statementLines || ['[Describe what happened and why you are owed money]']).forEach(function(line) {
        y = bodyParagraph(doc, line, y, H - 20, function() { header('Complaint (continued)'); });
      });
      y += 6;

      if (y > H - 35) { footer(); doc.addPage(); header('Complaint (continued)'); y = 22; }
      y = sectionHead(doc, 'Declaration', y, accent);
      y = bodyParagraph(doc, 'I declare under penalty of perjury that the information above is true and correct to the best of my knowledge and belief.', y, H - 16, function() { header('Complaint (continued)'); });
      y += 4;
      y = signatureBlock(doc, ['Plaintiff'], y);
      footer();

      // ── PAGE 2: EVIDENCE CHECKLIST ──────────────────────────────────────
      doc.addPage();
      header((claim.state||'State') + ' Small Claims — Evidence Checklist');
      y = titleBlock(doc, {
        title: 'Evidence Checklist',
        subtitle: 'Bring all checked items to court on your hearing date',
        accentColor: accent, titleBg: '#f0f0f8'
      }, 22);

      y = sectionHead(doc, 'Documents & Evidence to Bring', y, accent);
      var evidence = claim.evidence || ['All contracts or written agreements','All receipts, invoices, and payment records','Photographs with dates labeled','Printed text messages and emails','Witness names and contact information','3 copies of your complaint form'];
      evidence.forEach(function(item) {
        if (y > H - 14) { footer(); doc.addPage(); header('Evidence Checklist (cont.)'); y = 22; }
        y = checkboxRow(doc, item, y);
      });
      y += 6;

      if (y > H - 50) { footer(); doc.addPage(); header('Evidence Checklist (cont.)'); y = 22; }
      y = sectionHead(doc, 'Court Day Checklist', y, accent);
      ['Arrive at least 30 minutes early','Dress professionally','Bring 3 copies of all documents','Keep your presentation focused on facts and dollar amounts','Address the judge as "Your Honor" at all times','Do not interrupt the judge or opposing party'].forEach(function(tip) {
        if (y > H - 14) { footer(); doc.addPage(); header('Evidence Checklist (cont.)'); y = 22; }
        y = checkboxRow(doc, tip, y);
      });
      footer();

      // ── PAGE 3: JUDGE SCRIPT ────────────────────────────────────────────
      doc.addPage();
      header((claim.state||'State') + ' Small Claims — Hearing Script');
      y = titleBlock(doc, {
        title: 'Word-for-Word Hearing Script',
        subtitle: 'Practice this aloud before your hearing date',
        accentColor: accent, titleBg: '#f0f0f8'
      }, 22);

      y = sectionHead(doc, 'Opening Statement', y, accent);
      y = bodyParagraph(doc, claim.openingStatement || ('"Your Honor, my name is ' + (claim.plaintiffName||'[Your Name]') + ' and I am the plaintiff. I am here today because ' + (claim.defendantName||'the defendant') + ' owes me $' + (claim.amount||'[amount]') + ' for ' + (claim.claimType||'damages') + '."'), y, H - 20, function() { header('Hearing Script (cont.)'); });
      y += 6;

      if (y > H - 40) { footer(); doc.addPage(); header('Hearing Script (cont.)'); y = 22; }
      y = sectionHead(doc, 'Present Your Case', y, accent);
      (claim.keyPoints || ['State what happened clearly and in chronological order','Reference your evidence: "As shown in Exhibit A..."','State the exact dollar amount you are seeking','Explain why the defendant is responsible']).forEach(function(pt) {
        if (y > H - 14) { footer(); doc.addPage(); header('Hearing Script (cont.)'); y = 22; }
        y = bodyParagraph(doc, '• ' + pt, y, H - 16, function() { header('Hearing Script (cont.)'); });
      });
      y += 6;

      if (y > H - 35) { footer(); doc.addPage(); header('Hearing Script (cont.)'); y = 22; }
      y = sectionHead(doc, 'Closing Statement', y, accent);
      y = bodyParagraph(doc, '"Your Honor, I have presented the facts and my supporting evidence. I respectfully request that the court find in my favor and award me $' + (claim.amount||'[amount]') + ' plus court filing costs. Thank you, Your Honor."', y, H - 20, function() { header('Hearing Script (cont.)'); });
      y += 6;

      if (y > H - 40) { footer(); doc.addPage(); header('Hearing Script (cont.)'); y = 22; }
      y = sectionHead(doc, 'Tips for Responding to the Judge', y, accent);
      ['"I don\'t know" is a valid answer — never guess','Ask to repeat the question if needed: "Could you please repeat that, Your Honor?"','Answer only what was asked — do not volunteer extra information','Stay calm and composed regardless of what the defendant says'].forEach(function(tip) {
        if (y > H - 12) { footer(); doc.addPage(); header('Hearing Script (cont.)'); y = 22; }
        y = bodyParagraph(doc, '• ' + tip, y, H - 16, function() { header('Hearing Script (cont.)'); });
      });

      footer();
      doc.save('small-claims-' + (claim.state||'case').toLowerCase().replace(/\s+/g, '-') + '.pdf');
    });
  }

  // ════════════════════════════════════════════════════════════════════════
  // ── SHADOWAI: AI POLICY PDF ──────────────────────────────────────────────
  // ════════════════════════════════════════════════════════════════════════
  function downloadAIPolicy(policy) {
    ensureJsPDF(function() {
      var doc = newDoc();
      var accent = '#1a3a5c';
      var pgNum = 1;

      function header() { pageHeader(doc, { siteName: 'Shadow AI Policy', docTitle: 'AI Acceptable Use Policy', accentColor: accent }); }
      function footer() { pageFooter(doc, 'Shadow AI Policy — For informational purposes only. Review with legal counsel before adoption.', pgNum++); }

      header();
      var y = titleBlock(doc, {
        title: 'AI Acceptable Use Policy',
        subtitle: (policy.orgName || '[Organization]') + ' · Effective ' + (policy.effectiveDate || new Date().toLocaleDateString()),
        accentColor: accent, titleBg: '#eef3fa'
      }, 22);

      y = sectionHead(doc, 'Policy Information', y, accent);
      y = kvRow(doc, 'Organization', policy.orgName || '[Organization]', y, true);
      y = kvRow(doc, 'Effective Date', policy.effectiveDate || new Date().toLocaleDateString(), y);
      y = kvRow(doc, 'Version', policy.version || '1.0', y);
      y = kvRow(doc, 'Approved By', policy.approvedBy || '[Approver]', y);
      y += 4;

      y = sectionHead(doc, 'Purpose', y, accent);
      y = bodyParagraph(doc, policy.purpose || 'This policy governs the acceptable use of artificial intelligence tools by all employees and contractors.', y, H - 20, function() { header(); });
      y += 4;

      if ((policy.approvedTools || []).length) {
        if (y > H - 40) { footer(); doc.addPage(); header(); y = 22; }
        y = sectionHead(doc, 'Approved AI Tools', y, '#276749');
        (policy.approvedTools || []).forEach(function(t) {
          if (y > H - 12) { footer(); doc.addPage(); header(); y = 22; }
          y = okRow(doc, t, '', y);
        });
        y += 4;
      }

      if ((policy.prohibitedUses || []).length) {
        if (y > H - 40) { footer(); doc.addPage(); header(); y = 22; }
        y = sectionHead(doc, 'Prohibited Uses', y, '#c53030');
        (policy.prohibitedUses || []).forEach(function(p) {
          if (y > H - 25) { footer(); doc.addPage(); header(); y = 22; }
          y = flagRow(doc, p, '', y, function() { header(); });
        });
        y += 4;
      }

      if ((policy.requiredPractices || []).length) {
        if (y > H - 40) { footer(); doc.addPage(); header(); y = 22; }
        y = sectionHead(doc, 'Required Practices', y, accent);
        (policy.requiredPractices || []).forEach(function(r) {
          if (y > H - 12) { footer(); doc.addPage(); header(); y = 22; }
          y = bodyParagraph(doc, '• ' + r, y, H - 16, function() { header(); });
        });
        y += 4;
      }

      if (y > H - 50) { footer(); doc.addPage(); header(); y = 22; }
      y = sectionHead(doc, 'Employee Acknowledgment', y, accent);
      y = bodyParagraph(doc, 'By signing below, I confirm that I have read, understood, and agree to comply with this AI Acceptable Use Policy. I understand that violations may result in disciplinary action.', y, H - 20, function() { header(); });
      y += 6;
      y = signatureBlock(doc, ['Employee', 'Manager'], y);

      footer();
      doc.save('ai-policy-' + (policy.orgName || 'org').toLowerCase().replace(/\s+/g, '-') + '.pdf');
    });
  }

  // ── EXPORTS ──────────────────────────────────────────────────────────────
  return {
    downloadMedicalBillReport: downloadMedicalBillReport,
    downloadFormGuardReport: downloadFormGuardReport,
    downloadLeaseAgreement: downloadLeaseAgreement,
    downloadEvictionNotice: downloadEvictionNotice,
    downloadLeaseRenewal: downloadLeaseRenewal,
    downloadRentIncrease: downloadRentIncrease,
    downloadMoveOutChecklist: downloadMoveOutChecklist,
    downloadLeaseTermination: downloadLeaseTermination,
    downloadLeaseDocument: downloadLeaseDocument,
    downloadSmallClaimsPackage: downloadSmallClaimsPackage,
    downloadAIPolicy: downloadAIPolicy
  };
})();
