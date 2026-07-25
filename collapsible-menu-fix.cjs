const fs = require('fs');

const layoutPath = 'app/layout.js';
if (!fs.existsSync(layoutPath)) throw new Error('app/layout.js was not found');

let layout = fs.readFileSync(layoutPath, 'utf8');

layout = layout.replace(
  /function\s+RootLayout\s*\(\{children\}<MobileMenuRuntime\s*\/>\)\s*\{/,
  'function RootLayout({children}){',
);

if (!layout.includes("import MobileMenuRuntime from '../components/mobile-menu-runtime';")) {
  layout = `import MobileMenuRuntime from '../components/mobile-menu-runtime';\n${layout}`;
}

if (!layout.includes('<MobileMenuRuntime />')) {
  if (!layout.includes('</body>')) throw new Error('Could not locate </body> in app/layout.js');
  layout = layout.replace('</body>', '<MobileMenuRuntime /></body>');
}

fs.writeFileSync(layoutPath, layout, 'utf8');
console.log('Repaired MobileMenuRuntime injection inside the document body');
