const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const write = (file, content) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};

const copies = {
  'production-fixes/operations-route.js': 'app/api/operations/[action]/route.js',
  'production-fixes/knowledge-route.js': 'app/api/knowledge/[action]/route.js',
  'production-fixes/engagement-route.js': 'app/api/engagement/[action]/route.js',
  'production-fixes/knowledge-nav-runtime.js': 'components/knowledge-nav-runtime.js',
  'production-fixes/market-mirror-control.js': 'components/market-mirror-control.js',
};

for (const [source, target] of Object.entries(copies)) write(target, read(source));

let control = read('components/control-workspace.js');
if (!control.includes("import MarketMirrorControl from './market-mirror-control';")) {
  control = control.replace(
    "import MarktoneLogo from './marktone-logo';",
    "import MarktoneLogo from './marktone-logo';\nimport MarketMirrorControl from './market-mirror-control';",
  );
}
control = control.replace(
  /if\(tab==='integrations'\)return <section className="panel">.*?<\/section>;/,
  "if(tab==='integrations')return <div className=\"integration-stack\"><MarketMirrorControl/><section className=\"panel\"><PanelHead title=\"التكاملات\" sub=\"تسجيل مزودي الخدمات وحالة الاتصال\" action=\"+ تكامل جديد\" onClick={()=>open('integration')}/><div className=\"table-list\">{(data.integrations||[]).length?(data.integrations||[]).map(x=><div key={x.id}><b>{x.name}</b><span>{x.type} · {x.tenantName||'المنصة المركزية'}</span><em className={x.status==='active'?'good':'muted'}>{x.status}</em><time>{date(x.lastCheckedAt)}</time></div>):<Empty text=\"لا توجد تكاملات بعد\" action=\"إضافة أول تكامل\" onClick={()=>open('integration')}/>}</div></section></div>;",
);
write('components/control-workspace.js', control);

let platformRoute = read('app/api/platform/[action]/route.js');
platformRoute = platformRoute.replace(
  "'update-support':'support_update_status'",
  "'update-support':'support_update_status',\n  'market-sync-snapshot':'market_sync_admin_snapshot',\n  'market-sync-run':'market_sync_run_now',\n  'market-sync-schedule':'market_sync_update_schedule'",
);
write('app/api/platform/[action]/route.js', platformRoute);

const cssMarker = '/* production fixes 1.9.0 */';
let css = read('app/marktone-theme.css');
if (!css.includes(cssMarker)) {
  css += `

${cssMarker}
.integration-stack{display:grid;gap:18px}
.market-mirror-card{background:var(--mt-card,#fff);border:1px solid var(--mt-border,#e7e4dd);border-radius:18px;padding:22px;box-shadow:0 12px 34px rgba(35,31,24,.06)}
.market-mirror-card>header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}
.market-mirror-card h3{margin:4px 0 3px;font-size:19px}
.market-mirror-card header small{font:700 10px/1.4 var(--mt-font-en,sans-serif);letter-spacing:.13em;color:var(--mt-sidebar-primary,#9b7226)}
.market-mirror-card header p{margin:0;color:var(--mt-muted-foreground,#776f63);font-size:12px}
.mirror-status{display:inline-flex;align-items:center;gap:7px;padding:7px 11px;border-radius:999px;background:#fff2e8;color:#a64f20;font-size:11px;font-weight:700;white-space:nowrap}
.mirror-status:before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.mirror-status.active{background:#eaf8ef;color:#28794a}
.mirror-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:18px 0}
.mirror-stats>div{display:flex;flex-direction:column;gap:4px;padding:13px;border:1px solid var(--mt-border,#e7e4dd);border-radius:13px;background:var(--mt-background,#fbfaf7)}
.mirror-stats b{font-size:13px}.mirror-stats span{font-size:10px;color:var(--mt-muted-foreground,#776f63)}
.mirror-actions{display:flex;align-items:end;gap:10px;flex-wrap:wrap}
.mirror-actions label{display:grid;gap:5px;font-size:11px;color:var(--mt-muted-foreground,#776f63);min-width:160px}
.mirror-actions select{min-height:39px}
.mirror-actions button{min-height:39px}
.mirror-last-error{display:block;margin-top:10px;color:#a64f20}
.knowledge-nav-button{width:100%;display:flex!important;align-items:center;gap:10px}
@media (max-width:720px){
  .market-mirror-card{padding:16px}
  .market-mirror-card>header{flex-direction:column}
  .mirror-stats{grid-template-columns:1fr}
  .mirror-actions{display:grid;grid-template-columns:1fr}
  .mirror-actions label{min-width:0}
  .mirror-actions button{width:100%}
}
`;
}
write('app/marktone-theme.css', css);

const pkg = JSON.parse(read('package.json'));
pkg.version = '1.9.0';
if (!pkg.scripts.build.includes('production-fixes-patch.cjs')) {
  pkg.scripts.build = pkg.scripts.build.replace(' && next build', ' && node production-fixes-patch.cjs && next build');
}
write('package.json', `${JSON.stringify(pkg)}\n`);

const lock = JSON.parse(read('package-lock.json'));
lock.version = '1.9.0';
if (lock.packages?.['']) lock.packages[''].version = '1.9.0';
write('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);

write('public/release.json', `${JSON.stringify({
  version: '1.9.0',
  releasedAt: new Date().toISOString(),
  highlights: [
    'Authenticated operations APIs without service-role dependency',
    'Knowledge hub navigation and API repair',
    'Platform-owner engagement access',
    'Market Mirror manual and scheduled synchronization',
  ],
}, null, 2)}\n`);

console.log('Applied production fixes 1.9.0');
