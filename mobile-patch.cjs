const fs = require('fs');

const themePath = 'app/marktone-theme.css';
const globalsPath = 'app/globals.css';
const cssPath = fs.existsSync(themePath) ? themePath : globalsPath;

if (!fs.existsSync(cssPath)) {
  throw new Error('No application CSS file found for the mobile patch');
}

const marker = '/* MARKTONE MOBILE RELEASE 1.4.0 */';
let css = fs.readFileSync(cssPath, 'utf8');
css = css.split(marker)[0].trimEnd();

const mobileCss = String.raw`

${marker}
html, body { overflow-x: hidden !important; max-width: 100%; }
img, svg, video, canvas { max-width: 100%; }
button, a, input, select, textarea { -webkit-tap-highlight-color: transparent; }

@media (max-width: 820px) {
  :root { --mobile-page-pad: 14px; }

  .shell,
  .control-shell,
  .tenant-shell {
    display: block !important;
    width: 100% !important;
    min-width: 0 !important;
    overflow-x: clip !important;
  }

  .side {
    position: relative !important;
    inset: auto !important;
    width: 100% !important;
    height: auto !important;
    min-height: 0 !important;
    padding: 10px 12px 9px !important;
    border: 0 !important;
    border-radius: 0 !important;
    overflow: hidden !important;
  }

  .brand-logo-link {
    width: 150px !important;
    padding: 0 0 9px !important;
  }

  .side .marktone-logo {
    display: block !important;
  }

  .side .marktone-logo svg {
    width: 150px !important;
    max-height: 58px !important;
    border-radius: 12px !important;
  }

  .side .marktone-logo > span,
  .side .account {
    display: none !important;
  }

  .side nav {
    display: flex !important;
    grid-template-columns: none !important;
    gap: 7px !important;
    width: calc(100% + 4px) !important;
    margin-inline: -2px !important;
    padding: 2px 2px 5px !important;
    overflow-x: auto !important;
    overflow-y: hidden !important;
    overscroll-behavior-inline: contain;
    scroll-snap-type: inline proximity;
    scrollbar-width: none;
  }

  .side nav::-webkit-scrollbar { display: none; }

  .side nav button,
  .side nav a {
    flex: 0 0 auto !important;
    width: auto !important;
    min-width: max-content !important;
    min-height: 39px !important;
    margin: 0 !important;
    padding: 9px 12px !important;
    white-space: nowrap !important;
    text-align: center !important;
    font-size: 12px !important;
    border: 1px solid rgba(255,255,255,.08) !important;
    scroll-snap-align: start;
  }

  .side nav button.active,
  .side nav a.active {
    box-shadow: inset 0 -3px 0 var(--mt-sidebar-primary) !important;
  }

  .main,
  .control-shell .main,
  .tenant-shell .main {
    width: 100% !important;
    min-width: 0 !important;
    overflow: visible !important;
  }

  .top {
    top: 0 !important;
    z-index: 30 !important;
    min-height: 64px !important;
    height: auto !important;
    padding: 11px var(--mobile-page-pad) !important;
    gap: 8px !important;
    flex-wrap: wrap !important;
    align-items: center !important;
  }

  .top > div:first-child {
    min-width: 0 !important;
    flex: 1 1 180px !important;
  }

  .top h1 {
    max-width: 100% !important;
    font-size: 18px !important;
    white-space: nowrap !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
  }

  .top p { display: none !important; }

  .top > div:last-child,
  .top .user-actions {
    display: flex !important;
    width: auto !important;
    max-width: 100% !important;
    gap: 7px !important;
    align-items: center !important;
    overflow-x: auto !important;
    scrollbar-width: none;
  }

  .top > div:last-child::-webkit-scrollbar,
  .top .user-actions::-webkit-scrollbar { display: none; }

  .top button,
  .top a,
  .small-button,
  .quick-actions button,
  .action-stack button,
  .panel-head button,
  .panel-link,
  .hero-link {
    min-height: 42px !important;
    padding: 10px 12px !important;
    font-size: 12px !important;
    white-space: nowrap !important;
  }

  .user-email { display: none !important; }

  .content {
    width: 100% !important;
    max-width: 100% !important;
    padding: var(--mobile-page-pad) !important;
    overflow-x: clip !important;
  }

  .hero {
    display: grid !important;
    grid-template-columns: minmax(0, 1fr) !important;
    gap: 15px !important;
    padding: 18px !important;
    border-radius: 17px !important;
  }

  .hero h2 {
    margin: 8px 0 !important;
    font-size: 22px !important;
    line-height: 1.35 !important;
  }

  .hero p { font-size: 11px !important; line-height: 1.75 !important; }
  .hero button,
  .hero .hero-link { width: 100% !important; text-align: center !important; margin: 0 !important; }

  .stats {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
    gap: 9px !important;
    margin: 12px 0 !important;
  }

  .stats article,
  .stat-button {
    min-width: 0 !important;
    padding: 13px !important;
    border-radius: 14px !important;
  }

  .stats b,
  .stat-button b { font-size: 21px !important; }

  .grid {
    display: grid !important;
    grid-template-columns: minmax(0, 1fr) !important;
    gap: 11px !important;
    margin-top: 11px !important;
  }

  .panel,
  .surface {
    width: 100% !important;
    min-width: 0 !important;
    padding: 14px !important;
    border-radius: 15px !important;
    overflow-x: auto !important;
  }

  .panel-head,
  .surface-head {
    flex-wrap: wrap !important;
    align-items: flex-start !important;
    gap: 9px !important;
  }

  .panel-head > div,
  .surface-head > div { min-width: 0 !important; flex: 1 1 180px !important; }
  .panel-head h3,
  .surface-head h3 { font-size: 14px !important; }

  .plans,
  .feature-grid,
  .role-grid,
  .service-grid,
  .form-cards,
  .entity-grid,
  .assistant-actions,
  .provision-grid,
  .health-grid {
    grid-template-columns: minmax(0, 1fr) !important;
  }

  .tenant-row,
  .tenant-admin-card {
    grid-template-columns: minmax(0, 1fr) !important;
    align-items: start !important;
    gap: 10px !important;
  }

  .tenant-row > *,
  .tenant-admin-card > *,
  .support-list article > *,
  .table-list > div > * { min-width: 0 !important; }

  .tenant-row .avatar,
  .tenant-admin-card .avatar { display: none !important; }

  .tenant-row .mini,
  .tenant-row em,
  .tenant-row > a,
  .tenant-admin-card label,
  .tenant-admin-card .small-button {
    grid-column: auto !important;
    width: 100% !important;
  }

  .tenant-row .mini { display: flex !important; flex-wrap: wrap !important; }

  .table-list > div {
    grid-template-columns: minmax(0, 1fr) !important;
    gap: 6px !important;
  }

  .table-list span,
  .table-list time { grid-column: auto !important; }

  .panel table,
  .surface table { min-width: 680px !important; }

  .kanban {
    gap: 9px !important;
    padding: 2px 2px 12px !important;
    scroll-snap-type: inline mandatory;
    overscroll-behavior-inline: contain;
  }

  .column {
    min-width: min(84vw, 330px) !important;
    scroll-snap-align: start;
  }

  .task {
    grid-template-columns: auto minmax(0, 1fr) !important;
    align-items: start !important;
  }

  .task time,
  .task .task-complete,
  .task .done-badge {
    grid-column: 2 !important;
    justify-self: start !important;
  }

  .course,
  .people article,
  .role-people button,
  .contact-list article,
  .activity-list article,
  .audit-list article,
  .service-card,
  .entity-card {
    min-width: 0 !important;
  }

  .support-list article {
    grid-template-columns: minmax(0, 1fr) !important;
  }

  .quick-actions {
    flex-wrap: nowrap !important;
    overflow-x: auto !important;
    padding-bottom: 4px !important;
    scrollbar-width: none;
  }

  .quick-actions::-webkit-scrollbar { display: none; }
  .quick-actions button { flex: 0 0 auto !important; }

  .modal-backdrop {
    align-items: end !important;
    padding: 0 !important;
  }

  .command-modal {
    width: 100% !important;
    max-width: none !important;
    max-height: 92dvh !important;
    border-radius: 20px 20px 0 0 !important;
    overflow: auto !important;
  }

  .command-modal > header {
    position: sticky !important;
    top: 0 !important;
    z-index: 4 !important;
    padding: 15px 16px !important;
  }

  .command-modal > header h2 { font-size: 19px !important; }
  .command-modal form,
  .command-modal > form { padding: 14px !important; }

  .form-grid,
  .tenant-provision-grid,
  .provision-form {
    grid-template-columns: minmax(0, 1fr) !important;
  }

  .form-grid label.wide,
  .tenant-provision-grid .wide,
  .provision-form button,
  .provision-form .form-error {
    grid-column: auto !important;
  }

  .command-modal form > footer,
  .command-modal > form > footer {
    position: sticky !important;
    bottom: 0 !important;
    z-index: 3 !important;
    display: grid !important;
    grid-template-columns: 1fr 1fr !important;
    gap: 8px !important;
    margin: 18px -14px -14px !important;
    padding: 12px 14px calc(12px + env(safe-area-inset-bottom)) !important;
    background: rgba(255,255,255,.97) !important;
    backdrop-filter: blur(12px);
  }

  .command-modal form > footer button,
  .command-modal > form > footer button {
    width: 100% !important;
    min-width: 0 !important;
    min-height: 46px !important;
  }

  .market-results { max-height: 34dvh !important; }
  .market-results > button { grid-template-columns: minmax(0, 1fr) !important; }
  .market-result-meta { text-align: right !important; }

  .selected-market-account {
    grid-template-columns: auto minmax(0, 1fr) !important;
  }

  .selected-market-account button {
    grid-column: 2 !important;
    justify-self: start !important;
  }

  .assistant {
    right: 10px !important;
    left: 10px !important;
    bottom: calc(10px + env(safe-area-inset-bottom)) !important;
    width: auto !important;
    max-height: 78dvh !important;
    border-radius: 16px !important;
  }

  .assistant > div { max-height: 45dvh !important; overflow: auto !important; }

  .assistant-launcher {
    left: 14px !important;
    bottom: calc(14px + env(safe-area-inset-bottom)) !important;
    width: 52px !important;
    height: 52px !important;
  }

  .auth-page { padding: 12px !important; }
  .auth-card,
  .auth-card.narrow { display: block !important; width: 100% !important; border-radius: 20px !important; }
  .auth-brand { padding: 13px 15px !important; }
  .auth-brand .marktone-logo svg { width: 145px !important; }
  .auth-brand .marktone-logo > span,
  .auth-email { display: none !important; }
  .auth-copy,
  .auth-form { padding: 21px !important; }
  .auth-copy h1 { font-size: 27px !important; }

  .onboarding { padding: 20px 14px !important; }
  .onboarding-head h1 { font-size: 31px !important; }
  .provision-form { width: 100% !important; margin: 20px 0 !important; padding: 17px !important; }

  .assistant-page { margin: 12px auto !important; padding: 20px 14px !important; }
  .assistant-page h2 { font-size: 27px !important; }
  .assistant-big-input { display: grid !important; }
  .assistant-big-input button { min-height: 45px !important; }
}

@media (max-width: 430px) {
  :root { --mobile-page-pad: 11px; }
  .stats { grid-template-columns: minmax(0, 1fr) !important; }
  .hero h2 { font-size: 20px !important; }
  .top h1 { font-size: 16px !important; }
  .command-modal form > footer,
  .command-modal > form > footer { grid-template-columns: minmax(0, 1fr) !important; }
  .side .marktone-logo svg { width: 135px !important; }
}
`;

fs.writeFileSync(cssPath, `${css}${mobileCss}\n`);

const releasePath = 'public/release.json';
const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
release.version = '1.4.0';
release.release = 'mobile-responsive-layout';
release.mobileResponsive = true;
release.mobileBreakpoint = 820;
fs.writeFileSync(releasePath, `${JSON.stringify(release, null, 2)}\n`);

console.log(`Applied Marktone mobile release 1.4.0 to ${cssPath}`);
