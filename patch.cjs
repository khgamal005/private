const fs = require('fs');

const workspaceFiles = [
  'components/control-workspace.js',
  'components/tenant-workspace.js',
];

for (const file of workspaceFiles) {
  let source = fs.readFileSync(file, 'utf8');

  source = source.replace(
    /useEffect\(\(\)=>\{try\{setAssistantOpen\(localStorage\.getItem\('marktone-assistant-open'\)==='1'\)\}catch\{\}\},\[\]\);?/g,
    "useEffect(()=>{try{localStorage.removeItem('marktone-assistant-open')}catch{}},[]);",
  );

  source = source.replace(
    /function setAssistantVisibility\(open\)\{setAssistantOpen\(open\);try\{localStorage\.setItem\('marktone-assistant-open',open\?'1':'0'\)\}catch\{\}\}/g,
    'function setAssistantVisibility(open){setAssistantOpen(open)}',
  );

  fs.writeFileSync(file, source);
}

const releasePath = 'public/release.json';
const release = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
release.version = '1.3.1';
release.release = 'assistant-always-collapsed-on-load';
release.assistantDefault = 'collapsed';
fs.writeFileSync(releasePath, `${JSON.stringify(release, null, 2)}\n`);

console.log('Applied release 1.3.1: assistant always starts collapsed');
