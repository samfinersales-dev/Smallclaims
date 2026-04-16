// download-module.js
// Universal PDF download module for all 5 apps
// Requires: <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>

var DownloadModule = (function() {

  function ensureJsPDF(cb) {
    if (window.jspdf && window.jspdf.jsPDF) { cb(window.jspdf.jsPDF); return; }
    var s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
    s.onload = function(){ cb(window.jspdf.jsPDF); };
    document.head.appendChild(s);
  }

  function makePDF(cfg) {
    var doc = new window.jspdf.jsPDF({unit:'mm',format:'a4'});
    var W=210,H=297,M=18,CW=W-M*2,y=M,LH=6;
    doc.setFillColor(cfg.primaryColor||'#0d7377');
    doc.rect(0,0,W,24,'F');
    doc.setTextColor('#ffffff');
    doc.setFontSize(14); doc.setFont('helvetica','bold');
    doc.text(cfg.siteName||'Document',M,10);
    doc.setFontSize(9); doc.setFont('helvetica','normal');
    doc.text(cfg.title,M,17);
    doc.text(new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}),W-M,17,{align:'right'});
    y=34;
    if(cfg.subtitle){doc.setTextColor('#374151');doc.setFontSize(11);doc.setFont('helvetica','bold');doc.text(cfg.subtitle,M,y);y+=LH+2;}
    if(cfg.stats){
      doc.setFillColor('#f9fafb');doc.roundedRect(M,y,CW,16,2,2,'F');
      doc.setStrokeColor('#e5e7eb');doc.roundedRect(M,y,CW,16,2,2,'S');
      var SW=CW/cfg.stats.length;
      cfg.stats.forEach(function(s,i){
        var sx=M+SW*i+SW/2;
        doc.setFontSize(12);doc.setFont('helvetica','bold');doc.setTextColor(s.color||'#111827');
        doc.text(String(s.value),sx,y+7,{align:'center'});
        doc.setFontSize(7);doc.setFont('helvetica','normal');doc.setTextColor('#6b7280');
        doc.text(s.label,sx,y+13,{align:'center'});
      });
      y+=24;
    }
    cfg.sections.forEach(function(sec){
      if(y>H-40){doc.addPage();y=M;}
      doc.setFillColor(cfg.sectionBg||'#f0fdfa');doc.rect(M,y-1,CW,8,'F');
      doc.setFontSize(9);doc.setFont('helvetica','bold');doc.setTextColor(cfg.primaryColor||'#0d7377');
      doc.text(sec.heading.toUpperCase(),M+3,y+5);y+=12;
      (sec.lines||[]).forEach(function(ln){
        if(y>H-20){doc.addPage();y=M;}
        if(ln.flag){
          doc.setFillColor('#fef2f2');doc.rect(M,y-1,CW,LH+2,'F');
          doc.setDrawColor('#fca5a5');doc.rect(M,y-1,CW,LH+2,'S');
          doc.setTextColor('#dc2626');doc.setFontSize(8);doc.setFont('helvetica','bold');
          doc.text('! '+ln.label,M+3,y+4);
          if(ln.value)doc.text(ln.value,W-M-3,y+4,{align:'right'});
          y+=LH+3;
          if(ln.flagText&&ln.flagText.trim()){
            doc.setFillColor('#fff8f8');doc.rect(M+4,y-1,CW-8,LH+2,'F');
            doc.setTextColor('#7f1d1d');doc.setFont('helvetica','normal');doc.setFontSize(7);
            var wr=doc.splitTextToSize(ln.flagText,CW-14);
            doc.text(wr,M+6,y+3);y+=wr.length*4+4;
          }
        }else if(ln.isOk){
          doc.setTextColor('#15803d');doc.setFontSize(8);doc.setFont('helvetica','normal');
          doc.text('+ '+ln.label,M+3,y+4);
          if(ln.value)doc.text(ln.value,W-M-3,y+4,{align:'right'});
          y+=LH;
        }else if(ln.isBold){
          doc.setTextColor('#111827');doc.setFontSize(9);doc.setFont('helvetica','bold');
          doc.text(ln.label,M+3,y+4);
          if(ln.value)doc.text(ln.value,W-M-3,y+4,{align:'right'});
          y+=LH+1;
        }else if(ln.isBody){
          doc.setTextColor('#374151');doc.setFontSize(8);doc.setFont('helvetica','normal');
          var wrapped=doc.splitTextToSize(ln.label,CW-6);
          wrapped.forEach(function(line){
            if(y>H-15){doc.addPage();y=M;}
            doc.text(line,M+3,y+4);y+=LH-1;
          });
          y+=2;
        }else{
          doc.setTextColor('#374151');doc.setFontSize(8);doc.setFont('helvetica','normal');
          doc.text(ln.label,M+3,y+4);
          if(ln.value){doc.setTextColor('#6b7280');doc.text(ln.value,W-M-3,y+4,{align:'right'});}
          y+=LH;
        }
      });
      y+=6;
    });
    doc.setTextColor('#9ca3af');doc.setFontSize(7);doc.setFont('helvetica','normal');
    doc.text(cfg.footer||(cfg.siteName+' — for informational purposes only.'),W/2,H-8,{align:'center'});
    return doc;
  }

  // Helper: split long text into body lines
  function bodyLines(text) {
    if (!text) return [];
    return text.split(/\n+/).filter(function(l){return l.trim();}).map(function(l){return {label:l.trim(),isBody:true};});
  }

  // ─── VERIFYDOC ────────────────────────────────────────────────────────────
  function downloadMedicalBillReport(report){
    ensureJsPDF(function(){
      var flagged=report.items.filter(function(i){return!i.ok;}),clean=report.items.filter(function(i){return i.ok;});
      var secs=[];
      if(flagged.length)secs.push({heading:'Potential Billing Errors ('+flagged.length+' found)',lines:flagged.reduce(function(a,it){a.push({label:it.code+' - '+it.desc,value:it.amount,flag:true,flagText:it.flag||''});return a;},[])});
      secs.push({heading:'Items Correct ('+clean.length+')',lines:clean.map(function(it){return{label:it.code+' - '+it.desc,value:it.amount,isOk:true};})});
      if(flagged.length)secs.push({heading:'Dispute Letters',lines:flagged.reduce(function(a,it,i){a.push({label:'LETTER '+(i+1)+': '+it.code,isBold:true},{label:'To: [Provider/Insurer]'},{label:'Re: '+it.code+' - '+it.desc},{label:it.flag||''},{label:'I request review within 30 days.'},{label:'[Your Name] | [Account No.]'},{label:' '});return a;},[])});
      makePDF({siteName:'VerifyDoc',title:'Medical Bill Audit Report',subtitle:'Audit Summary',primaryColor:'#0d7377',stats:[{value:report.total,label:'Items Audited',color:'#0d7377'},{value:report.flagged,label:'Potential Errors',color:'#dc2626'},{value:report.clean,label:'Correct',color:'#15803d'}],sections:secs,footer:'VerifyDoc is a document analysis tool. Not medical or legal advice.'}).save('verifydoc-audit-'+new Date().toISOString().split('T')[0]+'.pdf');
    });
  }

  // ─── FORMGUARD ────────────────────────────────────────────────────────────
  function downloadFormGuardReport(report){
    ensureJsPDF(function(){
      var secs=[{heading:'Form: '+(report.formName||'USCIS Form'),lines:[{label:'Form Version',value:report.formVersion||'Latest'},{label:'Total Fields Checked',value:String(report.totalFields||0)},{label:'Errors Found',value:String(report.errors?report.errors.length:0),isBold:true}]}];
      if(report.errors&&report.errors.length)secs.push({heading:'Errors & Required Corrections',lines:report.errors.reduce(function(a,e){a.push({label:e.field+(e.part?' (Part '+e.part+')':''),flag:true,flagText:e.issue+(e.fix?' FIX: '+e.fix:'')});return a;},[])});
      if(report.warnings&&report.warnings.length)secs.push({heading:'Warnings',lines:report.warnings.map(function(w){return{label:w.field+': '+w.note};})});
      makePDF({siteName:'FormGuard',title:(report.formName||'USCIS Form')+' Error Report',subtitle:(report.errors&&report.errors.length)?report.errors.length+' errors require correction':'No critical errors found',primaryColor:'#1a5c3a',stats:[{value:report.totalFields||0,label:'Fields Checked',color:'#1a5c3a'},{value:report.errors?report.errors.length:0,label:'Errors',color:'#dc2626'},{value:report.warnings?report.warnings.length:0,label:'Warnings',color:'#d97706'}],sections:secs,footer:'FormGuard identifies potential errors for informational purposes only. Not legal advice.'}).save('formguard-'+(report.formName||'form').replace(/\s+/g,'-').toLowerCase()+'-report.pdf');
    });
  }

  // ─── LEASEHELPER: LEASE AGREEMENT ─────────────────────────────────────────
  function downloadLeaseAgreement(lease){
    ensureJsPDF(function(){
      var secs=[
        {heading:'Parties',lines:[{label:'Landlord',value:lease.landlordName||'[Landlord]',isBold:true},{label:'Tenant(s)',value:lease.tenantNames||'[Tenant]',isBold:true},{label:'Property',value:lease.propertyAddress||'[Address]',isBold:true}]},
        {heading:'Lease Terms',lines:[{label:'Lease Type',value:lease.leaseType||'Fixed Term'},{label:'Start Date',value:lease.startDate||'[Start]'},{label:'End Date',value:lease.endDate||'[End]'},{label:'Monthly Rent',value:'$'+(lease.rent||'0'),isBold:true},{label:'Security Deposit',value:'$'+(lease.deposit||'0'),isBold:true},{label:'Rent Due',value:lease.rentDue||'1st of month'}]},
        {heading:'Terms',lines:(lease.terms||['Tenant shall maintain premises in clean condition.']).map(function(t){return{label:t,isBody:true};})},
        {heading:'Signatures',lines:[{label:'Landlord: ________________________________  Date: __________'},{label:''},{label:'Tenant: __________________________________  Date: __________'}]}
      ];
      makePDF({siteName:'LeaseHelper',title:(lease.state||'State')+' Residential Lease Agreement',subtitle:lease.propertyAddress||'',primaryColor:'#1c1a14',sectionBg:'#f5f0e0',sections:secs,footer:'Generated by LeaseHelper. For informational purposes only. Consult a licensed attorney.'}).save('lease-agreement-'+(lease.state||'state').toLowerCase().replace(/\s+/g,'-')+'.pdf');
    });
  }

  // ─── LEASEHELPER: EVICTION NOTICE ─────────────────────────────────────────
  function downloadEvictionNotice(data){
    ensureJsPDF(function(){
      var secs=[
        {heading:'Notice Details',lines:[{label:'Landlord',value:data.landlordName||'[Landlord]',isBold:true},{label:'Tenant(s)',value:data.tenantNames||'[Tenant]',isBold:true},{label:'Property',value:data.propertyAddress||'[Address]',isBold:true},{label:'Reason',value:data.evictionType||'[Reason]',flag:true,flagText:''},{label:'Amount Owed',value:data.amountOwed&&data.amountOwed!=='0'?'$'+data.amountOwed:'N/A'}]},
        {heading:'Notice',lines:bodyLines(data.documentText)},
        {heading:'Next Steps',lines:bodyLines(data.supplementText)},
        {heading:'Signatures',lines:[{label:'Landlord: ________________________________  Date: __________'},{label:''},{label:'Served on tenant: ________________________  Date: __________'}]}
      ];
      makePDF({siteName:'LeaseHelper',title:(data.state||'State')+' Eviction Notice',subtitle:'Notice to Vacate — '+(data.evictionType||''),primaryColor:'#8b2010',sectionBg:'#fef2f2',sections:secs,footer:'Generated by LeaseHelper. For informational purposes only. Consult a licensed attorney.'}).save('eviction-notice-'+(data.state||'state').toLowerCase().replace(/\s+/g,'-')+'.pdf');
    });
  }

  // ─── LEASEHELPER: LEASE RENEWAL ───────────────────────────────────────────
  function downloadLeaseRenewal(data){
    ensureJsPDF(function(){
      var secs=[
        {heading:'Parties',lines:[{label:'Landlord',value:data.landlordName||'[Landlord]',isBold:true},{label:'Tenant(s)',value:data.tenantNames||'[Tenant]',isBold:true},{label:'Property',value:data.propertyAddress||'[Address]',isBold:true}]},
        {heading:'Renewal Terms',lines:[{label:'New Term',value:data.renewalTerm||'1 year'},{label:'Start Date',value:data.renewalStart||'[Date]'},{label:'New Monthly Rent',value:'$'+(data.newRent||'0'),isBold:true}]},
        {heading:'Renewal Agreement',lines:bodyLines(data.documentText)},
        {heading:'Key Terms & Next Steps',lines:bodyLines(data.supplementText)},
        {heading:'Signatures',lines:[{label:'Landlord: ________________________________  Date: __________'},{label:''},{label:'Tenant: __________________________________  Date: __________'}]}
      ];
      makePDF({siteName:'LeaseHelper',title:(data.state||'State')+' Lease Renewal Agreement',subtitle:data.propertyAddress||'',primaryColor:'#1c1a14',sectionBg:'#f0f5e0',sections:secs,footer:'Generated by LeaseHelper. For informational purposes only. Consult a licensed attorney.'}).save('lease-renewal-'+(data.state||'state').toLowerCase().replace(/\s+/g,'-')+'.pdf');
    });
  }

  // ─── LEASEHELPER: RENT INCREASE ───────────────────────────────────────────
  function downloadRentIncrease(data){
    ensureJsPDF(function(){
      var secs=[
        {heading:'Notice Details',lines:[{label:'Landlord',value:data.landlordName||'[Landlord]',isBold:true},{label:'Tenant(s)',value:data.tenantNames||'[Tenant]',isBold:true},{label:'Property',value:data.propertyAddress||'[Address]',isBold:true},{label:'Current Rent',value:'$'+(data.currentRent||'0')},{label:'New Rent',value:'$'+(data.newRent||'0'),isBold:true},{label:'Effective Date',value:data.effectiveDate||'[Date]'}]},
        {heading:'Notice',lines:bodyLines(data.documentText)},
        {heading:'Key Terms & Next Steps',lines:bodyLines(data.supplementText)},
        {heading:'Signatures',lines:[{label:'Landlord: ________________________________  Date: __________'}]}
      ];
      makePDF({siteName:'LeaseHelper',title:(data.state||'State')+' Rent Increase Notice',subtitle:'Effective '+(data.effectiveDate||'[Date]'),primaryColor:'#6b5210',sectionBg:'#fef9e0',sections:secs,footer:'Generated by LeaseHelper. For informational purposes only. Consult a licensed attorney.'}).save('rent-increase-'+(data.state||'state').toLowerCase().replace(/\s+/g,'-')+'.pdf');
    });
  }

  // ─── LEASEHELPER: MOVE-OUT CHECKLIST ──────────────────────────────────────
  function downloadMoveOutChecklist(data){
    ensureJsPDF(function(){
      var secs=[
        {heading:'Property Details',lines:[{label:'Tenant(s)',value:data.tenantNames||'[Tenant]',isBold:true},{label:'Property',value:data.propertyAddress||'[Address]',isBold:true},{label:'Move-Out Date',value:data.moveoutDate||'[Date]'},{label:'Security Deposit',value:'$'+(data.depositAmount||'0'),isBold:true}]},
        {heading:'Inspection Checklist',lines:bodyLines(data.documentText)},
        {heading:'Deposit Return Info',lines:bodyLines(data.supplementText)},
        {heading:'Signatures',lines:[{label:'Landlord: ________________________________  Date: __________'},{label:''},{label:'Tenant: __________________________________  Date: __________'}]}
      ];
      makePDF({siteName:'LeaseHelper',title:(data.state||'State')+' Move-Out Checklist',subtitle:data.propertyAddress||'',primaryColor:'#1a3a5c',sectionBg:'#e8f0f8',sections:secs,footer:'Generated by LeaseHelper. For informational purposes only. Consult a licensed attorney.'}).save('move-out-checklist-'+(data.state||'state').toLowerCase().replace(/\s+/g,'-')+'.pdf');
    });
  }

  // ─── LEASEHELPER: LEASE TERMINATION ───────────────────────────────────────
  function downloadLeaseTermination(data){
    ensureJsPDF(function(){
      var secs=[
        {heading:'Notice Details',lines:[{label:'From',value:data.senderName||'[Sender]',isBold:true},{label:'To',value:data.recipientName||'[Recipient]',isBold:true},{label:'Property',value:data.propertyAddress||'[Address]',isBold:true},{label:'Termination Date',value:data.terminationDate||'[Date]'},{label:'Reason',value:data.terminationReason||'End of lease term'}]},
        {heading:'Termination Notice',lines:bodyLines(data.documentText)},
        {heading:'Key Terms & Next Steps',lines:bodyLines(data.supplementText)},
        {heading:'Signatures',lines:[{label:'Signature: ________________________________  Date: __________'}]}
      ];
      makePDF({siteName:'LeaseHelper',title:(data.state||'State')+' Lease Termination Letter',subtitle:'Effective '+(data.terminationDate||'[Date]'),primaryColor:'#4a1a1a',sectionBg:'#f5eded',sections:secs,footer:'Generated by LeaseHelper. For informational purposes only. Consult a licensed attorney.'}).save('lease-termination-'+(data.state||'state').toLowerCase().replace(/\s+/g,'-')+'.pdf');
    });
  }

  // ─── LEASEHELPER: UNIVERSAL DOWNLOAD (routes to correct template) ─────────
  function downloadLeaseDocument(data) {
    var docType = data.docType || 'lease';
    if (docType === 'eviction') return downloadEvictionNotice(data);
    if (docType === 'renewal') return downloadLeaseRenewal(data);
    if (docType === 'rentincrease') return downloadRentIncrease(data);
    if (docType === 'moveout') return downloadMoveOutChecklist(data);
    if (docType === 'termination') return downloadLeaseTermination(data);
    return downloadLeaseAgreement(data);
  }

  // ─── SMALLCLAIMS ──────────────────────────────────────────────────────────
  function downloadSmallClaimsPackage(claim){
    ensureJsPDF(function(){
      var secs=[
        {heading:'Plaintiff (You)',lines:[{label:'Name',value:claim.plaintiffName||'[Your Name]'},{label:'Address',value:claim.plaintiffAddress||'[Address]'}]},
        {heading:'Defendant',lines:[{label:'Name',value:claim.defendantName||'[Defendant]'},{label:'Address',value:claim.defendantAddress||'[Address]'}]},
        {heading:'Your Claim',lines:[{label:'Amount Claimed',value:'$'+(claim.amount||'0'),isBold:true},{label:'State',value:claim.state||'[State]'},{label:'Court',value:claim.court||'Your local small claims court'},{label:'Filing Fee',value:claim.filingFee||'Check with court'}]},
        {heading:'Statement of Claim',lines:(claim.statementLines||['[Describe what happened]']).map(function(l){return{label:l,isBody:true};})},
        {heading:'Evidence Checklist',lines:(claim.evidence||['Contracts','Receipts','Photos','Texts/emails','Witnesses']).map(function(e){return{label:'☐ '+e};})},
        {heading:'Hearing Script',lines:[{label:'Opening:',isBold:true}].concat([{label:claim.openingStatement||'"Your Honor, I am '+(claim.plaintiffName||'[Name]')+'. I am here because...',isBody:true}]).concat((claim.keyPoints||['State facts clearly']).map(function(p){return{label:'• '+p};})) }
      ];
      makePDF({siteName:'SmallClaimsHelper',title:(claim.state||'State')+' Small Claims Package',subtitle:(claim.plaintiffName||'Plaintiff')+' v. '+(claim.defendantName||'Defendant')+' — $'+(claim.amount||'0'),primaryColor:'#1a1a2e',sections:secs,footer:'SmallClaimsHelper generates documents for informational purposes only. Not legal advice.'}).save('small-claims-'+(claim.state||'state').toLowerCase().replace(/\s+/g,'-')+'.pdf');
    });
  }

  // ─── SHADOWAI ─────────────────────────────────────────────────────────────
  function downloadAIPolicy(policy){
    ensureJsPDF(function(){
      var secs=[
        {heading:'Policy Information',lines:[{label:'Organization',value:policy.orgName||'[Org]',isBold:true},{label:'Effective Date',value:policy.effectiveDate||new Date().toLocaleDateString()},{label:'Version',value:policy.version||'1.0'},{label:'Approved By',value:policy.approvedBy||'[Approver]'}]},
        {heading:'Purpose',lines:[{label:policy.purpose||'This policy governs acceptable use of AI tools.',isBody:true}]},
        {heading:'Approved AI Tools',lines:(policy.approvedTools||['[List]']).map(function(t){return{label:'✓ '+t,isOk:true};})},
        {heading:'Prohibited Uses',lines:(policy.prohibitedUses||['Inputting confidential data']).map(function(p){return{label:p,flag:true,flagText:''};})},
        {heading:'Required Practices',lines:(policy.requiredPractices||['Verify AI content']).map(function(r){return{label:'• '+r};})},
        {heading:'Acknowledgment',lines:[{label:'By signing below I confirm I have read and agree to comply with this policy.',isBody:true},{label:''},{label:'Employee: ________________________________  Date: __________'},{label:''},{label:'Signature: _______________________________  Dept: ___________'}]}
      ];
      makePDF({siteName:'Shadow AI Policy',title:'AI Acceptable Use Policy — '+(policy.orgName||'[Org]'),subtitle:'Effective '+(policy.effectiveDate||new Date().toLocaleDateString()),primaryColor:'#1a3a5c',sectionBg:'#e8f0f8',sections:secs,footer:'Generated by ShadowAIPolicy.com. For informational purposes only. Review with legal counsel.'}).save('ai-policy-'+(policy.orgName||'org').toLowerCase().replace(/\s+/g,'-')+'.pdf');
    });
  }

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
